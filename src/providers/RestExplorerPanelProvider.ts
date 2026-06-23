import * as vscode from "vscode";
import * as https from "https";
import * as http from "http";
import { Logger } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { getCachedOrgList, refreshOrgListCache, warmOrgListCache } from "../utils/orgListCache";
import { getToolingApiVersion } from "../utils/constants";
import { scanApexRestResources } from "../utils/apexRestScanner";

/** Persisted UI state so the panel survives close/reopen and window reload. */
export interface RestExplorerState {
  org?: string;
  method?: string;
  url?: string;
  headers?: string;
  body?: string;
  soql?: string;
  recordId?: string;
  apiVersion?: string;
  autoAuth?: boolean;
}

/** Build a descending list of API versions around the configured default. */
function buildVersionList(): { versions: string[]; defaultVersion: string } {
  const def = getToolingApiVersion().replace(/^v/, "");
  const top = Math.max(62, Math.ceil(parseFloat(def) || 60));
  const versions: string[] = [];
  for (let v = top; v >= 50; v--) versions.push(`${v}.0`);
  if (!versions.includes(def)) versions.unshift(def);
  return { versions, defaultVersion: def };
}

interface RequestPayload {
  method: string;
  url: string;
  headers: string; // raw "Key: Value\nKey2: Value2"
  body: string;
}

