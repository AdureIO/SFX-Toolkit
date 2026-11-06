/**
 * Org schema access for the language server. The schema itself lives in the
 * extension host (which owns auth + the metadata caches); the server asks for it
 * lazily via custom requests (see src/languageClient.ts) so it stays credential-free.
 *
 * Caching (all per org context — see orgContext):
 *   - describes: LRU-capped, in-flight requests deduped, stale-while-revalidate after
 *     DESCRIBE_TTL_MS (matches the host's DescribeStore TTL), a real "no such object"
 *     answer is negative-cached briefly; timeouts/errors are never cached.
 *   - the object list (describeGlobal names): cached, revalidated after the same TTL,
 *     dropped on a structural/full NOTE_REFRESH. It gates `describe`: a name that is
 *     not in the list never costs a host round-trip.
 *
 * Deadlines: every host request has a hard deadline (HOST_TIMEOUT_MS; the host is
 * sent a $/cancelRequest when it fires). Interactive callers can additionally pass a
 * `SchemaBudget` (see `completionBudget`) as their CancellationToken: once its soft
 * deadline passes, schema calls return what is ready (cached data, or null/[]) and mark
 * the budget `incomplete`, while the host request keeps running in the background so a
 * re-request is served from cache.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CancellationToken, CancellationTokenSource, Connection } from 'vscode-languageserver/node';
import { lruGet, lruSet } from './caches';
import { raceCancel, throwIfCancelled, isCancelled } from './cancel';
import { REQ_OBJECT_LIST, REQ_DESCRIBE, REQ_DESCRIBE_MANY, REQ_PROJECT_INFO, REQ_OBJECT_INFO } from './protocol';
import { hasNamespacePrefix, nameMatchesNsOptional } from './textUtil';
import { stdTypeName } from './apexStdlib';

export interface HostField {
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
export interface HostChildRelationship {
    name: string;
    childSObject: string;
}
export interface HostDescribe {
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

function envMs(name: string, dflt: number): number {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
}

/** Hard deadline for every server→host request. */
export const HOST_TIMEOUT_MS = envMs('SFX_LS_HOST_TIMEOUT_MS', 10_000);
/** Soft deadline for interactive (completion) schema waits. */
export const SOFT_DEADLINE_MS = envMs('SFX_LS_SOFT_DEADLINE_MS', 1_500);
/** Describe / object-list freshness (matches the host DescribeStore TTL); older entries are revalidated in the background. */
export const DESCRIBE_TTL_MS = envMs('SFX_LS_DESCRIBE_TTL_MS', 10 * 60_000);

const MAX_NAMESPACE_CACHE = 500;
const MAX_OBJECT_DESCRIPTION_CACHE = 1000;
/** Describes kept server-side (trimmed describes are ~80 KB at the very most). */
export const MAX_DESCRIBE_CACHE = 400;
/** "No such object" answers are re-checked after this long (the host may simply not have been ready). */
const NEGATIVE_DESCRIBE_TTL_MS = 60_000;
/** An empty object list (host not ready yet) is re-asked after this long. A failed fetch is never cached at all. */
const EMPTY_OBJECT_LIST_TTL_MS = 2_000;
/** A failed revalidation keeps the stale entry and retries after this long. */
const REVALIDATE_BACKOFF_MS = 60_000;
const MAX_ORG_CONTEXT_CACHE = 500;
const MAX_OBJECT_LISTS = 20;
/** JSON-RPC MethodNotFound. */
const METHOD_NOT_FOUND = -32601;
/** Host: the org can't answer right now (offline, session expired, timeout) — transient, never "not found". */
export const SCHEMA_UNAVAILABLE = -32803;
/** Background prefetch pauses this long for an org context after SCHEMA_UNAVAILABLE. */
const UNAVAILABLE_BACKOFF_MS = 5_000;
/** Host cap on names per sfx/describeMany. */
const MAX_DESCRIBE_MANY = 500;

