import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { isSalesforceProject } from "./projectUtils";
import { DescribeStore } from "./describeStore";
import { canonicalOrgKey } from "./orgKey";
import { classifySchemaError, reportSchemaFailure, reportSchemaSuccess } from "./schemaHealth";

/** Max orgs whose object list is retained (LRU). Pruned lazily on access — no timers. */
const MAX_ORGS = 5;
/** Non-default orgs whose object list hasn't been used for this long are dropped on next access. */
const ORG_IDLE_MS = 30 * 60 * 1000;

export interface SObjectDescribe {
	fields: {
		name: string;
		type: string;
		relationshipName?: string;
		referenceTo?: string[];
		updateable?: boolean;
		calculated?: boolean;
	}[];
	childRelationships?: { relationshipName?: string; childSObject?: string }[];
}

interface OrgCache {
	sobjects: string[] | null;
	/** When sobject list was last fetched (for background refresh). */
	sobjectsFetchedAt: number;
	/** Last access (ms), for lazy idle pruning. */
	lastUsed: number;
}

/** Canonical key (username): alias, username and null-default share one entry. */
function cacheKey(org: string | null): string {
	return canonicalOrgKey(org);
}

/** True when two sorted name lists differ. */
function listsDiffer(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
	return false;
}

/**
 * Per-org cache for sobject list and describe metadata. Use for SOQL completion,
 * builder, and any feature that needs object/field lists. Refresh when user pulls
 * or runs "Refresh Metadata"; optionally warm in background when opening SOQL etc.
 */
/**
 * Detail attached to a change event. Absent ⇒ full invalidation (org switch /
 * manual refresh). Present ⇒ only these SObjects changed, so consumers can do a
 * targeted refresh (e.g. regenerate just those stubs) instead of everything.
 */
export interface SchemaChangeInfo {
	objects: string[];
	structural: boolean;
}

class OrgMetadataCacheImpl {
	private cache = new Map<string, OrgCache>();
	private fetchLocks = new Map<string, Promise<string[]>>();
	private changeListeners: ((org: string | null, change?: SchemaChangeInfo) => void)[] = [];

	/**
	 * Subscribe to cache invalidation/refresh events (org switch, pull, refresh
	 * metadata). Used by the SOQL language server to drop its describe cache.
	 * `change` is set for targeted (per-object) invalidations. Returns a disposer.
	 */
	onChange(listener: (org: string | null, change?: SchemaChangeInfo) => void): () => void {
		this.changeListeners.push(listener);
		return () => {
			const i = this.changeListeners.indexOf(listener);
			if (i >= 0) this.changeListeners.splice(i, 1);
		};
	}

	private emitChange(org: string | null, change?: SchemaChangeInfo): void {
		for (const l of this.changeListeners) {
			try {
				l(org, change);
			} catch {
				/* listener errors must not break cache ops */
			}
		}
	}

	/**
	 * Targeted invalidation after a push/pull that changed only specific SObjects.
	 * Drops just those describes (and, if `structural`, the object list so a new or
	 * removed object is picked up), then emits a change carrying the object names so
	 * consumers refresh only what's needed instead of everything.
	 */
	invalidateSObjects(org: string | null, objects: string[], structural = false): void {
		if (!objects.length && !structural) return;
		const key = cacheKey(org);
		for (const name of objects) DescribeStore.invalidateSObject(key, name);
		if (structural) {
			const entry = this.cache.get(key);
			if (entry) {
				entry.sobjects = null;
				entry.sobjectsFetchedAt = 0;
			}
			this.fetchLocks.delete(key);
			DescribeStore.dropObjectList(key);
		}
		this.emitChange(key, { objects, structural });
	}

	private getOrCreateOrgCache(key: string): OrgCache {
		const now = Date.now();
		this.pruneOrgs(now, key);
		let entry = this.cache.get(key);
		if (!entry) {
			entry = {
				sobjects: null,
				sobjectsFetchedAt: 0,
				lastUsed: now,
			};
		} else {
			this.cache.delete(key); // re-insert → most-recently-used
		}
		entry.lastUsed = now;
		this.cache.set(key, entry);
		return entry;
	}

