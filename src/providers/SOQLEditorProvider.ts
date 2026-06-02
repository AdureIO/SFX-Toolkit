import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { runCommandArgs } from "../utils/commandRunner";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { getCachedOrgList, refreshOrgListCache, warmOrgListCache } from "../utils/orgListCache";

const SOQL_HISTORY_MAX = 50;
const SOQL_LAST_FILE = "soql-last.txt";
const SOQL_HISTORY_FILE = "soql-history.json";
const ASFX_DIR = ".sfdx/asfx";

export class SOQLEditorProvider {
  public static readonly viewType = "adure-sfx-toolkit.soqlEditor";

  private static async runSoqlQuery(query: string, targetOrg: string | null) {
    const apiVersion = getToolingApiVersion();
    const { body, auth } = await AuthInfo.get(
      targetOrg,
      (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${apiVersion}/query?q=${encodeURIComponent(query)}`
    );
    const result = JSON.parse(body);
    return { auth, result };
  }

  public static async show(extensionUri: vscode.Uri, initialQuery?: string) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const panel = vscode.window.createWebviewPanel(
      SOQLEditorProvider.viewType,
      "SOQL Builder & Editor",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")]
      }
    );

    const { lastQuery, history } = await SOQLEditorProvider.loadSoqlState();
    panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri, initialQuery || lastQuery, history);

    AuthInfo.warmAuthForOrg(null);
    OrgMetadataCache.warmDefaultOrg();
    warmOrgListCache();

    const messageListener = panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "execute":
            await this.executeQuery(panel, message.query, message.targetOrg || null);
            break;
          case "save":
            await this.saveChanges(panel, message.changes);
            break;
          case "getObjectList":
            await this.sendObjectList(panel, message.targetOrg || null);
            break;
          case "getFields":
            await this.sendFields(panel, message.sobject, message.targetOrg || null);
            break;
          case "getRelationshipNames":
            await this.sendRelationshipNames(panel, message.parentSobject, message.targetOrg || null);
            break;
          case "getBuilderObjectList":
            await this.sendBuilderObjectList(panel, message.targetOrg || null);
            break;
          case "getBuilderFields":
            await this.sendBuilderFields(panel, message.sobject, message.targetOrg || null);
            break;
          case "getFieldsForRelationship":
            await this.sendFieldsForRelationship(
              panel,
              message.relName,
              message.fromSobject,
              message.targetOrg || null
            );
            break;
          case "getOrgList":
            await this.sendOrgList(panel);
            break;
          case "clearHistory":
            await this.clearSoqlHistory();
            panel.webview.postMessage({ command: "historyUpdated", history: [] });
            break;
          case "error":
            vscode.window.showErrorMessage(message.text);
            break;
        }
      },
      null,
      []
    );

    panel.onDidDispose(() => {
      messageListener.dispose();
      SOQLEditorProvider.editableFieldsCache = {};
    });
  }

  private static getSoqlStorageDir(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    return path.join(root, ASFX_DIR);
  }

  private static async loadSoqlState(): Promise<{ lastQuery: string; history: string[] }> {
    const dir = SOQLEditorProvider.getSoqlStorageDir();
    if (!dir) return { lastQuery: "", history: [] };
    let lastQuery = "";
    let history: string[] = [];
    try {
      const lastPath = path.join(dir, SOQL_LAST_FILE);
      if (fs.existsSync(lastPath)) lastQuery = fs.readFileSync(lastPath, "utf8").trim();
    } catch {
      // ignore
    }
    try {
      const histPath = path.join(dir, SOQL_HISTORY_FILE);
      if (fs.existsSync(histPath)) {
        const raw = fs.readFileSync(histPath, "utf8");
        const parsed = JSON.parse(raw);
        history = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // ignore
    }
    return { lastQuery, history };
  }

  private static async clearSoqlHistory(): Promise<void> {
    const dir = SOQLEditorProvider.getSoqlStorageDir();
    if (!dir) return;
    try {
      const histPath = path.join(dir, SOQL_HISTORY_FILE);
      if (fs.existsSync(histPath)) fs.unlinkSync(histPath);
    } catch {
      /* ignore */
    }
  }

  private static async saveSoqlOnExecute(query: string): Promise<string[]> {
    const dir = SOQLEditorProvider.getSoqlStorageDir();
    if (!dir) return [];
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const lastPath = path.join(dir, SOQL_LAST_FILE);
      fs.writeFileSync(lastPath, query, "utf8");
      const histPath = path.join(dir, SOQL_HISTORY_FILE);
      let history: string[] = [];
      if (fs.existsSync(histPath)) {
        try {
          const raw = fs.readFileSync(histPath, "utf8");
          history = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
        } catch {
          // ignore
        }
      }
      const trimmed = query.trim();
      if (trimmed) {
        history = [trimmed, ...history.filter((q) => q.trim() !== trimmed)].slice(0, SOQL_HISTORY_MAX);
        fs.writeFileSync(histPath, JSON.stringify(history, null, 0), "utf8");
      }
      return history;
    } catch {
      return [];
    }
  }

  private static async sendObjectList(panel: vscode.WebviewPanel, targetOrg: string | null) {
    try {
      const sobjects = await OrgMetadataCache.getObjectList(targetOrg);
      panel.webview.postMessage({ command: "completions", kind: "objects", items: sobjects });
    } catch (e: any) {
      panel.webview.postMessage({ command: "completions", kind: "objects", items: [] });
    }
  }

  private static async sendFields(panel: vscode.WebviewPanel, sobject: string, targetOrg: string | null) {
    if (!sobject) {
      panel.webview.postMessage({ command: "completions", kind: "fields", items: [] });
      return;
    }
    try {
      const fields = await OrgMetadataCache.getFieldsWithMeta(targetOrg, sobject);
      panel.webview.postMessage({ command: "completions", kind: "fields", items: fields });
    } catch (e: any) {
      panel.webview.postMessage({ command: "completions", kind: "fields", items: [] });
    }
  }

  private static async sendFieldsForRelationship(
    panel: vscode.WebviewPanel,
    relName: string,
    fromSobject: string,
    targetOrg: string | null
  ) {
    const empty = () => panel.webview.postMessage({ command: "completions", kind: "fields", items: [] });
    if (!relName || !fromSobject) {
      empty();
      return;
    }
    try {
      const targetSobject = await OrgMetadataCache.getRelationshipTarget(targetOrg, fromSobject, relName);
      if (!targetSobject) {
        empty();
        return;
      }
      const fields = await OrgMetadataCache.getFieldsWithMeta(targetOrg, targetSobject);
      panel.webview.postMessage({ command: "completions", kind: "fields", items: fields });
    } catch {
      empty();
    }
  }

  /** Child relationship names for subquery: (SELECT ... FROM <relationshipName>) FROM Parent. Returns name + childSObject for field completion. */
  private static async sendRelationshipNames(
    panel: vscode.WebviewPanel,
    parentSobject: string,
    targetOrg: string | null
  ) {
    if (!parentSobject) {
      panel.webview.postMessage({ command: "completions", kind: "relationships", parentSobject: "", items: [] });
      return;
    }
    try {
      const items = await OrgMetadataCache.getChildRelationships(targetOrg, parentSobject);
      panel.webview.postMessage({ command: "completions", kind: "relationships", parentSobject, items });
    } catch (e: any) {
      panel.webview.postMessage({ command: "completions", kind: "relationships", parentSobject: "", items: [] });
    }
  }

  private static async sendBuilderObjectList(panel: vscode.WebviewPanel, targetOrg: string | null) {
    try {
      const sobjects = await OrgMetadataCache.getObjectList(targetOrg);
      panel.webview.postMessage({ command: "builderObjects", items: sobjects });
    } catch (e: any) {
      panel.webview.postMessage({ command: "builderObjects", items: [] });
    }
  }

  private static async sendBuilderFields(panel: vscode.WebviewPanel, sobject: string, targetOrg: string | null) {
    if (!sobject) {
      panel.webview.postMessage({ command: "builderFields", items: [] });
      return;
    }
    try {
      const fields = await OrgMetadataCache.getFieldsWithMeta(targetOrg, sobject);
      panel.webview.postMessage({ command: "builderFields", items: fields });
    } catch (e: any) {
      panel.webview.postMessage({ command: "builderFields", items: [] });
    }
  }

  private static editableFieldsCache: Record<string, Record<string, Record<string, boolean>>> = {};

  /** Build a map sobjectType -> { fieldName: true } for fields that are editable. Uses cache and parallel describes. */
  private static async getEditableFieldsByType(
    records: any[],
    targetOrg: string | null
  ): Promise<Record<string, Record<string, boolean>>> {
    const orgKey = targetOrg || "__default__";
    if (!SOQLEditorProvider.editableFieldsCache[orgKey]) {
      SOQLEditorProvider.editableFieldsCache[orgKey] = {};
    }
    const orgCache = SOQLEditorProvider.editableFieldsCache[orgKey];
    const types = new Set<string>();
    const collectTypes = (list: any[]) => {
      for (const r of list || []) {
        const t = r.attributes && r.attributes.type;
        if (t) types.add(t);
        // subquery records
        for (const k of Object.keys(r)) {
          if (k === "attributes") continue;
          const v = r[k];
          const sub = SOQLEditorProvider.getSubqueryRecordsStatic(v);
          if (sub) collectTypes(sub);
        }
      }
    };
    collectTypes(records || []);
    const toFetch = Array.from(types).filter((t) => !orgCache[t]);
    if (toFetch.length > 0) {
      const results = await Promise.all(
        toFetch.map(async (sobjectType) => {
          const edit = await OrgMetadataCache.getEditableFields(targetOrg, sobjectType);
          return { sobjectType, edit };
        })
      );
      for (const { sobjectType, edit } of results) {
        orgCache[sobjectType] = edit;
      }
    }
    const out: Record<string, Record<string, boolean>> = {};
    for (const t of types) {
      if (orgCache[t]) out[t] = orgCache[t];
    }
    return out;
  }

  private static getSubqueryRecordsStatic(value: any): any[] | null {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value;
    if (typeof value === "object" && value.records && Array.isArray(value.records)) return value.records;
    return null;
  }

  private static async sendOrgList(panel: vscode.WebviewPanel) {
    const toWebview = (orgs: { username: string; label: string }[]) =>
      panel.webview.postMessage({ command: "orgList", orgs });

    const cached = getCachedOrgList();
    if (cached) {
      toWebview(cached);
    }

    try {
      const fresh = await refreshOrgListCache();
      toWebview(fresh);
    } catch (e: any) {
      if (!cached) {
        panel.webview.postMessage({ command: "orgList", orgs: [] });
      }
    }
  }

  private static async executeQuery(panel: vscode.WebviewPanel, query: string, targetOrg: string | null) {
    try {
      panel.webview.postMessage({ command: "loading", value: true });
      const { auth, result } = await SOQLEditorProvider.runSoqlQuery(query, targetOrg);
      if (result.records !== undefined) {
        const records = result.records as any[];
        const editableFields = await SOQLEditorProvider.getEditableFieldsByType(records, targetOrg);
        panel.webview.postMessage({
          command: "results",
          data: records,
          totalSize: result.totalSize ?? records.length,
          done: result.done !== false,
          instanceUrl: auth.instanceUrl,
          editableFields: editableFields
        });
        const history = await SOQLEditorProvider.saveSoqlOnExecute(query);
        panel.webview.postMessage({ command: "historyUpdated", history });
      } else {
        const err = result[0] || result;
        const message = err.message || err.errorDescription || JSON.stringify(result);
        panel.webview.postMessage({ command: "error", text: message });
      }
    } catch (e: any) {
      const errorMsg = e.message || e.stderr || JSON.stringify(e);
      panel.webview.postMessage({ command: "error", text: errorMsg });
    } finally {
      panel.webview.postMessage({ command: "loading", value: false });
    }
  }

  /** Escape a string for use inside double-quoted key=value pair for sf data update record. */
  private static escapeValue(value: string): string {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private static async saveChanges(panel: vscode.WebviewPanel, changes: any) {
    try {
      panel.webview.postMessage({ command: "saving", value: true });

      let successCount = 0;
      const errors: string[] = [];

      for (const id of Object.keys(changes)) {
        const recordChanges = changes[id];
        const type = recordChanges._type;
        const fieldsToUpdate: Record<string, string> = { ...recordChanges };
        delete fieldsToUpdate._type;

        if (!type) {
          errors.push(`Missing object type for ID ${id}`);
          continue;
        }

        // One update per field to avoid --values parsing issues with multiple fields
        for (const field of Object.keys(fieldsToUpdate)) {
          const value = fieldsToUpdate[field];
          const pair = `${field}=${SOQLEditorProvider.escapeValue(value)}`;
          try {
            const resultStr = await runCommandArgs("sf", [
              "data",
              "update",
              "record",
              "--sobject",
              type,
              "--record-id",
              id,
              "--values",
              `"${pair}"`,
              "--json"
            ]);

            const result = JSON.parse(resultStr);
            if (result.status !== 0) {
              throw new Error(result.message || "Unknown SF Error");
            }
            successCount++;
          } catch (e: any) {
            let errMsg = e.message || String(e);
            if (e.stdout) {
              try {
                const output = JSON.parse(e.stdout);
                if (output.message) errMsg = output.message;
                else if (Array.isArray(output) && output[0]?.message) errMsg = output[0].message;
              } catch {
                // ignore
              }
            }
            errors.push(`Record ${id}, field ${field}: ${errMsg}`);
          }
        }
      }

      if (errors.length > 0) {
        panel.webview.postMessage({ command: "saveErrors", errors });
        vscode.window.showErrorMessage(`Some updates failed: ${errors.join("; ")}`);
      } else if (successCount > 0) {
        vscode.window.showInformationMessage(`Successfully saved ${successCount} change(s).`);
      }
      panel.webview.postMessage({ command: "saveComplete", success: errors.length === 0 });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Save failed: ${e.message}`);
      panel.webview.postMessage({ command: "saveComplete", success: false });
    } finally {
      panel.webview.postMessage({ command: "saving", value: false });
    }
  }

