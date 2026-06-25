import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { sfRequest } from "../utils/dataMigration";
import { getCachedOrgList, refreshOrgListCache, warmOrgListCache } from "../utils/orgListCache";
import { ApexBufferBridge } from "./apexBufferBridge";
import { setBufferOrgOverride } from "../utils/bufferOrgOverride";
import { refreshLanguageServerSchema, setEphemeralBuffers } from "../languageClient";
import { getSoqlMarkers } from "../utils/soqlMarkers";
import { parseSoqlError } from "../utils/soqlError";
import { handleResultsTableMessage } from "../utils/resultsTableHost";
import { resultsTableCss, resultsTableScript } from "../webview/resultsTableComponent";

const SOQL_WB_BUFFER = ".vscode/soql-wb-buffer.soql";
const SOQL_HISTORY_MAX = 50;
const SOQL_LAST_FILE = "soql-last.txt";
const SOQL_HISTORY_FILE = "soql-history.json";
const SOQL_SAVED_FILE = "soql-saved.json";
const ASFX_DIR = ".sfdx/asfx";

interface SavedQuery {
  name: string;
  query: string;
}

export class SOQLEditorProvider {
  public static readonly viewType = "adure-sfx-toolkit.soqlEditor";

  /** Backing buffer for the Monaco editor's language-server completion/hover. */
  private static readonly _bridge = new ApexBufferBridge(SOQL_WB_BUFFER, "soql");

  private static async runSoqlQuery(query: string, targetOrg: string | null) {
    const apiVersion = getToolingApiVersion();
    const { body, auth } = await AuthInfo.get(
      targetOrg,
      (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${apiVersion}/query?q=${encodeURIComponent(query)}`
    );
    const result = JSON.parse(body);
    return { auth, result };
  }

  /** Fetch the next page of a query via its `nextRecordsUrl` (a server-relative path). */
  private static async fetchNextRecords(nextRecordsUrl: string, targetOrg: string | null) {
    const { body, auth } = await AuthInfo.get(
      targetOrg,
      (a) =>
        /^https?:\/\//i.test(nextRecordsUrl)
          ? nextRecordsUrl
          : `${a.instanceUrl.replace(/\/$/, "")}${nextRecordsUrl}`
    );
    const result = JSON.parse(body);
    return { auth, result };
  }

  public static async show(extensionUri: vscode.Uri, initialQuery?: string, initialOrg?: string) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

    const panel = vscode.window.createWebviewPanel(
      SOQLEditorProvider.viewType,
      "SOQL Builder & Editor",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "resources"),
        vscode.Uri.joinPath(extensionUri, "node_modules", "monaco-editor", "min")
      ]
      }
    );

    await SOQLEditorProvider.attach(panel, extensionUri, initialQuery, initialOrg);
  }

  /**
   * Restore the panel after a window reload. VS Code hands us the already-created
   * webview panel (via the registered WebviewPanelSerializer); we just re-wire its
   * HTML and message handler — the same setup `show()` performs.
   */
  public static async revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, "resources"),
        vscode.Uri.joinPath(extensionUri, "node_modules", "monaco-editor", "min")
      ]
    };
    await SOQLEditorProvider.attach(panel, extensionUri);
  }

  /** Wire HTML + message handling onto a (new or restored) panel. */
  private static async attach(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, initialQuery?: string, initialOrg?: string) {
    const { lastQuery, history } = await SOQLEditorProvider.loadSoqlState();
    const saved = SOQLEditorProvider.loadSavedQueries();
    panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri, initialQuery || lastQuery, history, saved, initialOrg);

    AuthInfo.warmAuthForOrg(null);
    OrgMetadataCache.warmDefaultOrg();
    warmOrgListCache();

    // Point the editor's IntelliSense buffer at the initial org and ensure no
    // SObject stubs are ever written for it (its org may be non-default).
    const wbUri = SOQLEditorProvider._bridge.getBufferUri();
    if (wbUri) {
      setBufferOrgOverride(wbUri.fsPath, initialOrg || null);
      setEphemeralBuffers([wbUri.toString()]);
    }

    const messageListener = panel.webview.onDidReceiveMessage(
      async (message) => {
        if (await handleResultsTableMessage(message, (m) => panel.webview.postMessage(m))) return;
        switch (message.command) {
          case "execute":
            await this.executeQuery(panel, message.query, message.targetOrg || null);
            break;
          case "wbCompletions":
            panel.webview.postMessage({
              command: "wbCompletions", requestId: message.requestId,
              items: await SOQLEditorProvider._bridge.completions(message.text || "", message.line || 0, message.character || 0)
            });
            break;
          case "wbHover":
            panel.webview.postMessage({
              command: "wbHover", requestId: message.requestId,
              hover: await SOQLEditorProvider._bridge.hover(message.text || "", message.line || 0, message.character || 0)
            });
            break;
          case "wbSetOrg": {
            const u = SOQLEditorProvider._bridge.getBufferUri();
            if (u) setBufferOrgOverride(u.fsPath, (typeof message.org === "string" && message.org) ? message.org : null);
            refreshLanguageServerSchema();
            break;
          }
          case "validateSoql":
            panel.webview.postMessage({
              command: "soqlMarkers",
              markers: await getSoqlMarkers((typeof message.org === "string" && message.org) ? message.org : null, message.text || "")
            });
            break;
          case "queryMore":
            await this.queryMore(panel, message.nextRecordsUrl, message.targetOrg || null);
            break;
          case "saveQuery":
            await this.promptSaveQuery(panel, message.query, message.suggestedName || "");
            break;
          case "deleteSavedQuery":
            await this.promptDeleteSavedQuery(panel, message.name);
            break;
          case "save":
            await this.saveChanges(panel, message.changes, message.targetOrg || null);
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
            await this.sendBuilderFields(panel, message.sobject, message.targetOrg || null, message.relName);
            break;
          case "getBuilderChildren":
            await this.sendBuilderChildren(panel, message.sobject, message.targetOrg || null);
            break;
          case "getBuilderChildFields":
            await this.sendBuilderChildFields(panel, message.childSobject, message.childRel, message.targetOrg || null);
            break;
          case "getFieldsForRelationship":
            await this.sendFieldsForRelationship(
              panel,
              message.relName,
              message.fromSobject,
              message.targetOrg || null
            );
            break;
          case "getFieldsForPath":
            await this.sendFieldsForPath(
              panel,
              message.fromSobject,
              Array.isArray(message.path) ? message.path : [],
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
          case "refreshCache": {
            const refreshOrg = (message.targetOrg as string | null) || null;
            OrgMetadataCache.invalidate(refreshOrg);
            AuthInfo.invalidateOrg(refreshOrg);
            const freshOrgs = await refreshOrgListCache();
            panel.webview.postMessage({ command: "orgList", orgs: freshOrgs });
            panel.webview.postMessage({ command: "cacheRefreshed" });
            break;
          }
          case "saveFile": {
            const suggested = (message.suggestedName as string) || "soql-export.csv";
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const uri = await vscode.window.showSaveDialog({
              defaultUri: ws ? vscode.Uri.file(path.join(ws, suggested)) : undefined,
              filters: suggested.endsWith(".json") ? { JSON: ["json"] } : { CSV: ["csv"], "All files": ["*"] }
            });
            if (!uri) break;
            try {
              fs.writeFileSync(uri.fsPath, String(message.content ?? ""), "utf8");
              vscode.window.showInformationMessage(`Exported ${path.basename(uri.fsPath)}`);
            } catch (e: any) {
              vscode.window.showErrorMessage(`Export failed: ${e?.message ?? e}`);
            }
            break;
          }
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
      const fields = await OrgMetadataCache.getFieldsAndRelations(targetOrg, sobject);
      panel.webview.postMessage({ command: "completions", kind: "fields", items: fields });
    } catch (e: any) {
      panel.webview.postMessage({ command: "completions", kind: "fields", items: [] });
    }
  }

  /**
   * Resolve a chain of parent-relationship names from a root sobject and return
   * the fields of the final target. Handles BOTH standard ("Owner", "CreatedBy",
   * "Account") and custom ("MyLookup__r") relationships, multiple hops deep
   * (e.g. Owner.Manager.Profile.<field>). 100% schema-driven — no guessing.
   */
  private static async sendFieldsForPath(
    panel: vscode.WebviewPanel,
    fromSobject: string,
    path: string[],
    targetOrg: string | null
  ) {
    const empty = () => panel.webview.postMessage({ command: "completions", kind: "fields", items: [] });
    if (!fromSobject) { empty(); return; }
    try {
      let current: string | null = fromSobject;
      for (const rel of path) {
        if (!current || !rel) { empty(); return; }
        current = await OrgMetadataCache.getRelationshipTarget(targetOrg, current, rel);
        if (!current) { empty(); return; } // relationship not found in schema → suggest nothing
      }
      const fields = await OrgMetadataCache.getFieldsAndRelations(targetOrg, current);
      panel.webview.postMessage({ command: "completions", kind: "fields", items: fields });
    } catch {
      empty();
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

  private static async sendBuilderFields(panel: vscode.WebviewPanel, sobject: string, targetOrg: string | null, relName?: string) {
    if (!sobject) {
      panel.webview.postMessage({ command: "builderFields", items: [], relName });
      return;
    }
    try {
      // For the object itself: include relationships so the UI can offer parent-field
      // traversal. For a relationship target (relName set): just its direct fields.
      const items = relName
        ? await OrgMetadataCache.getFieldsWithMeta(targetOrg, sobject)
        : await OrgMetadataCache.getFieldsAndRelations(targetOrg, sobject);
      panel.webview.postMessage({ command: "builderFields", items, relName });
    } catch (e: any) {
      panel.webview.postMessage({ command: "builderFields", items: [], relName });
    }
  }

  /** Child relationships of an object, for the builder's subquery picker. */
  private static async sendBuilderChildren(panel: vscode.WebviewPanel, sobject: string, targetOrg: string | null) {
    if (!sobject) {
      panel.webview.postMessage({ command: "builderChildren", items: [] });
      return;
    }
    try {
      const items = await OrgMetadataCache.getChildRelationships(targetOrg, sobject);
      panel.webview.postMessage({ command: "builderChildren", items });
    } catch {
      panel.webview.postMessage({ command: "builderChildren", items: [] });
    }
  }

  /** Fields of a child relationship's sObject, for the builder's subquery field picker. */
  private static async sendBuilderChildFields(
    panel: vscode.WebviewPanel,
    childSobject: string,
    childRel: string,
    targetOrg: string | null
  ) {
    try {
      const items = childSobject ? await OrgMetadataCache.getFieldsWithMeta(targetOrg, childSobject) : [];
      panel.webview.postMessage({ command: "builderChildFields", childRel, items });
    } catch {
      panel.webview.postMessage({ command: "builderChildFields", childRel, items: [] });
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
          nextRecordsUrl: result.nextRecordsUrl || null,
          instanceUrl: auth.instanceUrl,
          editableFields: editableFields
        });
        const history = await SOQLEditorProvider.saveSoqlOnExecute(query);
        panel.webview.postMessage({ command: "historyUpdated", history });
      } else {
        const err = result[0] || result;
        const message = err.message || err.errorDescription || JSON.stringify(result);
        SOQLEditorProvider.postQueryError(panel, message);
      }
    } catch (e: any) {
      SOQLEditorProvider.postQueryError(panel, e.message || e.stderr || JSON.stringify(e));
    } finally {
      panel.webview.postMessage({ command: "loading", value: false });
    }
  }

  /** Parse a SOQL error and surface it cleanly + inline (marker at Row:Column). */
  private static postQueryError(panel: vscode.WebviewPanel, raw: string): void {
    const parsed = parseSoqlError(raw);
    const label = parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message;
    panel.webview.postMessage({ command: "error", text: label, details: parsed.details, line: parsed.line, column: parsed.column });
  }

  /** Load the next page of records for the current result set (pagination). */
  private static async queryMore(panel: vscode.WebviewPanel, nextRecordsUrl: string, targetOrg: string | null) {
    try {
      panel.webview.postMessage({ command: "loadingMore", value: true });
      const { auth, result } = await SOQLEditorProvider.fetchNextRecords(nextRecordsUrl, targetOrg);
      if (result.records !== undefined) {
        const records = result.records as any[];
        const editableFields = await SOQLEditorProvider.getEditableFieldsByType(records, targetOrg);
        panel.webview.postMessage({
          command: "moreResults",
          data: records,
          totalSize: result.totalSize ?? records.length,
          done: result.done !== false,
          nextRecordsUrl: result.nextRecordsUrl || null,
          instanceUrl: auth.instanceUrl,
          editableFields: editableFields
        });
      } else {
        const err = result[0] || result;
        panel.webview.postMessage({ command: "error", text: err.message || JSON.stringify(result) });
      }
    } catch (e: any) {
      panel.webview.postMessage({ command: "error", text: e.message || e.stderr || JSON.stringify(e) });
    } finally {
      panel.webview.postMessage({ command: "loadingMore", value: false });
    }
  }

  // ── Saved queries ──────────────────────────────────────────────────────────
  private static loadSavedQueries(): SavedQuery[] {
    const dir = SOQLEditorProvider.getSoqlStorageDir();
    if (!dir) return [];
    try {
      const p = path.join(dir, SOQL_SAVED_FILE);
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (Array.isArray(parsed)) {
          return parsed.filter((q) => q && typeof q.name === "string" && typeof q.query === "string");
        }
      }
    } catch {
      /* ignore */
    }
    return [];
  }

  private static writeSavedQueries(list: SavedQuery[]): void {
    const dir = SOQLEditorProvider.getSoqlStorageDir();
    if (!dir) return;
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, SOQL_SAVED_FILE), JSON.stringify(list, null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }

  private static async saveNamedQuery(panel: vscode.WebviewPanel, name: string, query: string) {
    const trimmedName = (name || "").trim();
    const trimmedQuery = (query || "").trim();
    if (!trimmedName || !trimmedQuery) return;
    if (!SOQLEditorProvider.getSoqlStorageDir()) {
      panel.webview.postMessage({ command: "error", text: "Open a workspace folder to save queries." });
      return;
    }
    const list = SOQLEditorProvider.loadSavedQueries();
    const existing = list.findIndex((q) => q.name.toLowerCase() === trimmedName.toLowerCase());
    if (existing >= 0) list[existing] = { name: trimmedName, query: trimmedQuery };
    else list.unshift({ name: trimmedName, query: trimmedQuery });
    list.sort((a, b) => a.name.localeCompare(b.name));
    SOQLEditorProvider.writeSavedQueries(list);
    panel.webview.postMessage({ command: "savedQueries", items: list });
  }

  private static async deleteSavedQuery(panel: vscode.WebviewPanel, name: string) {
    const list = SOQLEditorProvider.loadSavedQueries().filter((q) => q.name !== name);
    SOQLEditorProvider.writeSavedQueries(list);
    panel.webview.postMessage({ command: "savedQueries", items: list });
  }

  /** Ask for a name (webview can't use window.prompt) then persist the query. */
  private static async promptSaveQuery(panel: vscode.WebviewPanel, query: string, suggestedName: string) {
    const trimmedQuery = (query || "").trim();
    if (!trimmedQuery) {
      vscode.window.showWarningMessage("Nothing to save — the query is empty.");
      return;
    }
    if (!SOQLEditorProvider.getSoqlStorageDir()) {
      vscode.window.showWarningMessage("Open a workspace folder to save queries.");
      return;
    }
    const existing = SOQLEditorProvider.loadSavedQueries();
    const name = await vscode.window.showInputBox({
      title: "Save SOQL query",
      prompt: "Name this query so you can recognise it later",
      value: (suggestedName || "").trim(),
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim() ? undefined : "Enter a name")
    });
    if (name === undefined) return; // user cancelled
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const clash = existing.find((q) => q.name.toLowerCase() === trimmedName.toLowerCase());
    if (clash) {
      const choice = await vscode.window.showWarningMessage(
        `A saved query named "${clash.name}" already exists. Overwrite it?`,
        { modal: true },
        "Overwrite"
      );
      if (choice !== "Overwrite") return;
    }
    await SOQLEditorProvider.saveNamedQuery(panel, trimmedName, trimmedQuery);
    vscode.window.showInformationMessage(`Saved query "${trimmedName}".`);
  }

  /** Confirm (host-side modal) before deleting a saved query. */
  private static async promptDeleteSavedQuery(panel: vscode.WebviewPanel, name: string) {
    if (!name) return;
    const choice = await vscode.window.showWarningMessage(
      `Delete saved query "${name}"?`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") return;
    await SOQLEditorProvider.deleteSavedQuery(panel, name);
  }

  /**
   * Coerce a string cell value (everything from contentEditable is a string) into the
   * JSON type Salesforce's REST PATCH expects, so inline edits work for all field types.
   */
  private static coerceCellValue(value: string): unknown {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (s === "") return null; // clear the field
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
    return s; // SF coerces numeric/date/picklist/reference strings on its own
  }

  private static async saveChanges(panel: vscode.WebviewPanel, changes: any, targetOrg: string | null) {
    try {
      panel.webview.postMessage({ command: "saving", value: true });

      const auth = await AuthInfo.getAuthInfoForOrg(targetOrg);
      if (!auth || !auth.accessToken || !auth.instanceUrl) {
        const msg = "Could not authenticate to the org to save changes.";
        panel.webview.postMessage({ command: "saveErrors", errors: [msg] });
        vscode.window.showErrorMessage(msg);
        panel.webview.postMessage({ command: "saveComplete", success: false });
        return;
      }
      const apiVersion = getToolingApiVersion();

      let successCount = 0;
      const errors: string[] = [];
      const savedIds: string[] = [];

      for (const id of Object.keys(changes)) {
        const recordChanges = changes[id];
        const type = recordChanges._type;
        const fieldsToUpdate: Record<string, string> = { ...recordChanges };
        delete fieldsToUpdate._type;

        if (!type) {
          errors.push(`Missing object type for ID ${id}`);
          continue;
        }

        // Build a single typed PATCH body for all changed fields on this record.
        const body: Record<string, unknown> = {};
        for (const field of Object.keys(fieldsToUpdate)) {
          body[field] = SOQLEditorProvider.coerceCellValue(fieldsToUpdate[field]);
        }

        try {
          const resp = await sfRequest(
            auth.instanceUrl,
            `/services/data/${apiVersion}/sobjects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
            "PATCH",
            auth.accessToken,
            body
          );
          if (resp.status >= 200 && resp.status < 300) {
            successCount++;
            savedIds.push(id);
          } else {
            let errMsg = `HTTP ${resp.status}`;
            try {
              const parsed = JSON.parse(resp.body);
              const first = Array.isArray(parsed) ? parsed[0] : parsed;
              if (first && first.message) errMsg = first.message;
            } catch {
              if (resp.body) errMsg = resp.body.slice(0, 300);
            }
            errors.push(`Record ${id}: ${errMsg}`);
          }
        } catch (e: any) {
          errors.push(`Record ${id}: ${e.message || String(e)}`);
        }
      }

