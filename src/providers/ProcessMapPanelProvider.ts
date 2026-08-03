import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getCachedOrgList, refreshOrgListCache, OrgOption } from "../utils/orgListCache";
import { fetchProcessMetadata } from "../utils/processMetadata";
import { buildProcessGraph, ProcessGraph } from "../utils/processGraph";

function getNonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

/** Render the graph as a compact, LLM-friendly text description. */
function graphToLlmText(graph: ProcessGraph): string {
    const byObject = new Map<string, string[]>();
    const standalone: string[] = [];
    const objectOf = new Map(graph.nodes.map((n) => [n.id, n.object]));
    for (const n of graph.nodes) {
        if (n.kind === "object") continue;
        const extras = n.meta?.events ? ` [${(n.meta.events as string[]).join(", ")}]` : n.meta?.kind ? ` [${n.meta.kind}]` : "";
        const line = `- ${n.kind}: ${n.label}${n.active === false ? " (inactive)" : ""}${extras}`;
        if (n.object) (byObject.get(n.object) ?? byObject.set(n.object, []).get(n.object)!).push(line);
        else standalone.push(line);
    }
    const out: string[] = ["# Org automation map", ""];
    for (const [obj, lines] of [...byObject.entries()].sort()) {
        out.push(`## ${obj}`, ...lines, "");
    }
    if (standalone.length) out.push("## Not object-scoped (scheduled / async / autolaunched)", ...standalone, "");
    // Cross-links (e.g. scheduled job → apex class).
    const links = graph.edges.filter((e) => e.kind === "schedules" || e.kind === "invokes");
    if (links.length) {
        out.push("## Links");
        for (const e of links) out.push(`- ${e.source} ${e.kind} ${objectOf.get(e.target) ?? e.target}`);
    }
    return out.join("\n");
}

export class ProcessMapPanelProvider {
    public static readonly viewType = "adure-sfx-toolkit.processMap";
    private static _panel: vscode.WebviewPanel | undefined;
    private static _graph: ProcessGraph | undefined;