/** Apex primitives / built-ins that are never SObjects. */
const NON_SOBJECT_TYPES = new Set([
    'string', 'integer', 'long', 'double', 'decimal', 'boolean', 'date', 'datetime', 'time', 'id', 'blob',
    'object', 'sobject', 'void', 'list', 'set', 'map', 'iterable', 'iterator', 'exception', 'type',
]);

interface DescribeEntry {
    value: HostDescribe | null;
    at: number;
}

interface ObjectListEntry {
    names: string[];
    /** lower-case name → exact API name */
    byLower: Map<string, string>;
    at: number;
}

/** Outcome of a host round-trip: `real` = the host actually answered (vs timeout/error). */
interface HostAnswer<T> {
    value: T;
    real: boolean;
}

export class HostTimeout extends Error {
    constructor(method: string) {
        super(`host request ${method} timed out`);
    }
}

/**
 * A CancellationToken carrying a soft deadline for one interactive request. Pass it
 * wherever the request's token goes; schema calls stop waiting when it expires and
 * set `incomplete` (→ `CompletionList.isIncomplete`). Cancellation is forwarded from
 * the wrapped token.
 */
export class SchemaBudget implements CancellationToken {
    readonly deadline: number;
    private _incomplete = false;
    constructor(private readonly inner: CancellationToken | undefined, ms: number = SOFT_DEADLINE_MS) {
        this.deadline = Date.now() + ms;
    }
    get isCancellationRequested(): boolean {
        return !!this.inner?.isCancellationRequested;
    }
    get onCancellationRequested(): CancellationToken['onCancellationRequested'] {
        return (this.inner ?? CancellationToken.None).onCancellationRequested;
    }
    /** True when some schema data was not ready in time (or a result list was capped). */
    get incomplete(): boolean {
        return this._incomplete;
    }
    markIncomplete(): void {
        this._incomplete = true;
    }
    remaining(): number {
        return this.deadline - Date.now();
    }
}

/** The SchemaBudget behind a token, if it is one. */
export function budgetOf(token?: CancellationToken): SchemaBudget | undefined {
    return token instanceof SchemaBudget ? token : undefined;
}

/** A syntactically plausible SObject API name (no dots, generics, spaces …). */
function plausibleObjectName(name: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !NON_SOBJECT_TYPES.has(name.toLowerCase());
}

export interface SchemaInvalidation {
    objects?: string[];
    uris?: string[];
    structural?: boolean;
}

export class SchemaService {
    // Project namespace (from sfdx-project.json) per document, cached. Empty/absent → null.
    // Dropped per document on close; capped as a backstop.
    private namespaceCache = new Map<string, string | null>();
    private namespaceInflight = new Map<string, Promise<HostAnswer<string | null>>>();
    // Object admin Description (Tooling API, fetched lazily on hover), cached per doc+object.
    private objectDescriptionCache = new Map<string, string | null>();
    // Describe cache. Key: `${orgContext}|${sobject lower-case}` for found objects; a
    // "not found" answer is cached under the exact-cased name (`${orgContext}|!${sobject}`)
    // with a TTL, since the host may resolve names case-sensitively.
    private describeCache = new Map<string, DescribeEntry>();
    private describeInflight = new Map<string, Promise<HostDescribe | null>>();
    // Object list per org context.
    private objectLists = new Map<string, ObjectListEntry>();
    private objectListInflight = new Map<string, Promise<ObjectListEntry | null>>();
    // Bumped on every invalidation; an in-flight answer that started before an
    // invalidation must not write its (possibly stale) result into the cache.
    private generation = 0;
    private ctxGeneration = new Map<string, number>();
    // Directory → org-context key (nearest sfdx-project.json dir), memoized.
    private orgContextByDir = new Map<string, string>();
    private describeManyUnsupported = false;
    /** Org context → time until which background prefetch skips the host (after SCHEMA_UNAVAILABLE). */
    private unavailableUntil = new Map<string, number>();
    /** Host request counters (debug/tests). */
    readonly stats = { describe: 0, describeMany: 0, objectList: 0, timeouts: 0 };

