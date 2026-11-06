/**
 * Hover: SOQL field/object info (always on) and Apex symbol/member info (additive,
 * read-only — runs even when the Salesforce extension is present).
 */
import { CancellationToken, Connection, Hover, MarkupKind } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import type { HostDescribe, HostField } from './schema';
import { WorkspaceIndex } from './workspaceIndex';
import { stdTypeName } from './apexStdlib';
import { soqlRegionAt, mainFromObject, relationshipSegmentsBeforeCursor, scopeObjectAt } from './soql';
import { orCancelled, throwIfCancelled } from './cancel';
import { isApex, wordSpanAt } from './textUtil';
import { MemberEntry, Resolver, receiverExprBefore } from './apexResolve';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onHover((params, token) => orCancelled<Hover | null>(null, () => hoverAt(ctx, params, token)));
}

async function hoverAt(
    ctx: ServerContext,
    params: { textDocument: { uri: string }; position: { line: number; character: number } },
    token: CancellationToken,
): Promise<Hover | null> {
    throwIfCancelled(token);
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;
    const offset = doc.offsetAt(params.position);

    if (doc.languageId === 'soql') {
        const span = wordSpanAt(doc.getText(), offset);
        if (!span) return null;
        return soqlHover(ctx, doc.uri, doc.getText(), params.position.line + 1, params.position.character + 1, span[2], token);
    }

    if (!isApex(doc.uri)) return null;
    // Inline [SELECT …] / dynamic-SOQL string in Apex → SOQL hover; else Apex hover.
    // Apex hover is additive (read-only) so it runs even when the Salesforce
    // extension is present — that's why field/var info shows here but not via
    // the gated diagnostics.
    const region = soqlRegionAt(doc.getText(), offset);
    if (region) {
        const span = wordSpanAt(region.snippet, offset - region.contentStart);
        if (!span) return null;
        return soqlHover(ctx, doc.uri, region.snippet, region.line, region.column, span[2], token);
    }
    return apexHover(ctx, doc, offset, params.position, token);
}

function codeHover(text: string): Hover {
    return { contents: { kind: MarkupKind.Markdown, value: '```apex\n' + text + '\n```' } };
}

/** Rich hover for an SObject field: signature + label + help + picklist values. */
function fieldHover(owner: string, f: HostField): Hover {
    const sizeSuffix = f.length ? ` (${f.length})` : '';
    const parts: string[] = ['```apex\n' + `${owner}.${f.name} : ${f.type}${sizeSuffix}` + '\n```'];
    if (f.label && f.label !== f.name) parts.push(`**${f.label}**`);
    if (f.helpText) parts.push(f.helpText);
    if (f.picklistValues && f.picklistValues.length) {
        const shown = f.picklistValues.slice(0, 12).join(', ');
        const more = f.picklistValues.length > 12 ? `, … (+${f.picklistValues.length - 12})` : '';
        parts.push(`_Values:_ ${shown}${more}`);
    }
    if (f.nillable === false) parts.push('_Required_');
    return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') } };
}

/** Rich hover for an SObject: label, description, key prefix, custom flag, CRUD, field count. */
function objectHover(name: string, d: HostDescribe | null, description?: string | null): Hover {
    const parts: string[] = ['```apex\n' + `SObject ${name}` + '\n```'];
    if (d) {
        const title = d.labelPlural && d.labelPlural !== d.label ? `${d.label} / ${d.labelPlural}` : d.label;
        if (title) parts.push(`**${title}**${d.custom ? ' _(custom)_' : ''}`);
        if (description) parts.push(description);
        const meta: string[] = [];
        if (d.keyPrefix) meta.push(`key prefix \`${d.keyPrefix}\``);
        meta.push(`${d.fields.length} fields`);
        if (d.childRelationships.length) meta.push(`${d.childRelationships.length} child relationships`);
        if (meta.length) parts.push(meta.join(' · '));
        const crud = [
            d.queryable !== false ? 'queryable' : '',
            d.createable ? 'createable' : '',
            d.updateable ? 'updateable' : '',
            d.deletable ? 'deletable' : '',
        ].filter(Boolean);
        if (crud.length) parts.push(`_${crud.join(', ')}_`);
    }
    return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') } };
}

