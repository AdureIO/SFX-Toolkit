/**
 * Single source of truth for SObject describe REST calls.
 *
 * Historically OrgMetadataCache, SoqlSchemaProvider and SchemaCache each fetched
 * `/sobjects/{name}/describe` independently, so describing one object could hit
 * the org up to three times (once per cache) — and concurrent callers double-
 * fetched because two of those caches had no in-flight dedup.
 *
 * This store owns the network call and the raw-JSON cache: one fetch per
 * org+sobject, shared across every consumer, with TTL and in-flight dedup. The
 * higher-level caches keep their own *parsed* shapes but source the raw payload
 * here, so the SOQL editor, data tools, language server and stub sync never
 * re-describe the same object.
 */
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";

const CACHE_KEY_DEFAULT = "__default__";
/** Freshness window for a successful describe. One full describe per object serves all
 *  fields + relationships from cache for this long; after it elapses the next use
 *  refetches once. Short-lived so schema edits surface without a manual refresh. */
export const DESCRIBE_TTL_MS = 10 * 60 * 1000;
/** Short window to cache a miss (object not found / fetch failed) so completion
 *  and validation don't re-hit the org on every keystroke while typing a partial
 *  or misspelled name — yet a genuinely new object appears after it expires. */
const NEGATIVE_TTL_MS = 60 * 1000;

/**
 * Memory bounds. A raw describe of a wide object can be several hundred KB of parsed
 * JSON, so the store is an LRU per org and keeps only a handful of orgs. Pruning is
 * lazy (on access) — no background timers.
 */
/** Max raw describes kept per org (least-recently-used evicted first). */
export const MAX_DESCRIBES_PER_ORG = 300;
/** Max orgs with cached describes (least-recently-used org evicted first). */
export const MAX_ORGS = 5;
/** Non-default orgs untouched for this long are dropped on the next access. */
export const ORG_IDLE_MS = 30 * 60 * 1000;

function orgKey(org: string | null): string {
	return org === null || org === "" ? CACHE_KEY_DEFAULT : org;
}

interface RawEntry {
	raw: any;
	fetchedAt: number;
}

class DescribeStoreImpl {
	private cache = new Map<string, Map<string, RawEntry>>();
	private locks = new Map<string, Promise<any | null>>();
	/** orgKey → last access (ms), for lazy idle-org pruning. */
	private orgLastUsed = new Map<string, number>();

	private orgMap(org: string | null): Map<string, RawEntry> {
		const key = orgKey(org);
		const now = Date.now();
		this.pruneOrgs(now, key);
		let m = this.cache.get(key);
		if (!m) {
			m = new Map();
		} else {
			// Re-insert to mark this org most-recently-used.
			this.cache.delete(key);
		}
		this.cache.set(key, m);
		this.orgLastUsed.set(key, now);
		return m;
	}

	/** Lazily drop idle non-default orgs and enforce the org cap (excluding `current`). */
	private pruneOrgs(now: number, current: string): void {
		for (const [k, last] of this.orgLastUsed) {
			if (k !== current && k !== CACHE_KEY_DEFAULT && now - last > ORG_IDLE_MS) this.dropOrg(k);
		}
		while (this.cache.size >= MAX_ORGS && !this.cache.has(current)) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.dropOrg(oldest);
		}
	}

	private dropOrg(key: string): void {
		this.cache.delete(key);
		this.orgLastUsed.delete(key);
		for (const lk of [...this.locks.keys()]) {
			if (lk.startsWith(`${key}|`)) this.locks.delete(lk);
		}
	}

	private store(map: Map<string, RawEntry>, sobject: string, entry: RawEntry): void {
		map.delete(sobject);
		map.set(sobject, entry);
		while (map.size > MAX_DESCRIBES_PER_ORG) {
			const oldest = map.keys().next().value;
			if (oldest === undefined) break;
			map.delete(oldest);
		}
	}

	/**
	 * Raw describe JSON for org+sobject. Returns the cached payload when fresh,
	 * joins an in-flight request when one is pending, otherwise fetches once.
	 * Returns null on failure (logged). Never throws.
	 */
	async getRaw(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): Promise<any | null> {
		if (!sobject) return null;
		const map = this.orgMap(org);
		const hit = map.get(sobject);
		if (hit) {
			// Hits live for ttlMs (~10 min); misses for a shorter window so a genuinely
			// new / correctly-typed name resolves soon after a typo.
			const effectiveTtl = hit.raw === null ? NEGATIVE_TTL_MS : ttlMs;
			if (Date.now() - hit.fetchedAt < effectiveTtl) {
				// LRU touch.
				map.delete(sobject);
				map.set(sobject, hit);
				return hit.raw;
			}
			map.delete(sobject); // expired — release it now rather than at eviction
		}

		const lockKey = `${orgKey(org)}|${sobject}`;
		const inflight = this.locks.get(lockKey);
		if (inflight) return inflight;

		// Only the current lock owner may write: if the org/sobject was invalidated while
		// this request was in flight its lock is gone, and a stale payload must not be cached.
		const owns = () => this.locks.get(lockKey) === promise;
		const promise: Promise<any | null> = this.fetch(org, sobject)
			.then((raw) => {
				if (owns()) {
					// Cache the result either way (null = negative cache) to avoid re-fetching.
					this.store(map, sobject, { raw: raw ?? null, fetchedAt: Date.now() });
					this.locks.delete(lockKey);
				}
				return raw;
			})
			.catch((e: any) => {
				if (owns()) {
					this.store(map, sobject, { raw: null, fetchedAt: Date.now() });
					this.locks.delete(lockKey);
				}
				// A 404 just means "that name isn't an SObject" — an expected negative result
				// (Apex class, generic, system type). Negative-cached; not worth logging. Only
				// surface genuine failures (network / auth / 5xx).
				const msg = String(e?.message ?? e);
				if (!/HTTP 404\b/.test(msg)) {
					outputChannel.appendLine(`DescribeStore: describe ${sobject} failed: ${msg}`);
				}
				return null;
			});
		this.locks.set(lockKey, promise);
		return promise;
	}

	/** Whether a fresh, successful raw describe is already cached (no network). */
	hasFresh(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): boolean {
		const hit = this.cache.get(orgKey(org))?.get(sobject);
		return !!hit && hit.raw !== null && Date.now() - hit.fetchedAt < ttlMs;
	}

	private async fetch(org: string | null, sobject: string): Promise<any | null> {
		const version = getToolingApiVersion();
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/${encodeURIComponent(sobject)}/describe`
		);
		return JSON.parse(body);
	}

	invalidate(org: string | null): void {
		this.dropOrg(orgKey(org));
	}

	invalidateSObject(org: string | null, sobject: string): void {
		this.cache.get(orgKey(org))?.delete(sobject);
		this.locks.delete(`${orgKey(org)}|${sobject}`);
	}

	invalidateAll(): void {
		this.cache.clear();
		this.locks.clear();
		this.orgLastUsed.clear();
	}

	/** Release everything (deactivate / workspace switch). Holds no timers. */
	disposeAll(): void {
		this.invalidateAll();
	}
}

export const DescribeStore = new DescribeStoreImpl();
