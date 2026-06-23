import { SObjectDescribe } from "./orgMetadataCache";

/**
 * Pure, host-side builder for the Object Visualizer ERD.
 *
 * Given a set of "seed" objects and a map of pre-fetched describes, it produces
 * a graph of nodes + edges applying a strict **1-hop** rule:
 *   nodes = seeds ∪ parents(seed) ∪ children(seed)
 *   edges = every reference relationship whose BOTH endpoints are in the node set
 *
 * Neighbours are never expanded further (their own parents/children are not added),
 * which keeps the diagram scoped. No `vscode` import here so it stays unit-testable.
 */

export interface GraphNodeField {
  name: string;
  type: string;
  isReference: boolean;
  referenceTo?: string[];
  relationshipName?: string;
}

export interface GraphNode {
  /** sObject API name — also the Cytoscape node id. */
  id: string;
  /** True when the object was explicitly selected (vs pulled in as a 1-hop neighbour). */
  isSeed: boolean;
  /** All fields (used when "full fields" is toggled on). */
  fields: GraphNodeField[];
  /** Just the reference/relationship fields (shown by default). */
  referenceFields: GraphNodeField[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** The reference field name the edge is drawn through (e.g. "AccountId"). */
  via: string;
  /** True when the field can point to more than one object type (e.g. OwnerId). */
  polymorphic: boolean;
  /** True when the edge points back at the same object (e.g. Account.ParentId). */
  selfRef: boolean;
}

export interface ObjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** "Object: child1, child2, …" entries for children dropped by the per-seed cap. */
  truncated: string[];
}

export interface BuildOptions {
  /** Max child relationships pulled in per seed (default 25). Use Infinity for "All". */
  childCap?: number;
}

const DEFAULT_CHILD_CAP = 25;

function referenceFieldsOf(desc: SObjectDescribe): GraphNodeField[] {
  return desc.fields
    .filter((f) => f.type === "reference" && Array.isArray(f.referenceTo) && f.referenceTo.length > 0)
    .map((f) => ({
      name: f.name,
      type: f.type,
      isReference: true,
      referenceTo: f.referenceTo,
      relationshipName: f.relationshipName
    }));
}

function allFieldsOf(desc: SObjectDescribe): GraphNodeField[] {
  return desc.fields.map((f) => ({
    name: f.name,
    type: f.type,
    isReference: f.type === "reference" && Array.isArray(f.referenceTo) && f.referenceTo.length > 0,
    referenceTo: f.referenceTo,
    relationshipName: f.relationshipName
  }));
}

/** Children (childSObject names) of a seed, deduped, deterministically ordered, capped. */
function cappedChildren(desc: SObjectDescribe, cap: number): { kept: string[]; dropped: string[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const cr of desc.childRelationships || []) {
    const child = cr.childSObject;
    if (!child || seen.has(child)) continue;
    seen.add(child);
    names.push(child);
  }
  names.sort((a, b) => a.localeCompare(b));
  if (names.length <= cap) return { kept: names, dropped: [] };
  return { kept: names.slice(0, cap), dropped: names.slice(cap) };
}

export function buildObjectGraph(
  seeds: string[],
  describes: Map<string, SObjectDescribe>,
  opts: BuildOptions = {}
): ObjectGraph {
  const cap = opts.childCap ?? DEFAULT_CHILD_CAP;
  const seedSet = new Set(seeds.filter((s) => describes.has(s)));

  // ── 1. Node set: seeds ∪ parents(seed) ∪ children(seed) ──────────────────────
  const nodeIds = new Set<string>(seedSet);
  const truncated: string[] = [];

  for (const seed of seedSet) {
    const desc = describes.get(seed)!;
    // parents: every target of every reference field (handles polymorphic).
    for (const f of desc.fields) {
      if (f.type !== "reference" || !Array.isArray(f.referenceTo)) continue;
      for (const target of f.referenceTo) nodeIds.add(target);
    }
    // children: capped, recording what was dropped.
    const { kept, dropped } = cappedChildren(desc, cap);
    for (const child of kept) nodeIds.add(child);
    if (dropped.length > 0) truncated.push(`${seed}: ${dropped.join(", ")}`);
  }

  // ── 2. Nodes (only those we actually have a describe for can show fields) ─────
  const nodes: GraphNode[] = Array.from(nodeIds)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const desc = describes.get(id);
      return {
        id,
        isSeed: seedSet.has(id),
        fields: desc ? allFieldsOf(desc) : [],
        referenceFields: desc ? referenceFieldsOf(desc) : []
      };
    });

  // ── 3. Edges: any reference whose both endpoints are in the node set ─────────
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const o of nodeIds) {
    const desc = describes.get(o);
    if (!desc) continue;
    for (const f of desc.fields) {
      if (f.type !== "reference" || !Array.isArray(f.referenceTo)) continue;
      const polymorphic = f.referenceTo.length > 1;
      for (const t of f.referenceTo) {
        if (!nodeIds.has(t)) continue; // edge only if the target is in scope
        const id = `${o}->${t}::${f.name}`;
        if (seenEdge.has(id)) continue;
        seenEdge.add(id);
        edges.push({ id, source: o, target: t, via: f.name, polymorphic, selfRef: t === o });
      }
    }
  }

  return { nodes, edges, truncated };
}