    constructor(
        private readonly connection: Connection,
        /** Documents that may target a non-default org (workbench buffers) — each is its own context. */
        private readonly isEphemeral: (uri: string) => boolean = () => false,
    ) {}

    /** A soft-deadline token for a completion request (see SchemaBudget). */
    completionBudget(token?: CancellationToken, ms: number = SOFT_DEADLINE_MS): SchemaBudget {
        return budgetOf(token) ?? new SchemaBudget(token, ms);
    }

    /**
     * The org context a document's schema requests resolve against, mirroring the
     * host's `orgForUri` (src/languageClient.ts): the nearest sfdx-project.json dir (its
     * default org). Buffers that can pin their own org (workbench buffers under
     * `.sfdx/`, ephemeral docs) and non-file URIs are each their own context.
     */
    orgContext(docUri: string): string {
        if (!docUri.startsWith('file:') || this.isEphemeral(docUri)) return docUri;
        let file: string;
        try {
            file = fileURLToPath(docUri);
        } catch {
            return docUri;
        }
        if (/[\\/]\.(?:sfdx|sf)[\\/]/.test(file)) return docUri;
        const dir = path.dirname(file);
        const hit = lruGet(this.orgContextByDir, dir);
        if (hit !== undefined) return hit;
        let key = dir; // no project found → per-directory (never shares across unrelated dirs)
        let d = dir;
        for (let i = 0; i < 100; i++) {
            try {
                if (fs.existsSync(path.join(d, 'sfdx-project.json'))) {
                    key = d;
                    break;
                }
            } catch {
                break;
            }
            const parent = path.dirname(d);
            if (parent === d) break;
            d = parent;
        }
        lruSet(this.orgContextByDir, dir, key, MAX_ORG_CONTEXT_CACHE);
        return key;
    }

    // ─── host plumbing ───────────────────────────────────────────────────────────

