/**
 * Turning a migration into something other than records in a second org: an Apex script, CSV, or
 * JSON. Pure (no `vscode`, no I/O) so the generated output can be unit-tested character for
 * character — a script that only fails once pasted into Anonymous Apex is worse than no script.
 *
 * The Apex generator follows the same rules as the live migration: system and org-assigned fields
 * are already gone from the profile, lookups are re-pointed at the records the script itself
 * creates rather than copied as source Ids, and self-references are linked in a second pass. The
 * one deliberate difference is the external Id — where the migration upserts, so does the script.
 */

import { topoSortNodes, type OrderableNode } from "./migrationOrder";

/** The records collected for one object, values as returned by the query (empty string for null). */
export interface ExportObjectData {
  sobject: string;
  records: Record<string, string>[];
}

/**
 * Field type, lookup targets and relationship name, per object. Drives literal formatting and
 * how a lookup is re-pointed — the relationship name is what makes the external-Id form
 * (`Account = new Account(Ext__c = 'E1')`) possible.
 */
export type ExportFieldMeta = Map<string, Map<string, {
  type: string;
  referenceTo: string[];
  relationshipName?: string | null;
  /** Marked as an external Id on the object — usable as a foreign key in a relationship stub. */
  externalId?: boolean;
  unique?: boolean;
}>>;

