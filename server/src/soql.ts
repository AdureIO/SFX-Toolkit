/**
 * SOQL glue: locating SOQL regions inside Apex (inline `[SELECT …]` and dynamic
 * `Database.query('…')` strings), text helpers over a SOQL snippet, and org-aware
 * SOQL completion. We reuse @salesforce/soql-language-server's pure-JS
 * `completionsFor` to get completion candidates + placeholder items, then expand the
 * placeholders against the connected org's schema.
 */
import { CancellationToken, CompletionItem, CompletionItemKind, InsertTextFormat, Range, TextEdit } from 'vscode-languageserver/node';
import { completionsFor } from '@salesforce/soql-language-server/lib/completion';
import { budgetOf, findRelationship } from './schema';
import type { SchemaService, HostDescribe, HostField } from './schema';
import { withSchemaDoc, sfxTag, applyNamespace, fieldsAndRels, objectSortTier } from './items';
import { nameMatchesNsOptional, stripLeadingNamespace } from './textUtil';

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


// ─── Query scopes (main query / child subquery / semi-join) ─────────────────────

export type QueryScopeKind = 'main' | 'child' | 'semi';
export interface QueryScope {
    kind: QueryScopeKind;
    /** Offset where the scope's text begins (just after its `(` for subqueries). */
    start: number;
    /** The scope's FROM name: an SObject (main/semi) or a child relationship name (child). */
    from: string | null;
}

const FROM_RE = /FROM\s+(?!(?:FROM|WHERE|SELECT|LIMIT|OFFSET|GROUP|ORDER|HAVING|AND|OR|NULL|WITH|USING|FOR)\b)([A-Za-z_]\w*)/iy;

/** The first `FROM name` at the scope's own paren depth, scanning from `start` (crosses the cursor). */
function scopeFrom(text: string, start: number): string | null {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (ch === '\\') i++;
            else if (ch === "'") inStr = false;
            continue;
        }
        if (ch === "'") inStr = true;
        else if (ch === '(') depth++;
        else if (ch === ')') {
            if (depth === 0) return null; // end of this scope
            depth--;
        } else if (depth === 0 && (ch === 'F' || ch === 'f') && (i === 0 || !/\w/.test(text[i - 1]))) {
            FROM_RE.lastIndex = i;
            const m = FROM_RE.exec(text);
            if (m) return m[1];
        }
    }
    return null;
}

/**
 * The query scopes enclosing `offset`, outermost first: the main query, then each
 * `(SELECT …)` subquery around the cursor — `child` for a SELECT-list subquery (its
 * FROM is a child relationship of the enclosing object), `semi` for a value-position
 * `IN (SELECT …)` semi/anti-join (its FROM is an SObject).
 */
export function queryScopesAt(text: string, offset: number): QueryScope[] {
    const stack: { pos: number; select: boolean; semi: boolean }[] = [];
    let inStr = false;
    for (let i = 0; i < offset && i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (ch === '\\') i++;
            else if (ch === "'") inStr = false;
            continue;
        }
        if (ch === "'") inStr = true;
        else if (ch === '(') {
            const select = /^\s*SELECT\b/i.test(text.slice(i + 1, i + 40));
            stack.push({ pos: i, select, semi: select && /\b(?:not\s+in|in)\s*$/i.test(text.slice(Math.max(0, i - 20), i)) });
        } else if (ch === ')') stack.pop();
    }
    const main: QueryScope = { kind: 'main', start: 0, from: scopeFrom(text, 0) ?? outerFromObject(text) };
    const scopes: QueryScope[] = [main];
    for (const s of stack) {
        if (!s.select) continue;
        scopes.push({ kind: s.semi ? 'semi' : 'child', start: s.pos + 1, from: scopeFrom(text, s.pos + 1) });
    }
    return scopes;
}

/** The child SObject a parent's child relationship points at (namespace-optional). */
function childObjectOf(d: HostDescribe, relName: string): string | null {
    const rel = d.childRelationships.find((r) => nameMatchesNsOptional(r.name, relName));
    return rel ? rel.childSObject : null;
}

