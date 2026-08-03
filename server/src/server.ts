/**
 * ASFX Toolkit language server (JVM-free).
 *
 * Phase 1: org-aware SOQL completion. We reuse @salesforce/soql-language-server's
 * pure-JS `completionsFor` to get completion candidates + placeholder items, then
 * expand the placeholders against the connected org's schema. The schema itself
 * lives in the extension host (which owns auth + the metadata caches); the server
 * asks for it lazily via custom requests so it stays credential-free.
 */
import {
    createConnection,
    ProposedFeatures,
    TextDocuments,
    TextDocumentSyncKind,
    InitializeResult,
    CompletionItem,
    CompletionItemKind,
    Location,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    Hover,
    MarkupKind,
    Range,
    InsertTextFormat,
    CodeAction,
    CodeActionKind,
    TextEdit,
    Diagnostic,
    DiagnosticSeverity,
    CreateFile,
    SymbolInformation,
    SymbolKind,
} from 'vscode-languageserver/node';
import { fileURLToPath } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { completionsFor } from '@salesforce/soql-language-server/lib/completion';
import { parseApex, enclosingClass, resolveVarType, ApexParseResult, ApexMember, ApexIndex } from './apexSymbols';
import { validateFieldAccesses } from './apexSemantics';
import { WorkspaceIndex } from './workspaceIndex';
import { getStub, setStubRoot, clearStubs, stubbedObjectNames, invalidateStubbedNames } from './sobjectStub';
import { STD_TYPES, stdTypeName, stdMembersFor, StdMember } from './apexStdlib';

// ─── Custom request contract with the host (see src/languageClient.ts) ──────────
// Server → host. Host answers from OrgMetadataCache / SchemaCache for the active org.
const REQ_OBJECT_LIST = 'sfx/objectList';   // ({ uri }) => string[]
const REQ_DESCRIBE = 'sfx/describe';        // ({ uri, sobject }) => HostDescribe
const REQ_PROJECT_INFO = 'sfx/projectInfo'; // ({ uri }) => { namespace: string | null }
const REQ_OBJECT_INFO = 'sfx/objectInfo';   // ({ uri, sobject }) => { description: string | null }
const NOTE_REFRESH = 'sfx/refreshSchema';   // host → server: org/schema changed
const NOTE_EPHEMERAL = 'sfx/ephemeralBuffers'; // host → server: docs that must never write stubs

// Buffer documents (e.g. the ASFX Workbench's hidden editors) whose IntelliSense
// may target a non-default org — we must NOT write SObject stub files for them,
// or a non-default org's schema would leak into the shared .sfdx stub folder.
const ephemeralDocs = new Set<string>();