async function apexHover(
    ctx: ServerContext,
    doc: TextDocument,
    offset: number,
    pos: { line: number; character: number },
    token: CancellationToken,
): Promise<Hover | null> {
    const text = doc.getText();
    const span = wordSpanAt(text, offset);
    if (!span) return null;
    const [start, , word] = span;
    // Read-only: the last completed parse is fine (cursor mapped into its coordinates).
    const view = ctx.parses.forRead(doc);
    const { index } = view.result;

    // Member access: type the receiver expression (chains, calls, indexes, inheritance)
    // with the completion resolver, so only real SObject types are ever described.
    let dot = start - 1;
    while (dot >= 0 && /\s/.test(text[dot])) dot--;
    if (dot >= 0 && text[dot] === '.') {
        const expr = receiverExprBefore(text, dot);
        if (!expr) return null;
        const good = ctx.parses.forReadGood(doc);
        const resolver = new Resolver(ctx, doc, pos, good ? [view, good] : [view], token);
        const v = await resolver.exprValue(expr);
        throwIfCancelled(token);
        if (!v) return null;
        const lw = word.toLowerCase();
        const hit = (await resolver.members(v)).find((e) => entryName(e)?.toLowerCase() === lw);
        return hit ? memberHover(hit, resolver) : null;
    }

    const methods = index.methods.get(word);
    if (methods && methods.length) return codeHover(methods.join('\n'));
    const varType = index.varTypes.get(word);
    if (varType) return codeHover(`${word} : ${varType}`);
    if (index.types.has(word)) return codeHover(`type ${word}`);
    const d = await ctx.schema.describe(doc.uri, word, token);
    if (d) return objectHover(word, d, await ctx.schema.objectDescription(doc.uri, word, token));
    // Workspace user class / Salesforce standard-library type.
    if (WorkspaceIndex.findTypeMembers(word)) return codeHover(`class ${word}`);
    const std = stdTypeName(word);
    if (std) return codeHover(`${std} — Salesforce system type`);
    return null;
}

function entryName(e: MemberEntry): string | undefined {
    switch (e.src) {
        case 'user':
        case 'std':
            return e.m.name;
        case 'field':
            return e.f.name;
        case 'rel':
            return e.f.relationshipName;
        default:
            return e.name;
    }
}

async function memberHover(e: MemberEntry, r: Resolver): Promise<Hover | null> {
    switch (e.src) {
        case 'user':
            return codeHover(`(${e.m.kind}) ${e.owner}.${e.m.name}${e.m.detail ? ' : ' + e.m.detail : ''}`);
        case 'std':
            return codeHover(`${stdTypeName(e.owner) ?? e.owner}.${e.m.detail}`);
        case 'field':
            return fieldHover(e.owner, e.f);
        case 'rel':
            return codeHover(`${e.owner}.${e.f.relationshipName} → ${e.f.referenceTo?.join(' | ') || '?'}`);
        case 'child':
            return codeHover(`${e.owner}.${e.name} → List<${e.child}>`);
        case 'type':
            return codeHover(`type ${e.owner}.${e.name}`);
        case 'object':
            return objectHover(e.name, await r.describe(e.name));
        case 'trigger':
            return codeHover(`Trigger.${e.name} : ${e.type}`);
    }
}

/** Hover for a SOQL field/object: resolve the word against the query's object. */
async function soqlHover(
    ctx: ServerContext,
    docUri: string,
    soqlText: string,
    line: number,
    column: number,
    word: string,
    token: CancellationToken,
): Promise<Hover | null> {
    const segments = relationshipSegmentsBeforeCursor(soqlText, line, column);
    // The innermost query's object (`(SELECT Name FROM Contacts)` → Contact), else the main FROM.
    const base = (await scopeObjectAt(ctx.schema, docUri, soqlText, line, column, token)) ?? mainFromObject(soqlText);
    if (base && word.toLowerCase() === base.toLowerCase()) {
        return objectHover(base, await ctx.schema.describe(docUri, base, token), await ctx.schema.objectDescription(docUri, base, token));
    }
    if (!base) return null;
    const target = segments.length ? await ctx.schema.resolveRelationshipTarget(docUri, base, segments, token) : base;
    const d = target ? await ctx.schema.describe(docUri, target, token) : null;
    if (!d) return null;
    const f = d.fields.find((x) => x.name.toLowerCase() === word.toLowerCase());
    if (f) return fieldHover(target as string, f);
    const r = d.fields.find((x) => x.relationshipName && x.relationshipName.toLowerCase() === word.toLowerCase());
    if (r) return codeHover(`${target}.${r.relationshipName} → ${r.referenceTo?.join(' | ') || '?'}`);
    return null;
}
