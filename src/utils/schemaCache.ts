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

// ─── Cache implementation ─────────────────────────────────────────────────────

// Rich describes are not cached here — they're parsed on demand from the shared
// DescribeStore (the single per-org, ~10-min cache). This class only adds the
// richer parsing shape on top.
class SchemaCacheImpl {
  /**
   * Get a rich SObject describe (fields with createable, externalId, unique, nillable, etc).
   * Sourced from the shared DescribeStore (the single per-org, ~10-min cache); we parse on
   * each call rather than keeping a parsed copy that could outlive the store's TTL.
   * Uses AuthInfo for authenticated REST calls with automatic 401 retry.
   */
  async getRichDescribe(org: string | null, sobject: string): Promise<SObjectDescribe | null> {
    if (!sobject) return null;
    const raw = (await DescribeStore.getRaw(org, sobject)) as Record<string, unknown> | null;
    if (!raw) return null;
    return this.parseDescribe(raw);
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
    DescribeStore.invalidate(org);
  }

  /** Invalidate a specific sobject's cached describe. */
  invalidateSObject(org: string | null, sobject: string): void {
    DescribeStore.invalidateSObject(org, sobject);
  }

  /** Clear all cached describes across all orgs. */
  clear(): void {
    DescribeStore.invalidateAll();
  }
}

export const SchemaCache = new SchemaCacheImpl();
