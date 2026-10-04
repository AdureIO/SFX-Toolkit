/**
 * SOQL glue: locating SOQL regions inside Apex (inline `[SELECT …]` and dynamic
 * `Database.query('…')` strings), text helpers over a SOQL snippet, and org-aware
 * SOQL completion. We reuse @salesforce/soql-language-server's pure-JS
 * `completionsFor` to get completion candidates + placeholder items, then expand the
 * placeholders against the connected org's schema.
 */
import { CancellationToken, CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import { completionsFor } from '@salesforce/soql-language-server/lib/completion';
import type { SchemaService } from './schema';
import { withSchemaDoc, sfxTag, applyNamespace, fieldsAndRels, objectSortTier } from './items';

export interface SoqlRegion {
    snippet: string;
    /** 1-based line of the cursor within the snippet. */
    line: number;
    /** 1-based column of the cursor within the snippet. */
    column: number;
    /** Absolute offset in the document where the snippet content begins. */
    contentStart: number;
}

// Cursor line/column within a snippet given the snippet and the relative offset.
function posInSnippet(snippet: string, rel: number): { line: number; column: number } {
    const head = snippet.slice(0, rel);
    const nlIdx = head.lastIndexOf('\n');
    const line = (head.match(/\n/g)?.length ?? 0) + 1;
    const column = (nlIdx === -1 ? rel : rel - nlIdx - 1) + 1;
    return { line, column };
}

/** Inline SOQL query `[SELECT … ]` containing the cursor, or null. */
function inlineSoqlAt(text: string, offset: number): SoqlRegion | null {
    const open = text.lastIndexOf('[', offset - 1);
    if (open === -1) return null;
    const before = text.slice(open + 1, offset);
    if (before.includes('[') || before.includes(']')) return null;

    let close = text.indexOf(']', offset);
    if (close === -1) {
        const nl = text.indexOf('\n', offset);
        close = nl === -1 ? text.length : nl;
    } else if (text.slice(offset, close).includes('[')) {
        return null;
    }

    const snippet = text.slice(open + 1, close);
    if (!/^\s*SELECT\b/i.test(snippet)) return null;
    const { line, column } = posInSnippet(snippet, offset - (open + 1));
    return { snippet, line, column, contentStart: open + 1 };
}

/**
 * Dynamic SOQL inside a single-quoted Apex string literal on the cursor's line,
 * e.g. `Database.query('SELECT Id FROM Account')`. Handles the common single-line
 * case (Apex string literals can't span raw newlines); concatenated queries are
 * resolved only up to the literal the cursor sits in.
 */
function dynamicSoqlAt(text: string, offset: number): SoqlRegion | null {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    let lineEnd = text.indexOf('\n', offset);
    if (lineEnd === -1) lineEnd = text.length;
    const lineText = text.slice(lineStart, lineEnd);
    const cursorCol = offset - lineStart;

    // Find the single-quote string span containing the cursor (respecting \').
    let openQuote = -1;
    for (let i = 0; i < cursorCol; i++) {
        if (lineText[i] === '\\') {
            i++;
            continue;
        }
        if (lineText[i] === "'") openQuote = openQuote === -1 ? i : -1;
    }
    if (openQuote === -1) return null; // not inside a string

    // Closing quote after the cursor (or end of line if still typing).
    let closeQuote = lineText.length;
    for (let i = cursorCol; i < lineText.length; i++) {
        if (lineText[i] === '\\') {
            i++;
            continue;
        }
        if (lineText[i] === "'") {
            closeQuote = i;
            break;
        }
    }

    const snippet = lineText.slice(openQuote + 1, closeQuote);
    if (!/^\s*SELECT\b/i.test(snippet)) return null;
    const rel = cursorCol - (openQuote + 1);
    const { line, column } = posInSnippet(snippet, rel);
    return { snippet, line, column, contentStart: lineStart + openQuote + 1 };
}

/** Either an inline `[SELECT …]` or a dynamic-SOQL string region at the cursor. */
export function soqlRegionAt(text: string, offset: number): SoqlRegion | null {
    return inlineSoqlAt(text, offset) ?? dynamicSoqlAt(text, offset);
}

/** Absolute offset of a 1-based (line, column) in a snippet. */
function offsetOf(text: string, line: number, column: number): number {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + column - 1;
}

/**
 * True when the cursor sits inside a value-position subquery — `… IN (SELECT … FROM |)`
 * (a semi/anti-join). The enclosing `(` is preceded by IN / NOT IN, so the inner
 * FROM ranges over an SObject, not a child relationship.
 */
function inSemiJoinSubquery(text: string, line: number, column: number): boolean {
    const offset = offsetOf(text, line, column);
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ')') depth++;
        else if (ch === '(') {
            if (depth === 0) return /\b(?:not\s+in|in)\s*$/i.test(text.slice(0, i));
            depth--;
        }
    }
    return false;
}

