import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { Logger } from "./outputChannel";
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";

// ─── System fields excluded from every migration ──────────────────────────────
export const SYSTEM_FIELDS = new Set([
  "Id", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById",
  "SystemModstamp", "LastActivityDate", "LastViewedDate", "LastReferencedDate",
  "IsDeleted", "MasterRecordId", "CleanStatus", "JigsawCompanyId",
  "DandbCompanyId", "IndividualId", "PhotoUrl", "Jigsaw"
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrgInfo {
  accessToken: string;
  instanceUrl: string;
  username: string;
  apiVersion: string;
}

export interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  createable: boolean;
  updateable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  externalId: boolean;
  unique: boolean;
  nillable: boolean;
}

export interface ChildRelationship {
  childSObject: string;
  field: string;          // lookup field on the child pointing to parent
  relationshipName: string | null;
  cascadeDelete: boolean;
}

export interface SObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  queryable: boolean;
  createable: boolean;
  fields: FieldDescribe[];
  childRelationships: ChildRelationship[];
}

/**
 * One node in the migration tree.
 * `parentSObject` is null for the root.
 * `lookupField` is the field on THIS object that points to the parent.
 */
export interface MigrationNodeConfig {
  sobject: string;
  label: string;
  parentSObject: string | null;
  lookupField: string | null;
  /** Fields to SELECT from source and INSERT/UPSERT to target (excludes Id unless needed). */
  includeFields: string[];
  /** If set, use PATCH composite/sobjects/{SObject}/{field} for upsert; otherwise INSERT. */
  externalIdField: string | null;
}

export interface MigrationProfile {
  version: 2;
  name: string;
  createdAt: string;
  sourceQuery: string;         // SOQL for the root object
  rootSObject: string;
  /** Nodes in topological order — root first, children after parents. */
  nodes: MigrationNodeConfig[];
}

export interface MigrationProgress {
  sobject: string;
  phase: "querying" | "inserting" | "mapping" | "done" | "skipped";
  done: number;
  total: number;
  inserted: number;
  updated: number;
  failed: number;
}

export interface MigrationResult {
  sobject: string;
  queried: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; srcId: string; message: string }>;
}

// ─── Auth resolution ─────────────────────────────────────────────────────────

/**
 * Resolve an org alias (or null for the default org) to OrgInfo using the
 * auth cache. Throws a user-friendly error if credentials cannot be obtained.
 * This is the single replacement for all `runCommand("sf org display")` calls
 * in providers that need raw tokens for migration / query operations.
 */
