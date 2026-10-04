/**
 * Go-to-definition: Apex symbols (in-file declarations, workspace types) and
 * SObject/field click-through to generated schema stubs.
 */
import { CancellationToken, Connection, Location, Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { enclosingClass } from './apexSymbols';
import { WorkspaceIndex } from './workspaceIndex';
import { getStub } from './sobjectStub';
import { soqlRegionAt, mainFromObject, relationshipSegmentsBeforeCursor } from './soql';
import { orCancelled, throwIfCancelled } from './cancel';
import { isApex, wordSpanAt, receiverBefore, baseTypeName } from './textUtil';

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

    // Inline [SELECT …] / dynamic-SOQL string in Apex → SObject/field stub; else Apex definition.
    const region = soqlRegionAt(doc.getText(), offset);
    if (region) {
        const span = wordSpanAt(region.snippet, offset - region.contentStart);
        if (!span) return null;
        return soqlDefinition(ctx, doc.uri, region.snippet, region.line, region.column, span[2], token);
    }
    return apexDefinition(ctx, doc, offset, params.position, token);
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
    const info = getStub(sobject, d);
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
    const base = mainFromObject(soqlText);
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
    // Exact parse: the result is a range into the CURRENT text, so a stale parse could
    // send the user to the wrong line.
    const { index } = ctx.parses.current(doc);
    throwIfCancelled(token);
    const receiver = receiverBefore(text, start);
    const apexFeatures = ctx.settings.apexFeatures;

    if (receiver) {
        // Member access: resolve receiver type, then locate the member.
        const typeName = receiver === 'this' ? enclosingClass(index, pos.line, pos.character) : index.varTypes.get(receiver) ?? receiver;
        if (!typeName) return null;
        const base = baseTypeName(typeName);
        if (apexFeatures && index.types.has(base)) {
            const r = index.decls.get(word);
            if (r) return { uri: doc.uri, range: r };
        }
        // SObject field → schema stub.
        if (await ctx.schema.describe(doc.uri, base, token)) return stubLocation(ctx, doc.uri, base, word, token);
        return null;
    }

    // Bare identifier: in-file decl / workspace type (gated), else SObject stub.
    if (apexFeatures) {
        const local = index.decls.get(word);
        if (local) return { uri: doc.uri, range: local };
        const wt = WorkspaceIndex.findType(word);
        if (wt) return wt;
    }
    if (await ctx.schema.describe(doc.uri, word, token)) return stubLocation(ctx, doc.uri, word, null, token);
    return null;
}
