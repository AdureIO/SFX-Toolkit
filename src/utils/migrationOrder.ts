/**
 * The order objects have to be processed in, shared by the migration engine and every export
 * format. Pure (no `vscode`, no I/O) so both can reach it and it can be unit-tested.
 */

/** The shape ordering needs — a full MigrationNodeConfig satisfies it. */
export interface OrderableNode {
  sobject: string;
  parentSObject: string | null;
  includeFields: string[];
}

/**
 * Order nodes so each object is migrated after every migrated object it
 * references (tree parent + any other lookups). Junction objects therefore
 * come after both their linked parents. Cycles (self-references, mutual
 * lookups) are broken by falling back to the original order.
 */
export function topoSortNodes<T extends OrderableNode>(
  nodes: T[],
  refMeta: Map<string, Map<string, string[]>>,
  included: Set<string>
): T[] {
  const deps = new Map<string, Set<string>>();
  for (const n of nodes) {
    const d = new Set<string>();
    if (n.parentSObject && included.has(n.parentSObject) && n.parentSObject !== n.sobject) {
      d.add(n.parentSObject);
    }
    const m = refMeta.get(n.sobject);
    if (m) {
      for (const field of n.includeFields) {
        const refs = m.get(field);
        if (!refs) continue;
        for (const r of refs) {
          if (included.has(r) && r !== n.sobject) d.add(r);
        }
      }
    }
    deps.set(n.sobject, d);
  }
  const bySObject = new Map(nodes.map((n) => [n.sobject, n]));
  const origIndex = new Map(nodes.map((n, i) => [n.sobject, i]));
  const remaining = new Set(nodes.map((n) => n.sobject));
  const ordered: T[] = [];
  while (remaining.size) {
    let pick: string | null = null;
    let pickIdx = Infinity;
    // Prefer a node whose dependencies are all already emitted.
    for (const s of remaining) {
      const d = deps.get(s)!;
      let ready = true;
      for (const dep of d) { if (remaining.has(dep)) { ready = false; break; } }
      if (ready && origIndex.get(s)! < pickIdx) { pick = s; pickIdx = origIndex.get(s)!; }
    }
    // Cycle: nothing is ready — break it by taking the earliest remaining node.
    if (pick === null) {
      for (const s of remaining) {
        if (origIndex.get(s)! < pickIdx) { pick = s; pickIdx = origIndex.get(s)!; }
      }
    }
    if (pick === null) break;
    ordered.push(bySObject.get(pick)!);
    remaining.delete(pick);
  }
  return ordered;
}

