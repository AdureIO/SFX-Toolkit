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
} from 'vscode-languageserver/node';
import { fileURLToPath } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { completionsFor } from '@salesforce/soql-language-server/lib/completion';
import { parseApex, enclosingClass, ApexParseResult, ApexMember } from './apexSymbols';
import { WorkspaceIndex } from './workspaceIndex';
import { getStub, setStubRoot, clearStubs } from './sobjectStub';
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
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                // Trigger on the characters that begin a new SOQL token position.
                triggerCharacters: ['.', ' ', ',', '(', '\n'],
                resolveProvider: false,
            },
            documentSymbolProvider: apexFeatures ? true : undefined,
            // Definition is always on: SObject/field click-through to schema stubs
            // needs no Apex gating; Apex-symbol resolution is gated in the handler.
            definitionProvider: true,
            signatureHelpProvider: apexFeatures ? { triggerCharacters: ['(', ','] } : undefined,
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

// Cached per document+sobject so a different sub-project (different org) doesn't
// reuse another project's describe. Host also caches by org with a TTL.
// Namespace-aware: in a namespaced project, `Widget__c` resolves to
// `ns__Widget__c` when the bare name isn't found.
const describeCache = new Map<string, HostDescribe | null>();
async function describe(docUri: string, sobject: string): Promise<HostDescribe | null> {
    const key = `${docUri}|${sobject}`;
    if (describeCache.has(key)) return describeCache.get(key) ?? null;
    let res = await fetchDescribe(docUri, sobject);
    if (!res) {
        const ns = await projectNamespace(docUri);
        if (ns && !hasNamespacePrefix(sobject, ns)) {
            res = await fetchDescribe(docUri, `${ns}__${sobject}`);
        }
    }
    describeCache.set(key, res);
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
    const target = (f.referenceTo && f.referenceTo[0]) || '';
    const item: CompletionItem = {
        label: f.relationshipName as string,
        kind: CompletionItemKind.Class,
        labelDetails: { detail: target ? ` → ${target}` : ' → (relationship)', description: owner },
        // Sort relationships just after their owning fields.
        sortText: '1_' + f.relationshipName,
    };
    return withSchemaDoc(item, [`\`${owner}.${f.relationshipName}\` → **${target || 'relationship'}**`]);
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

// Walk a parent-relationship path (e.g. ['Account','Owner']) from a base sobject
// to the final referenced sobject. Returns null if any hop can't be resolved.
async function resolveRelationshipTarget(docUri: string, base: string, segments: string[]): Promise<string | null> {
    let current = base;
    for (const seg of segments) {
        const d = await describe(docUri, current);
        if (!d) return null;
        const f = d.fields.find(
            (x) => x.relationshipName && x.relationshipName.toLowerCase() === seg.toLowerCase() && x.referenceTo && x.referenceTo.length,
        );
        if (!f || !f.referenceTo) return null;
        current = f.referenceTo[0];
    }
    return current;
}

// Expand one placeholder item into concrete, org-aware completion items.
// `relSegments` is the parent-relationship path typed before the cursor (e.g.
// `SELECT Account.Owner.|` → ['Account','Owner']), used to traverse for fields.
async function expand(item: CompletionItem, relSegments: string[], docUri: string): Promise<CompletionItem[]> {
    const label = item.label as string;
    const c = ctxOf(item);

    if (label === '__SOBJECTS_PLACEHOLDER') {
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
        const d = c?.sobjectName ? await describe(docUri, c.sobjectName) : null;
        if (!d) return [];
        return d.childRelationships.map((r) =>
            withSchemaDoc(
                {
                    label: r.name,
                    kind: CompletionItemKind.Reference,
                    labelDetails: { detail: ` → ${r.childSObject}`, description: c.sobjectName },
                    sortText: r.name,
                },
                [`\`${c.sobjectName}.${r.name}\` → **${r.childSObject}** (child relationship)`],
            ),
        );
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
    describeCache.clear();
    namespaceCache.clear();
    objectDescriptionCache.clear();
    apexSymbolCache.clear();
    clearStubs();
    // Re-publish Apex diagnostics for open documents after a push/pull/refresh.
    for (const doc of documents.all()) publishApexDiagnostics(doc);
});

connection.onNotification(NOTE_EPHEMERAL, (params: { uris?: string[] }) => {
    ephemeralDocs.clear();
    for (const u of params?.uris ?? []) ephemeralDocs.add(u);
});

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
            text = region.snippet;
            line = region.line;
            column = region.column;
        } else {
            if (!apexCompletion) return [];
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

    const out: CompletionItem[] = [];
    for (const item of raw) {
        if (isPlaceholder(item)) {
            out.push(...(await expand(item, relSegments, docUri)));
        } else {
            out.push(item);
        }
    }
    return sfxTag(applyNamespace(out, ns));
});

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

