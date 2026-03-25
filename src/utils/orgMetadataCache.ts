import { AuthInfo } from "./authInfo";
import { httpsGet } from "./httpUtils";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { isSalesforceProject } from "./projectUtils";

const CACHE_KEY_DEFAULT = "__default__";

export interface SObjectDescribe {
  fields: { name: string; updateable?: boolean; calculated?: boolean }[];
  childRelationships?: { relationshipName?: string; childSObject?: string }[];
}

interface OrgCache {
  sobjects: string[] | null;
  describes: Map<string, SObjectDescribe>;
  /** When sobject list was last fetched (for background refresh). */
  sobjectsFetchedAt: number;
}

/** TTL for sobject list: refresh if older than this (ms). Describe cache is indefinite until invalidate. */
const SOBJECT_LIST_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheKey(org: string | null): string {
  return org === null || org === "" ? CACHE_KEY_DEFAULT : org;
}

/**
 * Per-org cache for sobject list and describe metadata. Use for SOQL completion,
 * builder, and any feature that needs object/field lists. Refresh when user pulls
 * or runs "Refresh Metadata"; optionally warm in background when opening SOQL etc.
 */
class OrgMetadataCacheImpl {
  private cache = new Map<string, OrgCache>();
  private fetchLocks = new Map<string, Promise<string[]>>();

  private getOrCreateOrgCache(key: string): OrgCache {
    let entry = this.cache.get(key);
    if (!entry) {
      entry = {
        sobjects: null,
        describes: new Map(),
        sobjectsFetchedAt: 0
      };
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async fetchSObjectList(org: string | null): Promise<string[]> {
    const auth = await AuthInfo.getAuthInfoForOrg(org);
    if (!auth) return [];
    const base = auth.instanceUrl.replace(/\/$/, "");
    const version = getToolingApiVersion();
    const url = `${base}/services/data/${version}/sobjects/`;
    const body = await httpsGet(url, auth.accessToken);
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
    const auth = await AuthInfo.getAuthInfoForOrg(org);
    if (!auth) return null;
    const base = auth.instanceUrl.replace(/\/$/, "");
    const version = getToolingApiVersion();
    const url = `${base}/services/data/${version}/sobjects/${encodeURIComponent(sobject)}/describe`;
    try {
      const body = await httpsGet(url, auth.accessToken);
      const data = JSON.parse(body);
      const fields = Array.isArray(data.fields) ? data.fields : [];
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
    if (entry.sobjects !== null && now - entry.sobjectsFetchedAt < SOBJECT_LIST_TTL_MS) {
      return entry.sobjects;
    }
    const existing = this.fetchLocks.get(key);
    if (existing) return existing;
    const promise = this.fetchSObjectList(org).then((list) => {
      entry.sobjects = list;
      entry.sobjectsFetchedAt = now;
      this.fetchLocks.delete(key);
      return list;
    });
    this.fetchLocks.set(key, promise);
    return promise;
  }

  /**
   * Get describe (fields + childRelationships) for an sobject. Uses cache per org/sobject.
   */
  async getDescribe(org: string | null, sobject: string): Promise<SObjectDescribe | null> {
    if (!isSalesforceProject() || !sobject) return null;
    const key = cacheKey(org);
    const entry = this.getOrCreateOrgCache(key);
    const cached = entry.describes.get(sobject);
    if (cached) return cached;
    const desc = await this.fetchDescribe(org, sobject);
    if (desc) entry.describes.set(sobject, desc);
    return desc;
  }

  /**
   * Get field names for an sobject (from describe cache).
   */
  async getFieldNames(org: string | null, sobject: string): Promise<string[]> {
    const desc = await this.getDescribe(org, sobject);
    return desc ? desc.fields.map((f) => f.name) : [];
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
    entry.describes.clear();
    entry.sobjects = null;
    entry.sobjectsFetchedAt = 0;

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
