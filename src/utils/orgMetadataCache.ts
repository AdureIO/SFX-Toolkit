import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { isSalesforceProject } from "./projectUtils";
import { DescribeStore } from "./describeStore";

const CACHE_KEY_DEFAULT = "__default__";

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
}


function cacheKey(org: string | null): string {
	return org === null || org === "" ? CACHE_KEY_DEFAULT : org;
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
		for (const name of objects) DescribeStore.invalidateSObject(org, name);
		if (structural) {
			const entry = this.cache.get(cacheKey(org));
			if (entry) {
				entry.sobjects = null;
				entry.sobjectsFetchedAt = 0;
			}
			this.fetchLocks.delete(cacheKey(org));
		}
		this.emitChange(org, { objects, structural });
	}

	private getOrCreateOrgCache(key: string): OrgCache {
		let entry = this.cache.get(key);
		if (!entry) {
			entry = {
				sobjects: null,
				sobjectsFetchedAt: 0,
			};
			this.cache.set(key, entry);
		}
		return entry;
	}

	private async fetchSObjectList(org: string | null): Promise<string[]> {
		const version = getToolingApiVersion();
		const { body } = await AuthInfo.get(org, (a) =>
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
		return sobjects.sort((a, b) => a.localeCompare(b));
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
			const childRelationships = Array.isArray(data.childRelationships) ? data.childRelationships : [];
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
		const now = Date.now();
		// Kept indefinitely once fetched — only Refresh Metadata / push-pull invalidation re-fetches.
		if (entry.sobjects !== null) {
			return entry.sobjects;
		}
		const existing = this.fetchLocks.get(key);
		if (existing) return existing;
		const promise = this.fetchSObjectList(org)
			.then((list) => {
				entry.sobjects = list;
				entry.sobjectsFetchedAt = now;
				this.fetchLocks.delete(key);
				return list;
			})
			.catch((err: any) => {
				// Release the lock so the next call can retry instead of replaying this rejection forever.
				this.fetchLocks.delete(key);
				outputChannel.appendLine(`OrgMetadataCache: getObjectList failed: ${err?.message ?? err}`);
				return [] as string[];
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
		DescribeStore.invalidate(org);
		this.emitChange(org);

		const doRefresh = async () => {
			try {
				outputChannel.appendLine(`OrgMetadataCache: Refreshing metadata${org ? ` for ${org}` : ""}...`);
				await this.getObjectList(org);
				outputChannel.appendLine("OrgMetadataCache: Metadata refreshed.");
			} catch (e: any) {
				outputChannel.appendLine(`OrgMetadataCache: Refresh failed: ${e.message}`);
			}
		};

		if (options?.background) {
			doRefresh();
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
		DescribeStore.invalidate(org);
		this.emitChange(org);
	}

	/**
	 * Warm cache in background for default org (call when SOQL panel opens, etc.).
	 */
	warmDefaultOrg(): void {
		if (!isSalesforceProject()) return;
		this.getObjectList(null).catch(() => {});
	}
}

export const OrgMetadataCache = new OrgMetadataCacheImpl();