/**
 * Complete after `new ` in Apex. Prioritizes the type being assigned — e.g.
 * `acme__Widget__c po = new |` → `acme__Widget__c()` first —
 * then offers constructable SObjects. Returns [] when not in a `new` context.
 */
async function apexNewCompletion(doc: TextDocument, offset: number): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    if (!/(?:^|[\s({,=])new\s+[A-Za-z_0-9.<>]*$/.test(lineUpToCursor)) return [];

    // Expected type from the assignment LHS (declared inline, or via the index).
    let expected: string | undefined;
    const declared = /([A-Za-z_][\w.]*(?:<[^>]*>)?)\s+[A-Za-z_]\w*\s*=\s*new\s+[\w.<>]*$/.exec(lineUpToCursor);
    if (declared) {
        expected = declared[1];
    } else {
        const reassign = /([A-Za-z_]\w*)\s*=\s*new\s+[\w.<>]*$/.exec(lineUpToCursor);
        if (reassign) expected = getApexParse(doc).index.varTypes.get(reassign[1]);
    }

    const items: CompletionItem[] = [];
    if (expected) items.push(newTypeItem(expected, '0'));

    // Constructable SObjects (deprioritized below the expected type).
    const expectedBase = expected ? baseTypeName(expected) : '';
    for (const name of await objectList(doc.uri)) {
        if (name === expectedBase) continue;
        items.push(newTypeItem(name, objectSortTier(name) === '0' ? '1' : '2'));
    }
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

    const { index } = getApexParse(doc);

    // Resolve the receiver to a type name. Fall back to a text scan when the parse
    // index doesn't have it (common while mid-typing the member access).
    let typeName: string | undefined;
    if (receiver === 'this') {
        typeName = enclosingClass(index, pos.line, pos.character);
    } else if (index.varTypes.has(receiver)) {
        typeName = index.varTypes.get(receiver);
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
        const d = await describe(doc.uri, base);
        if (d) items = d.fields.map((f) => fieldItem(base, f));
    }

    const filtered = partial ? items.filter((i) => String(i.label).toLowerCase().startsWith(partial)) : items;
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

    return sfxTag(items);
}

// ─── Apex outline + syntax diagnostics (gated) ──────────────────────────────────

function isApex(uri: string): boolean {
    return /\.(cls|trigger)$/i.test(uri) || /\.apex$/i.test(uri);
}

// Diagnostics are intentionally NOT recomputed on every edit (to avoid per-keystroke
// parsing). We publish them when a document opens and refresh them on push/pull/org
// change (via NOTE_REFRESH). Completion/hover/definition still parse on demand
// (version-cached) only when actually invoked.
function publishApexDiagnostics(doc: TextDocument): void {
    if (!apexFeatures || doc.languageId === 'soql' || !isApex(doc.uri)) return;
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: getApexParse(doc).diagnostics });
}

documents.onDidOpen((e) => publishApexDiagnostics(e.document));
documents.onDidClose((e) => {
    apexSymbolCache.delete(e.document.uri);
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
            if (r) return codeHover(`${base}.${r.relationshipName} → ${r.referenceTo?.[0] ?? '?'}`);
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
    if (r) return codeHover(`${target}.${r.relationshipName} → ${r.referenceTo?.[0] ?? '?'}`);
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

documents.listen(connection);
connection.listen();
