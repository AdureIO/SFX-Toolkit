import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runCommand } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { SchemaCache } from "../utils/schemaCache";
import { getCachedOrgList, refreshOrgListCache, warmOrgListCache } from "../utils/orgListCache";
import { generateApexDataFactory, recommendedSelectFields, type RefMapping } from "../utils/apexDataFactory";
import { extractSObjectFromQuery, queryAllRecords, sfRequest, resolveOrgToInfo, type OrgInfo } from "../utils/dataMigration";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvData {
  headers: string[];
  rows: Record<string, string>[];
}

interface CollectionsResult {
  inserted: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(content: string): CsvData {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines
    .slice(1)
    .map((line) => {
      const vals = parseCsvLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
      return row;
    })
    .filter((r) => Object.values(r).some((v) => v !== ""));
  return { headers, rows };
}

function toCsvLine(values: string[]): string {
  return values.map((v) => {
    if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
    return v;
  }).join(",");
}


// ─── SObject Collections API calls ───────────────────────────────────────────

async function runInsert(org: OrgInfo, sobject: string, rows: Record<string, string>[]): Promise<CollectionsResult> {
  return runCollectionsOp(org, sobject, "POST", rows, null);
}

async function runUpdate(org: OrgInfo, sobject: string, rows: Record<string, string>[]): Promise<CollectionsResult> {
  return runCollectionsOp(org, sobject, "PATCH", rows, null);
}

async function runUpsertSingleKey(org: OrgInfo, sobject: string, externalIdField: string, rows: Record<string, string>[]): Promise<CollectionsResult> {
  return runCollectionsOp(org, sobject, "PATCH", rows, externalIdField);
}

async function runDelete(org: OrgInfo, sobject: string, rows: Record<string, string>[]): Promise<CollectionsResult> {
  const ids = rows.map((r) => r["Id"] ?? r["id"] ?? "").filter(Boolean);
  const total: CollectionsResult = { inserted: 0, updated: 0, failed: 0, errors: [] };
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const resp = await sfRequest(org.instanceUrl, `/services/data/v${org.apiVersion}/composite/sobjects?ids=${chunk.join(",")}&allOrNone=false`, "DELETE", org.accessToken);
    if (resp.status >= 200 && resp.status < 300) {
      try {
        const results: Array<{ success: boolean; errors?: Array<{ message: string }> }> = JSON.parse(resp.body);
        results.forEach((r, idx) => {
          if (r.success) total.updated++;
          else { total.failed++; total.errors.push({ row: i + idx, message: r.errors?.[0]?.message ?? "Unknown error" }); }
        });
      } catch { total.updated += chunk.length; }
    } else {
      total.failed += chunk.length;
      total.errors.push({ row: i, message: `HTTP ${resp.status}: ${resp.body.substring(0, 200)}` });
    }
  }
  return total;
}

async function runCollectionsOp(
  org: OrgInfo, sobject: string, method: "POST" | "PATCH",
  rows: Record<string, string>[], upsertField: string | null
): Promise<CollectionsResult> {
  const total: CollectionsResult = { inserted: 0, updated: 0, failed: 0, errors: [] };
  const BATCH = 200;
  const urlPath = upsertField
    ? `/services/data/v${org.apiVersion}/composite/sobjects/${sobject}/${upsertField}`
    : `/services/data/v${org.apiVersion}/composite/sobjects`;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const body = {
      allOrNone: false,
      records: chunk.map((row) => {
        const rec: Record<string, string> = { attributes: { type: sobject } as unknown as string };
        Object.entries(row).forEach(([k, v]) => { if (k !== "attributes") rec[k] = v; });
        return rec;
      })
    };
    const resp = await sfRequest(org.instanceUrl, urlPath, method, org.accessToken, body);
    if (resp.status >= 200 && resp.status < 300) {
      try {
        const results: Array<{ id: string | null; success: boolean; created?: boolean; errors?: Array<{ message: string }> }> = JSON.parse(resp.body);
        results.forEach((r, idx) => {
          if (r.success) {
            if (r.created) total.inserted++; else total.updated++;
          } else {
            total.failed++;
            total.errors.push({ row: i + idx, message: r.errors?.[0]?.message ?? "Unknown error" });
          }
        });
      } catch {
        total.inserted += chunk.length;
      }
    } else {
      total.failed += chunk.length;
      total.errors.push({ row: i, message: `HTTP ${resp.status}: ${resp.body.substring(0, 300)}` });
    }
  }
  return total;
}

// ─── Composite-key upsert ─────────────────────────────────────────────────────

