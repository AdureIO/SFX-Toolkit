/**
 * Go-to-definition (also behind Cmd/Ctrl+hover and Peek): Apex symbols resolve through
 * symbolSearch — the engine Find References / Rename / Go to Implementation use — so a
 * call lands on the declaration NAME of the exact member (receiver type via the
 * expression resolver, inheritance, overloads by arity and argument types, constructors,
 * the open buffer's text before the disk's). SObject / field click-through goes to the
 * generated schema stubs.
 */
import { CancellationToken, Connection, Location, Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { enclosingClass } from './apexSymbols';
import { getStub } from './sobjectStub';
import { soqlRegionAt, mainFromObject, relationshipSegmentsBeforeCursor, scopeObjectAt } from './soql';
import { orCancelled, throwIfCancelled } from './cancel';
import { isApex, wordSpanAt, receiverBefore, baseTypeName } from './textUtil';
import { SearchSession, resolveAt, declarationOf, constructorTarget, offsetOf } from './symbolSearch';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onDefinition((params, token) => orCancelled<Location | null>(null, () => definitionAt(ctx, params, token)));
}

async function definitionAt(
    ctx: ServerContext,
    params: { textDocument: { uri: string }; position: { line: number; character: number } },
    token: CancellationToken,
): Promise<Location | null> {
    throwIfCancelled(token);
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;
    const offset = doc.offsetAt(params.position);

    if (doc.languageId === 'soql') {
        const span = wordSpanAt(doc.getText(), offset);
        if (!span) return null;
        return soqlDefinition(ctx, doc.uri, doc.getText(), params.position.line + 1, params.position.character + 1, span[2], token);
    }
    if (!isApex(doc.uri)) return null;

    // Inline [SELECT …] / dynamic-SOQL string in Apex → SObject/field stub; a `:bind`
    // expression inside it is plain Apex.
    const region = soqlRegionAt(doc.getText(), offset);
    if (region) {
        const span = wordSpanAt(region.snippet, offset - region.contentStart);
        if (!span) return null;
        if (!inBindExpression(region.snippet, span[0])) {
            return soqlDefinition(ctx, doc.uri, region.snippet, region.line, region.column, span[2], token);
        }
    }
    return apexDefinition(ctx, doc, offset, params.position, token);
}

/** A word inside the `:expr` bind of a SOQL snippet (an Apex expression, not a SOQL name). */
function inBindExpression(snippet: string, wordStart: number): boolean {
    return /:\s*(?:[\w.]|\([^()]*\)|\[[^\]]*\])*$/.test(snippet.slice(0, wordStart));
}

/** A Location into a generated SObject schema stub (object or specific field). */
async function stubLocation(
    ctx: ServerContext,
    docUri: string,
    sobject: string,
    field: string | null,
    token: CancellationToken,
): Promise<Location | null> {
    // Never write/generate stub files for ephemeral buffers (their org may be
    // non-default — writing would contaminate the shared .sfdx stubs).
    if (ctx.ephemeralDocs.has(docUri)) return null;
    const d = await ctx.schema.describe(docUri, sobject, token);
    if (!d) return null;
    throwIfCancelled(token); // getStub may write a stub file — not for a cancelled request
    const info = await getStub(sobject, d);
    if (!info) return null;
    const line = field ? info.fieldLines.get(field.toLowerCase()) ?? info.classLine : info.classLine;
    return { uri: info.uri, range: Range.create(line, 0, line, 200) };
}

/** Resolve a word in a SOQL context to an SObject (object name) or one of its fields. */
async function soqlDefinition(
    ctx: ServerContext,
    docUri: string,
    soqlText: string,
    line: number,
    col: number,
    word: string,
    token: CancellationToken,
): Promise<Location | null> {
    // The innermost query's object (`(SELECT Name FROM Contacts)` → Contact), else the main FROM.
    const base = (await scopeObjectAt(ctx.schema, docUri, soqlText, line, col, token)) ?? mainFromObject(soqlText);
    if (!base) return null;
    if (word.toLowerCase() === base.toLowerCase()) return stubLocation(ctx, docUri, base, null, token);
    const segs = relationshipSegmentsBeforeCursor(soqlText, line, col);
    const target = segs.length ? await ctx.schema.resolveRelationshipTarget(docUri, base, segs, token) : base;
    if (!target) return null;
    return stubLocation(ctx, docUri, target, word, token);
}

async function apexDefinition(
    ctx: ServerContext,
    doc: TextDocument,
    offset: number,
    pos: { line: number; character: number },
    token: CancellationToken,
): Promise<Location | null> {
    const text = doc.getText();
    const span = wordSpanAt(text, offset);
    if (!span) return null;
    const [start, , word] = span;

    // Workspace symbols: the same resolution Find References / Rename use.
    if (ctx.settings.apexFeatures) {
        const session = new SearchSession(ctx, token);
        const res = await resolveAt(session, doc, pos);
        throwIfCancelled(token);
        const sym = res?.symbol;
        if (res && sym) {
            if (sym.kind === 'type') {
                const m = await session.modelForDoc(doc);
                const ws = offsetOf(m, res.range.start.line, res.range.start.character);
                const ctor = await constructorTarget(session, m, sym.node, ws, ws + res.word.length);
                if (ctor) return Location.create(ctor.uri, ctor.range);
            }
            const d = declarationOf(session, sym);
            if (d) return Location.create(d.uri, d.range);
        }
    }

    // Not a workspace symbol: an SObject / field → generated schema stub. (Never guess a
    // same-named member of an unrelated workspace type.)
    const { index } = await ctx.parses.currentAsync(doc);
    throwIfCancelled(token);
    const receiver = receiverBefore(text, start);
    // Scratch buffers (asfx-buffer: etc.) are outside the workspace graph: the declarations
    // of the buffer itself are all there is to resolve against.
    const scratch = ctx.settings.apexFeatures && !doc.uri.startsWith('file:');
    if (receiver) {
        const typeName = receiver === 'this' ? enclosingClass(index, pos.line, pos.character) : index.varTypes.get(receiver) ?? receiver;
        if (!typeName) return null;
        const base = baseTypeName(typeName);
        if (scratch && index.types.has(base)) {
            const r = index.decls.get(word);
            if (r) return { uri: doc.uri, range: r };
        }
        if (await ctx.schema.describe(doc.uri, base, token)) return stubLocation(ctx, doc.uri, base, word, token);
        return null;
    }
    if (scratch) {
        const local = index.decls.get(word);
        if (local) return { uri: doc.uri, range: local };
    }
    if (await ctx.schema.describe(doc.uri, word, token)) return stubLocation(ctx, doc.uri, word, null, token);
    return null;
}
