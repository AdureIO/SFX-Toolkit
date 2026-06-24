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
/** Default freshness window for a raw describe. */
export const DESCRIBE_TTL_MS = 15 * 60 * 1000;

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
		if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.raw;

		const lockKey = `${orgKey(org)}|${sobject}`;
		const inflight = this.locks.get(lockKey);
		if (inflight) return inflight;

		const promise = this.fetch(org, sobject)
			.then((raw) => {
				if (raw) map.set(sobject, { raw, fetchedAt: Date.now() });
				this.locks.delete(lockKey);
				return raw;
			})
			.catch((e: any) => {
				this.locks.delete(lockKey);
				outputChannel.appendLine(`DescribeStore: describe ${sobject} failed: ${e?.message ?? e}`);
				return null;
			});
		this.locks.set(lockKey, promise);
		return promise;
	}

	/** Whether a fresh raw describe is already cached (no network). */
	hasFresh(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): boolean {
		const hit = this.orgMap(org).get(sobject);
		return !!hit && Date.now() - hit.fetchedAt < ttlMs;
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
