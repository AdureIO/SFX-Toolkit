import * as vscode from "vscode";
import { InterpretedDeploy } from "../utils/deployErrorInterpret";

function getNonce(): string {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

const esc = (t: unknown): string =>
    String(t ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

/**
 * Interpreted deploy/push error panel. Shows each failure in plain language with a
 * suggested fix and a click-through to the offending file, plus the original raw
 * error on demand. Opened programmatically when a push/deploy fails.
 */
export class DeployErrorPanelProvider {
    public static readonly viewType = "adure-sfx-toolkit.deployError";
    private static _panel: vscode.WebviewPanel | undefined;

    public static show(report: InterpretedDeploy, org?: string): void {
        // Open in the active editor group (full), not a split.
        const column = vscode.ViewColumn.Active;
        if (!DeployErrorPanelProvider._panel) {
            DeployErrorPanelProvider._panel = vscode.window.createWebviewPanel(
                DeployErrorPanelProvider.viewType,
                "Deploy Errors",
                { viewColumn: column, preserveFocus: false },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            DeployErrorPanelProvider._panel.onDidDispose(() => (DeployErrorPanelProvider._panel = undefined));
            DeployErrorPanelProvider._panel.webview.onDidReceiveMessage((msg: { command: string; [k: string]: unknown }) => {
                if (msg.command === "openFile") {
                    void DeployErrorPanelProvider.openFile(
                        typeof msg.file === "string" ? msg.file : undefined,
                        typeof msg.line === "number" ? msg.line : undefined,
                        typeof msg.column === "number" ? msg.column : undefined
                    );
                } else if (msg.command === "copy" && typeof msg.text === "string") {
                    void vscode.env.clipboard.writeText(msg.text);
                    vscode.window.setStatusBarMessage("Copied error to clipboard", 2000);
                }
            });
        }
        const panel = DeployErrorPanelProvider._panel;
        panel.title = report.counts.errors ? `Deploy Errors (${report.counts.errors})` : "Deploy Errors";
        panel.webview.html = DeployErrorPanelProvider.getHtml(panel.webview, report, org);
        panel.reveal(column, false);
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

    private static getHtml(webview: vscode.Webview, report: InterpretedDeploy, org?: string): string {
        const nonce = getNonce();
        const csp = ["default-src 'none'", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`].join("; ");

        const issueCards = report.issues
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
    --accent: var(--vscode-focusBorder, #4c8bf5);
  }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; padding: 0; }
  header { position: sticky; top: 0; z-index: 2; padding: 14px 18px; border-bottom: 1px solid var(--b);
    background: linear-gradient(180deg, var(--surface), color-mix(in srgb, var(--surface) 90%, transparent)); }
  .title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .title .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 25%, transparent); }
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
</style></head>
<body>
  <header>
    <div class="title"><span class="dot"></span>${esc(report.title)}</div>
    <div class="sub">${org ? "Org: " + esc(org) + " · " : ""}Interpreted from the deploy result — the exact Salesforce message is under each item.</div>
  </header>
  ${report.headline ? `<div class="headline">${esc(report.headline)}</div>` : ""}
  ${
      report.warnings.length
          ? `<div class="warnings"><div class="warn-title">⚠ ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}</div>${report.warnings
                .map((w) => `<div class="warn">${esc(w)}</div>`)
                .join("")}</div>`
          : ""
  }
  <main>
    ${issueCards || '<div class="empty">No structured component errors were reported. See the original output below.</div>'}
  </main>
  <div class="rawbar">
    <details>
      <summary>Show original error output</summary>
      <button class="copy" id="copyRaw">Copy original</button>
      <pre id="raw">${esc(report.raw)}</pre>
    </details>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll(".open").forEach((b) => b.addEventListener("click", () => {
      vscode.postMessage({ command: "openFile", file: b.getAttribute("data-file"),
        line: Number(b.getAttribute("data-line")) || undefined, column: Number(b.getAttribute("data-col")) || undefined });
    }));
    const copyBtn = document.getElementById("copyRaw");
    if (copyBtn) copyBtn.addEventListener("click", () =>
      vscode.postMessage({ command: "copy", text: document.getElementById("raw").textContent }));
  </script>
</body></html>`;
    }
}
