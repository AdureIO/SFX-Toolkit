import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Logger } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { SchemaCache } from "../utils/schemaCache";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { getCachedOrgList, refreshOrgListCache, warmOrgListCache } from "../utils/orgListCache";
import {
  getCreatableFields,
  extractSObjectFromQuery,
  countQuery,
  runMigration,
  collectMigrationData,
  describeObject,
  findUnmappedLookups,
  ORG_ASSIGNED_LOOKUPS,
  orgAssignedReason,
  revertMigration,
  countJournal,
  filterJournal,
  subtractJournal,
  resolveOrgToInfo,
  saveProfile,
  loadProfileFromFile,
  type MigrationProfile,
  type SObjectDescribe,
  type FieldDescribe,
  type MigrationProgress,
  type MigrationJournal,
  type RevertSelection,
  type OrgInfo
} from "../utils/dataMigration";
import { toApexParts, toCsvExports, toJsonExport, APEX_CONSOLE_MAX_CHARS, type ExportFieldMeta } from "../utils/migrationExport";
import { Telemetry } from "../utils/telemetry";
import { confirmProductionOrgOperation } from "../utils/orgSafety";

// ─── Field availability comparison (source vs target org) ──────────────────────

interface ExcludedField { name: string; label: string; type: string; reason: string; }

/**
 * Split the source's creatable fields into those that can actually be written to
 * the TARGET org and those that can't. A field is excluded if it doesn't exist in
 * the target org, or exists but isn't creatable there (formula/system/read-only).
 * Without a target describe (target not chosen yet) everything is "available".
 */
function partitionFieldsByTarget(
  sourceFields: FieldDescribe[],
  targetDescribe: SObjectDescribe | null
): { available: FieldDescribe[]; excluded: ExcludedField[] } {
  const available: FieldDescribe[] = [];
  const excluded: ExcludedField[] = [];
  const targetByName = new Map<string, FieldDescribe>();
  if (targetDescribe) for (const f of targetDescribe.fields) targetByName.set(f.name.toLowerCase(), f);

  for (const f of sourceFields) {
    // Owner, Record Type and audit lookups are not migratable data — the target org assigns
    // them. They are listed as excluded (with the reason) rather than offered as a choice that
    // can only ever be wrong.
    if (ORG_ASSIGNED_LOOKUPS.has(f.name.toLowerCase())) {
      excluded.push({ name: f.name, label: f.label, type: f.type, reason: orgAssignedReason(f.name) });
      continue;
    }
    if (!targetDescribe) { available.push(f); continue; }
    const t = targetByName.get(f.name.toLowerCase());
    if (!t) { excluded.push({ name: f.name, label: f.label, type: f.type, reason: "Not present in target org" }); continue; }
    if (!t.createable) { excluded.push({ name: f.name, label: f.label, type: f.type, reason: "Not writable in target (formula / system / no permission)" }); continue; }
    available.push(f);
  }
  return { available, excluded };
}

/**
 * Every field that could serve as an upsert key, including the ones the target org won't accept.
 *
 * Filtering those out entirely is what made a freshly created external Id look like it simply
 * wasn't there. They are listed with the reason instead, so "my external Id is missing" always
 * has an answer on screen.
 */
function externalIdCandidates(
  sourceFields: FieldDescribe[],
  excluded: ExcludedField[]
): Array<{ name: string; type: string; usable: boolean; reason?: string }> {
  const reasonByName = new Map(excluded.map((e) => [e.name.toLowerCase(), e.reason]));
  return sourceFields
    .filter((f) => f.externalId || f.unique)
    .map((f) => {
      const reason = reasonByName.get(f.name.toLowerCase());
      return reason ? { name: f.name, type: f.type, usable: false, reason } : { name: f.name, type: f.type, usable: true };
    });
}

// ─── Revert helpers ───────────────────────────────────────────────────────────

function revertDetail(counts: { inserted: number; restorable: number }): string {
  const parts: string[] = [];
  if (counts.inserted) parts.push(`delete ${counts.inserted} record(s) this run created`);
  if (counts.restorable) parts.push(`restore ${counts.restorable} record(s) it overwrote to their previous values`);
  return `This will ${parts.join(" and ")}.\n\nNothing else in the target org is touched.`;
}

