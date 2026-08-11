import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getCachedOrgList, refreshOrgListCache, OrgOption } from "../utils/orgListCache";
import { fetchProcessMetadata } from "../utils/processMetadata";
import { buildProcessGraph, scopeMetadataToObjects, ProcessGraph, ProcessNode } from "../utils/processGraph";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { runCommandArgs } from "../utils/commandRunner";
import { getNonce } from "../utils/htmlUtils";


export class ProcessMapPanelProvider {
    public static readonly viewType = "adure-sfx-toolkit.processMap";
    private static _panel: vscode.WebviewPanel | undefined;
    private static _graph: ProcessGraph | undefined;
    private static _org: string | undefined;

    public static async show(extensionUri: vscode.Uri): Promise<void> {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (ProcessMapPanelProvider._panel) {
            ProcessMapPanelProvider._panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel(ProcessMapPanelProvider.viewType, "Process Visualizer", column, {
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
                case "objectList": {
                    const objects = await OrgMetadataCache.getObjectList(s("org") ?? null).catch(() => [] as string[]);
                    panel.webview.postMessage({ command: "objectList", objects });
                    break;
                }
                case "build":
                    await this.build(panel, s("org"), Array.isArray(msg.seeds) ? (msg.seeds as string[]) : []);
                    break;
                case "export":
                    await this.export(s("filename"), s("content"), msg.base64 === true);
                    break;
                case "openOrg":
                    await this.openInOrg(s("nodeId"));
                    break;
                case "copyText": {
                    const text = s("text");
                    if (text) {
                        await vscode.env.clipboard.writeText(text);
                        vscode.window.setStatusBarMessage(`Copied “${text}”`, 2000);
                    }
                    break;
                }
            }
        });

        panel.onDidDispose(() => {
            listener.dispose();
            ProcessMapPanelProvider._panel = undefined;
        });
    }

    private static async build(panel: vscode.WebviewPanel, org?: string, seeds: string[] = []): Promise<void> {
        ProcessMapPanelProvider._org = org;
        panel.webview.postMessage({ command: "loading", value: true });
        try {
            const metadata = await fetchProcessMetadata(
                org,
                (p) => panel.webview.postMessage({ command: "progress", label: p.label, completed: p.completed, total: p.total })
            );
            panel.webview.postMessage({ command: "progress", label: "Building graph", completed: 1, total: 1, phase: "build" });
            const scoped = seeds.length ? scopeMetadataToObjects(metadata, seeds) : metadata;
            const graph = buildProcessGraph(scoped);
            ProcessMapPanelProvider._graph = graph;
            panel.webview.postMessage({ command: "graph", graph });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            panel.webview.postMessage({ command: "error", text: `Couldn't build the process map: ${reason}` });
        } finally {
            panel.webview.postMessage({ command: "loading", value: false });
        }
    }

    /** Setup/relative path for a node, used to open the component in the org via `sf org open`. */
    private static orgPath(node: ProcessNode): string {
        const id = typeof node.meta?.recordId === "string" ? node.meta.recordId : "";
        const versionId = typeof node.meta?.versionId === "string" ? node.meta.versionId : "";
        switch (node.kind) {
            case "flow":
            case "scheduledFlow":
                return versionId ? `/builder_platform_interaction/flowBuilder.app?flowId=${versionId}` : "/lightning/setup/Flows/home";
            case "apexClass":
                return id ? `/lightning/setup/ApexClasses/page?address=%2F${id}` : "/lightning/setup/ApexClasses/home";
            case "trigger":
                return id ? `/${id}` : "/lightning/setup/ApexTriggers/home";
            case "validationRule":
            case "workflowRule":
                return id ? `/${id}` : "/lightning/setup/WorkflowRules/home";
            case "fieldUpdate":
                return "/lightning/setup/WorkflowFieldUpdates/home";
            case "scheduledJob":
                return "/lightning/setup/ScheduledJobs/home";
            case "object": {
                const obj = node.object ?? node.label;
                return obj ? `/lightning/setup/ObjectManager/${obj}/Details/view` : "/lightning/setup/ObjectManager/home";
            }
            case "field":
                return node.object ? `/lightning/setup/ObjectManager/${node.object}/FieldsAndRelationships/view` : "/lightning/setup/ObjectManager/home";
            default:
                return "/lightning/setup/SetupOneHome/home";
        }
    }

