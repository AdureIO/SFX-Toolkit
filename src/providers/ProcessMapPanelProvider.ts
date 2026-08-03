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
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background); margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap; flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.28));
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background)); }
  .tb-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .spacer { flex: 1; min-width: 8px; }
  select, input[type="text"] { padding: 5px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; font-size: 12px; outline: none; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px;
    cursor: pointer; border-radius: 4px; font-size: 12px; }
  button.sec { background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-widget-border); }
  button:hover { filter: brightness(1.1); }
  label.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  #cy { flex: 1; min-height: 0; width: 100%; position: relative; }
  #legend { display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 12px; font-size: 11px; border-top: 1px solid var(--vscode-widget-border); }
  #legend .lg { display: inline-flex; align-items: center; gap: 5px; }
  #legend .dot { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .status { padding: 5px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-widget-border); flex-shrink: 0; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="tb-label">Org</span>
    <select id="org"></select>
    <button id="build">Build map</button>
    <span class="tb-label">Filter</span>
    <input type="text" id="search" placeholder="object / name…" style="width:150px" />
    <label class="chk"><input type="checkbox" id="activeOnly" /> Active only</label>
    <span class="spacer"></span>
    <button class="sec" id="fit">Fit</button>
    <button class="sec" id="exportPng">PNG</button>
    <button class="sec" id="exportJson">JSON</button>
    <button class="sec" id="copyLlm">Copy for LLM</button>
  </div>
  <div id="legend"></div>
  <div id="cy"></div>
  <div class="status" id="status">Pick an org and build the map.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