/** Run the revert and report it to both the panel and the user. */
async function performRevert(
  panel: vscode.WebviewPanel,
  orgInfo: OrgInfo,
  order: string[],
  journal: MigrationJournal,
  orgLabel: string,
  /** What is still undoable afterwards — everything the user did not select. */
  remaining?: MigrationJournal | null
): Promise<void> {
  panel.webview.postMessage({ command: "revertStarted" });
  try {
    const r = await revertMigration(orgInfo, order, journal, (sobject, step, done, failed) =>
      panel.webview.postMessage({ command: "revertProgress", sobject, step, done, failed })
    );
    panel.webview.postMessage({ command: "revertComplete", ...r, remaining: remaining ?? null });
    const msg =
      `Reverted ${orgLabel}: deleted ${r.deleted}, restored ${r.restored}` +
      (r.failed ? `, ${r.failed} could not be undone` : "") + ".";
    Logger.info(msg);
    r.failed ? vscode.window.showWarningMessage(msg) : vscode.window.showInformationMessage(msg);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    Logger.error("Migration revert failed", e);
    panel.webview.postMessage({ command: "revertError", error: err.substring(0, 600) });
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class DataMigrationPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.dataMigration";

  public static async show(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showErrorMessage("No workspace open."); return; }
    const workspaceRoot = folder.uri.fsPath;

    const panel = vscode.window.createWebviewPanel(
      DataMigrationPanelProvider.viewType,
      "Data Migration Wizard",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = DataMigrationPanelProvider.getHtml();

    // Warm caches in background on panel open
    warmOrgListCache();
    AuthInfo.warmAuthForOrg(null);

    // The last run's undo information, kept here rather than in the webview so "Revert this run"
    // always acts on what was really written. Cleared once reverted so it can't be replayed.
    let lastRun: { org: string; orgInfo: OrgInfo; order: string[]; journal: MigrationJournal } | null = null;

    panel.webview.onDidReceiveMessage(async (msg: {
      command: string;
      sourceOrg?: string;
      targetOrg?: string;
      soql?: string;
      sobject?: string;
      profile?: MigrationProfile;
      name?: string;
      text?: string;
      retry?: { retryOnly?: Record<string, string[]>; priorIdMaps?: Record<string, Record<string, string>> };
      revertOnFail?: boolean;
      selection?: RevertSelection;
      format?: "org" | "apex" | "csv" | "json";
    }) => {

      // ── Init ─────────────────────────────────────────────────────────────
      if (msg.command === "panelReady") {
        const cached = getCachedOrgList();
        const orgs = cached ?? await refreshOrgListCache();
        panel.webview.postMessage({ command: "init", orgs, defaultOrg: orgs[0]?.username ?? "" });
        if (!cached) void refreshOrgListCache(); // re-warm if we just fetched
        return;
      }

      // ── Object list (for root-object builder dropdown) ────────────────────
      if (msg.command === "getObjectList") {
        const { sourceOrg = "" } = msg;
        try {
          const objects = await OrgMetadataCache.getObjectList(sourceOrg || null);
          panel.webview.postMessage({ command: "objectList", sourceOrg, objects });
        } catch (e) {
          panel.webview.postMessage({
            command: "objectList",
            sourceOrg,
            objects: [],
            error: e instanceof Error ? e.message : String(e)
          });
        }
        return;
      }

      // ── Webview error surfacing ───────────────────────────────────────────
      if (msg.command === "logError") {
        Logger.error(`DataMigration webview: ${msg.text ?? ""}`);
        return;
      }

      // ── Refresh cache ─────────────────────────────────────────────────────
      if (msg.command === "refreshCache") {
        const { sourceOrg, targetOrg } = msg;
        const orgToRefresh = sourceOrg || null;
        AuthInfo.invalidateOrg(orgToRefresh);
        SchemaCache.invalidate(orgToRefresh);
        if (targetOrg && targetOrg !== sourceOrg) {
          AuthInfo.invalidateOrg(targetOrg || null);
          SchemaCache.invalidate(targetOrg || null);
        }
        const orgs = await refreshOrgListCache();
        panel.webview.postMessage({ command: "cacheRefreshed", orgs });
        return;
      }

      // ── Discover root object ──────────────────────────────────────────────
      if (msg.command === "discoverRoot") {
        const { sourceOrg = "", targetOrg = "", soql = "" } = msg;
        if (!sourceOrg || !soql.trim()) {
          panel.webview.postMessage({ command: "discoverError", error: "Source org and SOQL query are required." });
          return;
        }
        panel.webview.postMessage({ command: "discoverProgress", message: "Resolving org credentials…" });
        try {
          const rootSObject = extractSObjectFromQuery(soql);
          panel.webview.postMessage({ command: "discoverProgress", message: `Describing ${rootSObject} in source & target…` });
          const compareTarget = targetOrg && targetOrg !== sourceOrg;
          const [describe, orgInfo, targetDescribe] = await Promise.all([
            SchemaCache.getRichDescribe(sourceOrg || null, rootSObject),
            resolveOrgToInfo(sourceOrg || null),
            compareTarget ? SchemaCache.getRichDescribe(targetOrg || null, rootSObject) : Promise.resolve(null)
          ]);
          if (!describe) throw new Error(`Could not describe ${rootSObject} — check org credentials and object API name.`);
          const count = await countQuery(orgInfo, soql);
          const creatableFields = getCreatableFields(describe);
          const { available, excluded } = partitionFieldsByTarget(creatableFields, compareTarget ? targetDescribe : null);
          panel.webview.postMessage({
            command: "rootDiscovered",
            sobject: rootSObject,
            label: describe.label,
            count,
            fields: available,
            excludedFields: excluded,
            targetMissing: compareTarget && !targetDescribe ? true : false,
            externalIdFields: externalIdCandidates(creatableFields, excluded),
            childRelationships: describe.childRelationships
              .filter((cr) => cr.childSObject && cr.field)
              .map((cr) => ({ childSObject: cr.childSObject, field: cr.field, relationshipName: cr.relationshipName }))
          });
        } catch (e) {
          panel.webview.postMessage({ command: "discoverError", error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── Describe a child object ───────────────────────────────────────────
      if (msg.command === "describeChild") {
        const { sourceOrg = "", targetOrg = "", sobject = "" } = msg;
        if (!sourceOrg || !sobject) return;
        try {
          const compareTarget = targetOrg && targetOrg !== sourceOrg;
          const [describe, targetDescribe] = await Promise.all([
            SchemaCache.getRichDescribe(sourceOrg || null, sobject),
            compareTarget ? SchemaCache.getRichDescribe(targetOrg || null, sobject) : Promise.resolve(null)
          ]);
          if (!describe) throw new Error(`Could not describe ${sobject}`);
          const creatableFields = getCreatableFields(describe);
          const { available, excluded } = partitionFieldsByTarget(creatableFields, compareTarget ? targetDescribe : null);
          panel.webview.postMessage({
            command: "childDescribed",
            sobject,
            label: describe.label,
            fields: available,
            excludedFields: excluded,
            targetMissing: compareTarget && !targetDescribe ? true : false,
            externalIdFields: externalIdCandidates(creatableFields, excluded),
            childRelationships: describe.childRelationships
              .filter((cr) => cr.childSObject && cr.field)
              .map((cr) => ({ childSObject: cr.childSObject, field: cr.field, relationshipName: cr.relationshipName }))
          });
        } catch (e) {
          panel.webview.postMessage({ command: "describeChildError", sobject, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── Validate the profile (runs when the overview screen opens) ────────
      // Findings belong on screen, where they can be read and acted on, not in a modal thrown
      // up after the user has already committed to starting.
      if (msg.command === "validate") {
        const { sourceOrg = "", profile } = msg;
        if (!profile) return;
        try {
          const srcOrg = await resolveOrgToInfo(sourceOrg || null);
          const refMeta = new Map<string, Map<string, string[]>>();
          for (const node of profile.nodes) {
            if (refMeta.has(node.sobject)) continue;
            try {
              const desc = await describeObject(srcOrg, node.sobject);
              const m = new Map<string, string[]>();
              for (const f of desc.fields) if (f.referenceTo?.length) m.set(f.name, f.referenceTo);
              refMeta.set(node.sobject, m);
            } catch { /* the engine describes again — a describe failure must not block the screen */ }
          }
          const unmapped = findUnmappedLookups(profile.nodes, refMeta);
          panel.webview.postMessage({
            command: "validated",
            unmapped,
            missingObjects: [...new Set(unmapped.flatMap((u) => u.referenceTo))].sort()
          });
        } catch (e) {
          panel.webview.postMessage({ command: "validated", unmapped: [], missingObjects: [], error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── Run migration ─────────────────────────────────────────────────────
      if (msg.command === "runMigration") {
        const { sourceOrg = "", targetOrg = "", profile } = msg;
        if (!sourceOrg || !targetOrg || !profile) {
          panel.webview.postMessage({ command: "migrationError", error: "Source org, target org, and profile are required." });
          return;
        }
        if (sourceOrg === targetOrg) {
          panel.webview.postMessage({ command: "migrationError", error: "Source and target org must be different." });
          return;
        }
        // Writing records into production (or a Dev Hub) is confirmed explicitly — the revert is
        // best-effort, so the guard belongs before the first record is written, not after.
        if (!(await confirmProductionOrgOperation("migrate records into", targetOrg))) {
          panel.webview.postMessage({ command: "migrationError", error: "Migration cancelled — target org is production." });
          return;
        }
        try {
          Telemetry.event("dataMigration");
          panel.webview.postMessage({ command: "migrationStarted" });
          const [srcOrg, tgtOrg] = await Promise.all([
            resolveOrgToInfo(sourceOrg || null),
            resolveOrgToInfo(targetOrg || null)
          ]);

          // Validation already ran on the overview screen (the `validate` command) and its
          // findings are on display there — re-asking in a modal at this point would be telling
          // the user something they just read and acted on by pressing Start.
          const retryOpts = msg.retry
            ? { retryOnly: msg.retry.retryOnly, priorIdMaps: msg.retry.priorIdMaps }
            : undefined;
          const { results, idMaps, journal } = await runMigration(srcOrg, tgtOrg, profile, (progress: MigrationProgress) => {
            panel.webview.postMessage({ command: "migrationProgress", progress });
          }, retryOpts);
          Logger.info(`Migration complete: ${results.map((r) => `${r.sobject}: +${r.inserted} ^${r.updated} x${r.failed}`).join(", ")}`);
          const failedTotal = results.reduce((n, r) => n + r.failed, 0);
          const order: string[] = profile.nodes.map((n: { sobject: string }) => n.sobject);
          // Keep the journal host-side: it is what a later "Revert this run" acts on, and it must
          // not depend on the webview holding on to it.
          lastRun = { org: targetOrg, orgInfo: tgtOrg, order, journal };
          const counts = countJournal(journal);
          panel.webview.postMessage({
            command: "migrationComplete",
            results, idMaps, journal,
            canRevert: counts.inserted + counts.restorable > 0,
            revertCounts: counts,
            targetInstanceUrl: tgtOrg.instanceUrl,
            sourceInstanceUrl: srcOrg.instanceUrl
          });

          // Revert on failure. Ticking the box IS the decision — asking again at the moment it
          // fires would make the setting mean nothing.
          if (msg.revertOnFail && failedTotal > 0 && counts.inserted + counts.restorable > 0) {
            Logger.info(
              `Revert on failure: ${failedTotal} record(s) failed — undoing the run ` +
              `(${counts.inserted} to delete, ${counts.restorable} to restore).`
            );
            lastRun = null; // consumed — the journal describes a state that no longer exists
            await performRevert(panel, tgtOrg, order, journal, targetOrg);
          }
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          Logger.error("Migration failed", e);
          panel.webview.postMessage({ command: "migrationError", error: err.substring(0, 600) });
        }
        return;
      }

      // ── Revert the last run ───────────────────────────────────────────────
      if (msg.command === "revertRun") {
        if (!lastRun) {
          panel.webview.postMessage({ command: "revertError", error: "Nothing to revert — no migration has run in this panel." });
          return;
        }
        // A selection narrows the journal to the records the user ticked; no selection means the
        // whole run. Filtering the journal (rather than passing Ids through) keeps the guarantee
        // that a revert can only touch rows this run actually wrote.
        const picked = filterJournal(lastRun.journal, msg.selection ?? null);
        const counts = countJournal(picked);
        if (counts.inserted + counts.restorable === 0) {
          panel.webview.postMessage({ command: "revertError", error: "Nothing selected to revert." });
          return;
        }
        const partial = msg.selection ? countJournal(lastRun.journal) : null;
        const isPartial = !!partial && (partial.inserted !== counts.inserted || partial.restorable !== counts.restorable);
        const choice = await vscode.window.showWarningMessage(
          isPartial
            ? `Undo the selected records from the last migration into ${lastRun.org}?`
            : `Undo the last migration into ${lastRun.org}?`,
          { modal: true, detail: revertDetail(counts) },
          isPartial ? "Revert selected" : "Revert this run"
        );
        if (!choice) return;
        const run = lastRun;
        // A partial revert leaves the rest of the run in place, so the journal is still valid for
        // it — drop only what was just undone. A full revert consumes the journal entirely.
        const remaining = isPartial ? subtractJournal(run.journal, picked) : null;
        lastRun = remaining ? { ...run, journal: remaining } : null;
        await performRevert(panel, run.orgInfo, run.order, picked, run.org, remaining);
        return;
      }

      // ── Export instead of migrate (Apex / CSV / JSON) ─────────────────────
      // The same selection and the same rules, written to a file rather than into a second org.
      // No target org is involved, so no production guard applies — nothing is written anywhere
      // but the user's own workspace.
      if (msg.command === "exportMigration") {
        const { sourceOrg = "", profile, format = "json" } = msg;
        if (!sourceOrg || !profile) {
          panel.webview.postMessage({ command: "migrationError", error: "Source org and a configured object tree are required." });
          return;
        }
        try {
          Telemetry.event("dataMigrationExport");
          panel.webview.postMessage({ command: "migrationStarted" });
          const srcOrg = await resolveOrgToInfo(sourceOrg || null);

          // Describe first: the external Id fields have to be known before the records are read,
          // because a lookup can only be written as `Account = new Account(Ext__c = 'E1')` if the
          // export actually carries that field's value.
          const meta: ExportFieldMeta = new Map();
          for (const node of profile.nodes) {
            const desc = await SchemaCache.getRichDescribe(sourceOrg || null, node.sobject);
            const m = new Map<string, { type: string; referenceTo: string[]; relationshipName?: string | null; externalId?: boolean; unique?: boolean }>();
            for (const f of desc?.fields ?? []) {
              m.set(f.name, {
                type: f.type, referenceTo: f.referenceTo ?? [], relationshipName: f.relationshipName,
                externalId: f.externalId, unique: f.unique
              });
            }
            meta.set(node.sobject, m);
          }

          // Pull in each object's external Id fields even when the user did not tick them. They
          // cost one column and they are what lets every lookup between exported objects resolve
          // by key instead of by a variable that does not survive the next execution.
          const exportProfile: MigrationProfile = {
            ...profile,
            nodes: profile.nodes.map((node) => {
              const extras = [...(meta.get(node.sobject) ?? new Map())]
                .filter(([name, f]) => f.externalId && !node.includeFields.includes(name))
                .map(([name]) => name);
              return extras.length ? { ...node, includeFields: [...node.includeFields, ...extras] } : node;
            })
          };

          const data = await collectMigrationData(srcOrg, exportProfile, (sobject, fetched) => {
            panel.webview.postMessage({
              command: "migrationProgress",
              progress: { sobject, phase: "querying", mode: "export", records: fetched, done: fetched, total: 0, inserted: 0, updated: 0, failed: 0 }
            });
          });
          // Nothing is written for a file output, so no later phase would ever close these rows —
          // without this they spin forever on a finished export.
          for (const d of data) {
            panel.webview.postMessage({
              command: "migrationProgress",
              progress: {
                sobject: d.sobject, phase: "done", mode: "export", records: d.records.length,
                done: d.records.length, total: d.records.length, inserted: 0, updated: 0, failed: 0
              }
            });
          }

          const stamp = new Date().toISOString();
          const safeName = (profile.name || "migration").replace(/[^a-zA-Z0-9_-]/g, "_");
          const outDir = path.join(workspaceRoot, ".sfdx", "asfx", "exports");

          if (format === "csv") {
            const uri = await vscode.window.showOpenDialog({
              canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
              defaultUri: vscode.Uri.file(outDir), title: "Choose a folder for the CSV files", openLabel: "Export here"
            });
            if (!uri?.length) { panel.webview.postMessage({ command: "exportCancelled" }); return; }
            const files = toCsvExports(data, (sobject) => {
              const node = exportProfile.nodes.find((n: { sobject: string }) => n.sobject === sobject);
              return ["Id", ...(node?.includeFields ?? []).filter((f: string) => f !== "Id")];
            });
            fs.mkdirSync(uri[0].fsPath, { recursive: true });
            for (const f of files) fs.writeFileSync(path.join(uri[0].fsPath, f.fileName), f.content, "utf8");
            const total = data.reduce((n, d) => n + d.records.length, 0);
            panel.webview.postMessage({
              command: "exportComplete", format,
              summary: `${files.length} CSV file(s), ${total} record(s) → ${uri[0].fsPath}`
            });
            vscode.window.showInformationMessage(`Exported ${files.length} CSV file(s) to ${uri[0].fsPath}`);
            return;
          }

          const total = data.reduce((n, d) => n + d.records.length, 0);

          if (format === "apex") {
            // Split to the Execute Anonymous window, so what lands on disk can actually be pasted.
            const parts = toApexParts(exportProfile, data, meta, stamp, APEX_CONSOLE_MAX_CHARS);
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(outDir, `${safeName}.apex`)),
              filters: { "Anonymous Apex": ["apex", "cls"] },
              title: parts.length > 1 ? `Save the generated Apex (${parts.length} parts)` : "Save the generated Apex script"
            });
            if (!uri) { panel.webview.postMessage({ command: "exportCancelled" }); return; }
            fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
            const ext = path.extname(uri.fsPath) || ".apex";
            const stem = uri.fsPath.slice(0, uri.fsPath.length - ext.length);
            const written = parts.map((p) => {
              const file = parts.length === 1 ? uri.fsPath : `${stem}.part${p.index}${ext}`;
              fs.writeFileSync(file, p.content, "utf8");
              return file;
            });
            const oversized = parts.filter((p) => p.oversize);
            for (const p of oversized) {
              Logger.info(`Apex export part ${p.index} is ${p.chars} chars, over the Execute Anonymous window. ${p.oversizeReason ?? ""}`);
            }
            panel.webview.postMessage({
              command: "exportComplete", format,
              summary: `${total} record(s) → ${written.length === 1 ? path.basename(written[0]) : `${written.length} parts, run them in order`}` +
                       (oversized.length ? ` — ${oversized.length} part(s) exceed the Execute Anonymous window, use \`sf apex run --file\`` : "")
            });
            if (oversized.length) {
              vscode.window.showWarningMessage(
                `${oversized.length} part(s) are larger than the Execute Anonymous window. ` +
                `Run them with \`sf apex run --file\`, or export CSV/JSON instead. ` +
                (oversized[0].oversizeReason ?? "")
              );
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(written[0]));
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
          }

          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(outDir, `${safeName}.json`)),
            filters: { JSON: ["json"] },
            title: "Save the exported records"
          });
          if (!uri) { panel.webview.postMessage({ command: "exportCancelled" }); return; }
          fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
          fs.writeFileSync(uri.fsPath, toJsonExport(exportProfile, data, stamp), "utf8");
          panel.webview.postMessage({
            command: "exportComplete", format,
            summary: `${total} record(s) across ${data.length} object(s) → ${path.basename(uri.fsPath)}`
          });
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: false });
          return;
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          Logger.error("Migration export failed", e);
          panel.webview.postMessage({ command: "migrationError", error: err.substring(0, 600) });
        }
        return;
      }

      // ── Save profile ──────────────────────────────────────────────────────
      if (msg.command === "saveProfile") {
        const { profile, name = "migration" } = msg;
        if (!profile) return;
        const safeName = (name || "migration").replace(/[^a-zA-Z0-9_-]/g, "_");
        const defaultPath = path.join(workspaceRoot, ".sfdx", "asfx", `${safeName}.migration.json`);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultPath),
          filters: { "Migration profile": ["json"] },
          title: "Save Migration Profile"
        });
        if (!uri) return;
        try {
          saveProfile(profile, uri.fsPath);
          panel.webview.postMessage({ command: "profileSaved", filePath: uri.fsPath, fileName: path.basename(uri.fsPath) });
          vscode.window.showInformationMessage(`Migration profile saved: ${path.basename(uri.fsPath)}`);
        } catch (e) {
          vscode.window.showErrorMessage(`Could not save profile: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      // ── Load profile ──────────────────────────────────────────────────────
      if (msg.command === "loadProfile") {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { "Migration profile": ["json"] },
          title: "Load Migration Profile",
          defaultUri: vscode.Uri.file(path.join(workspaceRoot, ".sfdx", "asfx"))
        });
        if (!uris?.length) return;
        try {
          const profile = loadProfileFromFile(uris[0].fsPath);
          panel.webview.postMessage({ command: "profileLoaded", profile, fileName: path.basename(uris[0].fsPath) });
        } catch (e) {
          vscode.window.showErrorMessage(`Could not load profile: ${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }

      // ── Open file ─────────────────────────────────────────────────────────
      if (msg.command === "openFile") {
        const fp = (msg as { command: string; filePath?: string }).filePath;
        if (fp && fs.existsSync(fp)) void vscode.window.showTextDocument(vscode.Uri.file(fp));
        return;
      }
    });
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private static getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; min-height: 100vh; }

/* ── Page header ── */
.page-header { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); flex-shrink: 0; display: flex; align-items: center; gap: 10px; }
.page-title { font-size: 13px; font-weight: 700; letter-spacing: .02em; }

/* ── Steps bar ── */
.steps-bar { display: flex; align-items: stretch; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; background: var(--vscode-editor-background); }
.step-item { display: flex; align-items: center; gap: 8px; padding: 9px 18px; font-size: 12px; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); cursor: default; user-select: none; transition: color .1s; }
.step-item.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-button-background); font-weight: 600; }
.step-item.done { color: #4ec94e; }
.step-num { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; background: var(--vscode-button-secondaryBackground, #444); color: var(--vscode-foreground); flex-shrink: 0; }
.step-item.active .step-num { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.step-item.done .step-num { background: #4ec94e22; color: #4ec94e; }
.step-arrow { color: var(--vscode-descriptionForeground); font-size: 10px; padding: 0 2px; }

/* ── Pages ── */
.page { display: none; flex: 1; flex-direction: column; overflow-y: auto; }
.page.active { display: flex; }

/* ── Shared form styles ── */
.form-section { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 700px; }
.field-block { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.form-select, .form-input { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: inherit; outline: none; }
.form-select:focus, .form-input:focus { border-color: var(--vscode-focusBorder); }
.form-textarea { padding: 7px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); outline: none; resize: vertical; min-height: 70px; }
.form-textarea:focus { border-color: var(--vscode-focusBorder); }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.btn-primary { padding: 8px 16px; font-size: 13px; font-weight: 600; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-family: inherit; }
.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.btn-secondary { padding: 6px 12px; font-size: 12px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border); border-radius: 3px; cursor: pointer; font-family: inherit; opacity: .8; }
.btn-secondary:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.btn-danger { padding: 6px 12px; font-size: 12px; background: transparent; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-errorForeground); border-radius: 3px; cursor: pointer; font-family: inherit; opacity: .8; }
.btn-danger:hover { opacity: 1; }
.btn-refresh { padding: 4px 8px; font-size: 11px; background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid transparent; border-radius: 3px; cursor: pointer; font-family: inherit; opacity: .7; transition: opacity .1s; }
.btn-refresh:hover { opacity: 1; background: var(--vscode-list-hoverBackground); border-color: var(--vscode-panel-border); }
.btn-refresh.spinning { pointer-events: none; opacity: .6; }
.btn-refresh.spinning .spin-icon { display: inline-block; animation: spin .8s linear infinite; }
.cache-status { font-size: 10px; color: var(--vscode-descriptionForeground); align-self: center; }
.divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
.status-bar { padding: 8px 12px; border-radius: 3px; font-size: 12px; font-weight: 500; border-left: 3px solid transparent; display: none; }
.status-bar.running { display: block; border-left-color: var(--vscode-progressBar-background); background: color-mix(in srgb, var(--vscode-progressBar-background) 12%, transparent); }
.status-bar.error   { display: block; border-left-color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); color: var(--vscode-errorForeground); }
.status-bar.success { display: block; border-left-color: #4ec94e; background: color-mix(in srgb, #4ec94e 12%, transparent); }
.spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Page 2: Tree ── */
.tree-page { padding: 0; }
.tree-toolbar { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; background: var(--vscode-sideBarSectionHeader-background); }
.tree-toolbar .profile-name { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); flex: 1; }
.tree-area { flex: 1; overflow-y: auto; padding: 10px 0; }

/* ── Object node ── */
.obj-node { margin-bottom: 4px; }
.obj-card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); }
.obj-node.included > .obj-card { border-left: 3px solid var(--vscode-button-background); }
.obj-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; user-select: none; transition: background .1s; border-radius: 7px; }
.obj-header:hover { background: var(--vscode-list-hoverBackground); }
.obj-header input[type="checkbox"] { cursor: pointer; flex-shrink: 0; width: 15px; height: 15px; accent-color: var(--vscode-button-background); }
.obj-chevron { font-size: 10px; width: 12px; flex-shrink: 0; color: var(--vscode-descriptionForeground); cursor: pointer; }
.obj-icon { font-size: 14px; flex-shrink: 0; }
.obj-name { font-weight: 600; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-sub { font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); flex-shrink: 0; }
.obj-lookup { font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; flex-shrink: 0; }
.count-badge { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 9px; background: color-mix(in srgb, var(--vscode-button-background) 20%, transparent); color: var(--vscode-button-background); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.count-badge.loading { opacity: .5; }
.node-remove { flex-shrink: 0; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: transparent; color: var(--vscode-descriptionForeground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.node-remove:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-errorForeground); }
.obj-body { padding: 4px 14px 12px 38px; display: none; flex-direction: column; gap: 12px; }
.obj-body.open { display: flex; }

/* ── Field list inside node ── */
.field-section { display: flex; flex-direction: column; gap: 6px; }
.field-section-head { display: flex; align-items: center; gap: 8px; }
.excluded-section .field-section-head:hover { opacity: .85; }
.excluded-list { border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 35%, var(--vscode-panel-border)); border-radius: 6px; max-height: 160px; overflow-y: auto; background: color-mix(in srgb, var(--vscode-errorForeground) 6%, transparent); }
.excluded-row { display: flex; align-items: baseline; gap: 10px; padding: 3px 8px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border); }
.excluded-row:last-child { border-bottom: none; }
.excluded-row .fname { font-family: var(--vscode-editor-font-family, monospace); min-width: 160px; }
.excluded-reason { color: var(--vscode-descriptionForeground); font-style: italic; }
.field-section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.field-count { font-size: 10px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.field-spacer { flex: 1; }
.field-search { padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; font-size: 11px; font-family: inherit; outline: none; width: 150px; }
.field-search:focus { border-color: var(--vscode-focusBorder); }
.ext-id-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ext-id-row label { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.ext-id-row select { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; font-size: 11px; font-family: inherit; outline: none; flex: 1; max-width: 280px; }
.fields-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 1px 10px; max-height: 220px; overflow-y: auto; padding: 6px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; }
.field-check { display: flex; align-items: center; gap: 7px; font-size: 11px; cursor: pointer; padding: 3px 5px; border-radius: 4px; overflow: hidden; }
.field-check:hover { background: var(--vscode-list-hoverBackground); }
.field-check input { cursor: pointer; flex-shrink: 0; accent-color: var(--vscode-button-background); }
.field-check .fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); flex: 1; }
.field-check .ftype { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); padding: 1px 4px; border-radius: 3px; flex-shrink: 0; }
.btn-tiny { font-size: 10px; padding: 3px 9px; background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.35))); border-radius: 4px; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-family: inherit; }
.btn-tiny:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }

