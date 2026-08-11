/**
 * Pre-migration validation. Pure (no `vscode`, no I/O) so it can be unit-tested and run before a
 * single record is written — a lookup that can't be preserved has to be surfaced while the user
 * can still fix it by including the missing object, not reported afterwards.
 */

/**
 * Lookups the target org fills in itself. No selection the user makes can preserve these — the
 * owner is the running user, the record type is resolved by the target's own configuration, and
 * audit fields are set by the platform. Recommending "add User to this migration" for them is
 * advice that can never be followed.
 */
export const ORG_ASSIGNED_LOOKUPS = new Set([
  "ownerid", "recordtypeid", "createdbyid", "lastmodifiedbyid"
]);

/** Why a given org-assigned lookup is never carried across. */
export function orgAssignedReason(field: string): string {
  switch (field.toLowerCase()) {
    case "ownerid": return "Owner is assigned by the target org — record ownership is never migrated";
    case "recordtypeid": return "Record Type is resolved by the target org's own configuration";
    default: return "Audit field — always set by the platform";
  }
}

/** A lookup that will be left empty because the object it points at isn't in the migration. */
export interface UnmappedLookup {
  sobject: string;
  field: string;
  /** Objects the lookup can point at, none of which are being migrated. */
  referenceTo: string[];
}

/**
 * Find lookups that CANNOT be preserved with the current selection, so the user is told before
 * anything is written rather than after the records land with empty links.
 *
 * Self-references are fine (re-linked after insert) and so are lookups to objects already in the
 * migration. Ids that could never be remapped anyway (Owner, RecordType, audit fields) are not
 * reported — nothing the user selects would fix those.
 */
export function findUnmappedLookups(
  nodes: Array<{ sobject: string; includeFields: string[] }>,
  refMeta: Map<string, Map<string, string[]>>
): UnmappedLookup[] {
  const included = new Set(nodes.map((n) => n.sobject.toLowerCase()));
  const out: UnmappedLookup[] = [];
  for (const node of nodes) {
    const fields = refMeta.get(node.sobject);
    if (!fields) continue;
    for (const field of node.includeFields) {
      if (field === "Id" || ORG_ASSIGNED_LOOKUPS.has(field.toLowerCase())) continue;
      const referenceTo = fields.get(field);
      if (!referenceTo || !referenceTo.length) continue;
      if (referenceTo.some((r) => included.has(r.toLowerCase()))) continue; // resolvable (incl. self)
      out.push({ sobject: node.sobject, field, referenceTo });
    }
  }
  return out;
}
