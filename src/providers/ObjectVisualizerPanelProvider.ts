import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { AuthInfo } from "../utils/authInfo";
import { OrgMetadataCache, SObjectDescribe } from "../utils/orgMetadataCache";
import {
  getCachedOrgList,
  refreshOrgListCache,
  warmOrgListCache,
  getDefaultUsernameFromOrgCache,
  OrgOption
} from "../utils/orgListCache";
import { buildObjectGraph } from "../utils/objectGraph";

/** Max concurrent describe requests when fanning out over neighbours. */
const DESCRIBE_CONCURRENCY = 6;

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Run an async mapper over items with a bounded concurrency pool. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export class ObjectVisualizerPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.objectVisualizer";

  public static async show(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
    const panel = vscode.window.createWebviewPanel(
      ObjectVisualizerPanelProvider.viewType,
      "Object Visualizer",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")]
      }
    );
    await ObjectVisualizerPanelProvider.attach(panel, extensionUri);
  }

  /** Restore the panel after a window reload (registered serializer). */
  public static async revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")]
    };
    await ObjectVisualizerPanelProvider.attach(panel, extensionUri);
  }

  private static async attach(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    panel.webview.html = this._getHtmlForWebview(panel.webview, extensionUri);

    AuthInfo.warmAuthForOrg(null);
    OrgMetadataCache.warmDefaultOrg();
    warmOrgListCache();

    const listener = panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "getOrgList":
          await this.sendOrgList(panel);
          break;
        case "getObjectList":
          await this.sendObjectList(panel, message.targetOrg || null);
          break;
        case "buildGraph":
          await this.buildGraph(panel, message.seeds || [], message.targetOrg || null, message.cap);
          break;
        case "refreshCache":
          OrgMetadataCache.invalidate(message.targetOrg || null);
          await refreshOrgListCache().catch(() => undefined);
          panel.webview.postMessage({ command: "cacheRefreshed" });
          break;
        case "saveFile":
          await this.saveFile(message);
          break;
        case "error":
          vscode.window.showErrorMessage(String(message.text || ""));
          break;
      }
    });

    panel.onDidDispose(() => listener.dispose());
  }

  private static async sendOrgList(panel: vscode.WebviewPanel) {
    const withDefault = (orgs: OrgOption[]) => {
      const def = getDefaultUsernameFromOrgCache();
      return orgs.map((o) => ({ ...o, isDefault: !!def && o.username === def }));
    };
    const cached = getCachedOrgList();
    if (cached) panel.webview.postMessage({ command: "orgList", orgs: withDefault(cached) });
    try {
      const fresh = await refreshOrgListCache();
      panel.webview.postMessage({ command: "orgList", orgs: withDefault(fresh) });
    } catch {
      if (!cached) panel.webview.postMessage({ command: "orgList", orgs: [] });
    }
  }

  private static async sendObjectList(panel: vscode.WebviewPanel, targetOrg: string | null) {
    try {
      const names = await OrgMetadataCache.getObjectList(targetOrg);
      const objects = names.map((name) => ({ name, custom: /__/.test(name) }));
      panel.webview.postMessage({ command: "objectList", objects });
    } catch (e: any) {
      panel.webview.postMessage({ command: "objectList", objects: [] });
      panel.webview.postMessage({ command: "error", text: e?.message || String(e) });
    }
  }

  private static async buildGraph(
    panel: vscode.WebviewPanel,
    seeds: string[],
    targetOrg: string | null,
    cap: number | undefined
  ) {
    try {
      panel.webview.postMessage({ command: "loading", value: true });

      // 1. Describe the seeds first.
      const describes = new Map<string, SObjectDescribe>();
      const seedDescribes = await mapPool(seeds, DESCRIBE_CONCURRENCY, (s) => OrgMetadataCache.getDescribe(targetOrg, s));
      seeds.forEach((s, i) => {
        const d = seedDescribes[i];
        if (d) describes.set(s, d);
      });

      // 2. Collect the 1-hop neighbour set (capped children + all parents).
      const effectiveCap = cap && cap > 0 ? cap : 25;
      const neighbours = new Set<string>();
      for (const s of seeds) {
        const d = describes.get(s);
        if (!d) continue;
        for (const f of d.fields) {
          if (f.type === "reference" && Array.isArray(f.referenceTo)) {
            for (const t of f.referenceTo) if (!describes.has(t)) neighbours.add(t);
          }
        }
        const children = (d.childRelationships || [])
          .map((cr) => cr.childSObject)
          .filter((c): c is string => !!c);
        const uniqueChildren = Array.from(new Set(children)).sort((a, b) => a.localeCompare(b)).slice(0, effectiveCap);
        for (const c of uniqueChildren) if (!describes.has(c)) neighbours.add(c);
      }

      // 3. Describe the neighbours (bounded concurrency, cached/deduped) with progress.
      const neighbourList = Array.from(neighbours);
      let done = 0;
      const total = neighbourList.length;
      await mapPool(neighbourList, DESCRIBE_CONCURRENCY, async (n) => {
        const d = await OrgMetadataCache.getDescribe(targetOrg, n);
        if (d) describes.set(n, d);
        done++;
        panel.webview.postMessage({ command: "progress", done, total, label: n });
      });

      // 4. Build the graph (pure) and send it.
      const graph = buildObjectGraph(seeds, describes, { childCap: effectiveCap });
      panel.webview.postMessage({
        command: "graph",
        nodes: graph.nodes,
        edges: graph.edges,
        truncated: graph.truncated
      });
    } catch (e: any) {
      panel.webview.postMessage({ command: "error", text: e?.message || String(e) });
    } finally {
      panel.webview.postMessage({ command: "loading", value: false });
    }
  }

  private static async saveFile(message: { content?: string; encoding?: string; suggestedName?: string }) {
    const suggested = message.suggestedName || "object-diagram.png";
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const ext = path.extname(suggested).replace(".", "").toLowerCase() || "png";
    const uri = await vscode.window.showSaveDialog({
      defaultUri: ws ? vscode.Uri.file(path.join(ws, suggested)) : undefined,
      filters: { [ext.toUpperCase()]: [ext], "All files": ["*"] }
    });
    if (!uri) return;
    try {
      if (message.encoding === "base64") {
        fs.writeFileSync(uri.fsPath, new Uint8Array(Buffer.from(String(message.content ?? ""), "base64")));
      } else {
        fs.writeFileSync(uri.fsPath, String(message.content ?? ""), "utf8");
      }
      vscode.window.showInformationMessage(`Exported ${path.basename(uri.fsPath)}`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Export failed: ${e?.message ?? e}`);
    }
  }

  private static _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "resources", "webview", "objectVisualizer.js")
    );
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Object Visualizer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    --asfx-radius: 6px; --asfx-radius-sm: 4px;
    --asfx-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.28)));
    --asfx-card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-inactiveSelectionBackground));
    --asfx-accent: var(--vscode-button-background);
  }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background); margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--asfx-border);
    background: var(--vscode-sideBarSectionHeader-background, var(--asfx-card-bg)); flex-wrap: wrap; flex-shrink: 0; }
  .tb-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .tb-spacer { flex: 1; min-width: 8px; }
  select, input[type="text"] { padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12px; outline: none; }
  select:focus, input:focus { border-color: var(--vscode-focusBorder); }
  button { background: var(--asfx-accent); color: var(--vscode-button-foreground); border: none; padding: 6px 12px;
    cursor: pointer; border-radius: var(--asfx-radius-sm); font-size: 12px; font-family: inherit; }
  button:hover { filter: brightness(1.1); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--asfx-border); }
  label.inline { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; }
  #cy { flex: 1; min-height: 0; width: 100%; background: var(--vscode-editor-background); }
  .status { padding: 5px 12px; font-size: 11px; color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--asfx-border); flex-shrink: 0; }
  /* Picker overlay */
  .picker { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45); z-index: 10; }
  .picker.open { display: flex; }
  .picker-card { width: 460px; max-width: 90%; max-height: 80%; display: flex; flex-direction: column;
    background: var(--asfx-card-bg); border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); overflow: hidden; }
  .picker-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--asfx-border); }
  .picker-head .title { font-weight: 700; }
  .picker-filters { display: flex; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--asfx-border); }
  #ov-picker-list { overflow-y: auto; padding: 6px 12px; flex: 1; }
  .ov-pick-item { display: flex; align-items: center; gap: 7px; padding: 3px 2px; font-size: 12px; cursor: pointer; }
  .ov-pick-item:hover { background: var(--vscode-list-hoverBackground); }
  .ov-badge { font-size: 9px; padding: 1px 5px; border-radius: 8px; background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground); }
  .picker-foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--asfx-border); }
  .picker-foot .tb-spacer { flex: 1; }
  #ov-picker-search { flex: 1; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="tb-label">Org</span>
    <select id="ov-org" title="Org to visualize"><option value="">Default org</option></select>
    <button id="ov-refresh" class="btn-secondary" title="Refresh org & schema cache">↻</button>
    <button id="ov-pick">⊕ Pick objects</button>
    <span class="tb-label">Max children</span>
    <select id="ov-childcap" title="Max child relationships pulled in per object">
      <option value="10">10</option>
      <option value="25" selected>25</option>
      <option value="50">50</option>
      <option value="all">All</option>
    </select>
    <label class="inline"><input type="checkbox" id="ov-fullfields"> Full fields</label>
    <span class="tb-spacer"></span>
    <button id="ov-export-png" class="btn-secondary">⬇ PNG</button>
    <button id="ov-export-svg" class="btn-secondary">⬇ SVG</button>
  </div>

  <div id="cy"></div>
  <div class="status" id="ov-status">Loading orgs…</div>

  <!-- Object picker overlay -->
  <div class="picker" id="ov-picker">
    <div class="picker-card">
      <div class="picker-head">
        <span class="title">Pick objects</span>
        <input type="text" id="ov-picker-search" placeholder="Search objects…" />
      </div>
      <div class="picker-filters">
        <label class="inline"><input type="radio" name="ov-filter" value="all" checked> All</label>
        <label class="inline"><input type="radio" name="ov-filter" value="standard"> Standard</label>
        <label class="inline"><input type="radio" name="ov-filter" value="custom"> Custom</label>
      </div>
      <div id="ov-picker-list"></div>
      <div class="picker-foot">
        <span id="ov-picker-count" class="tb-label">0 selected</span>
        <button id="ov-picker-clear" class="btn-secondary">Clear</button>
        <span class="tb-spacer"></span>
        <button id="ov-picker-cancel" class="btn-secondary">Cancel</button>
        <button id="ov-picker-apply">Visualize →</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
