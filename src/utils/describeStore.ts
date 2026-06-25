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
/** Retained for API compatibility; a successful describe is now cached indefinitely
 *  (until an explicit invalidate), so this TTL no longer expires positive entries. */
export const DESCRIBE_TTL_MS = 15 * 60 * 1000;
/** Short window to cache a miss (object not found / fetch failed) so completion
 *  and validation don't re-hit the org on every keystroke while typing a partial
 *  or misspelled name — yet a genuinely new object appears after it expires. */
const NEGATIVE_TTL_MS = 60 * 1000;

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

	private orgMap(org: string | null): Map<string, RawEntry> {
		const key = orgKey(org);
		let m = this.cache.get(key);
		if (!m) {
			m = new Map();
			this.cache.set(key, m);
		}
		return m;
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
			// A successful describe is kept indefinitely (until the user runs Refresh Metadata
			// or a push/pull invalidates it) — we never silently re-fetch the same org's schema.
			// Only misses expire, on a short TTL, so a genuinely new/correctly-typed name resolves.
			if (hit.raw !== null) return hit.raw;
			if (Date.now() - hit.fetchedAt < NEGATIVE_TTL_MS) return hit.raw;
		}
		void ttlMs;

		const lockKey = `${orgKey(org)}|${sobject}`;
		const inflight = this.locks.get(lockKey);
		if (inflight) return inflight;

		const promise = this.fetch(org, sobject)
			.then((raw) => {
				// Cache the result either way (null = negative cache) to avoid re-fetching.
				map.set(sobject, { raw: raw ?? null, fetchedAt: Date.now() });
				this.locks.delete(lockKey);
				return raw;
			})
			.catch((e: any) => {
				map.set(sobject, { raw: null, fetchedAt: Date.now() });
				this.locks.delete(lockKey);
				outputChannel.appendLine(`DescribeStore: describe ${sobject} failed: ${e?.message ?? e}`);
				return null;
			});
		this.locks.set(lockKey, promise);
		return promise;
	}

	/** Whether a successful raw describe is already cached (no network). */
	hasFresh(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): boolean {
		void ttlMs;
		const hit = this.orgMap(org).get(sobject);
		return !!hit && hit.raw !== null; // kept indefinitely until invalidate
	}

	private async fetch(org: string | null, sobject: string): Promise<any | null> {
		const version = getToolingApiVersion();
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/${encodeURIComponent(sobject)}/describe`
		);
		return JSON.parse(body);
	}

	invalidate(org: string | null): void {
		const key = orgKey(org);
		this.cache.delete(key);
		for (const lk of [...this.locks.keys()]) {
			if (lk.startsWith(`${key}|`)) this.locks.delete(lk);
		}
	}

	invalidateSObject(org: string | null, sobject: string): void {
		this.orgMap(org).delete(sobject);
		this.locks.delete(`${orgKey(org)}|${sobject}`);
	}

	invalidateAll(): void {
		this.cache.clear();
		this.locks.clear();
	}
}

export const DescribeStore = new DescribeStoreImpl();