      if (errors.length > 0) {
        panel.webview.postMessage({ command: "saveErrors", errors });
        vscode.window.showErrorMessage(`Some updates failed: ${errors.join("; ")}`);
      } else if (successCount > 0) {
        vscode.window.showInformationMessage(`Successfully saved ${successCount} record(s).`);
      }
      panel.webview.postMessage({ command: "saveComplete", success: errors.length === 0, savedIds });
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
    history: string[] = [],
    saved: SavedQuery[] = [],
    initialOrg?: string
  ) {
    const initialData = JSON.stringify({
      lastQuery: lastQuery || "",
      history: Array.isArray(history) ? history : [],
      saved: Array.isArray(saved) ? saved : [],
      initialOrg: initialOrg || ""
    });
    const initialDataEscaped = initialData.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    const monacoBase = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "node_modules", "monaco-editor", "min", "vs"));
    const cspSource = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-eval' 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; worker-src blob:; connect-src ${cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SOQL Builder &amp; Editor</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; }
        :root {
            --asfx-radius: 6px; --asfx-radius-sm: 4px;
            --asfx-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.28)));
            --asfx-border-strong: var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.45)));
            --asfx-card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-inactiveSelectionBackground));
            --asfx-accent: var(--vscode-button-background);
        }
        ::-webkit-scrollbar { width: 9px; height: 9px; }
        ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
        ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); background-clip: padding-box; }
        body {
            font-family: var(--vscode-font-family); font-size: 13px;
            color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
            margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden;
        }

        /* ── Header ── */
        .page-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 16px; background: var(--vscode-sideBarSectionHeader-background, var(--asfx-card-bg)); border-bottom: 1px solid var(--asfx-border); flex-shrink: 0; }
        .page-title { font-size: 13px; font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 8px; }
        .header-actions { display: flex; align-items: center; gap: 6px; }

        /* ── Run bar (Postman-style) ── */
        .run-bar { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); background: var(--asfx-card-bg); flex-shrink: 0; flex-wrap: wrap; }
        .rb-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
        .rb-spacer { flex: 1; min-width: 12px; }
        .rb-sep { width: 1px; align-self: stretch; margin: 2px 4px; background: var(--asfx-border); }
        #saved-select { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; min-width: 130px; max-width: 220px; outline: none; cursor: pointer; }
        .wb-spinner { width: 11px; height: 11px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; display: inline-block; animation: wb-spin .8s linear infinite; }
        @keyframes wb-spin { to { transform: rotate(360deg); } }
        /* Let the completion popup grow tall even when the editor is short. */
        .monaco-editor .suggest-widget { max-height: 360px !important; }
        .monaco-editor .suggest-widget .monaco-list { max-height: 340px !important; }
        #org-select { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; min-width: 160px; outline: none; cursor: pointer; }
        #org-select:focus { border-color: var(--vscode-focusBorder); }
        #history-select { padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; min-width: 150px; max-width: 260px; outline: none; cursor: pointer; }
        #cache-status-row { font-size: 10px; color: var(--vscode-descriptionForeground); }

        /* ── Buttons ── */
        button { background: var(--asfx-accent); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; border-radius: var(--asfx-radius-sm); font-size: 12px; font-family: inherit; }
        button:hover { filter: brightness(1.1); }
        button:disabled { opacity: .5; cursor: default; filter: none; }
        #execute-btn { font-weight: 700; padding: 7px 18px; }
        .btn-secondary { background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--asfx-border-strong); }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); filter: none; border-color: var(--vscode-focusBorder); }
        .btn-sm { padding: 3px 9px; font-size: 11px; }
        .btn-mini { font-size: 11px; padding: 3px 9px; cursor: pointer; font-family: inherit; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--asfx-border-strong); border-radius: var(--asfx-radius-sm); }
        .btn-mini:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
        .btn-refresh { background: transparent; border: 1px solid var(--asfx-border); color: var(--vscode-icon-foreground); padding: 4px 8px; font-size: 13px; border-radius: var(--asfx-radius-sm); cursor: pointer; flex-shrink: 0; line-height: 1.2; }
        .btn-refresh:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
        #save-btn { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }

        /* ── Content scroll ── */
        .content-wrap { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; min-height: 0; }

        /* ── Cards ── */
        .card { background: var(--asfx-card-bg); border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); overflow: hidden; flex-shrink: 0; }
        .card-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; cursor: pointer; user-select: none; }
        .card-head:hover { background: var(--vscode-list-hoverBackground); }
        .card-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-foreground); flex: 1; }
        .card-chevron { font-size: 10px; color: var(--vscode-descriptionForeground); }
        .card-actions { display: flex; align-items: center; gap: 6px; }
        .card-body { padding: 14px; display: flex; flex-direction: column; gap: 14px; }
        .card.collapsed .card-body { display: none; }
        /* The query card must NOT clip — the completion popup overflows it. */
        .card-query { overflow: visible; }
        .card-query .card-body { overflow: visible; }
        /* Builder card is toggled from the header button (.visible). */
        .builder-panel { display: none; }
        .builder-panel.visible { display: block; }

        /* ── Builder sections ── */
        .bsection { display: flex; flex-direction: column; gap: 6px; }
        .bsection-head { display: flex; align-items: center; gap: 8px; }
        .builder-field-search { padding: 3px 8px; min-width: 130px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 11px; outline: none; }
        .builder-field-search:focus { border-color: var(--vscode-focusBorder); }
        .bsection-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
        .bsection-spacer { flex: 1; }
        .brow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .brow > select, .brow > input { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; font-family: inherit; outline: none; }
        .brow > select:focus, .brow > input:focus { border-color: var(--vscode-focusBorder); }
        #builder-object { min-width: 220px; }
        #builder-limit { width: 90px; }
        .builder-actions { display: flex; gap: 8px; padding-top: 2px; }
        #builder-apply-btn { font-weight: 600; }

        /* Field checkbox grid */
        .builder-fields { max-height: 180px; overflow-y: auto; border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); padding: 6px; background: var(--vscode-input-background); display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 1px 12px; font-size: 12px; }
        .builder-fields label { display: flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; padding: 2px 4px; border-radius: 3px; overflow: hidden; }
        .builder-fields label:hover { background: var(--vscode-list-hoverBackground); }
        .builder-fields input { margin: 0; accent-color: var(--asfx-accent); }

        /* WHERE rows */
        .bw-row { display: flex; gap: 6px; align-items: center; margin-bottom: 5px; }
        .bw-row select, .bw-row input { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; font-family: inherit; outline: none; }
        .bw-row select:focus, .bw-row input:focus { border-color: var(--vscode-focusBorder); }
        .bw-conj { flex: 0 0 66px; }
        .bw-field { flex: 2; min-width: 0; }
        .bw-op { flex: 0 0 82px; }
        .bw-val { flex: 2; min-width: 0; }
        .bw-remove { flex: 0 0 26px; cursor: pointer; background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); border-radius: var(--asfx-radius-sm); }
        .bw-remove:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-errorForeground); }

        /* Related-field chips */
        #builder-rel-select, #builder-rel-field { padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; font-family: inherit; outline: none; min-width: 150px; }
        .builder-rel-chips { display: flex; flex-wrap: wrap; gap: 6px; }
        .rel-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; padding: 3px 8px; border-radius: 12px; background: color-mix(in srgb, var(--asfx-accent) 18%, transparent); color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family, monospace); }
        .rel-chip-x { cursor: pointer; opacity: .7; }
        .rel-chip-x:hover { opacity: 1; color: var(--vscode-errorForeground); }

        /* ── Query editor card ── */
        .query-wrap { position: relative; }
        textarea#query-input { width: 100%; box-sizing: border-box; height: 110px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); padding: 10px; resize: vertical; line-height: 1.55; outline: none; }
        textarea#query-input:focus { border-color: var(--vscode-focusBorder); }
        #completion-list { position: absolute; left: 0; top: 100%; margin: 2px 0 0; max-height: 220px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--asfx-card-bg)); border: 1px solid var(--vscode-dropdown-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); z-index: 100; list-style: none; padding: 2px 0; min-width: 220px; box-shadow: 0 6px 16px rgba(0,0,0,0.3); display: none; }
        #completion-list.visible { display: block; }
        #completion-list li { padding: 4px 10px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; display: flex; align-items: center; gap: 6px; }
        #completion-list li:hover, #completion-list li.selected { background: var(--vscode-list-hoverBackground); }
        .type-badge { display: inline-block; min-width: 20px; text-align: center; font-size: 10px; font-weight: 700; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 3px; padding: 1px 3px; flex-shrink: 0; }
        .type-badge.rel-badge { color: var(--vscode-button-foreground); background: var(--asfx-accent); }
        .rel-target { color: var(--vscode-descriptionForeground); font-size: 10px; font-style: italic; margin-left: 4px; }
        .query-hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
        .query-hint kbd { font-family: var(--vscode-editor-font-family, monospace); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 3px; padding: 0 4px; }

        /* ── Error ── */
        .error { color: var(--vscode-errorForeground); white-space: pre-wrap; font-size: 12px; padding: 9px 12px; border-radius: var(--asfx-radius-sm); background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.08)); border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); display: none; flex-shrink: 0; }
        .error:not(:empty) { display: block; }

        /* ── Results card ── */
        .results-card { flex: 1 0 auto; min-height: 340px; display: flex; flex-direction: column; }
        .results-toolbar { display: flex; align-items: center; gap: 6px; }
        .results-count { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-weight: 600; }
        .results-wrap { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; padding: 0; }
        #results-container { overflow: auto; flex: 1; }
        #results-container > p, #results-container:empty::before { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 14px; display: block; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { text-align: left; padding: 5px 9px; border-bottom: 1px solid var(--asfx-border); border-right: 1px solid var(--asfx-border); vertical-align: top; }
        th { background: var(--vscode-sideBarSectionHeader-background, var(--asfx-card-bg)); position: sticky; top: 0; z-index: 1; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
        tr:hover td { background: var(--vscode-list-hoverBackground); }
        td[contenteditable="true"]:focus { outline: 2px solid var(--vscode-focusBorder); background: var(--vscode-input-background); }
        td.editable-cell { cursor: text; }
        td.editable-cell:hover { background: var(--vscode-input-background); box-shadow: inset 0 0 0 1px var(--vscode-input-border, var(--asfx-border)); }
        td.editable-cell::after { content: "✎"; float: right; margin-left: 6px; opacity: 0; font-size: 10px; color: var(--vscode-descriptionForeground); }
        td.editable-cell:hover::after { opacity: .6; }
        .changed { background-color: rgba(255, 200, 0, 0.15) !important; }
        .nested-cell { padding: 4px; white-space: normal; }
        .nested-table { width: 100%; font-size: 11px; margin: 4px 0; }
        .nested-table th, .nested-table td { padding: 3px 6px; font-size: 11px; }
        .expandable { cursor: pointer; user-select: none; }
        .expandable::before { content: '▶ '; font-size: 10px; opacity: .7; }
        .expandable.open::before { content: '▼ '; }
        .status-bar { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--asfx-border); flex-shrink: 0; }
        #results-container a { color: var(--vscode-textLink-foreground); text-decoration: none; }
        #results-container a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
        td.readonly-cell { background: var(--asfx-card-bg); color: var(--vscode-descriptionForeground); cursor: not-allowed; border-left: 2px solid var(--asfx-border); }
        ${resultsTableCss()}
    </style>
