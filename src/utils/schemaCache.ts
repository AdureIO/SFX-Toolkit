/**
 * Rich SObject describe cache for data tools, migration wizard, REST explorer,
 * and Apex data factory. Uses AuthInfo for authenticated REST calls with 401
 * auto-retry, and caches full describe results (including createable, externalId,
 * unique, nillable) with a 15-minute TTL.
 *
 * Complements OrgMetadataCache (which serves the lighter SOQL-completion describe)
 * with the richer schema information needed by data operations.
 */
import { DescribeStore } from "./describeStore";
import type { SObjectDescribe, FieldDescribe, ChildRelationship } from "./dataMigration";

// ─── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_KEY_DEFAULT = "__default__";

// ─── Internal types ────────────────────────────────────────────────────────────

interface CacheEntry {
  describe: SObjectDescribe;
  fetchedAt: number;
}

function orgKey(org: string | null): string {
  return org === null || org === "" ? CACHE_KEY_DEFAULT : org;
}

// ─── Cache implementation ─────────────────────────────────────────────────────

class SchemaCacheImpl {
  private cache = new Map<string, Map<string, CacheEntry>>();

  private getOrgMap(org: string | null): Map<string, CacheEntry> {
    const key = orgKey(org);
    let m = this.cache.get(key);
    if (!m) {
      m = new Map();
      this.cache.set(key, m);
    }
    return m;
  }

  /**
   * Get a rich SObject describe (fields with createable, externalId, unique, nillable, etc).
   * Results are cached per org+sobject with a 15-minute TTL.
   * Uses AuthInfo for authenticated REST calls with automatic 401 retry.
   */
  async getRichDescribe(org: string | null, sobject: string): Promise<SObjectDescribe | null> {
    if (!sobject) return null;
    const map = this.getOrgMap(org);
    const entry = map.get(sobject);
    if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
      return entry.describe;
    }

    // Shared raw describe (one network call across all schema caches).
    const raw = (await DescribeStore.getRaw(org, sobject)) as Record<string, unknown> | null;
    if (!raw) return null;
    const describe = this.parseDescribe(raw);
    map.set(sobject, { describe, fetchedAt: Date.now() });
    return describe;
  }

  private parseDescribe(raw: Record<string, unknown>): SObjectDescribe {
    const fields: FieldDescribe[] = (
      (raw.fields ?? []) as Record<string, unknown>[]
    ).map((f) => ({
      name: f.name as string,
      label: (f.label as string) ?? (f.name as string),
      type: (f.type as string) ?? "string",
      createable: !!(f.createable),
      updateable: !!(f.updateable),
      referenceTo: ((f.referenceTo as string[]) ?? []),
      relationshipName: (f.relationshipName as string | null) ?? null,
      externalId: !!(f.externalId),
      unique: !!(f.unique),
      nillable: !!(f.nillable),
    }));

    const childRelationships: ChildRelationship[] = (
      (raw.childRelationships ?? []) as Record<string, unknown>[]
    )
      .filter((cr) => !(cr.deprecatedAndHidden as boolean))
      .map((cr) => ({
        childSObject: cr.childSObject as string,
        field: cr.field as string,
        relationshipName: (cr.relationshipName as string | null) ?? null,
        cascadeDelete: !!(cr.cascadeDelete),
      }));

    return {
      name: raw.name as string,
      label: (raw.label as string) ?? (raw.name as string),
      labelPlural: (raw.labelPlural as string) ?? (raw.name as string),
      queryable: !!(raw.queryable),
      createable: !!(raw.createable),
      fields,
      childRelationships,
    };
  }

  /**
   * Invalidate all cached describes for an org.
   * Call after the user refreshes metadata or after a deploy that changed field definitions.
   */
  invalidate(org: string | null): void {
    this.cache.delete(orgKey(org));
    DescribeStore.invalidate(org);
  }

  /** Invalidate a specific sobject's cached describe. */
  invalidateSObject(org: string | null, sobject: string): void {
    this.getOrgMap(org).delete(sobject);
    DescribeStore.invalidateSObject(org, sobject);
  }

  /** Clear all cached describes across all orgs. */
  clear(): void {
    this.cache.clear();
    DescribeStore.invalidateAll();
  }

  /** Stats for a given org: how many describes are currently cached. */
  stats(org: string | null): { count: number; sobjects: string[] } {
    const map = this.getOrgMap(org);
    return { count: map.size, sobjects: Array.from(map.keys()) };
  }
}

export const SchemaCache = new SchemaCacheImpl();