async function runCompositeKeyUpsert(
  org: OrgInfo, sobject: string, keyFields: string[], rows: Record<string, string>[]
): Promise<CollectionsResult> {
  // Step 1: collect unique values per key field for the SOQL query
  const valSets: Record<string, Set<string>> = {};
  keyFields.forEach((f) => { valSets[f] = new Set(); });
  rows.forEach((r) => keyFields.forEach((f) => { if (r[f]) valSets[f].add(r[f]); }));

  // Step 2: query existing records via REST API (no row limits, no CLI dependency)
  const selectFields = ["Id", ...keyFields].join(", ");
  const where = keyFields.map((f) => {
    const escaped = Array.from(valSets[f]).map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
    return `${f} IN (${escaped || "'__NONE__'"})`;
  }).join(" AND ");
  const soql = `SELECT ${selectFields} FROM ${sobject} WHERE ${where}`;

  // Step 3: build lookup map compositeKey → Salesforce Id
  const existingMap = new Map<string, string>();
  try {
    const existingRows = await queryAllRecords(org, soql);
    existingRows.forEach((qr) => {
      const compositeKey = keyFields.map((f) => qr[f] ?? "").join("|");
      if (compositeKey && qr["Id"]) existingMap.set(compositeKey, qr["Id"]);
    });
  } catch { /* best-effort — treat all rows as insert if query fails */ }

  // Step 4: split rows into insert vs update
  const toInsert: Record<string, string>[] = [];
  const toUpdate: Record<string, string>[] = [];
  rows.forEach((row) => {
    const compositeKey = keyFields.map((f) => row[f] ?? "").join("|");
    const existingId = existingMap.get(compositeKey);
    if (existingId) {
      toUpdate.push({ ...row, Id: existingId });
    } else {
      const clean = { ...row };
      delete clean["Id"]; delete clean["id"];
      toInsert.push(clean);
    }
  });

  // Step 5: run insert + update
  const insertResult = toInsert.length > 0 ? await runInsert(org, sobject, toInsert) : { inserted: 0, updated: 0, failed: 0, errors: [] };
  const updateResult = toUpdate.length > 0 ? await runUpdate(org, sobject, toUpdate) : { inserted: 0, updated: 0, failed: 0, errors: [] };

  return {
    inserted: insertResult.inserted + insertResult.updated,
    updated: updateResult.inserted + updateResult.updated,
    failed: insertResult.failed + updateResult.failed,
    errors: [...insertResult.errors, ...updateResult.errors.map((e) => ({ ...e, row: e.row + toInsert.length }))]
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class DataToolsPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.dataTools";

  private static _lastFilePath: string | null = null;
  private static _lastCsvData: CsvData | null = null;

  public static async show(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showErrorMessage("No workspace open."); return; }
    const workspaceRoot = folder.uri.fsPath;

    const panel = vscode.window.createWebviewPanel(DataToolsPanelProvider.viewType, "Data Export / Import", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = DataToolsPanelProvider.getHtml();

    // Warm caches in background on panel open
    warmOrgListCache();
    AuthInfo.warmAuthForOrg(null);

    panel.webview.onDidReceiveMessage(async (msg: {
      command: string;
      query?: string; org?: string; format?: string; outputFile?: string;
      sobject?: string; operation?: string;
      externalIdMode?: "single" | "composite";
      externalIdField?: string; externalIdFields?: string[];
      // Apex factory options
      apexClassName?: string;
      apexExtIdField?: string;
      apexSkipEmpty?: boolean;
      apexGenInsert?: boolean;
      apexGenUpsert?: boolean;
      apexRefMappings?: RefMapping[];
    }) => {
      if (msg.command === "panelReady") {
        const cached = getCachedOrgList();
        const orgs = cached ?? await refreshOrgListCache();
        panel.webview.postMessage({ command: "init", orgs, defaultOrg: orgs[0]?.username ?? "" });
        return;
      }

      // ── Refresh cache ─────────────────────────────────────────────────────
      if (msg.command === "refreshCache") {
        const orgToRefresh = msg.org || null;
        AuthInfo.invalidateOrg(orgToRefresh);
        SchemaCache.invalidate(orgToRefresh);
        const orgs = await refreshOrgListCache();
        panel.webview.postMessage({ command: "cacheRefreshed", orgs });
        return;
      }

      // ── Export ─────────────────────────────────────────────────────────────
      if (msg.command === "export") {
        const { query = "", org = "", format = "csv" } = msg;
        if (!query.trim()) { panel.webview.postMessage({ command: "exportError", error: "SOQL query is required." }); return; }
        if (!org) { panel.webview.postMessage({ command: "exportError", error: "Select a target org." }); return; }
        panel.webview.postMessage({ command: "exportProgress", message: "Running query…" });
        try {
          const resultFormat = format === "json" ? "json" : "csv";
          const safeQuery = query.replace(/"/g, '\\"').replace(/\r?\n/g, " ");
          const output = await runCommand(
            `sf data query --query "${safeQuery}" --result-format ${resultFormat} -o "${org}"`,
            workspaceRoot, undefined, false, undefined, 60000
          );
          // Parse row count
          const { rows } = parseCsv(output);
          const rowCount = resultFormat === "csv" ? rows.length : (() => { try { const p = JSON.parse(output); return (p.result?.records ?? p.records ?? []).length; } catch { return 0; } })();
          // Save to workspace
          const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 16);
          const fname = `export-${ts}.${resultFormat}`;
          const outPath = path.join(workspaceRoot, fname);
          fs.writeFileSync(outPath, output, "utf8");
          panel.webview.postMessage({ command: "exportDone", rowCount, outputFile: fname, outputPath: outPath });
        } catch (e) {
          panel.webview.postMessage({ command: "exportError", error: String(e instanceof Error ? e.message : e).substring(0, 500) });
        }
        return;
      }

      // ── Export as Apex Data Factory ───────────────────────────────────────
      if (msg.command === "exportApex") {
        const {
          query = "", org = "",
          apexClassName = "", apexExtIdField = "",
          apexSkipEmpty = true, apexGenInsert = true, apexGenUpsert = true,
          apexRefMappings = []
        } = msg;
        if (!query.trim()) { panel.webview.postMessage({ command: "apexError", error: "SOQL query is required." }); return; }
        if (!org) { panel.webview.postMessage({ command: "apexError", error: "Select a target org." }); return; }
        panel.webview.postMessage({ command: "apexProgress", message: "Resolving org credentials…" });
        try {
          // Resolve org auth + describe object in parallel
          const sobject = extractSObjectFromQuery(query);
          panel.webview.postMessage({ command: "apexProgress", message: `Describing ${sobject}…` });
          const [orgInfo, describe] = await Promise.all([
            resolveOrgToInfo(org || null),
            SchemaCache.getRichDescribe(org || null, sobject)
          ]);
          if (!describe) throw new Error(`Could not describe ${sobject} — check org credentials.`);
          const fieldTypeMap: Record<string, import("../utils/apexDataFactory").FieldTypeDef> = {};
          describe.fields.forEach((f) => { fieldTypeMap[f.name] = f; });
          // Build recommended SELECT list if query uses SELECT *-style or user didn't specify fields
          const creatableFields = recommendedSelectFields(fieldTypeMap);
          // Rewrite query with all createable fields (preserving WHERE/ORDER/LIMIT)
          const safeQuery = query.replace(/SELECT\s+.+?\s+FROM/is,
            `SELECT Id,${creatableFields.join(",")} FROM`);
          panel.webview.postMessage({ command: "apexProgress", message: "Querying records…" });
          // Query via REST (no row limits, paginated)
          const records = await queryAllRecords(orgInfo, safeQuery, (done, total) => {
            panel.webview.postMessage({ command: "apexProgress", message: `Fetching records… ${done}${total > 0 ? "/" + total : ""}` });
          });
          if (records.length === 0) {
            panel.webview.postMessage({ command: "apexError", error: "Query returned 0 records — nothing to generate." });
            return;
          }
          // Derive class name
          const className = (apexClassName || sobject + "DataFactory").replace(/[^a-zA-Z0-9_]/g, "_");
          panel.webview.postMessage({ command: "apexProgress", message: `Generating Apex for ${records.length} records…` });
          const apex = generateApexDataFactory(records, {
            className,
            sobject,
            externalIdField: apexExtIdField || null,
            skipEmptyFields: apexSkipEmpty,
            generateInsert: apexGenInsert,
            generateUpsert: apexGenUpsert,
            refMappings: apexRefMappings,
            fieldTypes: fieldTypeMap
          });
          // Save to workspace
          const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 16);
          const fname = `${className}-${ts}.apex`;
          const outPath = path.join(workspaceRoot, fname);
          fs.writeFileSync(outPath, apex, "utf8");
          Logger.info(`Apex data factory generated: ${fname} (${records.length} records)`);
          panel.webview.postMessage({
            command: "apexDone",
            rowCount: records.length,
            outputFile: fname,
            outputPath: outPath,
            className,
            lineCount: apex.split("\n").length
          });
        } catch (e) {
          panel.webview.postMessage({ command: "apexError", error: (e instanceof Error ? e.message : String(e)).substring(0, 500) });
        }
        return;
      }

      // ── Describe object for Apex options ──────────────────────────────────
      if (msg.command === "describeForApex") {
        const { query = "", org = "" } = msg;
        if (!query.trim() || !org) return;
        try {
          const sobject = extractSObjectFromQuery(query);
          const describe = await SchemaCache.getRichDescribe(org || null, sobject);
          if (!describe) return;
          const extIdFields = describe.fields
            .filter((f) => f.externalId || f.unique)
            .map((f) => ({ name: f.name, type: f.type, label: f.label }));
          const refFields = describe.fields
            .filter((f) => f.type === "reference" && f.createable)
            .map((f) => ({ name: f.name, referenceTo: f.referenceTo, label: f.label }));
          panel.webview.postMessage({ command: "apexDescribed", sobject, extIdFields, refFields });
        } catch { /* silent — user can still type manually */ }
        return;
      }

      // ── Browse file ────────────────────────────────────────────────────────
      if (msg.command === "browseFile") {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { "CSV / JSON": ["csv", "json"] }, title: "Select import file" });
        if (!uris?.length) return;
        const filePath = uris[0].fsPath;
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const csvData = parseCsv(content);
          DataToolsPanelProvider._lastFilePath = filePath;
          DataToolsPanelProvider._lastCsvData = csvData;
          const sobjectGuess = path.basename(filePath, path.extname(filePath)).replace(/[-_].*$/, "");
          panel.webview.postMessage({
            command: "fileLoaded",
            filePath,
            fileName: path.basename(filePath),
            headers: csvData.headers,
            previewRows: csvData.rows.slice(0, 5),
            totalRows: csvData.rows.length,
            sobjectGuess
          });
        } catch (e) {
          panel.webview.postMessage({ command: "importError", error: `Could not read file: ${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      // ── Import ─────────────────────────────────────────────────────────────
      if (msg.command === "import") {
        const { org = "", sobject = "", operation = "Insert", externalIdMode = "single", externalIdField = "", externalIdFields = [] } = msg;
        if (!org) { panel.webview.postMessage({ command: "importError", error: "Select a target org." }); return; }
        if (!sobject.trim()) { panel.webview.postMessage({ command: "importError", error: "Enter a SObject API name." }); return; }
        if (!DataToolsPanelProvider._lastFilePath || !DataToolsPanelProvider._lastCsvData) {
          panel.webview.postMessage({ command: "importError", error: "Select a file first." }); return;
        }
        const csvData = DataToolsPanelProvider._lastCsvData;
        if (!csvData.rows.length) { panel.webview.postMessage({ command: "importError", error: "File contains no data rows." }); return; }
        panel.webview.postMessage({ command: "importProgress", done: 0, total: csvData.rows.length, inserted: 0, updated: 0, failed: 0 });

        try {
          const orgInfo = await resolveOrgToInfo(org || null);
          let result: CollectionsResult;

          switch (operation) {
            case "Insert":
              result = await runInsert(orgInfo, sobject, csvData.rows);
              break;
            case "Update":
              result = await runUpdate(orgInfo, sobject, csvData.rows);
              break;
            case "Delete":
              result = await runDelete(orgInfo, sobject, csvData.rows);
              break;
            case "Upsert":
              if (externalIdMode === "composite" && externalIdFields.length >= 2) {
                result = await runCompositeKeyUpsert(orgInfo, sobject, externalIdFields, csvData.rows);
              } else if (externalIdField) {
                result = await runUpsertSingleKey(orgInfo, sobject, externalIdField, csvData.rows);
              } else {
                panel.webview.postMessage({ command: "importError", error: "Select an external ID field for upsert." }); return;
              }
              break;
            default:
              panel.webview.postMessage({ command: "importError", error: `Unknown operation: ${operation}` }); return;
          }

          Logger.info(`Data import done: +${result.inserted} inserted, ~${result.updated} updated, x${result.failed} failed`);
          panel.webview.postMessage({ command: "importDone", ...result });
        } catch (e) {
          const msg2 = e instanceof Error ? e.message : String(e);
          panel.webview.postMessage({ command: "importError", error: msg2.substring(0, 500) });
        }
        return;
      }

      // ── Open exported file ─────────────────────────────────────────────────
      if (msg.command === "openFile") {
        const fp = (msg as { command: string; filePath?: string; outputFile?: string }).filePath
          ?? (msg as { command: string; filePath?: string; outputFile?: string }).outputFile;
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
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; min-height: 100vh; display: flex; flex-direction: column; }
    .page-header { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .page-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    .tab-btn { padding: 8px 18px; font-size: 12px; cursor: pointer; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); font-family: inherit; transition: color 0.1s; }
    .tab-btn.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-button-background); font-weight: 600; }
    .tab-btn:hover:not(.active) { color: var(--vscode-foreground); }
    .tab-content { display: none; flex: 1; overflow-y: auto; padding: 16px; flex-direction: column; gap: 14px; }
    .tab-content.active { display: flex; }
    .field-block { display: flex; flex-direction: column; gap: 5px; }
    .field-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    .field-block select, .field-block input[type="text"] { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: inherit; outline: none; }
    .field-block select:focus, .field-block input:focus { border-color: var(--vscode-focusBorder); }
    .field-block textarea { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); outline: none; resize: vertical; min-height: 80px; }
    .field-block textarea:focus { border-color: var(--vscode-focusBorder); }
    .pill-group { display: flex; flex-wrap: wrap; gap: 4px; }
    .pill-group label { margin: 0; cursor: pointer; display: flex; align-items: center; padding: 3px 10px; border-radius: 10px; font-size: 11px; border: 1px solid var(--vscode-button-border); background: transparent; color: var(--vscode-foreground); opacity: 0.7; user-select: none; }
    .pill-group label:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .pill-group label:has(input:checked) { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; opacity: 1; }
    .pill-group input[type="radio"], .pill-group input[type="checkbox"] { display: none; }
    .btn-primary { padding: 8px 16px; font-size: 13px; font-weight: 600; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-family: inherit; }
    .btn-primary:hover { filter: brightness(1.1); }
    .btn-secondary { padding: 6px 12px; font-size: 12px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border); border-radius: 3px; cursor: pointer; opacity: 0.8; font-family: inherit; }
    .btn-secondary:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .file-row { display: flex; align-items: center; gap: 8px; }
    .file-name { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .result-bar { padding: 8px 12px; border-radius: 3px; font-size: 12px; font-weight: 500; border-left: 3px solid transparent; line-height: 1.5; display: none; }
    .result-bar.running { border-left-color: var(--vscode-progressBar-background); background: color-mix(in srgb, var(--vscode-progressBar-background) 10%, transparent); }
    .result-bar.success { border-left-color: #4ec94e; background: color-mix(in srgb, #4ec94e 10%, transparent); }
    .result-bar.error { border-left-color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
    .preview-wrap { overflow-x: auto; border: 1px solid var(--vscode-panel-border); border-radius: 3px; }
    .preview-table { border-collapse: collapse; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); white-space: nowrap; min-width: 100%; }
    .preview-table th { background: var(--vscode-editor-inactiveSelectionBackground); padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-weight: 600; text-align: left; }
    .preview-table td { padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
    .preview-table tr:last-child td { border-bottom: none; }
    .section-divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 2px 0; }
    .errors-list { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); max-height: 160px; overflow-y: auto; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 6px 8px; display: none; }
    .errors-list.visible { display: block; }
    .error-row { color: var(--vscode-errorForeground); padding: 2px 0; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .composite-fields { display: flex; flex-direction: column; gap: 4px; padding: 6px 0; }
    .composite-field-check { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
    .composite-field-check input { cursor: pointer; }
    .upsert-section { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; display: none; flex-direction: column; gap: 10px; }
    .upsert-section.visible { display: flex; }
    .ext-single { display: flex; flex-direction: column; gap: 5px; }
    .ext-composite { display: flex; flex-direction: column; gap: 5px; }
    .ext-single, .ext-composite { display: none; }
    .ext-single.visible, .ext-composite.visible { display: flex; }
    .stat-row { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12px; padding: 4px 0; }
    .stat { display: flex; align-items: center; gap: 5px; }
    .stat-num { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
    .stat-ins { color: #4ec94e; }
    .stat-upd { color: var(--vscode-textLink-foreground); }
    .stat-err { color: var(--vscode-errorForeground); }
    .toggle-errors { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; margin-top: 4px; }
    .toggle-errors:hover { text-decoration: underline; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* ── Apex tab ── */
    .apex-options { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; background: var(--vscode-input-background); display: none; flex-direction: column; gap: 10px; }
    .apex-options.visible { display: flex; }
    .apex-options-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
    .apex-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .apex-check-row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
    .apex-check-row input { cursor: pointer; }
    .ref-map-table { display: flex; flex-direction: column; gap: 4px; }
    .ref-map-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap: 6px; align-items: center; }
    .ref-map-row input { padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family,monospace); outline: none; width: 100%; }
    .ref-map-row input:focus { border-color: var(--vscode-focusBorder); }
    .ref-map-header { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr auto; gap: 6px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--vscode-descriptionForeground); padding: 0 0 2px 0; }
    .btn-add-ref { padding: 3px 10px; font-size: 11px; border: 1px dashed var(--vscode-button-border); border-radius: 3px; background: transparent; cursor: pointer; color: var(--vscode-foreground); opacity: .7; font-family: inherit; }
    .btn-add-ref:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .btn-del-ref { padding: 2px 7px; font-size: 11px; background: transparent; border: none; cursor: pointer; color: var(--vscode-errorForeground); opacity: .6; }
    .btn-del-ref:hover { opacity: 1; }
    .apex-field-block select, .apex-field-block input[type="text"] { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: inherit; outline: none; }
    .apex-field-block { display: flex; flex-direction: column; gap: 4px; }
    .apex-field-block .field-label { font-size: 10px; }
  </style>
</head>
<body>
<div class="page-header">
  <span class="page-title">📂 Data Export / Import</span>
  <div style="margin-left:auto; display:flex; align-items:center; gap:8px;">
    <span id="cache-status-lbl" style="font-size:10px; color:var(--vscode-descriptionForeground);"></span>
    <button id="refresh-cache-btn" onclick="refreshCache()" title="Refresh org list &amp; metadata cache" style="padding:3px 8px; font-size:11px; background:transparent; color:var(--vscode-descriptionForeground); border:1px solid var(--vscode-panel-border); border-radius:3px; cursor:pointer; font-family:inherit; opacity:.8;">🔄 Refresh cache</button>
  </div>
</div>
<div class="tabs">
  <button class="tab-btn active" id="tab-export-btn" onclick="switchTab('export')">📤 Export</button>
  <button class="tab-btn" id="tab-import-btn" onclick="switchTab('import')">📥 Import</button>
  <button class="tab-btn" id="tab-apex-btn" onclick="switchTab('apex')">⚡ Apex Factory</button>
</div>

<!-- EXPORT TAB -->
<div class="tab-content active" id="tab-export">
  <div class="field-block">
    <label class="field-label" for="exp-org">Target org</label>
    <select id="exp-org"></select>
  </div>
  <div class="field-block">
    <label class="field-label" for="exp-query">SOQL query</label>
    <textarea id="exp-query" placeholder="SELECT Id, Name, Email FROM Contact WHERE CreatedDate = TODAY LIMIT 1000"></textarea>
  </div>
  <div class="field-block">
    <span class="field-label">Output format</span>
    <div class="pill-group">
      <label><input type="radio" name="expFormat" value="csv" checked> CSV</label>
      <label><input type="radio" name="expFormat" value="json"> JSON</label>
    </div>
  </div>
  <button class="btn-primary" onclick="doExport()">📤 Export to workspace</button>
  <div class="result-bar" id="exp-result"></div>
</div>

<!-- IMPORT TAB -->
<div class="tab-content" id="tab-import">
  <div class="field-block">
    <label class="field-label" for="imp-org">Target org</label>
    <select id="imp-org"></select>
  </div>
  <div class="field-block">
    <label class="field-label" for="imp-sobject">SObject API name</label>
    <input type="text" id="imp-sobject" placeholder="e.g. Account, Contact, My_Custom_Obj__c" />
  </div>
  <div class="field-block">
    <span class="field-label">Source file (CSV)</span>
    <div class="file-row">
      <button class="btn-secondary" onclick="browseFile()">Browse…</button>
      <span class="file-name" id="imp-filename">No file selected</span>
    </div>
    <span class="hint" id="imp-rowcount"></span>
  </div>

  <!-- Preview table (shown after file loaded) -->
  <div id="preview-section" style="display:none; flex-direction:column; gap:6px;">
    <span class="field-label">Preview (first rows)</span>
    <div class="preview-wrap"><table class="preview-table" id="preview-table"></table></div>
  </div>

  <hr class="section-divider">

  <div class="field-block">
    <span class="field-label">Operation</span>
    <div class="pill-group">
      <label><input type="radio" name="impOp" value="Insert" checked onchange="onOpChange(this.value)"> Insert</label>
      <label><input type="radio" name="impOp" value="Update" onchange="onOpChange(this.value)"> Update</label>
      <label><input type="radio" name="impOp" value="Upsert" onchange="onOpChange(this.value)"> Upsert</label>
      <label><input type="radio" name="impOp" value="Delete" onchange="onOpChange(this.value)"> Delete</label>
    </div>
  </div>

  <!-- Upsert options -->
  <div class="upsert-section" id="upsert-section">
    <div class="field-block">
      <span class="field-label">External ID mode</span>
      <div class="pill-group">
        <label><input type="radio" name="extMode" value="single" checked onchange="onExtModeChange(this.value)"> Single field</label>
        <label><input type="radio" name="extMode" value="composite" onchange="onExtModeChange(this.value)"> Composite key (2–3 fields)</label>
      </div>
    </div>
    <div class="ext-single visible" id="ext-single">
      <div class="field-block">
        <label class="field-label" for="ext-field-select">External ID field</label>
        <select id="ext-field-select"></select>
      </div>
    </div>
    <div class="ext-composite" id="ext-composite">
      <span class="field-label">Select 2–3 key fields</span>
      <div class="composite-fields" id="composite-fields-list"></div>
      <span class="hint">Records matching ALL selected fields will be updated; unmatched records will be inserted.</span>
    </div>
  </div>

  <button class="btn-primary" id="imp-btn" onclick="doImport()">⚡ Run Import</button>
  <div class="result-bar" id="imp-result"></div>
  <div id="imp-stats" style="display:none;" class="stat-row">
    <div class="stat"><span class="stat-num stat-ins" id="stat-ins">0</span> inserted</div>
    <div class="stat"><span class="stat-num stat-upd" id="stat-upd">0</span> updated</div>
    <div class="stat"><span class="stat-num stat-err" id="stat-err">0</span> failed</div>
  </div>
  <span class="toggle-errors" id="toggle-errors" style="display:none;" onclick="toggleErrors()"></span>
  <div class="errors-list" id="errors-list"></div>
</div>

<script>
  var vsc = null;
  try { if (typeof acquireVsCodeApi !== 'undefined') vsc = acquireVsCodeApi(); } catch(e) {}
  function post(msg) { try { if (vsc) vsc.postMessage(msg); } catch(e) {} }
  function safeGet(id) { return document.getElementById(id); }
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  var orgsData = [], currentHeaders = [], currentErrors = [];

  function switchTab(t) {
    ['export','import'].forEach(function(n) {
      safeGet('tab-'+n).classList.toggle('active', n === t);
      safeGet('tab-'+n+'-btn').classList.toggle('active', n === t);
    });
  }

  function onOpChange(val) {
    var sec = safeGet('upsert-section');
    if (sec) sec.classList.toggle('visible', val === 'Upsert');
  }

  function onExtModeChange(val) {
    var single = safeGet('ext-single');
    var composite = safeGet('ext-composite');
    if (single) single.classList.toggle('visible', val === 'single');
    if (composite) composite.classList.toggle('visible', val === 'composite');
  }

  function refreshCache() {
    var org = (safeGet('exp-org') && safeGet('exp-org').value)
      || (safeGet('imp-org') && safeGet('imp-org').value) || '';
    var btn = safeGet('refresh-cache-btn');
    var lbl = safeGet('cache-status-lbl');
    if (btn) btn.style.opacity = '0.4';
    if (lbl) lbl.textContent = 'Refreshing…';
    post({ command: 'refreshCache', org: org });
  }

  function renderOrgSelect(selId, defaultOrg) {
    var sel = safeGet(selId);
    if (!sel) return;
    sel.innerHTML = (orgsData.length ? '' : '<option value="">No orgs found</option>') +
      orgsData.map(function(o) { return '<option value="'+escHtml(o.username)+'">'+escHtml(o.label)+'</option>'; }).join('');
    if (defaultOrg) sel.value = defaultOrg;
  }

  function renderFieldDropdown(selId, headers) {
    var sel = safeGet(selId);
    if (!sel) return;
    sel.innerHTML = headers.map(function(h) { return '<option value="'+escHtml(h)+'">'+escHtml(h)+'</option>'; }).join('');
  }

  function renderCompositeCheckboxes(headers) {
    var container = safeGet('composite-fields-list');
    if (!container) return;
    container.innerHTML = headers.map(function(h) {
      return '<label class="composite-field-check"><input type="checkbox" value="'+escHtml(h)+'"> '+escHtml(h)+'</label>';
    }).join('');
  }

  function renderPreview(headers, rows) {
    var tbl = safeGet('preview-table');
    if (!tbl) return;
    var html = '<tr>'+headers.map(function(h) { return '<th>'+escHtml(h)+'</th>'; }).join('')+'</tr>';
    rows.forEach(function(row) {
      html += '<tr>'+headers.map(function(h) { return '<td>'+escHtml(row[h]||'')+'</td>'; }).join('')+'</tr>';
    });
    tbl.innerHTML = html;
    var sec = safeGet('preview-section');
    if (sec) sec.style.display = 'flex';
  }

  function setResultBar(id, cls, msg) {
    var el = safeGet(id);
    if (!el) return;
    el.className = 'result-bar ' + cls;
    el.textContent = msg;
    el.style.display = 'block';
  }

  function browseFile() { post({ command: 'browseFile' }); }

  function doExport() {
    var org = safeGet('exp-org') && safeGet('exp-org').value;
    var query = safeGet('exp-query') && safeGet('exp-query').value;
    var format = (document.querySelector('input[name="expFormat"]:checked') || {}).value || 'csv';
    setResultBar('exp-result', 'running', '⏳ Exporting…');
    post({ command: 'export', org: org, query: query, format: format });
  }

  function doImport() {
    var org = safeGet('imp-org') && safeGet('imp-org').value;
    var sobject = safeGet('imp-sobject') && safeGet('imp-sobject').value;
    var operation = (document.querySelector('input[name="impOp"]:checked') || {}).value || 'Insert';
    var extMode = (document.querySelector('input[name="extMode"]:checked') || {}).value || 'single';
    var extField = safeGet('ext-field-select') && safeGet('ext-field-select').value;
    var extFields = [];
    document.querySelectorAll('#composite-fields-list input:checked').forEach(function(cb) { extFields.push(cb.value); });
    setResultBar('imp-result', 'running', '⏳ Running import…');
    safeGet('imp-stats') && (safeGet('imp-stats').style.display = 'none');
    safeGet('toggle-errors') && (safeGet('toggle-errors').style.display = 'none');
    safeGet('errors-list') && (safeGet('errors-list').classList.remove('visible'));
    post({ command: 'import', org: org, sobject: sobject, operation: operation, externalIdMode: extMode, externalIdField: extField, externalIdFields: extFields });
  }

  function toggleErrors() {
    var list = safeGet('errors-list');
    if (!list) return;
    var shown = list.classList.toggle('visible');
    var tog = safeGet('toggle-errors');
    if (tog) tog.textContent = shown ? '▲ Hide errors' : '▼ Show errors (' + currentErrors.length + ')';
  }

  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || !d.command) return;

    if (d.command === 'init') {
      orgsData = d.orgs || [];
      renderOrgSelect('exp-org', d.defaultOrg);
      renderOrgSelect('imp-org', d.defaultOrg);
      renderOrgSelect('apex-org', d.defaultOrg);
      return;
    }
    if (d.command === 'cacheRefreshed') {
      var btn = safeGet('refresh-cache-btn');
      var lbl = safeGet('cache-status-lbl');
      if (btn) btn.style.opacity = '0.8';
      if (d.orgs) {
        var prevExp = safeGet('exp-org') && safeGet('exp-org').value;
        var prevImp = safeGet('imp-org') && safeGet('imp-org').value;
        var prevApex = safeGet('apex-org') && safeGet('apex-org').value;
        orgsData = d.orgs;
        renderOrgSelect('exp-org', prevExp || d.orgs[0].username);
        renderOrgSelect('imp-org', prevImp || d.orgs[0].username);
        renderOrgSelect('apex-org', prevApex || d.orgs[0].username);
      }
      if (lbl) {
        var t = new Date(); lbl.textContent = 'Cache updated ' + t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0');
        setTimeout(function() { if (lbl) lbl.textContent = ''; }, 5000);
      }
      return;
    }
    if (d.command === 'exportProgress') {
      setResultBar('exp-result', 'running', '⏳ ' + (d.message || 'Working…'));
      return;
    }
    if (d.command === 'exportDone') {
      setResultBar('exp-result', 'success', '✅ Exported ' + d.rowCount + ' row' + (d.rowCount !== 1 ? 's' : '') + ' → ' + escHtml(d.outputFile));
      var bar = safeGet('exp-result');
      if (bar) {
        bar.style.cursor = 'pointer';
        bar.title = 'Click to open file';
        bar.onclick = function() { post({ command: 'openFile', outputFile: d.outputPath }); };
      }
      return;
    }
    if (d.command === 'exportError') {
      setResultBar('exp-result', 'error', '❌ ' + escHtml(d.error || 'Export failed'));
      return;
    }
    if (d.command === 'fileLoaded') {
      currentHeaders = d.headers || [];
      safeGet('imp-filename') && (safeGet('imp-filename').textContent = d.fileName || '');
      safeGet('imp-rowcount') && (safeGet('imp-rowcount').textContent = d.totalRows + ' row' + (d.totalRows !== 1 ? 's' : '') + ', ' + currentHeaders.length + ' column' + (currentHeaders.length !== 1 ? 's' : ''));
      if (d.sobjectGuess) { var s = safeGet('imp-sobject'); if (s && !s.value) s.value = d.sobjectGuess; }
      renderPreview(d.headers || [], d.previewRows || []);
      renderFieldDropdown('ext-field-select', d.headers || []);
      renderCompositeCheckboxes(d.headers || []);
      return;
    }
    if (d.command === 'importProgress') {
      setResultBar('imp-result', 'running', '⏳ Processing… ' + d.done + ' / ' + d.total);
      return;
    }
    if (d.command === 'importDone') {
      var ins = d.inserted || 0, upd = d.updated || 0, fail = d.failed || 0;
      var cls = fail > 0 && (ins + upd) === 0 ? 'error' : fail > 0 ? 'running' : 'success';
      var msg = (fail === 0 ? '✅' : fail < ins + upd ? '⚠' : '❌') + ' Import complete — ' + ins + ' inserted, ' + upd + ' updated, ' + fail + ' failed';
      setResultBar('imp-result', cls, msg);
      safeGet('stat-ins') && (safeGet('stat-ins').textContent = ins);
      safeGet('stat-upd') && (safeGet('stat-upd').textContent = upd);
      safeGet('stat-err') && (safeGet('stat-err').textContent = fail);
      safeGet('imp-stats') && (safeGet('imp-stats').style.display = 'flex');
      currentErrors = d.errors || [];
      var togEl = safeGet('toggle-errors');
      if (currentErrors.length > 0 && togEl) {
        togEl.textContent = '▼ Show errors (' + currentErrors.length + ')';
        togEl.style.display = '';
        var errList = safeGet('errors-list');
        if (errList) errList.innerHTML = currentErrors.map(function(e) {
          return '<div class="error-row">Row ' + (e.row + 2) + ': ' + escHtml(e.message) + '</div>';
        }).join('');
      }
      return;
    }
    if (d.command === 'importError') {
      setResultBar('imp-result', 'error', '❌ ' + escHtml(d.error || 'Import failed'));
      return;
    }

    /* ── Apex factory responses ── */
    if (d.command === 'apexProgress') {
      setResultBar('apex-result', 'running', '<span class="spinner" style="display:inline-block;width:11px;height:11px;border:2px solid var(--vscode-progressBar-background);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:5px;"></span>' + escHtml(d.message || 'Working…'));
      return;
    }
    if (d.command === 'apexDone') {
      var bar2 = safeGet('apex-result');
      if (bar2) {
        bar2.className = 'result-bar success';
        bar2.style.display = 'block';
        bar2.innerHTML = '✅ <strong>' + escHtml(d.className) + '</strong> — '
          + d.rowCount + ' record' + (d.rowCount!==1?'s':'') + ', '
          + d.lineCount + ' lines → <span style="font-family:var(--vscode-editor-font-family,monospace);cursor:pointer;text-decoration:underline;" onclick="post({command:\'openFile\',filePath:\'' + escHtml(d.outputPath||'') + '\'})">' + escHtml(d.outputFile) + '</span>';
      }
      return;
    }
    if (d.command === 'apexError') {
      setResultBar('apex-result', 'error', '❌ ' + escHtml(d.error || 'Generation failed'));
      return;
    }
    if (d.command === 'apexDescribed') {
      // Populate external ID dropdown
      var extSel = safeGet('apex-extid');
      if (extSel) {
        var curVal = extSel.value;
        extSel.innerHTML = '<option value="">(Insert — no upsert key)</option>'
          + (d.extIdFields||[]).map(function(f) {
              return '<option value="'+escHtml(f.name)+'"'+(curVal===f.name?' selected':'')+'>'
                +escHtml(f.name)+' — '+escHtml(f.label)+' ('+escHtml(f.type)+')</option>';
            }).join('');
        if (curVal) extSel.value = curVal;
      }
      // Populate ref field hints
      apexRefFieldOptions = d.refFields || [];
      refreshRefHints();
      return;
    }
  });

  /* ── Apex tab state ── */
  var apexRefMappings = [];
  var apexRefFieldOptions = [];

  function switchTabWithApex(t) {
    ['export','import','apex'].forEach(function(n) {
      safeGet('tab-'+n) && safeGet('tab-'+n).classList.toggle('active', n===t);
      safeGet('tab-'+n+'-btn') && safeGet('tab-'+n+'-btn').classList.toggle('active', n===t);
    });
    if (t === 'apex') triggerApexDescribe();
  }

  function triggerApexDescribe() {
    var org = safeGet('apex-org') && safeGet('apex-org').value;
    var q = safeGet('apex-query') && safeGet('apex-query').value.trim();
    if (org && q) post({ command: 'describeForApex', org: org, query: q });
  }

  function refreshRefHints() {
    // Update ref-map-row placeholders with known reference fields
    document.querySelectorAll('.ref-field-input').forEach(function(inp, i) {
      if (apexRefFieldOptions[i]) inp.placeholder = apexRefFieldOptions[i].name;
    });
  }

  function addRefMapping() {
    if (apexRefMappings.length >= 8) return;
    apexRefMappings.push({ lookupField:'', refSObject:'', extIdField:'', valueColumn:'' });
    renderRefMappings();
  }

  function removeRefMapping(idx) {
    apexRefMappings.splice(idx, 1);
    renderRefMappings();
  }

  function renderRefMappings() {
    var container = safeGet('ref-map-rows');
    if (!container) return;
    container.innerHTML = apexRefMappings.map(function(m, i) {
      return '<div class="ref-map-row">'
        + '<input class="ref-field-input" type="text" placeholder="AccountId" value="'+escHtml(m.lookupField)+'" oninput="apexRefMappings['+i+'].lookupField=this.value">'
        + '<input type="text" placeholder="Account" value="'+escHtml(m.refSObject)+'" oninput="apexRefMappings['+i+'].refSObject=this.value">'
        + '<input type="text" placeholder="External_Id__c" value="'+escHtml(m.extIdField)+'" oninput="apexRefMappings['+i+'].extIdField=this.value">'
        + '<input type="text" placeholder="Acct_ExtId__c" value="'+escHtml(m.valueColumn)+'" oninput="apexRefMappings['+i+'].valueColumn=this.value">'
        + '<button class="btn-del-ref" onclick="removeRefMapping('+i+')">✕</button>'
        + '</div>';
    }).join('');
  }

  function doApexExport() {
    var org = safeGet('apex-org') && safeGet('apex-org').value;
    var q = safeGet('apex-query') && safeGet('apex-query').value.trim();
    var className = safeGet('apex-classname') && safeGet('apex-classname').value.trim();
    var extId = safeGet('apex-extid') && safeGet('apex-extid').value;
    var skipEmpty = !!(safeGet('apex-skip-empty') && safeGet('apex-skip-empty').checked);
    var genInsert = !!(safeGet('apex-gen-insert') && safeGet('apex-gen-insert').checked);
    var genUpsert = !!(safeGet('apex-gen-upsert') && safeGet('apex-gen-upsert').checked);
    if (!org || !q) { setResultBar('apex-result','error','Select an org and enter a SOQL query.'); return; }
    var validMappings = apexRefMappings.filter(function(m){return m.lookupField&&m.refSObject&&m.extIdField&&m.valueColumn;});
    post({
      command: 'exportApex',
      org: org, query: q,
      apexClassName: className,
      apexExtIdField: extId,
      apexSkipEmpty: skipEmpty,
      apexGenInsert: genInsert,
      apexGenUpsert: genUpsert,
      apexRefMappings: validMappings
    });
  }

  // Override switchTab to include apex
  var _origSwitchTab = switchTab;
  switchTab = function(t) {
    if (t === 'apex') { switchTabWithApex('apex'); return; }
    ['export','import','apex'].forEach(function(n) {
      safeGet('tab-'+n) && safeGet('tab-'+n).classList.toggle('active', n===t);
      safeGet('tab-'+n+'-btn') && safeGet('tab-'+n+'-btn').classList.toggle('active', n===t);
    });
  };

  post({ command: 'panelReady' });
</script>

<!-- APEX FACTORY TAB -->
<div class="tab-content" id="tab-apex">
  <div class="field-block">
    <label class="field-label" for="apex-org">Source org</label>
    <select id="apex-org" onchange="triggerApexDescribe()"></select>
  </div>
  <div class="field-block">
    <label class="field-label" for="apex-query">SOQL query</label>
    <textarea id="apex-query" onblur="triggerApexDescribe()"
      placeholder="SELECT Name, BillingCity, External_Id__c FROM Account WHERE IsActive__c = true"></textarea>
    <span class="hint">Fields will be auto-enriched with all createable fields from the describe result. SELECT list is rewritten automatically — just get the WHERE/ORDER/LIMIT right.</span>
  </div>

  <div class="apex-options visible">
    <span class="apex-options-title">⚙ Code generation options</span>
    <div class="apex-2col">
      <div class="apex-field-block">
        <label class="field-label" for="apex-classname">Class name</label>
        <input type="text" id="apex-classname" placeholder="AccountDataFactory" style="font-family:var(--vscode-editor-font-family,monospace);" />
      </div>
      <div class="apex-field-block">
        <label class="field-label" for="apex-extid">Upsert key (external ID field)</label>
        <select id="apex-extid">
          <option value="">(Insert — no upsert key)</option>
        </select>
      </div>
    </div>
    <div style="display:flex; gap:18px; flex-wrap:wrap;">
      <label class="apex-check-row"><input type="checkbox" id="apex-skip-empty" checked> Skip empty / null fields</label>
      <label class="apex-check-row"><input type="checkbox" id="apex-gen-insert" checked> Generate <code>insertAll()</code></label>
      <label class="apex-check-row"><input type="checkbox" id="apex-gen-upsert" checked> Generate <code>upsertAll()</code></label>
    </div>

    <!-- Reference field mappings -->
    <div>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
        <span class="apex-options-title" style="margin:0;">Reference field overrides</span>
        <button class="btn-add-ref" onclick="addRefMapping()">+ Add</button>
        <span class="hint" style="margin:0;">Map lookup fields to cross-org relationship notation using external IDs.</span>
      </div>
      <div id="ref-map-header-row" style="display:none;" class="ref-map-header">
        <span>Lookup field</span><span>Ref SObject</span><span>Ext ID field</span><span>Value column</span><span></span>
      </div>
      <div class="ref-map-table" id="ref-map-rows"></div>
    </div>
  </div>

  <button class="btn-primary" onclick="doApexExport()">⚡ Generate Apex Data Factory</button>
  <div class="result-bar" id="apex-result"></div>
  <div class="hint" style="margin-top:4px;">
    Output: <code style="font-size:10px;">{ClassName}-{timestamp}.apex</code> saved to workspace root.
    Includes a <code>getRecords()</code> list factory, optional <code>insertAll()</code> / <code>upsertAll()</code> methods.
    Records &gt; 200 auto-generate chunked DML loops.
  </div>
</div>
</body>
</html>`;
  }
}