export async function resolveOrgToInfo(org: string | null): Promise<OrgInfo> {
  const auth = await AuthInfo.getAuthInfoForOrg(org);
  if (!auth) {
    throw new Error(
      `Could not resolve credentials for org: ${org ?? "default"}. ` +
      `Set a default org or check your connection.`
    );
  }
  const apiVersion = getToolingApiVersion().replace(/^v/, "");
  return {
    accessToken: auth.accessToken,
    instanceUrl: auth.instanceUrl.replace(/\/$/, ""),
    username: auth.username,
    apiVersion,
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface HttpResp { status: number; body: string; }

export function sfRequest(
  instanceUrl: string,
  urlPath: string,
  method: string,
  accessToken: string,
  bodyObj?: unknown
): Promise<HttpResp> {
  return new Promise((resolve, reject) => {
    const base = instanceUrl.replace(/\/$/, "");
    const fullUrl = urlPath.startsWith("http") ? urlPath : `${base}${urlPath}`;
    let parsed: URL;
    try { parsed = new URL(fullUrl); } catch (e) { reject(e); return; }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : (http as unknown as typeof https);
    const bodyStr = bodyObj != null ? JSON.stringify(bodyObj) : undefined;
    const reqHeaders: Record<string, string | number> = {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    };
    if (bodyStr) reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method.toUpperCase(),
      headers: reqHeaders
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Describe ─────────────────────────────────────────────────────────────────

export async function describeObject(org: OrgInfo, sobject: string): Promise<SObjectDescribe> {
  const resp = await sfRequest(
    org.instanceUrl,
    `/services/data/v${org.apiVersion}/sobjects/${encodeURIComponent(sobject)}/describe`,
    "GET",
    org.accessToken
  );
  if (resp.status !== 200) {
    throw new Error(`Describe ${sobject} failed (HTTP ${resp.status}): ${resp.body.substring(0, 300)}`);
  }
  const raw = JSON.parse(resp.body);
  const fields: FieldDescribe[] = ((raw.fields ?? []) as Record<string, unknown>[]).map((f) => ({
    name: f.name as string,
    label: f.label as string,
    type: f.type as string,
    createable: !!(f.createable),
    updateable: !!(f.updateable),
    referenceTo: ((f.referenceTo as string[]) ?? []),
    relationshipName: (f.relationshipName as string | null) ?? null,
    externalId: !!(f.externalId),
    unique: !!(f.unique),
    nillable: !!(f.nillable)
  }));
  const childRelationships: ChildRelationship[] = (
    (raw.childRelationships ?? []) as Record<string, unknown>[]
  )
    .filter((cr) => !(cr.deprecatedAndHidden as boolean))
    .map((cr) => ({
      childSObject: cr.childSObject as string,
      field: cr.field as string,
      relationshipName: (cr.relationshipName as string | null) ?? null,
      cascadeDelete: !!(cr.cascadeDelete)
    }));
  return {
    name: raw.name as string,
    label: raw.label as string,
    labelPlural: (raw.labelPlural as string) ?? raw.name as string,
    queryable: !!(raw.queryable),
    createable: !!(raw.createable),
    fields,
    childRelationships
  };
}

// ─── Createable fields ────────────────────────────────────────────────────────

export function getCreatableFields(describe: SObjectDescribe): FieldDescribe[] {
  return describe.fields.filter(
    (f) => !SYSTEM_FIELDS.has(f.name) && (f.createable || f.updateable) && f.type !== "base64"
  );
}

// ─── Parse root SObject from SOQL ─────────────────────────────────────────────

export function extractSObjectFromQuery(soql: string): string {
  const m = soql.replace(/\s+/g, " ").match(/\bFROM\s+(\w+)/i);
  if (!m) throw new Error('Could not find FROM clause in SOQL query.');
  return m[1];
}

// ─── COUNT query ──────────────────────────────────────────────────────────────

export async function countQuery(org: OrgInfo, soql: string): Promise<number> {
  const countSoql = soql.replace(/SELECT\s+.+?\s+FROM/is, "SELECT COUNT() FROM").replace(/\bLIMIT\s+\d+/i, "");
  const resp = await sfRequest(
    org.instanceUrl,
    `/services/data/v${org.apiVersion}/query?q=${encodeURIComponent(countSoql)}`,
    "GET",
    org.accessToken
  );
  if (resp.status !== 200) return -1;
  try { return (JSON.parse(resp.body).totalSize as number) ?? -1; } catch { return -1; }
}

// ─── Query all records (paginated) ────────────────────────────────────────────

export async function queryAllRecords(
  org: OrgInfo,
  soql: string,
  onProgress?: (fetched: number, total: number) => void
): Promise<Record<string, string>[]> {
  const all: Record<string, string>[] = [];
  let url = `/services/data/v${org.apiVersion}/query?q=${encodeURIComponent(soql)}`;

  while (url) {
    const resp = await sfRequest(org.instanceUrl, url, "GET", org.accessToken);
    if (resp.status !== 200) {
      throw new Error(`Query failed (HTTP ${resp.status}): ${resp.body.substring(0, 400)}`);
    }
    const page = JSON.parse(resp.body);
    const records = (page.records ?? []) as Record<string, unknown>[];
    for (const r of records) {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k === "attributes") continue;
        if (v === null || v === undefined) flat[k] = "";
        else if (typeof v === "object") flat[k] = ""; // skip nested relationships
        else flat[k] = String(v);
      }
      all.push(flat);
    }
    onProgress?.(all.length, page.totalSize ?? all.length);
    url = page.done ? "" : ((page.nextRecordsUrl as string) ?? "");
  }
  return all;
}

// ─── Build SOQL for a child node given parent record IDs ─────────────────────

function buildChildQuery(node: MigrationNodeConfig, parentIds: string[]): string {
  const fields = ["Id", ...node.includeFields.filter((f) => f !== "Id")];
  const quoted = parentIds.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
  return `SELECT ${fields.join(",")} FROM ${node.sobject} WHERE ${node.lookupField} IN (${quoted || "'__NONE__'"})`;
}

/** Query specific source records by Id (used when retrying only the failed rows). */
async function querySourceByIds(
  org: OrgInfo,
  node: MigrationNodeConfig,
  ids: string[]
): Promise<Record<string, string>[]> {
  const fields = ["Id", ...node.includeFields.filter((f) => f !== "Id")];
  if (node.externalIdField && !fields.includes(node.externalIdField)) fields.push(node.externalIdField);
  const out: Record<string, string>[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const quoted = ids.slice(i, i + 500).map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = `SELECT ${fields.join(",")} FROM ${node.sobject} WHERE Id IN (${quoted || "'__NONE__'"})`;
    out.push(...(await queryAllRecords(org, soql)));
  }
  return out;
}

// ─── SObject Collections API ──────────────────────────────────────────────────

const BATCH_SIZE = 200;

interface CollectionsRecord {
  attributes: { type: string };
  [key: string]: unknown;
}

interface CollectionsItem {
  id: string | null;
  success: boolean;
  created?: boolean;
  errors?: Array<{ message: string; errorCode: string }>;
}

async function batchCollections(
  org: OrgInfo,
  sobject: string,
  records: CollectionsRecord[],
  externalIdField: string | null
): Promise<CollectionsItem[]> {
  const results: CollectionsItem[] = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    // Insert → POST /composite/sobjects. Upsert (external Id) → PATCH the
    // external-id collection endpoint. Using PATCH on the plain collection is an
    // UPDATE and demands an Id on every row ("Id not specified in an update call").
    const urlPath = externalIdField
      ? `/services/data/v${org.apiVersion}/composite/sobjects/${sobject}/${externalIdField}`
      : `/services/data/v${org.apiVersion}/composite/sobjects`;
    const method = externalIdField ? "PATCH" : "POST";
    const resp = await sfRequest(org.instanceUrl, urlPath, method, org.accessToken, { allOrNone: false, records: chunk });
    if (resp.status >= 200 && resp.status < 300) {
      try {
        results.push(...(JSON.parse(resp.body) as CollectionsItem[]));
      } catch {
        results.push(...chunk.map(() => ({ id: null, success: false, errors: [{ message: "Unparseable response", errorCode: "PARSE_ERROR" }] })));
      }
    } else {
      const errMsg = `HTTP ${resp.status}: ${resp.body.substring(0, 200)}`;
      results.push(...chunk.map(() => ({ id: null, success: false, errors: [{ message: errMsg, errorCode: "API_ERROR" }] })));
    }
  }
  return results;
}

/**
 * Delete records from the target org via the collections endpoint, newest object first.
 *
 * Only ever called with Ids this run inserted (tracked in idMaps), so a revert can never touch
 * pre-existing data. `allOrNone=false` so one undeletable record doesn't strand the rest.
 */
async function deleteRecords(org: OrgInfo, ids: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const urlPath =
      `/services/data/v${org.apiVersion}/composite/sobjects?allOrNone=false&ids=${chunk.join(",")}`;
    const resp = await sfRequest(org.instanceUrl, urlPath, "DELETE", org.accessToken);
    if (resp.status >= 200 && resp.status < 300) {
      try {
        for (const r of JSON.parse(resp.body) as CollectionsItem[]) r.success ? deleted++ : failed++;
      } catch {
        failed += chunk.length;
      }
    } else {
      failed += chunk.length;
    }
  }
  return { deleted, failed };
}

/**
 * Undo a run by deleting everything it inserted, children before parents (profile order reversed)
 * so lookups never block the delete.
 */
export async function revertMigration(
  org: OrgInfo,
  order: string[],
  idMaps: Record<string, Record<string, string>>,
  onProgress?: (sobject: string, deleted: number, failed: number) => void
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const sobject of [...order].reverse()) {
    const ids = Object.values(idMaps[sobject] ?? {}).filter(Boolean);
    if (!ids.length) continue;
    const r = await deleteRecords(org, ids);
    deleted += r.deleted;
    failed += r.failed;
    Logger.info(`Data migration revert — ${sobject}: deleted ${r.deleted}, failed ${r.failed}`);
    onProgress?.(sobject, r.deleted, r.failed);
  }
  return { deleted, failed };
}