</head>
<body>
    <div class="page-header">
        <div class="page-title"><span>🔍</span> SOQL Workbench</div>
        <div class="header-actions">
            <button id="builder-toggle-btn" type="button" class="btn-secondary btn-sm">▼ Show Builder</button>
        </div>
    </div>

    <script type="application/json" id="soql-initial-data">${initialDataEscaped}</script>

    <div class="content-wrap">
        <!-- Visual builder (toggled from the header) -->
        <div id="builder-panel" class="card builder-panel">
            <div class="card-head" style="cursor:default;">
                <span class="card-title">Visual Query Builder</span>
                <span class="card-chevron">point &amp; click → SOQL</span>
            </div>
            <div class="card-body">
                <div class="bsection">
                    <span class="bsection-label">Object</span>
                    <div class="brow"><select id="builder-object"><option value="">Select object…</option></select></div>
                </div>
                <div class="bsection">
                    <div class="bsection-head"><span class="bsection-label">Fields</span>
                        <input type="text" id="builder-field-search" class="builder-field-search" placeholder="Filter fields…" />
                        <span class="bsection-spacer"></span>
                        <button type="button" id="builder-select-all" class="btn-mini">Select all</button>
                        <button type="button" id="builder-select-none" class="btn-mini">Clear</button>
                    </div>
                    <div id="builder-fields" class="builder-fields"></div>
                </div>
                <div class="bsection">
                    <span class="bsection-label">Related (parent) fields</span>
                    <div class="brow">
                        <select id="builder-rel-select"><option value="">— relationship —</option></select>
                        <select id="builder-rel-field"><option value="">— field —</option></select>
                        <button type="button" id="builder-rel-add" class="btn-mini">+ Add field</button>
                    </div>
                    <div id="builder-rel-chips" class="builder-rel-chips"></div>
                </div>
                <div class="bsection">
                    <span class="bsection-label">Child relationships (subqueries)</span>
                    <div class="brow">
                        <select id="builder-child-select"><option value="">— child relationship —</option></select>
                        <select id="builder-child-field"><option value="">— field —</option></select>
                        <button type="button" id="builder-child-add" class="btn-mini">+ Add field</button>
                    </div>
                    <div id="builder-child-chips" class="builder-rel-chips"></div>
                </div>
                <div class="bsection">
                    <span class="bsection-label">Filters (WHERE)</span>
                    <div id="builder-where-block">
                        <div id="builder-where-rows"></div>
                        <button type="button" id="builder-add-where" class="btn-mini" style="align-self:flex-start;">+ Condition</button>
                    </div>
                </div>
                <div class="bsection">
                    <span class="bsection-label">Sort &amp; limit</span>
                    <div class="brow">
                        <select id="builder-order-field"><option value="">— order by —</option></select>
                        <select id="builder-order-dir"><option value="ASC">ASC</option><option value="DESC">DESC</option></select>
                        <span style="opacity:.4;">·</span>
                        <span class="bsection-label">LIMIT</span>
                        <input type="number" id="builder-limit" min="1" max="2000" placeholder="e.g. 100" />
                    </div>
                </div>
                <div class="builder-actions">
                    <button type="button" id="builder-from-query-btn" class="btn-secondary btn-sm" title="Read the current query text back into the builder">↺ From query</button>
                    <button type="button" id="builder-apply-btn" class="btn-secondary btn-sm">Apply to query →</button>
                    <button type="button" id="builder-run-btn" title="Apply the builder to the query and run it">▶ Apply &amp; Execute</button>
                </div>
            </div>
        </div>

        <!-- Query editor -->
        <div class="card card-query">
            <div class="card-head" style="cursor:default;">
                <span class="card-title">Query</span>
                <span class="query-hint"><kbd>⌘/Ctrl+Enter</kbd> run · <kbd>Ctrl+Space</kbd> complete</span>
                <span class="bsection-spacer" style="flex:1;"></span>
                <span id="wb-busy" title="Loading schema from the org…" style="display:none; align-items:center; gap:5px; font-size:11px; opacity:0.85; margin-right:8px;"><span class="wb-spinner"></span>schema…</span>
                <button type="button" id="format-btn" class="btn-secondary btn-sm" title="Format / prettify (Shift+Alt+F)" onclick="formatSoql()">✨ Format</button>
            </div>
            <div class="card-body" style="gap:8px;">
                <div class="query-wrap">
                    <div id="query-editor" style="height:220px; width:100%; border:1px solid var(--asfx-border); border-radius:var(--asfx-radius-sm); overflow:hidden;"></div>
                    <ul id="completion-list" style="display:none;"></ul>
                </div>
            </div>
        </div>

        <!-- Run bar (org / history / execute) — sits between query and results -->
        <div class="run-bar">
            <span class="rb-label">Org</span>
            <select id="org-select" title="Org to run the query against"><option value="">Default org</option></select>
            <button type="button" id="btn-refresh-cache" class="btn-refresh" title="Refresh schema &amp; org cache">🔄</button>
            <span id="cache-status-row"></span>
            <span class="rb-spacer"></span>
            <span class="rb-label">History</span>
            <select id="history-select" title="Reopen a previous query"><option value="">— recent —</option></select>
            <button type="button" id="history-clear-btn" class="btn-refresh" title="Clear history">&#x2715;</button>
            <span class="rb-sep"></span>
            <span class="rb-label">Saved</span>
            <select id="saved-select" title="Open a saved query"><option value="">— saved —</option></select>
            <button type="button" id="saved-save-btn" class="btn-refresh" title="Save current query">💾</button>
            <button type="button" id="saved-delete-btn" class="btn-refresh" title="Delete selected saved query">🗑</button>
            <button id="execute-btn">&#9654; Execute</button>
        </div>

        <div id="error-msg" class="error"></div>

        <!-- Results -->
        <div class="card results-card">
            <div class="card-head" style="cursor:default;">
                <span class="card-title">Results</span>
                <div class="card-actions results-toolbar" id="results-toolbar" style="display:none;">
                    <span id="results-count" class="results-count"></span>
                    <button type="button" id="load-more-btn" class="btn-mini" style="display:none;" title="Load the next page of records">⬇ Load more</button>
                    <button id="save-btn" class="btn-mini" style="display:none;">💾 Save edits</button>
                    <button id="discard-btn" class="btn-mini" style="display:none;">Discard</button>
                    <button type="button" class="btn-mini" onclick="exportResults('csv')" title="Download results as CSV">⬇ CSV</button>
                    <button type="button" class="btn-mini" onclick="exportResults('json')" title="Download results as JSON">⬇ JSON</button>
                </div>
            </div>
            <div class="results-wrap">
                <div id="results-container"></div>
                <div class="status-bar" id="status-bar"></div>
            </div>
        </div>
    </div>

    <script src="${monacoBase}/loader.js"></script>
    <script>${resultsTableScript()}</script>
    <script>
        const vscode = acquireVsCodeApi();
        const MONACO_BASE = '${monacoBase}';
        // ── Monaco-backed query editor with a textarea-compatible shim ──────────
        // The rest of this view (builder, results, history) reads/writes
        // queryInput.value; we back it with a Monaco 'soql' editor whose completion
        // and hover come from the shared language server (single implementation).
        let soqlEditor = null, _pendingValue = null, _onChangeCb = null;
        const queryInput = {
            get value() { return soqlEditor ? soqlEditor.getValue() : (_pendingValue || ''); },
            set value(v) { if (soqlEditor) soqlEditor.setValue(v || ''); else _pendingValue = v || ''; },
            focus() { if (soqlEditor) soqlEditor.focus(); },
            get selectionStart() { try { return soqlEditor ? soqlEditor.getModel().getOffsetAt(soqlEditor.getPosition()) : 0; } catch (e) { return 0; } },
            get selectionEnd() { return this.selectionStart; },
            setSelectionRange(s) { try { if (soqlEditor) { const p = soqlEditor.getModel().getPositionAt(s); soqlEditor.setPosition(p); soqlEditor.revealPositionInCenterIfOutsideViewport(p); } } catch (e) {} },
            addEventListener() { /* legacy textarea listeners are no-ops; Monaco handles input */ }
        };
        let _reqId = 0; const _pending = {};
        let _busy = 0; function setBusy(d){ _busy = Math.max(0, _busy + d); const b = document.getElementById('wb-busy'); if (b) b.style.display = _busy > 0 ? 'inline-flex' : 'none'; }
        require.config({ paths: { vs: MONACO_BASE } });
        self.MonacoEnvironment = { getWorkerUrl: function () { return URL.createObjectURL(new Blob(["self.MonacoEnvironment={baseUrl:'" + MONACO_BASE + "/'};importScripts('" + MONACO_BASE + "/base/worker/workerMain.js');"], { type: 'text/javascript' })); } };
        require(['vs/editor/editor.main'], function () {
            function mapKind(k){ const M=monaco.languages.CompletionItemKind; const T={0:M.Text,1:M.Method,2:M.Function,3:M.Constructor,4:M.Field,5:M.Variable,6:M.Class,7:M.Interface,8:M.Module,9:M.Property,10:M.Unit,11:M.Value,12:M.Enum,13:M.Keyword,14:M.Snippet,17:M.Reference,19:M.EnumMember,20:M.Constant,21:M.Struct}; return T[k]!=null?T[k]:M.Text; }
            monaco.languages.register({ id: 'soql' });
            monaco.languages.setMonarchTokensProvider('soql', { ignoreCase: true,
                keywords: ['select','from','where','limit','offset','order','by','group','having','asc','desc','nulls','first','last','and','or','not','like','in','includes','excludes','null','true','false','count','count_distinct','sum','avg','min','max','using','scope','with','data','category','for','view','reference','update','tracking','viewstat','typeof','when','then','else','end'],
                tokenizer: { root: [ [/'(?:[^'\\\\]|\\\\.)*'/, 'string'], [/\\b\\d+(\\.\\d+)?\\b/, 'number'], [/[a-zA-Z_][\\w.]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }] ] } });
            monaco.languages.registerCompletionItemProvider('soql', { triggerCharacters: ['.', ' ', ',', '('], provideCompletionItems: function (model, pos) {
                return new Promise(function (resolve) { const id = ++_reqId; _pending[id] = function (items) { const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }; resolve({ suggestions: items.map(function (it) { return { label: it.label, kind: mapKind(it.kind), insertText: it.insertText || it.label, insertTextRules: it.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined, detail: it.detail, documentation: it.documentation ? { value: it.documentation } : undefined, sortText: it.sortText, filterText: it.filterText, range: range }; }) }); }; setBusy(1); vscode.postMessage({ command: 'wbCompletions', requestId: id, text: model.getValue(), line: pos.lineNumber - 1, character: pos.column - 1 }); });
            } });
            monaco.languages.registerHoverProvider('soql', { provideHover: function (model, pos) {
                return new Promise(function (resolve) { const id = ++_reqId; _pending[id] = function (h) { if (!h || !h.contents || !h.contents.length) { resolve(null); return; } resolve({ contents: h.contents.map(function (v) { return { value: v }; }) }); }; setBusy(1); vscode.postMessage({ command: 'wbHover', requestId: id, text: model.getValue(), line: pos.lineNumber - 1, character: pos.column - 1 }); });
            } });
            const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
            soqlEditor = monaco.editor.create(document.getElementById('query-editor'), { value: _pendingValue || '', language: 'soql', theme: dark ? 'vs-dark' : 'vs', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, quickSuggestions: true, quickSuggestionsDelay: 200, fixedOverflowWidgets: true });
            _pendingValue = null;
            soqlEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function () { runQuery(); });
            soqlEditor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Enter, function () { runQuery(); });
            if (_onChangeCb) soqlEditor.onDidChangeModelContent(_onChangeCb);
            // Validate fields against the schema (debounced) → red squiggles.
            let _valTimer = null;
            function scheduleValidate() { if (_valTimer) clearTimeout(_valTimer); _valTimer = setTimeout(function () { vscode.postMessage({ command: 'validateSoql', org: currentTargetOrg(), text: soqlEditor.getValue() }); }, 400); }
            soqlEditor.onDidChangeModelContent(scheduleValidate);
            soqlEditor.onDidChangeModelContent(clearSoqlErrorMarker); // stale once edited
            scheduleValidate();
            window.__soqlScheduleValidate = scheduleValidate;
        });
        // Inline marker for a run-time query error (from the API's Row:Column).
        function setSoqlErrorMarker(line, column, text) {
            if (!soqlEditor || !line) return;
            try {
                const model = soqlEditor.getModel();
                let col = column || 1, endCol = col + 1;
                const w = model.getWordAtPosition({ lineNumber: line, column: col });
                if (w) { col = w.startColumn; endCol = w.endColumn; }
                monaco.editor.setModelMarkers(model, 'asfx-soql-error', [{ severity: monaco.MarkerSeverity.Error, message: text, startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: endCol }]);
            } catch (e) {}
        }
        function clearSoqlErrorMarker() { if (soqlEditor) { try { monaco.editor.setModelMarkers(soqlEditor.getModel(), 'asfx-soql-error', []); } catch (e) {} } }
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
        const builderWhereRows = document.getElementById('builder-where-rows');
        const builderAddWhere = document.getElementById('builder-add-where');
        const builderRelSelect = document.getElementById('builder-rel-select');
        const builderRelField = document.getElementById('builder-rel-field');
        const builderRelAdd = document.getElementById('builder-rel-add');
        const builderRelChips = document.getElementById('builder-rel-chips');
        const builderOrderField = document.getElementById('builder-order-field');
        const builderOrderDir = document.getElementById('builder-order-dir');
        const builderLimit = document.getElementById('builder-limit');
        const builderApplyBtn = document.getElementById('builder-apply-btn');
        const builderChildSelect = document.getElementById('builder-child-select');
        const builderChildField = document.getElementById('builder-child-field');
        const builderChildAdd = document.getElementById('builder-child-add');
        const builderChildChips = document.getElementById('builder-child-chips');
        const builderFromQueryBtn = document.getElementById('builder-from-query-btn');
        const orgSelect = document.getElementById('org-select');
        let initialOrgPreset = '';
        const historySelect = document.getElementById('history-select');
        const historyClearBtn = document.getElementById('history-clear-btn');
        const savedSelect = document.getElementById('saved-select');
        const savedSaveBtn = document.getElementById('saved-save-btn');
        const savedDeleteBtn = document.getElementById('saved-delete-btn');
        const loadMoreBtn = document.getElementById('load-more-btn');

        let fullHistory = [];
        let savedQueries = [];        // [{name, query}]
        let nextRecordsUrl = null;    // pagination cursor for the current result set
        let resultTotalSize = 0;
        let builderChildList = [];    // [{name, sobject}] child relationships of the root object
        let selectedChildFields = []; // [{rel, field}] picked subquery fields
        let pendingBuilderApply = null; // parsed query awaiting field load (two-way sync)

        const soqlInitialEl = document.getElementById('soql-initial-data');
        if (soqlInitialEl && soqlInitialEl.textContent) {
            try {
                const data = JSON.parse(soqlInitialEl.textContent);
                if (data.lastQuery && typeof data.lastQuery === 'string') queryInput.value = data.lastQuery;
                if (Array.isArray(data.history)) {
                    fullHistory = data.history;
                    renderHistoryOptions(fullHistory);
                }
                if (Array.isArray(data.saved)) {
                    savedQueries = data.saved;
                    renderSavedOptions(savedQueries);
                }
                if (data.initialOrg) { initialOrgPreset = data.initialOrg; vscode.postMessage({ command: 'getOrgList' }); }
            } catch (e) {}
        }

        // ── Saved queries ─────────────────────────────────────────────────────
        function renderSavedOptions(items) {
            savedQueries = items || [];
            while (savedSelect.options.length > 1) savedSelect.remove(1);
            savedQueries.forEach((q) => {
                const opt = document.createElement('option');
                opt.value = q.name;
                opt.textContent = q.name;
                opt.title = q.query;
                savedSelect.appendChild(opt);
            });
        }
        if (savedSelect) savedSelect.addEventListener('change', () => {
            const found = savedQueries.find(q => q.name === savedSelect.value);
            if (found) { queryInput.value = found.query; errorMsg.textContent = ''; queryInput.focus(); }
        });
        if (savedSaveBtn) savedSaveBtn.addEventListener('click', () => {
            const query = (queryInput.value || '').trim();
            if (!query) { errorMsg.textContent = 'Nothing to save — the query is empty.'; return; }
            // The host shows the name input box (webview window.prompt is a no-op in VS Code).
            vscode.postMessage({ command: 'saveQuery', query: query, suggestedName: savedSelect.value || '' });
        });
        if (savedDeleteBtn) savedDeleteBtn.addEventListener('click', () => {
            const name = savedSelect.value;
            if (!name) { errorMsg.textContent = 'Pick a saved query to delete.'; return; }
            vscode.postMessage({ command: 'deleteSavedQuery', name: name });
        });

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
            renderHistoryOptions(fullHistory);
        }

        if (historyClearBtn) {
            historyClearBtn.addEventListener('click', () => {
                fullHistory = [];
                renderHistoryOptions([]);
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
        let builderRelList = [];          // [{name, target}] relationships on the object
        let selectedRelFields = [];       // ["Owner.Name", "Account.Industry", ...]
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
            // Point editor completion/hover at the selected org (server-side override).
            vscode.postMessage({ command: 'wbSetOrg', org: currentTargetOrg() });
            if (window.__soqlScheduleValidate) window.__soqlScheduleValidate();
            if (builderPanel.classList.contains('visible')) {
                vscode.postMessage({ command: 'getBuilderObjectList', targetOrg: currentTargetOrg() });
            }
        });

        function refreshCache() {
            const btn = document.getElementById('btn-refresh-cache');
            if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
            const statusRow = document.getElementById('cache-status-row');
            if (statusRow) statusRow.textContent = 'Refreshing…';
            vscode.postMessage({ command: 'refreshCache', targetOrg: currentTargetOrg() });
        }

        const refreshCacheBtn = document.getElementById('btn-refresh-cache');
        if (refreshCacheBtn) refreshCacheBtn.addEventListener('click', refreshCache);

        builderToggleBtn.addEventListener('click', () => {
            const visible = builderPanel.classList.toggle('visible');
            builderToggleBtn.textContent = visible ? '▲ Hide Builder' : '▼ Show Builder';
            if (visible && builderObjectList.length === 0) {
                vscode.postMessage({ command: 'getBuilderObjectList', targetOrg: currentTargetOrg() });
            }
        });

        function escOp(op) { return op.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

        function opsForType(fieldType) {
            const t = (fieldType || '').toLowerCase();
            if (['double', 'integer', 'currency', 'percent', 'long'].includes(t)) return ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN'];
            if (t === 'date' || t === 'datetime') return ['=', '!=', '>', '<', '>=', '<='];
            if (t === 'boolean') return ['=', '!='];
            if (['picklist', 'multipicklist'].includes(t)) return ['=', '!=', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'];
            return ['=', '!=', 'LIKE', 'IN', 'NOT IN'];
        }
        function fieldOptionsHtml() {
            return '<option value="">— field —</option>' + builderFieldsList.map(f => '<option value="' + escOp(f.name) + '" data-type="' + escOp(f.type || '') + '">' + escOp(f.name) + '</option>').join('');
        }
        function refreshWhereRowOps(row) {
            const fsel = row.querySelector('.bw-field');
            const opsel = row.querySelector('.bw-op');
            const type = fsel.options[fsel.selectedIndex] ? fsel.options[fsel.selectedIndex].dataset.type : '';
            const cur = opsel.value;
            opsel.innerHTML = opsForType(type).map(op => '<option value="' + escOp(op) + '">' + escOp(op) + '</option>').join('');
            if (cur) opsel.value = cur;
        }
        function addWhereRow() {
            if (!builderWhereRows) return;
            const first = builderWhereRows.children.length === 0;
            const row = document.createElement('div');
            row.className = 'bw-row';
            row.innerHTML =
                '<select class="bw-conj" style="' + (first ? 'visibility:hidden;' : '') + '"><option value="AND">AND</option><option value="OR">OR</option></select>'
                + '<select class="bw-field">' + fieldOptionsHtml() + '</select>'
                + '<select class="bw-op"></select>'
                + '<input type="text" class="bw-val" placeholder="value" />'
                + '<button type="button" class="bw-remove" title="Remove condition">✕</button>';
            builderWhereRows.appendChild(row);
            refreshWhereRowOps(row);
            row.querySelector('.bw-field').addEventListener('change', () => refreshWhereRowOps(row));
            row.querySelector('.bw-remove').addEventListener('click', () => { row.remove(); fixFirstConj(); });
        }
        function fixFirstConj() {
            const rows = builderWhereRows ? builderWhereRows.querySelectorAll('.bw-row') : [];
            rows.forEach((r, i) => { const c = r.querySelector('.bw-conj'); if (c) c.style.visibility = i === 0 ? 'hidden' : ''; });
        }
        function repopulateWhereFields() {
            if (!builderWhereRows) return;
            builderWhereRows.querySelectorAll('.bw-row').forEach(row => {
                const fsel = row.querySelector('.bw-field');
                const cur = fsel.value;
                fsel.innerHTML = fieldOptionsHtml();
                if (cur) fsel.value = cur;
                refreshWhereRowOps(row);
            });
        }
        if (builderAddWhere) builderAddWhere.addEventListener('click', () => { addWhereRow(); fixFirstConj(); });

        builderObject.addEventListener('change', () => {
            const sobject = builderObject.value;
            builderFieldsList = [];
            builderRelList = [];
            selectedRelFields = [];
            builderChildList = [];
            selectedChildFields = [];
            renderRelChips();
            renderChildChips();
            builderFieldsEl.innerHTML = '';
            if (builderRelSelect) builderRelSelect.innerHTML = '<option value="">— relationship —</option>';
            if (builderRelField) builderRelField.innerHTML = '<option value="">— field —</option>';
            if (builderChildSelect) builderChildSelect.innerHTML = '<option value="">— child relationship —</option>';
            if (builderChildField) builderChildField.innerHTML = '<option value="">— field —</option>';
            if (builderWhereRows) builderWhereRows.innerHTML = '';
            addWhereRow();
            builderOrderField.innerHTML = '<option value="">—</option>';
            if (sobject) {
                vscode.postMessage({ command: 'getBuilderFields', sobject: sobject, targetOrg: currentTargetOrg() });
                vscode.postMessage({ command: 'getBuilderChildren', sobject: sobject, targetOrg: currentTargetOrg() });
            }
        });

        // ── Child relationships (subqueries) ─────────────────────────────────
        if (builderChildSelect) builderChildSelect.addEventListener('change', () => {
            const opt = builderChildSelect.options[builderChildSelect.selectedIndex];
            const childSobject = opt ? opt.dataset.sobject : '';
            builderChildField.innerHTML = '<option value="">— field —</option>';
            if (builderChildSelect.value && childSobject) {
                vscode.postMessage({ command: 'getBuilderChildFields', childSobject: childSobject, childRel: builderChildSelect.value, targetOrg: currentTargetOrg() });
            }
        });
        if (builderChildAdd) builderChildAdd.addEventListener('click', () => {
            const rel = builderChildSelect.value, field = builderChildField.value;
            if (!rel || !field) return;
            if (!selectedChildFields.some(c => c.rel === rel && c.field === field)) {
                selectedChildFields.push({ rel: rel, field: field });
                renderChildChips();
            }
        });
        function renderChildChips() {
            if (!builderChildChips) return;
            builderChildChips.innerHTML = selectedChildFields.map((c, i) =>
                '<span class="rel-chip">' + (c.rel + '.' + c.field).replace(/</g,'&lt;') + '<span class="rel-chip-x" data-i="' + i + '">✕</span></span>'
            ).join('');
            builderChildChips.querySelectorAll('.rel-chip-x').forEach(x => x.addEventListener('click', () => {
                selectedChildFields.splice(parseInt(x.dataset.i, 10), 1); renderChildChips();
            }));
        }
        /** Build the (SELECT ... FROM Rel) subquery fragments grouped per child relationship. */
        function buildChildSubqueries() {
            const byRel = {};
            selectedChildFields.forEach(c => { (byRel[c.rel] = byRel[c.rel] || []).push(c.field); });
            return Object.keys(byRel).map(rel => {
                const flds = byRel[rel];
                if (flds.indexOf('Id') === -1) flds.unshift('Id');
                return '(SELECT ' + flds.join(', ') + ' FROM ' + rel + ')';
            });
        }

        // Select all / Clear act on the fields currently visible (respect the filter).
        builderSelectAll.addEventListener('click', () => {
            builderFieldsEl.querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') { const cb = l.querySelector('input[type="checkbox"]'); if (cb) cb.checked = true; } });
        });
        builderSelectNone.addEventListener('click', () => {
            builderFieldsEl.querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') { const cb = l.querySelector('input[type="checkbox"]'); if (cb) cb.checked = false; } });
        });
        // Filter the field checkboxes by name (keeps checked state intact).
        const builderFieldSearch = document.getElementById('builder-field-search');
        function applyFieldFilter() {
            const term = builderFieldSearch ? builderFieldSearch.value.trim().toLowerCase() : '';
            builderFieldsEl.querySelectorAll('label').forEach(l => {
                const cb = l.querySelector('input[type="checkbox"]');
                const name = cb ? cb.value.toLowerCase() : l.textContent.toLowerCase();
                l.style.display = (!term || name.indexOf(term) !== -1) ? '' : 'none';
            });
        }
        if (builderFieldSearch) builderFieldSearch.addEventListener('input', applyFieldFilter);

        // ── Related (parent) fields ──────────────────────────────────────────
        if (builderRelSelect) builderRelSelect.addEventListener('change', () => {
            const opt = builderRelSelect.options[builderRelSelect.selectedIndex];
            const target = opt ? opt.dataset.target : '';
            builderRelField.innerHTML = '<option value="">— field —</option>';
            if (builderRelSelect.value && target) {
                vscode.postMessage({ command: 'getBuilderFields', sobject: target, relName: builderRelSelect.value, targetOrg: currentTargetOrg() });
            }
        });
        if (builderRelAdd) builderRelAdd.addEventListener('click', () => {
            const rel = builderRelSelect.value, field = builderRelField.value;
            if (!rel || !field) return;
            const path = rel + '.' + field;
            if (selectedRelFields.indexOf(path) === -1) { selectedRelFields.push(path); renderRelChips(); }
        });
        function renderRelChips() {
            if (!builderRelChips) return;
            builderRelChips.innerHTML = selectedRelFields.map((p, i) =>
                '<span class="rel-chip">' + p.replace(/</g,'&lt;') + '<span class="rel-chip-x" data-i="' + i + '">✕</span></span>'
            ).join('');
            builderRelChips.querySelectorAll('.rel-chip-x').forEach(x => x.addEventListener('click', () => {
                selectedRelFields.splice(parseInt(x.dataset.i, 10), 1); renderRelChips();
            }));
        }

        function buildWhereClauseFromBuilder() {
            if (!builderWhereRows) return '';
            const esc = (s) => String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
            const rows = builderWhereRows.querySelectorAll('.bw-row');
            let clause = '';
            let any = false;
            rows.forEach((row) => {
                const field = row.querySelector('.bw-field').value;
                const op = row.querySelector('.bw-op').value;
                const raw = row.querySelector('.bw-val').value.trim();
                const conj = row.querySelector('.bw-conj').value || 'AND';
                if (!field || raw === '') return;
                const fsel = row.querySelector('.bw-field');
                const type = (fsel.options[fsel.selectedIndex] ? fsel.options[fsel.selectedIndex].dataset.type : '') || '';
                const t = type.toLowerCase();
                const bare = ['double','integer','currency','percent','long','boolean','date','datetime'].includes(t);
                const one = (v) => bare ? String(v).trim() : "'" + esc(String(v).trim()) + "'";
                let cond;
                if (op === 'IN' || op === 'NOT IN' || op === 'INCLUDES' || op === 'EXCLUDES') {
                    const list = raw.split(',').map(s => one(s)).join(', ');
                    cond = field + ' ' + op + ' (' + list + ')';
                } else if (op === 'LIKE') {
                    cond = field + " LIKE '" + esc(raw) + "'";
                } else {
                    cond = field + ' ' + op + ' ' + one(raw);
                }
                clause += (any ? ' ' + conj + ' ' : ' WHERE ') + cond;
                any = true;
            });
            return clause;
        }

        function buildQueryFromBuilder() {
            const sobject = builderObject.value;
            if (!sobject) return '';
            const fields = Array.from(builderFieldsEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value).concat(selectedRelFields).concat(buildChildSubqueries());
            if (fields.length === 0) return '';
            const selectList = fields.join(', ');
            let q = 'SELECT ' + selectList + ' FROM ' + sobject;
            q += buildWhereClauseFromBuilder();
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

        const builderRunBtn = document.getElementById('builder-run-btn');
        if (builderRunBtn) builderRunBtn.addEventListener('click', () => {
            const query = buildQueryFromBuilder();
            if (!query) { errorMsg.textContent = 'Pick an object and at least one field first.'; return; }
            queryInput.value = query;
            errorMsg.textContent = '';
            runQuery();
        });

        // ── Two-way sync: parse the query text back into the builder ───────────
        function splitTopLevel(str, sep) {
            const out = []; let depth = 0; let inq = false; let cur = '';
            for (let i = 0; i < str.length; i++) {
                const ch = str[i];
                if (ch === "'") { inq = !inq; cur += ch; continue; }
                if (!inq && ch === '(') { depth++; cur += ch; continue; }
                if (!inq && ch === ')') { depth--; cur += ch; continue; }
                if (!inq && depth === 0 && ch === sep) { if (cur.trim() !== '') out.push(cur.trim()); cur = ''; continue; }
                cur += ch;
            }
            if (cur.trim() !== '') out.push(cur.trim());
            return out;
        }
        function splitWhereConds(where) {
            const conds = []; let depth = 0; let inq = false; let start = 0; let lastConj = 'AND';
            for (let i = 0; i < where.length; i++) {
                const ch = where[i];
                if (ch === "'") { inq = !inq; continue; }
                if (inq) continue;
                if (ch === '(') { depth++; continue; }
                if (ch === ')') { depth--; continue; }
                if (depth === 0) {
                    const rest = where.slice(i);
                    const mAnd = /^\\s+AND\\s+/i.exec(rest);
                    const mOr = !mAnd ? /^\\s+OR\\s+/i.exec(rest) : null;
                    const m = mAnd || mOr;
                    if (m) {
                        const e = where.slice(start, i).trim();
                        if (e) conds.push({ conj: lastConj, expr: e });
                        lastConj = mAnd ? 'AND' : 'OR';
                        i += m[0].length - 1; start = i + 1;
                    }
                }
            }
            const tail = where.slice(start).trim();
            if (tail) conds.push({ conj: lastConj, expr: tail });
            return conds;
        }
        function unquoteVal(raw) {
            let v = raw.trim();
            if (v[0] === '(' && v[v.length - 1] === ')') v = v.slice(1, -1);
            return splitTopLevel(v, ',').map(function (part) {
                let p = part.trim();
                if (p[0] === "'" && p[p.length - 1] === "'") p = p.slice(1, -1).replace(/\\\\'/g, "'").replace(/\\\\\\\\/g, '\\\\');
                return p;
            }).join(',');
        }
        function parseQueryIntoBuilder() {
            const q = (queryInput.value || '').replace(/\\s+/g, ' ').trim();
            const m = /^SELECT\\s+(.+?)\\s+FROM\\s+([A-Za-z0-9_]+)(.*)$/i.exec(q);
            if (!m) { errorMsg.textContent = 'Could not parse the query into the builder.'; return; }
            const selectPart = m[1];
            const object = m[2];
            let rest = m[3] || '';
            const parsed = { object: object, fields: [], relFields: [], childFields: [], where: [], orderField: '', orderDir: 'ASC', limit: '' };
            splitTopLevel(selectPart, ',').forEach(function (f) {
                const sub = /^\\(\\s*SELECT\\s+(.+?)\\s+FROM\\s+([A-Za-z0-9_]+)\\s*(?:WHERE[\\s\\S]*?)?\\)$/i.exec(f);
                if (sub) {
                    const rel = sub[2];
                    splitTopLevel(sub[1], ',').forEach(function (cf) { parsed.childFields.push({ rel: rel, field: cf.trim() }); });
                } else if (f.indexOf('.') !== -1) {
                    parsed.relFields.push(f);
                } else {
                    parsed.fields.push(f);
                }
            });
            let mLimit = /\\bLIMIT\\s+(\\d+)\\b/i.exec(rest);
            if (mLimit) { parsed.limit = mLimit[1]; rest = rest.replace(mLimit[0], ''); }
            let mOrder = /\\bORDER\\s+BY\\s+([A-Za-z0-9_.]+)\\s*(ASC|DESC)?/i.exec(rest);
            if (mOrder) { parsed.orderField = mOrder[1]; parsed.orderDir = (mOrder[2] || 'ASC').toUpperCase(); rest = rest.replace(mOrder[0], ''); }
            let mWhere = /\\bWHERE\\s+([\\s\\S]+)$/i.exec(rest);
            if (mWhere) {
                splitWhereConds(mWhere[1].trim()).forEach(function (c) {
                    const em = /^(\\S+)\\s+(NOT IN|INCLUDES|EXCLUDES|IN|LIKE|!=|>=|<=|=|>|<)\\s+([\\s\\S]+)$/i.exec(c.expr);
                    if (em) parsed.where.push({ conj: c.conj, field: em[1], op: em[2].toUpperCase(), val: unquoteVal(em[3]) });
                });
            }
            pendingBuilderApply = parsed;
            // Select the object; once its fields arrive, applyPendingBuilder() runs.
            if (builderObjectList.indexOf(object) === -1) {
                const opt = document.createElement('option'); opt.value = object; opt.textContent = object; builderObject.appendChild(opt);
            }
            if (builderObject.value !== object) {
                builderObject.value = object;
                builderObject.dispatchEvent(new Event('change'));
            } else {
                // Same object already loaded — request fresh fields to trigger apply.
                vscode.postMessage({ command: 'getBuilderFields', sobject: object, targetOrg: currentTargetOrg() });
                vscode.postMessage({ command: 'getBuilderChildren', sobject: object, targetOrg: currentTargetOrg() });
            }
        }
        function applyPendingBuilder() {
            if (!pendingBuilderApply) return;
            const p = pendingBuilderApply;
            pendingBuilderApply = null;
            // Plain fields → check matching boxes.
            const want = {}; p.fields.forEach(function (f) { want[f.toLowerCase()] = true; });
            builderFieldsEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = !!want[cb.value.toLowerCase()]; });
            // Parent relationship fields.
            selectedRelFields = p.relFields.slice(); renderRelChips();
            // Child subqueries.
            selectedChildFields = p.childFields.slice(); renderChildChips();
            // Order & limit.
            if (p.orderField) { builderOrderField.value = p.orderField; builderOrderDir.value = p.orderDir; }
            builderLimit.value = p.limit || '';
            // WHERE rows.
            if (builderWhereRows) {
                builderWhereRows.innerHTML = '';
                if (p.where.length === 0) { addWhereRow(); }
                else {
                    p.where.forEach(function (w) {
                        addWhereRow();
                        const row = builderWhereRows.lastElementChild;
                        const fsel = row.querySelector('.bw-field');
                        fsel.value = w.field; refreshWhereRowOps(row);
                        const opsel = row.querySelector('.bw-op');
                        if (Array.from(opsel.options).some(function (o) { return o.value === w.op; })) opsel.value = w.op;
                        row.querySelector('.bw-val').value = w.val;
                        const conj = row.querySelector('.bw-conj'); if (conj) conj.value = w.conj;
                    });
                    fixFirstConj();
                }
            }
        }
        if (builderFromQueryBtn) builderFromQueryBtn.addEventListener('click', parseQueryIntoBuilder);

        function runQuery() {
            const query = queryInput.value;
            if (!query) return;
            changes = {};
            updateSaveButton();
            hideCompletion();
            const targetOrg = orgSelect.value || null;
            vscode.postMessage({ command: 'execute', query: query, targetOrg: targetOrg });
        }
        executeBtn.addEventListener('click', runQuery);
        // Cmd/Ctrl+Enter inside the query box executes (unless the completion popup is open).
        queryInput.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                if (completionList.classList.contains('visible')) return;
                e.preventDefault();
                runQuery();
            }
        });

        saveBtn.addEventListener('click', () => {
            const payload = {};
            for (const id of Object.keys(changes)) {
                payload[id] = { ...changes[id] };
            }
            vscode.postMessage({ command: 'save', changes: payload, targetOrg: orgSelect.value || null });
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
            items.slice(0, 120).forEach((item, i) => {
                const li = document.createElement('li');
                const name = (typeof item === 'object' && item && item.name !== undefined) ? item.name : String(item);
                const fieldType = (typeof item === 'object' && item && item.type) ? item.type : null;
                const isRel = !!(typeof item === 'object' && item && item.rel);
                const icon = isRel ? '→' : (fieldType ? fieldTypeIcon(fieldType) : null);
                if (icon) {
                    const badge = document.createElement('span');
                    badge.className = 'type-badge' + (isRel ? ' rel-badge' : '');
                    badge.textContent = icon;
                    badge.title = isRel ? ('relationship → ' + (item.target || '') + ' (drill in with a dot)') : fieldType;
                    li.appendChild(badge);
                }
                li.appendChild(document.createTextNode(name));
                if (isRel && item.target) {
                    const hint = document.createElement('span');
                    hint.className = 'rel-target';
                    hint.textContent = ' ' + item.target;
                    li.appendChild(hint);
                }
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
            const isRel = !!(typeof textOrItem === 'object' && textOrItem && textOrItem.rel);
            const trailingSpace = typeof textOrItem === 'object' && textOrItem && textOrItem.trailingSpace;
            const before = queryInput.value.slice(0, start);
            const after = queryInput.value.slice(start + len);
            const alreadyHasClosing = after.charAt(0) === ')';
            const closingParen = (sobject && !alreadyHasClosing) ? ')' : '';
            // Picking a relationship (e.g. "Parent") inserts a trailing dot so the
            // user immediately drills into its fields (Parent.Name).
            const relDot = (isRel && after.charAt(0) !== '.') ? '.' : '';
            const space = (!relDot && trailingSpace && !closingParen && after.charAt(0) !== ' ') ? ' ' : '';
            queryInput.value = before + name + closingParen + relDot + space + after;
            const newCursor = start + name.length + closingParen.length + relDot.length + space.length;
            queryInput.setSelectionRange(newCursor, newCursor);
            queryInput.focus();
            hideCompletion();
            if (relDot) {
                // Re-trigger so the parent's fields appear right after the dot.
                setTimeout(() => triggerCompletion(getQueryContext()), 0);
                return;
            }
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

            // 2. After a relationship chain "Owner.Manager." -> fields of the resolved target.
            //    Handles standard + custom (__r) relationships, multiple hops deep,
            //    resolved 100% from org describe metadata (no guessing).
            const dotMatch = before.match(/([A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)*)\\.(\\w*)$/);
            if (dotMatch) {
                const chain = dotMatch[1];
                const prefix = dotMatch[2];
                const start = cursor - prefix.length;
                let root = null;
                if (subqueryBefore) {
                    const subqueryFull = getSubqueryFull(fullText, cursor);
                    const fc = (subqueryFull || subqueryBefore).match(/\\bFROM\\s+(\\w+)/i);
                    root = fc ? fc[1] : null;
                    const parentSobject = getMainQueryFrom(fullText);
                    if (root && parentSobject && relationshipCache[parentSobject] && relationshipCache[parentSobject][root])
                        root = relationshipCache[parentSobject][root];
                } else {
                    root = getMainQueryFrom(fullText);
                }
                return { type: 'path', fromSobject: root || '', path: chain.split('.'), prefix: prefix, start: start };
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
            } else if (ctx.type === 'path') {
                vscode.postMessage({ command: 'getFieldsForPath', fromSobject: ctx.fromSobject, path: ctx.path, targetOrg: currentTargetOrg() });
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
            if (message.command && message.command.indexOf('rt:') === 0) { soqlTable.handleMessage(message); return; }
            if (message.command === 'wbCompletions') { setBusy(-1); const cb = _pending[message.requestId]; if (cb) { delete _pending[message.requestId]; cb(message.items || []); } return; }
            if (message.command === 'wbHover') { setBusy(-1); const cb = _pending[message.requestId]; if (cb) { delete _pending[message.requestId]; cb(message.hover || null); } return; }
            if (message.command === 'soqlMarkers') { if (soqlEditor) { try { monaco.editor.setModelMarkers(soqlEditor.getModel(), 'asfx-soql', (message.markers || []).map(function (m) { return { severity: monaco.MarkerSeverity.Error, message: m.message, startLineNumber: m.line + 1, startColumn: m.startCol + 1, endLineNumber: m.line + 1, endColumn: m.endCol + 1 }; })); } catch (e) {} } return; }
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
                    clearSoqlErrorMarker();
                    if (message.instanceUrl) currentInstanceUrl = message.instanceUrl;
                    if (message.editableFields) editableFieldsByType = message.editableFields;
                    nextRecordsUrl = message.nextRecordsUrl || null;
                    resultTotalSize = message.totalSize;
                    renderTable(message.data);
                    statusBar.textContent = 'Total: ' + message.totalSize + ' records';
                    updateResultsToolbar(message.data, message.totalSize);
                    break;
                case 'moreResults':
                    if (message.instanceUrl) currentInstanceUrl = message.instanceUrl;
                    if (message.editableFields) editableFieldsByType = Object.assign(editableFieldsByType || {}, message.editableFields);
                    nextRecordsUrl = message.nextRecordsUrl || null;
                    resultTotalSize = message.totalSize || resultTotalSize;
                    renderTable((currentRecords || []).concat(message.data || []));
                    statusBar.textContent = 'Total: ' + resultTotalSize + ' records';
                    updateResultsToolbar(currentRecords, resultTotalSize);
                    break;
                case 'loadingMore':
                    if (loadMoreBtn) {
                        loadMoreBtn.disabled = message.value;
                        loadMoreBtn.textContent = message.value ? 'Loading…' : '⬇ Load more';
                    }
                    break;
                case 'orgList':
                    orgSelect.innerHTML = '<option value="">Default org</option>';
                    (message.orgs || []).forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o.username || '';
                        opt.textContent = o.label || ((o.alias || o.username || '') + (o.isDefault ? ' (default)' : ''));
                        orgSelect.appendChild(opt);
                    });
                    // Preselect the org carried over from the workbench (once available).
                    if (initialOrgPreset) {
                        const has = Array.prototype.some.call(orgSelect.options, o => o.value === initialOrgPreset);
                        if (has) { orgSelect.value = initialOrgPreset; orgSelect.dispatchEvent(new Event('change')); }
                        initialOrgPreset = '';
                    }
                    break;
                case 'historyUpdated':
                    setHistoryDropdown(message.history || []);
                    break;
                case 'error': {
                    errorMsg.textContent = message.text;
                    statusBar.textContent = '';
                    // Also show the full, polished Salesforce error (not the raw JSON).
                    if (message.details) {
                        const pre = document.createElement('pre');
                        pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:8px 0 0;padding:8px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;opacity:0.85;';
                        pre.textContent = message.details;
                        resultsContainer.innerHTML = '';
                        resultsContainer.appendChild(pre);
                    } else {
                        resultsContainer.innerHTML = '';
                    }
                    setSoqlErrorMarker(message.line, message.column, message.text);
                    break;
                }
                case 'saveErrors':
                    errorMsg.textContent = 'Save errors:\\n' + (message.errors || []).join('\\n');
                    break;
                case 'saveComplete': {
                    // Bake successfully-saved values into the baseline (currentRecords)
                    // so a later Discard reverts only still-unsaved edits, not saved ones.
                    const savedIds = message.savedIds || [];
                    savedIds.forEach(id => {
                        const rec = findRecordDeep(currentRecords, id);
                        const ch = changes[id];
                        if (rec && ch) {
                            Object.keys(ch).forEach(f => { if (f !== '_type') rec[f] = ch[f]; });
                        }
                        delete changes[id];
                        document.querySelectorAll('td.changed[data-rec-id="' + id + '"]').forEach(el => el.classList.remove('changed'));
                    });
                    updateSaveButton();
                    if (message.success) errorMsg.textContent = '';
                    break;
                }
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
                case 'builderFields': {
                    const items = (message.items || []).map(f => typeof f === 'object' ? f : { name: f, type: '' });
                    if (message.relName) {
                        // Fields of a relationship target → fill the related-field dropdown
                        // (only if it's still the selected relationship).
                        if (builderRelSelect && builderRelSelect.value === message.relName && builderRelField) {
                            builderRelField.innerHTML = '<option value="">— field —</option>' +
                                items.map(f => '<option value="' + f.name + '">' + f.name + '</option>').join('');
                        }
                        break;
                    }
                    builderFieldsList = items.filter(f => !f.rel);
                    // Sort alphabetically (case-insensitive) but keep Id, then Name, on top.
                    builderFieldsList.sort((a, b) => {
                        const rank = (n) => n === 'Id' ? 0 : (n === 'Name' ? 1 : 2);
                        const ra = rank(a.name), rb = rank(b.name);
                        if (ra !== rb) return ra - rb;
                        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                    });
                    builderRelList = items.filter(f => f.rel).map(f => ({ name: f.name, target: f.target || '' }));
                    builderFieldsEl.innerHTML = builderFieldsList.map(f => '<label><input type="checkbox" value="' + f.name + '"> ' + f.name + '</label>').join('');
                    applyFieldFilter();
                    builderOrderField.innerHTML = '<option value="">—</option>' + builderFieldsList.map(f => '<option value="' + f.name + '">' + f.name + '</option>').join('');
                    if (builderRelSelect) builderRelSelect.innerHTML = '<option value="">— relationship —</option>' +
                        builderRelList.map(r => '<option value="' + r.name + '" data-target="' + r.target + '">' + r.name + ' →' + r.target + '</option>').join('');
                    if (builderWhereRows && builderWhereRows.children.length === 0) addWhereRow();
                    repopulateWhereFields();
                    if (pendingBuilderApply && pendingBuilderApply.object &&
                        pendingBuilderApply.object.toLowerCase() === (builderObject.value || '').toLowerCase()) {
                        applyPendingBuilder();
                    }
                    break;
                }
                case 'cacheRefreshed': {
                    const refreshBtn = document.getElementById('btn-refresh-cache');
                    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '🔄'; }
                    const statusRow = document.getElementById('cache-status-row');
                    if (statusRow) statusRow.textContent = '✓ Refreshed at ' + new Date().toLocaleTimeString();
                    break;
                }
                case 'savedQueries':
                    renderSavedOptions(message.items || []);
                    break;
                case 'builderChildren':
                    builderChildList = (message.items || []).map(c => ({ name: c.name, sobject: c.sobject || c.childSObject || '' })).filter(c => c.name);
                    if (builderChildSelect) builderChildSelect.innerHTML = '<option value="">— child relationship —</option>' +
                        builderChildList.map(c => '<option value="' + c.name + '" data-sobject="' + c.sobject + '">' + c.name + (c.sobject ? ' (' + c.sobject + ')' : '') + '</option>').join('');
                    break;
                case 'builderChildFields':
                    if (builderChildSelect && builderChildSelect.value === message.childRel && builderChildField) {
                        const cfItems = (message.items || []).map(f => typeof f === 'object' ? f : { name: f });
                        builderChildField.innerHTML = '<option value="">— field —</option>' +
                            cfItems.map(f => '<option value="' + f.name + '">' + f.name + '</option>').join('');
                    }
                    break;
            }
        });

        function getSubqueryRecords(value) {
            if (value === null || value === undefined) return null;
            if (Array.isArray(value)) return value;
            if (typeof value === 'object' && value.records && Array.isArray(value.records)) return value.records;
            return null;
        }

        // Flatten a parent-relationship object (e.g. Parent.Name -> { attributes, Name })
        // to its leaf scalar values, so the cell shows the queried value(s), not raw JSON.
        // Nested relationships recurse (Parent.Owner.Name -> "Owner.Name"); child subqueries
        // collapse to a "N record(s)" summary.
        function relationshipLeaves(obj, prefix) {
            const out = [];
            Object.keys(obj || {}).forEach(k => {
                if (k === 'attributes') return;
                const v = obj[k];
                const label = prefix ? prefix + '.' + k : k;
                if (v !== null && typeof v === 'object') {
                    const sub = getSubqueryRecords(v);
                    if (sub !== null) out.push([label, sub.length + ' record(s)']);
                    else out.push.apply(out, relationshipLeaves(v, label));
                } else {
                    out.push([label, v === null ? '' : v]);
                }
            });
            return out;
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
                        const recId = recordIdOf(rec);
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
                            const isEditableNested = recId && recType && h !== 'Id' && !isNestedObject && isFieldEditable(recType, h);
                            if (isEditableNested) {
                                td.contentEditable = true;
                                td.classList.add('editable-cell');
                                td.dataset.recId = recId;
                                td.title = 'Editable — click to change, then Save edits';
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
                // Parent relationship object → show the queried value(s) inline, not JSON.
                if (value.attributes) {
                    const leaves = relationshipLeaves(value, '');
                    if (leaves.length === 1) {
                        const v = leaves[0][1];
                        if (currentInstanceUrl && isSalesforceId(v)) {
                            const link = makeRecordLink(String(v), currentInstanceUrl);
                            if (link) return link;
                        }
                        const span = document.createElement('span');
                        span.textContent = v === null ? '' : String(v);
                        return span;
                    }
                    if (leaves.length > 1) {
                        const span = document.createElement('span');
                        span.textContent = leaves.map(p => p[0] + ': ' + p[1]).join(' · ');
                        span.title = JSON.stringify(value, null, 2);
                        return span;
                    }
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

        // The record Id is needed to save an edit. Prefer the selected Id column, but
        // fall back to the Id embedded in attributes.url (e.g. ".../Account/001...") so
        // editing still works when the query didn't SELECT Id.
        function recordIdOf(rec) {
            if (rec && rec.Id) return rec.Id;
            const url = rec && rec.attributes && rec.attributes.url;
            if (url) { const parts = String(url).split('/'); const last = parts[parts.length - 1]; if (isSalesforceId(last)) return last; }
            return null;
        }

        // Find a record by Id anywhere in the result set, including inside subquery
        // (child relationship) records — so saved edits to related-object rows bake
        // into the baseline too.
        function findRecordDeep(records, id) {
            for (const r of records || []) {
                if (recordIdOf(r) === id) return r;
                for (const k of Object.keys(r)) {
                    if (k === 'attributes') continue;
                    const sub = getSubqueryRecords(r[k]);
                    if (sub) { const found = findRecordDeep(sub, id); if (found) return found; }
                }
            }
            return null;
        }

        // A cell is editable if describe says the field is updateable. When describe
        // info is unavailable for the type, fall back to editable (let the user try; SF
        // rejects genuinely read-only fields on save) so inline edit works everywhere.
        function isFieldEditable(type, field) {
            const map = editableFieldsByType[type];
            if (!map || Object.keys(map).length === 0) return true;
            return !!map[field];
        }

        // Rendering + type-aware inline editing now go through the shared component
        // (same one the ASFX Workbench SOQL tab uses). We keep currentRecords for
        // pagination/export; the component owns the table, editors and Save bar.
        const soqlTable = ASFXResults({ mount: resultsContainer, post: vscode.postMessage, getOrg: function () { return currentTargetOrg(); } });
        function renderTable(records) {
            currentRecords = records || [];
            soqlTable.setData(currentRecords);
        }

        function updateSaveButton() {
            const hasChanges = Object.keys(changes).length > 0;
            saveBtn.style.display = hasChanges ? 'block' : 'none';
            discardBtn.style.display = hasChanges ? 'block' : 'none';
        }

        // ── Results toolbar (count + export) ──────────────────────────────────
        function updateResultsToolbar(records, totalSize) {
            const tb = document.getElementById('results-toolbar');
            const cnt = document.getElementById('results-count');
            const n = (records && records.length) || 0;
            if (tb) tb.style.display = n > 0 ? 'flex' : 'none';
            if (cnt) cnt.textContent = n + (totalSize > n ? ' of ' + totalSize : '') + ' record' + (totalSize === 1 ? '' : 's');
            if (loadMoreBtn) loadMoreBtn.style.display = nextRecordsUrl ? 'inline-block' : 'none';
        }
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => {
            if (!nextRecordsUrl) return;
            vscode.postMessage({ command: 'queryMore', nextRecordsUrl: nextRecordsUrl, targetOrg: orgSelect.value || null });
        });

        // ── Format / prettify SOQL ────────────────────────────────────────────
        function formatSoql() {
            let q = (queryInput.value || '').replace(/\\s+/g, ' ').trim();
            if (!q) return;
            // Uppercase the major keywords (outside of string literals is approximated).
            const kw = ['SELECT','FROM','WHERE','GROUP BY','HAVING','ORDER BY','LIMIT','OFFSET','AND','OR','ASC','DESC','NULLS FIRST','NULLS LAST','TYPEOF','WHEN','THEN','ELSE','END'];
            kw.forEach(function(k){ q = q.replace(new RegExp('\\\\b' + k.replace(' ','\\\\s+') + '\\\\b','gi'), k); });
            // Newline + indent before major clauses.
            ['FROM','WHERE','GROUP BY','HAVING','ORDER BY','LIMIT','OFFSET'].forEach(function(k){
                q = q.replace(new RegExp('\\\\s+' + k.replace(' ','\\\\s+') + '\\\\b','g'), '\\n' + k);
            });
            q = q.replace(/\\s+(AND|OR)\\b/g, '\\n  $1');
            pushUndoState();
            queryInput.value = q;
            queryInput.focus();
        }

        // ── Export results (CSV / JSON) ───────────────────────────────────────
        function flattenForExport(rec) {
            const out = {};
            Object.keys(rec || {}).forEach(function(k){
                if (k === 'attributes') return;
                const v = rec[k];
                out[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
            });
            return out;
        }
        function buildCsv(records) {
            const cols = [];
            const seen = {};
            records.forEach(function(r){ Object.keys(flattenForExport(r)).forEach(function(c){ if(!seen[c]){seen[c]=1;cols.push(c);} }); });
            const esc = function(v){ if (v === null || v === undefined) return ''; v = String(v); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
            const lines = [cols.join(',')];
            records.forEach(function(r){ const f = flattenForExport(r); lines.push(cols.map(function(c){ return esc(f[c]); }).join(',')); });
            return lines.join('\\n');
        }
        function exportResults(format) {
            if (!currentRecords || !currentRecords.length) return;
            let content, ext;
            if (format === 'json') { content = JSON.stringify(currentRecords.map(flattenForExport), null, 2); ext = 'json'; }
            else { content = buildCsv(currentRecords); ext = 'csv'; }
            vscode.postMessage({ command: 'saveFile', content: content, suggestedName: 'soql-export.' + ext });
        }

        // Shift+Alt+F formats, like VS Code.
        queryInput.addEventListener('keydown', (e) => {
            if (e.shiftKey && e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); formatSoql(); }
        });
    </script>
</body>
</html>`;
  }
}