    public static async show(extensionUri: vscode.Uri): Promise<void> {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ProcessMapPanelProvider._panel) {
            ProcessMapPanelProvider._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(ProcessMapPanelProvider.viewType, "Process Map", column, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "resources")]
        });
        ProcessMapPanelProvider._panel = panel;
        panel.webview.html = this.getHtml(panel.webview, extensionUri);

        const listener = panel.webview.onDidReceiveMessage(async (msg: { command: string; [k: string]: unknown }) => {
            const s = (k: string) => (typeof msg[k] === "string" ? (msg[k] as string) : undefined);
            switch (msg.command) {
                case "ready": {
                    const orgs = getCachedOrgList() ?? (await refreshOrgListCache().catch(() => [] as OrgOption[]));
                    panel.webview.postMessage({ command: "orgList", orgs });
                    break;
                }
                case "build":
                    await this.build(panel, s("org"));
                    break;
                case "copyLlm":
                    if (ProcessMapPanelProvider._graph) {
                        await vscode.env.clipboard.writeText(graphToLlmText(ProcessMapPanelProvider._graph));
                        vscode.window.setStatusBarMessage("Process map copied as text for an LLM", 2500);
                    }
                    break;
                case "export":
                    await this.export(s("filename"), s("content"), msg.base64 === true);
                    break;
            }
        });

        panel.onDidDispose(() => {
            listener.dispose();
            ProcessMapPanelProvider._panel = undefined;
        });
    }

    private static async build(panel: vscode.WebviewPanel, org?: string): Promise<void> {
        panel.webview.postMessage({ command: "loading", value: true });
        try {
            const metadata = await fetchProcessMetadata(org);
            const graph = buildProcessGraph(metadata);
            ProcessMapPanelProvider._graph = graph;
            panel.webview.postMessage({ command: "graph", graph });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            panel.webview.postMessage({ command: "error", text: `Couldn't build the process map: ${reason}` });
        } finally {
            panel.webview.postMessage({ command: "loading", value: false });
        }
    }

    private static async export(filename?: string, content?: string, base64 = false): Promise<void> {
        if (!content) return;
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(filename ?? "process-map") });
        if (!uri) return;
        try {
            if (base64) fs.writeFileSync(uri.fsPath, new Uint8Array(Buffer.from(content, "base64")));
            else fs.writeFileSync(uri.fsPath, content, "utf8");
            vscode.window.showInformationMessage(`Exported ${path.basename(uri.fsPath)}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "resources", "webview", "processMap.js"));
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
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Process Map</title>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  :root {
    --pm-radius: 10px; --pm-radius-sm: 7px;
    --pm-border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    --pm-border-strong: color-mix(in srgb, var(--vscode-foreground) 26%, transparent);
    --pm-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --pm-surface-2: color-mix(in srgb, var(--vscode-foreground) 5%, var(--vscode-editor-background));
    --pm-accent: var(--vscode-focusBorder, #4c8bf5);
    --pm-shadow: 0 6px 24px -8px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.25);
    --k-object: #3b82f6; --k-trigger: #8b5cf6; --k-flow: #10b981; --k-scheduledFlow: #0d9488;
    --k-validationRule: #f59e0b; --k-workflowRule: #f97316; --k-fieldUpdate: #eab308;
    --k-field: #64748b; --k-apexClass: #6b7280; --k-scheduledJob: #ec4899;
  }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* Toolbar */
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-shrink: 0; flex-wrap: wrap;
    border-bottom: 1px solid var(--pm-border);
    background: linear-gradient(180deg, var(--pm-surface), color-mix(in srgb, var(--pm-surface) 92%, transparent)); }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: .01em; }
  .brand .dotgrid { width: 16px; height: 16px; border-radius: 4px; background:
    radial-gradient(var(--pm-accent) 1.4px, transparent 1.4px) 0 0/6px 6px; opacity: .9; }
  .sep { width: 1px; height: 22px; background: var(--pm-border); margin: 0 2px; }
  .lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; min-width: 8px; }
  select, input[type="text"], input[type="search"] { height: 30px; padding: 0 10px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--pm-border); border-radius: var(--pm-radius-sm); font-size: 12px; outline: none; }
  select:focus, input:focus { border-color: var(--pm-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--pm-accent) 22%, transparent); }
  .search { position: relative; }
  .search input { padding-left: 28px; width: 200px; }
  .search::before { content: "⌕"; position: absolute; left: 9px; top: 50%; transform: translateY(-50%); opacity: .6; font-size: 15px; }
  button { height: 30px; display: inline-flex; align-items: center; gap: 6px; background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); border: 1px solid transparent; padding: 0 14px; cursor: pointer;
    border-radius: var(--pm-radius-sm); font-size: 12px; font-family: inherit; font-weight: 500; transition: filter .12s, transform .06s; }
  button:hover { filter: brightness(1.12); } button:active { transform: translateY(1px); }
  button.ghost { background: transparent; color: var(--vscode-foreground); border-color: var(--pm-border); }
  button.ghost:hover { background: var(--pm-surface-2); filter: none; }
  button.icon { padding: 0 9px; }
  label.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--vscode-descriptionForeground); cursor: pointer; }
  /* Segmented control */
  .seg { display: inline-flex; background: var(--pm-surface-2); border: 1px solid var(--pm-border); border-radius: var(--pm-radius-sm); padding: 2px; }
  .seg button { height: 24px; background: transparent; border: none; color: var(--vscode-descriptionForeground); padding: 0 11px; border-radius: 5px; font-weight: 500; }
  .seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  /* Stage */
  .stage { flex: 1; min-height: 0; display: flex; position: relative; }
  #cy { flex: 1; min-height: 0; height: 100%;
    background-color: var(--vscode-editor-background);
    background-image: radial-gradient(color-mix(in srgb, var(--vscode-foreground) 8%, transparent) 1px, transparent 1px);
    background-size: 22px 22px; }

  /* Empty state */
  .empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; text-align: center; color: var(--vscode-descriptionForeground); pointer-events: none; }
  .empty .big { font-size: 15px; color: var(--vscode-foreground); font-weight: 600; }
  .empty .ring { width: 46px; height: 46px; border-radius: 50%; border: 2px solid var(--pm-border); border-top-color: var(--pm-accent); }
  .empty.spin .ring { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }

  /* Legend (floating) */
  .legend { position: absolute; left: 14px; bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px; max-width: 62%;
    padding: 8px; border-radius: var(--pm-radius); background: color-mix(in srgb, var(--pm-surface) 82%, transparent);
    backdrop-filter: blur(8px); border: 1px solid var(--pm-border); box-shadow: var(--pm-shadow); }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 6px; border-radius: 999px; font-size: 11px;
    cursor: pointer; user-select: none; border: 1px solid var(--pm-border); background: var(--pm-surface-2); transition: opacity .12s, filter .12s; }
  .chip:hover { filter: brightness(1.15); } .chip.off { opacity: .38; }
  .chip .sw { width: 10px; height: 10px; border-radius: 3px; } .chip .n { opacity: .65; font-variant-numeric: tabular-nums; }

  /* Inspector */
  .inspector { width: 0; flex-shrink: 0; overflow: hidden; border-left: 1px solid var(--pm-border);
    background: var(--pm-surface); transition: width .22s cubic-bezier(.2,.7,.2,1); }
  .inspector.open { width: 340px; }
  .insp-inner { width: 340px; height: 100%; display: flex; flex-direction: column; }
  .insp-head { padding: 14px 16px; border-bottom: 1px solid var(--pm-border); display: flex; align-items: flex-start; gap: 10px; }
  .insp-ico { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
    font-size: 17px; color: #fff; flex-shrink: 0; }
  .insp-title { font-weight: 600; font-size: 14px; word-break: break-word; }
  .insp-kind { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
  .insp-x { margin-left: auto; cursor: pointer; opacity: .6; font-size: 18px; line-height: 1; background: none; border: none; color: inherit; height: auto; }
  .insp-x:hover { opacity: 1; }
  .insp-body { padding: 12px 16px; overflow-y: auto; flex: 1; }
  .meta-row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 12px; border-bottom: 1px dashed var(--pm-border); }
  .meta-row .k { color: var(--vscode-descriptionForeground); } .meta-row .v { text-align: right; word-break: break-word; }
  .insp-sec { margin-top: 14px; } .insp-sec h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .conn { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; }
  .conn:hover { background: var(--pm-surface-2); } .conn .sw { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }

  .status { padding: 6px 14px; font-size: 11px; color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--pm-border); flex-shrink: 0; display: flex; align-items: center; gap: 8px;
    background: var(--pm-surface); }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="brand"><span class="dotgrid"></span>Process Map</span>
    <span class="sep"></span>
    <span class="lbl">Org</span>
    <select id="org"></select>
    <button id="build">⚡ Build map</button>
    <span class="sep"></span>
    <span class="lbl">Layout</span>
    <span class="seg" id="layout">
      <button data-l="dagre" class="on">Flow</button>
      <button data-l="cose">Organic</button>
      <button data-l="order">Order</button>
    </span>
    <span class="search"><input type="search" id="search" placeholder="Search object / name…" /></span>
    <label class="chk"><input type="checkbox" id="activeOnly" /> Active only</label>
    <span class="spacer"></span>
    <button class="ghost icon" id="fit" title="Fit to view">⤢</button>
    <button class="ghost" id="copyLlm" title="Copy a text description for an LLM">Copy for LLM</button>
    <button class="ghost icon" id="exportPng" title="Export PNG">PNG</button>
    <button class="ghost icon" id="exportJson" title="Export JSON">JSON</button>
  </div>
  <div class="stage">
    <div id="cy"></div>
    <div class="legend" id="legend"></div>
    <div class="empty" id="empty"><div class="ring"></div><div class="big">Map your org's automation</div><div>Pick an org and press <b>Build map</b>.</div></div>
    <aside class="inspector" id="inspector"><div class="insp-inner" id="inspInner"></div></aside>
  </div>
  <div class="status" id="status">Ready.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
