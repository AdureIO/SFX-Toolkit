/**
 * ASFX Toolkit language server (JVM-free) — entry point.
 *
 * This file only wires things together: it creates the connection + document store
 * + shared context, declares the server capabilities, registers each feature
 * module's handlers, and handles lifetime (host notifications, shutdown).
 * The features themselves live in their own modules:
 *
 *   context.ts          shared ServerContext (connection, documents, settings, services)
 *   protocol.ts         custom host request/notification names
 *   schema.ts           org schema access via the host (describe, object list, namespace)
 *   parseCache.ts       per-document Apex parse cache + debounced background parse
 *   cancel.ts           request-cancellation helpers (RequestCancelled, raceCancel, orCancelled)
 *   caches.ts           LRU helpers        textUtil.ts / items.ts   shared helpers
 *   soql.ts             SOQL region detection + org-aware SOQL completion
 *   completion.ts  hover.ts  definition.ts  references.ts  signatureHelp.ts
 *   documentSymbols.ts  workspaceSymbols.ts  diagnostics.ts  codeActions.ts
 *
 * ── Adding a feature ─────────────────────────────────────────────────────────────
 *   1. Create `server/src/<feature>.ts` exporting
 *        `export function register(connection: Connection, ctx: ServerContext): void`
 *      that installs its `connection.onXxx(...)` handler(s). Read settings from
 *      `ctx.settings` at request time; use `ctx.parses` / `ctx.schema` for shared
 *      state; register cleanup with `ctx.onRelease` and schema-change reactions with
 *      `ctx.onSchemaRefresh`. Import only context/services/helpers — never server.ts
 *      or another feature module (keeps the import graph acyclic).
 *   2. Add one capability line in `capabilitiesFor()` below (marked FEATURE CAPABILITIES).
 *   3. Add one `register(connection, ctx)` call in FEATURE REGISTRATION below.
 */
import {
    createConnection,
    ProposedFeatures,
    TextDocuments,
    TextDocumentSyncKind,
    InitializeResult,
    ServerCapabilities,
    CodeActionKind,
    FileChangeType,
} from 'vscode-languageserver/node';
import { fileURLToPath } from 'url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createServerContext, ServerSettings } from './context';
import { NOTE_REFRESH, NOTE_EPHEMERAL } from './protocol';
import { isApex } from './textUtil';
import { WorkspaceIndex } from './workspaceIndex';
import { setStubRoot, clearStubs, invalidateStubbedNames } from './sobjectStub';
import * as completion from './completion';
import * as hover from './hover';
import * as definition from './definition';
import * as references from './references';
import * as navigation from './navigation';
import * as signatureHelp from './signatureHelp';
import * as documentSymbols from './documentSymbols';
import * as workspaceSymbols from './workspaceSymbols';
import * as diagnostics from './diagnostics';
import * as codeActions from './codeActions';
import * as semanticTokens from './semanticTokens';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const ctx = createServerContext(connection, documents);

/** The server capabilities, given the settings negotiated in `initialize`. */
function capabilitiesFor(s: ServerSettings): ServerCapabilities {
    return {
        // Object form (not the number shorthand) so the client also sends
        // didSave — the schema/diagnostics pass refreshes on save.
        textDocumentSync: {
            openClose: true,
            change: TextDocumentSyncKind.Incremental,
            save: { includeText: false },
        },
        // ── FEATURE CAPABILITIES (one line per feature module; add new ones at the end) ──
        completionProvider: {
            // Trigger on the characters that begin a new SOQL token position, plus the quote
            // that opens a value literal (picklist values in `WHERE Field = '|'`) and the
            // at-sign that opens an annotation.
            triggerCharacters: ['.', ' ', ',', '(', '\n', "'", '@'],
            resolveProvider: false,
        },
        // Hover is always on: SOQL field/object info needs no Apex gating;
        // Apex hover content is gated inside the handler.
        hoverProvider: true,
        // Definition is always on: SObject/field click-through to schema stubs
        // needs no Apex gating; Apex-symbol resolution is gated in the handler.
        definitionProvider: true,
        // References for Apex symbols (scope-aware for locals/params).
        referencesProvider: s.apexFeatures ? true : undefined,
        signatureHelpProvider: s.apexFeatures ? { triggerCharacters: ['(', ','] } : undefined,
        documentSymbolProvider: s.apexFeatures ? true : undefined,
        // Names come from the filename index (no parsing per keystroke); the exact
        // declaration range is resolved lazily when a symbol is picked.
        workspaceSymbolProvider: s.apexFeatures ? { resolveProvider: true } : undefined,
        codeActionProvider: s.apexFeatures
            ? { codeActionKinds: [CodeActionKind.RefactorRewrite, CodeActionKind.QuickFix] }
            : undefined,
        // (diagnostics are pushed via publishDiagnostics — no capability needed)
        ...navigation.capabilities(s.apexFeatures), // rename (+prepare), implementation, type hierarchy
        semanticTokensProvider: s.apexSemanticHighlighting ? { legend: semanticTokens.LEGEND, full: { delta: true }, range: true } : undefined,
        // ── add new feature capabilities above this line ──
    };
}