/** Resolve the SObject a list of scopes (outermost first) ranges over. */
async function objectOfScopes(schema: SchemaService, docUri: string, scopes: QueryScope[], token?: CancellationToken): Promise<string | null> {
    let obj: string | null = null;
    for (const s of scopes) {
        if (s.kind !== 'child') {
            obj = s.from;
            continue;
        }
        if (!obj || !s.from) return null;
        const parent = await schema.describe(docUri, obj, token);
        obj = parent ? childObjectOf(parent, s.from) : null;
        if (!obj) return null;
    }
    return obj;
}

/**
 * The SObject the innermost query around a 1-based (line, column) ranges over —
 * `(SELECT Account.| FROM Contacts) FROM Account` → Contact. For hover/definition.
 */
export async function scopeObjectAt(
    schema: SchemaService,
    docUri: string,
    text: string,
    line: number,
    column: number,
    token?: CancellationToken,
): Promise<string | null> {
    return objectOfScopes(schema, docUri, queryScopesAt(text, offsetOf(text, line, column)), token);
}

// ─── Completion helpers ──────────────────────────────────────────────────────────

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
    { label: 'NEXT_N_QUARTERS:n', snippet: 'NEXT_N_QUARTERS:${1:n}' },
    { label: 'LAST_N_YEARS:n', snippet: 'LAST_N_YEARS:${1:n}' },
    { label: 'NEXT_N_YEARS:n', snippet: 'NEXT_N_YEARS:${1:n}' },
    { label: 'LAST_N_FISCAL_QUARTERS:n', snippet: 'LAST_N_FISCAL_QUARTERS:${1:n}' },
    { label: 'NEXT_N_FISCAL_QUARTERS:n', snippet: 'NEXT_N_FISCAL_QUARTERS:${1:n}' },
    { label: 'LAST_N_FISCAL_YEARS:n', snippet: 'LAST_N_FISCAL_YEARS:${1:n}' },
    { label: 'NEXT_N_FISCAL_YEARS:n', snippet: 'NEXT_N_FISCAL_YEARS:${1:n}' },
];
const DATE_LITERAL_RE = /^(?:TODAY|YESTERDAY|TOMORROW|(?:THIS|LAST|NEXT)_(?:FISCAL_)?(?:WEEK|MONTH|QUARTER|YEAR)|(?:LAST|NEXT)_90_DAYS|(?:LAST|NEXT)_N_\w+|N_\w+_AGO)(?::n)?$/;
const SOQL_AGG_FUNCS = ['COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];
/** soql-language-server's typed value placeholders — never useful as completions. */
const VALUE_PLACEHOLDER_LABELS = new Set(['nnn', 'nnn.nnn', 'ISOCODEnnn.nn', 'abc123', 'YYYY-MM-DD', 'YYYY-MM-DDThh:mm:ssZ']);
/** FROM-position object items returned at most (the list is then marked incomplete). */
export const MAX_OBJECT_ITEMS = 200;

/**
 * Fields of the polymorphic `Name` pseudo-object — what a multi-target lookup
 * (`Case.Owner`, `Task.What`) can be traversed to without TYPEOF.
 */
const NAME_FIELDS: HostField[] = [
    { name: 'Id', type: 'id' },
    { name: 'Name', type: 'string' },
    { name: 'Type', type: 'string' },
    { name: 'Alias', type: 'string' },
    { name: 'Email', type: 'email' },
    { name: 'FirstName', type: 'string' },
    { name: 'LastName', type: 'string' },
    { name: 'IsActive', type: 'boolean' },
    { name: 'Phone', type: 'phone' },
    { name: 'Title', type: 'string' },
    { name: 'Username', type: 'string' },
    { name: 'NameOrAlias', type: 'string' },
    { name: 'UserRoleId', type: 'reference', relationshipName: 'UserRole', referenceTo: ['UserRole'] },
    { name: 'ProfileId', type: 'reference', relationshipName: 'Profile', referenceTo: ['Profile'] },
    { name: 'RecordTypeId', type: 'reference', relationshipName: 'RecordType', referenceTo: ['RecordType'] },
    { name: 'LastReferencedDate', type: 'datetime' },
    { name: 'LastViewedDate', type: 'datetime' },
];
const NAME_DESCRIBE: HostDescribe = { name: 'Name', fields: NAME_FIELDS, childRelationships: [] };

/** Context-aware SOQL extras: aggregates + FIELDS() in the SELECT list of the current scope. */
function soqlExtraCompletions(text: string, offset: number, scopeStart: number): CompletionItem[] {
    const upto = text.slice(scopeStart, Math.max(scopeStart, offset));
    const selIdx = upto.toLowerCase().lastIndexOf('select');
    if (selIdx < 0 || /\bfrom\b/i.test(upto.slice(selIdx))) return [];
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
    return items;
}

function isPlaceholder(item: CompletionItem): boolean {
    return typeof item.label === 'string' && item.label.startsWith('__');
}

function ctxOf(item: CompletionItem): any {
    return (item.data && (item.data as any).soqlContext) || undefined;
}

/** Case-insensitive subsequence match (a superset of the client's fuzzy filter). */
function subsequence(name: string, typed: string): boolean {
    let j = 0;
    for (let i = 0; i < name.length && j < typed.length; i++) if (name[i] === typed[j]) j++;
    return j === typed.length;
}

/**
 * Org SObjects as completion items. With a budget (interactive request) a large list
 * is filtered by the typed prefix and capped at MAX_OBJECT_ITEMS (marked incomplete,
 * so the client re-asks as the user keeps typing).
 */
async function sobjectsCompletion(schema: SchemaService, docUri: string, prefix: string, token?: CancellationToken): Promise<CompletionItem[]> {
    let names = await schema.objectNames(docUri, token);
    const budget = budgetOf(token);
    if (budget && names.length > MAX_OBJECT_ITEMS) {
        const p = prefix.toLowerCase();
        if (p) {
            names = names.filter((n) => {
                const l = n.toLowerCase();
                return subsequence(l, p) || subsequence(stripLeadingNamespace(l), p);
            });
        }
        if (names.length > MAX_OBJECT_ITEMS) {
            const rank = (n: string) => {
                const l = n.toLowerCase();
                const starts = p && (l.startsWith(p) || stripLeadingNamespace(l).startsWith(p)) ? '0' : '1';
                return starts + objectSortTier(n) + l;
            };
            names = names
                .map((n) => ({ n, r: rank(n) }))
                .sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0))
                .slice(0, MAX_OBJECT_ITEMS)
                .map((x) => x.n);
        }
        budget.markIncomplete();
    }
    return names.map((name) =>
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

/** `TYPEOF <rel> WHEN T THEN … END` snippet items for the polymorphic lookups of an object. */
function typeofItems(owner: string, d: HostDescribe): CompletionItem[] {
    const out: CompletionItem[] = [];
    for (const f of d.fields) {
        if (!f.relationshipName || !f.referenceTo || f.referenceTo.length < 2) continue;
        const choices = f.referenceTo.map((t) => t.replace(/[,|$}\\]/g, '')).join(',');
        out.push(
            withSchemaDoc(
                {
                    label: `TYPEOF ${f.relationshipName}`,
                    kind: CompletionItemKind.Snippet,
                    labelDetails: { detail: ` → ${f.referenceTo.join(' | ')}`, description: owner },
                    insertText: `TYPEOF ${f.relationshipName} WHEN \${1|${choices}|} THEN \${2:Id} ELSE \${3:Id} END`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    sortText: '1_' + f.relationshipName + '~',
                },
                [`Polymorphic \`${owner}.${f.relationshipName}\` → **${f.referenceTo.join(' | ')}**`, 'Select type-specific fields with `TYPEOF`.'],
            ),
        );
    }
    return out;
}

