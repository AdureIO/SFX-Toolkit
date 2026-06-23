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
  /** From describe — used by the UI to hide read-only/system fields. */
  updateable?: boolean;
  calculated?: boolean;
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

/** How far out from the seeds to pull related objects. */
export type GraphDirection = "self" | "parents" | "both";

export interface BuildOptions {
  /** Max child relationships pulled in per seed (default 25). Use Infinity for "All". */
  childCap?: number;
  /**
   * "self"    — only the selected objects (+ edges among them);
   * "parents" — selected + objects they reference (lookups out);
   * "both"    — selected + parents + children (default, full 1-hop).
   */
  direction?: GraphDirection;
  /**
   * Include polymorphic lookups (referenceTo length > 1, e.g. OwnerId, WhatId).
   * Off by default — these native fields point at many object types and otherwise
   * drag dozens of objects (and huge label text) into the graph.
   */
  includePolymorphic?: boolean;
  /**
   * Include audit lookups (CreatedById / LastModifiedById → User). Off by default —
   * they're on virtually every object and turn User into a noisy hub.
   */
  includeAudit?: boolean;
}

const DEFAULT_CHILD_CAP = 25;

/** Standard audit lookups present on (almost) every object — User hub-makers. */
const AUDIT_REF_FIELDS = new Set(["CreatedById", "LastModifiedById"]);

interface RefFieldLike {
  name: string;
  type: string;
  referenceTo?: string[];
}

/** Whether a reference field should be traversed / drawn, given the filter options. */
function includeRefField(f: RefFieldLike, includePolymorphic: boolean, includeAudit: boolean): boolean {
  if (f.type !== "reference" || !Array.isArray(f.referenceTo) || f.referenceTo.length === 0) return false;
  if (!includeAudit && AUDIT_REF_FIELDS.has(f.name)) return false;
  if (f.referenceTo.length > 1 && !includePolymorphic) return false;
  return true;
}

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
    relationshipName: f.relationshipName,
    updateable: f.updateable,
    calculated: f.calculated
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
  const direction = opts.direction ?? "both";
  const includePolymorphic = opts.includePolymorphic ?? false;
  const includeAudit = opts.includeAudit ?? false;
  const seedSet = new Set(seeds.filter((s) => describes.has(s)));

  // ── 1. Node set: seeds (+ parents) (+ children) per the direction option ─────
  const nodeIds = new Set<string>(seedSet);
  const truncated: string[] = [];

  for (const seed of seedSet) {
    const desc = describes.get(seed)!;
    if (direction === "parents" || direction === "both") {
      // parents: targets of reference fields (skipping polymorphic unless asked).
      for (const f of desc.fields) {
        if (!includeRefField(f, includePolymorphic, includeAudit)) continue;
        for (const target of f.referenceTo!) nodeIds.add(target);
      }
    }
    if (direction === "both") {
      const { kept, dropped } = cappedChildren(desc, cap);
      for (const child of kept) nodeIds.add(child);
      if (dropped.length > 0) truncated.push(`${seed}: ${dropped.join(", ")}`);
    }
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
      if (!includeRefField(f, includePolymorphic, includeAudit)) continue;
      const refTo = f.referenceTo!;
      const polymorphic = refTo.length > 1;
      for (const t of refTo) {
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