connection.onInitialize((params): InitializeResult => {
    const opts = params.initializationOptions || {};
    codeActions.noteClientCapabilities(params.capabilities);
    ctx.settings.apexFeatures = !!opts.apexFeatures;
    ctx.settings.apexCompletion = opts.apexCompletion !== false;
    ctx.settings.apexValidateSchema = opts.apexValidateSchema !== false;
    ctx.settings.apexSemanticHighlighting = opts.apexSemanticHighlighting !== false;
    ctx.settings.semanticTokensRefreshSupport = !!params.capabilities.workspace?.semanticTokens?.refreshSupport;

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

    return { capabilities: capabilitiesFor(ctx.settings) };
});

// Build the cross-file type index in the background (async walk, never blocks requests).
connection.onInitialized(() => {
    void WorkspaceIndex.ready();
});

// Keep the type index current: the client forwards `**/*.{cls,trigger}` file events
// (see src/languageClient.ts `synchronize.fileEvents`). Generated dirs (.sfdx/.sf/
// node_modules) are filtered out again here in case the watcher can't exclude them.
connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
        const kind =
            change.type === FileChangeType.Deleted ? 'deleted' : change.type === FileChangeType.Created ? 'created' : 'changed';
        WorkspaceIndex.applyFileChange(change.uri, kind);
    }
});

// Document lifecycle shared by every feature (registered BEFORE the feature modules
// so the type index is updated before e.g. diagnostics run on open/save).
documents.onDidOpen((e) => WorkspaceIndex.updateFromDoc(e.document.uri));
documents.onDidSave((e) => WorkspaceIndex.updateFromDoc(e.document.uri));
// Background parse: every edit to an Apex document (re)schedules a debounced parse, so
// interactive requests find a fresh (or nearly fresh) parse instead of reparsing on the
// keystroke path. Pending parses are cancelled on close (ParseCache.drop).
documents.onDidChangeContent((e) => {
    const doc = e.document;
    if (doc.languageId === 'soql' || !isApex(doc.uri)) return;
    if (!ctx.settings.apexFeatures && !ctx.settings.apexCompletion) return;
    ctx.parses.noteChange(doc); // edit history → exact position mapping into a stale parse
    if (!ctx.parses.isCurrent(doc)) ctx.parses.scheduleBackground(doc);
});
documents.onDidClose((e) => {
    // Drop every per-document cache entry so closed buffers don't accumulate.
    ctx.parses.drop(e.document.uri);
    ctx.schema.dropDocument(e.document.uri);
});

// Host → server: org/schema changed (targeted `{ objects }` or everything).
connection.onNotification(NOTE_REFRESH, (params?: { objects?: string[] }) => {
    const objects = params?.objects?.length ? params.objects : undefined;
    ctx.schema.invalidate(objects);
    // The Apex parse cache is a pure text parse keyed by document version — schema-independent.
    clearStubs(objects);
    invalidateStubbedNames(); // stubs may have been (re)generated → rescan for validation
    ctx.fireSchemaRefresh(objects);
});

connection.onNotification(NOTE_EPHEMERAL, (params: { uris?: string[] }) => {
    ctx.ephemeralDocs.clear();
    for (const u of params?.uris ?? []) ctx.ephemeralDocs.add(u);
});

// ── FEATURE REGISTRATION (one call per feature module; add new ones at the end) ──
completion.register(connection, ctx);
hover.register(connection, ctx);
definition.register(connection, ctx);
references.register(connection, ctx);
signatureHelp.register(connection, ctx);
documentSymbols.register(connection, ctx);
workspaceSymbols.register(connection, ctx);
diagnostics.register(connection, ctx);
codeActions.register(connection, ctx);
navigation.register(connection, ctx);
semanticTokens.register(connection, ctx);
// ── add new feature registrations above this line ──

// ─── Lifetime ─────────────────────────────────────────────────────────────────
// The client stops us with shutdown → exit (the library then calls process.exit).
// Release timers and caches on shutdown so nothing keeps the loop alive meanwhile.
ctx.onRelease(() => {
    ctx.parses.clear();
    ctx.schema.clear();
    ctx.ephemeralDocs.clear();
    clearStubs();
    invalidateStubbedNames();
    WorkspaceIndex.clear();
});
connection.onShutdown(() => {
    ctx.releaseAll();
});

// Parent-death safety net. vscode-languageserver already exits when the IPC stream
// closes and polls the client's processId (from `initialize` / --clientProcessId)
// every 3s; `disconnect` fires as soon as the extension host's IPC channel goes away
// (crash, window close, project switch), so exit immediately instead of waiting.
process.on('disconnect', () => {
    ctx.releaseAll();
    process.exit(0);
});

documents.listen(connection);
connection.listen();