/** Fields of a polymorphic lookup (`Owner.` on Case): the `Name` pseudo-object's fields. */
function polymorphicFields(owner: string, rel: string, targets: string[]): CompletionItem[] {
    const items = fieldsAndRels('Name', NAME_DESCRIBE, {});
    for (const i of items) i.labelDetails = { ...i.labelDetails, description: `${owner}.${rel} (${targets.join(' | ')})` };
    return items;
}

/** Escape text for use inside a snippet placeholder (`$`, `}` and `\` are special). */
function snippetEscape(t: string): string {
    return t.replace(/[$}\\]/g, '\\$&');
}

/**
 * `TYPEOF What …` item offered right after `What.` in a SELECT field list. It replaces the
 * whole `What.` token (`range`, in document coordinates) with a full TYPEOF snippet whose
 * first two WHEN targets are prefilled from the lookup's referenceTo.
 */
function typeofAfterDotItem(owner: string, rel: string, targets: string[], range: Range, typed: string): CompletionItem {
    const [t1, t2] = targets.map(snippetEscape);
    const r = snippetEscape(rel);
    const snippet = `TYPEOF ${r} WHEN \${1:${t1}} THEN \${2:Id, Name} \${3:WHEN \${4:${t2}} THEN \${5:Id, Name}} ELSE \${6:Id} END`;
    return withSchemaDoc(
        {
            label: `TYPEOF ${rel} …`,
            kind: CompletionItemKind.Snippet,
            labelDetails: { detail: ` → ${targets.join(' | ')}`, description: owner },
            insertTextFormat: InsertTextFormat.Snippet,
            textEdit: TextEdit.replace(range, snippet),
            // Keep it visible while the user types `What.Na` — the client filters against this.
            filterText: typed,
            sortText: '!TYPEOF' + rel,
        },
        [`Polymorphic \`${owner}.${rel}\` → **${targets.join(' | ')}**`, 'Replaces `' + typed + '` with a `TYPEOF` clause.'],
    );
}

