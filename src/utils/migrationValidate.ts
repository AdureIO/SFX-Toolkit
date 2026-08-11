/**
 * Pre-migration validation. Pure (no `vscode`, no I/O) so it can be unit-tested and run before a
 * single record is written — a lookup that can't be preserved has to be surfaced while the user
 * can still fix it by including the missing object, not reported afterwards.
 */

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
  const alwaysEmpty = new Set(["ownerid", "recordtypeid", "createdbyid", "lastmodifiedbyid"]);
  const out: UnmappedLookup[] = [];
  for (const node of nodes) {
    const fields = refMeta.get(node.sobject);
    if (!fields) continue;
    for (const field of node.includeFields) {
      if (field === "Id" || alwaysEmpty.has(field.toLowerCase())) continue;
      const referenceTo = fields.get(field);
      if (!referenceTo || !referenceTo.length) continue;
      if (referenceTo.some((r) => included.has(r.toLowerCase()))) continue; // resolvable (incl. self)
      out.push({ sobject: node.sobject, field, referenceTo });
    }
  }
  return out;
}