/* ── Related-object searchable combo ── */
.rel-section { display: flex; flex-direction: column; gap: 6px; max-width: 520px; }
.rel-section-inner { display: flex; flex-direction: column; gap: 6px; }
.rel-search { width: 100%; padding: 7px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 6px; font-size: 12px; font-family: inherit; outline: none; }
.rel-search:focus { border-color: var(--vscode-focusBorder); }
/* In-flow results list (NOT an overlay) — guaranteed clickable, like the field checkboxes.
   Shown only while the search box is focused; hidden otherwise. */
.rel-list { display: none; max-height: 200px; overflow-y: auto; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-input-background); }
.rel-list.show { display: block; }
.rel-opt { padding: 7px 10px; font-size: 12px; cursor: pointer; display: flex; align-items: baseline; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.rel-opt:last-child { border-bottom: none; }
.rel-opt:hover { background: var(--vscode-list-hoverBackground); }
.rel-opt .ro-name { font-weight: 600; }
.rel-opt .ro-sobject { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); font-size: 11px; }
.rel-opt .ro-via { margin-left: auto; font-style: italic; color: var(--vscode-descriptionForeground); font-size: 10px; flex-shrink: 0; }
.rel-combo-empty { padding: 8px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ── Children subtree (indented) ── */
.children-subtree { margin-left: 22px; margin-top: 6px; padding-left: 10px; border-left: 1px dashed var(--vscode-panel-border); display: flex; flex-direction: column; gap: 6px; }

/* ── Page 3: Run ── */
.run-page { padding: 0; flex-direction: column; }
.run-toolbar { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; background: var(--vscode-sideBarSectionHeader-background); }
.run-area { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.run-overview { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); padding: 12px 14px; }
.ov-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.ov-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
.ov-orgs { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
.ov-summary { font-size: 12px; color: var(--vscode-foreground); margin-bottom: 8px; font-variant-numeric: tabular-nums; }
.ov-note { margin-top: 10px; font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
.run-summary { display: flex; flex-wrap: wrap; gap: 16px; padding: 10px 12px; border-radius: 3px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); font-size: 12px; }
.run-stat { display: flex; flex-direction: column; gap: 2px; }
.run-stat-num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.run-stat-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); }
.stat-ins { color: #4ec94e; }
.stat-upd { color: var(--vscode-textLink-foreground); }
.stat-fail { color: var(--vscode-errorForeground); }

/* ── Per-object row ── */
/* One row per object: what is planned and what is happening, on the same line. */
.obj-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 10px; border-radius: 3px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); }
.obj-line { display: flex; align-items: baseline; gap: 12px; font-size: 12px; }
.obj-progress-icon { font-size: 13px; flex-shrink: 0; align-self: center; }
.obj-name { font-weight: 600; min-width: 170px; }
.obj-api { font-weight: 400; font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; color: var(--vscode-descriptionForeground); }
.obj-count { min-width: 110px; font-variant-numeric: tabular-nums; color: var(--vscode-textLink-foreground); font-weight: 600; }
.obj-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
.obj-link { color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; font-family: var(--vscode-editor-font-family, monospace); margin-left: auto; }
.obj-progress-phase { font-size: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: .04em; min-width: 62px; text-align: right; }
.obj-progress-counts { font-size: 11px; display: flex; gap: 8px; min-width: 92px; justify-content: flex-end; font-variant-numeric: tabular-nums; }
.obj-progress-counts .ok { color: #4ec94e; }
.obj-progress-counts .upd { color: var(--vscode-textLink-foreground); }
.obj-progress-counts .err { color: var(--vscode-errorForeground); }
.progress-track { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--vscode-progressBar-background); border-radius: 2px; transition: width .3s; }
.errors-toggle { font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; margin-top: 2px; display: none; }
.errors-toggle:hover { text-decoration: underline; }
.errors-detail { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); max-height: 320px; overflow-y: auto; background: color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent); border-radius: 2px; padding: 6px 8px; display: none; }
.errors-detail.open { display: block; }
.err-group { margin-bottom: 6px; }
.err-count { font-weight: 700; color: var(--vscode-errorForeground); margin-bottom: 2px; }
.err-line { color: var(--vscode-errorForeground); padding: 1px 0; }
/* Expected omissions (Owner, Record Type, audit fields) — stated, not flagged as a problem. */
.note-group { margin-bottom: 6px; background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); border-radius: 2px; padding: 4px 6px; }
.note-count { font-weight: 700; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
.note-line { color: var(--vscode-descriptionForeground); padding: 1px 0; }
.global-error { padding: 10px 12px; border-radius: 3px; border-left: 3px solid var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); font-size: 12px; color: var(--vscode-errorForeground); display: none; }
.global-error.visible { display: block; }

.no-target { padding: 5px 0; font-size: 12px; color: var(--vscode-descriptionForeground); font-style: italic; }
.run-type { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 3px 8px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); color: var(--vscode-descriptionForeground); }

/* ── Pre-run validation, shown on the overview screen ── */
.valid-card { margin-top: 12px; border-radius: 8px; padding: 10px 14px; font-size: 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.valid-card.checking { color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 8px; }
.valid-card.ok { color: var(--vscode-charts-green, #3fb950); border-left: 3px solid var(--vscode-charts-green, #3fb950); }
.valid-card.warn { border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 8%, transparent); }
.valid-title { font-weight: 700; color: var(--vscode-editorWarning-foreground, #cca700); }
.valid-sub { color: var(--vscode-descriptionForeground); margin-top: 2px; line-height: 1.5; }
.valid-list { margin: 6px 0 0; padding-left: 18px; line-height: 1.7; }
.valid-list code { font-family: var(--vscode-editor-font-family, monospace); }
.valid-fix { margin-top: 6px; color: var(--vscode-descriptionForeground); }

/* ── Overwritten-records table (what a revert would put back) ── */
.changes-card { margin-top: 14px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); overflow: hidden; }
.changes-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.changes-bar { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 8px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px 8px 0 0; border-bottom: none; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); }
.changes-bar-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.changes-bar-sub { flex: 1; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.changes-bar + .changes-card { margin-top: 0; border-radius: 0 0 8px 8px; }
.changes-head .sub { flex: 1; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--vscode-descriptionForeground); }
table.changes th.pick, table.changes td.pick { width: 28px; text-align: center; padding-left: 8px; padding-right: 0; }
table.changes .pick input { margin: 0; cursor: pointer; }
.diff-line { padding: 1px 0; white-space: nowrap; }
.diff-field { color: var(--vscode-descriptionForeground); }
.diff-none { color: var(--vscode-descriptionForeground); font-style: italic; }
.changes-scroll { max-height: 380px; overflow: auto; }
table.changes { width: 100%; border-collapse: collapse; font-size: 11px; }
table.changes th { position: sticky; top: 0; text-align: left; font-weight: 600; padding: 6px 10px; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); white-space: nowrap; }
table.changes td { padding: 4px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 8%, transparent); vertical-align: top; font-family: var(--vscode-editor-font-family, monospace); }
table.changes td.was { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
table.changes a { color: var(--vscode-textLink-foreground); text-decoration: none; }
table.changes a:hover { text-decoration: underline; }
.changes-card + .changes-card { margin-top: 10px; }
table.changes .st-updated { color: var(--vscode-charts-green, #3fb950); }
table.changes .st-failed { color: var(--vscode-errorForeground); }
.changes-more { padding: 8px 14px; font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ── Step 1 builder: cards ── */
.card { background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.card-head { display: flex; align-items: center; gap: 8px; }
.card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-foreground); }
.card-sub { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
.card-head .spacer { flex: 1; }

/* ── Segmented toggle (Basic | Advanced) ── */
.segmented { display: inline-flex; border: 1px solid var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.35))); border-radius: 999px; overflow: hidden; background: var(--vscode-input-background); }
.segmented button { padding: 4px 14px; font-size: 11px; font-weight: 600; background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; font-family: inherit; opacity: .7; transition: background .1s, opacity .1s; }
.segmented button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }

/* ── Searchable combo (root object picker) ── */
.combo { position: relative; }
.combo-input { width: 100%; padding: 8px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; font-size: 13px; font-family: inherit; outline: none; }
.combo-input:focus { border-color: var(--vscode-focusBorder); }
.combo-input:disabled { opacity: .5; cursor: not-allowed; }
.combo-list { position: absolute; left: 0; right: 0; top: calc(100% + 3px); z-index: 50; max-height: 280px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; box-shadow: 0 6px 18px rgba(0,0,0,0.35); display: none; }
.combo-list.open { display: block; }
.combo-opt { padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); display: flex; align-items: center; gap: 8px; }
.combo-opt:hover, .combo-opt.active { background: var(--vscode-list-hoverBackground); }
.combo-opt.selected { color: var(--vscode-button-background); font-weight: 700; }
.combo-empty { padding: 8px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.combo-more { padding: 5px 10px; font-size: 10px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }

/* ── Root summary ── */
.root-summary { display: none; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-button-background) 35%, transparent); font-size: 12px; }
.root-summary.visible { display: flex; }
.root-summary.describing { background: color-mix(in srgb, var(--vscode-progressBar-background) 12%, transparent); border-color: color-mix(in srgb, var(--vscode-progressBar-background) 35%, transparent); }
.root-summary.error { background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
.root-summary .rs-name { font-weight: 700; }
.root-summary .rs-meta { color: var(--vscode-descriptionForeground); }

/* ── Filter rows ── */
.filters-block { display: flex; flex-direction: column; gap: 8px; }
.filters-block.disabled { opacity: .45; pointer-events: none; }
.filter-row { display: flex; align-items: center; gap: 6px; }
.filter-row select, .filter-row input { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; font-size: 12px; font-family: inherit; outline: none; }
.filter-row select:focus, .filter-row input:focus { border-color: var(--vscode-focusBorder); }
.filter-row .filter-field { flex: 2; min-width: 0; }
.filter-row .filter-op { flex: 0 0 70px; }
.filter-row .filter-val { flex: 2; min-width: 0; }
.filter-row .filter-remove { flex-shrink: 0; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid transparent; border-radius: 4px; cursor: pointer; font-size: 13px; }
.filter-row .filter-remove:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-errorForeground); }
.filters-empty { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }
.limit-row { display: flex; align-items: center; gap: 8px; }
.limit-row .form-input { width: 120px; }
.inline-add { align-self: flex-start; }
</style>
</head>
<body>

<div class="page-header">
  <span class="page-title">🔄 Data Migration Wizard</span>
</div>

<!-- Steps bar -->
<div class="steps-bar">
  <div class="step-item active" id="step1-indicator">
    <span class="step-num">1</span><span>Source &amp; Target</span>
  </div>
  <span class="step-arrow">›</span>
  <div class="step-item" id="step2-indicator">
    <span class="step-num">2</span><span>Object Tree</span>
  </div>
  <span class="step-arrow">›</span>
  <div class="step-item" id="step3-indicator">
    <span class="step-num">3</span><span>Overview</span>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════ PAGE 1 -->
<div class="page active" id="page1">
  <div class="form-section">

    <!-- Card: Orgs -->
    <div class="card">
      <div class="card-head">
        <span class="card-title">Source &amp; Target</span>
        <span class="spacer"></span>
        <button class="btn-refresh" id="refresh-cache-btn" title="Refresh org list &amp; metadata cache" onclick="refreshCache()"><span class="spin-icon">🔄</span> Refresh cache</button>
        <span class="cache-status" id="cache-status-label"></span>
      </div>
      <div style="display:flex; gap:12px; flex-wrap:wrap;">
        <div class="field-block" style="flex:1; min-width:180px;">
          <label class="field-label" for="migration-type">Migration type</label>
          <select class="form-select" id="migration-type" onchange="onMigrationTypeChange()">
            <option value="org">Org → Org</option>
            <option value="apex">Org → Apex script</option>
            <option value="csv">Org → CSV</option>
            <option value="json">Org → JSON</option>
          </select>
        </div>
        <div class="field-block" style="flex:1; min-width:180px;">
          <label class="field-label" for="src-org">Source org</label>
          <select class="form-select" id="src-org" onchange="onSourceOrgChange()"></select>
        </div>
        <div class="field-block" id="tgt-org-block" style="flex:1; min-width:180px;">
          <label class="field-label" for="tgt-org">Target org</label>
          <select class="form-select" id="tgt-org"></select>
        </div>
        <!-- Replaces the target-org picker for a file output: there is no second org involved. -->
        <div class="field-block" id="tgt-org-none" style="flex:1; min-width:180px; display:none;">
          <label class="field-label">Target org</label>
          <div class="no-target">Not needed — the records go to a file.</div>
        </div>
      </div>
    </div>

    <!-- Card: What to migrate -->
    <div class="card">
      <div class="card-head">
        <span class="card-title">What to migrate</span>
        <span class="spacer"></span>
        <div class="segmented" id="advanced-toggle" role="tablist" aria-label="Builder mode">
          <button type="button" id="mode-basic-btn" class="active" onclick="setMode('basic')">Builder</button>
          <button type="button" id="mode-advanced-btn" onclick="setMode('advanced')">Advanced</button>
        </div>
      </div>

      <!-- BASIC builder -->
      <div id="basic-panel" style="display:flex; flex-direction:column; gap:14px;">
        <div class="field-block">
          <label class="field-label" for="root-object-input">Root object</label>
          <div class="combo">
            <input type="text" class="combo-input" id="root-object-input" autocomplete="off" spellcheck="false"
              placeholder="Select source org first…" disabled
              oninput="onRootInput()" onfocus="openRootList()" onkeydown="onRootKeydown(event)" />
            <div class="combo-list" id="root-object-list"></div>
          </div>
          <span class="card-sub">Pick the object to migrate. All of its fields are selected by default — you'll fine-tune fields and related objects in the next step.</span>
        </div>

        <div class="root-summary" id="root-summary"></div>

        <div class="field-block">
          <label class="field-label">Filters <span style="font-weight:400; text-transform:none; opacity:.8;">(optional — all records migrate if empty)</span></label>
          <div class="filters-block disabled" id="filters-block">
            <div class="filters-empty" id="filters-empty">Select a root object to add filters.</div>
            <div id="filter-rows"></div>
            <button type="button" class="btn-tiny inline-add" id="add-filter-btn" onclick="addFilterRow()">+ Add filter</button>
          </div>
        </div>

        <div class="field-block">
          <label class="field-label" for="record-limit">Record limit <span style="font-weight:400; text-transform:none; opacity:.8;">(optional)</span></label>
          <div class="limit-row">
            <input type="number" class="form-input" id="record-limit" min="1" placeholder="e.g. 5000" oninput="syncSoqlFromBuilder()" />
            <span class="card-sub">Leave empty to migrate every matching record.</span>
          </div>
        </div>
      </div>

      <!-- ADVANCED raw SOQL -->
      <div id="advanced-panel" style="display:none;">
        <div class="field-block">
          <label class="field-label" for="src-soql">Source SOQL query (root object)</label>
          <textarea class="form-textarea" id="src-soql" rows="4"
            placeholder="SELECT Id, Name, BillingCity, BillingCountry FROM Account WHERE RecordType.DeveloperName = 'Commercial' LIMIT 5000"
            oninput="onSoqlEdited()"></textarea>
          <span class="hint">Full control. The <code>SELECT</code> list is replaced based on your field selection in the next step — <code>FROM</code>, <code>WHERE</code>, <code>ORDER BY</code> and <code>LIMIT</code> are preserved. Editing here overrides the builder.</span>
        </div>
      </div>
    </div>

    <!-- Card: Name + actions -->
    <div class="card">
      <div class="field-block">
        <label class="field-label" for="profile-name">Migration name</label>
        <input type="text" class="form-input" id="profile-name" placeholder="e.g. accounts-to-sandbox" style="max-width:280px;" />
      </div>

      <div class="status-bar" id="p1-status"></div>

      <div class="btn-row">
        <button class="btn-primary" id="configure-btn" onclick="goToTree()" disabled>Configure objects &amp; fields →</button>
        <button class="btn-secondary" onclick="loadProfile()">📂 Load Profile</button>
      </div>

      <div id="loaded-profile-bar" style="display:none; font-size:11px; color:var(--vscode-descriptionForeground);">
        Loaded: <span id="loaded-profile-name" style="font-family:var(--vscode-editor-font-family,monospace);"></span>
        &nbsp;·&nbsp;<a href="#" onclick="goToTree(); return false;" style="color:var(--vscode-textLink-foreground);">Review tree →</a>
      </div>
    </div>

  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════ PAGE 2 -->