/**
 * Whether the cursor (end of `upto`, the text of the innermost scope) sits in the SELECT field
 * list of a main/subquery scope, outside parentheses and strings — the only place TYPEOF is valid.
 */
function inSelectFieldList(upto: string): boolean {
    if (!/^\s*SELECT\b/i.test(upto)) return false;
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < upto.length; i++) {
        const ch = upto[i];
        if (inStr) {
            if (ch === '\\') i++;
            else if (ch === "'") inStr = false;
            continue;
        }
        if (ch === "'") inStr = true;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && (ch === 'F' || ch === 'f') && !/\w/.test(upto[i - 1] ?? ' ') && /^from\b/i.test(upto.slice(i, i + 5))) return false;
    }
    return depth === 0 && !inStr;
}

type PathTarget = { object: string } | { poly: string[]; owner: string; rel: string } | null;

/** Walk a relationship path from `base`, stopping at a polymorphic final hop. */
async function resolvePath(schema: SchemaService, docUri: string, base: string, segs: string[], token?: CancellationToken): Promise<PathTarget> {
    let current = base;
    for (let i = 0; i < segs.length; i++) {
        const d = current === 'Name' ? NAME_DESCRIBE : await schema.describe(docUri, current, token);
        if (!d) return null;
        const f = findRelationship(d, segs[i]);
        if (!f || !f.referenceTo) return null;
        const targets = f.referenceTo;
        if (targets.length === 1) {
            current = targets[0];
            continue;
        }
        if (i === segs.length - 1) return { poly: targets, owner: current, rel: f.relationshipName as string };
        current = 'Name'; // a polymorphic hop mid-path traverses the Name pseudo-object
    }
    return { object: current };
}

/** A `TYPEOF rel WHEN … THEN …` context before the cursor, within the current scope. */
function typeofContext(upto: string): { rel: string; mode: 'when' | 'then' | 'else'; type?: string; lead: string } | null {
    const m = /\bTYPEOF\s+([A-Za-z_]\w*)\b((?:(?!\bEND\b)[\s\S])*)$/i.exec(upto);
    if (!m) return null;
    const body = m[2];
    const tail = /\b(WHEN|THEN|ELSE)\b((?:(?!\b(?:WHEN|THEN|ELSE)\b)[\s\S])*)$/i.exec(body);
    if (!tail) return null;
    const kw = tail[1].toUpperCase();
    if (kw === 'WHEN') return { rel: m[1], mode: 'when', lead: tail[2] };
    if (kw === 'ELSE') return { rel: m[1], mode: 'else', lead: tail[2] };
    let type: string | undefined;
    for (const w of body.matchAll(/\bWHEN\s+([A-Za-z_]\w*)\s+THEN\b/gi)) type = w[1];
    return { rel: m[1], mode: 'then', type, lead: tail[2] };
}

