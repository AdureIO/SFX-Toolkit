/**
 * Background schema prefetch: when a document opens or changes (debounced), warm the
 * describe cache for the objects its SOQL references — FROM objects first, then the
 * likely next hops (child-subquery objects, dotted-path targets, Owner/CreatedBy/
 * LastModifiedBy → User), so the first completion in a query is served from cache.
 *
 * Low priority by construction: debounced per document, at most MAX_CONCURRENT jobs at
 * a time, no soft deadline (only the host's hard one), never on the request path.
 * Uses `sfx/describeMany` (one round-trip) with fallback to single describes.
 */
import type { Connection } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { findRelationship } from './schema';
import { soqlQueriesIn, queryRefs } from './soql';
import { isApex } from './textUtil';

const DEBOUNCE_MS = 600;
const MAX_CONCURRENT = 3;
/** Second-hop targets prefetched per document. */
const MAX_HOP_TARGETS = 8;
/** Documents larger than this are not scanned. */
const MAX_SCAN_CHARS = 2_000_000;
const AUDIT_RELS = ['owner', 'createdby', 'lastmodifiedby'];

export function register(_connection: Connection, ctx: ServerContext): void {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending: string[] = [];
    const pendingSet = new Set<string>();
    let running = 0;
    let released = false;

    const isTarget = (doc: TextDocument): boolean =>
        doc.languageId === 'soql' || /\.soql$/i.test(doc.uri) || isApex(doc.uri) || doc.languageId === 'apex' || doc.languageId === 'apex-anon';

    const runJob = async (uri: string): Promise<void> => {
        const doc = ctx.documents.get(uri);
        if (!doc || !isTarget(doc)) return;
        const text = doc.getText();
        if (text.length > MAX_SCAN_CHARS || !/select/i.test(text)) return;
        const isSoql = doc.languageId === 'soql' || /\.soql$/i.test(uri);
        const queries = soqlQueriesIn(text, isSoql);
        if (!queries.length) return;
        const objects = new Set<string>();
        const children: { parent: string; rel: string }[] = [];
        const paths: { base: string; rel: string }[] = [];
        for (const q of queries) {
            const r = queryRefs(q);
            r.objects.forEach((o) => objects.add(o));
            children.push(...r.children);
            paths.push(...r.paths);
        }
        if (!objects.size) return;
        await ctx.schema.prefetch(uri, [...objects]);
        if (released) return;

        // Second hop, from what is now cached (no extra round-trips to find targets).
        const hop = new Set<string>();
        const add = (n: string | undefined) => {
            if (n && hop.size < MAX_HOP_TARGETS && !objects.has(n)) hop.add(n);
        };
        for (const c of children) {
            const d = ctx.schema.peekDescribe(uri, c.parent);
            add(d?.childRelationships.find((r) => r.name.toLowerCase() === c.rel.toLowerCase())?.childSObject);
        }
        for (const p of paths) {
            const d = ctx.schema.peekDescribe(uri, p.base);
            const f = d ? findRelationship(d, p.rel) : undefined;
            for (const t of f?.referenceTo ?? []) add(t);
        }
        for (const o of objects) {
            const d = ctx.schema.peekDescribe(uri, o);
            if (!d) continue;
            for (const rel of AUDIT_RELS) {
                const f = findRelationship(d, rel);
                if (f?.referenceTo?.includes('User')) add('User');
            }
        }
        if (hop.size) await ctx.schema.prefetch(uri, [...hop]);
    };

    const drain = (): void => {
        while (!released && running < MAX_CONCURRENT && pending.length) {
            const uri = pending.shift()!;
            pendingSet.delete(uri);
            running++;
            runJob(uri)
                .catch(() => undefined)
                .finally(() => {
                    running--;
                    drain();
                });
        }
    };

    const schedule = (doc: TextDocument): void => {
        if (released || !isTarget(doc)) return;
        const uri = doc.uri;
        const prev = timers.get(uri);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
            timers.delete(uri);
            if (!pendingSet.has(uri)) {
                pendingSet.add(uri);
                pending.push(uri);
            }
            drain();
        }, DEBOUNCE_MS);
        (t as { unref?: () => void }).unref?.();
        timers.set(uri, t);
    };

    ctx.documents.onDidOpen((e) => schedule(e.document));
    ctx.documents.onDidChangeContent((e) => schedule(e.document));
    ctx.documents.onDidClose((e) => {
        const t = timers.get(e.document.uri);
        if (t) clearTimeout(t);
        timers.delete(e.document.uri);
    });
    // After a refresh, re-warm the open documents (debounced like an edit).
    ctx.onSchemaRefresh(() => {
        for (const doc of ctx.documents.all()) schedule(doc);
    });
    ctx.onRelease(() => {
        released = true;
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
        pending.length = 0;
        pendingSet.clear();
    });
}