    /** One host request with the hard deadline; the host gets a $/cancelRequest on timeout. */
    private hostRequest<R>(method: string, params: unknown, timeoutMs: number = HOST_TIMEOUT_MS): Promise<R> {
        const cts = new CancellationTokenSource();
        return new Promise<R>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.stats.timeouts++;
                cts.cancel();
                cts.dispose();
                reject(new HostTimeout(method));
            }, timeoutMs);
            (timer as { unref?: () => void }).unref?.();
            let sent: Promise<R>;
            try {
                sent = this.connection.sendRequest<R>(method, params, cts.token);
            } catch (e) {
                clearTimeout(timer);
                cts.dispose();
                reject(e);
                return;
            }
            sent.then(
                (v) => {
                    clearTimeout(timer);
                    cts.dispose();
                    resolve(v);
                },
                (e) => {
                    clearTimeout(timer);
                    cts.dispose();
                    reject(e);
                },
            );
        });
    }

    /**
     * Wait for `p` honoring the caller's token: cancellation rejects with
     * RequestCancelled; an expired SchemaBudget resolves with `fallback` (and marks the
     * budget incomplete) while `p` keeps running in the background.
     */
    private wait<T>(p: Promise<T>, token: CancellationToken | undefined, fallback: T): Promise<T> {
        const b = budgetOf(token);
        if (!b) return raceCancel(p, token);
        return new Promise<T>((resolve, reject) => {
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                b.markIncomplete();
                resolve(fallback);
            }, Math.max(0, b.remaining()));
            raceCancel(p, token).then(
                (v) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(v);
                },
                (e) => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    reject(e);
                },
            );
        });
    }

    private genStamp(ctxKey: string): string {
        return `${this.generation}:${this.ctxGeneration.get(ctxKey) ?? 0}`;
    }

    // ─── object list ─────────────────────────────────────────────────────────────

    private loadObjectList(docUri: string, ctxKey: string): Promise<ObjectListEntry | null> {
        let p = this.objectListInflight.get(ctxKey);
        if (p) return p;
        const stamp = this.genStamp(ctxKey);
        this.stats.objectList++;
        p = this.hostRequest<string[]>(REQ_OBJECT_LIST, { uri: docUri })
            .then(
                (list) => {
                    const names = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
                    const byLower = new Map<string, string>();
                    for (const n of names) byLower.set(n.toLowerCase(), n);
                    const entry: ObjectListEntry = { names, byLower, at: Date.now() };
                    if (stamp === this.genStamp(ctxKey)) lruSet(this.objectLists, ctxKey, entry, MAX_OBJECT_LISTS);
                    return entry;
                },
                () => {
                    // Timeout/error: never cached. Keep a stale entry (if any) usable for a while.
                    const stale = this.objectLists.get(ctxKey);
                    if (stale) stale.at = Date.now() - DESCRIBE_TTL_MS + REVALIDATE_BACKOFF_MS;
                    return stale ?? null;
                },
            )
            .finally(() => {
                if (this.objectListInflight.get(ctxKey) === p) this.objectListInflight.delete(ctxKey);
            });
        this.objectListInflight.set(ctxKey, p);
        return p;
    }

    /** The cached object list for a document's org (null = unknown: not answered yet / failed). */
    private async objectListEntry(docUri: string, token?: CancellationToken): Promise<ObjectListEntry | null> {
        const ctxKey = this.orgContext(docUri);
        const hit = lruGet(this.objectLists, ctxKey);
        if (hit) {
            const age = Date.now() - hit.at;
            const ttl = hit.names.length ? DESCRIBE_TTL_MS : EMPTY_OBJECT_LIST_TTL_MS;
            if (age < ttl) return hit;
            if (hit.names.length) {
                void this.loadObjectList(docUri, ctxKey); // stale-while-revalidate
                return hit;
            }
        }
        throwIfCancelled(token);
        const entry = await this.wait(this.loadObjectList(docUri, ctxKey), token, hit ?? null);
        // Unknown list (fetch failed / not ready): tell an interactive caller to ask again.
        if (!entry || !entry.names.length) budgetOf(token)?.markIncomplete();
        return entry;
    }

    /** All SObject API names of the document's org (cached per org context). */
    async objectNames(docUri: string, token?: CancellationToken): Promise<string[]> {
        try {
            return (await this.objectListEntry(docUri, token))?.names ?? [];
        } catch (e) {
            if (isCancelled(e)) throw e;
            return [];
        }
    }

    /** Back-compat alias of objectNames. */
    objectList(docUri: string, token?: CancellationToken): Promise<string[]> {
        return this.objectNames(docUri, token);
    }

    /**
     * The exact API name of `name` in the document's org (namespace-aware: `Widget__c`
     * → `ns__Widget__c` when only that is listed). `null` = definitely not an object;
     * `undefined` = unknown (no object list available).
     */
    async resolveObjectName(docUri: string, name: string, token?: CancellationToken): Promise<string | null | undefined> {
        if (!name || !plausibleObjectName(name)) return null;
        const list = await this.objectListEntry(docUri, token);
        if (!list || !list.byLower.size) return undefined;
        const exact = list.byLower.get(name.toLowerCase());
        if (exact) return exact;
        const ns = await this.projectNamespace(docUri, token);
        if (ns && !hasNamespacePrefix(name, ns)) {
            const nsName = list.byLower.get(`${ns}__${name}`.toLowerCase());
            if (nsName) return nsName;
        }
        return null;
    }

    /**
     * True when `name` (namespace-optional) is an SObject of the document's org. When the
     * object list is unknown (host not ready / org unreachable) a plausible name is probed
     * with a describe instead of being declared "not an object": otherwise one failed
     * object-list fetch would switch every SObject completion off.
     */
    async isObjectName(name: string, docUri: string, token?: CancellationToken): Promise<boolean> {
        try {
            const resolved = await this.resolveObjectName(docUri, name, token);
            if (resolved !== undefined) return !!resolved;
            if (!plausibleObjectName(name) || stdTypeName(name)) return false;
            return !!(await this.describe(docUri, name, token));
        } catch (e) {
            if (isCancelled(e)) throw e;
            return false;
        }
    }

    /** Synchronous peek: the cached object-list answer for a name, without any host round-trip. */
    peekObjectName(docUri: string, name: string): string | null | undefined {
        const list = this.objectLists.get(this.orgContext(docUri));
        if (!list || !list.byLower.size) return undefined;
        return list.byLower.get(name.toLowerCase()) ?? null;
    }

    // ─── project namespace / object description ─────────────────────────────────

    async projectNamespace(docUri: string, token?: CancellationToken): Promise<string | null> {
        if (this.namespaceCache.has(docUri)) return this.namespaceCache.get(docUri) ?? null;
        throwIfCancelled(token);
        let p = this.namespaceInflight.get(docUri);
        if (!p) {
            p = this.hostRequest<{ namespace: string | null }>(REQ_PROJECT_INFO, { uri: docUri })
                .then(
                    (info) => ({ value: info && info.namespace ? info.namespace : null, real: true }),
                    () => ({ value: null, real: false }),
                )
                .then((a) => {
                    if (this.namespaceInflight.get(docUri) === p) this.namespaceInflight.delete(docUri);
                    // never cache an answer we didn't get
                    if (a.real) lruSet(this.namespaceCache, docUri, a.value, MAX_NAMESPACE_CACHE);
                    return a;
                });
            this.namespaceInflight.set(docUri, p);
        }
        return (await this.wait(p, token, { value: null, real: false })).value;
    }

    async objectDescription(docUri: string, sobject: string, token?: CancellationToken): Promise<string | null> {
        const key = `${docUri}|${sobject}`;
        if (this.objectDescriptionCache.has(key)) return this.objectDescriptionCache.get(key) ?? null;
        throwIfCancelled(token);
        const p = this.hostRequest<{ description: string | null }>(REQ_OBJECT_INFO, { uri: docUri, sobject }).then(
            (res) => {
                const desc = res ? res.description : null;
                lruSet(this.objectDescriptionCache, key, desc, MAX_OBJECT_DESCRIPTION_CACHE);
                return desc;
            },
            () => null, // timeout/error: not cached
        );
        return this.wait(p, token, null);
    }

    // ─── describes ───────────────────────────────────────────────────────────────

    /**
     * Track one describe answer: write it into the cache (unless invalidated meanwhile)
     * and keep the in-flight map in sync. Only a real host answer is cached.
     */
    private trackDescribe(ctxKey: string, sobject: string, source: Promise<HostAnswer<HostDescribe | null>>): Promise<HostDescribe | null> {
        const posKey = `${ctxKey}|${sobject.toLowerCase()}`;
        const negKey = `${ctxKey}|!${sobject}`;
        const stamp = this.genStamp(ctxKey);
        const p: Promise<HostDescribe | null> = source.then((a) => {
            if (this.describeInflight.get(negKey) === p) this.describeInflight.delete(negKey);
            const current = stamp === this.genStamp(ctxKey);
            if (a.real) {
                if (current) {
                    if (a.value) {
                        this.describeCache.delete(negKey);
                        lruSet(this.describeCache, posKey, { value: a.value, at: Date.now() }, MAX_DESCRIBE_CACHE);
                    } else {
                        this.describeCache.delete(posKey);
                        lruSet(this.describeCache, negKey, { value: null, at: Date.now() }, MAX_DESCRIBE_CACHE);
                    }
                }
                return a.value;
            }
            // Timeout/error: keep a stale positive entry (back off its revalidation).
            const stale = this.describeCache.get(posKey);
            if (stale?.value) {
                stale.at = Date.now() - DESCRIBE_TTL_MS + REVALIDATE_BACKOFF_MS;
                return stale.value;
            }
            return null;
        });
        this.describeInflight.set(negKey, p);
        return p;
    }

    private singleDescribe(docUri: string, sobject: string): Promise<HostAnswer<HostDescribe | null>> {
        this.stats.describe++;
        return this.hostRequest<HostDescribe | null>(REQ_DESCRIBE, { uri: docUri, sobject }).then(
            (v) => ({ value: v ?? null, real: true }),
            (err) => {
                // Timeout / SCHEMA_UNAVAILABLE / any error: transient, never negative-cached.
                if ((err as { code?: number } | null)?.code === SCHEMA_UNAVAILABLE) {
                    this.unavailableUntil.set(this.orgContext(docUri), Date.now() + UNAVAILABLE_BACKOFF_MS);
                }
                return { value: null, real: false };
            },
        );
    }

    /** One host describe for an exact object name, through the cache + in-flight dedupe. */
    private async fetchDescribe(docUri: string, sobject: string, token?: CancellationToken): Promise<HostDescribe | null> {
        const ctxKey = this.orgContext(docUri);
        const posKey = `${ctxKey}|${sobject.toLowerCase()}`;
        const negKey = `${ctxKey}|!${sobject}`;
        const pos = lruGet(this.describeCache, posKey);
        if (pos) {
            if (Date.now() - pos.at >= DESCRIBE_TTL_MS && !this.describeInflight.has(negKey)) {
                void this.trackDescribe(ctxKey, sobject, this.singleDescribe(docUri, sobject)); // revalidate
            }
            return pos.value;
        }
        const neg = this.describeCache.get(negKey);
        if (neg) {
            if (Date.now() - neg.at < NEGATIVE_DESCRIBE_TTL_MS) return null;
            this.describeCache.delete(negKey);
        }
        let inflight = this.describeInflight.get(negKey);
        if (!inflight) {
            // Don't start a host round-trip for a request that is already cancelled.
            throwIfCancelled(token);
            inflight = this.trackDescribe(ctxKey, sobject, this.singleDescribe(docUri, sobject));
        }
        return this.wait(inflight, token, null);
    }

    /**
     * Describe an SObject (namespace-optional: `Widget__c` falls back to `ns__Widget__c`
     * when only that is listed). Gated by the cached object list: a name that is not an
     * object of the org (or contains a '.', is an Apex primitive …) returns null without
     * a host round-trip. Cached per org context (see orgContext).
     */
    async describe(docUri: string, sobject: string, token?: CancellationToken): Promise<HostDescribe | null> {
        const name = (sobject || '').trim();
        if (!plausibleObjectName(name)) return null;
        const resolved = await this.resolveObjectName(docUri, name, token);
        if (resolved === null) return null;
        if (resolved) return this.fetchDescribe(docUri, resolved, token);
        // No object list (host not ready / failed): fall back to probing.
        if (stdTypeName(name)) return null;
        let res = await this.fetchDescribe(docUri, name, token);
        if (!res) {
            const ns = await this.projectNamespace(docUri, token);
            if (ns && !hasNamespacePrefix(name, ns)) res = await this.fetchDescribe(docUri, `${ns}__${name}`, token);
        }
        return res;
    }

    /** Cached describe only (no host round-trip, no revalidation); undefined when not cached. */
    peekDescribe(docUri: string, sobject: string): HostDescribe | null | undefined {
        const ctxKey = this.orgContext(docUri);
        const exact = this.peekObjectName(docUri, sobject) ?? sobject;
        const pos = this.describeCache.get(`${ctxKey}|${exact.toLowerCase()}`);
        if (pos) return pos.value;
        return undefined;
    }

    /**
     * Warm the cache for several objects at once (low priority, hard deadline only):
     * one `sfx/describeMany` round-trip for the names not cached/in flight, falling back
     * to single describes when the host doesn't support it (or the batch errors).
     */
    async prefetch(docUri: string, names: string[]): Promise<void> {
        const ctxKey = this.orgContext(docUri);
        const todo: string[] = [];
        const seen = new Set<string>();
        for (const n of names) {
            let exact: string | null | undefined;
            try {
                exact = await this.resolveObjectName(docUri, n);
            } catch {
                exact = undefined;
            }
            if (!exact) continue; // unknown list → don't probe in the background
            const lc = exact.toLowerCase();
            if (seen.has(lc)) continue;
            seen.add(lc);
            const pos = this.describeCache.get(`${ctxKey}|${lc}`);
            if (pos && Date.now() - pos.at < DESCRIBE_TTL_MS) continue;
            if (this.describeInflight.has(`${ctxKey}|!${exact}`)) continue;
            todo.push(exact);
        }
        if (!todo.length) return;
        // Org unreachable recently (host said "schema unavailable"): background work backs off.
        if (Date.now() < (this.unavailableUntil.get(ctxKey) ?? 0)) return;
        if (this.describeManyUnsupported || todo.length === 1) {
            await Promise.all(todo.map((n) => this.trackDescribe(ctxKey, n, this.singleDescribe(docUri, n))));
            return;
        }
        const chunks: string[][] = [];
        for (let i = 0; i < todo.length; i += MAX_DESCRIBE_MANY) chunks.push(todo.slice(i, i + MAX_DESCRIBE_MANY));
        await Promise.all(chunks.map((chunk) => this.describeManyChunk(docUri, ctxKey, chunk)));
    }

    private describeManyChunk(docUri: string, ctxKey: string, names: string[]): Promise<unknown> {
        this.stats.describeMany++;
        const batch = this.hostRequest<(HostDescribe | null)[]>(REQ_DESCRIBE_MANY, { names, uri: docUri }).then(
            (arr) => ({ arr: Array.isArray(arr) ? arr : null, err: null as unknown }),
            (err) => ({ arr: null, err }),
        );
        return Promise.all(
            names.map((n, i) =>
                this.trackDescribe(
                    ctxKey,
                    n,
                    batch.then(({ arr, err }): HostAnswer<HostDescribe | null> | Promise<HostAnswer<HostDescribe | null>> => {
                        if (arr) return { value: arr[i] ?? null, real: true };
                        if (err instanceof HostTimeout) return { value: null, real: false };
                        const code = (err as { code?: number } | null)?.code;
                        if (code === SCHEMA_UNAVAILABLE) {
                            // Transient (offline / session expired): not cached, no single-describe storm.
                            this.unavailableUntil.set(ctxKey, Date.now() + UNAVAILABLE_BACKOFF_MS);
                            return { value: null, real: false };
                        }
                        if (code === METHOD_NOT_FOUND) this.describeManyUnsupported = true;
                        return this.singleDescribe(docUri, n);
                    }),
                ),
            ),
        );
    }

    /**
     * Walk a parent-relationship path (e.g. ['Account','Owner']) from a base sobject to
     * the final referenced sobject. Returns null if any hop can't be resolved.
     * Relationship names match namespace-optionally so `X__r` resolves `ns__X__r`.
     * Polymorphic hops pick the target that has the next hop (User for a final Owner).
     */
    async resolveRelationshipTarget(
        docUri: string,
        base: string,
        segments: string[],
        token?: CancellationToken,
    ): Promise<string | null> {
        let current = base;
        for (let i = 0; i < segments.length; i++) {
            const d = await this.describe(docUri, current, token);
            if (!d) return null;
            const f = findRelationship(d, segments[i]);
            if (!f || !f.referenceTo) return null;
            const targets = f.referenceTo;
            if (targets.length === 1) {
                current = targets[0];
                continue;
            }
            if (i === segments.length - 1) {
                current = targets.find((t) => t === 'User') ?? targets[0];
                continue;
            }
            let pick = targets[0];
            for (const t of targets) {
                const td = await this.describe(docUri, t, token);
                if (td && findRelationship(td, segments[i + 1])) {
                    pick = t;
                    break;
                }
            }
            current = pick;
        }
        return current;
    }

    // ─── invalidation ────────────────────────────────────────────────────────────

    private dropContext(ctxKey: string): void {
        this.ctxGeneration.set(ctxKey, (this.ctxGeneration.get(ctxKey) ?? 0) + 1);
        this.unavailableUntil.delete(ctxKey);
        const prefix = ctxKey + '|';
        for (const k of [...this.describeCache.keys()]) if (k.startsWith(prefix)) this.describeCache.delete(k);
        for (const k of [...this.describeInflight.keys()]) if (k.startsWith(prefix)) this.describeInflight.delete(k);
        this.objectLists.delete(ctxKey);
        this.objectListInflight.delete(ctxKey);
    }

    /**
     * Schema changed on the host (NOTE_REFRESH):
     *   - `uris`: drop only those documents' org contexts (e.g. a workbench org override changed);
     *   - `objects`: drop just those objects' cached schema (push/pull of known objects);
     *   - `structural`: the object list changed (objects added/removed) → drop object lists;
     *   - nothing: drop everything.
     * Back-compat: an array argument is treated as `{ objects }`.
     */
    invalidate(arg?: string[] | SchemaInvalidation): void {
        const opts: SchemaInvalidation = Array.isArray(arg) ? { objects: arg } : arg ?? {};
        const objects = opts.objects?.length ? opts.objects : undefined;
        const uris = opts.uris?.length ? opts.uris : undefined;
        if (!objects && !uris && !opts.structural) {
            this.clear();
            return;
        }
        if (uris) {
            for (const uri of uris) {
                this.dropContext(this.orgContext(uri));
                this.namespaceCache.delete(uri);
                const prefix = uri + '|';
                for (const k of [...this.objectDescriptionCache.keys()]) if (k.startsWith(prefix)) this.objectDescriptionCache.delete(k);
            }
        }
        if (objects) {
            this.generation++;
            // Drop just their cached schema, with or without a namespace prefix (`Widget__c` ≈ `ns__Widget__c`).
            const lower = new Set(objects.map((o) => o.toLowerCase()));
            const hit = (name: string) => lower.has(name.toLowerCase()) || [...lower].some((o) => nameMatchesNsOptional(o, name));
            for (const k of [...this.objectDescriptionCache.keys()]) {
                if (lower.has(k.slice(k.lastIndexOf('|') + 1).toLowerCase())) this.objectDescriptionCache.delete(k);
            }
            for (const k of [...this.describeCache.keys()]) {
                const name = k.slice(k.lastIndexOf('|') + 1).replace(/^!/, '');
                if (hit(name)) this.describeCache.delete(k);
            }
            for (const k of [...this.describeInflight.keys()]) {
                if (hit(k.slice(k.lastIndexOf('|') + 2))) this.describeInflight.delete(k);
            }
        }
        if (opts.structural || objects) {
            // A created/deleted object may turn a cached "not found" into a hit (or back):
            // drop every negative entry so the next lookup asks the host again.
            for (const [k, v] of [...this.describeCache.entries()]) if (!v.value) this.describeCache.delete(k);
        }
        if (opts.structural) {
            if (uris) {
                for (const uri of uris) this.objectLists.delete(this.orgContext(uri));
            } else {
                this.generation++;
                this.objectLists.clear();
                this.objectListInflight.clear();
            }
        }
    }

    /** Drop every per-document entry for a closed document. */
    dropDocument(uri: string): void {
        this.namespaceCache.delete(uri);
        const prefix = uri + '|';
        for (const k of [...this.objectDescriptionCache.keys()]) if (k.startsWith(prefix)) this.objectDescriptionCache.delete(k);
        // Describes are shared per org context (project), so they outlive a single
        // document — except a per-buffer context, which dies with its buffer.
        for (const k of [...this.describeCache.keys()]) if (k.startsWith(prefix)) this.describeCache.delete(k);
        this.objectLists.delete(uri);
    }

    clear(): void {
        this.generation++;
        this.namespaceCache.clear();
        this.namespaceInflight.clear();
        this.objectDescriptionCache.clear();
        this.describeCache.clear();
        this.describeInflight.clear();
        this.objectLists.clear();
        this.objectListInflight.clear();
        this.orgContextByDir.clear();
        this.ctxGeneration.clear();
        this.unavailableUntil.clear();
    }
}

/** A parent relationship field of `d` named `rel` (namespace-optional). */
export function findRelationship(d: HostDescribe, rel: string): HostField | undefined {
    return d.fields.find(
        (x) => x.relationshipName && nameMatchesNsOptional(x.relationshipName, rel) && x.referenceTo && x.referenceTo.length,
    );
}