interface HttpResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
  error?: string;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function doHttp(fullUrl: string, method: string, extraHeaders: Record<string, string>, bodyStr: string | undefined): Promise<HttpResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(fullUrl); }
    catch (e) { resolve({ status: 0, statusText: "Invalid URL", headers: {}, body: "", durationMs: 0, error: String(e) }); return; }
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : (http as unknown as typeof https);
    const headers: Record<string, string | number> = { "Accept": "application/json", "Content-Type": "application/json", ...extraHeaders };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method.toUpperCase(),
      headers
    }, (res) => {
      let data = "";
      res.on("data", (c: string) => { data += c; });
      res.on("end", () => {
        const respHeaders: Record<string, string> = {};
        Object.entries(res.headers).forEach(([k, v]) => { respHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? ""); });
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: respHeaders, body: data, durationMs: Date.now() - t0 });
      });
      res.on("error", (err: Error) => resolve({ status: 0, statusText: "Response error", headers: {}, body: "", durationMs: Date.now() - t0, error: err.message }));
    });
    req.on("error", (err: Error) => resolve({ status: 0, statusText: "Request error", headers: {}, body: "", durationMs: Date.now() - t0, error: err.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseRawHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  raw.split("\n").forEach((line) => {
    const colon = line.indexOf(":");
    if (colon < 0) return;
    const key = line.substring(0, colon).trim();
    const val = line.substring(colon + 1).trim();
    if (key) out[key] = val;
  });
  return out;
}


// ─── Quick templates ──────────────────────────────────────────────────────────

const TEMPLATES: Array<{ label: string; icon: string; method: string; path: string; body?: string; soql?: boolean; needsObject?: boolean; needsRecordId?: boolean }> = [
  { label: "SOQL Query",           icon: "⚡", method: "GET",   path: "/services/data/v{version}/query?q={soql}", soql: true },
  { label: "List Records",         icon: "📑", method: "GET",   path: "/services/data/v{version}/query?q=SELECT+FIELDS(ALL)+FROM+{sobject}+LIMIT+200", needsObject: true },
  { label: "List SObjects",        icon: "📋", method: "GET",   path: "/services/data/v{version}/sobjects" },
  { label: "Describe SObject",     icon: "🔍", method: "GET",   path: "/services/data/v{version}/sobjects/{sobject}/describe", needsObject: true },
  { label: "Get Record",           icon: "📄", method: "GET",   path: "/services/data/v{version}/sobjects/{sobject}/{recordId}", needsObject: true, needsRecordId: true },
  { label: "Create Record",        icon: "➕", method: "POST",  path: "/services/data/v{version}/sobjects/{sobject}", body: '{\n  "Name": "Test"\n}', needsObject: true },
  { label: "Update Record",        icon: "✏️", method: "PATCH", path: "/services/data/v{version}/sobjects/{sobject}/{recordId}", body: '{\n  "Name": "Updated"\n}', needsObject: true, needsRecordId: true },
  { label: "Delete Record",        icon: "🗑️", method: "DELETE", path: "/services/data/v{version}/sobjects/{sobject}/{recordId}", needsObject: true, needsRecordId: true },
  { label: "Composite API",        icon: "🔗", method: "POST",  path: "/services/data/v{version}/composite", body: '{\n  "allOrNone": true,\n  "compositeRequest": []\n}' },
  { label: "Limits",               icon: "📊", method: "GET",   path: "/services/data/v{version}/limits" },
  { label: "Search (SOSL)",        icon: "🔎", method: "GET",   path: "/services/data/v{version}/search?q=FIND+%7BTest%7D+IN+ALL+FIELDS+RETURNING+Account(Id,Name)" },
];

// ─── Provider ─────────────────────────────────────────────────────────────────

export class RestExplorerPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.restExplorer";

  /** Persisted state per workspace so the panel restores on reopen / window reload. */
  private static stateByWorkspace: Record<string, RestExplorerState> = {};

  public static async show(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showErrorMessage("No workspace open."); return; }

    const panel = vscode.window.createWebviewPanel(
      RestExplorerPanelProvider.viewType,
      "REST API Explorer",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    RestExplorerPanelProvider.attach(panel, folder.uri.fsPath);
  }

  /** Re-attach to a panel restored by VS Code (window reload). */
  public static async revive(panel: vscode.WebviewPanel): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    RestExplorerPanelProvider.attach(panel, folder?.uri.fsPath ?? "");
  }

  private static attach(panel: vscode.WebviewPanel, workspaceRoot: string): void {
    panel.webview.html = RestExplorerPanelProvider.getHtml();

    // Warm caches in background on panel open
    warmOrgListCache();
    AuthInfo.warmAuthForOrg(null);

    panel.webview.onDidReceiveMessage(async (msg: {
      command: string;
      org?: string;
      request?: RequestPayload;
      autoAuth?: boolean;
      apiVersion?: string;
      state?: RestExplorerState;
    }) => {
      if (msg.command === "panelReady") {
        const cached = getCachedOrgList();
        const orgs = cached ?? await refreshOrgListCache();
        const { versions, defaultVersion } = buildVersionList();
        const savedState = RestExplorerPanelProvider.stateByWorkspace[workspaceRoot] ?? null;
        let restResources: Awaited<ReturnType<typeof scanApexRestResources>> = [];
        try { restResources = await scanApexRestResources(); } catch { /* non-fatal */ }
        panel.webview.postMessage({
          command: "init",
          orgs,
          defaultOrg: orgs[0]?.username ?? "",
          templates: TEMPLATES,
          versions,
          defaultVersion,
          restResources,
          savedState
        });
        return;
      }

      // ── Persist UI state ──────────────────────────────────────────────────
      if (msg.command === "persistPanelState" && msg.state) {
        RestExplorerPanelProvider.stateByWorkspace[workspaceRoot] = msg.state;
        return;
      }

      // ── Refresh cache ─────────────────────────────────────────────────────
      if (msg.command === "refreshCache") {
        const orgToRefresh = msg.org || null;
        AuthInfo.invalidateOrg(orgToRefresh);
        const orgs = await refreshOrgListCache();
        let restResources: Awaited<ReturnType<typeof scanApexRestResources>> = [];
        try { restResources = await scanApexRestResources(); } catch { /* non-fatal */ }
        panel.webview.postMessage({ command: "cacheRefreshed", orgs, restResources });
        return;
      }

      // ── Object list for the CRUD object selector ──────────────────────────
      if (msg.command === "getObjectList") {
        try {
          const objects = await OrgMetadataCache.getObjectList(msg.org || null);
          panel.webview.postMessage({ command: "objectList", org: msg.org || "", objects });
        } catch (e) {
          panel.webview.postMessage({ command: "objectList", org: msg.org || "", objects: [], error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      if (msg.command === "sendRequest") {
        const { org = "", request, autoAuth = true } = msg;
        if (!request) return;
        const { method, url, headers: rawHeaders, body } = request;

        if (!url) { panel.webview.postMessage({ command: "responseError", error: "URL is required." }); return; }

        // Bare version number — templates already include the 'v' (e.g. /v{version}/).
        const apiVersion = (msg.apiVersion || getToolingApiVersion()).replace(/^v/, "");

        // Resolve auth from cache (falls back to the default org when none chosen).
        let orgAuth: Awaited<ReturnType<typeof AuthInfo.getAuthInfoForOrg>> = null;
        let authErr = "";
        if (autoAuth) {
          try { orgAuth = await AuthInfo.getAuthInfoForOrg(org || null); }
          catch (e) { authErr = e instanceof Error ? e.message : String(e); }
        }

        let fullUrl = url.trim().replace(/\{version\}/g, apiVersion);
        const isAbsolute = /^https?:\/\//i.test(fullUrl);
        if (!isAbsolute) {
          if (!orgAuth) {
            panel.webview.postMessage({
              command: "responseError",
              error: `Could not authenticate to ${org || "the default org"}. ${authErr || "Pick an org above, or run 'sf org login web' / check 'sf org display'."}`
            });
            return;
          }
          fullUrl = `${orgAuth.instanceUrl.replace(/\/$/, "")}${fullUrl.startsWith("/") ? "" : "/"}${fullUrl}`;
        }

        const extraHeaders = parseRawHeaders(rawHeaders || "");
        if (orgAuth) extraHeaders["Authorization"] = `Bearer ${orgAuth.accessToken}`;

        const bodyStr = body?.trim() ? body.trim() : undefined;
        panel.webview.postMessage({ command: "requestStarted" });

        try {
          const result = await doHttp(fullUrl, method, extraHeaders, bodyStr);
          Logger.info(`REST ${method} ${fullUrl} → ${result.status} (${result.durationMs}ms)`);
          panel.webview.postMessage({ command: "response", result, resolvedUrl: fullUrl });
        } catch (e) {
          panel.webview.postMessage({ command: "responseError", error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      if (msg.command === "getOrgAuth") {
        const { org = "" } = msg;
        try {
          const auth = await AuthInfo.getAuthInfoForOrg(org || null);
          if (!auth) {
            panel.webview.postMessage({ command: "orgAuth", instanceUrl: "", ok: false });
            return;
          }
          panel.webview.postMessage({ command: "orgAuth", instanceUrl: auth.instanceUrl, ok: true });
        } catch (e) {
          panel.webview.postMessage({ command: "orgAuth", instanceUrl: "", ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
    });
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

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
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .page-header { padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .page-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
    .main { display: flex; flex: 1; overflow: hidden; }
    /* ── Left pane ── */
    .left-pane { display: flex; flex-direction: column; flex: 0 0 420px; min-width: 300px; max-width: 500px; border-right: 1px solid var(--vscode-panel-border); overflow-y: auto; }
    .pane-section { padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 8px; }
    .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
    /* ── Method + URL ── */
    .request-bar { display: flex; gap: 6px; align-items: stretch; }
    .topbar { display: flex; gap: 8px; align-items: stretch; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); flex-shrink: 0; }
    .topbar .url-input { flex: 1; font-size: 13px; padding: 8px 12px; }
    .topbar .method-select { min-width: 92px; }
    .topbar .send-btn { padding: 8px 22px; font-weight: 700; }
    .method-select { font-size: 12px; font-weight: 700; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; outline: none; cursor: pointer; font-family: inherit; }
    .method-select option { font-weight: 600; }
    .url-input { flex: 1; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); outline: none; min-width: 0; }
    .url-input:focus { border-color: var(--vscode-focusBorder); }
    .send-btn { padding: 6px 14px; font-size: 12px; font-weight: 700; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; font-family: inherit; white-space: nowrap; }
    .send-btn:hover { filter: brightness(1.1); }
    .send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    /* ── Org row ── */
    .org-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .org-row label { flex-shrink: 0; color: var(--vscode-descriptionForeground); }
    .org-row select { flex: 1; padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: inherit; outline: none; }
    .org-row .auth-badge { font-size: 10px; padding: 2px 6px; border-radius: 8px; white-space: nowrap; }
    .auth-badge.on  { background: color-mix(in srgb, #4ec94e 15%, transparent); color: #4ec94e; }
    .auth-badge.off { background: color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent); color: var(--vscode-descriptionForeground); }
    /* ── Tabs for headers/body ── */
    .mini-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); margin: -8px -14px 0; }
    .mini-tab { padding: 6px 14px; font-size: 11px; cursor: pointer; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); font-family: inherit; }
    .mini-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-button-background); font-weight: 600; }
    .mini-tab-content { display: none; padding-top: 8px; }
    .mini-tab-content.active { display: flex; flex-direction: column; gap: 6px; }
    .mono-area { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 7px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; resize: vertical; min-height: 70px; outline: none; }
    .mono-area:focus { border-color: var(--vscode-focusBorder); }
    .hint { font-size: 10px; color: var(--vscode-descriptionForeground); }
    /* ── Templates ── */
    .templates-grid { display: flex; flex-direction: column; gap: 3px; }
    .tpl-btn { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: transparent; border: 1px solid transparent; border-radius: 3px; cursor: pointer; font-size: 11px; font-family: inherit; color: var(--vscode-foreground); text-align: left; }
    .tpl-btn:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-panel-border); }
    .tpl-method { font-weight: 700; font-size: 10px; min-width: 38px; border-radius: 2px; padding: 1px 4px; text-align: center; }
    .tpl-GET    { background: color-mix(in srgb, #4ec94e 15%, transparent); color: #4ec94e; }
    .tpl-POST   { background: color-mix(in srgb, #f0a030 15%, transparent); color: #f0a030; }
    .tpl-PATCH  { background: color-mix(in srgb, var(--vscode-textLink-foreground) 15%, transparent); color: var(--vscode-textLink-foreground); }
    .tpl-DELETE { background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); color: var(--vscode-errorForeground); }
    /* ── History ── */
    .history-list { display: flex; flex-direction: column; gap: 2px; }
    .hist-item { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 3px; cursor: pointer; font-size: 11px; min-width: 0; }
    .hist-item:hover { background: var(--vscode-list-hoverBackground); }
    .hist-method { font-weight: 700; font-size: 10px; min-width: 38px; border-radius: 2px; padding: 1px 4px; text-align: center; flex-shrink: 0; }
    .hist-url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); }
    .hist-status { font-size: 10px; font-weight: 700; flex-shrink: 0; }
    .hist-status.ok  { color: #4ec94e; }
    .hist-status.err { color: var(--vscode-errorForeground); }
    .hist-status.warn{ color: #f0a030; }
    .hist-method, .hist-url { cursor: pointer; }
    .hist-time { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .hist-replay { flex-shrink: 0; background: transparent; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 0 4px; opacity: 0.6; }
    .hist-replay:hover { opacity: 1; color: var(--vscode-foreground); }
    .no-history { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px; }
    /* ── Right pane ── */
    .right-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; overflow: hidden; }
    .response-toolbar { padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .status-badge { font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 3px; }
    .status-badge.s2xx { background: color-mix(in srgb, #4ec94e 15%, transparent); color: #4ec94e; }
    .status-badge.s4xx { background: color-mix(in srgb, #f0a030 15%, transparent); color: #f0a030; }
    .status-badge.s5xx { background: color-mix(in srgb, var(--vscode-errorForeground) 15%, transparent); color: var(--vscode-errorForeground); }
    .status-badge.idle { background: transparent; color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11px; }
    .timing { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .copy-btn { margin-left: auto; padding: 4px 10px; font-size: 11px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border); border-radius: 3px; cursor: pointer; font-family: inherit; opacity: 0.8; }
    .copy-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
    .resp-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    .resp-tab { padding: 6px 14px; font-size: 11px; cursor: pointer; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); font-family: inherit; }
    .resp-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-button-background); font-weight: 600; }
    .resp-content { flex: 1; overflow: hidden; display: none; }
    .resp-content.active { display: block; }
    .resp-body-wrap { height: 100%; overflow: auto; padding: 10px 14px; }
    .resp-body { font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
    .resp-body .json-key  { color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe); }
    .resp-body .json-str  { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .resp-body .json-num  { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .resp-body .json-bool { color: var(--vscode-symbolIcon-booleanForeground, #569cd6); }
    .resp-body .json-null { color: var(--vscode-symbolIcon-nullForeground, #569cd6); }
    .resp-headers-list { padding: 10px 14px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); overflow: auto; height: 100%; }
    .resp-header-row { display: flex; gap: 0; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
    .resp-header-key   { color: var(--vscode-symbolIcon-fieldForeground, #9cdcfe); min-width: 200px; flex-shrink: 0; }
    .resp-header-val   { color: var(--vscode-foreground); word-break: break-all; }
    .resp-empty { padding: 10px 14px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .resolved-url { font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); padding: 4px 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; display: none; }
    .resolved-url.visible { display: block; }
    .auto-auth-row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .auto-auth-row input { cursor: pointer; }
    .auto-auth-row label { cursor: pointer; }
    .opt-row { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--vscode-descriptionForeground); flex-wrap: wrap; margin: 6px 0; }
    .opt-row label { cursor: pointer; }
    .opt-inline { display: inline-flex; align-items: center; gap: 5px; }
    .opt-inline input { cursor: pointer; }
    .opt-sep { opacity: 0.4; }
    .mini-select { padding: 3px 6px; font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; outline: none; cursor: pointer; font-family: inherit; }
    .mini-select:focus { border-color: var(--vscode-focusBorder); }
    code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.12)); padding: 0 3px; border-radius: 2px; }
  </style>
</head>
<body>
<div class="page-header">
  <span class="page-title">🔌 Salesforce REST API Explorer</span>
</div>
<!-- Full-width request bar (Postman-style) -->
<div class="topbar">
  <select class="method-select" id="method">
    <option value="GET">GET</option>
    <option value="POST">POST</option>
    <option value="PATCH">PATCH</option>
    <option value="PUT">PUT</option>
    <option value="DELETE">DELETE</option>
  </select>
  <input type="text" class="url-input" id="url-input" placeholder="/services/data/v{version}/sobjects" oninput="onConfigChange()" onkeydown="if(event.key==='Enter'){event.preventDefault();sendRequest();}" />
  <button class="send-btn" id="send-btn" onclick="sendRequest()">▶ Send</button>
</div>
<div class="main">

  <!-- ──── LEFT PANE ──── -->
  <div class="left-pane">

    <!-- Org + Send -->
    <div class="pane-section">
      <span class="section-title">Request</span>
      <div class="org-row">
        <label for="req-org">Org</label>
        <select id="req-org" onchange="onOrgChange()"></select>
        <span class="auth-badge on" id="auth-badge">🔑 Auto-auth</span>
        <button id="refresh-cache-btn" onclick="refreshCache()" title="Refresh org list &amp; auth cache" style="padding:3px 8px;font-size:10px;background:transparent;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-family:inherit;opacity:.7;flex-shrink:0;">🔄</button>
      </div>
      <div id="cache-status-row" style="font-size:10px;color:var(--vscode-descriptionForeground);display:none;padding-top:2px;"></div>
      <div class="opt-row">
        <label class="opt-inline"><input type="checkbox" id="auto-auth" checked onchange="onConfigChange()"> Auto-auth</label>
        <span class="opt-sep">·</span>
        <label for="api-version">API</label>
        <select id="api-version" class="mini-select" onchange="onConfigChange()"></select>
        <span class="opt-sep">·</span>
        <label for="sobject-select" id="sobject-label">Object</label>
        <select id="sobject-select" class="mini-select" onfocus="ensureObjectList()" onchange="onObjectChange()">
          <option value="">— object —</option>
        </select>
        <span class="opt-sep" id="recid-sep" style="display:none;">·</span>
        <label for="record-id" id="recid-label" style="display:none;">Record Id</label>
        <input type="text" id="record-id" class="mini-select" style="display:none;width:150px;" placeholder="record id" oninput="onRecordIdChange()" />
      </div>
      <span class="hint" style="display:block;margin-top:4px;">Use <code>{version}</code> for the API version. Relative paths resolve against the selected org's instance URL.</span>
    </div>

    <!-- SOQL / Headers / Body -->
    <div class="pane-section">
      <div class="mini-tabs">
        <button class="mini-tab" id="mtab-soql-btn" onclick="switchMiniTab('soql')">SOQL</button>
        <button class="mini-tab active" id="mtab-headers-btn" onclick="switchMiniTab('headers')">Headers</button>
        <button class="mini-tab" id="mtab-body-btn" onclick="switchMiniTab('body')">Body</button>
      </div>
      <div class="mini-tab-content" id="mtab-soql">
        <textarea class="mono-area" id="soql-input" placeholder="SELECT Id, Name FROM Account LIMIT 10" rows="4" oninput="onConfigChange()"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px;">
          <button class="tpl-btn" style="width:auto;" onclick="runSoql()">⚡ Run query</button>
          <span class="hint" style="margin:0;">Write SOQL here — it's URL-encoded into <code>/query?q=…</code> and sent. No need to edit the URL.</span>
        </div>
      </div>
      <div class="mini-tab-content active" id="mtab-headers">
        <textarea class="mono-area" id="req-headers" placeholder="Content-Type: application/json&#10;X-Custom-Header: value" rows="4" oninput="onConfigChange()"></textarea>
        <span class="hint">One header per line, "Key: Value" format. Authorization is auto-injected when Auto-auth is on.</span>
      </div>
      <div class="mini-tab-content" id="mtab-body">
        <textarea class="mono-area" id="req-body" placeholder='{\n  "Name": "Example"\n}' rows="8" style="min-height:120px;" oninput="onConfigChange()"></textarea>
        <span class="hint">JSON body for POST / PATCH / PUT requests.</span>
      </div>
    </div>

    <!-- Apex REST services -->
    <div class="pane-section" id="apexrest-section" style="display:none;">
      <span class="section-title">Apex REST services (@RestResource)</span>
      <div class="templates-grid" id="apexrest-grid"></div>
    </div>

    <!-- Templates -->
    <div class="pane-section">
      <span class="section-title">Quick templates</span>
      <div class="templates-grid" id="templates-grid"></div>
    </div>

    <!-- History -->
    <div class="pane-section" style="flex: 1;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="section-title" style="margin:0;flex:1;">Request history</span>
        <input type="text" id="history-filter" class="mini-select" placeholder="Filter…" style="width:110px;" oninput="renderHistory()">
        <button class="tpl-btn" style="width:auto;padding:3px 8px;" onclick="clearHistory()" title="Clear history">🗑</button>
      </div>
      <span class="hint" style="margin:4px 0;">Click a row to load it back into the form; <b>▶</b> to replay it.</span>
      <div class="history-list" id="history-list"><span class="no-history">No requests yet.</span></div>
    </div>

  </div>

  <!-- ──── RIGHT PANE ──── -->
  <div class="right-pane">
    <div class="response-toolbar">
      <span class="status-badge idle" id="resp-status-badge">No request sent</span>
      <span class="timing" id="resp-timing"></span>
      <button class="copy-btn" id="copy-btn" onclick="copyBody()" style="display:none;">Copy body</button>
    </div>
    <div class="resolved-url" id="resolved-url"></div>
    <div class="resp-tabs">
      <button class="resp-tab active" id="rtab-body-btn" onclick="switchRespTab('body')">Body</button>
      <button class="resp-tab" id="rtab-headers-btn" onclick="switchRespTab('headers')">Response headers</button>
    </div>
    <div class="resp-content active" id="rtab-body">
      <div class="resp-body-wrap" id="resp-body-wrap">
        <div class="resp-body" id="resp-body"><!-- response shown here --></div>
      </div>
    </div>
    <div class="resp-content" id="rtab-headers">
      <div class="resp-headers-list" id="resp-headers-list"></div>
    </div>
  </div>

</div>

<script>
  var vsc = null;
  try { if (typeof acquireVsCodeApi !== 'undefined') vsc = acquireVsCodeApi(); } catch(e) {}
  function post(msg) { try { if (vsc) vsc.postMessage(msg); } catch(e) {} }
  function safeGet(id) { return document.getElementById(id); }
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  var orgsData = [], historyData = [], lastRespBody = '';

  // ── Tab switches ──────────────────────────────────────────────────────────
  function switchMiniTab(t) {
    ['soql','headers','body'].forEach(function(n) {
      var c = safeGet('mtab-'+n), b = safeGet('mtab-'+n+'-btn');
      if (c) c.classList.toggle('active', n === t);
      if (b) b.classList.toggle('active', n === t);
    });
  }

  function switchRespTab(t) {
    ['body','headers'].forEach(function(n) {
      safeGet('rtab-'+n).classList.toggle('active', n === t);
      safeGet('rtab-'+n+'-btn').classList.toggle('active', n === t);
    });
  }

  // ── Cache refresh ─────────────────────────────────────────────────────────
  function refreshCache() {
    var org = safeGet('req-org') && safeGet('req-org').value || '';
    var btn = safeGet('refresh-cache-btn');
    var row = safeGet('cache-status-row');
    if (btn) btn.style.opacity = '0.4';
    if (row) { row.style.display = ''; row.textContent = 'Refreshing…'; }
    post({ command: 'refreshCache', org: org });
  }

  // ── Org change ────────────────────────────────────────────────────────────
  function onOrgChange() {
    objectListOrg = null; objectListData = [];           // object list is org-specific
    var os = safeGet('sobject-select'); if (os) os.innerHTML = '<option value="">— object —</option>';
    post({ command: 'getOrgAuth', org: safeGet('req-org') && safeGet('req-org').value || '' });
    onConfigChange();
  }

  // ── Method color ──────────────────────────────────────────────────────────
  var methodColors = { GET: '#4ec94e', POST: '#f0a030', PATCH: 'var(--vscode-textLink-foreground)', PUT: '#a0a0f0', DELETE: 'var(--vscode-errorForeground)' };
  function updateMethodColor() {
    var sel = safeGet('method');
    if (!sel) return;
    var c = methodColors[sel.value] || 'var(--vscode-foreground)';
    sel.style.color = c;
    sel.style.borderColor = c;
  }

  // ── Render templates ──────────────────────────────────────────────────────
  function renderTemplates(templates) {
    var grid = safeGet('templates-grid');
    if (!grid) return;
    grid.innerHTML = templates.map(function(t, i) {
      return '<button class="tpl-btn" onclick="applyTemplate('+i+')">'
        + '<span class="tpl-method tpl-'+t.method+'">'+escHtml(t.method)+'</span>'
        + '<span>'+escHtml(t.icon)+' '+escHtml(t.label)+'</span>'
        + '</button>';
    }).join('');
  }
  var templatesData = [], objectListData = [], objectListOrg = null;
  function applyTemplate(idx) {
    var t = templatesData[idx];
    if (!t) return;
    var sel = safeGet('method'); if (sel) sel.value = t.method;
    var obj = safeGet('sobject-select') && safeGet('sobject-select').value;
    var rid = safeGet('record-id') && safeGet('record-id').value;
    var path = t.path;
    if (t.needsObject && obj) path = path.replace(/\{sobject\}/g, obj);
    if (t.needsRecordId && rid) path = path.replace(/\{recordId\}/g, rid);
    var url = safeGet('url-input'); if (url) url.value = path;
    var body = safeGet('req-body'); if (body) body.value = t.body || '';
    updateMethodColor();
    setRecordIdVisible(!!t.needsRecordId);
    updateTabVisibility();
    if (t.soql) { switchMiniTab('soql'); var s = safeGet('soql-input'); if (s) s.focus(); }
    else if (t.body) switchMiniTab('body');
    else switchMiniTab('headers');
    if (t.needsObject) { ensureObjectList(); flashObjectLabel(); }
    if (t.needsRecordId) flashRecId();
    onConfigChange();
  }

  function flashObjectLabel() {
    var lbl = safeGet('sobject-label'); if (!lbl) return;
    lbl.style.color = 'var(--vscode-focusBorder)';
    setTimeout(function(){ lbl.style.color = ''; }, 1200);
  }

  // ── Object-type selector (for CRUD) ────────────────────────────────────────
  function ensureObjectList() {
    var org = safeGet('req-org') && safeGet('req-org').value || '';
    if (objectListOrg === org && objectListData.length) return;
    post({ command: 'getObjectList', org: org });
  }
  function populateObjectSelect() {
    var sel = safeGet('sobject-select');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">— object —</option>' +
      objectListData.map(function(o){ return '<option value="'+escHtml(o)+'">'+escHtml(o)+'</option>'; }).join('');
    if (cur) sel.value = cur;
  }
  function onObjectChange() {
    var obj = safeGet('sobject-select') && safeGet('sobject-select').value;
    if (!obj) return;
    var urlEl = safeGet('url-input');
    if (urlEl) {
      if (/\{sobject\}/.test(urlEl.value)) urlEl.value = urlEl.value.replace(/\{sobject\}/g, obj);
      else urlEl.value = urlEl.value.replace(/(\\/sobjects\\/)[A-Za-z0-9_]+/, '$1' + obj);
    }
    onConfigChange();
  }

  // ── Record Id (for Get/Update/Delete) ──────────────────────────────────────
  function setRecordIdVisible(show) {
    ['recid-sep','recid-label','record-id'].forEach(function(id){ var e=safeGet(id); if(e) e.style.display = show ? '' : 'none'; });
    if (safeGet('record-id')) safeGet('record-id').style.width = '150px';
  }
  function flashRecId() { var l=safeGet('recid-label'); if(!l) return; l.style.color='var(--vscode-focusBorder)'; setTimeout(function(){l.style.color='';},1200); var r=safeGet('record-id'); if(r) r.focus(); }
  function onRecordIdChange() {
    var rid = safeGet('record-id') && safeGet('record-id').value;
    var urlEl = safeGet('url-input');
    if (rid && urlEl && /\{recordId\}/.test(urlEl.value)) urlEl.value = urlEl.value.replace(/\{recordId\}/g, rid);
    onConfigChange();
  }

  // ── Show only the relevant request tabs for the current method/url ─────────
  function updateTabVisibility() {
    var method = (safeGet('method') && safeGet('method').value) || 'GET';
    var url = (safeGet('url-input') && safeGet('url-input').value) || '';
    var isQuery = url.indexOf('/query') !== -1 || url.indexOf('{soql}') !== -1;
    var bodyAllowed = (method === 'POST' || method === 'PATCH' || method === 'PUT');
    function show(id, on){ var b=safeGet('mtab-'+id+'-btn'); if(b) b.style.display = on ? '' : 'none'; }
    show('soql', isQuery);
    show('body', bodyAllowed);
    show('headers', true);
    // If the active tab got hidden, fall back to a visible one.
    var active = document.querySelector('.mini-tab.active');
    var activeId = active ? active.id.replace('mtab-','').replace('-btn','') : '';
    if ((activeId === 'soql' && !isQuery) || (activeId === 'body' && !bodyAllowed)) {
      switchMiniTab(isQuery ? 'soql' : (bodyAllowed ? 'body' : 'headers'));
    }
  }

  // ── SOQL helper ────────────────────────────────────────────────────────────
  function runSoql() {
    var soql = (safeGet('soql-input') && safeGet('soql-input').value || '').trim();
    if (!soql) { safeGet('soql-input') && safeGet('soql-input').focus(); return; }
    var m = safeGet('method'); if (m) m.value = 'GET';
    var url = safeGet('url-input');
    if (url) url.value = '/services/data/v{version}/query?q=' + encodeURIComponent(soql);
    updateMethodColor();
    sendRequest();
  }

  // ── Send request ──────────────────────────────────────────────────────────
  function currentVersion() { var v = safeGet('api-version'); return v && v.value ? v.value : ''; }
  function sendRequest() {
    var org = safeGet('req-org') && safeGet('req-org').value || '';
    var method = safeGet('method') && safeGet('method').value || 'GET';
    var url = (safeGet('url-input') && safeGet('url-input').value || '').trim();
    var headers = safeGet('req-headers') && safeGet('req-headers').value || '';
    var body = safeGet('req-body') && safeGet('req-body').value || '';
    var autoAuth = !!(safeGet('auto-auth') && safeGet('auto-auth').checked);

    // Resolve {sobject} from the selector, and {soql} from the SOQL box, before sending.
    var obj = safeGet('sobject-select') && safeGet('sobject-select').value;
    if (obj && /\{sobject\}/.test(url)) url = url.replace(/\{sobject\}/g, obj);
    var rid = safeGet('record-id') && safeGet('record-id').value;
    if (rid && /\{recordId\}/.test(url)) url = url.replace(/\{recordId\}/g, encodeURIComponent(rid));
    if (/\{recordId\}/.test(url)) { setRespStatus(0,'',0); safeGet('resp-body') && (safeGet('resp-body').textContent = '❌ This request needs a Record Id — fill the "Record Id" field.'); return; }
    if (/\{soql\}/.test(url)) {
      var soql = (safeGet('soql-input') && safeGet('soql-input').value || '').trim();
      url = url.replace(/\{soql\}/g, encodeURIComponent(soql));
    }
    if (!url) { setRespStatus(0, '', 0); safeGet('resp-body') && (safeGet('resp-body').textContent = '❌ URL is required.'); return; }

    lastSentReq = { method: method, url: url, headers: headers, body: body, soql: (safeGet('soql-input') && safeGet('soql-input').value) || '' };
    var btn = safeGet('send-btn'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending'; }
    setRespStatus(-1, '', 0);
    post({ command: 'sendRequest', org: org, autoAuth: autoAuth, apiVersion: currentVersion(),
      request: { method: method, url: url, headers: headers, body: body } });
  }
  var lastSentReq = null;

  // ── State persistence ──────────────────────────────────────────────────────
  var saveTimer = null;
  function onConfigChange() { clearTimeout(saveTimer); saveTimer = setTimeout(persistState, 400); }
  function persistState() {
    post({ command: 'persistPanelState', state: {
      org: safeGet('req-org') && safeGet('req-org').value || '',
      method: safeGet('method') && safeGet('method').value || 'GET',
      url: safeGet('url-input') && safeGet('url-input').value || '',
      headers: safeGet('req-headers') && safeGet('req-headers').value || '',
      body: safeGet('req-body') && safeGet('req-body').value || '',
      soql: safeGet('soql-input') && safeGet('soql-input').value || '',
      recordId: safeGet('record-id') && safeGet('record-id').value || '',
      apiVersion: currentVersion(),
      autoAuth: !!(safeGet('auto-auth') && safeGet('auto-auth').checked)
    }});
  }
  document.addEventListener('visibilitychange', function(){ if (document.hidden) persistState(); });

  // ── Apex REST services ─────────────────────────────────────────────────────
  function renderApexRest(list) {
    var sec = safeGet('apexrest-section'), grid = safeGet('apexrest-grid');
    if (!sec || !grid) return;
    if (!list || !list.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    grid.innerHTML = list.map(function(r, i) {
      var verb = (r.methods && r.methods[0]) || 'GET';
      return '<button class="tpl-btn" onclick="applyApexRest('+i+')" title="'+escHtml(r.path)+'">'
        + '<span class="tpl-method tpl-'+verb+'">'+escHtml(verb)+'</span>'
        + '<span>🔧 '+escHtml(r.className)+'</span></button>';
    }).join('');
  }
  var apexRestData = [];
  function applyApexRest(idx) {
    var r = apexRestData[idx]; if (!r) return;
    var m = safeGet('method'); if (m) m.value = (r.methods && r.methods[0]) || 'GET';
    var url = safeGet('url-input'); if (url) url.value = r.path;
    updateMethodColor(); switchMiniTab(((r.methods&&r.methods[0])==='GET')?'headers':'body'); onConfigChange();
  }

  // ── Status badge ──────────────────────────────────────────────────────────
  function setRespStatus(status, statusText, ms) {
    var badge = safeGet('resp-status-badge');
    var timing = safeGet('resp-timing');
    if (!badge) return;
    if (status === -1) { badge.className = 'status-badge idle'; badge.innerHTML = '<span class="spinner"></span> Sending…'; timing.textContent = ''; return; }
    if (status === 0) { badge.className = 'status-badge s5xx'; badge.textContent = 'Error'; timing.textContent = ''; return; }
    var cls = status >= 500 ? 's5xx' : status >= 400 ? 's4xx' : 's2xx';
    badge.className = 'status-badge ' + cls;
    badge.textContent = status + (statusText ? ' ' + statusText : '');
    timing.textContent = ms ? ms + ' ms' : '';
  }

  // ── JSON syntax highlight ─────────────────────────────────────────────────
  function highlightJson(str) {
    str = escHtml(str);
    return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function(match) {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) return '<span class="json-key">'+match+'</span>';
        return '<span class="json-str">'+match+'</span>';
      }
      if (/true|false/.test(match)) return '<span class="json-bool">'+match+'</span>';
      if (/null/.test(match)) return '<span class="json-null">'+match+'</span>';
      return '<span class="json-num">'+match+'</span>';
    });
  }

  // ── History (clickable: load to restore the full request, ▶ to replay) ──────
  function addHistory(status, durationMs) {
    var req = lastSentReq || {};
    var d = new Date();
    var time = d.getHours() + ':' + String(d.getMinutes()).padStart(2,'0') + ':' + String(d.getSeconds()).padStart(2,'0');
    historyData.unshift({ method: req.method, url: req.url, headers: req.headers, body: req.body, soql: req.soql, status: status, ms: durationMs || 0, time: time });
    if (historyData.length > 25) historyData.length = 25;
    renderHistory();
  }

  function renderHistory() {
    var list = safeGet('history-list');
    if (!list) return;
    var filter = (safeGet('history-filter') && safeGet('history-filter').value || '').toLowerCase();
    var items = historyData.filter(function(h){ return !filter || (h.url||'').toLowerCase().indexOf(filter) !== -1 || (h.method||'').toLowerCase().indexOf(filter) !== -1; });
    if (!items.length) { list.innerHTML = '<span class="no-history">'+(historyData.length?'No matches.':'No requests yet.')+'</span>'; return; }
    list.innerHTML = items.map(function(h) {
      var i = historyData.indexOf(h);
      var sCls = h.status >= 500 ? 'err' : h.status >= 400 ? 'warn' : (h.status >= 200 ? 'ok' : 'err');
      return '<div class="hist-item" title="'+escHtml(h.url)+'">'
        + '<span class="hist-method tpl-'+escHtml(h.method)+'" onclick="loadHistory('+i+')">'+escHtml(h.method)+'</span>'
        + '<span class="hist-url" onclick="loadHistory('+i+')">'+escHtml(h.url)+'</span>'
        + '<span class="hist-status '+sCls+'">'+escHtml(String(h.status))+'</span>'
        + '<span class="hist-time">'+escHtml(h.time)+'</span>'
        + '<button class="hist-replay" title="Replay this request" onclick="replayHistory('+i+')">▶</button>'
        + '</div>';
    }).join('');
  }

  function loadHistory(idx) {
    var h = historyData[idx];
    if (!h) return;
    if (safeGet('method')) safeGet('method').value = h.method || 'GET';
    if (safeGet('url-input')) safeGet('url-input').value = h.url || '';
    if (safeGet('req-headers')) safeGet('req-headers').value = h.headers || '';
    if (safeGet('req-body')) safeGet('req-body').value = h.body || '';
    if (safeGet('soql-input')) safeGet('soql-input').value = h.soql || '';
    updateMethodColor();
    updateTabVisibility();
    onConfigChange();
  }
  function replayHistory(idx) { loadHistory(idx); sendRequest(); }
  function clearHistory() { historyData = []; renderHistory(); }

  // ── Copy body ─────────────────────────────────────────────────────────────
  function copyBody() {
    try { navigator.clipboard.writeText(lastRespBody); } catch(e) { /* fallback */ }
  }

  // ── Render response ───────────────────────────────────────────────────────
  function renderResponse(result, resolvedUrl) {
    setRespStatus(result.status, result.statusText, result.durationMs);
    lastRespBody = result.body;

    // resolved URL
    var resolvedEl = safeGet('resolved-url');
    if (resolvedEl && resolvedUrl) { resolvedEl.textContent = '↳ ' + resolvedUrl; resolvedEl.classList.add('visible'); }

    // body
    var bodyEl = safeGet('resp-body');
    if (bodyEl) {
      var pretty = result.body;
      try {
        var parsed = JSON.parse(result.body);
        pretty = JSON.stringify(parsed, null, 2);
        bodyEl.innerHTML = highlightJson(pretty);
      } catch {
        bodyEl.textContent = result.body || '(empty body)';
      }
    }

    // headers
    var hList = safeGet('resp-headers-list');
    if (hList) {
      hList.innerHTML = Object.entries(result.headers || {}).map(function(kv) {
        return '<div class="resp-header-row"><span class="resp-header-key">'+escHtml(kv[0])+'</span><span class="resp-header-val">'+escHtml(kv[1])+'</span></div>';
      }).join('') || '<div class="resp-empty">No headers.</div>';
    }

    var copyBtn = safeGet('copy-btn');
    if (copyBtn) copyBtn.style.display = '';
  }

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || !d.command) return;

    var sendBtn = safeGet('send-btn');

    if (d.command === 'init') {
      orgsData = d.orgs || [];
      var orgSel = safeGet('req-org');
      if (orgSel) {
        orgSel.innerHTML = (orgsData.length ? '' : '<option value="">No orgs found</option>') +
          orgsData.map(function(o) { return '<option value="'+escHtml(o.username)+'">'+escHtml(o.label)+'</option>'; }).join('');
        if (d.defaultOrg) orgSel.value = d.defaultOrg;
      }
      // API version selector
      var verSel = safeGet('api-version');
      if (verSel) {
        verSel.innerHTML = (d.versions || []).map(function(v){ return '<option value="'+escHtml(v)+'">v'+escHtml(v)+'</option>'; }).join('');
        if (d.defaultVersion) verSel.value = d.defaultVersion;
      }
      templatesData = d.templates || [];
      renderTemplates(templatesData);
      apexRestData = d.restResources || [];
      renderApexRest(apexRestData);
      // Restore persisted state.
      if (d.savedState) {
        var s = d.savedState;
        if (s.org && orgSel) orgSel.value = s.org;
        if (s.apiVersion && verSel) verSel.value = s.apiVersion;
        if (s.method && safeGet('method')) safeGet('method').value = s.method;
        if (s.url !== undefined && safeGet('url-input')) safeGet('url-input').value = s.url;
        if (s.headers !== undefined && safeGet('req-headers')) safeGet('req-headers').value = s.headers;
        if (s.body !== undefined && safeGet('req-body')) safeGet('req-body').value = s.body;
        if (s.soql !== undefined && safeGet('soql-input')) safeGet('soql-input').value = s.soql;
        if (s.recordId !== undefined && safeGet('record-id')) { safeGet('record-id').value = s.recordId; if (s.recordId) setRecordIdVisible(true); }
        if (s.autoAuth !== undefined && safeGet('auto-auth')) safeGet('auto-auth').checked = !!s.autoAuth;
      }
      updateMethodColor();
      updateTabVisibility();
      return;
    }

    if (d.command === 'objectList') {
      if (d.org && safeGet('req-org') && d.org !== safeGet('req-org').value) return; // stale
      objectListData = d.objects || [];
      objectListOrg = d.org || (safeGet('req-org') && safeGet('req-org').value) || null;
      populateObjectSelect();
      return;
    }

    if (d.command === 'requestStarted') {
      if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<span class="spinner"></span> Sending'; }
      safeGet('resolved-url') && safeGet('resolved-url').classList.remove('visible');
      safeGet('copy-btn') && (safeGet('copy-btn').style.display = 'none');
      return;
    }

    if (d.command === 'response') {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '▶ Send'; }
      renderResponse(d.result, d.resolvedUrl);
      addHistory(d.result.status, d.result.durationMs);
      return;
    }

    if (d.command === 'responseError') {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '▶ Send'; }
      setRespStatus(0, '', 0);
      safeGet('resp-body') && (safeGet('resp-body').textContent = '❌ ' + (d.error || 'Request failed'));
      return;
    }

    if (d.command === 'orgAuth') {
      var badge = safeGet('auth-badge');
      if (badge) {
        if (d.ok) { badge.textContent = '🔑 Authenticated'; badge.className = 'auth-badge on'; }
        else { badge.textContent = '⚠ Not authenticated'; badge.className = 'auth-badge off'; badge.title = d.error || 'Run: sf org login web'; }
      }
      var urlEl = safeGet('url-input');
      if (urlEl && !urlEl.value) urlEl.value = '/services/data/v{version}/sobjects';
      return;
    }

    if (d.command === 'cacheRefreshed') {
      var btn2 = safeGet('refresh-cache-btn');
      var row2 = safeGet('cache-status-row');
      if (btn2) btn2.style.opacity = '0.7';
      if (d.orgs) {
        var prevOrg = safeGet('req-org') && safeGet('req-org').value;
        orgsData = d.orgs;
        var orgSel2 = safeGet('req-org');
        if (orgSel2) {
          orgSel2.innerHTML = (orgsData.length ? '' : '<option value="">No orgs found</option>') +
            orgsData.map(function(o) { return '<option value="'+escHtml(o.username)+'">'+escHtml(o.label)+'</option>'; }).join('');
          if (prevOrg) orgSel2.value = prevOrg;
        }
      }
      if (d.restResources) { apexRestData = d.restResources; renderApexRest(apexRestData); }
      objectListOrg = null; objectListData = [];
      if (row2) {
        var t = new Date(); row2.textContent = '✓ Cache updated at ' + t.getHours() + ':' + String(t.getMinutes()).padStart(2,'0');
        setTimeout(function() { row2.style.display = 'none'; }, 4000);
      }
      return;
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  safeGet('method') && safeGet('method').addEventListener('change', function(){ updateMethodColor(); updateTabVisibility(); onConfigChange(); });
  updateMethodColor();
  updateTabVisibility();
  post({ command: 'panelReady' });
</script>
</body>
</html>`;
  }
}
