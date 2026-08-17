import * as vscode from "vscode";
import { InterpretedDeploy } from "../utils/errorInterpret";
import { getNonce, escapeHtml as esc } from "../utils/htmlUtils";
import type { DeployLiveStatus } from "../utils/deployStatusMap";
import type { ApiDeployResult, ApiComponentSuccess } from "../utils/deployDiagnostics";

/** Handle returned by beginOperation(); drives one run of the shared Operation panel. */
export interface OperationHandle {
    /** Feed a live status tick (component/test counts, elapsed). No-op once finalized or superseded by a newer operation. */
    updateLiveStatus(s: DeployLiveStatus): void;
    /** Finalize into the success view. apiResult (when present) carries details.componentSuccesses
     * for the deployed-components table, not just the summary counts. */
    succeed(summary: string, apiResult?: ApiDeployResult): void;
    /** Finalize into the failure view (same issue-card UI the panel has always shown). */
    fail(report: InterpretedDeploy, onRetry?: () => void): void;
    /** Bring the panel to the front without changing its content. */
    reveal(): void;
    /** Detach this handle so late/stray calls from a superseded run are ignored. */
    dispose(): void;
}

type PanelState = "live" | "succeeded" | "failed";

interface RenderData {
    operation: string;
    org?: string;
    startTime: number;
    report?: InterpretedDeploy;
    canRetry?: boolean;
    summary?: string;
    apiResult?: ApiDeployResult;
}

/**
 * Shared singleton panel for any long-running CLI/command operation (Deploy, Push, Pull,
 * Retrieve, Run Local Tests, …). Three states: live (while it runs, with an always-on
 * client-side elapsed timer and optional component/test counts fed via postMessage),
 * succeeded, and failed (the original interpreted error view — issue cards, plain-language
 * category/fix when recognised, click-through to file, full original payload on demand).
 * Driven by utils/reportError (reportError / reportSuccess) or directly via beginOperation().
 *
 * The panel is created LAZILY — beginOperation()/updateLiveStatus()/succeed()/fail() never open
 * or focus a tab on their own. It only appears when the user explicitly asks to see it: the
 * status bar item shown while an operation runs, or the "Show details" button on the completion
 * toast. Until then, the latest state is just tracked in `_pending` so the first reveal() paints
 * the right content immediately instead of a blank/stale panel.
 */
/** Command id for the status bar item's click action — registered once in extension.ts. */
export const REVEAL_OPERATION_PANEL_COMMAND = "adure-sfx-toolkit.revealOperationPanel";

export class OperationPanelProvider {
    public static readonly viewType = "adure-sfx-toolkit.operationPanel";
    private static _panel: vscode.WebviewPanel | undefined;
    private static _onRetry: (() => void) | undefined;
    /** Bumped on every beginOperation() so handles from a superseded run become no-ops. */
    private static _generation = 0;
    /** Latest known state, painted lazily the first time the panel is actually revealed. */
    private static _pending: { state: PanelState; data: RenderData } | undefined;

    /** Reveal the panel — creating it on first use — painted with the latest known state. No-op if no operation has run yet this session. */
    public static revealCurrent(): void {
        if (!OperationPanelProvider._pending) return;
        const { state, data } = OperationPanelProvider._pending;
        const panel = OperationPanelProvider.ensurePanel(data.operation);
        OperationPanelProvider.paint(panel, state, data);
        panel.reveal(vscode.ViewColumn.Active, false);
    }

