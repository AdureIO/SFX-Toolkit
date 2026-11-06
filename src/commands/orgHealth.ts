import * as vscode from "vscode";
import { runCommandArgs } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";
import { escapeHtml, getNonce } from "../utils/htmlUtils";

export class OrgHealthProvider {
  /** Singleton: re-running the command reveals (and refreshes) the open panel. */
  private static panel: vscode.WebviewPanel | undefined;
  /** Bumped per load so a slow, superseded `sf limits` call can't overwrite newer content. */
  private static loadSeq = 0;

  public static async show(_extensionUri: vscode.Uri) {
    let panel = OrgHealthProvider.panel;
    if (panel) {
      panel.reveal();
    } else {
      panel = vscode.window.createWebviewPanel(
        "adure-sfx-toolkit.orgHealth",
        "Org Health Dashboard",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      OrgHealthProvider.panel = panel;
      const created = panel;
      const sub = created.onDidDispose(() => {
        if (OrgHealthProvider.panel === created) OrgHealthProvider.panel = undefined;
        sub.dispose();
      });
    }

    const seq = ++OrgHealthProvider.loadSeq;
    const target = panel;
    const isCurrent = () => OrgHealthProvider.panel === target && OrgHealthProvider.loadSeq === seq;
    target.webview.html = OrgHealthProvider.getLoadingHtml();

    try {
      const limitsStr = await runCommandArgs("sf", ["limits", "api", "display", "--json"]);
      const limitsJson = JSON.parse(limitsStr);
      const limits = Array.isArray(limitsJson.result) ? limitsJson.result : [];

      if (isCurrent()) target.webview.html = OrgHealthProvider.getHtml(limits);
    } catch (e: any) {
      Logger.error("Failed to fetch org limits", e);
      if (isCurrent()) target.webview.html = OrgHealthProvider.getErrorHtml(e?.message || "Failed to fetch org limits");
    }
  }

  /** Close the panel (deactivate). */
  public static dispose(): void {
    OrgHealthProvider.panel?.dispose();
    OrgHealthProvider.panel = undefined;
  }

  private static getLoadingHtml(): string {
    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <style>body { font-family: var(--vscode-font-family); padding: 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); text-align: center; }</style>
            </head><body><h2>Loading org limits...</h2><p>Fetching data from Salesforce...</p></body></html>`;
  }

  private static getErrorHtml(message: string): string {
    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <style>body { font-family: var(--vscode-font-family); padding: 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
            .error { color: var(--vscode-errorForeground); padding: 16px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; }</style>
            </head><body><h2>Org Health Dashboard</h2><div class="error">${escapeHtml(message)}</div></body></html>`;
  }

  private static getHtml(limits: any[]): string {
    const rows = limits
      .map((l: any) => {
        const name = escapeHtml(l?.name || "");
        const max = Number(l?.max) || 0;
        const remaining = Number(l?.remaining) || 0;
        const used = max - remaining;
        const pct = max > 0 ? Math.round((used / max) * 100) : 0;
        const color =
          pct >= 90
            ? "var(--vscode-errorForeground)"
            : pct >= 70
              ? "var(--vscode-editorWarning-foreground)"
              : "var(--vscode-testing-iconPassed)";
        return `<tr>
                <td>${name}</td>
                <td>${used.toLocaleString()} / ${max.toLocaleString()}</td>
                <td>${remaining.toLocaleString()}</td>
                <td>
                    <div class="bar-bg"><div class="bar-fill" style="width: ${pct}%; background: ${color};"></div></div>
                    <span style="color: ${color}; font-weight: 600;">${pct}%</span>
                </td>
            </tr>`;
      })
      .join("");

    const nonce = getNonce();
    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
                h2 { margin-bottom: 16px; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; }
                th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
                th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; }
                tr:hover { background: var(--vscode-list-hoverBackground); }
                .bar-bg { display: inline-block; width: 100px; height: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; vertical-align: middle; margin-right: 8px; }
                .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
                input { width: 100%; padding: 6px 10px; margin-bottom: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); box-sizing: border-box; }
            </style>
        </head><body>
            <h2>Org Health Dashboard</h2>
            <input type="text" id="search" placeholder="Filter limits...">
            <table id="limitsTable">
                <thead><tr><th>Limit Name</th><th>Used / Max</th><th>Remaining</th><th>Usage</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <script nonce="${nonce}">
                function filterTable() {
                    const filter = document.getElementById('search').value.toUpperCase();
                    const rows = document.querySelectorAll('#limitsTable tbody tr');
                    rows.forEach(row => {
                        const name = row.cells[0].textContent || '';
                        row.style.display = name.toUpperCase().includes(filter) ? '' : 'none';
                    });
                }
                document.getElementById('search').addEventListener('input', filterTable);
            </script>
        </body></html>`;
  }
}
