import * as vscode from "vscode";
import { runCommandArgs } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";

interface DeployResult {
  id: string;
  status: string;
  startDate: string;
  completedDate: string;
  numberComponentsDeployed: number;
  numberComponentErrors: number;
  createdByName: string;
}

export class DeployHistoryProvider {
  public static async show() {
    const panel = vscode.window.createWebviewPanel(
      "adure-sfx-toolkit.deployHistory",
      "Deployment History",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = DeployHistoryProvider.getLoadingHtml();

    try {
      const result = await runCommandArgs("sf", ["project", "deploy", "report", "--json"]);
      const parsed = JSON.parse(result);
      const deploys: DeployResult[] = parsed.result ? [parsed.result] : [];

      panel.webview.html = DeployHistoryProvider.getHtml(deploys);
    } catch (e: any) {
      Logger.error("Failed to fetch deployment history", e);
      panel.webview.html = DeployHistoryProvider.getErrorHtml(e.message || "Failed to fetch deployment history");
    }
  }

  private static getLoadingHtml(): string {
    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <style>body { font-family: var(--vscode-font-family); padding: 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); text-align: center; }</style>
            </head><body><h2>Loading deployment history...</h2></body></html>`;
  }

  private static getErrorHtml(message: string): string {
    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <style>body { font-family: var(--vscode-font-family); padding: 40px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
            .error { color: var(--vscode-errorForeground); padding: 16px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; }</style>
            </head><body><h2>Deployment History</h2><div class="error">${message}</div></body></html>`;
  }

  private static getHtml(deploys: DeployResult[]): string {
    const rows = deploys
      .map((d) => {
        const statusColor =
          d.status === "Succeeded"
            ? "var(--vscode-testing-iconPassed)"
            : d.status === "Failed"
              ? "var(--vscode-errorForeground)"
              : "var(--vscode-foreground)";
        return `<tr>
                <td>${d.id || ""}</td>
                <td style="color: ${statusColor}; font-weight: 600;">${d.status || ""}</td>
                <td>${d.startDate || ""}</td>
                <td>${d.completedDate || ""}</td>
                <td>${d.numberComponentsDeployed ?? 0}</td>
                <td>${d.numberComponentErrors ?? 0}</td>
                <td>${d.createdByName || ""}</td>
            </tr>`;
      })
      .join("");

    return `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
                h2 { margin-bottom: 16px; }
                table { width: 100%; border-collapse: collapse; font-size: 13px; }
                th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
                th { background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; }
                tr:hover { background: var(--vscode-list-hoverBackground); }
            </style>
        </head><body>
            <h2>Deployment History</h2>
            <table>
                <thead><tr><th>ID</th><th>Status</th><th>Start</th><th>Completed</th><th>Components</th><th>Errors</th><th>By</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </body></html>`;
  }
}