export interface ExportProfileLike {
  name: string;
  rootSObject: string;
  nodes: Array<OrderableNode & { externalIdField: string | null }>;
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180: quote when the value contains a delimiter, quote or newline; double inner quotes. */
export function csvCell(value: string): string {
  if (value === "" || value == null) return "";
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * One CSV per object. The Id column is kept: without it the export cannot be matched back to the
 * source, and a CSV is usually the input to something that needs that key.
 */
export function toCsvExports(
  data: ExportObjectData[],
  columnsFor: (sobject: string) => string[]
): Array<{ fileName: string; content: string }> {
  return data.map(({ sobject, records }) => {
    const columns = columnsFor(sobject);
    const lines = [columns.map(csvCell).join(",")];
    for (const rec of records) lines.push(columns.map((c) => csvCell(rec[c] ?? "")).join(","));
    return { fileName: `${sobject}.csv`, content: lines.join("\r\n") + "\r\n" };
  });
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

export function toJsonExport(profile: ExportProfileLike, data: ExportObjectData[], exportedAt: string): string {
  return JSON.stringify({
    profile: profile.name,
    rootSObject: profile.rootSObject,
    exportedAt,
    objects: data.map((d) => ({
      sobject: d.sobject,
      externalIdField: profile.nodes.find((n) => n.sobject === d.sobject)?.externalIdField ?? null,
      count: d.records.length,
      records: d.records
    }))
  }, null, 2);
}

// ─── Apex ─────────────────────────────────────────────────────────────────────

/**
 * The Developer Console's Execute Anonymous window truncates past this, so it is the budget a
 * generated script is split to fit.
 */
export const APEX_CONSOLE_MAX_CHARS = 32_000;
/** What the Tooling API accepts — the ceiling for `sf apex run --file`, well above the console. */
export const APEX_API_MAX_CHARS = 1_000_000;
/** One transaction cannot DML more rows than this. */
export const APEX_MAX_DML_ROWS = 10_000;

const NUMERIC = new Set(["int", "integer", "long", "double", "currency", "percent"]);

export function apexString(value: string): string {
  // Backslash first, or the escapes we add would themselves be escaped.
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
}

/**
 * A field value as an Apex literal, or null when it should be left out.
 *
 * An empty value is omitted rather than written as null: on insert there is no reason to send it,
 * and the target org's own defaults should apply — the same choice the live migration makes.
 */
export function apexLiteral(value: string, type: string): string | null {
  if (value === "" || value == null) return null;
  const t = (type || "string").toLowerCase();
  if (t === "boolean") return value.toLowerCase() === "true" ? "true" : "false";
  if (NUMERIC.has(t)) return Number.isFinite(Number(value)) ? String(Number(value)) : apexString(value);
  if (t === "date") return `Date.valueOf(${apexString(value.substring(0, 10))})`;
  if (t === "datetime") {
    // Salesforce returns 2024-01-31T09:15:00.000+0000; valueOfGmt wants 2024-01-31 09:15:00.
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value);
    return m ? `Datetime.valueOfGmt(${apexString(`${m[1]} ${m[2]}`)})` : `Datetime.valueOfGmt(${apexString(value)})`;
  }
  if (t === "time") return `Time.newInstance(${value.substring(0, 2)}, ${value.substring(3, 5)}, ${value.substring(6, 8)}, 0)`;
  return apexString(value);
}

/**
 * The field a lookup to this object can be resolved through.
 *
 * Any external Id will do, not just the one chosen as the upsert key — the DML resolves a
 * relationship stub against whichever external Id it carries. The only requirement is that the
 * script actually writes the field, so it has to be one of the object's included fields. A unique
 * one is preferred: a non-unique external Id makes the foreign key ambiguous and the DML rejects
 * it.
 */
export function resolveKeyFor(
  node: ExportProfileLike["nodes"][number],
  meta: ExportFieldMeta
): string | null {
  const included = node.includeFields;
  if (node.externalIdField && included.includes(node.externalIdField)) return node.externalIdField;
  const fields = meta.get(node.sobject);
  if (!fields) return null;
  const candidates = included.filter((f) => fields.get(f)?.externalId);
  return candidates.find((f) => fields.get(f)?.unique) ?? candidates[0] ?? null;
}

/** A valid, collision-free Apex identifier stem for an object (Order__c → Order__c, ns__X → ns__X). */
export function apexVar(sobject: string): string {
  const cleaned = sobject.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
}

/**
 * One DML-able slice of an object's records.
 *
 * An object is usually one chunk. It is split into several only when that is provably safe —
 * see `chunkable` — because every part is a separate execution with its own variables.
 */
interface Chunk {
  sobject: string;
  externalIdField: string | null;
  rowLiterals: string[];
  /** Source Ids, aligned with `rowLiterals`. */
  srcIds: string[];
  /** Self-reference assignments; only ever present on an object kept in one piece. */
  selfLinks: string[];
  /** Per referenced object, the source Ids this chunk looks up. */
  needsIds: Map<string, Set<string>>;
  /** Whether anything has to find these records again by source Id. */
  exposesMap: boolean;
  chars: number;
}

/** One record's generated literal, plus which parent maps it reads. */
interface RowData {
  literal: string;
  srcId: string;
  needs: Map<string, Set<string>>;
}

/** Room left for the part header, hoisted map declarations and any rehydration query. */
const PART_OVERHEAD_RESERVE = 3_000;

function chunkBody(chunk: Chunk, suffix: string): string[] {
  const v = apexVar(chunk.sobject);
  const rows = `${v}_rows${suffix}`;
  const lines: string[] = [];
  lines.push(`List<${chunk.sobject}> ${rows} = new List<${chunk.sobject}>{`);
  chunk.rowLiterals.forEach((r, i) => lines.push(`  ${r}${i < chunk.rowLiterals.length - 1 ? "," : ""}`));
  lines.push(`};`);
  lines.push(chunk.externalIdField
    ? `upsert ${rows} ${chunk.sobject}.${chunk.externalIdField};`
    : `insert ${rows};`);
  if (chunk.exposesMap) {
    // The list order survives the DML, so the source Ids zip straight back onto it — far shorter
    // than giving every row its own variable.
    const src = `${v}_src${suffix}`;
    lines.push(`List<String> ${src} = new List<String>{${chunk.srcIds.map(apexString).join(",")}};`);
    lines.push(`for (Integer i = 0; i < ${rows}.size(); i++) ${v}_byId.put(${src}[i], ${rows}[i]);`);
  }
  if (chunk.selfLinks.length) {
    lines.push(...chunk.selfLinks);
    lines.push(`update ${rows};`);
  }
  return lines;
}

/**
 * Build the chunks for one object.
 *
 * Splitting an object's records is only safe when no part can end up needing rows that another
 * part holds in a variable. That rules it out when the object links to itself, and requires an
 * external Id whenever a later object has to look these records up — otherwise the object stays
 * in one piece even if that overflows the budget.
 */
function buildRows(
  node: ExportProfileLike["nodes"][number],
  records: Record<string, string>[],
  meta: ExportFieldMeta,
  included: Set<string>,
  srcIdsBySObject: Map<string, Set<string>>,
  externalKeys: Map<string, Map<string, string>>,
  resolveKeyOf: Map<string, string | null>
): { rows: RowData[]; selfRefs: Array<{ srcId: string; field: string; refSrcId: string }> } {
  const sobject = node.sobject;
  const fieldMeta = meta.get(sobject) ?? new Map();
  const selfRefs: Array<{ srcId: string; field: string; refSrcId: string }> = [];

  const rows = records.map((rec) => {
    const assignments: string[] = [];
    const needs = new Map<string, Set<string>>();
    for (const field of node.includeFields) {
      if (field === "Id") continue;
      const info = fieldMeta.get(field);
      const raw = rec[field] ?? "";
      const referenceTo = info?.referenceTo ?? [];
      if (referenceTo.length) {
        if (!raw) continue;
        // A lookup is only written when the record it points at is part of this export. Outside
        // it the link can only be left empty — a source Id would not resolve in the org this runs
        // against, and a map lookup that misses would throw.
        const target = referenceTo.find((r: string) => included.has(r) && srcIdsBySObject.get(r)?.has(raw));
        if (!target) continue;

        if (referenceTo.includes(sobject) && srcIdsBySObject.get(sobject)?.has(raw)) {
          // Self-reference. The external-Id form cannot help here: the parent is in the very same
          // DML statement, and a foreign key by external Id only resolves against rows that
          // already exist. So it is linked in a second pass, after the insert gives every row an
          // Id. This is checked before the external-Id branch for exactly that reason.
          selfRefs.push({ srcId: rec["Id"] ?? "", field, refSrcId: raw });
          continue;
        }

        // Preferred form: point the RELATIONSHIP at a stub carrying the parent's external Id and
        // let the DML resolve it. No variable, no ordering beyond "the parent already exists" —
        // which holds, since a different object is a separate, earlier DML statement — and it
        // survives across executions, which is what makes a script splittable at all.
        const parentKey = externalKeys.get(target)?.get(raw);
        const relationship = info?.relationshipName;
        if (parentKey && relationship) {
          assignments.push(`${relationship}=new ${target}(${resolveKeyOf.get(target)}=${apexString(parentKey)})`);
          continue;
        }
        // Fallback: the parent has no external Id, so the only handle on it is the record this
        // script created. That costs a map, and pins the two objects into the same execution.
        (needs.get(target) ?? needs.set(target, new Set()).get(target)!).add(raw);
        assignments.push(`${field}=${apexVar(target)}_byId.get(${apexString(raw)}).Id`);
        continue;
      }
      const literal = apexLiteral(raw, info?.type ?? "string");
      if (literal !== null) assignments.push(`${field}=${literal}`);
    }
    return { literal: `new ${sobject}(${assignments.join(", ")})`, srcId: rec["Id"] ?? "", needs };
  });
  return { rows, selfRefs };
}

/**
 * Slice one object's rows into chunks that fit the budget.
 *
 * Splitting is only safe when no part can end up needing rows another part holds in a variable:
 * that rules it out when the object links to itself through a map, and requires an external Id
 * whenever a later object still has to look these records up. Otherwise the object stays whole,
 * even if that overflows.
 */
function chunkRows(
  node: ExportProfileLike["nodes"][number],
  rows: RowData[],
  selfRefs: Array<{ srcId: string; field: string; refSrcId: string }>,
  mapNeeded: boolean,
  resolveKey: string | null,
  budget: number
): Chunk[] {
  const sobject = node.sobject;
  const v = apexVar(sobject);
  const exposesMap = mapNeeded || selfRefs.length > 0;
  const selfLinks = selfRefs
    .filter((r) => r.srcId && r.refSrcId)
    .map(({ srcId, field, refSrcId }) =>
      `${v}_byId.get(${apexString(srcId)}).${field} = ${v}_byId.get(${apexString(refSrcId)}).Id;`);

  const chunkable = selfLinks.length === 0 && (!mapNeeded || !!resolveKey);
  const limit = Math.max(1_000, budget - PART_OVERHEAD_RESERVE);

  const chunks: Chunk[] = [];
  let cur: RowData[] = [];
  let curChars = 0;
  const flush = () => {
    if (!cur.length) return;
    const needsIds = new Map<string, Set<string>>();
    for (const b of cur) {
      for (const [target, ids] of b.needs) {
        const set = needsIds.get(target) ?? needsIds.set(target, new Set()).get(target)!;
        for (const id of ids) set.add(id);
      }
    }
    const chunk: Chunk = {
      sobject, externalIdField: node.externalIdField,
      rowLiterals: cur.map((b) => b.literal),
      srcIds: cur.map((b) => b.srcId),
      selfLinks: chunks.length === 0 ? selfLinks : [],
      needsIds, exposesMap, chars: 0
    };
    chunk.chars = chunkBody(chunk, "").reduce((n, l) => n + l.length + 1, 0);
    chunks.push(chunk);
    cur = [];
    curChars = 0;
  };

  for (const b of rows) {
    // The source Id list roughly adds its own length again when a map is emitted.
    const cost = b.literal.length + (exposesMap ? b.srcId.length + 6 : 0) + 4;
    if (chunkable && cur.length && curChars + cost > limit) flush();
    cur.push(b);
    curChars += cost;
  }
  flush();
  return chunks;
}

/**
 * Rebuild an earlier part's source-Id → record map by querying the org.
 *
 * Variables do not survive from one anonymous execution to the next, so a part that references
 * records an earlier part created has to find them again. The external Id is the only thing that
 * can do that, which is why a split is only ever placed where every object still needed has one.
 */
function rehydrateLines(
  sobject: string,
  externalIdField: string,
  keyBySrcId: Map<string, string>,
  wantedSrcIds: Set<string>
): string[] {
  const v = apexVar(sobject);
  const pairs = [...wantedSrcIds]
    .map((srcId) => [srcId, keyBySrcId.get(srcId)] as const)
    .filter((p): p is readonly [string, string] => !!p[1]);
  if (!pairs.length) return [];
  return [
    `// ${sobject} was loaded by an earlier part — find those records again by ${externalIdField}`,
    `Map<String, String> ${v}_srcByKey = new Map<String, String>{${
      pairs.map(([srcId, key]) => `${apexString(key)}=>${apexString(srcId)}`).join(",")
    }};`,
    `for (${sobject} r : [SELECT Id, ${externalIdField} FROM ${sobject} WHERE ${externalIdField} IN :${v}_srcByKey.keySet()]) {`,
    `  ${v}_byId.put(${v}_srcByKey.get(String.valueOf(r.get(${apexString(externalIdField)}))), r);`,
    `}`,
    ``
  ];
}

export interface ApexPart {
  /** 1-based. */
  index: number;
  content: string;
  chars: number;
  rows: number;
  objects: string[];
  /** True when this part could not be split small enough — see `oversizeReason`. */
  oversize: boolean;
  oversizeReason?: string;
}

/**
 * Generate Anonymous Apex that recreates the exported records, split into parts that each fit the
 * Execute Anonymous character budget.
 *
 * Records go in as list literals, and only objects that something later has to find again pay for
 * a source-Id → record map — zipped onto the list after the DML rather than naming every row.
 *
 * Splitting is constrained by the platform, not by preference: an anonymous block's variables are
 * gone by the next execution, so a part may only begin where every object it still references can
 * be re-queried, which means an external Id. Where one is missing the objects stay together even
 * if the result is over budget, and the part says so rather than handing over a script that will
 * silently truncate when pasted.
 */
export function toApexParts(
  profile: ExportProfileLike,
  data: ExportObjectData[],
  meta: ExportFieldMeta,
  generatedAt: string,
  budget: number = APEX_CONSOLE_MAX_CHARS
): ApexPart[] {
  const byObject = new Map(data.map((d) => [d.sobject, d.records]));
  const included = new Set(profile.nodes.map((n) => n.sobject));
  const refMeta = new Map<string, Map<string, string[]>>();
  for (const [sobject, fields] of meta) {
    const m = new Map<string, string[]>();
    for (const [field, info] of fields) if (info.referenceTo?.length) m.set(field, info.referenceTo);
    refMeta.set(sobject, m);
  }
  const ordered = topoSortNodes(profile.nodes, refMeta, included)
    .filter((n) => (byObject.get(n.sobject)?.length ?? 0) > 0);

  // Which source Ids each object carries — a lookup is only emitted when its record is here.
  const srcIdsBySObject = new Map<string, Set<string>>();
  for (const [sobject, records] of byObject) {
    srcIdsBySObject.set(sobject, new Set(records.map((r) => r["Id"]).filter(Boolean)));
  }

  // The field each object's lookups resolve through — the upsert key when there is one, otherwise
  // any external Id the script writes. source Id → its value is what lets a lookup be written as
  // `Account = new Account(Ext__c = 'E1')` instead of going through a map.
  const resolveKeyOf = new Map<string, string | null>(ordered.map((n) => [n.sobject, resolveKeyFor(n, meta)]));
  const externalKeys = new Map<string, Map<string, string>>();
  for (const node of ordered) {
    const key = resolveKeyOf.get(node.sobject);
    if (!key) continue;
    const m = new Map<string, string>();
    for (const rec of byObject.get(node.sobject) ?? []) {
      if (rec["Id"] && rec[key]) m.set(rec["Id"], rec[key]);
    }
    externalKeys.set(node.sobject, m);
  }

  // Build every row first. Only then is it known which objects actually had to fall back to a
  // map — a parent reachable by external Id costs nothing, so most exports need no maps at all.
  const rowsByObject = new Map<string, ReturnType<typeof buildRows>>();
  for (const node of ordered) {
    rowsByObject.set(node.sobject, buildRows(
      node, byObject.get(node.sobject) ?? [], meta, included, srcIdsBySObject, externalKeys, resolveKeyOf
    ));
  }
  const mapNeeded = new Set<string>();
  for (const { rows } of rowsByObject.values()) {
    for (const row of rows) for (const target of row.needs.keys()) mapNeeded.add(target);
  }

  const chunks: Chunk[] = [];
  for (const node of ordered) {
    const built = rowsByObject.get(node.sobject)!;
    chunks.push(...chunkRows(node, built.rows, built.selfRefs, mapNeeded.has(node.sobject), resolveKeyOf.get(node.sobject) ?? null, budget));
  }

  // ── Pack chunks into parts ────────────────────────────────────────────────
  const partChunks: Chunk[][] = [];
  let current: Chunk[] = [];
  let currentChars = 0;
  for (const chunk of chunks) {
    const inPart = new Set(current.map((c) => c.sobject));
    // A new part can only start if everything this chunk still needs can be found again by query.
    const unrecoverable = [...chunk.needsIds.keys()].filter((s) => !inPart.has(s) && !resolveKeyOf.get(s));
    if (current.length && currentChars + chunk.chars > budget - PART_OVERHEAD_RESERVE && !unrecoverable.length) {
      partChunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chunk);
    currentChars += chunk.chars;
  }
  if (current.length) partChunks.push(current);

  // ── Emit ──────────────────────────────────────────────────────────────────
  const totalRows = chunks.reduce((n, c) => n + c.rowLiterals.length, 0);
  const emittedBefore = new Map<string, Set<string>>(); // sobject → source Ids already loaded

  return partChunks.map((part, idx) => {
    const objects = [...new Set(part.map((c) => c.sobject))];
    const partRows = part.reduce((n, c) => n + c.rowLiterals.length, 0);
    const lines: string[] = [];
    const label = partChunks.length > 1 ? ` — part ${idx + 1} of ${partChunks.length}` : "";

    lines.push(`/*`);
    lines.push(` * ${profile.name}${label} — Adure SFX Toolkit Data Migration Wizard, ${generatedAt}`);
    lines.push(` *`);
    lines.push(` * Run in Anonymous Apex against the target org. Lookups point at records this`);
    lines.push(` * script creates, so no source Id ever reaches the target. Objects with an`);
    lines.push(` * external Id upsert on it and are safe to re-run; the rest insert and will`);
    lines.push(` * duplicate if run twice.`);
    if (partChunks.length > 1) {
      lines.push(` *`);
      lines.push(` * Run the parts in order — this one expects parts 1..${idx} to have run already.`);
    }
    lines.push(` *`);
    lines.push(` * ${partRows} record(s), ${objects.join(", ")}` +
               (partChunks.length > 1 ? ` (${totalRows} across all parts)` : ""));
    if (partRows > APEX_MAX_DML_ROWS) {
      lines.push(` *`);
      lines.push(` * WARNING: ${partRows} rows exceeds the ${APEX_MAX_DML_ROWS}-row DML limit for one`);
      lines.push(` * transaction. Load this part's objects from CSV instead.`);
    }
    lines.push(` */`);
    lines.push("");

    // Every map this part reads or fills, declared once up front — several chunks of the same
    // object share one map, and a rehydrated object fills the same one.
    const needsMap = new Set<string>();
    for (const chunk of part) {
      if (chunk.exposesMap) needsMap.add(chunk.sobject);
      for (const s of chunk.needsIds.keys()) needsMap.add(s);
    }
    for (const sobject of needsMap) {
      lines.push(`Map<String, ${sobject}> ${apexVar(sobject)}_byId = new Map<String, ${sobject}>();`);
    }
    if (needsMap.size) lines.push("");

    // Anything referenced here that an earlier part created has to be looked up again.
    const rehydrated = new Set<string>();
    for (const chunk of part) {
      for (const [sobject, wanted] of chunk.needsIds) {
        if (rehydrated.has(sobject)) continue;
        const fromEarlier = new Set([...wanted].filter((id) => emittedBefore.get(sobject)?.has(id)));
        if (!fromEarlier.size) continue;
        const ext = resolveKeyOf.get(sobject);
        if (!ext) continue;
        rehydrated.add(sobject);
        lines.push(...rehydrateLines(sobject, ext, externalKeys.get(sobject) ?? new Map(), fromEarlier));
      }
    }

    const seenInPart = new Map<string, number>();
    for (const chunk of part) {
      const n = (seenInPart.get(chunk.sobject) ?? 0) + 1;
      seenInPart.set(chunk.sobject, n);
      const suffix = n > 1 ? `_${n}` : "";
      lines.push(`// ── ${chunk.sobject} — ${chunk.rowLiterals.length} record(s)`);
      lines.push(...chunkBody(chunk, suffix));
      lines.push("");
      const seen = emittedBefore.get(chunk.sobject) ?? new Set<string>();
      for (const id of chunk.srcIds) seen.add(id);
      emittedBefore.set(chunk.sobject, seen);
    }
    lines.push(`System.debug('Part ${idx + 1}: loaded ${partRows} record(s).');`);

    const content = lines.join("\n");
    const oversize = content.length > budget;
    return {
      index: idx + 1,
      content: oversize ? withOversizeNotice(content, content.length, budget) : content,
      chars: content.length,
      rows: partRows,
      objects,
      oversize,
      oversizeReason: oversize ? oversizeReason(part, resolveKeyOf) : undefined
    };
  });
}

function oversizeReason(part: Chunk[], resolveKeyOf: Map<string, string | null>): string {
  const pinned = [...new Set(part
    .filter((c) => c.selfLinks.length || [...c.needsIds.keys()].some((s) => !resolveKeyOf.get(s)))
    .map((c) => c.sobject))];
  return pinned.length
    ? `${pinned.join(", ")} cannot be split up: an object is only divisible when it does not link ` +
      `to itself and the objects it looks up have an external Id to find them by.`
    : `A single record is larger than the budget allows.`;
}

function withOversizeNotice(content: string, chars: number, budget: number): string {
  return [
    `/*`,
    ` * NOTE: this part is ${chars} characters, over the ${budget}-character Execute Anonymous`,
    ` * window. Run it with the CLI instead, which accepts far more:`,
    ` *`,
    ` *   sf apex run --file <this file>`,
    ` *`,
    ` * Or export CSV/JSON for a load this size.`,
    ` */`,
    ``,
    content
  ].join("\n");
}

/** The whole script as one string — what a caller wanting a single file gets. */
export function toApexScript(
  profile: ExportProfileLike,
  data: ExportObjectData[],
  meta: ExportFieldMeta,
  generatedAt: string,
  budget: number = APEX_API_MAX_CHARS
): string {
  return toApexParts(profile, data, meta, generatedAt, budget).map((p) => p.content).join("\n\n");
}
