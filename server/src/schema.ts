/**
 * Org schema access for the language server. The schema itself lives in the
 * extension host (which owns auth + the metadata caches); the server asks for it
 * lazily via custom requests (see src/languageClient.ts) so it stays credential-free.
 *
 * Describes are cached server-side (per org context + object, LRU-capped, in-flight
 * requests deduped) so completion/hover/validation don't pay a host round-trip per
 * keystroke. The cache is invalidated by the host's NOTE_REFRESH notification
 * (targeted `{ objects }` or everything) and cleared on shutdown.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { CancellationToken, Connection } from 'vscode-languageserver/node';
import { lruGet, lruSet } from './caches';
import { raceCancel, throwIfCancelled, isCancelled } from './cancel';
import { REQ_OBJECT_LIST, REQ_DESCRIBE, REQ_PROJECT_INFO, REQ_OBJECT_INFO } from './protocol';
import { hasNamespacePrefix, nameMatchesNsOptional } from './textUtil';

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


const MAX_NAMESPACE_CACHE = 500;
const MAX_OBJECT_DESCRIPTION_CACHE = 1000;
/** Describes kept server-side (each can be large — hundreds of fields). */
const MAX_DESCRIBE_CACHE = 150;
/** "No such object" answers are re-checked after this long (the host may simply not have been ready). */
const NEGATIVE_DESCRIBE_TTL_MS = 60_000;
const MAX_ORG_CONTEXT_CACHE = 500;

interface DescribeEntry {
    value: HostDescribe | null;
    at: number;
}

export class SchemaService {
    // Project namespace (from sfdx-project.json) per document, cached. Empty/absent → null.
    // Dropped per document on close; capped as a backstop.
    private namespaceCache = new Map<string, string | null>();
    // Object admin Description (Tooling API, fetched lazily on hover), cached per doc+object.
    // Keys are `${docUri}|${sobject}`; a closed document's entries are dropped, and the
    // whole map is LRU-capped.
    private objectDescriptionCache = new Map<string, string | null>();
    // Describe cache. Key: `${orgContext}|${sobject lower-case}` for found objects; a
    // "not found" answer is cached under the exact-cased name (`${orgContext}|!${sobject}`)
    // with a TTL, since the host may resolve names case-sensitively.
    private describeCache = new Map<string, DescribeEntry>();
    private describeInflight = new Map<string, Promise<HostDescribe | null>>();
    // Bumped on every invalidation; an in-flight describe that started before an
    // invalidation must not write its (possibly stale) answer into the cache.
    private generation = 0;
    // Directory → org-context key (nearest sfdx-project.json dir), memoized.
    private orgContextByDir = new Map<string, string>();

    constructor(
        private readonly connection: Connection,
        /** Documents that may target a non-default org (workbench buffers) — each is its own context. */
        private readonly isEphemeral: (uri: string) => boolean = () => false,
    ) {}