interface HostField {
    name: string;
    type: string;
    label?: string;
    helpText?: string;
    length?: number;
    sortable?: boolean;
    aggregatable?: boolean;
    groupable?: boolean;
    nillable?: boolean;
    relationshipName?: string;
    referenceTo?: string[];
    picklistValues?: string[];
}
interface HostChildRelationship {
    name: string;
    childSObject: string;
}
interface HostDescribe {
    name?: string;
    label?: string;
    labelPlural?: string;
    keyPrefix?: string;
    custom?: boolean;
    queryable?: boolean;
    createable?: boolean;
    updateable?: boolean;
    deletable?: boolean;
    fields: HostField[];
    childRelationships: HostChildRelationship[];
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Apex *semantic* features (outline, syntax diagnostics, go-to-def for user code,
// signature help) — gated so we don't duplicate the official Salesforce Apex
// extension (auto-off when it's installed).
let apexFeatures = false;
// Apex *completion* (org-aware member fields, `new` constructors, type names) —
// additive and on by default; users can turn it off to avoid duplicate items.
let apexCompletion = true;
// Offline schema validation (Tier 1): flag `receiver.member` accesses whose member
// isn't a field/relationship of the resolved SObject. Gated with apexFeatures.
let apexValidateSchema = true;

// Cached per document version so we parse at most once per edit, on demand
// (completion/hover/definition/diagnostics all share the same parse).
const apexSymbolCache = new Map<string, { version: number; result: ApexParseResult }>();
function getApexParse(doc: TextDocument): ApexParseResult {
    const cached = apexSymbolCache.get(doc.uri);
    if (cached && cached.version === doc.version) return cached.result;
    const result = parseApex(doc.getText());
    apexSymbolCache.set(doc.uri, { version: doc.version, result });
    return result;
}

connection.onInitialize((params): InitializeResult => {
    const opts = params.initializationOptions || {};
    apexFeatures = !!opts.apexFeatures;
    apexCompletion = opts.apexCompletion !== false;
    apexValidateSchema = opts.apexValidateSchema !== false;

    // Workspace roots for the cross-file type index (go-to-definition).
    const roots: string[] = [];
    if (Array.isArray(params.workspaceFolders)) {
        for (const f of params.workspaceFolders) roots.push(f.uri);
    } else if (params.rootUri) {
        roots.push(params.rootUri);
    }
    WorkspaceIndex.setRoots(roots);
    // Write SObject stubs under the first workspace root (gitignored .sfdx area).
    if (roots[0]) {
        try {
            setStubRoot(fileURLToPath(roots[0]));
        } catch {
            setStubRoot(null);
        }
    }

    return {
        capabilities: {
            // Object form (not the number shorthand) so the client also sends
            // didSave — the schema/diagnostics pass refreshes on save.
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Incremental,
                save: { includeText: false },
            },
            completionProvider: {
                // Trigger on the characters that begin a new SOQL token position.
                triggerCharacters: ['.', ' ', ',', '(', '\n', '@'],
                resolveProvider: false,
            },
            documentSymbolProvider: apexFeatures ? true : undefined,
            // Definition is always on: SObject/field click-through to schema stubs
            // needs no Apex gating; Apex-symbol resolution is gated in the handler.
            definitionProvider: true,
            signatureHelpProvider: apexFeatures ? { triggerCharacters: ['(', ','] } : undefined,
            codeActionProvider: apexFeatures
                ? { codeActionKinds: [CodeActionKind.RefactorRewrite, CodeActionKind.QuickFix] }
                : undefined,
            workspaceSymbolProvider: apexFeatures ? true : undefined,
            // Hover is always on: SOQL field/object info needs no Apex gating;
            // Apex hover content is gated inside the handler.
            hoverProvider: true,
        },
    };
});

// Small helpers ----------------------------------------------------------------

function isPlaceholder(item: CompletionItem): boolean {
    return typeof item.label === 'string' && item.label.startsWith('__');
}

function ctxOf(item: CompletionItem): any {
    return (item.data && (item.data as any).soqlContext) || undefined;
}

// `docUri` lets the host resolve the right org per document (nested sub-projects
// each use their own default org).
async function objectList(docUri: string): Promise<string[]> {
    try {
        return (await connection.sendRequest<string[]>(REQ_OBJECT_LIST, { uri: docUri })) || [];
    } catch {
        return [];
    }
}

// Project namespace (from sfdx-project.json) per document, cached. Empty/absent → null.
const namespaceCache = new Map<string, string | null>();
async function projectNamespace(docUri: string): Promise<string | null> {
    if (namespaceCache.has(docUri)) return namespaceCache.get(docUri) ?? null;
    let ns: string | null = null;
    try {
        const info = await connection.sendRequest<{ namespace: string | null }>(REQ_PROJECT_INFO, { uri: docUri });
        ns = info && info.namespace ? info.namespace : null;
    } catch {
        ns = null;
    }
    namespaceCache.set(docUri, ns);
    return ns;
}

function hasNamespacePrefix(name: string, ns: string): boolean {
    return name.toLowerCase().startsWith(ns.toLowerCase() + '__');
}

// Object admin Description (Tooling API, fetched lazily on hover), cached per doc+object.
const objectDescriptionCache = new Map<string, string | null>();
async function objectDescription(docUri: string, sobject: string): Promise<string | null> {
    const key = `${docUri}|${sobject}`;
    if (objectDescriptionCache.has(key)) return objectDescriptionCache.get(key) ?? null;
    let desc: string | null = null;
    try {
        const res = await connection.sendRequest<{ description: string | null }>(REQ_OBJECT_INFO, { uri: docUri, sobject });
        desc = res ? res.description : null;
    } catch {
        desc = null;
    }
    objectDescriptionCache.set(key, desc);
    return desc;
}

async function fetchDescribe(docUri: string, sobject: string): Promise<HostDescribe | null> {
    try {
        return (await connection.sendRequest<HostDescribe | null>(REQ_DESCRIBE, { uri: docUri, sobject })) ?? null;
    } catch {
        return null;
    }
}

// No server-side describe cache: a single webview buffer (the ASFX/SOQL workbench)
// keeps ONE docUri but switches orgs over its lifetime, so caching by docUri here
// would serve a previous org's fields after an org switch. The host owns the
// authoritative per-org describe cache, so we always delegate to it (a host memory
// hit, no network). Namespace-aware: `Widget__c` falls back to `ns__Widget__c`.
async function describe(docUri: string, sobject: string): Promise<HostDescribe | null> {
    let res = await fetchDescribe(docUri, sobject);
    if (!res) {
        const ns = await projectNamespace(docUri);
        if (ns && !hasNamespacePrefix(sobject, ns)) {
            res = await fetchDescribe(docUri, `${ns}__${sobject}`);
        }
    }
    return res;
}

/**
 * In a namespaced project, the org returns API names with the namespace prefix
 * (`ns__Widget__c`) but it's optional to type. Set filterText to the
 * unprefixed name so typing `Prod` matches; label/insertText keep the namespace.
 */
function applyNamespace(items: CompletionItem[], ns: string | null): CompletionItem[] {
    if (!ns) return items;
    const prefix = ns.toLowerCase() + '__';
    for (const i of items) {
        if (typeof i.label === 'string' && i.label.toLowerCase().startsWith(prefix)) {
            i.filterText = i.label.slice(prefix.length);
        }
    }
    return items;
}

// Provenance footers shown in each item's documentation popup. The visible
// label slots (labelDetails.detail/description) carry type/owner info instead.
const ASFX_SCHEMA_FOOTER = '_— ASFX Toolkit · org schema_';
const ASFX_PLAIN_FOOTER = '_— ASFX Toolkit_';

function md(value: string): { kind: typeof MarkupKind.Markdown; value: string } {
    return { kind: MarkupKind.Markdown, value };
}

/** Attach a schema-item documentation popup (body lines + provenance footer). */
function withSchemaDoc(item: CompletionItem, body: string[]): CompletionItem {
    item.documentation = md([...body, ASFX_SCHEMA_FOOTER].join('\n\n'));
    return item;
}

/**
 * Ensure every returned item carries ASFX provenance in its documentation popup,
 * without consuming the visible label slots. Items we built already have a richer
 * schema doc; pass-through items (SOQL keywords) get a plain footer.
 */
function sfxTag(items: CompletionItem[]): CompletionItem[] {
    for (const i of items) {
        if (!i.documentation) i.documentation = md(ASFX_PLAIN_FOOTER);
    }
    return items;
}

// Standard audit/system fields are rarely the ones you want first.
const AUDIT_FIELDS = new Set([
    'createdbyid', 'createddate', 'lastmodifiedbyid', 'lastmodifieddate', 'systemmodstamp',
    'isdeleted', 'lastvieweddate', 'lastreferenceddate', 'lastactivitydate',
]);

/** Field sort tier (lower = higher): 0 business field, 2 audit/system field. */
function fieldSortTier(name: string): string {
    return AUDIT_FIELDS.has(name.toLowerCase()) ? '2' : '0';
}

function fieldItem(owner: string, f: HostField): CompletionItem {
    const sizeSuffix = f.length ? ` (${f.length})` : '';
    const item: CompletionItem = {
        label: f.name,
        kind: CompletionItemKind.Field,
        labelDetails: { detail: ` : ${f.type}`, description: owner },
        sortText: fieldSortTier(f.name) + '_' + f.name,
    };
    const body = ['```apex\n' + `${owner}.${f.name} : ${f.type}${sizeSuffix}` + '\n```'];
    if (f.label && f.label !== f.name) body.push(`**${f.label}**`);
    if (f.helpText) body.push(f.helpText);
    if (f.picklistValues && f.picklistValues.length) {
        const shown = f.picklistValues.slice(0, 12).join(', ');
        const more = f.picklistValues.length > 12 ? `, … (+${f.picklistValues.length - 12})` : '';
        body.push(`_Values:_ ${shown}${more}`);
    }
    if (f.nillable === false) body.push('_Required_');
    return withSchemaDoc(item, body);
}

/**
 * Sort tier for an SObject in completion (lower = higher in the list):
 *  0 = business objects (standard + custom `__c`),
 *  1 = metadata/platform-event/big/external objects (`__mdt`/`__e`/`__b`/`__x`),
 *  2 = auxiliary system objects (History / Share / Feed / ChangeEvent / Tag).
 * These are infrequently queried, so they sort below the rest.
 */
function objectSortTier(name: string): string {
    const n = name.toLowerCase();
    if (/(?:__)?(?:history|share|feed|changeevent|tag)$/.test(n)) return '2';
    if (/__(?:mdt|e|b|x)$/.test(n)) return '1';
    return '0';
}

function passesFlags(f: HostField, c: any): boolean {
    if (!c) return true;
    if (c.onlySortable && f.sortable === false) return false;
    if (c.onlyAggregatable && f.aggregatable === false) return false;
    if (c.onlyGroupable && f.groupable === false) return false;
    if (c.onlyNillable && f.nillable === false) return false;
    if (Array.isArray(c.onlyTypes) && c.onlyTypes.length && !c.onlyTypes.includes(f.type)) return false;
    return true;
}

// A relationship-traversal item, e.g. `Account` / `Owner` that you can dot into.
function relItem(owner: string, f: HostField): CompletionItem {
    // Lookups can be polymorphic (WhatId → Account | Opportunity | …); show every target,
    // and type it like a field so the details panel isn't blank for relationships.
    const targets = f.referenceTo && f.referenceTo.length ? f.referenceTo : [];
    const typeStr = targets.length ? targets.join(' | ') : '(relationship)';
    const item: CompletionItem = {
        label: f.relationshipName as string,
        kind: CompletionItemKind.Class,
        detail: `${typeStr} ${owner}.${f.relationshipName}`,
        labelDetails: { detail: ` : ${typeStr}`, description: owner },
        // Sort relationships just after their owning fields.
        sortText: '1_' + f.relationshipName,
    };
    return withSchemaDoc(item, [`\`${owner}.${f.relationshipName}\` → **${typeStr}**`]);
}

// Scalar fields (flag-filtered) plus, unless suppressed, relationship names to traverse.
function fieldsAndRels(owner: string, d: HostDescribe, c: any): CompletionItem[] {
    const out = d.fields.filter((f) => passesFlags(f, c)).map((f) => fieldItem(owner, f));
    if (!c?.dontShowRelationshipField) {
        for (const f of d.fields) {
            if (f.relationshipName) out.push(relItem(owner, f));
        }
    }
    return out;
}

/** Strip a leading managed-package namespace: `ns__Name__r` → `name__r` (lower-cased). */
function stripLeadingNamespace(name: string): string {
    const p = name.toLowerCase().split('__');
    return p.length >= 3 ? p.slice(1).join('__') : name.toLowerCase();
}

/** Namespace-optional, case-insensitive match (e.g. `DataSource__r` ≈ `sfy24__DataSource__r`). */
function nameMatchesNsOptional(apiName: string, typed: string): boolean {
    const a = apiName.toLowerCase();
    const b = typed.toLowerCase();
    return a === b || stripLeadingNamespace(a) === stripLeadingNamespace(b);
}

/** Namespace-optional prefix match for member completion: `datasource__c` matches `sfy24__Datasource__c`. */
function matchesMemberPrefix(label: string, partial: string): boolean {
    const l = label.toLowerCase();
    return l.startsWith(partial) || stripLeadingNamespace(l).startsWith(partial);
}

// Walk a parent-relationship path (e.g. ['Account','Owner']) from a base sobject
// to the final referenced sobject. Returns null if any hop can't be resolved.
// Relationship names match namespace-optionally so `X__r` resolves `ns__X__r`.
async function resolveRelationshipTarget(docUri: string, base: string, segments: string[]): Promise<string | null> {
    let current = base;
    for (const seg of segments) {
        const d = await describe(docUri, current);
        if (!d) return null;
        const f = d.fields.find(
            (x) => x.relationshipName && nameMatchesNsOptional(x.relationshipName, seg) && x.referenceTo && x.referenceTo.length,
        );
        if (!f || !f.referenceTo) return null;
        current = f.referenceTo[0];
    }
    return current;
}

// Expand one placeholder item into concrete, org-aware completion items.
// `relSegments` is the parent-relationship path typed before the cursor (e.g.
// `SELECT Account.Owner.|` → ['Account','Owner']), used to traverse for fields.
async function sobjectsCompletion(docUri: string): Promise<CompletionItem[]> {
    return (await objectList(docUri)).map((name) =>
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
async function childRelationshipsOf(docUri: string, parentName: string): Promise<CompletionItem[]> {
    const d = await describe(docUri, parentName);
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

async function expand(
    item: CompletionItem,
    relSegments: string[],
    docUri: string,
    forceObjects = false,
    subqueryParent: string | null = null,
): Promise<CompletionItem[]> {
    const label = item.label as string;
    const c = ctxOf(item);

    if (label === '__SOBJECTS_PLACEHOLDER') {
        // In a SELECT-list subquery (`SELECT …, (SELECT Id FROM |) FROM Parent`) the parser
        // sometimes emits SOBJECTS instead of RELATIONSHIPS depending on parse state. Force
        // child relationships of the outer object so it's consistent regardless of edits.
        if (subqueryParent) return childRelationshipsOf(docUri, subqueryParent);
        return sobjectsCompletion(docUri);
    }

    if (label === '__SOBJECT_FIELDS_PLACEHOLDER') {
        if (!c?.sobjectName) return [];
        const target = relSegments.length
            ? await resolveRelationshipTarget(docUri, c.sobjectName, relSegments)
            : c.sobjectName;
        const d = target ? await describe(docUri, target) : null;
        if (!d) return [];
        return fieldsAndRels(target as string, d, c);
    }

    if (label === '__RELATIONSHIPS_PLACEHOLDER') {
        // A WHERE/value-position subquery (`… IN (SELECT Id FROM |)`) is a semi-join
        // over an SObject, not a child-relationship subquery — offer objects.
        if (forceObjects) return sobjectsCompletion(docUri);
        // Prefer the text-derived outer object (reliable across edits) over the parser's
        // context, then fall back to it.
        const parent = subqueryParent || c?.sobjectName || null;
        if (!parent) return [];
        return childRelationshipsOf(docUri, parent);
    }

    if (label === '__RELATIONSHIP_FIELDS_PLACEHOLDER') {
        const parent = c?.sobjectName ? await describe(docUri, c.sobjectName) : null;
        const rel = parent?.childRelationships.find((r) => r.name === c?.relationshipName);
        const child = rel ? await describe(docUri, rel.childSObject) : null;
        if (!child || !rel) return [];
        return fieldsAndRels(rel.childSObject, child, c);
    }

    if (label === '__LITERAL_VALUES_FOR_FIELD') {
        const d = c?.sobjectName ? await describe(docUri, c.sobjectName) : null;
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

interface SoqlRegion {
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
function soqlRegionAt(text: string, offset: number): SoqlRegion | null {
    return inlineSoqlAt(text, offset) ?? dynamicSoqlAt(text, offset);
}

connection.onNotification(NOTE_REFRESH, () => {
    namespaceCache.clear();
    objectDescriptionCache.clear();
    apexSymbolCache.clear();
    clearStubs();
    invalidateStubbedNames(); // stubs may have been (re)generated → rescan for validation
    // Re-publish Apex diagnostics for open documents after a push/pull/refresh.
    for (const doc of documents.all()) publishApexDiagnostics(doc);
});

connection.onNotification(NOTE_EPHEMERAL, (params: { uris?: string[] }) => {
    ephemeralDocs.clear();
    for (const u of params?.uris ?? []) ephemeralDocs.add(u);
});

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
    const lines = text.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    off += column - 1;
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

connection.onCompletion(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    let text: string;
    let line: number;
    let column: number;

    if (doc.languageId === 'soql') {
        text = doc.getText();
        // soql-language-server expects 1-based line/column.
        line = params.position.line + 1;
        column = params.position.character + 1;
    } else {
        // Apex: inline [SELECT …] gets SOQL completion; otherwise try type-aware
        // member completion. Member completion runs even when Apex features are
        // gated off — its org-aware SObject field results are additive to the
        // Salesforce extension (which can't resolve org fields for these). Bare
        // (non-member) Apex completion is left to the other provider.
        const offset = doc.offsetAt(params.position);
        const region = soqlRegionAt(doc.getText(), offset);
        if (region) {
            // Apex bind variable inside inline SOQL: `:partial` → in-scope variables.
            const bindLine = doc.getText().slice(doc.getText().lastIndexOf('\n', offset - 1) + 1, offset);
            const bindM = /:\s*(\w*)$/.exec(bindLine);
            if (bindM) {
                const { index } = getApexParse(doc);
                const p = bindM[1].toLowerCase();
                const vars = inScopeVars(index, params.position.line, params.position.character).filter(
                    (v) => !p || v.name.toLowerCase().startsWith(p),
                );
                return sfxTag(
                    vars.map((v) =>
                        withSchemaDoc(
                            { label: v.name, kind: CompletionItemKind.Variable, labelDetails: { detail: ` : ${v.type}` }, sortText: '0_' + v.name },
                            ['`' + v.name + ' : ' + v.type + '` — bind variable'],
                        ),
                    ),
                );
            }
            text = region.snippet;
            line = region.line;
            column = region.column;
        } else {
            if (!apexCompletion) return [];
            const pick = await apexPicklistValueCompletion(doc, offset);
            if (pick.length) return pick;
            const ann = apexAnnotationCompletion(doc, offset);
            if (ann.length) return ann;
            const cat = apexCatchCompletion(doc, offset);
            if (cat.length) return cat;
            const ctorArgs = await apexConstructorArgCompletion(doc, offset);
            if (ctorArgs.length) return ctorArgs;
            const ctor = await apexNewCompletion(doc, offset);
            if (ctor.length) return ctor;
            const member = await apexMemberCompletion(doc, offset, params.position);
            if (member.length) return member;
            // Bare identifier position: SObject types + workspace user classes +
            // Salesforce standard-library types/namespaces.
            const out: CompletionItem[] = [];
            const seen = new Set<string>();
            for (const it of await apexTypeCompletion(doc, offset)) {
                if (seen.has(String(it.label))) continue;
                seen.add(String(it.label));
                out.push(it);
            }
            for (const it of apexGlobalCompletion(doc, offset)) {
                if (seen.has(String(it.label))) continue;
                seen.add(String(it.label));
                out.push(it);
            }
            return out;
        }
    }

    // The SOQL engine doesn't resolve parent-relationship traversal and emits no
    // field placeholder after `Account.`. So if a dotted path precedes the cursor,
    // resolve it ourselves from the query's FROM object and return those fields.
    const docUri = params.textDocument.uri;
    const ns = await projectNamespace(docUri);
    const relSegments = relationshipSegmentsBeforeCursor(text, line, column);
    if (relSegments.length) {
        const base = mainFromObject(text);
        if (base) {
            const target = await resolveRelationshipTarget(docUri, base, relSegments);
            const d = target ? await describe(docUri, target) : null;
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
            out.push(...(await expand(item, relSegments, docUri, forceObjects, subqueryParent)));
        } else {
            out.push(item);
        }
    }
    out.push(...soqlExtraCompletions(text, line, column));
    return sfxTag(applyNamespace(out, ns));
});

/**
 * True when the cursor sits inside a value-position subquery — `… IN (SELECT … FROM |)`
 * (a semi/anti-join). The enclosing `(` is preceded by IN / NOT IN, so the inner
 * FROM ranges over an SObject, not a child relationship.
 */
function inSemiJoinSubquery(text: string, line: number, column: number): boolean {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += column - 1;
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
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
    offset += column - 1;
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
function relationshipSegmentsBeforeCursor(text: string, line: number, column: number): string[] {
    const lineText = text.split('\n')[line - 1] ?? '';
    const upToCursor = lineText.slice(0, column - 1);
    const m = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\.\s*\w*$/.exec(upToCursor);
    if (!m) return [];
    return m[1].split('.').map((s) => s.trim()).filter(Boolean);
}

/** The object name of the (first) FROM clause in a SOQL string. */
function mainFromObject(text: string): string | null {
    const m = /\bFROM\s+([A-Za-z_]\w*)/i.exec(text);
    return m ? m[1] : null;
}

// ─── Apex member completion (gated) ─────────────────────────────────────────────

const APEX_MEMBER_KIND: Record<ApexMember['kind'], CompletionItemKind> = {
    method: CompletionItemKind.Method,
    field: CompletionItemKind.Field,
    property: CompletionItemKind.Property,
    constructor: CompletionItemKind.Constructor,
};

function memberItem(owner: string, m: ApexMember): CompletionItem {
    return withSchemaDoc(
        {
            label: m.name,
            kind: APEX_MEMBER_KIND[m.kind],
            labelDetails: { detail: m.detail ? ` : ${m.detail}` : undefined, description: owner },
            sortText: m.name,
        },
        [`\`${owner}.${m.name}\`${m.detail ? ' : ' + m.detail : ''} _(${m.kind})_`],
    );
}

/** Strip generic args / array suffix: `List<Account>` → `List`, `Account[]` → `Account`. */
function baseTypeName(type: string): string {
    return type.replace(/<.*$/, '').replace(/\[\]$/, '').trim();
}

const APEX_DECL_KEYWORDS = new Set([
    'return', 'new', 'else', 'final', 'public', 'private', 'protected', 'global', 'static',
    'void', 'if', 'for', 'while', 'do', 'try', 'catch', 'throw', 'this', 'super', 'instanceof',
]);

/**
 * Resolve a receiver's declared type by scanning the document text, as a fallback
 * when the parse index misses it (e.g. mid-edit, when the current line `emp.N`
 * makes the method body temporarily unparseable). Handles `Type receiver` and
 * `receiver = new Type(...)`.
 */
function regexReceiverType(text: string, receiver: string): string | undefined {
    const assign = new RegExp(`\\b${receiver}\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`).exec(text);
    if (assign) return assign[1];
    const decl = new RegExp(`\\b([A-Za-z_][\\w.]*(?:<[^>]*>)?)\\s+${receiver}\\b`).exec(text);
    if (decl && !APEX_DECL_KEYWORDS.has(decl[1].toLowerCase())) return decl[1];
    return undefined;
}

// A constructor item for `new <Type>(…)`.
function newTypeItem(typeName: string, tier: string): CompletionItem {
    return withSchemaDoc(
        {
            label: typeName,
            kind: CompletionItemKind.Constructor,
            insertText: `${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            labelDetails: { detail: '()' },
            sortText: tier + '_' + typeName,
        },
        ['new `' + typeName + '()`'],
    );
}

/** Apex primitives / value types that have no meaningful `new X()` constructor. */
const NON_CONSTRUCTABLE = new Set(
    ['string', 'integer', 'long', 'decimal', 'double', 'boolean', 'id', 'blob', 'date', 'datetime', 'time', 'object', 'void', 'sobject'],
);

/** A full `new Type()` expression item — includes the `new ` keyword (for the pre-`new` assignment position). */
function newExprItem(typeName: string, tier: string): CompletionItem {
    return withSchemaDoc(
        {
            label: `new ${typeName}()`,
            kind: CompletionItemKind.Constructor,
            insertText: `new ${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            filterText: `new ${typeName}`,
            labelDetails: { detail: '', description: 'construct' },
            sortText: tier + '_' + typeName,
        },
        ['`new ' + typeName + '()`'],
    );
}

/** Capture the declared/known type on an assignment LHS. `requireNew` matches after `new ` is typed. */
function expectedAssignType(doc: TextDocument, lineUpToCursor: string, requireNew: boolean): string | undefined {
    const tail = requireNew ? 'new\\s+[\\w.<>]*' : '(?:new\\s+[\\w.<>]*)?';
    // `Type name = [new …]` — Type may carry (possibly nested) generics: List<String>, Map<Id, List<X>>.
    const declared = new RegExp(`(?:^|[\\s({;,])([A-Za-z_][\\w.]*(?:\\s*<.*>)?)\\s+[A-Za-z_]\\w*\\s*=\\s*${tail}$`).exec(lineUpToCursor);
    if (declared) return declared[1].trim();
    // `existingVar = [new …]` — resolve the variable's type from the index.
    const reassign = new RegExp(`(?:^|[\\s({;,])([A-Za-z_]\\w*)\\s*=\\s*${tail}$`).exec(lineUpToCursor);
    if (reassign) return getApexParse(doc).index.varTypes.get(reassign[1]);
    return undefined;
}

/**
 * Suggest constructor expressions in Apex. Two positions:
 *  1. Right after an assignment `Type a = |` (before `new` is typed) → offers `new Type()`
 *     first, with declared generics preserved (`List<String> a = ` → `new List<String>()`).
 *  2. After `new ` → the assigned type first, then constructable SObjects.
 * Returns [] when not in either position.
 */
async function apexNewCompletion(doc: TextDocument, offset: number): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);

    const afterNew = /(?:^|[\s({,=])new\s+[A-Za-z_0-9.<>]*$/.test(lineUpToCursor);
    // Assignment RHS just opened (`… = |`), but not a comparison/compound op (`==`, `<=`, `+=`, …).
    const assignOpen = /(?:^|[^=!<>+\-*/%&|^])=\s*$/.test(lineUpToCursor);

    if (!afterNew && assignOpen) {
        const expected = expectedAssignType(doc, lineUpToCursor, false);
        if (!expected || NON_CONSTRUCTABLE.has(baseTypeName(expected).toLowerCase())) return [];
        return sfxTag(applyNamespace([newExprItem(expected, '0')], await projectNamespace(doc.uri)));
    }

    if (!afterNew) return [];

    // After `new `: the assigned type first, then collection snippets, then SObjects.
    const expected = expectedAssignType(doc, lineUpToCursor, true);
    const items: CompletionItem[] = [];
    if (expected) items.push(newTypeItem(expected, '0'));

    // Generic collection constructors as snippets (`new List<Account>()`, Map, Set).
    const collections: { label: string; insert: string; key: string }[] = [
        { label: 'List<…>()', insert: 'List<${1:SObject}>()', key: 'List' },
        { label: 'Map<…, …>()', insert: 'Map<${1:Id}, ${2:SObject}>()', key: 'Map' },
        { label: 'Set<…>()', insert: 'Set<${1:Id}>()', key: 'Set' },
    ];
    for (const c of collections) {
        items.push(
            withSchemaDoc(
                {
                    label: c.label,
                    kind: CompletionItemKind.Snippet,
                    insertText: c.insert,
                    insertTextFormat: InsertTextFormat.Snippet,
                    filterText: c.key,
                    detail: 'collection',
                    sortText: '0a_' + c.key,
                },
                ['`new ' + c.label + '`'],
            ),
        );
    }

    const expectedBase = expected ? baseTypeName(expected) : '';
    for (const name of await objectList(doc.uri)) {
        if (name === expectedBase) continue;
        items.push(newTypeItem(name, objectSortTier(name) === '0' ? '1' : '2'));
    }
    return sfxTag(applyNamespace(items, await projectNamespace(doc.uri)));
}

/**
 * Org-aware named-argument completion inside an SObject constructor —
 * `new Account(|)` / `new Account(Name = 'x', |)` — offers the object's fields as
 * `Field = ` from live schema (fields already supplied are filtered out). Only fires
 * for SObject types; user-class constructors fall through to other completion.
 */
async function apexConstructorArgCompletion(doc: TextDocument, offset: number): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    // `new Type(` with the cursor still inside the (unclosed) parens, no intervening generics.
    const m = /\bnew\s+([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const typeName = m[1];
    const argsSoFar = m[2];
    const lastSeg = argsSoFar.split(',').pop() ?? '';
    if (lastSeg.includes('=')) return []; // typing a value, not a field name
    const partial = (/([A-Za-z_]\w*)?$/.exec(lastSeg)?.[1] ?? '').toLowerCase();

    const d = await describe(doc.uri, baseTypeName(typeName));
    if (!d) return [];
    const used = new Set(
        argsSoFar
            .split(',')
            .map((s) => s.split('=')[0].trim().toLowerCase())
            .filter(Boolean),
    );
    const items = d.fields
        .filter((f) => !used.has(f.name.toLowerCase()))
        .filter((f) => !partial || matchesMemberPrefix(f.name.toLowerCase(), partial))
        .map((f) => {
            const item: CompletionItem = {
                label: f.name,
                kind: CompletionItemKind.Field,
                insertText: `${f.name} = `,
                labelDetails: { detail: ` : ${f.type}`, description: typeName },
                sortText: fieldSortTier(f.name) + '_' + f.name,
            };
            return withSchemaDoc(item, ['```apex\n' + `${typeName}.${f.name} : ${f.type}` + '\n```', '_constructor argument_']);
        });
    return sfxTag(applyNamespace(items, await projectNamespace(doc.uri)));
}

/**
 * Complete `receiver.partial` in Apex: resolve the receiver's type from the
 * document index (locals/params/fields, `this`) and list its members — either a
 * user type's members or, failing that, an SObject's fields from the org schema.
 */
async function apexMemberCompletion(
    doc: TextDocument,
    offset: number,
    pos: { line: number; character: number }
): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const receiver = m[1];
    const partial = m[2].toLowerCase();

    // Trigger context variables (`Trigger.new`, `Trigger.isInsert`, …), typed to the object.
    if (receiver === 'Trigger') return triggerMembers(full, partial);

    const { index } = getApexParse(doc);

    // Resolve the receiver to a type name. Fall back to a text scan when the parse
    // index doesn't have it (common while mid-typing the member access).
    let typeName: string | undefined;
    const scopedType = resolveVarType(index, receiver, pos.line, pos.character);
    if (receiver === 'this') {
        typeName = enclosingClass(index, pos.line, pos.character);
    } else if (scopedType) {
        typeName = scopedType; // scope-aware: the declaration in *this* method wins
    } else if (index.types.has(receiver)) {
        typeName = receiver; // static-ish access on a known type
    } else {
        typeName = regexReceiverType(full, receiver) ?? receiver; // text fallback, else maybe an SObject name
    }
    if (!typeName) return [];
    const base = baseTypeName(typeName);

    let items: CompletionItem[] = [];
    const userMembers = index.types.get(base);
    const stdMembers = stdMembersFor(base);
    // Cross-file user type defined in another workspace file (the common case in
    // the Execute Apex panel and when referencing other classes).
    const wsMembers = userMembers && userMembers.length ? undefined : WorkspaceIndex.findTypeMembers(base);
    if (userMembers && userMembers.length) {
        items = userMembers.map((m) => memberItem(base, m));
    } else if (wsMembers && wsMembers.length) {
        items = wsMembers.map((m) => memberItem(base, m));
    } else if (stdMembers) {
        // Static members of a Salesforce built-in namespace/type (System.debug…).
        items = stdMembers.map((m) => stdMemberItem(stdTypeName(base) ?? base, m));
    } else {
        // An SObject instance (namespace resolved inside describe): offer its fields
        // AND its parent relationships (`X__r`), same as the SOQL builder.
        const d = await describe(doc.uri, base);
        if (d) {
            for (const f of d.fields) {
                items.push(fieldItem(base, f));
                if (f.relationshipName) items.push(relItem(base, f));
            }
        }
    }

    // Namespace-optional prefix filter: a member typed `datasource__c` matches
    // `sfy24__Datasource__c`, and typing the namespaced form matches too.
    const filtered = partial ? items.filter((i) => matchesMemberPrefix(String(i.label), partial)) : items;
    return sfxTag(applyNamespace(filtered, await projectNamespace(doc.uri)));
}

/**
 * SObject type-name completion in Apex type positions (variable declarations,
 * generics, casts, `return`, `instanceof`). This is what gives namespace-optional
 * matching for types in Apex — typing `Widget__c` matches the namespaced
 * object via filterText. Conservative: only fires with a >=2 char prefix and in a
 * plausible type position, and items are deprioritized so locals stay on top.
 */
async function apexTypeCompletion(doc: TextDocument, offset: number): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);

    // Plausible type positions ending in the partial type name being typed.
    const typePos =
        /(?:^\s*|[<(,]\s*|\breturn\s+|\binstanceof\s+)([A-Za-z_]\w*)$/.exec(lineUpToCursor);
    if (!typePos) return [];
    const partial = typePos[1];
    if (partial.length < 2) return [];

    const ns = await projectNamespace(doc.uri);
    const objs = await objectList(doc.uri);
    const items: CompletionItem[] = objs.map((name) =>
        withSchemaDoc(
            {
                label: name,
                kind: CompletionItemKind.Class,
                labelDetails: { description: 'SObject' },
                // Deprioritized (tier 5/6) so they never outrank locals/keywords.
                sortText: (objectSortTier(name) === '0' ? '5_' : '6_') + name,
            },
            ['`' + name + '` — SObject'],
        ),
    );
    return sfxTag(applyNamespace(items, ns));
}

// A static member of a Salesforce built-in (e.g. `System.debug`).
function stdMemberItem(owner: string, m: StdMember): CompletionItem {
    const isMethod = m.kind === 'method';
    return withSchemaDoc(
        {
            label: m.name,
            kind: isMethod ? CompletionItemKind.Method : CompletionItemKind.Field,
            insertText: isMethod ? `${m.name}($0)` : m.name,
            insertTextFormat: isMethod ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
            labelDetails: { detail: m.detail.replace(/^\S+\s+\S+/, '').trim() || undefined, description: owner },
            sortText: '0_' + m.name,
        },
        ['`' + owner + '.' + m.detail + '`'],
    );
}

/**
 * Bare-identifier completion in Apex statement positions: workspace user classes
 * (so `MyService` completes) and Salesforce standard-library types/namespaces
 * (`System`, `Database`, `Math`, …). Skipped after a `.` (member access) and after
 * `new ` (handled by the constructor path). Deprioritized below locals/keywords.
 */
// Apex annotations offered after `@`. `snippet` (when present) fills in the common
// arguments as tabstops; otherwise the bare annotation is inserted.
interface AnnotationDef {
    name: string;
    snippet?: string;
    detail: string;
    doc: string;
}
const APEX_ANNOTATIONS: AnnotationDef[] = [
    { name: 'IsTest', detail: 'Test class / method', doc: 'Marks a class or method as a test.' },
    { name: "IsTest(SeeAllData=true)", snippet: 'IsTest(SeeAllData=true)', detail: 'Test with org data', doc: 'Test that can see existing org data.' },
    { name: 'TestSetup', detail: 'Test setup', doc: 'Creates records once for every test in the class.' },
    { name: 'TestVisible', detail: 'Expose to tests', doc: 'Makes a private/protected member visible to test methods.' },
    { name: 'AuraEnabled', detail: 'Expose to LWC / Aura', doc: 'Exposes a method or property to Lightning components.' },
    { name: 'AuraEnabled(cacheable=true)', snippet: 'AuraEnabled(cacheable=true)', detail: 'Cacheable (@wire)', doc: 'Read-only, cacheable method usable with @wire.' },
    { name: 'Future', detail: 'Async method', doc: 'Runs the static method asynchronously.' },
    { name: 'Future(callout=true)', snippet: 'Future(callout=true)', detail: 'Async + callouts', doc: 'Async method allowed to make callouts.' },
    { name: 'InvocableMethod', snippet: "InvocableMethod(label='${1:Label}' description='${2:Description}')", detail: 'Flow / REST action', doc: 'Exposes the method as an invocable action for Flow/REST.' },
    { name: 'InvocableVariable', snippet: "InvocableVariable(label='${1:Label}' description='${2:Description}' required=${3:false})", detail: 'Invocable variable', doc: 'Marks a field as input/output of an invocable method.' },
    { name: 'RemoteAction', detail: 'Visualforce remoting', doc: 'Exposes a static method to Visualforce JS remoting.' },
    { name: 'ReadOnly', detail: 'Read-only context', doc: 'Relaxes query row limits for read-only requests.' },
    { name: 'Deprecated', detail: 'Deprecated', doc: 'Marks the member deprecated for subscribers of a managed package.' },
    { name: 'SuppressWarnings', snippet: "SuppressWarnings('${1:PMD}')", detail: 'Suppress warnings', doc: 'Suppresses analyzer warnings on the element.' },
    { name: 'NamespaceAccessible', detail: 'Cross-package access', doc: 'Makes the member accessible to other packages that extend your namespace.' },
    { name: 'JsonAccess', snippet: "JsonAccess(serializable='${1:always}' deserializable='${2:always}')", detail: 'JSON (de)serialization', doc: 'Controls serialization/deserialization of the class across namespaces.' },
    { name: 'RestResource', snippet: "RestResource(urlMapping='/${1:resource}')", detail: 'REST resource', doc: 'Exposes an Apex class as a REST resource at a URL.' },
    { name: 'HttpGet', detail: 'REST GET', doc: 'Handles REST GET on the enclosing @RestResource.' },
    { name: 'HttpPost', detail: 'REST POST', doc: 'Handles REST POST on the enclosing @RestResource.' },
    { name: 'HttpPut', detail: 'REST PUT', doc: 'Handles REST PUT on the enclosing @RestResource.' },
    { name: 'HttpPatch', detail: 'REST PATCH', doc: 'Handles REST PATCH on the enclosing @RestResource.' },
    { name: 'HttpDelete', detail: 'REST DELETE', doc: 'Handles REST DELETE on the enclosing @RestResource.' },
];

/** Completion after `@` — Apex annotations, with argument snippets where useful. */
function apexAnnotationCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /@(\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const partial = m[1].toLowerCase();
    const items = APEX_ANNOTATIONS.filter((a) => !partial || a.name.toLowerCase().startsWith(partial)).map((a) => {
        const snippet = a.snippet !== undefined;
        // `@` is already typed and isn't a word char, so insert without it.
        const item: CompletionItem = {
            label: '@' + a.name,
            kind: CompletionItemKind.Keyword,
            insertText: a.snippet ?? a.name,
            insertTextFormat: snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
            filterText: a.name.replace(/[^\w].*$/, ''), // match the typed word after `@`
            detail: a.detail,
            sortText: '0_' + a.name,
        };
        return withSchemaDoc(item, [a.doc]);
    });
    return sfxTag(items);
}

// Common Apex statement snippets, triggered by typing their prefix (label).
const APEX_SNIPPETS: { label: string; insert: string; detail: string }[] = [
    { label: 'sysdebug', insert: 'System.debug(${1:msg});', detail: 'System.debug(…)' },
    { label: 'soqlfor', insert: 'for (${1:SObject} ${2:record} : [SELECT ${3:Id} FROM ${1:SObject}${4: WHERE }]) {\n\t$0\n}', detail: 'SOQL for-loop' },
    { label: 'forlist', insert: 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}', detail: 'for-each loop' },
    { label: 'ifelse', insert: 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}', detail: 'if / else' },
    { label: 'trycatch', insert: 'try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}', detail: 'try / catch' },
    { label: 'testmethod', insert: '@IsTest\nstatic void ${1:testName}() {\n\t$0\n}', detail: 'test method' },
    { label: 'auramethod', insert: "@AuraEnabled(cacheable=true)\npublic static ${1:Object} ${2:name}(${3}) {\n\t$0\n}", detail: 'cacheable AuraEnabled method' },
    { label: 'assertequals', insert: "Assert.areEqual(${1:expected}, ${2:actual}, '${3:message}');", detail: 'Assert.areEqual(…)' },
    { label: 'systemassert', insert: 'System.assertEquals(${1:expected}, ${2:actual});', detail: 'System.assertEquals(…)' },
    { label: 'insertdml', insert: 'insert ${1:records};', detail: 'insert DML' },
    { label: 'dbinsert', insert: 'Database.insert(${1:records}, ${2:false});', detail: 'Database.insert(…)' },
    { label: 'batchable', insert: 'global Database.QueryLocator start(Database.BatchableContext bc) {\n\treturn Database.getQueryLocator([SELECT Id FROM ${1:SObject}]);\n}\n\nglobal void execute(Database.BatchableContext bc, List<${1:SObject}> scope) {\n\t$0\n}\n\nglobal void finish(Database.BatchableContext bc) {\n}', detail: 'Batchable methods — add: implements Database.Batchable<SObject>' },
    { label: 'queueable', insert: 'public void execute(QueueableContext context) {\n\t$0\n}', detail: 'Queueable execute — add: implements Queueable' },
    { label: 'schedulable', insert: 'global void execute(SchedulableContext sc) {\n\t$0\n}', detail: 'Schedulable execute — add: implements Schedulable' },
    { label: 'trigger', insert: 'trigger ${1:Name} on ${2:SObject} (${3:before insert, after insert}) {\n\t$0\n}', detail: 'trigger declaration' },
    { label: 'triggerhandler', insert: 'switch on Trigger.operationType {\n\twhen BEFORE_INSERT {\n\t\t$1\n\t}\n\twhen AFTER_INSERT {\n\t\t$2\n\t}\n\twhen BEFORE_UPDATE {\n\t\t$3\n\t}\n\twhen AFTER_UPDATE {\n\t\t$0\n\t}\n}', detail: 'trigger context routing' },
];

// Standard Apex exception types, offered inside `catch (…)`.
const APEX_EXCEPTIONS = [
    'Exception', 'DmlException', 'QueryException', 'CalloutException', 'NullPointerException',
    'ListException', 'SObjectException', 'StringException', 'TypeException', 'MathException',
    'JSONException', 'NoAccessException', 'NoDataFoundException', 'LimitException', 'AsyncException',
    'SecurityException', 'InvalidParameterValueException', 'EmailException', 'SearchException', 'HandledException',
];

/** Completion inside `catch (…)` — standard Apex exception types. */
function apexCatchCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /\bcatch\s*\(\s*([A-Za-z_]\w*)?$/.exec(lineUpToCursor);
    if (!m) return [];
    const partial = (m[1] ?? '').toLowerCase();
    return sfxTag(
        APEX_EXCEPTIONS.filter((e) => !partial || e.toLowerCase().startsWith(partial)).map((e) =>
            withSchemaDoc(
                { label: e, kind: CompletionItemKind.Class, labelDetails: { description: 'exception' }, sortText: '0_' + e },
                ['`' + e + '` — Apex exception type'],
            ),
        ),
    );
}

/** Statement-snippet items for the bare-identifier position (filtered by the typed prefix). */
function apexSnippetCompletion(partial: string): CompletionItem[] {
    return APEX_SNIPPETS.filter((s) => !partial || s.label.startsWith(partial)).map((s) =>
        withSchemaDoc(
            {
                label: s.label,
                kind: CompletionItemKind.Snippet,
                insertText: s.insert,
                insertTextFormat: InsertTextFormat.Snippet,
                detail: s.detail,
                sortText: '5_' + s.label,
            },
            ['`' + s.detail + '` — snippet'],
        ),
    );
}

/** In-scope Apex variables/params/fields visible at a position (for SOQL bind completion). */
function inScopeVars(index: ApexIndex, line: number, character: number): { name: string; type: string }[] {
    const out: { name: string; type: string }[] = [];
    const seen = new Set<string>();
    for (const d of index.varDecls) {
        const s = d.scope;
        const within =
            (line > s.start.line || (line === s.start.line && character >= s.start.character)) &&
            (line < s.end.line || (line === s.end.line && character <= s.end.character));
        if (!within || d.line > line) continue;
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        out.push({ name: d.name, type: d.type });
    }
    return out;
}

/** The SObject a trigger fires on, from `trigger X on Object (...)`. */
function triggerObjectName(full: string): string {
    return /\btrigger\s+\w+\s+on\s+([A-Za-z_]\w*)/i.exec(full)?.[1] ?? 'SObject';
}

/** `Trigger.` context members, typed to the trigger's SObject. */
function triggerMembers(full: string, partial: string): CompletionItem[] {
    const obj = triggerObjectName(full);
    const members: { name: string; type: string }[] = [
        { name: 'new', type: `List<${obj}>` },
        { name: 'old', type: `List<${obj}>` },
        { name: 'newMap', type: `Map<Id, ${obj}>` },
        { name: 'oldMap', type: `Map<Id, ${obj}>` },
        { name: 'size', type: 'Integer' },
        { name: 'operationType', type: 'System.TriggerOperation' },
        { name: 'isExecuting', type: 'Boolean' },
        { name: 'isBefore', type: 'Boolean' },
        { name: 'isAfter', type: 'Boolean' },
        { name: 'isInsert', type: 'Boolean' },
        { name: 'isUpdate', type: 'Boolean' },
        { name: 'isDelete', type: 'Boolean' },
        { name: 'isUndelete', type: 'Boolean' },
    ];
    return sfxTag(
        members
            .filter((mm) => !partial || mm.name.toLowerCase().startsWith(partial))
            .map((mm) =>
                withSchemaDoc(
                    {
                        label: mm.name,
                        kind: CompletionItemKind.Field,
                        labelDetails: { detail: ` : ${mm.type}`, description: 'Trigger' },
                        sortText: '0_' + mm.name,
                    },
                    ['```apex\n' + `Trigger.${mm.name} : ${mm.type}` + '\n```'],
                ),
            ),
    );
}

/** Picklist value completion inside a string literal RHS: `acc.Industry = '|'`. */
async function apexPicklistValueCompletion(doc: TextDocument, offset: number): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const luc = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*(?:__c)?)\s*(?:=|==|!=|<>)\s*'([^']*)$/.exec(luc);
    if (!m) return [];
    const receiver = m[1];
    const field = m[2];
    const partial = m[3].toLowerCase();
    const { index } = getApexParse(doc);
    const pos = doc.positionAt(offset);
    const typeName = resolveVarType(index, receiver, pos.line, pos.character) ?? regexReceiverType(full, receiver) ?? receiver;
    const d = await describe(doc.uri, baseTypeName(typeName));
    if (!d) return [];
    const f = d.fields.find((x) => x.name.toLowerCase() === field.toLowerCase() || nameMatchesNsOptional(x.name, field));
    if (!f || !f.picklistValues || !f.picklistValues.length) return [];
    return sfxTag(
        f.picklistValues
            .filter((v) => !partial || v.toLowerCase().startsWith(partial))
            .map((v) =>
                withSchemaDoc(
                    { label: v, kind: CompletionItemKind.EnumMember, insertText: v, detail: `${baseTypeName(typeName)}.${f.name}`, sortText: '0_' + v },
                    ['`' + v + '` — picklist value'],
                ),
            ),
    );
}

function apexGlobalCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const before = lineUpToCursor.slice(0, m.index).trimEnd();
    if (before.endsWith('.') || /\bnew$/.test(before)) return [];
    const partial = m[1].toLowerCase();

    const items: CompletionItem[] = [];

    // Workspace user classes/triggers.
    for (const name of WorkspaceIndex.allTypeNames()) {
        if (partial && !name.toLowerCase().startsWith(partial)) continue;
        items.push(
            withSchemaDoc(
                {
                    label: name,
                    kind: CompletionItemKind.Class,
                    labelDetails: { description: 'Apex class' },
                    sortText: '3_' + name,
                },
                ['`' + name + '` — Apex class'],
            ),
        );
    }

    // Salesforce standard library types & namespaces.
    for (const name of STD_TYPES) {
        if (partial && !name.toLowerCase().startsWith(partial)) continue;
        items.push(
            withSchemaDoc(
                {
                    label: name,
                    kind: CompletionItemKind.Class,
                    labelDetails: { description: 'System' },
                    sortText: '4_' + name,
                },
                ['`' + name + '` — Salesforce system type'],
            ),
        );
    }

    // Common Apex statement snippets (sysdebug, soqlfor, testmethod, …).
    items.push(...apexSnippetCompletion(partial));

    return sfxTag(items);
}

// ─── Apex outline + syntax diagnostics (gated) ──────────────────────────────────

function isApex(uri: string): boolean {
    return /\.(cls|trigger)$/i.test(uri) || /\.apex$/i.test(uri);
}

// Diagnostics are intentionally NOT recomputed on every keystroke (to avoid
// per-edit parsing). We publish them when a document opens or is saved, and refresh
// on push/pull/org change (via NOTE_REFRESH). Syntax diagnostics go out immediately;
// the org-aware schema pass (async describe calls) runs debounced and re-publishes
// the merged set. Completion/hover/definition still parse on demand (version-cached).
/** Body spans `{…}` of every `for`/`while`/`do` loop, for the SOQL/DML-in-loop lint. */
function loopBodies(text: string): { start: number; end: number }[] {
    const bodies: { start: number; end: number }[] = [];
    const re = /\b(for|while)\s*\(|\bdo\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        let i = re.lastIndex;
        if (m[1]) {
            let depth = 1; // skip the (…) condition
            while (i < text.length && depth > 0) {
                const ch = text[i++];
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
        }
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === '{') {
            let depth = 1;
            const start = ++i;
            while (i < text.length && depth > 0) {
                const ch = text[i++];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            bodies.push({ start, end: i - 1 });
        }
    }
    return bodies;
}

/** Brace nesting depth at an offset (0 = top level), used to limit lints to top-level classes. */
function braceDepthAt(text: string, off: number): number {
    let d = 0;
    for (let i = 0; i < off && i < text.length; i++) {
        const c = text[i];
        if (c === '{') d++;
        else if (c === '}') d--;
    }
    return d;
}

/**
 * Lightweight, heuristic Apex lints published alongside syntax/schema diagnostics:
 * SOQL/DML in loops, hardcoded IDs, leftover System.debug, and classes missing a
 * sharing declaration. Text-based (no parse) so it stays cheap; source `asfx-apex-lint`.
 */
function lintApex(doc: TextDocument): Diagnostic[] {
    const text = doc.getText();
    const diags: Diagnostic[] = [];
    const add = (off: number, len: number, message: string, severity: DiagnosticSeverity) =>
        diags.push({
            range: { start: doc.positionAt(off), end: doc.positionAt(off + len) },
            message,
            severity,
            source: 'asfx-apex-lint',
        });

    for (const m of text.matchAll(/\bSystem\.debug\s*\(/g)) {
        add(m.index ?? 0, 12, 'Leftover System.debug() — remove before deploying.', DiagnosticSeverity.Information);
    }
    for (const m of text.matchAll(/'(?:[A-Za-z0-9]{18}|[A-Za-z0-9]{15})'/g)) {
        add(m.index ?? 0, m[0].length, 'Possible hardcoded Salesforce ID — avoid hardcoding record IDs.', DiagnosticSeverity.Warning);
    }

    const bodies = loopBodies(text);
    if (bodies.length) {
        const inLoop = (off: number) => bodies.some((b) => off >= b.start && off < b.end);
        for (const m of text.matchAll(/\[\s*SELECT\b/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].length, 'SOQL query inside a loop — move it out to avoid governor limits.', DiagnosticSeverity.Warning);
        }
        for (const m of text.matchAll(/\b(?:insert|update|upsert|delete|undelete)\b\s+[A-Za-z_([]/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].trimEnd().length, 'DML inside a loop — bulkify (collect records, DML once).', DiagnosticSeverity.Warning);
        }
        for (const m of text.matchAll(/\bDatabase\.(?:insert|update|upsert|delete|undelete)\s*\(/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].length, 'DML inside a loop — bulkify (collect records, DML once).', DiagnosticSeverity.Warning);
        }
    }

    for (const m of text.matchAll(/\b(?:public|global)\s+((?:(?:virtual|abstract|with|without|inherited|sharing)\s+)*)class\s+(\w+)/gi)) {
        if (/sharing/i.test(m[1]) || braceDepthAt(text, m.index ?? 0) !== 0) continue;
        add(m.index ?? 0, m[0].length, `Class ${m[2]} declares no sharing (with / without / inherited sharing).`, DiagnosticSeverity.Information);
    }

    return diags;
}

function publishApexDiagnostics(doc: TextDocument): void {
    if (!apexFeatures || doc.languageId === 'soql' || !isApex(doc.uri)) return;
    const parse = getApexParse(doc);
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [...parse.diagnostics, ...lintApex(doc)] });
    if (apexValidateSchema) scheduleSchemaValidation(doc.uri);
}

// Debounced, per-document schema validation. Coalesces bursts (open+save) and
// drops stale runs when the document changes underneath us.
const schemaTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleSchemaValidation(uri: string): void {
    const prev = schemaTimers.get(uri);
    if (prev) clearTimeout(prev);
    schemaTimers.set(uri, setTimeout(() => { schemaTimers.delete(uri); void runSchemaValidation(uri); }, 300));
}

/** Suffixes that make a name a custom SObject: object, big object, platform event, custom metadata, external object. */
const CUSTOM_SOBJECT_SUFFIX = /__(c|b|e|mdt|x)$/i;

/**
 * Common standard objects declared as Apex variable types. Not exhaustive — custom
 * SObjects are recognized by their suffix, and a standard object missing here simply
 * isn't validated (conservative, no false positive). Local/workspace types shadow these.
 */
const STANDARD_SOBJECTS = new Set([
    'account', 'accountcontactrelation', 'asset', 'attachment', 'businesshours', 'campaign', 'campaignmember',
    'case', 'casecomment', 'contact', 'contentdocument', 'contentdocumentlink', 'contentnote', 'contentversion',
    'contract', 'dashboard', 'document', 'emailmessage', 'entitlement', 'event', 'eventrelation', 'feedcomment',
    'feeditem', 'group', 'groupmember', 'holiday', 'idea', 'individual', 'lead', 'note', 'opportunity',
    'opportunitycontactrole', 'opportunitylineitem', 'opportunityteammember', 'order', 'orderitem', 'organization',
    'period', 'permissionset', 'permissionsetassignment', 'pricebook2', 'pricebookentry', 'processinstance',
    'product2', 'profile', 'quote', 'quotelineitem', 'recordtype', 'report', 'serviceappointment', 'servicecontract',
    'site', 'solution', 'task', 'territory2', 'topic', 'user', 'userrole', 'workorder', 'workorderlineitem',
]);

/**
 * A name that is obviously NOT an org SObject and must never be resolved via the
 * describe API: generics/arrays/qualified names, the abstract `SObject`, Apex system
 * types, and any class/trigger defined in the workspace.
 */
function isNonSObjectName(name: string): boolean {
    if (!name || /[<>[\]\s.,()]/.test(name)) return true; // generics, arrays, qualified, calls
    if (name.toLowerCase() === 'sobject') return true;    // the abstract base type
    if (stdTypeName(name)) return true;                   // System/Database/… and value types
    if (WorkspaceIndex.hasType(name)) return true;        // a class/trigger defined in this project
    return false;
}

async function runSchemaValidation(uri: string): Promise<void> {
    const doc = documents.get(uri);
    if (!doc || !apexFeatures || !apexValidateSchema || ephemeralDocs.has(uri) || doc.languageId === 'soql' || !isApex(uri)) return;
    const atStart = doc.version;
    const parse = getApexParse(doc);
    try {
        // Decide if a receiver type is an SObject with no API probing — easy logic:
        //   • a type declared in this file (class/enum/inner class), a workspace class,
        //     a generic/system type → NOT an SObject (a local `Event` beats the SObject).
        //   • a custom suffix (__c/__b/__e/__mdt/__x) → a custom SObject.
        //   • a name we've generated an org stub for → a real SObject (covers standard
        //     objects the org actually uses, beyond the built-in list).
        //   • otherwise, a known standard object from the built-in list.
        const localTypes = new Set([...parse.index.types.keys()].map((t) => t.toLowerCase()));
        const stubbed = stubbedObjectNames();
        const shouldDescribe = (s: string): boolean => {
            const l = s.toLowerCase();
            if (isNonSObjectName(s) || localTypes.has(l)) return false;
            return CUSTOM_SOBJECT_SUFFIX.test(s) || stubbed.has(l) || STANDARD_SOBJECTS.has(l);
        };

        const schema = await validateFieldAccesses(parse.fieldAccesses, {
            varTypeAt: (name, line, character) => resolveVarType(parse.index, name, line, character),
            describe: (s) => (shouldDescribe(s) ? describe(uri, s) : Promise.resolve(null)),
            resolveRelTarget: (base, hops) => resolveRelationshipTarget(uri, base, hops),
        });
        // Drop the result if the document changed while we were awaiting describes;
        // a newer edit will have scheduled its own run.
        const live = documents.get(uri);
        if (!live || live.version !== atStart) return;
        connection.sendDiagnostics({ uri, diagnostics: [...getApexParse(live).diagnostics, ...lintApex(live), ...schema] });
    } catch {
        // Keep the already-published syntax diagnostics; schema pass is best-effort.
    }
}

documents.onDidOpen((e) => publishApexDiagnostics(e.document));
documents.onDidSave((e) => publishApexDiagnostics(e.document));
documents.onDidClose((e) => {
    apexSymbolCache.delete(e.document.uri);
    const t = schemaTimers.get(e.document.uri);
    if (t) { clearTimeout(t); schemaTimers.delete(e.document.uri); }
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

connection.onDocumentSymbol((params) => {
    if (!apexFeatures) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc || !isApex(doc.uri)) return [];
    return getApexParse(doc).symbols;
});

// ─── Go-to-definition: Apex symbols + SObject/field schema stubs ──────────────────

/** A Location into a generated SObject schema stub (object or specific field). */
async function stubLocation(docUri: string, sobject: string, field: string | null): Promise<Location | null> {
    // Never write/generate stub files for ephemeral buffers (their org may be
    // non-default — writing would contaminate the shared .sfdx stubs).
    if (ephemeralDocs.has(docUri)) return null;
    const d = await describe(docUri, sobject);
    if (!d) return null;
    const info = getStub(sobject, d);
    if (!info) return null;
    const line = field ? info.fieldLines.get(field.toLowerCase()) ?? info.classLine : info.classLine;
    return { uri: info.uri, range: Range.create(line, 0, line, 200) };
}

/** Resolve a word in a SOQL context to an SObject (object name) or one of its fields. */
async function soqlDefinition(docUri: string, soqlText: string, line: number, col: number, word: string): Promise<Location | null> {
    const base = mainFromObject(soqlText);
    if (!base) return null;
    if (word.toLowerCase() === base.toLowerCase()) return stubLocation(docUri, base, null);
    const segs = relationshipSegmentsBeforeCursor(soqlText, line, col);
    const target = segs.length ? await resolveRelationshipTarget(docUri, base, segs) : base;
    if (!target) return null;
    return stubLocation(docUri, target, word);
}

async function apexDefinition(doc: TextDocument, offset: number, pos: { line: number; character: number }): Promise<Location | null> {
    const text = doc.getText();
    const span = wordSpanAt(text, offset);
    if (!span) return null;
    const [start, , word] = span;
    const { index } = getApexParse(doc);
    const receiver = receiverBefore(text, start);

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
        if (await describe(doc.uri, base)) return stubLocation(doc.uri, base, word);
        return null;
    }

    // Bare identifier: in-file decl / workspace type (gated), else SObject stub.
    if (apexFeatures) {
        const local = index.decls.get(word);
        if (local) return { uri: doc.uri, range: local };
        const wt = WorkspaceIndex.findType(word);
        if (wt) return wt;
    }
    if (await describe(doc.uri, word)) return stubLocation(doc.uri, word, null);
    return null;
}

connection.onDefinition(async (params): Promise<Location | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const offset = doc.offsetAt(params.position);

    if (doc.languageId === 'soql') {
        const span = wordSpanAt(doc.getText(), offset);
        if (!span) return null;
        return soqlDefinition(doc.uri, doc.getText(), params.position.line + 1, params.position.character + 1, span[2]);
    }
    if (!isApex(doc.uri)) return null;

    // Inline [SELECT …] / dynamic-SOQL string in Apex → SObject/field stub; else Apex definition.
    const region = soqlRegionAt(doc.getText(), offset);
    if (region) {
        const span = wordSpanAt(region.snippet, offset - region.contentStart);
        if (!span) return null;
        return soqlDefinition(doc.uri, region.snippet, region.line, region.column, span[2]);
    }
    return apexDefinition(doc, offset, params.position);
});

// ─── Signature help for user methods (gated) ─────────────────────────────────────

function parseParamsFromLabel(label: string): ParameterInformation[] {
    const open = label.indexOf('(');
    const close = label.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    const inner = label.slice(open + 1, close).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => ParameterInformation.create(p.trim()));
}

connection.onSignatureHelp((params): SignatureHelp | null => {
    if (!apexFeatures) return null;
    const doc = documents.get(params.textDocument.uri);
    if (!doc || !isApex(doc.uri)) return null;
    const text = doc.getText();
    const offset = doc.offsetAt(params.position);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = text.slice(lineStart, offset);

    // Innermost open call: methodName( …args-so-far
    const m = /([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(lineUpToCursor);
    if (!m) return null;
    const name = m[1];
    const argsSoFar = m[2];
    const activeParameter = argsSoFar.length ? (argsSoFar.match(/,/g)?.length ?? 0) : 0;

    const { index } = getApexParse(doc);
    const sigs = index.methods.get(name);
    if (!sigs || !sigs.length) return null;

    const signatures: SignatureInformation[] = sigs.map((label) => ({
        label,
        parameters: parseParamsFromLabel(label),
    }));
    return { signatures, activeSignature: 0, activeParameter };
});

// ─── Hover (SOQL always; Apex gated) ─────────────────────────────────────────────

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

/** Word boundaries around an offset: returns [start, end, word] or null. */
function wordSpanAt(text: string, offset: number): [number, number, string] | null {
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    const word = text.slice(start, end);
    return /^[A-Za-z_]\w*$/.test(word) ? [start, end, word] : null;
}

/** Identifier immediately before a `.` that precedes `wordStart`, or null. */
function receiverBefore(text: string, wordStart: number): string | null {
    let i = wordStart - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (text[i] !== '.') return null;
    i--;
    while (i >= 0 && /\s/.test(text[i])) i--;
    let end = i + 1;
    let start = end;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    const recv = text.slice(start, end);
    return /^[A-Za-z_]\w*$/.test(recv) ? recv : null;
}

async function apexHover(doc: TextDocument, offset: number, pos: { line: number; character: number }): Promise<Hover | null> {
    const text = doc.getText();
    const span = wordSpanAt(text, offset);
    if (!span) return null;
    const [start, , word] = span;
    const { index } = getApexParse(doc);

    const receiver = receiverBefore(text, start);
    if (receiver) {
        const typeName =
            receiver === 'this'
                ? enclosingClass(index, pos.line, pos.character)
                : index.varTypes.get(receiver) ?? regexReceiverType(text, receiver) ?? receiver;
        if (!typeName) return null;
        const base = baseTypeName(typeName);
        const member = index.types.get(base)?.find((m) => m.name === word);
        if (member) return codeHover(`(${member.kind}) ${base}.${word}${member.detail ? ' : ' + member.detail : ''}`);
        // Cross-file user type member.
        const wsm = WorkspaceIndex.findTypeMembers(base)?.find((m) => m.name === word);
        if (wsm) return codeHover(`(${wsm.kind}) ${base}.${word}${wsm.detail ? ' : ' + wsm.detail : ''}`);
        // Salesforce standard-library member (System.debug, Database.query…).
        const sm = stdMembersFor(base)?.find((m) => m.name.toLowerCase() === word.toLowerCase());
        if (sm) return codeHover(`${stdTypeName(base) ?? base}.${sm.detail}`);
        const d = await describe(doc.uri, base);
        if (d) {
            const f = d.fields.find((x) => x.name.toLowerCase() === word.toLowerCase());
            if (f) return fieldHover(base, f);
            const r = d.fields.find((x) => x.relationshipName && x.relationshipName.toLowerCase() === word.toLowerCase());
            if (r) return codeHover(`${base}.${r.relationshipName} → ${r.referenceTo?.join(' | ') || '?'}`);
        }
        return null;
    }

    const methods = index.methods.get(word);
    if (methods && methods.length) return codeHover(methods.join('\n'));
    const varType = index.varTypes.get(word);
    if (varType) return codeHover(`${word} : ${varType}`);
    if (index.types.has(word)) return codeHover(`type ${word}`);
    const d = await describe(doc.uri, word);
    if (d) return objectHover(word, d, await objectDescription(doc.uri, word));
    // Workspace user class / Salesforce standard-library type.
    if (WorkspaceIndex.findTypeMembers(word)) return codeHover(`class ${word}`);
    const std = stdTypeName(word);
    if (std) return codeHover(`${std} — Salesforce system type`);
    return null;
}

/** Hover for a SOQL field/object: resolve the word against the query's object. */
async function soqlHover(docUri: string, soqlText: string, line: number, column: number, word: string): Promise<Hover | null> {
    const segments = relationshipSegmentsBeforeCursor(soqlText, line, column);
    const base = mainFromObject(soqlText);
    if (base && word.toLowerCase() === base.toLowerCase()) {
        return objectHover(base, await describe(docUri, base), await objectDescription(docUri, base));
    }
    if (!base) return null;
    const target = segments.length ? await resolveRelationshipTarget(docUri, base, segments) : base;
    const d = target ? await describe(docUri, target) : null;
    if (!d) return null;
    const f = d.fields.find((x) => x.name.toLowerCase() === word.toLowerCase());
    if (f) return fieldHover(target as string, f);
    const r = d.fields.find((x) => x.relationshipName && x.relationshipName.toLowerCase() === word.toLowerCase());
    if (r) return codeHover(`${target}.${r.relationshipName} → ${r.referenceTo?.join(' | ') || '?'}`);
    return null;
}

connection.onHover(async (params): Promise<Hover | null> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;
    const offset = doc.offsetAt(params.position);

    if (doc.languageId === 'soql') {
        const span = wordSpanAt(doc.getText(), offset);
        if (!span) return null;
        return soqlHover(doc.uri, doc.getText(), params.position.line + 1, params.position.character + 1, span[2]);
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
        return soqlHover(doc.uri, region.snippet, region.line, region.column, span[2]);
    }
    return apexHover(doc, offset, params.position);
});

// Standard interfaces whose method stubs can be generated when a class declares them.
const IFACE_STUBS: { match: RegExp; key: string; title: string; body: string }[] = [
    {
        match: /Database\.Batchable/i,
        key: 'execute',
        title: 'Database.Batchable',
        body:
            '\tglobal Database.QueryLocator start(Database.BatchableContext bc) {\n' +
            '\t\treturn Database.getQueryLocator([SELECT Id FROM SObject]);\n\t}\n\n' +
            '\tglobal void execute(Database.BatchableContext bc, List<SObject> scope) {\n\t\t\n\t}\n\n' +
            '\tglobal void finish(Database.BatchableContext bc) {\n\t}\n',
    },
    { match: /(?:^|[\s,])Queueable\b/, key: 'execute', title: 'Queueable', body: '\tpublic void execute(QueueableContext context) {\n\t\t\n\t}\n' },
    { match: /(?:^|[\s,])Schedulable\b/, key: 'execute', title: 'Schedulable', body: '\tglobal void execute(SchedulableContext sc) {\n\t\t\n\t}\n' },
    { match: /(?:^|[\s,])Comparable\b/, key: 'compareto', title: 'Comparable', body: '\tpublic Integer compareTo(Object other) {\n\t\treturn 0;\n\t}\n' },
];

// Apex code actions: surround a selection with try/catch, and modernize legacy asserts.
connection.onCodeAction((params): CodeAction[] => {
    if (!apexCompletion) return [];
    const doc = documents.get(params.textDocument.uri);
    if (!doc || doc.languageId === 'soql') return [];
    const uri = params.textDocument.uri;
    const range = params.range;
    const actions: CodeAction[] = [];

    // 1. Surround selection with try/catch.
    const selected = doc.getText(range);
    if (selected.trim().length > 0) {
        const inner = selected
            .split('\n')
            .map((l) => '\t' + l)
            .join('\n');
        const wrapped = 'try {\n' + inner + '\n} catch (Exception e) {\n\t\n}';
        actions.push({
            title: 'Surround with try/catch',
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [uri]: [TextEdit.replace(range, wrapped)] } },
        });
    }

    // 2. Convert legacy System.assert* → Assert.* on the touched lines.
    const full = doc.getText();
    const lines = full.split('\n');
    const conversions: { re: RegExp; to: string }[] = [
        { re: /System\.assertEquals\(/g, to: 'Assert.areEqual(' },
        { re: /System\.assertNotEquals\(/g, to: 'Assert.areNotEqual(' },
        { re: /System\.assert\(/g, to: 'Assert.isTrue(' },
    ];
    const edits: TextEdit[] = [];
    for (let ln = range.start.line; ln <= range.end.line && ln < lines.length; ln++) {
        const lineText = lines[ln];
        for (const { re, to } of conversions) {
            re.lastIndex = 0;
            let mm: RegExpExecArray | null;
            while ((mm = re.exec(lineText))) {
                edits.push(TextEdit.replace(Range.create(ln, mm.index, ln, mm.index + mm[0].length), to));
            }
        }
    }
    if (edits.length) {
        actions.push({
            title: 'Convert System.assert* → Assert.*',
            kind: CodeActionKind.QuickFix,
            edit: { changes: { [uri]: edits } },
        });
    }

    // 3. Class-level: generate a constructor and implement declared standard interfaces.
    const index = getApexParse(doc).index;
    let cls: { name: string; range: Range } | undefined;
    let best = Infinity;
    for (const c of index.classRanges) {
        const r = c.range;
        const inside =
            (range.start.line > r.start.line || (range.start.line === r.start.line && range.start.character >= r.start.character)) &&
            (range.start.line < r.end.line || (range.start.line === r.end.line && range.start.character <= r.end.character));
        if (!inside) continue;
        const size = r.end.line - r.start.line;
        if (size < best) {
            best = size;
            cls = c;
        }
    }
    if (cls) {
        const members = index.types.get(cls.name) ?? [];
        const at = { line: range.start.line, character: 0 };

        const fields = members.filter((m) => m.kind === 'field' || m.kind === 'property');
        if (fields.length) {
            const paramList = fields.map((f) => `${f.detail ?? 'Object'} ${f.name}`).join(', ');
            const assigns = fields.map((f) => `\t\tthis.${f.name} = ${f.name};`).join('\n');
            const ctor = `\tpublic ${cls.name}(${paramList}) {\n${assigns}\n\t}\n\n`;
            actions.push({
                title: `Generate constructor (${fields.length} field${fields.length === 1 ? '' : 's'})`,
                kind: CodeActionKind.RefactorRewrite,
                edit: { changes: { [uri]: [TextEdit.insert(at, ctor)] } },
            });
        }

        const headerStart = doc.offsetAt(cls.range.start);
        const braceIdx = full.indexOf('{', headerStart);
        const header = full.slice(headerStart, braceIdx >= 0 ? braceIdx : headerStart + 200);
        const memberNames = new Set(members.map((m) => m.name.toLowerCase()));
        for (const s of IFACE_STUBS) {
            if (!s.match.test(header) || memberNames.has(s.key)) continue;
            actions.push({
                title: `Implement ${s.title} methods`,
                kind: CodeActionKind.QuickFix,
                edit: { changes: { [uri]: [TextEdit.insert(at, s.body + '\n')] } },
            });
        }

        // Generate a sibling test class (new file + meta.xml) for a non-test top-level class.
        if (!/@IsTest/i.test(header) && braceDepthAt(full, headerStart) === 0) {
            const dir = uri.slice(0, uri.lastIndexOf('/'));
            const testUri = `${dir}/${cls.name}Test.cls`;
            const metaUri = `${testUri}-meta.xml`;
            const testBody =
                `@IsTest\nprivate class ${cls.name}Test {\n` +
                `\t@IsTest\n\tstatic void test${cls.name}() {\n` +
                `\t\t// TODO: arrange, act, assert\n\t\tAssert.isTrue(true);\n\t}\n}\n`;
            const metaBody =
                '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
                '\t<apiVersion>61.0</apiVersion>\n\t<status>Active</status>\n</ApexClass>\n';
            actions.push({
                title: `Generate test class ${cls.name}Test`,
                kind: CodeActionKind.RefactorRewrite,
                edit: {
                    documentChanges: [
                        CreateFile.create(testUri, { ignoreIfExists: true }),
                        { textDocument: { uri: testUri, version: null }, edits: [TextEdit.insert({ line: 0, character: 0 }, testBody)] },
                        CreateFile.create(metaUri, { ignoreIfExists: true }),
                        { textDocument: { uri: metaUri, version: null }, edits: [TextEdit.insert({ line: 0, character: 0 }, metaBody)] },
                    ],
                },
            });
        }
    }

    return actions;
});

// Apex workspace symbols — jump to any class/trigger in the project.
connection.onWorkspaceSymbol((params): SymbolInformation[] => {
    if (!apexFeatures) return [];
    const q = (params.query ?? '').toLowerCase();
    const out: SymbolInformation[] = [];
    for (const name of WorkspaceIndex.allTypeNames()) {
        if (q && !name.toLowerCase().includes(q)) continue;
        const location = WorkspaceIndex.findType(name);
        if (!location) continue;
        out.push({ name, kind: SymbolKind.Class, location });
        if (out.length >= 200) break;
    }
    return out;
});

documents.listen(connection);
connection.listen();