<div class="page" id="page2">
  <div class="tree-toolbar">
    <button class="btn-secondary" onclick="goToSetup()">← Setup</button>
    <span class="profile-name" id="tree-title">Object tree</span>
    <button class="btn-secondary" onclick="saveProfile()">💾 Save Profile</button>
    <button class="btn-primary" id="run-btn" onclick="goToRun()">Overview →</button>
  </div>
  <div class="tree-area" id="tree-area">
    <div style="padding:20px; color:var(--vscode-descriptionForeground); font-size:12px;">Discovering relationships…</div>
  </div>
</div>

<!-- ════════════════════════════════════════════════════════════════ PAGE 3 -->
<div class="page" id="page3">
  <div class="run-toolbar">
    <button class="btn-secondary" id="back-to-tree-btn" onclick="goToTree()">← Adjust settings</button>
    <span class="run-type" id="run-type-label" title="Set on the Source &amp; Target step"></span>
    <span style="flex:1; font-size:12px; color:var(--vscode-descriptionForeground);" id="run-status-label">Ready to run</span>
    <label class="inline" style="font-size:12px;" title="If any record fails, offer to undo the whole run: delete the records it created and restore the records it overwrote to their previous values. Only rows this run touched are affected, and you are asked to confirm first."><input type="checkbox" id="revert-on-fail"> Revert on failure</label>
    <button class="btn-secondary" id="retry-failed-btn" onclick="retryFailed()" style="display:none;">⟳ Retry failed rows</button>
    <button class="btn-primary" id="start-run-btn" onclick="startMigration()">⚡ Start Migration</button>
  </div>
  <div class="run-area" id="run-area">
    <div id="run-overview" class="run-overview"></div>
    <div id="validation-panel"></div>
    <div class="global-error" id="global-error"></div>
    <div id="progress-list"></div>
    <div id="changes-table"></div>
  </div>
</div>

<script>
/* ══════════════════════════════════════════════════════════════════════════
   VS Code bridge
══════════════════════════════════════════════════════════════════════════ */
var vsc = null;
try { if (typeof acquireVsCodeApi !== 'undefined') vsc = acquireVsCodeApi(); } catch(e) {}
function post(msg) { try { if (vsc) vsc.postMessage(msg); } catch(e) {} }
function safeGet(id) { return document.getElementById(id); }
function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// A file output has no target org, so nothing is compared against one — otherwise fields would
// be excluded as "not present in target" for an org that is not part of the operation at all.
function tgtOrgVal() {
  if (migrationType() !== 'org') return '';
  var s = safeGet('tgt-org');
  return (s && s.value) || '';
}

/* ══════════════════════════════════════════════════════════════════════════
   Global state
══════════════════════════════════════════════════════════════════════════ */
var orgsData = [];
// Flat map: sobject -> node state
var nodes = {};         // sobject -> NodeState
var rootSObject = '';

// ── Step 1 builder state ──
var mode = 'basic';               // 'basic' | 'advanced'
var soqlManuallyEdited = false;   // true once user hand-edits the SOQL textarea
var objectListData = [];          // sorted sobject API names for current source org
var objectListOrg = null;         // org the object list belongs to
var objectListLoading = false;
var pendingRoot = '';             // root object selected, awaiting describe
var rootFieldDefs = [];           // [{name,label,type}] of described root, for filter dropdowns
var comboActiveIdx = -1;          // keyboard nav index in the combo list
var filterSeq = 0;                // unique id seq for filter rows
var orgRefreshedOnce = false;     // guard: auto-refresh empty org list only once
var lastIdMaps = {};              // sobject -> { srcId: targetId } from the last run (for retry)
var lastJournal = null;           // what the last run changed: { inserted: {...}, updated: {...} }
var targetInstanceUrl = '';       // target org base URL, so a new record Id links straight to it
var sourceInstanceUrl = '';       // source org base URL, for the source Ids in the result table
var lastFailed = {};              // sobject -> [srcId, …] that failed in the last run

/*
  NodeState {
    sobject, label,
    parentSObject (null for root),
    lookupField (null for root),
    count (null|number),
    included (bool),
    expanded (bool),
    described (bool),           // describe response received
    describeLoading (bool),
    fields: [{name, label, type, included, externalId}],
    externalIdField: null | string,
    childRelationships: [{childSObject, field, relationshipName}],
    children: [sobject strings],   // all known children sobjects for this parent
  }
*/

/* ══════════════════════════════════════════════════════════════════════════
   Step navigation
══════════════════════════════════════════════════════════════════════════ */
var currentPage = 1;
function showPage(n) {
  [1,2,3].forEach(function(i) {
    safeGet('page'+i) && safeGet('page'+i).classList.toggle('active', i===n);
    var ind = safeGet('step'+i+'-indicator');
    if (!ind) return;
    ind.classList.remove('active','done');
    if (i === n) ind.classList.add('active');
    else if (i < n) ind.classList.add('done');
  });
  currentPage = n;
}
function goToSetup() { showPage(1); }
function goToTree()  { renderTree(); showPage(2); }
function goToRun()   {
  if (!rootSObject) return;
  prepareRunPage();
  showPage(3);
  requestValidation();
}

/**
 * Validate on arrival at the overview, so problems are visible while there is still time to go
 * back and fix them — not raised in a modal once the user has already pressed Start.
 */
function requestValidation() {
  var host = safeGet('validation-panel');
  var profile = buildProfile();
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  if (!host || !profile || !srcOrg) return;
  host.innerHTML = '<div class="valid-card checking"><span class="spinner"></span> Checking lookups…</div>';
  post({ command: 'validate', sourceOrg: srcOrg, profile: profile });
}

function renderValidation(d) {
  var host = safeGet('validation-panel');
  if (!host) return;
  if (d.error) {
    host.innerHTML = '<div class="valid-card warn">⚠ Could not validate: ' + escHtml(d.error) +
                     ' — the migration can still run.</div>';
    return;
  }
  var unmapped = d.unmapped || [];
  if (!unmapped.length) {
    host.innerHTML = '<div class="valid-card ok">✅ Validation passed — every lookup in this selection can be re-linked.</div>';
    return;
  }
  var html = '<div class="valid-card warn">';
  html += '<div class="valid-title">⚠ ' + unmapped.length + ' lookup field(s) will be left empty</div>';
  html += '<div class="valid-sub">The object each one points at is not part of this migration, and a source Id never resolves in the target org.</div>';
  html += '<ul class="valid-list">';
  unmapped.forEach(function(u) {
    html += '<li><code>' + escHtml(u.sobject) + '.' + escHtml(u.field) + '</code> → ' +
            escHtml((u.referenceTo || []).join(' / ')) + '</li>';
  });
  html += '</ul>';
  if ((d.missingObjects || []).length) {
    html += '<div class="valid-fix">↳ Add ' + d.missingObjects.map(escHtml).join(', ') +
            ' on the Object Tree screen to keep ' + (unmapped.length > 1 ? 'these links' : 'this link') +
            ', or start the migration to accept them as empty.</div>';
  }
  html += '</div>';
  host.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════════════════
   Page 1 — Setup
══════════════════════════════════════════════════════════════════════════ */
function setStatus1(cls, msg) {
  var el = safeGet('p1-status');
  if (!el) return;
  el.className = 'status-bar ' + cls;
  el.innerHTML = (cls === 'running' ? '<span class="spinner"></span>' : '') + escHtml(msg);
}

function refreshCache() {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  var tgtOrg = safeGet('tgt-org') && safeGet('tgt-org').value;
  var btn = safeGet('refresh-cache-btn');
  var lbl = safeGet('cache-status-label');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  if (lbl) lbl.textContent = 'Refreshing…';
  post({ command: 'refreshCache', sourceOrg: srcOrg, targetOrg: tgtOrg });
}

function populateOrgSelects(orgs) {
  var srcSel = safeGet('src-org');
  var tgtSel = safeGet('tgt-org');
  var srcVal = srcSel && srcSel.value;
  var tgtVal = tgtSel && tgtSel.value;
  var opts = (orgs && orgs.length ? '' : '<option value="">No orgs found</option>')
    + (orgs||[]).map(function(o) { return '<option value="'+escHtml(o.username)+'">'+escHtml(o.label)+'</option>'; }).join('');
  if (srcSel) { srcSel.innerHTML = opts; if (srcVal) srcSel.value = srcVal; }
  if (tgtSel) { tgtSel.innerHTML = opts; if (tgtVal) tgtSel.value = tgtVal; else if (orgs && orgs.length > 1) tgtSel.value = orgs[1].username; }
  // Fetch the object list for whatever source org is now selected.
  if (srcSel && srcSel.value) requestObjectList();
}

/* ── Object list (root-object picker source) ── */
function requestObjectList() {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  var input = safeGet('root-object-input');
  if (!srcOrg) {
    objectListData = []; objectListOrg = null;
    if (input) { input.disabled = true; input.placeholder = 'Select source org first…'; }
    return;
  }
  if (objectListOrg === srcOrg && objectListData.length) { if (input) input.disabled = false; return; }
  objectListLoading = true;
  if (input) { input.disabled = true; input.placeholder = 'Loading objects…'; }
  post({ command: 'getObjectList', sourceOrg: srcOrg });
}

function onSourceOrgChange() {
  // Reset the builder when source org changes — describe state is org-specific.
  resetBuilderForOrgChange();
  requestObjectList();
}

function resetBuilderForOrgChange() {
  pendingRoot = ''; rootSObject = ''; rootFieldDefs = []; nodes = {};
  var input = safeGet('root-object-input'); if (input) input.value = '';
  var sum = safeGet('root-summary'); if (sum) { sum.className = 'root-summary'; sum.innerHTML = ''; }
  setFiltersEnabled(false);
  var rows = safeGet('filter-rows'); if (rows) rows.innerHTML = '';
  var soql = safeGet('src-soql'); if (soql) soql.value = '';
  soqlManuallyEdited = false;
  var cfg = safeGet('configure-btn'); if (cfg) cfg.disabled = true;
}

/* ── Searchable combo for root object ── */
function openRootList() { renderRootList(); var l = safeGet('root-object-list'); if (l) l.classList.add('open'); }
function closeRootList() { var l = safeGet('root-object-list'); if (l) l.classList.remove('open'); comboActiveIdx = -1; }
function onRootInput() { comboActiveIdx = -1; renderRootList(); var l = safeGet('root-object-list'); if (l) l.classList.add('open'); }

function filteredObjects() {
  var input = safeGet('root-object-input');
  var q = (input && input.value ? input.value : '').trim().toLowerCase();
  if (!q) return objectListData.slice(0, 50);
  return objectListData.filter(function(o) { return o.toLowerCase().indexOf(q) !== -1; }).slice(0, 50);
}

function renderRootList() {
  var list = safeGet('root-object-list');
  if (!list) return;
  if (objectListLoading) { list.innerHTML = '<div class="combo-empty">Loading objects…</div>'; return; }
  if (!objectListData.length) { list.innerHTML = '<div class="combo-empty">No objects available for this org.</div>'; return; }
  var matches = filteredObjects();
  if (!matches.length) { list.innerHTML = '<div class="combo-empty">No objects match.</div>'; return; }
  var total = (function() {
    var input = safeGet('root-object-input');
    var q = (input && input.value ? input.value : '').trim().toLowerCase();
    return q ? objectListData.filter(function(o){ return o.toLowerCase().indexOf(q) !== -1; }).length : objectListData.length;
  })();
  var html = matches.map(function(o, i) {
    var sel = (o === pendingRoot) ? ' selected' : '';
    var act = (i === comboActiveIdx) ? ' active' : '';
    return '<div class="combo-opt'+sel+act+'" data-obj="'+escHtml(o)+'" onmousedown="selectRoot(\\''+escHtml(o)+'\\')">'+escHtml(o)+'</div>';
  }).join('');
  if (total > matches.length) html += '<div class="combo-more">Showing '+matches.length+' of '+total+' — keep typing to narrow.</div>';
  list.innerHTML = html;
}

function onRootKeydown(e) {
  var matches = filteredObjects();
  if (e.key === 'ArrowDown') { e.preventDefault(); comboActiveIdx = Math.min(comboActiveIdx + 1, matches.length - 1); renderRootList(); openRootList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); comboActiveIdx = Math.max(comboActiveIdx - 1, 0); renderRootList(); }
  else if (e.key === 'Enter') { e.preventDefault(); var pick = comboActiveIdx >= 0 ? matches[comboActiveIdx] : matches[0]; if (pick) selectRoot(pick); }
  else if (e.key === 'Escape') { closeRootList(); }
}

function selectRoot(sobject) {
  if (!sobject) return;
  var input = safeGet('root-object-input');
  if (input) input.value = sobject;
  closeRootList();
  onRootObjectSelected(sobject);
}

