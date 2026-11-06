/**
 * Shared server context: the LSP connection, the open-document store, the settings
 * negotiated in `initialize`, and the shared services (org schema access, Apex parse
 * cache). Every feature module receives it in `register(connection, ctx)`.
 *
 * This module must not import any feature module (keeps the import graph acyclic:
 * server.ts → feature modules → context/services/helpers).
 */
import type { Connection, TextDocuments } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { SchemaService, SchemaInvalidation } from './schema';
import { ParseCache } from './parseCache';

export interface ServerSettings {
    // Apex *semantic* features (outline, syntax diagnostics, go-to-def for user code,
    // signature help) — gated so we don't duplicate the official Salesforce Apex
    // extension (auto-off when it's installed).
    apexFeatures: boolean;
    // Apex *completion* (org-aware member fields, `new` constructors, type names) —
    // additive and on by default; users can turn it off to avoid duplicate items.
    apexCompletion: boolean;
    // Offline schema validation (Tier 1): flag `receiver.member` accesses whose member
    // isn't a field/relationship of the resolved SObject. Gated with apexFeatures.
    apexValidateSchema: boolean;
    // Semantic highlighting (semanticTokens/full, /delta, /range) for Apex + SOQL.
    // From initializationOptions.apexSemanticHighlighting (default on).
    apexSemanticHighlighting: boolean;
    // Client capability: workspace/semanticTokens/refresh is supported.
    semanticTokensRefreshSupport: boolean;
}

export interface ServerContext {
    readonly connection: Connection;
    readonly documents: TextDocuments<TextDocument>;
    /** Mutated once in onInitialize; read by handlers at request time. */
    readonly settings: ServerSettings;
    // Buffer documents (e.g. the ASFX Workbench's hidden editors) whose IntelliSense
    // may target a non-default org — we must NOT write SObject stub files for them,
    // or a non-default org's schema would leak into the shared .sfdx stub folder.
    readonly ephemeralDocs: Set<string>;
    readonly schema: SchemaService;
    readonly parses: ParseCache;
    /**
     * Register a callback run after the host signals a schema change: targeted `objects`
     * or all (`objects` undefined). `info` carries the full NOTE_REFRESH params — a
     * callback that ignores it treats a `uris`/`structural`-only refresh as a full one
     * (safe, just broader).
     */
    onSchemaRefresh(fn: (objects?: string[], info?: SchemaInvalidation) => void): void;
    /** Fire the schema-refresh callbacks (called by the NOTE_REFRESH handler). */
    fireSchemaRefresh(objects?: string[], info?: SchemaInvalidation): void;
    /** Register a callback that releases module state (timers, caches) on shutdown. */
    onRelease(fn: () => void): void;
    /** Run every release callback. */
    releaseAll(): void;
}

export function createServerContext(connection: Connection, documents: TextDocuments<TextDocument>): ServerContext {
    const refreshFns: ((objects?: string[], info?: SchemaInvalidation) => void)[] = [];
    const releaseFns: (() => void)[] = [];
    const ephemeralDocs = new Set<string>();
    return {
        connection,
        documents,
        settings: {
            apexFeatures: false,
            apexCompletion: true,
            apexValidateSchema: true,
            apexSemanticHighlighting: true,
            semanticTokensRefreshSupport: false,
        },
        ephemeralDocs,
        schema: new SchemaService(connection, (uri) => ephemeralDocs.has(uri)),
        parses: new ParseCache((uri) => documents.get(uri)),
        onSchemaRefresh: (fn) => void refreshFns.push(fn),
        fireSchemaRefresh: (objects, info) => {
            for (const fn of refreshFns) {
                try {
                    fn(objects, info);
                } catch {
                    /* one module's failure must not block the others */
                }
            }
        },
        onRelease: (fn) => void releaseFns.push(fn),
        releaseAll: () => {
            for (const fn of releaseFns) {
                try {
                    fn();
                } catch {
                    /* ignore */
                }
            }
        },
    };
}