  private static _getHtmlForWebview(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    lastQuery: string = "",
    history: string[] = []
  ) {
    const initialData = JSON.stringify({ lastQuery: lastQuery || "", history: Array.isArray(history) ? history : [] });
    const initialDataEscaped = initialData.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SOQL Builder &amp; Editor</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        .builder-toggle { margin-bottom: 12px; }
        .builder-toggle button { font-size: 12px; padding: 4px 10px; }
        .builder-panel { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; margin-bottom: 16px; background: var(--vscode-editor-inactiveSelectionBackground); display: none; }
        .builder-panel.visible { display: block; }
        .builder-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 10px; }
        .builder-row label { min-width: 70px; font-size: 12px; }
        .builder-row select, .builder-row input[type="number"], .builder-row input[type="text"] { min-width: 120px; padding: 4px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
        .builder-fields { max-height: 160px; overflow-y: auto; border: 1px solid var(--vscode-input-border); padding: 6px; background: var(--vscode-input-background); display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 2px 12px; font-size: 12px; }
        .builder-fields label { display: flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }
        .builder-fields input { margin: 0; }
        .builder-actions { margin-top: 10px; }
        .controls { display: flex; gap: 10px; margin-bottom: 20px; align-items: flex-start; position: relative; }
        .query-wrap { flex-grow: 1; position: relative; }
        .query-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
        textarea { width: 100%; box-sizing: border-box; height: 80px; font-family: monospace; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 5px; }
        #completion-list { position: absolute; left: 0; top: 100%; margin-top: 2px; max-height: 200px; overflow-y: auto; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); z-index: 100; list-style: none; padding: 0; margin: 0; min-width: 180px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); display: none; }
        #completion-list.visible { display: block; }
        #completion-list li { padding: 4px 8px; cursor: pointer; font-family: monospace; font-size: 12px; display: flex; align-items: center; gap: 5px; }
        #completion-list li:hover, #completion-list li.selected { background: var(--vscode-list-hoverBackground); }
        .type-badge { display: inline-block; min-width: 18px; text-align: center; font-size: 10px; font-weight: bold; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 2px; padding: 0 2px; flex-shrink: 0; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button:disabled { opacity: 0.5; cursor: default; }
        #results-container { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); vertical-align: top; }
        th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; }
        td[contenteditable="true"]:focus { outline: 2px solid var(--vscode-focusBorder); background: var(--vscode-input-background); }
        .changed { background-color: rgba(255, 255, 0, 0.2); }
        .nested-cell { padding: 4px; }
        .nested-table { width: 100%; font-size: 12px; margin: 4px 0; }
        .nested-table th, .nested-table td { padding: 4px; }
        .expandable { cursor: pointer; }
        .expandable::before { content: '▶ '; font-size: 10px; }
        .expandable.open::before { content: '▼ '; }
        .status-bar { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; }
        .error { color: var(--vscode-errorForeground); margin-top: 10px; white-space: pre-wrap; }
        #results-container a { color: var(--vscode-textLink-foreground); text-decoration: underline; }
        #results-container a:hover { color: var(--vscode-textLink-activeForeground); }
        td.readonly-cell { background: var(--vscode-editor-inactiveSelectionBackground); color: var(--vscode-descriptionForeground); cursor: not-allowed; border-left: 2px solid var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <div class="builder-toggle">
        <button id="builder-toggle-btn" type="button">▼ Show Builder</button>
    </div>
    <div id="builder-panel" class="builder-panel">
        <div class="builder-row">
            <label>Object</label>
            <select id="builder-object">
                <option value="">Select object...</option>
            </select>
        </div>
        <div class="builder-row">
            <label>Fields</label>
            <div style="flex: 1;">
                <button type="button" id="builder-select-all" style="padding: 2px 8px; font-size: 11px;">Select all</button>
                <button type="button" id="builder-select-none" style="padding: 2px 8px; font-size: 11px; margin-left: 4px;">Clear</button>
                <div id="builder-fields" class="builder-fields"></div>
            </div>
        </div>
        <div class="builder-row">
            <label>WHERE</label>
            <select id="builder-where-field">
                <option value="">—</option>
            </select>
            <select id="builder-where-op">
                <option value="=">=</option>
                <option value="!=">!=</option>
                <option value="LIKE">LIKE</option>
                <option value="IN">IN</option>
                <option value="NOT IN">NOT IN</option>
            </select>
            <input type="text" id="builder-where-value" placeholder="Value" />
        </div>
        <div class="builder-row">
            <label>ORDER BY</label>
            <select id="builder-order-field">
                <option value="">—</option>
            </select>
            <select id="builder-order-dir">
                <option value="ASC">ASC</option>
                <option value="DESC">DESC</option>
            </select>
        </div>
        <div class="builder-row">
            <label>LIMIT</label>
            <input type="number" id="builder-limit" min="1" max="2000" placeholder="e.g. 100" style="width: 80px;" />
        </div>
        <div class="builder-actions">
            <button type="button" id="builder-apply-btn">Apply to query</button>
        </div>
    </div>

    <script type="application/json" id="soql-initial-data">${initialDataEscaped}</script>
    <div class="controls">
        <div class="query-wrap">
            <div class="query-label">Query (edit directly or use Builder above)</div>
            <textarea id="query-input" placeholder="SELECT Id, Name FROM Account LIMIT 10">SELECT Id, Name FROM Account LIMIT 10</textarea>
            <ul id="completion-list"></ul>
        </div>
        <div style="display: flex; flex-direction: column; gap: 5px;">
            <div class="builder-row" style="margin-bottom: 0;">
                <label>History</label>
                <input type="text" id="history-search" placeholder="Filter..." style="width: 70px; padding: 2px 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-size: 12px;" title="Filter history" />
                <select id="history-select" title="Reopen a previous query" style="flex: 1; min-width: 0;">
                    <option value="">— select —</option>
                </select>
                <button type="button" id="history-clear-btn" style="padding: 4px 8px; font-size: 11px;" title="Clear all history">&#x2715;</button>
            </div>
            <div class="builder-row" style="margin-bottom: 0;">
                <label>Org</label>
                <select id="org-select" title="Override org to run query">
                    <option value="">Default org</option>
                </select>
            </div>
            <button id="execute-btn">Execute</button>
            <div style="display: flex; gap: 5px;">
                <button id="save-btn" style="display: none; background-color: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground);">Save</button>
                <button id="discard-btn" style="display: none;">Discard</button>
            </div>
        </div>
    </div>
    
    <div id="error-msg" class="error"></div>
    <div id="results-container"></div>
    <div class="status-bar" id="status-bar"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('query-input');
        const completionList = document.getElementById('completion-list');
        const executeBtn = document.getElementById('execute-btn');
        const saveBtn = document.getElementById('save-btn');
        const discardBtn = document.getElementById('discard-btn');
        const resultsContainer = document.getElementById('results-container');
        const errorMsg = document.getElementById('error-msg');
        const statusBar = document.getElementById('status-bar');
        const builderToggleBtn = document.getElementById('builder-toggle-btn');
        const builderPanel = document.getElementById('builder-panel');
        const builderObject = document.getElementById('builder-object');
        const builderFieldsEl = document.getElementById('builder-fields');
        const builderSelectAll = document.getElementById('builder-select-all');
        const builderSelectNone = document.getElementById('builder-select-none');
        const builderWhereField = document.getElementById('builder-where-field');
        const builderWhereOp = document.getElementById('builder-where-op');
        const builderWhereValue = document.getElementById('builder-where-value');
        const builderOrderField = document.getElementById('builder-order-field');
        const builderOrderDir = document.getElementById('builder-order-dir');
        const builderLimit = document.getElementById('builder-limit');
        const builderApplyBtn = document.getElementById('builder-apply-btn');
        const orgSelect = document.getElementById('org-select');
        const historySelect = document.getElementById('history-select');
        const historySearch = document.getElementById('history-search');
        const historyClearBtn = document.getElementById('history-clear-btn');

        let fullHistory = [];

        const soqlInitialEl = document.getElementById('soql-initial-data');
        if (soqlInitialEl && soqlInitialEl.textContent) {
            try {
                const data = JSON.parse(soqlInitialEl.textContent);
                if (data.lastQuery && typeof data.lastQuery === 'string') queryInput.value = data.lastQuery;
                if (Array.isArray(data.history)) {
                    fullHistory = data.history;
                    renderHistoryOptions(fullHistory);
                }
            } catch (e) {}
        }

        function renderHistoryOptions(items) {
            while (historySelect.options.length > 1) historySelect.remove(1);
            (items || []).forEach((q, i) => {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = (q.length > 60 ? q.slice(0, 57) + '...' : q).replace(/\\s+/g, ' ');
                opt.title = q;
                historySelect.appendChild(opt);
            });
        }

        function setHistoryDropdown(items) {
            fullHistory = items || [];
            const filter = historySearch ? historySearch.value.trim().toLowerCase() : '';
            renderHistoryOptions(filter ? fullHistory.filter(q => q.toLowerCase().includes(filter)) : fullHistory);
        }

        if (historySearch) {
            historySearch.addEventListener('input', () => {
                const filter = historySearch.value.trim().toLowerCase();
                renderHistoryOptions(filter ? fullHistory.filter(q => q.toLowerCase().includes(filter)) : fullHistory);
            });
        }

        if (historyClearBtn) {
            historyClearBtn.addEventListener('click', () => {
                fullHistory = [];
                renderHistoryOptions([]);
                if (historySearch) historySearch.value = '';
                vscode.postMessage({ command: 'clearHistory' });
            });
        }

        historySelect.addEventListener('change', () => {
            const idx = historySelect.value;
            if (idx === '') return;
            const opt = historySelect.options[historySelect.selectedIndex];
            const fullQuery = opt ? opt.title : '';
            if (fullQuery) { queryInput.value = fullQuery; queryInput.focus(); }
            historySelect.selectedIndex = 0;
        });

        let currentRecords = [];
        let changes = {};
        let completionItems = [];
        let completionStart = 0;
        let completionReplaceLen = 0;
        let selectedIndex = 0;
        let builderObjectList = [];
        let builderFieldsList = [];
        let currentInstanceUrl = null;
        let editableFieldsByType = {}; // { "Account": { "Name": true, ... }, ... }
        /** parentSobject -> { relationshipName: childSobject } for subquery field resolution */
        let relationshipCache = {};
        const MAX_UNDO = 50;
        let undoStack = [];

        function currentTargetOrg() {
            return orgSelect.value || null;
        }

        function pushUndoState() {
            undoStack.push({
                value: queryInput.value,
                start: queryInput.selectionStart,
                end: queryInput.selectionEnd
            });
            if (undoStack.length > MAX_UNDO) undoStack.shift();
        }

        function isSalesforceId(val) {
            if (typeof val !== 'string' || !val) return false;
            const s = val.trim();
            return /^[a-zA-Z0-9]{15}$/.test(s) || /^[a-zA-Z0-9]{18}$/.test(s);
        }
        function makeRecordLink(id, instanceUrl) {
            if (!instanceUrl || !id) return null;
            const href = instanceUrl.replace(/\\/$/, '') + '/' + id;
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = id;
            a.title = 'Open in Salesforce';
            return a;
        }

        orgSelect.addEventListener('focus', () => {
            if (orgSelect.options.length <= 1) vscode.postMessage({ command: 'getOrgList' });
        });

        orgSelect.addEventListener('change', () => {
            relationshipCache = {};
            if (builderPanel.classList.contains('visible')) {
                vscode.postMessage({ command: 'getBuilderObjectList', targetOrg: currentTargetOrg() });
            }
        });

        builderToggleBtn.addEventListener('click', () => {
            const visible = builderPanel.classList.toggle('visible');
            builderToggleBtn.textContent = visible ? '▲ Hide Builder' : '▼ Show Builder';
            if (visible && builderObjectList.length === 0) {
                vscode.postMessage({ command: 'getBuilderObjectList', targetOrg: currentTargetOrg() });
            }
        });

        function escOp(op) { return op.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

        function updateBuilderWhereOps(fieldType) {
            const t = (fieldType || '').toLowerCase();
            let ops;
            if (['double', 'integer', 'currency', 'percent', 'long'].includes(t)) {
                ops = ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN'];
            } else if (t === 'date' || t === 'datetime') {
                ops = ['=', '!=', '>', '<', '>=', '<='];
            } else if (t === 'boolean') {
                ops = ['=', '!='];
            } else if (['picklist', 'multipicklist'].includes(t)) {
                ops = ['=', '!=', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'];
            } else {
                ops = ['=', '!=', 'LIKE', 'IN', 'NOT IN'];
            }
            builderWhereOp.innerHTML = ops.map(op => '<option value="' + escOp(op) + '">' + escOp(op) + '</option>').join('');
        }

        builderWhereField.addEventListener('change', () => {
            const sel = builderWhereField.options[builderWhereField.selectedIndex];
            updateBuilderWhereOps(sel ? sel.dataset.type : '');
        });

        builderObject.addEventListener('change', () => {
            const sobject = builderObject.value;
            builderFieldsList = [];
            builderFieldsEl.innerHTML = '';
            builderWhereField.innerHTML = '<option value="">—</option>';
            builderOrderField.innerHTML = '<option value="">—</option>';
            if (sobject) {
                vscode.postMessage({ command: 'getBuilderFields', sobject: sobject, targetOrg: currentTargetOrg() });
            }
        });

        builderSelectAll.addEventListener('click', () => {
            builderFieldsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        });
        builderSelectNone.addEventListener('click', () => {
            builderFieldsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        });

        function buildQueryFromBuilder() {
            const sobject = builderObject.value;
            if (!sobject) return '';
            const fields = Array.from(builderFieldsEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
            if (fields.length === 0) return '';
            const selectList = fields.join(', ');
            let q = 'SELECT ' + selectList + ' FROM ' + sobject;
            const whereF = builderWhereField.value;
            const whereOp = builderWhereOp.value;
            const whereVal = builderWhereValue.value.trim();
            if (whereF && whereVal !== '') {
                const escape = (s) => s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
                if (whereOp === 'IN' || whereOp === 'NOT IN') {
                    const list = whereVal.split(',').map(s => "'" + escape(s.trim()) + "'").join(',');
                    q += ' WHERE ' + whereF + ' ' + whereOp + ' (' + list + ')';
                } else {
                    q += ' WHERE ' + whereF + ' ' + whereOp + " '" + escape(whereVal) + "'";
                }
            }
            const orderF = builderOrderField.value;
            if (orderF) {
                q += ' ORDER BY ' + orderF + ' ' + builderOrderDir.value;
            }
            const limit = builderLimit.value.trim();
            if (limit && /^\\d+$/.test(limit)) {
                q += ' LIMIT ' + limit;
            }
            return q;
        }

        builderApplyBtn.addEventListener('click', () => {
            const query = buildQueryFromBuilder();
            if (query) {
                queryInput.value = query;
                errorMsg.textContent = '';
            }
        });

        executeBtn.addEventListener('click', () => {
            const query = queryInput.value;
            if (!query) return;
            changes = {};
            updateSaveButton();
            hideCompletion();
            const targetOrg = orgSelect.value || null;
            vscode.postMessage({ command: 'execute', query: query, targetOrg: targetOrg });
        });

        saveBtn.addEventListener('click', () => {
            const payload = {};
            for (const id of Object.keys(changes)) {
                payload[id] = { ...changes[id] };
            }
            vscode.postMessage({ command: 'save', changes: payload });
        });

        discardBtn.addEventListener('click', () => {
            changes = {};
            updateSaveButton();
            if (currentRecords && currentRecords.length > 0) {
                renderTable(JSON.parse(JSON.stringify(currentRecords)));
            }
        });

        function hideCompletion() {
            completionList.classList.remove('visible');
            completionItems = [];
        }

        function fieldTypeIcon(type) {
            const t = (type || '').toLowerCase();
            if (['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring'].includes(t)) return 'T';
            if (['double', 'integer', 'currency', 'percent', 'long'].includes(t)) return 'N';
            if (t === 'date') return 'D';
            if (t === 'datetime') return 'DT';
            if (t === 'boolean') return 'B';
            if (['id', 'reference'].includes(t)) return 'R';
            if (['picklist', 'multipicklist'].includes(t)) return 'P';
            return null;
        }

        function showCompletion(items, replaceStart, replaceLen) {
            completionItems = items;
            completionStart = replaceStart;
            completionReplaceLen = replaceLen;
            selectedIndex = 0;
            completionList.innerHTML = '';
            items.slice(0, 80).forEach((item, i) => {
                const li = document.createElement('li');
                const name = (typeof item === 'object' && item && item.name !== undefined) ? item.name : String(item);
                const fieldType = (typeof item === 'object' && item && item.type) ? item.type : null;
                const icon = fieldType ? fieldTypeIcon(fieldType) : null;
                if (icon) {
                    const badge = document.createElement('span');
                    badge.className = 'type-badge';
                    badge.textContent = icon;
                    badge.title = fieldType;
                    li.appendChild(badge);
                }
                li.appendChild(document.createTextNode(name));
                li.dataset.index = String(i);
                li.addEventListener('click', () => insertCompletion(item, replaceStart, replaceLen));
                completionList.appendChild(li);
            });
            completionList.classList.add('visible');
            completionList.querySelector('li')?.classList.add('selected');
        }

        function insertCompletion(textOrItem, start, len) {
            pushUndoState();
            const name = (typeof textOrItem === 'object' && textOrItem && textOrItem.name !== undefined) ? textOrItem.name : String(textOrItem);
            const sobject = (typeof textOrItem === 'object' && textOrItem && textOrItem.sobject) ? textOrItem.sobject : null;
            const trailingSpace = typeof textOrItem === 'object' && textOrItem && textOrItem.trailingSpace;
            const before = queryInput.value.slice(0, start);
            const after = queryInput.value.slice(start + len);
            const alreadyHasClosing = after.charAt(0) === ')';
            const closingParen = (sobject && !alreadyHasClosing) ? ')' : '';
            const space = (trailingSpace && !closingParen && after.charAt(0) !== ' ') ? ' ' : '';
            queryInput.value = before + name + closingParen + space + after;
            const newCursor = start + name.length + closingParen.length + space.length;
            queryInput.setSelectionRange(newCursor, newCursor);
            queryInput.focus();
            hideCompletion();
            if (sobject) {
                const subqueryCursor = start + name.length + closingParen.length;
                queryInput.setSelectionRange(subqueryCursor, subqueryCursor);
                const fullText = queryInput.value;
                const subqueryBefore = getSubqueryPrefix(fullText, subqueryCursor);
                if (subqueryBefore) {
                    const selIdx = subqueryBefore.indexOf('SELECT ');
                    if (selIdx >= 0) {
                        const startOfSubquery = subqueryCursor - subqueryBefore.length;
                        const afterSelect = startOfSubquery + selIdx + 7;
                        queryInput.setSelectionRange(afterSelect, afterSelect);
                        queryInput.focus();
                        vscode.postMessage({ command: 'getFields', sobject: sobject, targetOrg: currentTargetOrg() });
                    }
                }
            }
        }

        function getSubqueryPrefix(text, cursor) {
            let depth = 0;
            for (let i = cursor - 1; i >= 0; i--) {
                if (text[i] === ')') depth++;
                else if (text[i] === '(') {
                    depth--;
                    if (depth === -1) return text.slice(i, cursor);
                }
            }
            return null;
        }

        /** Full subquery text containing cursor (from opening "(" to closing ")" or end). Used to read FROM when cursor is in SELECT part. */
        function getSubqueryFull(text, cursor) {
            let startIdx = -1;
            let depth = 0;
            for (let i = cursor - 1; i >= 0; i--) {
                if (text[i] === ')') depth++;
                else if (text[i] === '(') {
                    depth--;
                    if (depth === -1) { startIdx = i; break; }
                }
            }
            if (startIdx < 0) return null;
            depth = 0;
            for (let i = startIdx; i < text.length; i++) {
                if (text[i] === '(') depth++;
                else if (text[i] === ')') { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
            }
            return text.slice(startIdx);
        }

        /** FROM sobject at depth 0 (main query), for "SELECT ... FROM Account" when query has subqueries. */
        function getMainQueryFrom(text) {
            const re = /\\bFROM\\s+(\\w+)/gi;
            let last = null, m;
            while ((m = re.exec(text)) !== null) {
                let depth = 0;
                for (let i = 0; i < m.index; i++) {
                    if (text[i] === '(') depth++;
                    else if (text[i] === ')') depth--;
                }
                if (depth === 0) last = m[1];
            }
            return last;
        }

        const SOQL_OPERATORS = ['=', '!=', '<', '>', '<=', '>=', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'];

        function getQueryContext() {
            const text = queryInput.value;
            const cursor = queryInput.selectionStart;
            const before = text.slice(0, cursor);
            const fullText = text;
            const subqueryBefore = getSubqueryPrefix(fullText, cursor);

            // 1. After "FROM " -> main: object list; subquery: relationship names of parent
            const fromMatch = (subqueryBefore || before).match(/\\sFROM\\s+(\\w*)$/i);
            if (fromMatch) {
                if (subqueryBefore) {
                    const parentSobject = getMainQueryFrom(fullText);
                    const prefix = fromMatch[1];
                    const start = cursor - prefix.length;
                    const replaceLen = prefix.length;
                    return { type: 'relationship', parentSobject: parentSobject || '', prefix: prefix, start: start, replaceLen: replaceLen };
                }
                return { type: 'object', prefix: fromMatch[1], start: cursor - fromMatch[1].length };
            }

            // 2. After "Something." -> suggest fields; resolve __r relationship names via extension
            const dotMatch = before.match(/(\\w+)\\.(\\w*)$/);
            if (dotMatch) {
                const relOrSobject = dotMatch[1];
                const prefix = dotMatch[2];
                const start = cursor - prefix.length;
                if (relOrSobject.endsWith('__r')) {
                    const fromSobject = getMainQueryFrom(fullText) || '';
                    return { type: 'relField', relName: relOrSobject, fromSobject, prefix, start };
                }
                return { type: 'field', sobject: relOrSobject, prefix, start };
            }

            // Resolve sobject for WHERE and SELECT field completion
            let sobjectFromQuery = null;
            if (subqueryBefore) {
                const subqueryFull = getSubqueryFull(fullText, cursor);
                const fromClause = (subqueryFull || subqueryBefore).match(/\\bFROM\\s+(\\w+)/i);
                sobjectFromQuery = fromClause ? fromClause[1] : null;
                if (sobjectFromQuery) {
                    const parentSobject = getMainQueryFrom(fullText);
                    if (parentSobject && relationshipCache[parentSobject] && relationshipCache[parentSobject][sobjectFromQuery])
                        sobjectFromQuery = relationshipCache[parentSobject][sobjectFromQuery];
                }
            } else {
                sobjectFromQuery = getMainQueryFrom(fullText);
            }

            // 3. After WHERE/AND/OR + field + space -> operator completion (client-side static list)
            const whereOpMatch = before.match(/\\b(?:WHERE|AND|OR)\\s+[\\w.]+\\s+(\\w*)$/i);
            if (whereOpMatch) {
                return { type: 'operator', prefix: whereOpMatch[1], start: cursor - whereOpMatch[1].length };
            }

            // 4. After WHERE/AND/OR -> field completion
            if (sobjectFromQuery) {
                const whereFieldMatch = before.match(/\\b(?:WHERE|AND|OR)\\s+(\\w*)$/i);
                if (whereFieldMatch) {
                    return { type: 'field', sobject: sobjectFromQuery, prefix: whereFieldMatch[1], start: cursor - whereFieldMatch[1].length };
                }
            }

            // 5. In SELECT clause: after "SELECT " or ", "
            const selectScopeText = subqueryBefore || before;
            if (sobjectFromQuery) {
                const fieldWordMatch = selectScopeText.match(/(?:SELECT\\s+|,\\s*)(\\w*)$/i);
                if (fieldWordMatch) {
                    return { type: 'field', sobject: sobjectFromQuery, prefix: fieldWordMatch[1], start: cursor - fieldWordMatch[1].length };
                }
            }

            return null;
        }

        function triggerCompletion(ctx) {
            if (!ctx) { hideCompletion(); return; }
            if (ctx.type === 'object') {
                vscode.postMessage({ command: 'getObjectList', targetOrg: currentTargetOrg() });
            } else if (ctx.type === 'relationship') {
                vscode.postMessage({ command: 'getRelationshipNames', parentSobject: ctx.parentSobject, targetOrg: currentTargetOrg() });
            } else if (ctx.type === 'operator') {
                const prefix = (ctx.prefix || '').toUpperCase();
                const ops = SOQL_OPERATORS.filter(op => op.startsWith(prefix));
                if (ops.length > 0) showCompletion(ops.map(op => ({ name: op, trailingSpace: true })), ctx.start, ctx.prefix.length);
                else hideCompletion();
            } else if (ctx.type === 'relField') {
                vscode.postMessage({ command: 'getFieldsForRelationship', relName: ctx.relName, fromSobject: ctx.fromSobject, targetOrg: currentTargetOrg() });
            } else {
                vscode.postMessage({ command: 'getFields', sobject: ctx.sobject, targetOrg: currentTargetOrg() });
            }
        }

        let completionDebounce = null;
        queryInput.addEventListener('input', () => {
            if (completionDebounce) clearTimeout(completionDebounce);
            completionDebounce = setTimeout(() => {
                completionDebounce = null;
                triggerCompletion(getQueryContext());
            }, 50);
        });

        queryInput.addEventListener('keydown', (e) => {
            if (!completionList.classList.contains('visible')) return;
            if (e.key === 'Escape') { hideCompletion(); e.preventDefault(); return; }
            if (e.key === 'Enter' || e.key === 'Tab') {
                const sel = completionList.querySelector('li.selected');
                if (sel && completionItems[selectedIndex] !== undefined) {
                    const ctx = getQueryContext();
                    const len = (ctx && ctx.replaceLen !== undefined) ? ctx.replaceLen : ((ctx && ctx.prefix !== undefined) ? ctx.prefix.length : completionReplaceLen);
                    insertCompletion(completionItems[selectedIndex], ctx ? ctx.start : completionStart, len);
                    e.preventDefault();
                }
                return;
            }
            if (e.key === 'ArrowDown') {
                selectedIndex = Math.min(selectedIndex + 1, completionItems.length - 1);
                completionList.querySelectorAll('li').forEach((li, i) => li.classList.toggle('selected', i === selectedIndex));
                e.preventDefault();
            }
            if (e.key === 'ArrowUp') {
                selectedIndex = Math.max(selectedIndex - 1, 0);
                completionList.querySelectorAll('li').forEach((li, i) => li.classList.toggle('selected', i === selectedIndex));
                e.preventDefault();
            }
        });

        queryInput.addEventListener('blur', () => { setTimeout(hideCompletion, 150); });

        queryInput.addEventListener('keydown', (e) => {
            if (e.key === '(') {
                const before = queryInput.value.slice(0, queryInput.selectionStart);
                const expandSubquery = before.length === 0 || /[\\s,]$/.test(before) || /\\bSELECT\\s*$/.test(before);
                if (expandSubquery) {
                    e.preventDefault();
                    pushUndoState();
                    const cursor = queryInput.selectionStart;
                    const insert = '(SELECT Id FROM )';
                    queryInput.value = queryInput.value.slice(0, cursor) + insert + queryInput.value.slice(cursor);
                    queryInput.setSelectionRange(cursor + insert.length - 1, cursor + insert.length - 1);
                    queryInput.focus();
                }
            }
        });

        queryInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                if (undoStack.length > 0) {
                    e.preventDefault();
                    const state = undoStack.pop();
                    queryInput.value = state.value;
                    queryInput.setSelectionRange(state.start, state.end);
                    queryInput.focus();
                }
            }
        });

        queryInput.addEventListener('keydown', (e) => {
            if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                triggerCompletion(getQueryContext());
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'loading':
                    executeBtn.disabled = message.value;
                    executeBtn.textContent = message.value ? 'Running...' : 'Execute';
                    if (message.value) errorMsg.textContent = '';
                    break;
                case 'saving':
                    saveBtn.disabled = message.value;
                    discardBtn.disabled = message.value;
                    saveBtn.textContent = message.value ? 'Saving...' : 'Save';
                    break;
                case 'results':
                    if (message.instanceUrl) currentInstanceUrl = message.instanceUrl;
                    if (message.editableFields) editableFieldsByType = message.editableFields;
                    renderTable(message.data);
                    statusBar.textContent = 'Total: ' + message.totalSize + ' records';
                    break;
                case 'orgList':
                    orgSelect.innerHTML = '<option value="">Default org</option>';
                    (message.orgs || []).forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o.username || '';
                        opt.textContent = o.label || ((o.alias || o.username || '') + (o.isDefault ? ' (default)' : ''));
                        orgSelect.appendChild(opt);
                    });
                    break;
                case 'historyUpdated':
                    setHistoryDropdown(message.history || []);
                    break;
                case 'error':
                    errorMsg.textContent = message.text;
                    resultsContainer.innerHTML = '';
                    statusBar.textContent = '';
                    break;
                case 'saveErrors':
                    errorMsg.textContent = 'Save errors:\\n' + (message.errors || []).join('\\n');
                    break;
                case 'saveComplete':
                    if (message.success) {
                        changes = {};
                        updateSaveButton();
                        document.querySelectorAll('.changed').forEach(el => el.classList.remove('changed'));
                        errorMsg.textContent = '';
                    }
                    break;
                case 'completions':
                    const ctx = getQueryContext();
                    if (message.kind === 'relationships' && message.parentSobject) {
                        relationshipCache[message.parentSobject] = {};
                        (message.items || []).forEach(it => {
                            if (it && it.name) relationshipCache[message.parentSobject][it.name] = it.sobject || it.name;
                        });
                    }
                    const prefix = (ctx && ctx.prefix) ? ctx.prefix.toLowerCase() : '';
                    const rawItems = message.items || [];
                    const filtered = rawItems.filter(it => {
                        if (!it) return false;
                        const n = typeof it === 'object' && it.name !== undefined ? it.name : String(it);
                        return n.toLowerCase().startsWith(prefix);
                    });
                    if (filtered.length > 0 && ctx) {
                        const replaceLen = (ctx.replaceLen !== undefined ? ctx.replaceLen : (ctx.prefix || '').length);
                        showCompletion(filtered, ctx.start, replaceLen);
                    } else {
                        hideCompletion();
                    }
                    break;
                case 'builderObjects':
                    builderObjectList = message.items || [];
                    builderObject.innerHTML = '<option value="">Select object...</option>' + builderObjectList.map(o => '<option value="' + o + '">' + o + '</option>').join('');
                    break;
                case 'builderFields':
                    builderFieldsList = (message.items || []).map(f => typeof f === 'object' ? f : { name: f, type: '' });
                    builderFieldsEl.innerHTML = builderFieldsList.map(f => '<label><input type="checkbox" value="' + f.name + '"> ' + f.name + '</label>').join('');
                    builderWhereField.innerHTML = '<option value="">—</option>' + builderFieldsList.map(f => '<option value="' + f.name + '" data-type="' + (f.type || '') + '">' + f.name + '</option>').join('');
                    builderOrderField.innerHTML = '<option value="">—</option>' + builderFieldsList.map(f => '<option value="' + f.name + '">' + f.name + '</option>').join('');
                    updateBuilderWhereOps('');
                    break;
            }
        });

        function getSubqueryRecords(value) {
            if (value === null || value === undefined) return null;
            if (Array.isArray(value)) return value;
            if (typeof value === 'object' && value.records && Array.isArray(value.records)) return value.records;
            return null;
        }

        function renderCellValue(value, recId, type, fieldName, changesRef) {
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') {
                const subqueryRecords = getSubqueryRecords(value);
                if (subqueryRecords !== null) {
                    const div = document.createElement('div');
                    div.className = 'nested-cell';
                    const summary = document.createElement('span');
                    summary.className = 'expandable';
                    summary.textContent = subqueryRecords.length + ' record(s)';
                    const inner = document.createElement('div');
                    inner.style.display = 'none';
                    const nestedTable = document.createElement('table');
                    nestedTable.className = 'nested-table';
                    const nestedHeaders = new Set();
                    subqueryRecords.forEach(rec => Object.keys(rec).filter(k => k !== 'attributes').forEach(k => nestedHeaders.add(k)));
                    const nHeaders = Array.from(nestedHeaders);
                    const thead = document.createElement('thead');
                    const trH = document.createElement('tr');
                    nHeaders.forEach(h => { const th = document.createElement('th'); th.textContent = h; trH.appendChild(th); });
                    thead.appendChild(trH);
                    nestedTable.appendChild(thead);
                    const tbody = document.createElement('tbody');
                    subqueryRecords.forEach(rec => {
                        const tr = document.createElement('tr');
                        const recId = rec.Id;
                        const recType = (rec.attributes && rec.attributes.type) ? rec.attributes.type : null;
                        nHeaders.forEach(h => {
                            const td = document.createElement('td');
                            const v = rec[h];
                            const isNestedObject = typeof v === 'object' && v !== null;
                            if (isNestedObject) {
                                td.textContent = JSON.stringify(v);
                            } else {
                                const link = currentInstanceUrl && (h === 'Id' || isSalesforceId(v)) ? makeRecordLink(String(v), currentInstanceUrl) : null;
                                if (link) td.appendChild(link);
                                else td.textContent = v === null ? '' : v;
                            }
                            const isEditableNested = recId && recType && h !== 'Id' && !isNestedObject && editableFieldsByType[recType] && editableFieldsByType[recType][h];
                            if (isEditableNested) {
                                td.contentEditable = true;
                                td.addEventListener('input', () => {
                                    const newValue = td.textContent.trim();
                                    if (!changes[recId]) changes[recId] = { _type: recType };
                                    changes[recId][h] = newValue;
                                    td.classList.add('changed');
                                    updateSaveButton();
                                });
                            } else if (recId && recType && h !== 'Id' && !isNestedObject) {
                                td.classList.add('readonly-cell');
                                td.title = 'Read-only (formula, system field, or no edit permission)';
                            }
                            tr.appendChild(td);
                        });
                        tbody.appendChild(tr);
                    });
                    nestedTable.appendChild(tbody);
                    inner.appendChild(nestedTable);
                    summary.addEventListener('click', () => {
                        summary.classList.toggle('open');
                        inner.style.display = inner.style.display === 'none' ? 'block' : 'none';
                    });
                    div.appendChild(summary);
                    div.appendChild(inner);
                    return div;
                }
                const summary = document.createElement('span');
                summary.className = 'expandable';
                const keys = Object.keys(value).filter(k => k !== 'attributes');
                summary.textContent = keys.length ? '{ ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? '...' : '') + ' }' : '{}';
                const pre = document.createElement('pre');
                pre.style.display = 'none';
                pre.style.margin = '4px 0';
                pre.style.fontSize = '11px';
                pre.style.whiteSpace = 'pre-wrap';
                pre.textContent = JSON.stringify(value, null, 2);
                summary.addEventListener('click', () => {
                    summary.classList.toggle('open');
                    pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
                });
                const wrap = document.createElement('div');
                wrap.appendChild(summary);
                wrap.appendChild(pre);
                return wrap;
            }
            return document.createTextNode(value);
        }

        function renderTable(records) {
            currentRecords = records;
            resultsContainer.innerHTML = '';
            if (!records || records.length === 0) {
                resultsContainer.textContent = 'No records found.';
                return;
            }

            const columns = new Set();
            records.forEach(r => {
                Object.keys(r).forEach(k => { if (k !== 'attributes') columns.add(k); });
            });
            const headers = Array.from(columns);

            const table = document.createElement('table');
            const thead = document.createElement('thead');
            const trHead = document.createElement('tr');
            headers.forEach(h => {
                const th = document.createElement('th');
                th.textContent = h;
                trHead.appendChild(th);
            });
            thead.appendChild(trHead);
            table.appendChild(thead);

            const tbody = document.createElement('tbody');
            records.forEach(r => {
                const tr = document.createElement('tr');
                const recId = r.Id;
                const type = (r.attributes && r.attributes.type) ? r.attributes.type : null;

                headers.forEach(h => {
                    const td = document.createElement('td');
                    const value = r[h];
                    const isObject = typeof value === 'object' && value !== null;

                    if (isObject) {
                        td.appendChild(renderCellValue(value, recId, type, h, changes));
                    } else {
                        const link = currentInstanceUrl && (h === 'Id' || isSalesforceId(value)) ? makeRecordLink(String(value), currentInstanceUrl) : null;
                        if (link) td.appendChild(link);
                        else td.textContent = value === null ? '' : value;
                    }

                    const isEditable = recId && type && h !== 'Id' && !isObject && editableFieldsByType[type] && editableFieldsByType[type][h];
                    if (isEditable) {
                        td.contentEditable = true;
                        td.addEventListener('input', () => {
                            const newValue = td.textContent.trim();
                            if (!changes[recId]) changes[recId] = { _type: type };
                            changes[recId][h] = newValue;
                            td.classList.add('changed');
                            updateSaveButton();
                        });
                    } else if (recId && type && h !== 'Id' && !isObject) {
                        td.classList.add('readonly-cell');
                        td.title = 'Read-only (formula, system field, or no edit permission)';
                    }
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.appendChild(tbody);
            resultsContainer.appendChild(table);
        }

        function updateSaveButton() {
            const hasChanges = Object.keys(changes).length > 0;
            saveBtn.style.display = hasChanges ? 'block' : 'none';
            discardBtn.style.display = hasChanges ? 'block' : 'none';
        }
    </script>
</body>
</html>`;
  }
}