function picklistItems(owner: string, fieldName: string, values: string[], text: string, offset: number, scopeStart: number): CompletionItem[] {
    // Inside an opened string literal already (`= '` / `= 'Ban`)? Count unescaped quotes in this scope.
    let quotes = 0;
    for (let i = scopeStart; i < offset; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === "'") quotes++;
    }
    const inQuote = quotes % 2 === 1;
    const closeTyped = inQuote && text[offset] === "'";
    return values.map((v, idx) => {
        const esc = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const item: CompletionItem = {
            label: `'${v}'`,
            kind: CompletionItemKind.Value,
            labelDetails: { description: 'picklist value' },
            filterText: v,
            // The picklist's own order, ahead of everything else.
            sortText: '0_' + String(idx).padStart(4, '0'),
            insertText: inQuote ? esc + (closeTyped ? '' : "'") : `'${esc}'`,
        };
        return withSchemaDoc(item, [`Picklist value of \`${owner}.${fieldName}\``]);
    });
}

function dateLiteralItems(): CompletionItem[] {
    return SOQL_DATE_LITERALS.map((d) => {
        const item: CompletionItem = { label: d.label, kind: CompletionItemKind.Value, sortText: '1_' + d.label };
        if (d.snippet) {
            item.insertText = d.snippet;
            item.insertTextFormat = InsertTextFormat.Snippet;
        }
        return withSchemaDoc(item, ['`' + d.label + '` — SOQL date literal']);
    });
}

/**
 * Value position (`WHERE Field = |`): keep only what fits the field's type — picklist
 * values first, date literals for date/datetime, TRUE/FALSE for booleans, NULL — and
 * drop the engine's typed placeholders (nnn, YYYY-MM-DD, abc123 …).
 */
async function valueCompletions(
    schema: SchemaService,
    docUri: string,
    raw: CompletionItem[],
    c: any,
    text: string,
    offset: number,
    scopeStart: number,
    token?: CancellationToken,
): Promise<CompletionItem[]> {
    const d = c?.sobjectName ? await schema.describe(docUri, c.sobjectName, token) : null;
    const want = String(c?.fieldName ?? '').toLowerCase();
    const field = d?.fields.find((f) => f.name.toLowerCase() === want);
    const type = field?.type?.toLowerCase();
    const out: CompletionItem[] = [];
    for (const item of raw) {
        const label = String(item.label);
        if (label === '__LITERAL_VALUES_FOR_FIELD') {
            if (field?.picklistValues?.length) out.push(...picklistItems(c.sobjectName, field.name, field.picklistValues, text, offset, scopeStart));
            continue;
        }
        if (isPlaceholder(item) || VALUE_PLACEHOLDER_LABELS.has(label) || DATE_LITERAL_RE.test(label)) continue;
        const only: unknown = ctxOf(item)?.onlyTypes;
        if (Array.isArray(only) && only.length && (!type || !only.includes(type))) continue;
        out.push(item);
    }
    if (type === 'date' || type === 'datetime') out.push(...dateLiteralItems());
    return out;
}

// Expand one structural placeholder item into concrete, org-aware completion items.
async function expand(
    schema: SchemaService,
    item: CompletionItem,
    docUri: string,
    scopeObject: string | null,
    parentObject: string | null,
    scope: QueryScope,
    prefix: string,
    token?: CancellationToken,
): Promise<CompletionItem[]> {
    const label = item.label as string;
    const c = ctxOf(item);

    if (label === '__SOBJECTS_PLACEHOLDER') {
        // In a SELECT-list subquery (`SELECT …, (SELECT Id FROM |) FROM Parent`) the parser
        // sometimes emits SOBJECTS instead of RELATIONSHIPS depending on parse state. Force
        // child relationships of the enclosing object so it's consistent regardless of edits.
        if (scope.kind === 'child') return parentObject ? childRelationshipsOf(schema, docUri, parentObject, token) : [];
        return sobjectsCompletion(schema, docUri, prefix, token);
    }

    if (label === '__SOBJECT_FIELDS_PLACEHOLDER') {
        const target = scope.kind === 'child' ? scopeObject : c?.sobjectName || scopeObject;
        const d = target ? await schema.describe(docUri, target, token) : null;
        if (!d) return [];
        const items = fieldsAndRels(target as string, d, c);
        if (!c?.dontShowRelationshipField && !c?.onlyAggregatable && !c?.onlyGroupable && !c?.onlySortable) items.push(...typeofItems(target as string, d));
        return items;
    }

    if (label === '__RELATIONSHIPS_PLACEHOLDER') {
        // A WHERE/value-position subquery (`… IN (SELECT Id FROM |)`) is a semi-join
        // over an SObject, not a child-relationship subquery — offer objects.
        if (scope.kind === 'semi') return sobjectsCompletion(schema, docUri, prefix, token);
        const parent = parentObject || c?.sobjectName || null;
        if (!parent) return [];
        return childRelationshipsOf(schema, docUri, parent, token);
    }

    if (label === '__RELATIONSHIP_FIELDS_PLACEHOLDER') {
        let childName = scope.kind === 'child' ? scopeObject : null;
        if (!childName && c?.sobjectName && c?.relationshipName) {
            const parent = await schema.describe(docUri, c.sobjectName, token);
            childName = parent ? childObjectOf(parent, c.relationshipName) : null;
        }
        const child = childName ? await schema.describe(docUri, childName, token) : null;
        if (!child || !childName) return [];
        return [...fieldsAndRels(childName, child, c), ...typeofItems(childName, child)];
    }

    return [];
}