    /**
     * The org context a document's schema requests resolve against, mirroring the
     * host's `orgForUri` (src/languageClient.ts): the nearest sfdx-project.json dir (its
     * default org). Buffers that can pin their own org (workbench buffers under
     * `.sfdx/`, ephemeral docs) and non-file URIs are each their own context; org
     * switches / override changes arrive as a full NOTE_REFRESH.
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

    // `docUri` lets the host resolve the right org per document (nested sub-projects
    // each use their own default org).
    async objectList(docUri: string, token?: CancellationToken): Promise<string[]> {
        throwIfCancelled(token);
        try {
            return (await raceCancel(this.connection.sendRequest<string[]>(REQ_OBJECT_LIST, { uri: docUri }), token)) || [];
        } catch (e) {
            if (isCancelled(e)) throw e;
            return [];
        }
    }

    async projectNamespace(docUri: string, token?: CancellationToken): Promise<string | null> {
        if (this.namespaceCache.has(docUri)) return this.namespaceCache.get(docUri) ?? null;
        throwIfCancelled(token);
        let ns: string | null = null;
        try {
            const info = await raceCancel(
                this.connection.sendRequest<{ namespace: string | null }>(REQ_PROJECT_INFO, { uri: docUri }),
                token,
            );
            ns = info && info.namespace ? info.namespace : null;
        } catch (e) {
            if (isCancelled(e)) throw e; // never cache an answer we didn't get
            ns = null;
        }
        lruSet(this.namespaceCache, docUri, ns, MAX_NAMESPACE_CACHE);
        return ns;
    }

    async objectDescription(docUri: string, sobject: string, token?: CancellationToken): Promise<string | null> {
        const key = `${docUri}|${sobject}`;
        if (this.objectDescriptionCache.has(key)) return this.objectDescriptionCache.get(key) ?? null;
        throwIfCancelled(token);
        let desc: string | null = null;
        try {
            const res = await raceCancel(
                this.connection.sendRequest<{ description: string | null }>(REQ_OBJECT_INFO, { uri: docUri, sobject }),
                token,
            );
            desc = res ? res.description : null;
        } catch (e) {
            if (isCancelled(e)) throw e;
            desc = null;
        }
        lruSet(this.objectDescriptionCache, key, desc, MAX_OBJECT_DESCRIPTION_CACHE);
        return desc;
    }

    /** One host describe for an exact object name, through the cache + in-flight dedupe. */
    private async fetchDescribe(docUri: string, sobject: string, token?: CancellationToken): Promise<HostDescribe | null> {
        const ctxKey = this.orgContext(docUri);
        const posKey = `${ctxKey}|${sobject.toLowerCase()}`;
        const negKey = `${ctxKey}|!${sobject}`;
        const pos = lruGet(this.describeCache, posKey);
        if (pos) return pos.value;
        const neg = this.describeCache.get(negKey);
        if (neg) {
            if (Date.now() - neg.at < NEGATIVE_DESCRIBE_TTL_MS) return null;
            this.describeCache.delete(negKey);
        }
        let inflight = this.describeInflight.get(negKey);
        if (!inflight) {
            // Don't start a host round-trip for a request that is already cancelled.
            throwIfCancelled(token);
            const gen = this.generation;
            inflight = this.connection
                .sendRequest<HostDescribe | null>(REQ_DESCRIBE, { uri: docUri, sobject })
                .then(
                    (v) => v ?? null,
                    () => null,
                )
                .then((value) => {
                    if (this.describeInflight.get(negKey) === inflight) this.describeInflight.delete(negKey);
                    if (gen === this.generation) {
                        lruSet(this.describeCache, value ? posKey : negKey, { value, at: Date.now() }, MAX_DESCRIBE_CACHE);
                    }
                    return value;
                });
            this.describeInflight.set(negKey, inflight);
        }
        return raceCancel(inflight, token);
    }

    // Namespace-aware: `Widget__c` falls back to `ns__Widget__c`. Cached per org
    // context (see orgContext) so a buffer that switches orgs is invalidated by the
    // host's refresh notification rather than served a previous org's fields.
    async describe(docUri: string, sobject: string, token?: CancellationToken): Promise<HostDescribe | null> {
        let res = await this.fetchDescribe(docUri, sobject, token);
        if (!res) {
            const ns = await this.projectNamespace(docUri, token);
            if (ns && !hasNamespacePrefix(sobject, ns)) {
                res = await this.fetchDescribe(docUri, `${ns}__${sobject}`, token);
            }
        }
        return res;
    }

    // Walk a parent-relationship path (e.g. ['Account','Owner']) from a base sobject
    // to the final referenced sobject. Returns null if any hop can't be resolved.
    // Relationship names match namespace-optionally so `X__r` resolves `ns__X__r`.
    async resolveRelationshipTarget(
        docUri: string,
        base: string,
        segments: string[],
        token?: CancellationToken,
    ): Promise<string | null> {
        let current = base;
        for (const seg of segments) {
            const d = await this.describe(docUri, current, token);
            if (!d) return null;
            const f = d.fields.find(
                (x) => x.relationshipName && nameMatchesNsOptional(x.relationshipName, seg) && x.referenceTo && x.referenceTo.length,
            );
            if (!f || !f.referenceTo) return null;
            current = f.referenceTo[0];
        }
        return current;
    }

    /** Schema changed on the host: targeted (`objects`) or everything. */
    invalidate(objects?: string[]): void {
        this.generation++;
        if (objects) {
            // Targeted (push/pull changed only these objects): drop just their cached schema,
            // with or without a namespace prefix (`Widget__c` ≈ `ns__Widget__c`).
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
            // A created/deleted object may turn a cached "not found" into a hit (or back):
            // drop every negative entry so the next lookup asks the host again.
            for (const [k, v] of [...this.describeCache.entries()]) if (!v.value) this.describeCache.delete(k);
        } else {
            this.namespaceCache.clear();
            this.objectDescriptionCache.clear();
            this.describeCache.clear();
            this.describeInflight.clear();
            this.orgContextByDir.clear();
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
    }

    clear(): void {
        this.generation++;
        this.namespaceCache.clear();
        this.objectDescriptionCache.clear();
        this.describeCache.clear();
        this.describeInflight.clear();
        this.orgContextByDir.clear();
    }
}