/**
 * When the cursor is inside a SELECT-list child subquery `(SELECT … FROM |)`, returns the
 * OUTER object name (so the FROM completes that object's child relationships). Returns null
 * when not in such a subquery or when it's a value-position semi-join (`… IN (SELECT …)`).
 */
function childSubqueryParent(text: string, line: number, column: number): string | null {
    const offset = offsetOf(text, line, column);
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ')') depth++;
        else if (ch === '(') {
            if (depth === 0) {
                // Enclosing paren found. A semi-join (preceded by IN/NOT IN) is handled elsewhere.
                if (/\b(?:not\s+in|in)\s*$/i.test(text.slice(0, i))) return null;
                return outerFromObject(text);
            }
            depth--;
        }
    }
    return null;
}

/**
 * The outer/main query's FROM object: the FROM clause at the shallowest paren depth.
 * Using the minimum depth (rather than strictly 0) keeps it working mid-edit when the
 * subquery's closing paren isn't typed yet.
 */
function outerFromObject(text: string): string | null {
    // The negative lookahead stops `FROM` from capturing a following keyword as the object
    // name — e.g. while typing `(SELECT Id FROM  FROM Outer` the inner FROM must not eat the
    // outer FROM keyword, or the real outer object would be missed.
    const re = /\(|\)|\bFROM\s+(?!(?:FROM|WHERE|SELECT|LIMIT|OFFSET|GROUP|ORDER|HAVING|AND|OR|NULL)\b)([A-Za-z_]\w*)/gi;
    let depth = 0;
    let best: string | null = null;
    let bestDepth = Infinity;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m[0] === '(') depth++;
        else if (m[0] === ')') depth = Math.max(0, depth - 1);
        else if (m[1] && depth < bestDepth) {
            best = m[1];
            bestDepth = depth;
        }
    }
    return best;
}

/**
 * Parent-relationship path typed before the cursor in a SOQL field position.
 * `SELECT Account.Owner.Na|me` → ['Account', 'Owner']. Empty when there's no dot.
 */
export function relationshipSegmentsBeforeCursor(text: string, line: number, column: number): string[] {
    const lineText = text.split('\n')[line - 1] ?? '';
    const upToCursor = lineText.slice(0, column - 1);
    const m = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*\w*$/.exec(upToCursor);
    if (!m) return [];
    return m[1].split('.').map((s) => s.trim()).filter(Boolean);
}

/** The object name of the (first) FROM clause in a SOQL string. */
export function mainFromObject(text: string): string | null {
    const m = /\bFROM\s+([A-Za-z_]\w*)/i.exec(text);
    return m ? m[1] : null;
}