    private static ensurePanel(operationTitle: string): vscode.WebviewPanel {
        if (!OperationPanelProvider._panel) {
            OperationPanelProvider._panel = vscode.window.createWebviewPanel(
                OperationPanelProvider.viewType,
                operationTitle || "Operation",
                { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            OperationPanelProvider._panel.onDidDispose(() => {
                OperationPanelProvider._panel = undefined;
                OperationPanelProvider._onRetry = undefined;
            });
            OperationPanelProvider._panel.webview.onDidReceiveMessage((msg: { command: string; [k: string]: unknown }) => {
                if (msg.command === "openFile") {
                    void OperationPanelProvider.openFile(
                        typeof msg.file === "string" ? msg.file : undefined,
                        typeof msg.line === "number" ? msg.line : undefined,
                        typeof msg.column === "number" ? msg.column : undefined
                    );
                } else if (msg.command === "copy" && typeof msg.text === "string") {
                    void vscode.env.clipboard.writeText(msg.text);
                    vscode.window.setStatusBarMessage("Copied error to clipboard", 2000);
                } else if (msg.command === "retry") {
                    const retry = OperationPanelProvider._onRetry;
                    OperationPanelProvider._panel?.dispose(); // the push reopens this panel if it fails again
                    retry?.();
                }
            });
        }
        return OperationPanelProvider._panel;
    }

    private static paint(panel: vscode.WebviewPanel, state: PanelState, data: RenderData): void {
        panel.title = state === "failed" ? data.report?.title || "Error" : state === "succeeded" ? `${data.operation} succeeded` : data.operation || "Operation";
        panel.webview.html = OperationPanelProvider.getHtml(panel.webview, state, data);
    }

    /** Track a fresh "live" operation and return a handle to drive it. Does NOT open the panel. */
    public static beginOperation(operation: string, org?: string): OperationHandle {
        const myGeneration = ++OperationPanelProvider._generation;
        OperationPanelProvider._onRetry = undefined;
        const startTime = Date.now();
        const base: RenderData = { operation, org, startTime };
        OperationPanelProvider._pending = { state: "live", data: base };

        const isCurrent = () => myGeneration === OperationPanelProvider._generation;

        // A status bar entry for the duration of the run — clicking it reveals the panel.
        // This (not an auto-opened tab) is the way in while the operation is still running.
        let statusBarDisposed = false;
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.text = `$(pulse) ${operation}`;
        statusBarItem.tooltip = `${operation} running — click to view live progress`;
        statusBarItem.command = REVEAL_OPERATION_PANEL_COMMAND;
        statusBarItem.show();
        const disposeStatusBar = () => {
            if (statusBarDisposed) return;
            statusBarDisposed = true;
            statusBarItem.dispose();
        };

        return {
            updateLiveStatus(s: DeployLiveStatus): void {
                if (!isCurrent()) return;
                // Only an already-open panel needs the tick — nothing to patch if the user never opened it.
                if (OperationPanelProvider._panel) {
                    OperationPanelProvider._panel.webview.postMessage({ command: "liveStatus", status: s });
                }
            },
            succeed(summary: string, apiResult?: ApiDeployResult): void {
                disposeStatusBar();
                if (!isCurrent()) return;
                const data: RenderData = { ...base, summary, apiResult };
                OperationPanelProvider._pending = { state: "succeeded", data };
                if (OperationPanelProvider._panel) OperationPanelProvider.paint(OperationPanelProvider._panel, "succeeded", data);
            },
            fail(report: InterpretedDeploy, onRetry?: () => void): void {
                disposeStatusBar();
                if (!isCurrent()) return;
                OperationPanelProvider._onRetry = onRetry;
                const data: RenderData = { ...base, report, canRetry: !!onRetry };
                OperationPanelProvider._pending = { state: "failed", data };
                if (OperationPanelProvider._panel) OperationPanelProvider.paint(OperationPanelProvider._panel, "failed", data);
            },
            reveal(): void {
                if (!isCurrent()) return;
                OperationPanelProvider.revealCurrent();
            },
            dispose(): void {
                disposeStatusBar();
                // Otherwise nothing to release directly — isCurrent() naturally starts failing
                // once a newer beginOperation() bumps the generation.
            }
        };
    }

    /** Back-compat entry point for existing failure-only callers: begin + immediately fail. Does NOT open the panel — call revealCurrent() to show it. */
    public static show(report: InterpretedDeploy, org?: string, onRetry?: () => void): void {
        const handle = OperationPanelProvider.beginOperation(report.title, org);
        handle.fail(report, onRetry);
    }

    /** Resolve a deploy fileName (relative, e.g. "classes/Foo.cls") to a workspace file and open it. */
    private static async openFile(file?: string, line?: number, column?: number): Promise<void> {
        if (!file) return;
        const base = file.split(/[\\/]/).pop() ?? file;
        // Prefer an exact tail match so classes/Foo.cls beats an unrelated Foo.cls elsewhere.
        const matches = await vscode.workspace.findFiles(`**/${base}`, "**/node_modules/**", 20);
        const target = matches.find((u) => u.fsPath.replace(/\\/g, "/").endsWith(file.replace(/\\/g, "/"))) ?? matches[0];
        if (!target) {
            vscode.window.showWarningMessage(`Couldn't locate ${file} in the workspace.`);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(target);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        if (line && line > 0) {
            const pos = new vscode.Position(line - 1, Math.max(0, (column ?? 1) - 1));
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    }

    private static getHtml(
        webview: vscode.Webview,
        state: PanelState,
        data: RenderData
    ): string {
        const nonce = getNonce();
        const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ");
        const { operation, org, startTime, report, canRetry, summary, apiResult } = data;

        const dotClass = state === "live" ? "live" : state === "succeeded" ? "ok" : "err";
        const title = state === "failed" ? report!.title : state === "succeeded" ? `${esc(operation)} succeeded` : esc(operation);

        const issueCards = (report?.issues ?? [])
            .map((it, idx) => {
                const loc = it.line ? `${it.file ? esc(it.file.split(/[\\/]/).pop()) : ""}:${it.line}${it.column ? ":" + it.column : ""}` : it.file ? esc(it.file.split(/[\\/]/).pop()) : "";
                const openBtn = it.file
                    ? `<button class="open" data-file="${esc(it.file)}" data-line="${it.line ?? 0}" data-col="${it.column ?? 0}">Open ${esc(loc)} ↗</button>`
                    : "";
                const head = [it.type ? `<span class="type">${esc(it.type)}</span>` : "", it.component ? `<span class="comp">${esc(it.component)}</span>` : ""].join("");
                return `<div class="card">
  <div class="card-head"><span class="cat">${esc(it.category)}</span>${head}<span class="idx">#${idx + 1}</span></div>
  <pre class="msg">${esc(it.problem)}</pre>
  ${it.explanation ? `<div class="explain">${esc(it.explanation)}</div>` : ""}
  ${it.suggestion ? `<div class="fix"><span class="fix-ic">💡</span>${esc(it.suggestion)}</div>` : ""}
  ${openBtn}
</div>`;
            })
            .join("");

        const resultRows: string[] = [];
        if (apiResult) {
            const dep = apiResult.numberComponentsDeployed;
            const totC = apiResult.numberComponentsTotal;
            if (dep !== undefined || totC !== undefined) {
                const errC = apiResult.numberComponentErrors ?? 0;
                resultRows.push(`<div class="stat"><span class="stat-label">Components</span><span class="stat-val">${dep ?? 0}/${totC ?? dep ?? 0}${errC > 0 ? ` <span class="stat-err">(${errC} errors)</span>` : ""}</span></div>`);
            }
            const totT = apiResult.numberTestsTotal;
            if (totT !== undefined && totT > 0) {
                const done = apiResult.numberTestsCompleted ?? 0;
                const errT = apiResult.numberTestErrors ?? 0;
                resultRows.push(`<div class="stat"><span class="stat-label">Tests</span><span class="stat-val">${done + errT}/${totT}${errT > 0 ? ` <span class="stat-err">(${errT} failed)</span>` : ""}</span></div>`);
            }
        }

        // Per-component detail — what actually deployed and its native state (Changed/Created/
        // Deleted/Unchanged), the same table shown in the Output log and the CLI, so "1/1
        // components" isn't the only thing the success view has to show for it.
        const rawSuccesses = apiResult?.details?.componentSuccesses;
        const successes: ApiComponentSuccess[] = Array.isArray(rawSuccesses) ? rawSuccesses : rawSuccesses ? [rawSuccesses] : [];
        const componentState = (c: ApiComponentSuccess): string => (c.deleted ? "Deleted" : c.created ? "Created" : c.changed ? "Changed" : "Unchanged");
        const componentRows = successes
            .map((c) => {
                const label = [c.componentType, c.fullName].filter(Boolean).join(" ") || "—";
                const loc = c.fileName?.trim() || "";
                return `<div class="comp-row"><span class="comp-state comp-state-${componentState(c).toLowerCase()}">${componentState(c)}</span><span class="comp-name">${esc(label)}</span><span class="comp-loc">${esc(loc)}</span></div>`;
            })
            .join("");

        return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  *,*::before,*::after { box-sizing: border-box; }
  :root {
    --b: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
    --surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --surface2: color-mix(in srgb, var(--vscode-foreground) 5%, var(--vscode-editor-background));
    --err: var(--vscode-editorError-foreground, #f14c4c);
    --ok: var(--vscode-terminal-ansiGreen, #2ea043);
    --accent: var(--vscode-focusBorder, #4c8bf5);
  }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; padding: 0; }
  header { position: sticky; top: 0; z-index: 2; padding: 14px 18px; border-bottom: 1px solid var(--b);
    background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 90%, transparent)); }
  .title-row { display: flex; align-items: center; gap: 12px; }
  .title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex: 1; }
  .retry { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border: none;
    padding: 6px 14px; font-weight: 600; }
  .retry:hover { filter: brightness(1.12); }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.err { background: var(--err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 25%, transparent); }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 25%, transparent); }
  .dot.live { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .sub { margin-top: 3px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .headline { margin: 10px 18px 0; padding: 10px 12px; border-radius: 8px; background: color-mix(in srgb, var(--err) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); font-size: 12.5px; }
  .warnings { margin: 10px 18px 0; padding: 10px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 38%, transparent); }
  .warn-title { font-size: 12px; font-weight: 600; color: var(--vscode-editorWarning-foreground, #cca700); margin-bottom: 4px; }
  .warn { font-size: 12.5px; line-height: 1.4; padding: 2px 0; }
  main { padding: 14px 18px 28px; display: flex; flex-direction: column; gap: 12px; }
  .card { position: relative; border: 1px solid var(--b); border-radius: 10px; padding: 12px 14px; background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .cat { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--err);
    background: color-mix(in srgb, var(--err) 14%, transparent); padding: 2px 8px; border-radius: 999px; }
  .type { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .comp { font-size: 13px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
  /* The real Salesforce message — the primary content, shown verbatim. */
  .msg { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--surface2);
    border-left: 3px solid var(--err); font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px;
    line-height: 1.5; color: var(--vscode-foreground); white-space: pre-wrap; word-break: break-word; overflow-x: auto; }
  .explain { margin-top: 8px; font-size: 12.5px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
  .fix { margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); font-size: 12.5px; line-height: 1.45;
    display: flex; gap: 8px; align-items: flex-start; }
  .fix-ic { flex-shrink: 0; }
  button { font-family: inherit; font-size: 12px; cursor: pointer; border-radius: 7px; border: 1px solid var(--b);
    background: var(--surface2); color: var(--vscode-foreground); padding: 5px 11px; }
  button:hover { filter: brightness(1.15); }
  .open { margin-top: 10px; }
  .idx { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .rawbar { margin: 4px 18px 24px; }
  .rawbar details summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); padding: 8px 0; user-select: none; }
  .rawbar pre { margin: 0; padding: 12px; background: var(--surface2); border: 1px solid var(--b); border-radius: 8px;
    overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow-y: auto; }
  .rawbar .copy { margin-bottom: 8px; }
  .empty { padding: 40px 18px; text-align: center; color: var(--vscode-descriptionForeground); }
  .stat { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-radius: 8px;
    background: var(--surface2); font-size: 12.5px; }
  .stat-label { color: var(--vscode-descriptionForeground); }
  .stat-val { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
  .stat-err { color: var(--err); font-weight: 600; }
  .stage { font-size: 13px; margin-bottom: 2px; }
  .timer { font-family: var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .live-card .stats { display: none; flex-direction: column; gap: 8px; margin-top: 12px; }
  .live-card .stats.shown { display: flex; }
  .summary-card { font-size: 13.5px; line-height: 1.5; }
  .comp-table { display: flex; flex-direction: column; max-height: 420px; overflow-y: auto; }
  .comp-row { display: flex; align-items: center; gap: 10px; padding: 6px 2px; font-size: 12.5px;
    border-bottom: 1px solid var(--b); }
  .comp-row:last-child { border-bottom: none; }
  .comp-state { flex-shrink: 0; min-width: 76px; white-space: nowrap; font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .03em; padding: 2px 7px; border-radius: 999px; text-align: center; }
  .comp-state-changed { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .comp-state-created { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
  .comp-state-deleted { color: var(--err); background: color-mix(in srgb, var(--err) 16%, transparent); }
  .comp-state-unchanged { color: var(--vscode-descriptionForeground); background: var(--surface2); }
  .comp-name { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; flex-shrink: 0; }
  .comp-loc { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style></head>
<body>
  <header>
    <div class="title-row">
      <div class="title"><span class="dot ${dotClass}"></span>${title}</div>
      ${state === "failed" && canRetry ? '<button class="retry" id="retry">↻ Retry</button>' : ""}
    </div>
    <div class="sub">${org ? "Org: " + esc(org) + " · " : ""}${
        state === "live"
            ? `Running… <span class="timer" id="timer">0:00.0</span>`
            : state === "succeeded"
              ? "Completed successfully."
              : "The exact Salesforce/CLI message is shown for each problem; the interpretation is a hint on top."
    }</div>
  </header>
  ${state === "failed" && report?.headline ? `<div class="headline">${esc(report.headline)}</div>` : ""}
  ${
      state === "failed" && report?.warnings.length
          ? `<div class="warnings"><div class="warn-title">⚠ ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}</div>${report.warnings
                .map((w) => `<div class="warn">${esc(w)}</div>`)
                .join("")}</div>`
          : ""
  }
  <main>
    ${
        state === "live"
            ? `<div class="card live-card">
      <div class="stage" id="stage">Starting…</div>
      <div class="stats" id="stats">
        <div class="stat" id="row-components" style="display:none"><span class="stat-label">Components</span><span class="stat-val" id="val-components">–</span></div>
        <div class="stat" id="row-tests" style="display:none"><span class="stat-label">Tests</span><span class="stat-val" id="val-tests">–</span></div>
      </div>
    </div>`
            : state === "succeeded"
              ? `<div class="card summary-card">${esc(summary || "Done.")}</div>
    ${resultRows.length ? `<div class="card"><div class="stats shown">${resultRows.join("")}</div></div>` : ""}
    ${componentRows ? `<div class="card"><div class="comp-table">${componentRows}</div></div>` : ""}`
              : issueCards || '<div class="empty">No structured component errors were reported. See the original output below.</div>'
    }
  </main>
  ${
      state === "failed"
          ? `<div class="rawbar">
    <details>
      <summary>Show original error output</summary>
      <button class="copy" id="copyRaw">Copy original</button>
      <pre id="raw">${esc(report?.raw ?? "")}</pre>
    </details>
  </div>`
          : ""
  }
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll(".open").forEach((b) => b.addEventListener("click", () => {
      vscode.postMessage({ command: "openFile", file: b.getAttribute("data-file"),
        line: Number(b.getAttribute("data-line")) || undefined, column: Number(b.getAttribute("data-col")) || undefined });
    }));
    const copyBtn = document.getElementById("copyRaw");
    if (copyBtn) copyBtn.addEventListener("click", () =>
      vscode.postMessage({ command: "copy", text: document.getElementById("raw").textContent }));
    const retryBtn = document.getElementById("retry");
    if (retryBtn) retryBtn.addEventListener("click", () => { retryBtn.disabled = true; retryBtn.textContent = "↻ Retrying…"; vscode.postMessage({ command: "retry" }); });

    ${
        state === "live"
            ? `
    // Elapsed timer ticks locally — accurate regardless of how often (or whether) liveStatus arrives.
    const startTime = ${startTime};
    function fmtElapsed(ms) {
      const totalMs = Math.max(0, Math.floor(ms));
      const totalS = Math.floor(totalMs / 1000);
      const d = Math.floor((totalMs % 1000) / 100);
      const s = String(totalS % 60).padStart(2, "0");
      const m = Math.floor(totalS / 60) % 60;
      const h = Math.floor(totalS / 3600);
      return h > 0 ? \`\${h}:\${String(m).padStart(2, "0")}:\${s}.\${d}\` : \`\${m}:\${s}.\${d}\`;
    }
    const timerEl = document.getElementById("timer");
    setInterval(() => { if (timerEl) timerEl.textContent = fmtElapsed(Date.now() - startTime); }, 100);

    const stageEl = document.getElementById("stage");
    const statsEl = document.getElementById("stats");
    const rowComponents = document.getElementById("row-components");
    const rowTests = document.getElementById("row-tests");
    const valComponents = document.getElementById("val-components");
    const valTests = document.getElementById("val-tests");
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.command !== "liveStatus") return;
      const s = msg.status;
      let stage = s.status === "Pending" ? "Pending" : s.status === "InProgress" ? "Deploying" : s.status;
      if (s.testsTotal > 0 && (s.testsCompleted + s.testErrors) < s.testsTotal) stage = "Running tests";
      if (s.stateDetail) stage += " · " + s.stateDetail;
      stageEl.textContent = stage;
      if (s.componentsTotal > 0) {
        rowComponents.style.display = "";
        statsEl.classList.add("shown");
        valComponents.textContent = s.componentsDeployed + "/" + s.componentsTotal + (s.componentErrors > 0 ? " (" + s.componentErrors + " errors)" : "");
      }
      if (s.testsTotal > 0) {
        rowTests.style.display = "";
        statsEl.classList.add("shown");
        valTests.textContent = (s.testsCompleted + s.testErrors) + "/" + s.testsTotal + (s.testErrors > 0 ? " (" + s.testErrors + " failed)" : "");
      }
    });`
            : ""
    }
  </script>
</body></html>`;
    }
}