	/** Drop idle non-default orgs and enforce the org cap (never the org being accessed). */
	private pruneOrgs(now: number, current: string): void {
		const def = cacheKey(null);
		for (const [k, e] of this.cache) {
			if (k !== current && k !== def && now - e.lastUsed > ORG_IDLE_MS) {
				this.cache.delete(k);
				this.fetchLocks.delete(k);
			}
		}
		while (this.cache.size >= MAX_ORGS && !this.cache.has(current)) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
			this.fetchLocks.delete(oldest);
		}
	}

	private async fetchSObjectList(org: string | null): Promise<string[]> {
		const version = getToolingApiVersion();
		const { body, auth } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/`
		);
		const data = JSON.parse(body);
		const sobjects: string[] = [];
		const arr = data.sobjects;
		if (Array.isArray(arr)) {
			for (const s of arr) {
				const name = typeof s === "string" ? s : s?.name;
				if (name) sobjects.push(name);
			}
		}
		sobjects.sort((a, b) => a.localeCompare(b));
		DescribeStore.persistObjectList(org, sobjects, auth.orgId);
		return sobjects;
	}



	private async fetchDescribe(org: string | null, sobject: string): Promise<SObjectDescribe | null> {
		try {
			// Shared raw describe (one network call across all schema caches).
			const data = await DescribeStore.getRaw(org, sobject);
			if (!data) return null;
			const fields = Array.isArray(data.fields)
				? data.fields.map((f: any) => ({
						name: f.name as string,
						type: (f.type as string) || "string",
						relationshipName: f.relationshipName || undefined,
						referenceTo: Array.isArray(f.referenceTo) && f.referenceTo.length > 0 ? (f.referenceTo as string[]) : undefined,
						updateable: f.updateable,
						calculated: f.calculated,
					}))
				: [];
			const childRelationships = Array.isArray(data.childRelationships)
				? data.childRelationships.map((cr) => ({ relationshipName: cr.relationshipName ?? undefined, childSObject: cr.childSObject }))
				: [];
			return { fields, childRelationships };
		} catch (e: any) {
			outputChannel.appendLine(`OrgMetadataCache: describe ${sobject} failed: ${e.message}`);
			return null;
		}
	}

	/**
	 * Get the list of sobject names for an org. Uses cache; refetches if missing or stale (TTL).
	 */
	async getObjectList(org: string | null): Promise<string[]> {
		if (!isSalesforceProject()) return [];
		const key = cacheKey(org);
		const entry = this.getOrCreateOrgCache(key);
		// Kept indefinitely once fetched — only Refresh Metadata / push-pull invalidation re-fetches.
		if (entry.sobjects !== null) {
			return entry.sobjects;
		}
		const existing = this.fetchLocks.get(key);
		if (existing) return existing;

		// Stale-while-revalidate from the previous session's persisted list: serve it now
		// (no CLI spawn / describeGlobal on the first completion), refetch in background.
		const persisted = await DescribeStore.getPersistedObjectList(key);
		if (entry.sobjects !== null) return entry.sobjects;
		if (persisted && persisted.list.length && !this.fetchLocks.has(key)) {
			entry.sobjects = persisted.list;
			entry.sobjectsFetchedAt = persisted.t;
			void this.fetchInto(key, entry, persisted.list);
			return persisted.list;
		}
		return this.fetchLocks.get(key) ?? this.fetchInto(key, entry);
	}

	/**
	 * Fetch the object list into `entry` (single-flight per key). With `servedStale`
	 * (a persisted list already handed out), a different result is announced as a
	 * structural change so the language server drops its object list.
	 */
	private fetchInto(key: string, entry: OrgCache, servedStale?: string[]): Promise<string[]> {
		const now = Date.now();
		// Only the current lock owner writes back: an invalidate/refresh while this was in
		// flight removes the lock, and the stale list must not overwrite the reset entry.
		const owns = () => this.fetchLocks.get(key) === promise && this.cache.get(key) === entry;
		const promise: Promise<string[]> = this.fetchSObjectList(key)
			.then((list) => {
				reportSchemaSuccess(key);
				if (owns()) {
					entry.sobjects = list;
					entry.sobjectsFetchedAt = now;
					this.fetchLocks.delete(key);
					if (servedStale && listsDiffer(servedStale, list)) this.emitChange(key, { objects: [], structural: true });
				}
				return list;
			})
			.catch((err: any) => {
				// Release the lock so the next call can retry instead of replaying this rejection forever.
				if (owns()) this.fetchLocks.delete(key);
				reportSchemaFailure(key, classifySchemaError(err));
				outputChannel.appendLine(`OrgMetadataCache: getObjectList failed: ${err?.message ?? err}`);
				return servedStale ?? ([] as string[]);
			});
		this.fetchLocks.set(key, promise);
		return promise;
	}

	/**
	 * Get describe (fields + childRelationships) for an sobject. Uses cache per org/sobject.
	 */
	async getDescribe(org: string | null, sobject: string): Promise<SObjectDescribe | null> {
		if (!isSalesforceProject() || !sobject) return null;
		// Source from the shared DescribeStore (the single per-org, ~10-min cache). We
		// don't keep our own parsed copy — that would outlive the store's TTL and serve
		// stale fields/relationships. Parsing a cached describe is cheap.
		return this.fetchDescribe(org, sobject);
	}

	/**
	 * Get field names for an sobject (from describe cache).
	 */
	async getFieldNames(org: string | null, sobject: string): Promise<string[]> {
		const desc = await this.getDescribe(org, sobject);
		return desc ? desc.fields.map((f) => f.name) : [];
	}

	/**
	 * Get field names with their Salesforce type for an sobject. Used for typed completions.
	 */
	async getFieldsWithMeta(org: string | null, sobject: string): Promise<{ name: string; type: string }[]> {
		const desc = await this.getDescribe(org, sobject);
		return desc ? desc.fields.map((f) => ({ name: f.name, type: f.type })) : [];
	}

	/**
	 * Like getFieldsWithMeta, but ALSO emits a relationship pseudo-field for every
	 * reference field so completion can offer both the id field and the traversal:
	 * e.g. `ParentId` (reference) AND `Parent` (rel → drill into Parent.Name).
	 * `rel: true` marks the relationship entry; `target` is the referenced sobject.
	 */
	async getFieldsAndRelations(
		org: string | null,
		sobject: string
	): Promise<{ name: string; type: string; rel?: boolean; target?: string }[]> {
		const desc = await this.getDescribe(org, sobject);
		if (!desc) return [];
		const out: { name: string; type: string; rel?: boolean; target?: string }[] = [];
		for (const f of desc.fields) {
			out.push({ name: f.name, type: f.type });
			if (f.relationshipName && f.referenceTo && f.referenceTo.length > 0) {
				out.push({ name: f.relationshipName, type: "reference", rel: true, target: f.referenceTo[0] });
			}
		}
		return out;
	}

	/**
	 * Resolve a relationship name (e.g. `Account__r`) on fromSobject to the target sobject API name.
	 * Returns null if the relationship is not found in the describe.
	 */
	async getRelationshipTarget(org: string | null, fromSobject: string, relName: string): Promise<string | null> {
		const desc = await this.getDescribe(org, fromSobject);
		if (!desc) return null;
		const want = (relName || "").toLowerCase();
		for (const f of desc.fields) {
			if (f.relationshipName && f.relationshipName.toLowerCase() === want && f.referenceTo && f.referenceTo.length > 0) {
				return f.referenceTo[0];
			}
		}
		return null;
	}

	/**
	 * Get child relationship names for subquery completion. Returns { name, sobject }[].
	 */
	async getChildRelationships(org: string | null, parentSobject: string): Promise<{ name: string; sobject: string }[]> {
		const desc = await this.getDescribe(org, parentSobject);
		if (!desc || !Array.isArray(desc.childRelationships)) return [];
		const out: { name: string; sobject: string }[] = [];
		for (const cr of desc.childRelationships) {
			const name = cr.relationshipName;
			const sobject = cr.childSObject;
			if (name && sobject) out.push({ name, sobject });
		}
		return out;
	}

	/**
	 * Editable fields map for an sobject (updateable, not calculated). For SOQL result grid.
	 */
	async getEditableFields(org: string | null, sobjectType: string): Promise<Record<string, boolean>> {
		const desc = await this.getDescribe(org, sobjectType);
		if (!desc) return {};
		const edit: Record<string, boolean> = {};
		for (const f of desc.fields) {
			if (f.updateable === true && f.calculated !== true) edit[f.name] = true;
		}
		return edit;
	}

	/**
	 * Refresh metadata for an org: refetch sobject list and clear describe cache so next access refetches.
	 * If background is true, run without awaiting (fire-and-forget).
	 */
	async refresh(org: string | null, options?: { background?: boolean }): Promise<void> {
		if (!isSalesforceProject()) return;
		const key = cacheKey(org);
		const entry = this.getOrCreateOrgCache(key);
		entry.sobjects = null;
		entry.sobjectsFetchedAt = 0;
		// Drop any in-flight fetch so the refresh really refetches (and the stale one can't write back).
		this.fetchLocks.delete(key);
		// Full refresh: memory AND the persisted (disk) describes + object list of this org.
		DescribeStore.clearPersisted(key);
		this.emitChange(key);

		const doRefresh = async () => {
			try {
				outputChannel.appendLine(`OrgMetadataCache: Refreshing metadata${org ? ` for ${org}` : ""}...`);
				await this.getObjectList(key);
				outputChannel.appendLine("OrgMetadataCache: Metadata refreshed.");
			} catch (e: any) {
				outputChannel.appendLine(`OrgMetadataCache: Refresh failed: ${e.message}`);
			}
		};

		if (options?.background) {
			void doRefresh();
			return;
		}
		await doRefresh();
	}

	/**
	 * Invalidate cache for an org (e.g. after pull). Next getObjectList/getDescribe will refetch.
	 */
	invalidate(org: string | null): void {
		const key = cacheKey(org);
		this.cache.delete(key);
		this.fetchLocks.delete(key);
		DescribeStore.invalidate(key);
		this.emitChange(key);
	}

	/**
	 * The default org switched. Cached data stays valid (it is keyed by username, not
	 * by "default"), but every consumer that resolved "the default org" must re-resolve:
	 * emit a full change without dropping anything.
	 */
	notifyDefaultOrgChanged(): void {
		this.emitChange(null);
	}

	/**
	 * Warm cache in background for default org (call when SOQL panel opens, etc.).
	 */
	warmDefaultOrg(): void {
		this.warmOrg(null);
	}

	/** Warm an org's object list in the background (canonical key — the same entry the LS reads). */
	warmOrg(org: string | null): void {
		if (!isSalesforceProject()) return;
		this.getObjectList(org).catch(() => {});
	}

	/**
	 * Low-priority background pre-describe of a few common objects (those present in
	 * the org), so the first completion on them is instant. Uses one composite/batch call.
	 */
	async warmCommonDescribes(org: string | null, names: string[] = ["Account", "Contact", "User"]): Promise<void> {
		if (!isSalesforceProject()) return;
		const list = await this.getObjectList(org);
		if (!list.length) return;
		const present = new Set(list);
		const wanted = names.filter((n) => present.has(n) && !DescribeStore.hasFresh(org, n));
		if (wanted.length) await DescribeStore.getMany(org, wanted);
	}

	/**
	 * Drop every cached object list and describe (all orgs) without notifying listeners.
	 * Use on workspace switch; listeners stay subscribed.
	 */
	clearAll(): void {
		this.cache.clear();
		this.fetchLocks.clear();
		DescribeStore.invalidateAll();
	}

	/** Release everything including change listeners (deactivate). Holds no timers. */
	disposeAll(): void {
		this.clearAll();
		this.changeListeners = [];
	}
}

export const OrgMetadataCache = new OrgMetadataCacheImpl();