/**
 * Org-aware SOQL completion for a SOQL text (a .soql document or a region inside Apex).
 * `line`/`column` are 1-based positions within `text`. Pass a SchemaBudget (see
 * SchemaService.completionBudget) as `token` to get the soft deadline + capped object
 * lists; its `incomplete` flag then tells whether the result is partial.
 * `origin` is the 0-based document position of `text`'s first character (default 0:0, right
 * for a .soql file); it maps snippet positions back to the document for text edits that span
 * the typed token, e.g. the `TYPEOF What …` item after `What.`.
 */
export async function soqlCompletion(
    schema: SchemaService,
    docUri: string,
    text: string,
    line: number,
    column: number,
    token?: CancellationToken,
    origin: { line: number; character: number } = { line: 0, character: 0 },
): Promise<CompletionItem[]> {
    const ns = await schema.projectNamespace(docUri, token);
    const offset = offsetOf(text, line, column);
    const scopes = queryScopesAt(text, offset);
    const scope = scopes[scopes.length - 1];
    const upto = text.slice(scope.start, offset);
    const prefix = /[A-Za-z0-9_]*$/.exec(upto)?.[0] ?? '';
    const scopeObject = await objectOfScopes(schema, docUri, scopes, token);
    const done = (items: CompletionItem[]) => sfxTag(applyNamespace(items, ns));

    // TYPEOF … WHEN <type> THEN <fields> ELSE <fields> END
    const ty = scopeObject ? typeofContext(upto) : null;
    if (ty && scopeObject) {
        if (ty.mode === 'when') {
            if (!/^\s*\w*$/.test(ty.lead)) return [];
            const d = await schema.describe(docUri, scopeObject, token);
            const f = d ? findRelationship(d, ty.rel) : undefined;
            return done(
                (f?.referenceTo ?? []).map((t) =>
                    withSchemaDoc({ label: t, kind: CompletionItemKind.Class, labelDetails: { description: `${scopeObject}.${ty.rel}` }, sortText: '0_' + t }, [
                        `\`${t}\` — possible type of \`${scopeObject}.${ty.rel}\``,
                    ]),
                ),
            );
        }
        const base = ty.mode === 'then' ? ty.type : 'Name';
        if (!base) return [];
        const segs = relationshipSegmentsBeforeCursor(text, line, column);
        const target: PathTarget = segs.length ? await resolvePath(schema, docUri, base, segs, token) : { object: base };
        if (!target) return [];
        if ('poly' in target) return done(polymorphicFields(target.owner, target.rel, target.poly));
        const d = target.object === 'Name' ? NAME_DESCRIBE : await schema.describe(docUri, target.object, token);
        return d ? done(fieldsAndRels(target.object, d, {})) : [];
    }

    // The SOQL engine doesn't resolve parent-relationship traversal and emits no
    // field placeholder after `Account.`. So if a dotted path precedes the cursor,
    // resolve it ourselves from the innermost query's object and return those fields.
    const relSegments = relationshipSegmentsBeforeCursor(text, line, column);
    if (relSegments.length) {
        if (!scopeObject) return [];
        const target = await resolvePath(schema, docUri, scopeObject, relSegments, token);
        if (!target) return [];
        if ('poly' in target) {
            const items = polymorphicFields(target.owner, target.rel, target.poly);
            // TYPEOF is only valid on a direct polymorphic lookup of the query's object, in a SELECT list.
            const tok = relSegments.length === 1 && scope.kind !== 'semi' ? /([A-Za-z_]\w*)\s*\.\s*\w*$/.exec(upto) : null;
            if (tok && !tok[0].includes('\n') && inSelectFieldList(upto) && /(?:\bSELECT(?:\s+DISTINCT)?|,)\s*$/i.test(upto.slice(0, tok.index))) {
                // Snippet position of the token → document position (only the snippet's first line is offset).
                const sp = posInSnippet(text, offset - tok[0].length);
                const ep = posInSnippet(text, offset);
                const toDoc = (p: { line: number; column: number }) => ({
                    line: origin.line + p.line - 1,
                    character: (p.line === 1 ? origin.character : 0) + p.column - 1,
                });
                items.unshift(typeofAfterDotItem(target.owner, target.rel, target.poly, Range.create(toDoc(sp), toDoc(ep)), tok[0]));
            }
            return done(items);
        }
        const d = target.object === 'Name' ? NAME_DESCRIBE : await schema.describe(docUri, target.object, token);
        return d ? done(fieldsAndRels(target.object, d, {})) : [];
    }

    let raw: CompletionItem[];
    try {
        raw = completionsFor(text, line, column);
    } catch {
        return [];
    }

    // Value position (`WHERE Field = |`): the engine tags those items with the field.
    const valueCtx = raw.map(ctxOf).find((c) => c && c.fieldName);
    if (valueCtx) return done(await valueCompletions(schema, docUri, raw, valueCtx, text, offset, scope.start, token));

    const parentObject = scopes.length > 1 ? await objectOfScopes(schema, docUri, scopes.slice(0, -1), token) : null;
    const out: CompletionItem[] = [];
    for (const item of raw) {
        if (isPlaceholder(item)) {
            out.push(...(await expand(schema, item, docUri, scopeObject, parentObject, scope, prefix, token)));
        } else if (!VALUE_PLACEHOLDER_LABELS.has(String(item.label))) {
            out.push(item);
        }
    }
    out.push(...soqlExtraCompletions(text, offset, scope.start));
    return done(out);
}