/* Auto-describe on selection — no button. */
function onRootObjectSelected(sobject) {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  if (!srcOrg) { setStatus1('error', 'Select a source org first.'); return; }
  pendingRoot = sobject;
  soqlManuallyEdited = false;
  // Reset filters/limit for the new object.
  var rows = safeGet('filter-rows'); if (rows) rows.innerHTML = '';
  var lim = safeGet('record-limit'); if (lim) lim.value = '';
  setFiltersEnabled(false);
  var cfg = safeGet('configure-btn'); if (cfg) cfg.disabled = true;
  var soql = safeGet('src-soql'); if (soql) soql.value = 'SELECT Id FROM ' + sobject;
  // Show "describing" summary.
  var sum = safeGet('root-summary');
  if (sum) { sum.className = 'root-summary visible describing'; sum.innerHTML = '<span class="spinner"></span> Detecting fields &amp; related objects for <span class="rs-name">' + escHtml(sobject) + '</span>…'; }
  setStatus1('running', 'Describing ' + sobject + '…');
  post({ command: 'discoverRoot', sourceOrg: srcOrg, targetOrg: tgtOrgVal(), soql: 'SELECT Id FROM ' + sobject });
}

/* ── Filters ── */
function setFiltersEnabled(enabled) {
  var block = safeGet('filters-block');
  var empty = safeGet('filters-empty');
  if (block) block.classList.toggle('disabled', !enabled);
  if (empty) empty.style.display = enabled ? 'none' : '';
}

function fieldType(name) {
  for (var i = 0; i < rootFieldDefs.length; i++) if (rootFieldDefs[i].name === name) return (rootFieldDefs[i].type || '').toLowerCase();
  return '';
}

function addFilterRow() {
  var rows = safeGet('filter-rows');
  if (!rows || !rootFieldDefs.length) return;
  var id = 'f' + (++filterSeq);
  var fieldOpts = rootFieldDefs.map(function(f) { return '<option value="'+escHtml(f.name)+'">'+escHtml(f.name)+'</option>'; }).join('');
  var ops = ['=','!=','<','>','<=','>=','LIKE','IN'].map(function(o){ return '<option value="'+o+'">'+o+'</option>'; }).join('');
  var row = document.createElement('div');
  row.className = 'filter-row';
  row.id = id;
  row.innerHTML =
    '<select class="filter-field" onchange="syncSoqlFromBuilder()">'+fieldOpts+'</select>'
    + '<select class="filter-op" onchange="syncSoqlFromBuilder()">'+ops+'</select>'
    + '<input class="filter-val" type="text" placeholder="value" oninput="syncSoqlFromBuilder()" />'
    + '<button type="button" class="filter-remove" title="Remove" onclick="removeFilterRow(\\''+id+'\\')">✕</button>';
  rows.appendChild(row);
  syncSoqlFromBuilder();
}

function removeFilterRow(id) {
  var row = safeGet(id);
  if (row && row.parentNode) row.parentNode.removeChild(row);
  syncSoqlFromBuilder();
}

function quoteValue(type, op, raw) {
  var numeric = ['double','int','integer','currency','percent','long','number'].indexOf(type) !== -1;
  var bool = (type === 'boolean');
  var dateish = (type === 'date' || type === 'datetime');
  function esc(s) { return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
  function one(v) {
    v = String(v).trim();
    if (numeric || bool || dateish) return v;     // emit as-is (SOQL literal expected for dates)
    return "'" + esc(v) + "'";
  }
  if (op === 'IN') {
    var parts = String(raw).split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!parts.length) return null;
    return '(' + parts.map(one).join(', ') + ')';
  }
  if (op === 'LIKE') return "'" + esc(String(raw).trim()) + "'"; // always quoted, keep % wildcards
  return one(raw);
}

function buildWhereClause() {
  var rows = safeGet('filter-rows');
  if (!rows) return '';
  var conds = [];
  Array.prototype.forEach.call(rows.querySelectorAll('.filter-row'), function(r) {
    var field = r.querySelector('.filter-field').value;
    var op = r.querySelector('.filter-op').value;
    var rawEl = r.querySelector('.filter-val');
    var raw = rawEl ? rawEl.value : '';
    if (!field || raw.trim() === '') return;
    var val = quoteValue(fieldType(field), op, raw);
    if (val === null) return;
    conds.push(field + ' ' + op + ' ' + val);
  });
  return conds.join(' AND ');
}

function buildSoqlFromBuilder() {
  if (!pendingRoot) return '';
  var q = 'SELECT Id FROM ' + pendingRoot;
  var where = buildWhereClause();
  if (where) q += ' WHERE ' + where;
  var limEl = safeGet('record-limit');
  var lim = limEl && limEl.value ? parseInt(limEl.value, 10) : 0;
  if (lim && lim > 0) q += ' LIMIT ' + lim;
  return q;
}

/* Keep #src-soql in sync with the builder, unless the user took over in advanced mode. */
function syncSoqlFromBuilder() {
  if (soqlManuallyEdited) return;
  var soql = safeGet('src-soql');
  if (soql) soql.value = buildSoqlFromBuilder();
}

/* ── Basic / Advanced toggle ── */
function setMode(m) {
  mode = m;
  var basic = safeGet('basic-panel');
  var adv = safeGet('advanced-panel');
  var bBtn = safeGet('mode-basic-btn');
  var aBtn = safeGet('mode-advanced-btn');
  if (basic) basic.style.display = (m === 'basic') ? 'flex' : 'none';
  if (adv) adv.style.display = (m === 'advanced') ? 'block' : 'none';
  if (bBtn) bBtn.classList.toggle('active', m === 'basic');
  if (aBtn) aBtn.classList.toggle('active', m === 'advanced');
  if (m === 'advanced' && !soqlManuallyEdited) syncSoqlFromBuilder();
}

var advDiscoverTimer = null;
function fromObjectOf(soql) {
  var m = /\\bfrom\\s+([a-zA-Z0-9_]+)/i.exec(soql || '');
  return m ? m[1] : '';
}
function onSoqlEdited() {
  soqlManuallyEdited = true;
  var soql = safeGet('src-soql');
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  if (!soql || !srcOrg) return;
  var fromObj = fromObjectOf(soql.value);
  // If the FROM object changed (or nothing described yet), re-detect it (debounced).
  if (fromObj && fromObj.toLowerCase() !== (rootSObject || '').toLowerCase()) {
    if (advDiscoverTimer) clearTimeout(advDiscoverTimer);
    advDiscoverTimer = setTimeout(function() {
      pendingRoot = fromObj;
      setStatus1('running', 'Describing ' + fromObj + '…');
      var sum = safeGet('root-summary');
      if (sum) { sum.className = 'root-summary visible describing'; sum.innerHTML = '<span class="spinner"></span> Detecting fields &amp; related objects for <span class="rs-name">' + escHtml(fromObj) + '</span>…'; }
      post({ command: 'discoverRoot', sourceOrg: srcOrg, targetOrg: tgtOrgVal(), soql: soql.value.trim() });
    }, 600);
  }
}

function loadProfile() { post({ command: 'loadProfile' }); }

/* ══════════════════════════════════════════════════════════════════════════
   Page 2 — Tree rendering
══════════════════════════════════════════════════════════════════════════ */
function renderTree() {
  var area = safeGet('tree-area');
  if (!area) return;
  if (!rootSObject || !nodes[rootSObject]) {
    area.innerHTML = '<div style="padding:20px; color:var(--vscode-descriptionForeground); font-size:12px;">No object tree loaded.</div>';
    return;
  }
  var profileName = (safeGet('profile-name') && safeGet('profile-name').value) || rootSObject;
  var titleEl = safeGet('tree-title');
  if (titleEl) titleEl.textContent = profileName + ' — select objects & fields';
  area.innerHTML = renderNodeHtml(rootSObject, null, 0);
}

function renderNodeHtml(sobject, lookupField, depth) {
  var node = nodes[sobject];
  if (!node) return '';
  var isRoot = !node.parentSObject;
  var chevron = node.described ? (node.expanded ? '▼' : '▶') : '&nbsp;';
  var countHtml = '';
  if (node.count !== null && node.count >= 0) countHtml = '<span class="count-badge">'+node.count.toLocaleString()+'</span>';
  else if (node.count === -1) countHtml = '<span class="count-badge loading">…</span>';
  var lookupHtml = lookupField ? '<span class="obj-lookup">via '+escHtml(lookupField)+'</span>' : '';

  var html = '<div class="obj-node'+(node.included ? ' included' : '')+'" id="node-'+escHtml(sobject)+'">';
  html += '<div class="obj-card">';
  html += '<div class="obj-header" onclick="toggleNodeExpand(\\''+escHtml(sobject)+'\\')">';
  html += '<span class="obj-chevron">'+chevron+'</span>';
  html += '<span class="obj-icon">'+(isRoot?'📦':'🔗')+'</span>';
  html += '<span class="obj-name">'+escHtml(node.label)+'</span>';
  html += '<span class="obj-sub">'+escHtml(sobject)+'</span>';
  html += lookupHtml;
  html += countHtml;
  if (node.describeLoading) html += '<span class="spinner" style="flex-shrink:0;"></span>';
  if (!isRoot) html += '<button type="button" class="node-remove" title="Remove this related object" onclick="event.stopPropagation(); removeRelation(\\''+escHtml(sobject)+'\\')">✕</button>';
  html += '</div>'; // end obj-header

  // Body (expanded)
  html += '<div class="obj-body'+(node.expanded ? ' open' : '')+'" id="body-'+escHtml(sobject)+'">';
  if (node.described) {
    // External ID selector
    html += '<div class="ext-id-row">';
    html += '<label>External ID / Upsert key:</label>';
    html += '<select id="extid-'+escHtml(sobject)+'" onchange="setExtId(\\''+escHtml(sobject)+'\\', this.value)">';
    html += '<option value="">(Insert — no external ID)</option>';
    var extBlocked = [];
    (node.externalIdFields || []).forEach(function(f) {
      // A key the target org can't accept is listed but not selectable — visible with a reason
      // beats absent, which reads as "the field doesn't exist".
      if (f.usable === false) {
        extBlocked.push(f);
        html += '<option value="" disabled>'+escHtml(f.name)+' — unavailable in target</option>';
        return;
      }
      html += '<option value="'+escHtml(f.name)+'"'+(node.externalIdField===f.name?' selected':'')+'>'
        +escHtml(f.name)+' ('+escHtml(f.type)+')</option>';
    });
    html += '</select></div>';
    extBlocked.forEach(function(f) {
      html += '<div class="err-line" style="font-size:10px; padding-left:2px;">⚠ ' + escHtml(f.name) +
              ' cannot be used as an upsert key: ' + escHtml(f.reason || 'not writable in the target org') + '</div>';
    });

    // Fields
    if (node.fields && node.fields.length) {
      var selCount = node.fields.filter(function(f){ return f.included; }).length;
      html += '<div class="field-section">';
      html += '<div class="field-section-head">';
      html += '<span class="field-section-label">Fields</span>';
      html += '<span class="field-count" id="fcount-'+escHtml(sobject)+'">'+selCount+' / '+node.fields.length+' selected</span>';
      html += '<span class="field-spacer"></span>';
      html += '<span class="btn-tiny" onclick="setAllFields(\\''+escHtml(sobject)+'\\',true)">All</span>';
      html += '<span class="btn-tiny" onclick="setAllFields(\\''+escHtml(sobject)+'\\',false)">None</span>';
      html += '</div>';
      if (node.fields.length > 12) {
        html += '<input type="text" class="field-search" placeholder="🔍 Filter fields…" oninput="filterNodeFields(\\''+escHtml(sobject)+'\\', this.value)">';
      }
      html += '<div class="fields-grid" id="fields-'+escHtml(sobject)+'">';
      node.fields.forEach(function(f) {
        html += '<label class="field-check" data-fname="'+escHtml(f.name.toLowerCase())+'" title="'+escHtml(f.label)+' ('+escHtml(f.type)+')">'
          + '<input type="checkbox" '+(f.included?'checked':'')
          + ' onchange="toggleField(\\''+escHtml(sobject)+'\\',\\''+escHtml(f.name)+'\\',this.checked)">'
          + '<span class="fname">'+escHtml(f.name)+'</span>'
          + '<span class="ftype">'+escHtml((f.type||'').substring(0,4))+'</span>'
          + '</label>';
      });
      html += '</div></div>';
    }

    // Excluded fields — present in source but not writable in the target org.
    if (node.excludedFields && node.excludedFields.length) {
      var exId = 'excl-' + escHtml(sobject);
      html += '<div class="field-section excluded-section">';
      html += '<div class="field-section-head" style="cursor:pointer;" onclick="toggleExcluded(\\''+escHtml(sobject)+'\\')">';
      html += '<span class="field-section-label" style="color:var(--vscode-errorForeground);">⚠ '+node.excludedFields.length+' field'+(node.excludedFields.length!==1?'s':'')+' unavailable in target</span>';
      html += '<span class="field-count" id="'+exId+'-tog">show</span></div>';
      html += '<div class="excluded-list" id="'+exId+'" style="display:none;">';
      node.excludedFields.forEach(function(f) {
        html += '<div class="excluded-row"><span class="fname">'+escHtml(f.name)+'</span>'
          + '<span class="excluded-reason">'+escHtml(f.reason)+'</span></div>';
      });
      html += '</div></div>';
    }

    // Related objects — searchable add
    var avail = (node.childRelationships || []).filter(function(cr) {
      var c = nodes[cr.childSObject];
      return !(c && c.included && c.parentSObject === sobject);
    });
    html += '<div class="rel-section">';
    var availCount = relAvailable(sobject).length;
    html += '<div class="field-section-head"><span class="field-section-label">Related objects</span>'
      + '<span class="field-count">'+availCount+' available — search &amp; click to add as sub-data</span></div>';
    if (availCount) {
      html += '<div class="rel-section-inner">';
      html += '<input type="text" class="rel-search" id="relsearch-'+escHtml(sobject)+'" data-parent="'+escHtml(sobject)+'"'
        + ' placeholder="🔍 Search related objects…" autocomplete="off" spellcheck="false"'
        + ' oninput="filterRelList(this)" onfocus="showRelList(this)" onblur="hideRelListSoon(this)">';
      html += '<div class="rel-list" id="rellist-'+escHtml(sobject)+'">' + buildRelOptions(sobject, '') + '</div>';
      html += '</div>';
    } else {
      html += '<div class="rel-combo-empty">No related objects available.</div>';
    }
    html += '</div>';
  }
  html += '</div>'; // end obj-body
  html += '</div>'; // end obj-card

  // Render included children as subtree
  var includedChildren = (node.children || []).filter(function(cs) { return nodes[cs] && nodes[cs].included; });
  if (includedChildren.length) {
    html += '<div class="children-subtree">';
    includedChildren.forEach(function(cs) {
      var childNode = nodes[cs];
      if (childNode) html += renderNodeHtml(cs, childNode.lookupField, depth + 1);
    });
    html += '</div>';
  }

  html += '</div>'; // end obj-node
  return html;
}

function toggleNodeExpand(sobject) {
  var node = nodes[sobject];
  if (!node) return;
  if (!node.described && !node.describeLoading) return; // must describe first
  node.expanded = !node.expanded;
  renderTree();
}