// SOQL date literals for WHERE value positions; the `:n` ones insert a tabstop.
const SOQL_DATE_LITERALS: { label: string; snippet?: string }[] = [
    { label: 'TODAY' }, { label: 'YESTERDAY' }, { label: 'TOMORROW' },
    { label: 'THIS_WEEK' }, { label: 'LAST_WEEK' }, { label: 'NEXT_WEEK' },
    { label: 'THIS_MONTH' }, { label: 'LAST_MONTH' }, { label: 'NEXT_MONTH' },
    { label: 'THIS_QUARTER' }, { label: 'LAST_QUARTER' }, { label: 'NEXT_QUARTER' },
    { label: 'THIS_YEAR' }, { label: 'LAST_YEAR' }, { label: 'NEXT_YEAR' },
    { label: 'THIS_FISCAL_QUARTER' }, { label: 'LAST_FISCAL_QUARTER' }, { label: 'NEXT_FISCAL_QUARTER' },
    { label: 'THIS_FISCAL_YEAR' }, { label: 'LAST_FISCAL_YEAR' }, { label: 'NEXT_FISCAL_YEAR' },
    { label: 'LAST_90_DAYS' }, { label: 'NEXT_90_DAYS' },
    { label: 'LAST_N_DAYS:n', snippet: 'LAST_N_DAYS:${1:n}' },
    { label: 'NEXT_N_DAYS:n', snippet: 'NEXT_N_DAYS:${1:n}' },
    { label: 'N_DAYS_AGO:n', snippet: 'N_DAYS_AGO:${1:n}' },
    { label: 'LAST_N_WEEKS:n', snippet: 'LAST_N_WEEKS:${1:n}' },
    { label: 'NEXT_N_WEEKS:n', snippet: 'NEXT_N_WEEKS:${1:n}' },
    { label: 'LAST_N_MONTHS:n', snippet: 'LAST_N_MONTHS:${1:n}' },
    { label: 'NEXT_N_MONTHS:n', snippet: 'NEXT_N_MONTHS:${1:n}' },
    { label: 'LAST_N_QUARTERS:n', snippet: 'LAST_N_QUARTERS:${1:n}' },
    { label: 'LAST_N_YEARS:n', snippet: 'LAST_N_YEARS:${1:n}' },
    { label: 'LAST_N_FISCAL_QUARTERS:n', snippet: 'LAST_N_FISCAL_QUARTERS:${1:n}' },
    { label: 'LAST_N_FISCAL_YEARS:n', snippet: 'LAST_N_FISCAL_YEARS:${1:n}' },
];
const SOQL_AGG_FUNCS = ['COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];

/** Context-aware SOQL extras: date literals in WHERE values; aggregates + FIELDS() in the SELECT list. */
function soqlExtraCompletions(text: string, line: number, column: number): CompletionItem[] {
    const off = offsetOf(text, line, column);
    const upto = text.slice(0, Math.max(0, off));

    // WHERE value position → date literals.
    if (/\bwhere\b/i.test(upto) && /[<>!=]=?\s*\w*$/.test(upto)) {
        return sfxTag(
            SOQL_DATE_LITERALS.map((d) => {
                const item: CompletionItem = { label: d.label, kind: CompletionItemKind.Value, sortText: '0_' + d.label };
                if (d.snippet) {
                    item.insertText = d.snippet;
                    item.insertTextFormat = InsertTextFormat.Snippet;
                }
                return withSchemaDoc(item, ['`' + d.label + '` — SOQL date literal']);
            }),
        );
    }

    // SELECT-list position (after SELECT, before its FROM) → aggregates + FIELDS().
    const selIdx = upto.toLowerCase().lastIndexOf('select');
    if (selIdx >= 0 && !/\bfrom\b/i.test(upto.slice(selIdx))) {
        const items: CompletionItem[] = [];
        items.push(
            withSchemaDoc(
                { label: 'COUNT()', kind: CompletionItemKind.Function, insertText: 'COUNT()', sortText: '0_COUNT' },
                ['`COUNT()` — row count aggregate'],
            ),
        );
        for (const fn of SOQL_AGG_FUNCS) {
            items.push(
                withSchemaDoc(
                    {
                        label: `${fn}(field)`,
                        kind: CompletionItemKind.Function,
                        insertText: `${fn}(\${1:field})`,
                        insertTextFormat: InsertTextFormat.Snippet,
                        filterText: fn,
                        sortText: '0_' + fn,
                    },
                    ['`' + fn + '(field)` — SOQL aggregate'],
                ),
            );
        }
        for (const ff of ['ALL', 'STANDARD', 'CUSTOM']) {
            items.push(
                withSchemaDoc(
                    { label: `FIELDS(${ff})`, kind: CompletionItemKind.Keyword, insertText: `FIELDS(${ff})`, sortText: '1_FIELDS' + ff },
                    ['`FIELDS(' + ff + ')` — field selection'],
                ),
            );
        }
        return sfxTag(items);
    }
    return [];
}

function isPlaceholder(item: CompletionItem): boolean {
    return typeof item.label === 'string' && item.label.startsWith('__');
}

function ctxOf(item: CompletionItem): any {
    return (item.data && (item.data as any).soqlContext) || undefined;
}

/** All org SObjects as completion items. */
async function sobjectsCompletion(schema: SchemaService, docUri: string, token?: CancellationToken): Promise<CompletionItem[]> {
    return (await schema.objectList(docUri, token)).map((name) =>
        withSchemaDoc(
            {
                label: name,
                kind: CompletionItemKind.Class,
                labelDetails: { description: 'SObject' },
                sortText: objectSortTier(name) + '_' + name,
            },
            [`\`${name}\` — SObject`],
        ),
    );
}

/** Child-relationship completion for a parent object (the `(SELECT … FROM <rel>)` position). */
async function childRelationshipsOf(
    schema: SchemaService,
    docUri: string,
    parentName: string,
    token?: CancellationToken,
): Promise<CompletionItem[]> {
    const d = await schema.describe(docUri, parentName, token);
    if (!d) return [];
    return d.childRelationships.map((r) =>
        withSchemaDoc(
            {
                label: r.name,
                kind: CompletionItemKind.Reference,
                labelDetails: { detail: ` → ${r.childSObject}`, description: parentName },
                sortText: r.name,
            },
            [`\`${parentName}.${r.name}\` → **${r.childSObject}** (child relationship)`],
        ),
    );
}

// Expand one placeholder item into concrete, org-aware completion items.
// `relSegments` is the parent-relationship path typed before the cursor (e.g.
// `SELECT Account.Owner.|` → ['Account','Owner']), used to traverse for fields.
async function expand(
    schema: SchemaService,
    item: CompletionItem,
    relSegments: string[],
    docUri: string,
    forceObjects = false,
    subqueryParent: string | null = null,
    token?: CancellationToken,
): Promise<CompletionItem[]> {
    const label = item.label as string;
    const c = ctxOf(item);

    if (label === '__SOBJECTS_PLACEHOLDER') {
        // In a SELECT-list subquery (`SELECT …, (SELECT Id FROM |) FROM Parent`) the parser
        // sometimes emits SOBJECTS instead of RELATIONSHIPS depending on parse state. Force
        // child relationships of the outer object so it's consistent regardless of edits.
        if (subqueryParent) return childRelationshipsOf(schema, docUri, subqueryParent, token);
        return sobjectsCompletion(schema, docUri, token);
    }

    if (label === '__SOBJECT_FIELDS_PLACEHOLDER') {
        if (!c?.sobjectName) return [];
        const target = relSegments.length
            ? await schema.resolveRelationshipTarget(docUri, c.sobjectName, relSegments, token)
            : c.sobjectName;
        const d = target ? await schema.describe(docUri, target, token) : null;
        if (!d) return [];
        return fieldsAndRels(target as string, d, c);
    }

    if (label === '__RELATIONSHIPS_PLACEHOLDER') {
        // A WHERE/value-position subquery (`… IN (SELECT Id FROM |)`) is a semi-join
        // over an SObject, not a child-relationship subquery — offer objects.
        if (forceObjects) return sobjectsCompletion(schema, docUri, token);
        // Prefer the text-derived outer object (reliable across edits) over the parser's
        // context, then fall back to it.
        const parent = subqueryParent || c?.sobjectName || null;
        if (!parent) return [];
        return childRelationshipsOf(schema, docUri, parent, token);
    }

    if (label === '__RELATIONSHIP_FIELDS_PLACEHOLDER') {
        const parent = c?.sobjectName ? await schema.describe(docUri, c.sobjectName, token) : null;
        const rel = parent?.childRelationships.find((r) => r.name === c?.relationshipName);
        const child = rel ? await schema.describe(docUri, rel.childSObject, token) : null;
        if (!child || !rel) return [];
        return fieldsAndRels(rel.childSObject, child, c);
    }

    if (label === '__LITERAL_VALUES_FOR_FIELD') {
        const d = c?.sobjectName ? await schema.describe(docUri, c.sobjectName, token) : null;
        const field = d?.fields.find((f) => f.name === c?.fieldName);
        const values = field?.picklistValues || [];
        return values.map((v) =>
            withSchemaDoc(
                {
                    label: `'${v}'`,
                    kind: CompletionItemKind.Value,
                    labelDetails: { description: 'picklist value' },
                    sortText: v,
                },
                [`Picklist value of \`${c.sobjectName}.${c.fieldName}\``],
            ),
        );
    }

    return [];
}

/**
 * Org-aware SOQL completion for a SOQL text (a .soql document or a region inside Apex).
 * `line`/`column` are 1-based positions within `text`.
 */
export async function soqlCompletion(
    schema: SchemaService,
    docUri: string,
    text: string,
    line: number,
    column: number,
    token?: CancellationToken,
): Promise<CompletionItem[]> {
    // The SOQL engine doesn't resolve parent-relationship traversal and emits no
    // field placeholder after `Account.`. So if a dotted path precedes the cursor,
    // resolve it ourselves from the query's FROM object and return those fields.
    const ns = await schema.projectNamespace(docUri, token);
    const relSegments = relationshipSegmentsBeforeCursor(text, line, column);
    if (relSegments.length) {
        const base = mainFromObject(text);
        if (base) {
            const target = await schema.resolveRelationshipTarget(docUri, base, relSegments, token);
            const d = target ? await schema.describe(docUri, target, token) : null;
            if (d) return sfxTag(applyNamespace(fieldsAndRels(target as string, d, {}), ns));
        }
        return [];
    }

    let raw: CompletionItem[];
    try {
        raw = completionsFor(text, line, column);
    } catch {
        return [];
    }

    const forceObjects = inSemiJoinSubquery(text, line, column);
    // A SELECT-list child subquery `(SELECT … FROM |)` → complete child relationships of
    // the outer object, even when the parser's state would otherwise offer SObjects.
    const subqueryParent = forceObjects ? null : childSubqueryParent(text, line, column);
    const out: CompletionItem[] = [];
    for (const item of raw) {
        if (isPlaceholder(item)) {
            out.push(...(await expand(schema, item, relSegments, docUri, forceObjects, subqueryParent, token)));
        } else {
            out.push(item);
        }
    }
    out.push(...soqlExtraCompletions(text, line, column));
    return sfxTag(applyNamespace(out, ns));
}