// ─── Prefetch targets ────────────────────────────────────────────────────────────

/** Every SOQL query text in a document: the whole text for .soql, else inline `[SELECT …]` and quoted `'SELECT …'`. */
export function soqlQueriesIn(text: string, isSoqlDoc: boolean): string[] {
    if (isSoqlDoc) return [text];
    const out: string[] = [];
    for (const m of text.matchAll(/\[\s*(SELECT\b[^\]]*)\]/gi)) out.push(m[1]);
    for (const m of text.matchAll(/'(\s*SELECT\b(?:[^'\\\n]|\\.)*)'/gi)) out.push(m[1].replace(/\\'/g, "'"));
    return out;
}

export interface QueryRefs {
    /** SObjects named in FROM clauses of the main query and semi-joins. */
    objects: string[];
    /** Child subqueries: (parent object, relationship name). */
    children: { parent: string; rel: string }[];
    /** First hops of dotted parent paths, with the object they start from. */
    paths: { base: string; rel: string }[];
}

/** The objects/relationships a query references, for background prefetch. */
export function queryRefs(query: string): QueryRefs {
    const refs: QueryRefs = { objects: [], children: [], paths: [] };
    const main = scopeFrom(query, 0) ?? outerFromObject(query);
    if (main) refs.objects.push(main);
    let inStr = false;
    for (let i = 0; i < query.length; i++) {
        const ch = query[i];
        if (inStr) {
            if (ch === '\\') i++;
            else if (ch === "'") inStr = false;
            continue;
        }
        if (ch === "'") inStr = true;
        else if (ch === '(' && /^\s*SELECT\b/i.test(query.slice(i + 1, i + 40))) {
            const from = scopeFrom(query, i + 1);
            if (!from) continue;
            if (/\b(?:not\s+in|in)\s*$/i.test(query.slice(Math.max(0, i - 20), i))) refs.objects.push(from);
            else if (main) refs.children.push({ parent: main, rel: from });
        }
    }
    if (main) {
        for (const m of query.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]/g)) refs.paths.push({ base: main, rel: m[1] });
    }
    return refs;
}