/* Add a related object as an included sub-node (and auto-describe it). */
function addRelation(parentSobject, childSobject, lookupField) {
  var parent = nodes[parentSobject];
  if (!parent) return;
  if (!nodes[childSobject]) {
    nodes[childSobject] = {
      sobject: childSobject, label: childSobject,
      parentSObject: parentSobject, lookupField: lookupField,
      count: -1, included: true, expanded: true,
      described: false, describeLoading: false,
      fields: [], externalIdFields: [], externalIdField: null,
      childRelationships: [], children: []
    };
  } else {
    nodes[childSobject].included = true;
    nodes[childSobject].parentSObject = parentSobject;
    nodes[childSobject].lookupField = lookupField;
    nodes[childSobject].expanded = true;
  }
  if (!parent.children) parent.children = [];
  if (parent.children.indexOf(childSobject) < 0) parent.children.push(childSobject);
  if (!nodes[childSobject].described && !nodes[childSobject].describeLoading) {
    requestDescribeChild(childSobject);
  }
  renderTree();
  // Make the newly added related object visible.
  var added = safeGet('node-' + childSobject);
  if (added && added.scrollIntoView) added.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* Relationships on this object not yet included as its children, sorted by name. */
function relAvailable(sobject) {
  var node = nodes[sobject];
  if (!node || !node.childRelationships) return [];
  return node.childRelationships.filter(function(cr) {
    var c = nodes[cr.childSObject];
    return !(c && c.included && c.parentSObject === sobject);
  }).slice().sort(function(a, b) {
    return (a.relationshipName || a.childSObject).localeCompare(b.relationshipName || b.childSObject);
  });
}

/* Build the in-flow results-list HTML, filtered by the query string. */
function buildRelOptions(sobject, query) {
  var q = (query || '').trim().toLowerCase();
  var avail = relAvailable(sobject);
  if (q) {
    avail = avail.filter(function(cr) {
      return (cr.relationshipName || '').toLowerCase().indexOf(q) !== -1
        || (cr.childSObject || '').toLowerCase().indexOf(q) !== -1
        || (cr.field || '').toLowerCase().indexOf(q) !== -1;
    });
  }
  if (!avail.length) return '<div class="rel-combo-empty">No matching related objects.</div>';
  var shown = avail.slice(0, 60);
  return shown.map(function(cr) {
    return '<div class="rel-opt" data-parent="'+escHtml(sobject)+'" data-child="'+escHtml(cr.childSObject)+'" data-field="'+escHtml(cr.field)+'" onclick="addRelationFromOpt(this)">'
      + '<span class="ro-name">'+escHtml(cr.relationshipName || cr.childSObject)+'</span>'
      + '<span class="ro-sobject">'+escHtml(cr.childSObject)+'</span>'
      + '<span class="ro-via">via '+escHtml(cr.field)+'</span>'
      + '</div>';
  }).join('') + (avail.length > shown.length ? '<div class="rel-combo-empty">+ '+(avail.length-shown.length)+' more — refine your search…</div>' : '');
}

/* Re-filter the results list as the user types (no full tree re-render → keeps focus). */
function filterRelList(input) {
  var sobject = input.getAttribute('data-parent');
  if (!sobject) return;
  var list = safeGet('rellist-' + sobject);
  if (list) { list.innerHTML = buildRelOptions(sobject, input.value); list.classList.add('show'); }
}

/* Show the results list when the search box is focused. */
function showRelList(input) {
  var list = safeGet('rellist-' + input.getAttribute('data-parent'));
  if (list) list.classList.add('show');
}

/* Hide shortly after blur — the delay lets a row's click register first. */
function hideRelListSoon(input) {
  var id = 'rellist-' + input.getAttribute('data-parent');
  setTimeout(function() { var l = safeGet(id); if (l) l.classList.remove('show'); }, 200);
}

/* Click handler on a result row → add it as a sub-node. */
function addRelationFromOpt(el) {
  try {
    var p = el.getAttribute('data-parent');
    var c = el.getAttribute('data-child');
    var f = el.getAttribute('data-field');
    if (p && c) addRelation(p, c, f);
  } catch (err) {
    post({ command: 'logError', text: 'addRelation failed: ' + (err && err.message ? err.message : String(err)) });
  }
}

/* Remove an included related object (exclude it from the migration). */
function removeRelation(sobject) {
  var node = nodes[sobject];
  if (!node) return;
  node.included = false;
  var parent = node.parentSObject && nodes[node.parentSObject];
  if (parent && parent.children) {
    var i = parent.children.indexOf(sobject);
    if (i >= 0) parent.children.splice(i, 1);
  }
  renderTree();
}

/* Filter visible field checkboxes within a node (pure DOM, no re-render). */
function filterNodeFields(sobject, q) {
  var grid = safeGet('fields-' + sobject);
  if (!grid) return;
  var query = (q || '').trim().toLowerCase();
  Array.prototype.forEach.call(grid.querySelectorAll('.field-check'), function(el) {
    var name = el.getAttribute('data-fname') || '';
    el.style.display = (!query || name.indexOf(query) !== -1) ? '' : 'none';
  });
}

function toggleExcluded(sobject) {
  var list = safeGet('excl-' + sobject);
  var tog = safeGet('excl-' + sobject + '-tog');
  if (!list) return;
  var open = list.style.display === 'none';
  list.style.display = open ? 'block' : 'none';
  if (tog) tog.textContent = open ? 'hide' : 'show';
}

/* Re-describe every object currently in the tree. The describe cache was just cleared, but the
   field lists on screen came from the old describe — without this a field created since the last
   describe (typically a new external Id) never appears until the panel is rebuilt. */
function redescribeSelected() {
  var names = Object.keys(nodes || {});
  if (!names.length) return;
  names.forEach(function(sobject) { requestDescribeChild(sobject); });
}

function requestDescribeChild(sobject) {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  if (!srcOrg) return;
  if (nodes[sobject]) nodes[sobject].describeLoading = true;
  post({ command: 'describeChild', sourceOrg: srcOrg, targetOrg: tgtOrgVal(), sobject: sobject });
  renderTree();
}

function toggleField(sobject, fieldName, checked) {
  var node = nodes[sobject];
  if (!node) return;
  var f = node.fields && node.fields.find(function(x) { return x.name === fieldName; });
  if (f) f.included = checked;
  var cnt = safeGet('fcount-' + sobject);
  if (cnt && node.fields) cnt.textContent = node.fields.filter(function(x){ return x.included; }).length + ' / ' + node.fields.length + ' selected';
}

function setAllFields(sobject, checked) {
  var node = nodes[sobject];
  if (!node || !node.fields) return;
  node.fields.forEach(function(f) { f.included = checked; });
  renderTree();
}

function setExtId(sobject, value) {
  var node = nodes[sobject];
  if (!node) return;
  node.externalIdField = value || null;
}

/* ══════════════════════════════════════════════════════════════════════════
   Page 3 — Run
══════════════════════════════════════════════════════════════════════════ */
function prepareRunPage() {
  var profile = buildProfile();
  if (!profile) return;

  // ── Overview of what will be migrated ──
  var ov = safeGet('run-overview');
  if (ov) {
    var srcLbl = (function(){ var s=safeGet('src-org'); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : (s&&s.value)||'?'; })();
    // A file output has no target org, so the destination is the format itself.
    var exporting = migrationType() !== 'org';
    var tgtLbl = exporting
      ? ({ apex: 'Apex script', csv: 'CSV files', json: 'JSON file' })[migrationType()]
      : (function(){ var s=safeGet('tgt-org'); return s && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : (s&&s.value)||'?'; })();
    var knownTotal = 0;
    profile.nodes.forEach(function(n) {
      var node = nodes[n.sobject] || {};
      if (node.count !== undefined && node.count !== null && node.count >= 0) knownTotal += node.count;
    });
    ov.innerHTML =
      '<div class="ov-head"><span class="ov-title">' + (exporting ? 'Export' : 'Migration') + ' overview</span>'
      + '<span class="ov-orgs">'+escHtml(srcLbl)+' &nbsp;→&nbsp; '+escHtml(tgtLbl)+'</span></div>'
      + '<div class="ov-summary">'+profile.nodes.length+' object type'+(profile.nodes.length!==1?'s':'')
      + ' · '+knownTotal.toLocaleString()+'+ records to '+(exporting ? 'export' : 'migrate')+'</div>'
      + '<div class="ov-note">'
      + (exporting
          ? 'Nothing is written to an org. Lookups between exported objects resolve through the parent&rsquo;s external Id where there is one; lookups to objects not in this selection are left empty. Child record counts are determined when the records are read.'
          : 'References are re-linked automatically to the new records. Lookups to objects not in this migration (e.g. Owner, Record Type, Created By) are left empty — source Ids never exist in the target org. Child record counts are determined at run time from the migrated parents.')
      + '</div>';
  }

  var area = safeGet('progress-list');
  if (!area) return;
  var isExport = migrationType() !== 'org';
  area.innerHTML = '';
  // One row per object carrying BOTH what is planned and what is happening. Two separate lists
  // saying the same thing about the same objects was just something to scroll past.
  profile.nodes.forEach(function(n) {
    var node = nodes[n.sobject] || {};
    var mode = n.externalIdField ? ('Upsert on ' + n.externalIdField) : 'Insert';
    var link = n.parentSObject ? ('↳ ' + (n.lookupField || '?') + ' → ' + n.parentSObject) : 'root';
    var hasCount = (node.count !== undefined && node.count !== null && node.count >= 0);
    var cnt = hasCount ? (node.count.toLocaleString() + ' record' + (node.count !== 1 ? 's' : '')) : 'counted at run';
    var row = document.createElement('div');
    row.className = 'obj-row';
    row.id = 'pr-' + n.sobject;
    row.innerHTML =
      '<div class="obj-line">'
      + '<span class="obj-progress-icon">'+(n.parentSObject ? '🔗' : '📦')+'</span>'
      + '<span class="obj-name">'+escHtml(n.label || n.sobject)+' <span class="obj-api">'+escHtml(n.sobject)+'</span></span>'
      + '<span class="obj-count">'+escHtml(cnt)+'</span>'
      + '<span class="obj-meta">'+(n.includeFields ? n.includeFields.length : 0)+' fields</span>'
      + '<span class="obj-meta">'+escHtml(mode)+'</span>'
      + '<span class="obj-link">'+escHtml(link)+'</span>'
      + '<span class="obj-progress-phase" id="ph-'+escHtml(n.sobject)+'">queued</span>'
      + '<span class="obj-progress-counts" id="counts-'+escHtml(n.sobject)+'">'
      + '<span class="ok" id="ins-'+escHtml(n.sobject)+'">'+(isExport ? '' : '+0')+'</span>'
      + '<span class="upd" id="upd-'+escHtml(n.sobject)+'">'+(isExport ? '' : '~0')+'</span>'
      + '<span class="err" id="fail-'+escHtml(n.sobject)+'">'+(isExport ? '' : '✗0')+'</span>'
      + '</span>'
      + '</div>'
      + '<div class="progress-track"><div class="progress-fill" id="fill-'+escHtml(n.sobject)+'" style="width:0%"></div></div>'
      + '<div class="errors-toggle" id="etog-'+escHtml(n.sobject)+'" onclick="toggleObjErrors(\\''+escHtml(n.sobject)+'\\')"></div>'
      + '<div class="errors-detail" id="edet-'+escHtml(n.sobject)+'"></div>';
    area.appendChild(row);
  });
  var statusLbl = safeGet('run-status-label');
  if (statusLbl) statusLbl.textContent = 'Ready — ' + profile.nodes.length + ' object'+(profile.nodes.length!==1?'s':'');
  safeGet('global-error') && (safeGet('global-error').classList.remove('visible'));
  safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = false);
  safeGet('start-run-btn') && (safeGet('start-run-btn').textContent = '⚡ Start Migration');
  safeGet('retry-failed-btn') && (safeGet('retry-failed-btn').style.display = 'none');
  // The previous run's undo no longer describes the org once a new run starts. Clearing the
  // results block removes the revert control with it — it lives there now.
  safeGet('changes-table') && (safeGet('changes-table').innerHTML = '');
  lastJournal = null;
  onMigrationTypeChange(); // the button and the revert controls follow the chosen output
}

function toggleObjErrors(sobject) {
  var det = safeGet('edet-'+sobject);
  var tog = safeGet('etog-'+sobject);
  if (!det) return;
  var open = det.classList.toggle('open');
  if (tog) tog.textContent = open ? '▲ Hide errors' : '▼ Show errors';
}

function buildProfile() {
  if (!rootSObject || !nodes[rootSObject]) return null;
  var name = (safeGet('profile-name') && safeGet('profile-name').value) || rootSObject;
  var soql = (safeGet('src-soql') && safeGet('src-soql').value) || '';
  // Topological order: BFS from root
  var ordered = [];
  var queue = [rootSObject];
  var seen = new Set();
  while (queue.length) {
    var current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    var n = nodes[current];
    if (!n || !n.included) continue;
    var includedFields = (n.fields || []).filter(function(f) { return f.included; }).map(function(f) { return f.name; });
    if (!includedFields.length) includedFields = (n.fields || []).slice(0,5).map(function(f){return f.name;});
    ordered.push({
      sobject: n.sobject,
      label: n.label,
      parentSObject: n.parentSObject || null,
      lookupField: n.lookupField || null,
      includeFields: includedFields,
      externalIdField: n.externalIdField || null
    });
    // Enqueue included children
    (n.children || []).forEach(function(cs) {
      if (nodes[cs] && nodes[cs].included) queue.push(cs);
    });
  }
  return { version: 2, name: name, createdAt: new Date().toISOString(), sourceQuery: soql, rootSObject: rootSObject, nodes: ordered };
}

function saveProfile() {
  var profile = buildProfile();
  if (!profile) { vscode && vscode.window && vscode.window.showErrorMessage('No tree loaded.'); return; }
  post({ command: 'saveProfile', profile: profile, name: profile.name });
}

function migrationType() {
  var el = safeGet('migration-type');
  return (el && el.value) || 'org';
}

var TYPE_LABEL = { org: '⚡ Start Migration', apex: '⚡ Generate Apex', csv: '⚡ Export CSV', json: '⚡ Export JSON' };

/**
 * Only an org-to-org run writes into a second org, so the target-org controls and the revert
 * machinery are meaningless for the file outputs — hide them rather than leave dead switches on
 * screen.
 */
var TYPE_NAME = { org: 'Org → Org', apex: 'Org → Apex script', csv: 'Org → CSV', json: 'Org → JSON' };
var lastMigrationType = null;   // so a re-render does not count as a change

function onMigrationTypeChange() {
  var t = migrationType();
  var toOrg = t === 'org';
  // A file output has no second org, so the target picker is replaced rather than left to be
  // filled in pointlessly — and the field comparison that needs it simply does not run.
  var tgtBlock = safeGet('tgt-org-block');
  if (tgtBlock) tgtBlock.style.display = toOrg ? '' : 'none';
  var tgtNone = safeGet('tgt-org-none');
  if (tgtNone) tgtNone.style.display = toOrg ? 'none' : '';
  var chip = safeGet('run-type-label');
  if (chip) chip.textContent = TYPE_NAME[t] || TYPE_NAME.org;
  var btn = safeGet('start-run-btn');
  if (btn) btn.textContent = TYPE_LABEL[t] || TYPE_LABEL.org;
  var rev = safeGet('revert-on-fail');
  if (rev && rev.parentElement) rev.parentElement.style.display = toOrg ? '' : 'none';
  if (!toOrg) safeGet('changes-table') && (safeGet('changes-table').innerHTML = '');
  var lbl = safeGet('run-status-label');
  if (lbl) {
    lbl.textContent = toOrg
      ? 'Ready to run'
      : 'Ready — the same selection and rules, written to a file instead of an org.';
  }
  // Which fields are available depends on whether a target org is being compared against, so a
  // tree built under the previous type has to be described again — but only when the type really
  // changed, since this also runs every time the run page is prepared.
  var changed = lastMigrationType !== null && lastMigrationType !== t;
  lastMigrationType = t;
  if (changed && Object.keys(nodes || {}).length) {
    try { redescribeSelected(); } catch (e) { /* nothing described yet */ }
  }
}