    /** Open the component behind a node in the org's browser via the Salesforce CLI. */
    private static async openInOrg(nodeId?: string): Promise<void> {
        if (!nodeId || !ProcessMapPanelProvider._graph) return;
        const node = ProcessMapPanelProvider._graph.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const path = this.orgPath(node);
        const args = ["org", "open", "--path", path];
        if (ProcessMapPanelProvider._org) args.push("--target-org", ProcessMapPanelProvider._org);
        try {
            await runCommandArgs("sf", args, undefined, undefined, false);
            vscode.window.setStatusBarMessage(`Opening ${node.label} in the org…`, 2500);
        } catch (e) {
            vscode.window.showErrorMessage(`Couldn't open in org: ${e instanceof Error ? e.message : String(e)}`);
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
<title>Process Visualizer</title>
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
  .search input { padding-left: 28px; width: 220px; }
  .search::before { content: "⌕"; position: absolute; left: 9px; top: 50%; transform: translateY(-50%); opacity: .6; font-size: 15px; z-index: 1; }
  /* Search results dropdown */
  .results { position: absolute; top: 36px; left: 0; width: 300px; max-height: 340px; overflow-y: auto; z-index: 30;
    background: var(--pm-surface); border: 1px solid var(--pm-border-strong); border-radius: var(--pm-radius); box-shadow: var(--pm-shadow); display: none; padding: 4px; }
  .results.open { display: block; }
  .result-head { padding: 5px 8px 3px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); }
  .result-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .result-item:hover, .result-item.active { background: var(--pm-surface-2); }
  .result-item .sw { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .result-item .rk { margin-left: auto; font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .result-more { padding: 6px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
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
  /* Loading / progress */
  .empty .load { display: none; flex-direction: column; align-items: center; gap: 10px; width: min(340px, 70vw); }
  .empty.loading .load { display: flex; } .empty.loading .idle { display: none; }
  .empty .idle { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .loadstep { font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 16px; }
  .pbar { width: 100%; height: 6px; border-radius: 999px; overflow: hidden; background: var(--pm-surface-2); border: 1px solid var(--pm-border); }
  .pfill { height: 100%; width: 0; border-radius: 999px; background: linear-gradient(90deg, var(--pm-accent), color-mix(in srgb, var(--pm-accent) 55%, #10b981));
    transition: width .3s cubic-bezier(.2,.7,.2,1); }
  .pcount { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }

  /* Legend (floating) */
  .legend { position: absolute; left: 14px; bottom: 14px; display: flex; flex-wrap: wrap; gap: 6px; max-width: 62%;
    padding: 8px; border-radius: var(--pm-radius); background: color-mix(in srgb, var(--pm-surface) 82%, transparent);
    backdrop-filter: blur(8px); border: 1px solid var(--pm-border); box-shadow: var(--pm-shadow); }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px 3px 6px; border-radius: 999px; font-size: 11px;
    cursor: pointer; user-select: none; border: 1px solid var(--pm-border); background: var(--pm-surface-2); transition: opacity .12s, filter .12s; }
  .chip:hover { filter: brightness(1.15); } .chip.off { opacity: .38; }
  .chip .sw { width: 10px; height: 10px; border-radius: 3px; } .chip .n { opacity: .65; font-variant-numeric: tabular-nums; }

  /* Inspector — absolute overlay pinned to the stage's right edge (never widens the layout,
     so it can't get pushed off-screen when #cy won't shrink). */
  .inspector { position: absolute; top: 0; right: 0; bottom: 0; width: 340px; max-width: 92vw; overflow: hidden;
    border-left: 1px solid var(--pm-border); background: var(--pm-surface); box-shadow: var(--pm-shadow);
    transform: translateX(100%); transition: transform .22s cubic-bezier(.2,.7,.2,1); z-index: 25; }
  .inspector.open { transform: translateX(0); }
  .insp-inner { width: 100%; height: 100%; display: flex; flex-direction: column; }
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
  .conn .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conn .open, .execorder .open { margin-left: auto; opacity: 0; font-size: 13px; padding: 0 4px; border-radius: 5px; flex-shrink: 0; }
  .conn:hover .open, .execorder li:hover .open { opacity: .75; } .conn .open:hover, .execorder .open:hover { opacity: 1; background: var(--pm-surface-2); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .insp-open { height: 26px; font-size: 11px; padding: 0 10px; }
  /* Execution-order timeline */
  .execorder { list-style: none; margin: 0; padding: 0; }
  .execorder li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; position: relative; }
  .execorder li:hover { background: var(--pm-surface-2); }
  .execorder li::before { content: ""; position: absolute; left: 15px; top: 24px; bottom: -6px; width: 1.5px; background: var(--pm-border); }
  .execorder li:last-child::before { display: none; }
  .execorder .step { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; color: #fff; z-index: 1; }
  .execorder .et { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .execorder .et .nm { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .execorder .et .ph { font-size: 10px; color: var(--vscode-descriptionForeground); }

  /* Object picker modal */
  .pickmodal { position: fixed; inset: 0; z-index: 80; display: none; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.45); }
  .pickmodal.open { display: flex; }
  .pick-box { width: min(560px, 92vw); max-height: 80vh; display: flex; flex-direction: column;
    background: var(--pm-surface); border: 1px solid var(--pm-border-strong); border-radius: var(--pm-radius); box-shadow: var(--pm-shadow); overflow: hidden; }
  .pick-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--pm-border); }
  .pick-title { font-weight: 600; }
  .pick-head input { flex: 1; }
  .pick-count { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .pick-list { overflow-y: auto; padding: 6px; flex: 1; }
  .pick-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
  .pick-item:hover { background: var(--pm-surface-2); }
  .pick-item .cust { margin-left: auto; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .pick-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--pm-border); }

  /* Right-click context menu */
  .ctxmenu { position: fixed; z-index: 60; min-width: 180px; display: none; padding: 5px;
    background: var(--pm-surface); border: 1px solid var(--pm-border-strong); border-radius: var(--pm-radius); box-shadow: var(--pm-shadow); }
  .ctxmenu.open { display: block; }
  .ctx-title { display: flex; align-items: center; gap: 7px; padding: 4px 8px 6px; font-size: 12px; font-weight: 600;
    border-bottom: 1px solid var(--pm-border); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx-title .sw { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .ctx-item { padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap; }
  .ctx-item:hover { background: var(--pm-surface-2); }

  .status { padding: 6px 14px; font-size: 11px; color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--pm-border); flex-shrink: 0; display: flex; align-items: center; gap: 8px;
    background: var(--pm-surface); }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="brand"><span class="dotgrid"></span>Process Visualizer</span>
    <span class="sep"></span>
    <span class="lbl">Org</span>
    <select id="org"></select>
    <button class="ghost" id="pick" title="Choose which objects to include">◈ Objects: none</button>
    <button id="build">⚡ Build map</button>
    <span class="sep"></span>
    <span class="lbl">Layout</span>
    <span class="seg" id="layout">
      <button data-l="dagre" class="on">Process</button>
      <button data-l="cose">Organic</button>
    </span>
    <span class="search"><input type="search" id="search" placeholder="Search object / name…" autocomplete="off" /><div class="results" id="results"></div></span>
    <label class="chk"><input type="checkbox" id="activeOnly" /> Active only</label>
    <span class="spacer"></span>
    <button class="ghost icon" id="fit" title="Fit to view">⤢</button>
    <button class="ghost icon" id="exportPng" title="Export PNG">PNG</button>
    <button class="ghost icon" id="exportJson" title="Export JSON">JSON</button>
  </div>
  <div class="stage">
    <div id="cy"></div>
    <div class="legend" id="legend"></div>
    <div class="empty" id="empty">
      <div class="ring"></div>
      <div class="idle"><div class="big">Map your org's process</div><div>Pick an org, choose <b>Objects</b>, then press <b>Build map</b>.<br>Follow the blue arrows to read execution order · right-click a node to open it in the org.</div></div>
      <div class="load">
        <div class="big">Mapping your org…</div>
        <div class="loadstep" id="loadStep">Starting…</div>
        <div class="pbar"><div class="pfill" id="pfill"></div></div>
        <div class="pcount" id="pcount"></div>
      </div>
    </div>
    <aside class="inspector" id="inspector"><div class="insp-inner" id="inspInner"></div></aside>
  </div>
  <div class="ctxmenu" id="ctxmenu"></div>
  <div class="pickmodal" id="pickModal">
    <div class="pick-box">
      <div class="pick-head">
        <span class="pick-title">Choose objects</span>
        <input type="search" id="pickSearch" placeholder="Search objects…" autocomplete="off" />
        <span class="pick-count" id="pickCount">0 selected</span>
      </div>
      <div class="pick-list" id="pickList"></div>
      <div class="pick-foot">
        <button class="ghost" id="pickClear">Clear</button>
        <span class="spacer"></span>
        <button class="ghost" id="pickCancel">Cancel</button>
        <button id="pickApply">Apply</button>
      </div>
    </div>
  </div>
  <div class="status" id="status">Ready.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
