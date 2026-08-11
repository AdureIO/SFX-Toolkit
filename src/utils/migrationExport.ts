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

/** Field type + lookup targets, per object. Drives literal formatting and lookup re-pointing. */
export type ExportFieldMeta = Map<string, Map<string, { type: string; referenceTo: string[] }>>;

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

/** Anonymous Apex is rejected above roughly 1 MB, and one transaction can only DML 10,000 rows. */
export const APEX_MAX_CHARS = 1_000_000;
export const APEX_MAX_DML_ROWS = 10_000;

const STRINGY = new Set([
  "string", "textarea", "picklist", "multipicklist", "phone", "email", "url",
  "id", "reference", "encryptedstring", "combobox", "base64", "address", "anytype"
]);
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
  if (STRINGY.has(t)) return apexString(value);
  return apexString(value);
}

/** A valid, collision-free Apex identifier stem for an object (Order__c → Order__c, ns__X → ns__X). */
export function apexVar(sobject: string): string {
  const cleaned = sobject.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `x${cleaned}`;
}

/**
 * Generate an Anonymous Apex script that recreates the migrated records in whatever org it is
 * run against.
 *
 * Each object gets a list and a source-Id → record map. Children reference their parent through
 * that map, so the link is to the record the script just created — never a source Id, which would
 * not resolve. Nodes with an external Id upsert on it instead of inserting, which also makes the
 * script safe to re-run for those objects.
 */
export function toApexScript(
  profile: ExportProfileLike,
  data: ExportObjectData[],
  meta: ExportFieldMeta,
  generatedAt: string
): string {
  const byObject = new Map(data.map((d) => [d.sobject, d.records]));
  const included = new Set(profile.nodes.map((n) => n.sobject));
  const refMeta = new Map<string, Map<string, string[]>>();
  for (const [sobject, fields] of meta) {
    const m = new Map<string, string[]>();
    for (const [field, info] of fields) if (info.referenceTo?.length) m.set(field, info.referenceTo);
    refMeta.set(sobject, m);
  }
  const ordered = topoSortNodes(profile.nodes, refMeta, included);
  // Which source Ids each object actually carries. A lookup is only written when its record is
  // in here — the same rule the live migration applies, and it is also what keeps the script from
  // throwing: a `.get()` on a key the map never received would be a null dereference at runtime.
  const srcIds = new Map<string, Set<string>>();
  for (const [sobject, records] of byObject) {
    srcIds.set(sobject, new Set(records.map((r) => r["Id"]).filter(Boolean)));
  }

  const totalRows = ordered.reduce((n, node) => n + (byObject.get(node.sobject)?.length ?? 0), 0);
  const out: string[] = [];

  out.push(`/*`);
  out.push(` * ${profile.name} — generated by the Adure SFX Toolkit Data Migration Wizard`);
  out.push(` * ${generatedAt}`);
  out.push(` *`);
  out.push(` * Run in Anonymous Apex against the target org. Objects are created parent-first and`);
  out.push(` * every lookup points at a record this script creates, so source Ids never leak into`);
  out.push(` * the target. Objects with an external Id upsert on it and are safe to re-run;`);
  out.push(` * everything else inserts and will duplicate if you run it twice.`);
  out.push(` *`);
  out.push(` * ${totalRows} record(s) across ${ordered.length} object(s).`);
  if (totalRows > APEX_MAX_DML_ROWS) {
    out.push(` *`);
    out.push(` * WARNING: ${totalRows} rows exceeds the ${APEX_MAX_DML_ROWS}-row DML limit for a single`);
    out.push(` * transaction. Split this script or load it in batches.`);
  }
  out.push(` */`);
  out.push("");

  for (const node of ordered) {
    const sobject = node.sobject;
    const records = byObject.get(sobject) ?? [];
    const v = apexVar(sobject);
    const listVar = `${v}_rows`;
    const mapVar = `${v}_bySrc`;
    const fieldMeta = meta.get(sobject) ?? new Map();
    const selfRefs: Array<{ srcId: string; field: string; refSrcId: string }> = [];

    out.push(`// ── ${sobject} — ${records.length} record(s) ${"─".repeat(Math.max(2, 48 - sobject.length))}`);
    if (!records.length) {
      out.push(`// nothing to load`);
      out.push("");
      continue;
    }
    out.push(`List<${sobject}> ${listVar} = new List<${sobject}>();`);
    out.push(`Map<String, ${sobject}> ${mapVar} = new Map<String, ${sobject}>();`);

    records.forEach((rec, idx) => {
      const rowVar = `${v}_${idx}`;
      const assignments: string[] = [];
      for (const field of node.includeFields) {
        if (field === "Id") continue;
        const info = fieldMeta.get(field);
        const raw = rec[field] ?? "";
        const referenceTo = info?.referenceTo ?? [];
        if (referenceTo.length) {
          if (!raw) continue;
          if (referenceTo.includes(sobject) && srcIds.get(sobject)?.has(raw)) {
            // Self-reference: the parent is in this same list and has no Id until after the
            // insert, so it is linked in a second pass below.
            selfRefs.push({ srcId: rec["Id"] ?? "", field, refSrcId: raw });
            continue;
          }
          // A lookup is only written when the record it points at is part of this export. Outside
          // it, the link can only be left empty — a source Id would not resolve in the org this
          // runs against, and a map lookup that misses would throw.
          const target = referenceTo.find((r: string) => included.has(r) && srcIds.get(r)?.has(raw));
          if (target) assignments.push(`${field} = ${apexVar(target)}_bySrc.get(${apexString(raw)}).Id`);
          continue;
        }
        const literal = apexLiteral(raw, info?.type ?? "string");
        if (literal !== null) assignments.push(`${field} = ${literal}`);
      }
      if (!assignments.length) {
        out.push(`${sobject} ${rowVar} = new ${sobject}();`);
      } else {
        out.push(`${sobject} ${rowVar} = new ${sobject}(`);
        assignments.forEach((a, i) => out.push(`    ${a}${i < assignments.length - 1 ? "," : ""}`));
        out.push(`);`);
      }
      out.push(`${listVar}.add(${rowVar}); ${mapVar}.put(${apexString(rec["Id"] ?? "")}, ${rowVar});`);
    });

    out.push("");
    if (node.externalIdField) {
      out.push(`upsert ${listVar} ${sobject}.${node.externalIdField};`);
    } else {
      out.push(`insert ${listVar};`);
    }

    const linkable = selfRefs.filter((r) => r.srcId && r.refSrcId);
    if (linkable.length) {
      out.push("");
      out.push(`// re-link self-references now that every ${sobject} row has an Id`);
      for (const { srcId, field, refSrcId } of linkable) {
        out.push(`${mapVar}.get(${apexString(srcId)}).${field} = ${mapVar}.get(${apexString(refSrcId)}).Id;`);
      }
      out.push(`update ${listVar};`);
    }
    out.push("");
  }

  out.push(`System.debug('Loaded ${totalRows} record(s).');`);

  const script = out.join("\n");
  if (script.length > APEX_MAX_CHARS) {
    return `/*\n * WARNING: this script is ${script.length} characters — Anonymous Apex rejects\n` +
           ` * anything over about ${APEX_MAX_CHARS}. Export fewer records, or split it by object.\n */\n\n` +
           script;
  }
  return script;
}