// ─── Main migration runner ────────────────────────────────────────────────────

/**
 * Order nodes so each object is migrated after every migrated object it
 * references (tree parent + any other lookups). Junction objects therefore
 * come after both their linked parents. Cycles (self-references, mutual
 * lookups) are broken by falling back to the original order.
 */
function topoSortNodes(
  nodes: MigrationNodeConfig[],
  refMeta: Map<string, Map<string, string[]>>,
  included: Set<string>
): MigrationNodeConfig[] {
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
  const ordered: MigrationNodeConfig[] = [];
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

/**
 * Execute a full org-to-org migration based on a MigrationProfile.
 * Processes nodes in topological order (root first).
 * Maintains an ID map per SObject so child lookup fields are remapped
 * from source IDs to the newly created target IDs.
 */
export interface MigrationRunResult {
  results: MigrationResult[];
  /** sobject → (sourceId → targetId) for everything created/matched this run. */
  idMaps: Record<string, Record<string, string>>;
}

export interface MigrationRetryOptions {
  /** Re-attempt only these source record Ids per sobject. Objects absent / empty are skipped. */
  retryOnly?: Record<string, string[]>;
  /** Id maps carried over from a prior run so links to already-created records still resolve. */
  priorIdMaps?: Record<string, Record<string, string>>;
}

export async function runMigration(
  sourceOrg: OrgInfo,
  targetOrg: OrgInfo,
  profile: MigrationProfile,
  onProgress: (p: MigrationProgress) => void,
  opts?: MigrationRetryOptions
): Promise<MigrationRunResult> {
  const results: MigrationResult[] = [];
  // idMaps: sobject → Map<sourceId, targetId>
  const idMaps = new Map<string, Map<string, string>>();
  // Seed from a prior run (retry): links to already-created records still resolve.
  if (opts?.priorIdMaps) {
    for (const [sobj, m] of Object.entries(opts.priorIdMaps)) {
      idMaps.set(sobj, new Map(Object.entries(m)));
    }
  }
  const retrying = !!opts?.retryOnly;

  // Describe every object so we know which fields are references and what they
  // point to. This is what makes linking work: a reference is remapped to the
  // new target Id of the already-migrated record, never copied as a source Id.
  const includedSObjects = new Set(profile.nodes.map((n) => n.sobject));
  const refMeta = new Map<string, Map<string, string[]>>(); // sobject → (field → referenceTo[])
  // Fields the TARGET org will actually accept. A profile can be built before the target is
  // chosen (or against a differently-configured org), so a field may exist in the source and not
  // in the target — State & Country picklists (BillingCountryCode) are the classic case. Without
  // this the insert fails wholesale with "No such column".
  const targetWritable = new Map<string, Set<string>>(); // sobject → lower-cased createable field names
  for (const node of profile.nodes) {
    if (!refMeta.has(node.sobject)) {
      try {
        const desc = await describeObject(sourceOrg, node.sobject);
        const m = new Map<string, string[]>();
        for (const f of desc.fields) {
          if (f.referenceTo && f.referenceTo.length) m.set(f.name, f.referenceTo);
        }
        refMeta.set(node.sobject, m);
      } catch {
        refMeta.set(node.sobject, new Map());
      }
    }
    if (!targetWritable.has(node.sobject)) {
      try {
        const desc = await describeObject(targetOrg, node.sobject);
        targetWritable.set(
          node.sobject,
          new Set(desc.fields.filter((f) => f.createable).map((f) => f.name.toLowerCase()))
        );
      } catch {
        // Target describe unavailable — send the profile's fields unchanged rather than
        // dropping everything.
        targetWritable.set(node.sobject, new Set());
      }
    }
  }

  // Topologically order nodes so each object is migrated AFTER every migrated
  // object it references — its tree parent AND any extra lookups. This is what
  // makes junction objects work: both linked parents are inserted before the
  // junction row, so both of its lookups can be remapped to new target Ids.
  const orderedNodes = topoSortNodes(profile.nodes, refMeta, includedSObjects);

  for (const node of orderedNodes) {
    const result: MigrationResult = { sobject: node.sobject, queried: 0, inserted: 0, updated: 0, failed: 0, errors: [] };

    // ── 1 & 2. Obtain the source records to migrate ─────────────────────────
    let sourceRecords: Record<string, string>[];

    if (retrying) {
      // Retry mode: re-attempt only the previously-failed rows for this object.
      const failedIds = (opts!.retryOnly![node.sobject]) || [];
      if (failedIds.length === 0) {
        // Nothing failed here — keep its prior id map, don't re-insert (avoid duplicates).
        onProgress({ sobject: node.sobject, phase: "skipped", done: 0, total: 0, inserted: 0, updated: 0, failed: 0 });
        results.push(result);
        continue;
      }
      onProgress({ sobject: node.sobject, phase: "querying", done: 0, total: 0, inserted: 0, updated: 0, failed: 0 });
      try {
        sourceRecords = await querySourceByIds(sourceOrg, node, failedIds);
      } catch (e) {
        result.errors.push({ row: 0, srcId: "", message: `Query failed: ${e instanceof Error ? e.message : String(e)}` });
        results.push(result);
        continue;
      }
    } else {
      // Normal mode.
      let soql: string;
      if (!node.parentSObject) {
        const fields = ["Id", ...node.includeFields.filter((f) => f !== "Id")];
        soql = profile.sourceQuery.replace(/SELECT\s+.+?\s+FROM/is, `SELECT ${fields.join(",")} FROM`);
      } else {
        const parentIdMap = idMaps.get(node.parentSObject);
        const parentIds = parentIdMap ? Array.from(parentIdMap.keys()) : [];
        if (parentIds.length === 0) {
          onProgress({ sobject: node.sobject, phase: "skipped", done: 0, total: 0, inserted: 0, updated: 0, failed: 0 });
          results.push(result);
          continue;
        }
        soql = buildChildQuery(node, parentIds.slice(0, 500));
      }
      onProgress({ sobject: node.sobject, phase: "querying", done: 0, total: 0, inserted: 0, updated: 0, failed: 0 });
      try {
        sourceRecords = await queryAllRecords(sourceOrg, soql, (done, total) => {
          onProgress({ sobject: node.sobject, phase: "querying", done, total, inserted: 0, updated: 0, failed: 0 });
        });
      } catch (e) {
        result.errors.push({ row: 0, srcId: "", message: `Query failed: ${e instanceof Error ? e.message : String(e)}` });
        results.push(result);
        continue;
      }
      // Extra chunks for child nodes when there are > 500 parent IDs
      if (node.parentSObject) {
        const parentIdMap = idMaps.get(node.parentSObject);
        const parentIds = parentIdMap ? Array.from(parentIdMap.keys()) : [];
        for (let offset = 500; offset < parentIds.length; offset += 500) {
          try {
            const extra = await queryAllRecords(sourceOrg, buildChildQuery(node, parentIds.slice(offset, offset + 500)));
            sourceRecords.push(...extra);
          } catch { /* best-effort */ }
        }
      }
    }

    result.queried = sourceRecords.length;
    if (sourceRecords.length === 0) {
      onProgress({ sobject: node.sobject, phase: "done", done: 0, total: 0, inserted: 0, updated: 0, failed: 0 });
      results.push(result);
      continue;
    }

    // ── 3. Build target records with remapped lookup fields ─────────────────
    onProgress({ sobject: node.sobject, phase: "inserting", done: 0, total: sourceRecords.length, inserted: 0, updated: 0, failed: 0 });

    const nodeRefs = refMeta.get(node.sobject) ?? new Map<string, string[]>();
    // INSERT (no external Id) vs UPSERT (external Id → PATCH). On INSERT a null is
    // never meaningful — omit it so Salesforce applies defaults. On UPSERT a null is
    // intentional (clear the field), so it's kept.
    const isInsert = !node.externalIdField;
    const writable = targetWritable.get(node.sobject) ?? new Set<string>();
    const skipped = writable.size
      ? node.includeFields.filter((f) => f !== "Id" && !writable.has(f.toLowerCase()))
      : [];
    if (skipped.length) {
      Logger.info(`Data migration — ${node.sobject}: skipping ${skipped.length} field(s) the target org can't accept: ${skipped.join(", ")}`);
    }
    const targetRecords: CollectionsRecord[] = sourceRecords.map((rec) => {
      const out: CollectionsRecord = { attributes: { type: node.sobject } };
      for (const field of node.includeFields) {
        if (field === "Id") continue; // never copy the record's own Id
        // Not present/creatable in the target → omit (an empty set means "describe failed", so
        // fall through and send everything as before).
        if (writable.size && !writable.has(field.toLowerCase())) continue;
        const val: unknown = rec[field] === "" ? null : rec[field] ?? null;
        const referenceTo = nodeRefs.get(field);
        if (referenceTo && referenceTo.length) {
          // Reference field → remap to the new target Id of the migrated record.
          // If it can't be remapped (referenced object not migrated — OwnerId→User,
          // RecordTypeId, CreatedById, an unselected lookup), OMIT the field rather
          // than sending the source Id (which can never resolve in the target).
          // Omitting also avoids "OwnerId: owner cannot be blank" and won't clobber
          // an existing value on upsert.
          let remapped: string | undefined;
          if (val && typeof val === "string") {
            for (const refSObj of referenceTo) {
              const t = idMaps.get(refSObj)?.get(val);
              if (t) { remapped = t; break; }
            }
          }
          if (remapped) out[field] = remapped;
          continue; // omit when not remappable
        }
        // On INSERT, omit nulls (no reason to send them); on UPSERT, keep them
        // so an empty source value clears the target field.
        if (val === null && isInsert) continue;
        out[field] = val;
      }
      delete out["Id"];
      return out;
    });

    // ── 4. Send to target org ───────────────────────────────────────────────
    const responses = await batchCollections(targetOrg, node.sobject, targetRecords, node.externalIdField);

    // ── 5. Build idMap and tally ────────────────────────────────────────────
    onProgress({ sobject: node.sobject, phase: "mapping", done: sourceRecords.length, total: sourceRecords.length, inserted: 0, updated: 0, failed: 0 });

    const idMap = new Map<string, string>();
    let ins = 0, upd = 0, fail = 0;

    if (!node.externalIdField) {
      // INSERT: response array is in same order as request
      responses.forEach((r, idx) => {
        const srcId = sourceRecords[idx]?.["Id"] ?? "";
        if (r.success) {
          r.created !== false ? ins++ : upd++;
          if (r.id && srcId) idMap.set(srcId, r.id);
        } else {
          fail++;
          result.errors.push({ row: idx, srcId, message: r.errors?.[0]?.message ?? "Unknown error" });
        }
      });
    } else {
      // UPSERT: after sending, query target org to get new IDs by matching external ID values
      responses.forEach((r) => { r.success ? (r.created ? ins++ : upd++) : fail++; });
      if (responses.some((r) => !r.success)) {
        responses.forEach((r, idx) => {
          if (!r.success) {
            const srcId = sourceRecords[idx]?.["Id"] ?? "";
            result.errors.push({ row: idx, srcId, message: r.errors?.[0]?.message ?? "Unknown error" });
          }
        });
      }
      // Build srcId → extIdValue map
      const srcIdToExtId = new Map<string, string>();
      sourceRecords.forEach((r) => {
        const extVal = r[node.externalIdField!];
        if (r["Id"] && extVal) srcIdToExtId.set(r["Id"], extVal);
      });
      // Query target in chunks of 200
      const extIdValues = Array.from(new Set(srcIdToExtId.values()));
      for (let i = 0; i < extIdValues.length; i += 200) {
        const chunk = extIdValues.slice(i, i + 200);
        const quoted = chunk.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(",");
        const lookupSoql = `SELECT Id,${node.externalIdField} FROM ${node.sobject} WHERE ${node.externalIdField} IN (${quoted})`;
        try {
          const targetRecs = await queryAllRecords(targetOrg, lookupSoql);
          const extIdToTargetId = new Map(targetRecs.map((r) => [r[node.externalIdField!], r["Id"]]));
          srcIdToExtId.forEach((extId, srcId) => {
            const targetId = extIdToTargetId.get(extId);
            if (targetId) idMap.set(srcId, targetId);
          });
        } catch { /* skip — children will lose remapping but migration continues */ }
      }
    }

    result.inserted = ins;
    result.updated = upd;
    result.failed = fail;
    // Merge into any prior map (retry) so earlier successful links are preserved.
    const merged = idMaps.get(node.sobject) ?? new Map<string, string>();
    idMap.forEach((v, k) => merged.set(k, v));
    idMaps.set(node.sobject, merged);

    onProgress({ sobject: node.sobject, phase: "done", done: sourceRecords.length, total: sourceRecords.length, inserted: ins, updated: upd, failed: fail });
    results.push(result);
  }

  // Serialize id maps so the caller can persist them for a later retry.
  const idMapsOut: Record<string, Record<string, string>> = {};
  for (const [sobj, m] of idMaps.entries()) {
    idMapsOut[sobj] = Object.fromEntries(m);
  }
  return { results, idMaps: idMapsOut };
}

// ─── Profile I/O ─────────────────────────────────────────────────────────────

export function saveProfile(profile: MigrationProfile, filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf8");
}

export function loadProfileFromFile(filePath: string): MigrationProfile {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as MigrationProfile;
}