function startMigration() {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  var tgtOrg = safeGet('tgt-org') && safeGet('tgt-org').value;
  var profile = buildProfile();
  var type = migrationType();
  var needsTarget = type === 'org';
  if (!srcOrg || !profile || !profile.nodes.length || (needsTarget && !tgtOrg)) {
    safeGet('global-error') && (safeGet('global-error').className = 'global-error visible');
    safeGet('global-error') && (safeGet('global-error').textContent = needsTarget
      ? 'Source org, target org and at least one included object are required.'
      : 'Source org and at least one included object are required.');
    return;
  }
  safeGet('global-error') && (safeGet('global-error').classList.remove('visible'));
  safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = true);
  safeGet('start-run-btn') && (safeGet('start-run-btn').textContent = needsTarget ? '⏳ Running…' : '⏳ Exporting…');
  safeGet('back-to-tree-btn') && (safeGet('back-to-tree-btn').disabled = true);
  safeGet('run-status-label') && (safeGet('run-status-label').textContent = needsTarget ? 'Migration running…' : 'Reading records…');
  if (!needsTarget) {
    post({ command: 'exportMigration', sourceOrg: srcOrg, profile: profile, format: type });
    return;
  }
  var revertEl = safeGet('revert-on-fail');
  post({ command: 'runMigration', sourceOrg: srcOrg, targetOrg: tgtOrg, profile: profile,
    revertOnFail: !!(revertEl && revertEl.checked) });
}

function finishExport(text, cls) {
  safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = false);
  safeGet('start-run-btn') && (safeGet('start-run-btn').textContent = TYPE_LABEL[migrationType()] || TYPE_LABEL.org);
  safeGet('back-to-tree-btn') && (safeGet('back-to-tree-btn').disabled = false);
  safeGet('run-status-label') && (safeGet('run-status-label').textContent = text);
  if (cls === 'error') {
    var ge = safeGet('global-error');
    if (ge) { ge.className = 'global-error visible'; ge.textContent = '❌ ' + text; }
  }
}

/** Leave no row spinning when a run ends early — a stuck spinner reads as "still working". */
function stopProgressSpinners() {
  var icons = document.querySelectorAll('.obj-progress-icon');
  for (var i = 0; i < icons.length; i++) {
    if (icons[i].querySelector('.spinner')) icons[i].textContent = '⚠';
  }
}

function updateProgressRow(progress) {
  var sb = progress.sobject;
  var isExport = progress.mode === 'export';
  var phEl = safeGet('ph-'+sb);
  if (phEl) phEl.textContent = isExport && progress.phase === 'querying' ? 'reading' : progress.phase;
  var insEl = safeGet('ins-'+sb);
  var updEl = safeGet('upd-'+sb);
  var failEl = safeGet('fail-'+sb);
  if (isExport) {
    // Nothing is inserted, updated or failed by an export — the only number that means anything
    // is how many records were read.
    if (insEl) insEl.textContent = (progress.records || 0) + ' record' + (progress.records === 1 ? '' : 's');
    if (updEl) updEl.textContent = '';
    if (failEl) failEl.textContent = '';
  } else {
    if (insEl) insEl.textContent = '+'+progress.inserted;
    if (updEl) updEl.textContent = '~'+progress.updated;
    if (failEl) failEl.textContent = '✗'+progress.failed;
  }
  var fill = safeGet('fill-'+sb);
  if (fill && progress.total > 0) fill.style.width = Math.round(progress.done/progress.total*100)+'%';
  var row = safeGet('pr-'+sb);
  if (row) {
    var icon = row.querySelector('.obj-progress-icon');
    if (icon) {
      if (progress.phase === 'done') icon.textContent = progress.failed > 0 ? '⚠' : '✅';
      else if (progress.phase === 'skipped') icon.textContent = '⏭';
      else icon.innerHTML = '<span class="spinner"></span>';
    }
  }
}

function showMigrationResults(results) {
  var totalIns = 0, totalUpd = 0, totalFail = 0;
  lastFailed = {};
  results.forEach(function(r) {
    totalIns += r.inserted; totalUpd += r.updated; totalFail += r.failed;
    updateProgressRow({ sobject: r.sobject, phase: 'done', done: r.queried, total: r.queried, inserted: r.inserted, updated: r.updated, failed: r.failed });
    if (r.errors && r.errors.length) {
      // Remember failed source Ids for retry.
      var ids = [];
      r.errors.forEach(function(e) { if (e.srcId) ids.push(e.srcId); });
      if (ids.length) lastFailed[r.sobject] = ids;
      // Group identical messages so "10 failed" reads as "10× <reason>" — but show EVERY row.
      var byMsg = {};
      r.errors.forEach(function(e) { var k = e.message || 'Unknown error'; (byMsg[k] = byMsg[k] || []).push(e); });
      var tog = safeGet('etog-'+r.sobject);
      var det = safeGet('edet-'+r.sobject);
      if (tog) { tog.textContent = '▲ Hide '+r.errors.length+' error'+(r.errors.length!==1?'s':''); tog.style.display = ''; }
      if (det) {
        var html = '';
        Object.keys(byMsg).forEach(function(msg) {
          var rows = byMsg[msg];
          html += '<div class="err-group"><div class="err-count">'+rows.length+'× '+escHtml(msg)+'</div>';
          html += rows.map(function(e) {
            return '<div class="err-line">• row '+(e.row+2)+(e.srcId?' ['+escHtml(e.srcId)+']':'')+'</div>';
          }).join('');
          html += '</div>';
        });
        det.innerHTML = html;
        det.classList.add('open'); // auto-expand so the reason is visible
      }
    }
    // Fields that were NOT written. Never let a run look clean while data was dropped.
    if (r.warnings && r.warnings.length) {
      var det2 = safeGet('edet-'+r.sobject);
      if (det2) {
        // Two different things wear the "not migrated" label, and mixing them is what produced
        // "add User to this migration" for OwnerId — advice nobody can follow. Split them:
        // fixable ones get the recommendation, org-assigned ones are stated and left alone.
        var missing = {};
        var fixable = r.warnings.filter(function(w) { return w.fixable !== false; });
        var expected = r.warnings.filter(function(w) { return w.fixable === false; });
        var wHtml = '';
        if (fixable.length) {
          wHtml += '<div class="err-group" style="border-left-color:var(--vscode-editorWarning-foreground,#cca700);">';
          wHtml += '<div class="err-count" style="color:var(--vscode-editorWarning-foreground,#cca700);">⚠ '+fixable.length+' field(s) not migrated</div>';
          fixable.forEach(function(w) {
            wHtml += '<div class="err-line">• '+escHtml(w.field)+' — '+escHtml(w.reason)+' ('+w.count+' record'+(w.count!==1?'s':'')+')</div>';
            var m = /Lookup to ([^—]+) —/.exec(w.reason);
            if (m) { m[1].trim().split('/').forEach(function(o) { missing[o.trim()] = true; }); }
          });
          var names = Object.keys(missing);
          if (names.length) {
            wHtml += '<div class="err-line" style="margin-top:6px;">↳ Add ' + names.map(escHtml).join(', ') +
                     ' to this migration to keep ' + (names.length > 1 ? 'these links' : 'this link') + '.</div>';
          }
          wHtml += '</div>';
        }
        if (expected.length) {
          wHtml += '<div class="err-group note-group">';
          wHtml += '<div class="note-count">ℹ '+expected.length+' field(s) the target org fills in itself</div>';
          expected.forEach(function(w) {
            wHtml += '<div class="note-line">• '+escHtml(w.field)+' — '+escHtml(w.reason)+' ('+w.count+' record'+(w.count!==1?'s':'')+')</div>';
          });
          wHtml += '</div>';
        }
        det2.innerHTML = (det2.innerHTML || '') + wHtml;
        det2.classList.add('open');
        var tog2 = safeGet('etog-'+r.sobject);
        if (tog2 && tog2.style.display === 'none') { tog2.textContent = '▲ Hide details'; tog2.style.display = ''; }
      }
    }
    if (safeGet('fill-'+r.sobject)) safeGet('fill-'+r.sobject).style.width = '100%';
  });
  var statusLbl = safeGet('run-status-label');
  if (statusLbl) statusLbl.textContent = (totalFail ? '⚠' : '✅') + ' Done — +'+totalIns+' inserted, ~'+totalUpd+' updated, ✗'+totalFail+' failed';
  safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = false);
  safeGet('start-run-btn') && (safeGet('start-run-btn').textContent = '🔄 Run Again');
  safeGet('back-to-tree-btn') && (safeGet('back-to-tree-btn').disabled = false);
  // Offer a targeted retry when there are failed rows we can re-attempt.
  var retryBtn = safeGet('retry-failed-btn');
  if (retryBtn) {
    var hasRetry = Object.keys(lastFailed).length > 0;
    retryBtn.style.display = hasRetry ? '' : 'none';
    retryBtn.disabled = false;
    retryBtn.textContent = '⟳ Retry failed rows';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Revert — what this run changed, and putting it back
══════════════════════════════════════════════════════════════════════════ */
var CHANGES_ROW_LIMIT = 500;   // render cap only; the revert always covers every row

function fmtVal(v) {
  if (v === null || v === undefined || v === '') return '∅';
  return String(v);
}

/** A record Id as a link into the org it lives in, plain text when we have no URL for it. */
function orgLink(id, baseUrl, title) {
  if (!id) return '—';
  if (!baseUrl) return escHtml(id);
  return '<a href="' + escHtml(baseUrl) + '/' + escHtml(id) + '" title="' + escHtml(title) + '">' + escHtml(id) + '</a>';
}
function recordCell(id) { return orgLink(id, targetInstanceUrl, 'Open in the target org'); }
function sourceCell(id) { return orgLink(id, sourceInstanceUrl, 'Open in the source org'); }

/** The field-by-field diff for one overwritten record, one "field was → now" line each. */
function diffCell(entry) {
  var out = '';
  Object.keys(entry.after || {}).forEach(function(f) {
    var before = (entry.before || {})[f];
    var after = (entry.after || {})[f];
    if (fmtVal(before) === fmtVal(after)) return;   // the write did not change this one
    out += '<div class="diff-line"><span class="diff-field">' + escHtml(f) + '</span> ' +
           '<span class="was">' + escHtml(fmtVal(before)) + '</span> → ' +
           escHtml(fmtVal(after)) + '</div>';
  });
  return out || '<span class="diff-none">no field changed</span>';
}

/**
 * The record-level result of the run: every record created, and every record overwritten with
 * its old value beside the new one, each with a checkbox.
 *
 * The per-object counters say how many; this says which — and which of them to undo. It is also
 * the review surface when "Revert on failure" is off: nothing was undone automatically, so the
 * run has to be inspectable in full before it is accepted.
 */
function renderChangesTable(journal) {
  var host = safeGet('changes-table');
  if (!host) return;
  host.innerHTML = '';
  if (!journal) return;

  // ── Header: what changed, and the control that undoes it ──────────────────
  // The revert belongs beside the records it acts on, not in the toolbar where it sat next to
  // Start with nothing on screen to tell you what it would touch.
  var createdTotal = 0, updatedTotal = 0, restorable = 0;
  Object.keys(journal.inserted || {}).forEach(function(s) { createdTotal += (journal.inserted[s] || []).length; });
  Object.keys(journal.updated || {}).forEach(function(s) {
    (journal.updated[s] || []).forEach(function(e) { updatedTotal++; if (e.status === 'updated') restorable++; });
  });
  if (!createdTotal && !updatedTotal) return;

  var parts = [];
  if (createdTotal) parts.push(createdTotal + ' created');
  if (updatedTotal) parts.push(updatedTotal + ' overwritten');

  var html = '<div class="changes-bar">'
    + '<span class="changes-bar-title">What this run changed</span>'
    + '<span class="changes-bar-sub">' + parts.join(' · ') + '</span>'
    + (createdTotal + restorable > 0
        ? '<button class="btn-secondary" id="revert-run-btn" onclick="revertRun()" title="Delete the records this run created and put the records it overwrote back to their previous values. Untick rows below to undo only some.">↩ Revert this run</button>'
        : '')
    + '</div>';

  // ── Created records ───────────────────────────────────────────────────────
  var created = [];
  Object.keys(journal.inserted || {}).forEach(function(sobject) {
    (journal.inserted[sobject] || []).forEach(function(rec) {
      created.push({ sobject: sobject, id: rec.id, srcId: rec.srcId });
    });
  });
  if (created.length) {
    html += '<div class="changes-card">' +
      '<div class="changes-head">Created' +
      '<span class="sub">ticked records are the ones a revert deletes</span>' +
      '<span class="btn-tiny" onclick="setRevertAll(\\'ins\\', true)">All</span>' +
      '<span class="btn-tiny" onclick="setRevertAll(\\'ins\\', false)">None</span></div>' +
      '<div class="changes-scroll"><table class="changes"><thead><tr>' +
      '<th class="pick"><input type="checkbox" checked title="Select every created record" ' +
      'onchange="setRevertAll(\\'ins\\', this.checked)"></th>' +
      '<th>Object</th><th>Source Id</th><th>New record</th><th>Status</th>' +
      '</tr></thead><tbody>';
    created.slice(0, CHANGES_ROW_LIMIT).forEach(function(r) {
      html += '<tr>' +
        '<td class="pick"><input type="checkbox" class="rv rv-ins" checked ' +
          'data-obj="' + escHtml(r.sobject) + '" data-id="' + escHtml(r.id) + '" onchange="updateRevertBtn()"></td>' +
        '<td>' + escHtml(r.sobject) + '</td>' +
        '<td>' + sourceCell(r.srcId) + '</td>' +
        '<td>' + recordCell(r.id) + '</td>' +
        '<td class="st-updated">created</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    if (created.length > CHANGES_ROW_LIMIT) {
      html += '<div class="changes-more">Showing the first ' + CHANGES_ROW_LIMIT + ' of ' +
              created.length + ' records — the rest are reverted with them unless you deselect here.</div>';
    }
    html += '</div>';
  }

  // ── Overwritten records (upsert only — an insert overwrites nothing) ──────
  // One row per RECORD, not per field: a record is the unit a revert acts on, so it has to be
  // the unit you can tick.
  var updated = [];
  Object.keys(journal.updated || {}).forEach(function(sobject) {
    (journal.updated[sobject] || []).forEach(function(e) { updated.push({ sobject: sobject, e: e }); });
  });
  if (updated.length) {
    html += '<div class="changes-card">' +
      '<div class="changes-head">Overwritten' +
      '<span class="sub">' + restorable + ' restorable — ticked records go back to their previous values</span>' +
      '<span class="btn-tiny" onclick="setRevertAll(\\'upd\\', true)">All</span>' +
      '<span class="btn-tiny" onclick="setRevertAll(\\'upd\\', false)">None</span></div>' +
      '<div class="changes-scroll"><table class="changes"><thead><tr>' +
      '<th class="pick"><input type="checkbox" checked title="Select every restorable record" ' +
      'onchange="setRevertAll(\\'upd\\', this.checked)"></th>' +
      '<th>Object</th><th>Source Id</th><th>Record</th><th>Changes (was → now)</th><th>Status</th>' +
      '</tr></thead><tbody>';
    updated.slice(0, CHANGES_ROW_LIMIT).forEach(function(u) {
      var failed = u.e.status === 'failed';
      html += '<tr>' +
        '<td class="pick">' + (failed ? '' :
          '<input type="checkbox" class="rv rv-upd" checked data-obj="' + escHtml(u.sobject) +
          '" data-id="' + escHtml(u.e.id) + '" onchange="updateRevertBtn()">') + '</td>' +
        '<td>' + escHtml(u.sobject) + '</td>' +
        '<td>' + sourceCell(u.e.srcId) + '</td>' +
        '<td>' + recordCell(u.e.id) + '</td>' +
        '<td>' + diffCell(u.e) + '</td>' +
        '<td class="' + (failed ? 'st-failed' : 'st-updated') + '">' +
          escHtml(failed ? ('failed — ' + (u.e.message || '')) : 'updated') + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    if (updated.length > CHANGES_ROW_LIMIT) {
      html += '<div class="changes-more">Showing the first ' + CHANGES_ROW_LIMIT + ' of ' +
              updated.length + ' records — the rest are reverted with them unless you deselect here.</div>';
    }
    html += '</div>';
  }

  host.innerHTML = html;
  updateRevertBtn();
}

/** Tick or untick every row in one of the two tables. */
function setRevertAll(kind, checked) {
  var boxes = document.querySelectorAll('.rv-' + kind);
  for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
  updateRevertBtn();
}

/** The records currently ticked, grouped the way the revert wants them. */
function revertSelection() {
  var sel = { inserted: {}, updated: {} };
  var boxes = document.querySelectorAll('.rv');
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    if (!b.checked) continue;
    var bucket = b.classList.contains('rv-ins') ? sel.inserted : sel.updated;
    var obj = b.getAttribute('data-obj');
    (bucket[obj] = bucket[obj] || []).push(b.getAttribute('data-id'));
  }
  return sel;
}

function selectionCount(sel) {
  var n = 0;
  ['inserted', 'updated'].forEach(function(k) {
    Object.keys(sel[k]).forEach(function(o) { n += sel[k][o].length; });
  });
  return n;
}

/** Keep the button honest about how many records it would actually touch. */
function updateRevertBtn() {
  var btn = safeGet('revert-run-btn');
  if (!btn) return;
  var total = document.querySelectorAll('.rv').length;
  var n = selectionCount(revertSelection());
  btn.disabled = n === 0;
  btn.textContent = (n && n === total) ? '↩ Revert this run' : '↩ Revert ' + n + ' selected';
}

function revertRun() {
  var sel = revertSelection();
  if (!selectionCount(sel)) return;
  var btn = safeGet('revert-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Reverting…'; }
  // Always send the selection — the host filters the journal by it, so a partial revert leaves
  // the rest of the run untouched and still undoable.
  post({ command: 'revertRun', selection: sel });
}

function retryFailed() {
  var srcOrg = safeGet('src-org') && safeGet('src-org').value;
  var tgtOrg = safeGet('tgt-org') && safeGet('tgt-org').value;
  var profile = buildProfile();
  if (!srcOrg || !tgtOrg || !profile || !Object.keys(lastFailed).length) return;
  var btn = safeGet('retry-failed-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Retrying…'; }
  safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = true);
  safeGet('back-to-tree-btn') && (safeGet('back-to-tree-btn').disabled = true);
  safeGet('run-status-label') && (safeGet('run-status-label').textContent = 'Retrying failed rows…');
  post({ command: 'runMigration', sourceOrg: srcOrg, targetOrg: tgtOrg, profile: profile,
    retry: { retryOnly: lastFailed, priorIdMaps: lastIdMaps } });
}

/* ══════════════════════════════════════════════════════════════════════════
   Message handler
══════════════════════════════════════════════════════════════════════════ */
window.addEventListener('message', function(ev) {
  var d = ev.data;
  if (!d || !d.command) return;

  if (d.command === 'init') {
    orgsData = d.orgs || [];
    populateOrgSelects(orgsData);
    onMigrationTypeChange();
    // Self-heal empty dropdowns: trigger one cache refresh if no orgs came back.
    if ((!orgsData || !orgsData.length) && !orgRefreshedOnce) {
      orgRefreshedOnce = true;
      var lbl0 = safeGet('cache-status-label'); if (lbl0) lbl0.textContent = 'Loading orgs…';
      post({ command: 'refreshCache' });
    }
    return;
  }

  if (d.command === 'objectList') {
    objectListLoading = false;
    if (d.sourceOrg && safeGet('src-org') && d.sourceOrg !== safeGet('src-org').value) return; // stale
    objectListData = (d.objects || []).slice();
    objectListOrg = d.sourceOrg || (safeGet('src-org') && safeGet('src-org').value) || null;
    var inputEl = safeGet('root-object-input');
    if (inputEl) {
      inputEl.disabled = !objectListData.length;
      inputEl.placeholder = objectListData.length ? 'Search objects… (e.g. Account)' : (d.error ? 'Could not load objects' : 'No objects found');
    }
    renderRootList();
    return;
  }

  if (d.command === 'cacheRefreshed') {
    var btn2 = safeGet('refresh-cache-btn');
    var lbl2 = safeGet('cache-status-label');
    if (btn2) { btn2.classList.remove('spinning'); btn2.disabled = false; }
    if (d.orgs) { orgsData = d.orgs; populateOrgSelects(orgsData); }
    // The cache is cleared, but the field lists on screen were built from the OLD describe.
    // Re-describe whatever is selected so newly created fields (external Ids) appear.
    try { redescribeSelected(); } catch (e) { /* nothing selected yet */ }
    if (lbl2) {
      var now = new Date(); lbl2.textContent = 'Updated ' + now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0');
      setTimeout(function() { if (lbl2) lbl2.textContent = ''; }, 5000);
    }
    return;
  }

  if (d.command === 'discoverProgress') {
    setStatus1('running', d.message || 'Working…');
    return;
  }

  if (d.command === 'discoverError') {
    setStatus1('error', d.error || 'Discovery failed');
    var sumE = safeGet('root-summary');
    if (sumE) { sumE.className = 'root-summary visible error'; sumE.innerHTML = '⚠ ' + escHtml(d.error || 'Could not describe object.'); }
    var cfgE = safeGet('configure-btn'); if (cfgE) cfgE.disabled = true;
    return;
  }

  if (d.command === 'rootDiscovered') {
    setStatus1('success', '✅ ' + d.sobject + ' ready — ' + (d.count >= 0 ? d.count + ' records' : 'record count unavailable'));
    rootSObject = d.sobject;
    pendingRoot = d.sobject;
    rootFieldDefs = (d.fields || []).map(function(f) { return { name: f.name, label: f.label, type: f.type }; });
    nodes = {};
    nodes[d.sobject] = {
      sobject: d.sobject, label: d.label,
      parentSObject: null, lookupField: null,
      count: d.count, included: true, expanded: true,
      described: true, describeLoading: false,
      fields: (d.fields || []).map(function(f) { return Object.assign({}, f, {included: true}); }),
      excludedFields: d.excludedFields || [],
      externalIdFields: d.externalIdFields || [],
      externalIdField: null,
      childRelationships: d.childRelationships || [],
      children: []
    };
    // Update inline summary (no auto-navigation — let the user set filters first).
    var sum = safeGet('root-summary');
    if (sum) {
      var nFields = (d.fields || []).length;
      var nChildren = (d.childRelationships || []).length;
      sum.className = 'root-summary visible';
      sum.innerHTML = '✅ <span class="rs-name">' + escHtml(d.label || d.sobject) + '</span> '
        + '<span class="rs-meta">(' + escHtml(d.sobject) + ')</span> · '
        + '<span class="rs-meta">' + (d.count >= 0 ? d.count.toLocaleString() + ' records' : 'count unavailable') + '</span> · '
        + '<span class="rs-meta">' + nFields + ' fields · ' + nChildren + ' related object' + (nChildren !== 1 ? 's' : '') + ' detected</span>';
    }
    // Enable filters (built from the described fields) and the proceed button.
    setFiltersEnabled(true);
    if (!soqlManuallyEdited) syncSoqlFromBuilder();
    var cfg = safeGet('configure-btn'); if (cfg) cfg.disabled = false;
    return;
  }

  if (d.command === 'childDescribed') {
    var node = nodes[d.sobject];
    if (node) {
      node.described = true;
      node.describeLoading = false;
      node.label = d.label || d.sobject;
      node.fields = (d.fields || []).map(function(f) { return Object.assign({}, f, {included: true}); });
      node.excludedFields = d.excludedFields || [];
      node.externalIdFields = d.externalIdFields || [];
      node.childRelationships = d.childRelationships || [];
      node.expanded = true;
    }
    renderTree();
    return;
  }

  if (d.command === 'describeChildError') {
    var node2 = nodes[d.sobject];
    if (node2) { node2.describeLoading = false; }
    renderTree();
    return;
  }

  if (d.command === 'exportComplete') {
    finishExport('✅ Exported — ' + (d.summary || 'done'));
    return;
  }

  if (d.command === 'exportCancelled') {
    finishExport('Export cancelled.');
    return;
  }

  if (d.command === 'validated') {
    renderValidation(d);
    return;
  }

  if (d.command === 'migrationStarted') {
    safeGet('run-status-label') && (safeGet('run-status-label').textContent = 'Migration running…');
    return;
  }

  if (d.command === 'migrationProgress') {
    updateProgressRow(d.progress);
    return;
  }

  if (d.command === 'migrationComplete') {
    if (d.idMaps) lastIdMaps = d.idMaps;
    lastJournal = d.journal || null;
    targetInstanceUrl = (d.targetInstanceUrl || '').replace(/\\/$/, '');
    sourceInstanceUrl = (d.sourceInstanceUrl || '').replace(/\\/$/, '');
    showMigrationResults(d.results || []);
    renderChangesTable(lastJournal);
    return;
  }

  if (d.command === 'revertStarted') {
    safeGet('run-status-label') && (safeGet('run-status-label').textContent = 'Reverting…');
    return;
  }

  if (d.command === 'revertProgress') {
    var lblR = safeGet('run-status-label');
    if (lblR) {
      lblR.textContent = (d.step === 'restoring' ? 'Restoring ' : 'Deleting ') + d.sobject +
                         ' — ' + d.done + ' done' + (d.failed ? ', ' + d.failed + ' failed' : '');
    }
    return;
  }

  if (d.command === 'revertComplete') {
    // A partial revert leaves the unselected records in the org — they stay listed and undoable.
    // Re-rendering rebuilds the revert control, or drops it when nothing is left to undo.
    lastJournal = d.remaining || null;
    if (lastJournal) renderChangesTable(lastJournal);
    else safeGet('changes-table') && (safeGet('changes-table').innerHTML = '');
    safeGet('run-status-label') && (safeGet('run-status-label').textContent =
      (d.failed ? '⚠' : '↩') + ' Reverted — deleted ' + (d.deleted || 0) + ', restored ' + (d.restored || 0) +
      (d.failed ? ', ' + d.failed + ' could not be undone' : ''));
    if (d.errors && d.errors.length) {
      var geR = safeGet('global-error');
      if (geR) {
        geR.className = 'global-error visible';
        geR.textContent = '⚠ Revert incomplete: ' + d.errors.slice(0, 5).map(function(e) {
          return e.sobject + ' ' + e.id + ': ' + e.message;
        }).join(' | ') + (d.errors.length > 5 ? ' … +' + (d.errors.length - 5) + ' more' : '');
      }
    }
    return;
  }

  if (d.command === 'revertError') {
    var rb2 = safeGet('revert-run-btn');
    if (rb2) { rb2.disabled = false; rb2.textContent = '↩ Revert this run'; }
    var geR2 = safeGet('global-error');
    if (geR2) { geR2.className = 'global-error visible'; geR2.textContent = '❌ ' + (d.error || 'Revert failed'); }
    return;
  }

  if (d.command === 'migrationError') {
    stopProgressSpinners();
    var ge = safeGet('global-error');
    if (ge) { ge.className = 'global-error visible'; ge.textContent = '❌ ' + (d.error || 'Migration failed'); }
    safeGet('start-run-btn') && (safeGet('start-run-btn').disabled = false);
    safeGet('start-run-btn') && (safeGet('start-run-btn').textContent = '⚡ Start Migration');
    safeGet('back-to-tree-btn') && (safeGet('back-to-tree-btn').disabled = false);
    safeGet('run-status-label') && (safeGet('run-status-label').textContent = '❌ Failed');
    return;
  }

  if (d.command === 'profileSaved') {
    // Show a subtle confirmation in tree toolbar area
    return;
  }

  if (d.command === 'profileLoaded') {
    var profile = d.profile;
    if (!profile || !profile.rootSObject || !profile.nodes) return;
    // Rebuild nodes from profile
    rootSObject = profile.rootSObject;
    nodes = {};
    profile.nodes.forEach(function(nodeConfig) {
      nodes[nodeConfig.sobject] = {
        sobject: nodeConfig.sobject,
        label: nodeConfig.label || nodeConfig.sobject,
        parentSObject: nodeConfig.parentSObject,
        lookupField: nodeConfig.lookupField,
        count: -1, included: true, expanded: true,
        described: nodeConfig.includeFields && nodeConfig.includeFields.length > 0,
        describeLoading: false,
        fields: (nodeConfig.includeFields || []).map(function(fn) {
          return { name: fn, label: fn, type: '', included: true, externalId: false };
        }),
        externalIdFields: nodeConfig.externalIdField
          ? [{ name: nodeConfig.externalIdField, type: 'string' }]
          : [],
        externalIdField: nodeConfig.externalIdField || null,
        childRelationships: [],
        children: []
      };
    });
    // Rebuild parent.children
    profile.nodes.forEach(function(nc) {
      if (nc.parentSObject && nodes[nc.parentSObject]) {
        var parent = nodes[nc.parentSObject];
        if (!parent.children) parent.children = [];
        if (parent.children.indexOf(nc.sobject) < 0) parent.children.push(nc.sobject);
      }
    });
    // Update UI — a loaded profile carries a real query, so switch to Advanced
    // and lock the SOQL so the builder doesn't clobber it.
    pendingRoot = profile.rootSObject;
    soqlManuallyEdited = true;
    if (safeGet('src-soql')) safeGet('src-soql').value = profile.sourceQuery || '';
    setMode('advanced');
    if (safeGet('profile-name')) safeGet('profile-name').value = profile.name || '';
    var profileNameEl = safeGet('loaded-profile-name');
    if (profileNameEl) profileNameEl.textContent = d.fileName || profile.name;
    var loadedBar = safeGet('loaded-profile-bar');
    if (loadedBar) loadedBar.style.display = '';
    var cfgL = safeGet('configure-btn'); if (cfgL) cfgL.disabled = false;
    goToTree();
    return;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   Boot
══════════════════════════════════════════════════════════════════════════ */
// Close the root-object combo when clicking outside of it.
document.addEventListener('mousedown', function(e) {
  var combo = e.target && e.target.closest ? e.target.closest('.combo') : null;
  if (!combo) closeRootList();
});
post({ command: 'panelReady' });
</script>
</body>
</html>`;
  }
}
