import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { outputChannel } from "../utils/outputChannel";
import { getSalesforceLogDirectory } from "../utils/logPaths";
import { isSalesforceProject } from "../utils/projectUtils";
import { runCommand } from "../utils/commandRunner";
import { getMaxLogFiles } from "../utils/constants";

/** Regex to derive a short label from log body (e.g. trigger or class name). */
const CODE_UNIT_STARTED = /\|CODE_UNIT_STARTED\|\[.*?\]\|.*?\|(.*)$/m;
const LOG_PREVIEW_BYTES = 64 * 1024;

function readFilePreview(fullPath: string, maxBytes: number): string {
  const fd = fs.openSync(fullPath, "r");
  try {
    const buffer = new Uint8Array(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    if (bytesRead <= 0) return "";
    return Buffer.from(buffer.subarray(0, bytesRead)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Returns true if the log body indicates execution failure (exception/fatal). */
function isLogFailure(body: string): boolean {
  return /FATAL_ERROR|EXCEPTION_THROWN|\|ERROR\|/.test(body);
}

export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<LogItem | undefined | null | void> = new vscode.EventEmitter<
    LogItem | undefined | null | void
  >();
  readonly onDidChangeTreeData: vscode.Event<LogItem | undefined | null | void> = this._onDidChangeTreeData.event;

  /** Set by polling commands so the view can show polling state. */
  public isPolling = false;

  private fetchInProgress = false;

  constructor() {}

  clearCache(): void {
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * When polling is enabled: query the org for recent ApexLog IDs and download any that
   * are not yet in .sfdx/tools/debug/logs, then refresh the tree.
   * Shows a progress notification (loading bar) while retrieving.
   */
  async fetchNewLogsFromOrg(): Promise<void> {
    if (this.fetchInProgress) return;
    this.fetchInProgress = true;
    try {
      const logDir = getSalesforceLogDirectory();
      if (!logDir || !isSalesforceProject()) return;
      if (!fs.existsSync(logDir)) {
        try {
          fs.mkdirSync(logDir, { recursive: true });
        } catch (e) {
          outputChannel.appendLine(`LogTreeProvider: Could not create log dir: ${e}`);
          return;
        }
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Retrieving logs",
          cancellable: false
        },
        async (progress) => {
          try {
            progress.report({ message: "Querying org…" });
            const query = `SELECT Id FROM ApexLog ORDER BY StartTime DESC LIMIT ${getMaxLogFiles()}`;
            const result = await runCommand(`sf data query -q "${query}" -t --json`);
            const parsed = JSON.parse(result);
            if (parsed.status !== 0 || !parsed.result?.records?.length) return;
            const ids: string[] = parsed.result.records.map((r: { Id: string }) => r.Id);
            const toFetch = ids.filter((id) => !fs.existsSync(path.join(logDir, `${id}.log`)));
            if (toFetch.length === 0) {
              progress.report({ message: "Up to date" });
              return;
            }
            let fetched = 0;
            for (let i = 0; i < toFetch.length; i++) {
              const id = toFetch[i];
              progress.report({ message: `Downloading ${i + 1}/${toFetch.length}…` });
              try {
                await runCommand(`sf apex get log -i ${id} -d "${logDir}"`);
                fetched++;
              } catch (e: any) {
                if (!e?.message?.includes("does not exist")) {
                  outputChannel.appendLine(`LogTreeProvider: Failed to get log ${id}: ${e?.message ?? e}`);
                }
              }
            }
            if (fetched > 0) {
              outputChannel.appendLine(`LogTreeProvider: Polling fetched ${fetched} new log(s).`);
              this.refresh();
            }
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            if (msg.includes("not found") || msg.includes("ENOENT")) {
              outputChannel.appendLine("LogTreeProvider: Salesforce CLI (sf) not found — polling skipped.");
            } else {
              outputChannel.appendLine(`LogTreeProvider: Polling query failed: ${msg}`);
            }
          }
        }
      );
    } finally {
      this.fetchInProgress = false;
    }
  }

  getTreeItem(element: LogItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: LogItem): Promise<LogItem[]> {
    if (element) {
      return [];
    }
    if (!isSalesforceProject()) {
      return [new LogItem("Open an SFDX project", "", "", vscode.TreeItemCollapsibleState.None)];
    }

    const logDir = getSalesforceLogDirectory();
    if (!logDir) {
      return [new LogItem("Open a workspace folder", "", "", vscode.TreeItemCollapsibleState.None)];
    }
    if (!fs.existsSync(logDir)) {
      return [
        new LogItem(
          "No log folder yet",
          "Logs appear when Salesforce extensions save to .sfdx/tools/debug/logs",
          "",
          vscode.TreeItemCollapsibleState.None
        )
      ];
    }

    try {
      const names = fs.readdirSync(logDir);
      const logFiles = names
        .filter((n) => n.endsWith(".log"))
        .map((name) => {
          const full = path.join(logDir, name);
          try {
            const stat = fs.statSync(full);
            return { name, full, mtime: stat.mtime.getTime(), size: stat.size };
          } catch {
            return null;
          }
        })
        .filter((f): f is { name: string; full: string; mtime: number; size: number } => f !== null);

      logFiles.sort((a, b) => b.mtime - a.mtime);

      if (logFiles.length === 0) {
        return [
          new LogItem(
            "No debug logs",
            "Save logs to .sfdx/tools/debug/logs (e.g. via Salesforce extensions)",
            "",
            vscode.TreeItemCollapsibleState.None
          )
        ];
      }

      const items: LogItem[] = logFiles.map((f) => {
        const logId = f.name.replace(/\.log$/i, "");
        let label = logId;
        let preview = "";
        let tooltip = `File: ${f.name}\nSize: ${this.formatBytes(f.size)}\nModified: ${new Date(f.mtime).toLocaleString()}`;
        try {
          preview = readFilePreview(f.full, LOG_PREVIEW_BYTES);
          const match = preview.match(CODE_UNIT_STARTED);
          if (match && match[1]) {
            label = match[1].trim();
          }
          tooltip += `\n\nID: ${logId}`;
        } catch {
          // keep label as logId
        }
        const description = `${this.formatBytes(f.size)} · ${this.formatRelativeTime(f.mtime)}`;
        const item = new LogItem(
          label,
          description,
          logId,
          vscode.TreeItemCollapsibleState.None,
          {
            command: "adure-sfx-toolkit.openLog",
            title: "Open Log",
            arguments: [logId]
          },
          tooltip
        );
        item.resourceUri = vscode.Uri.file(f.full);

        let failed = false;
        if (preview) {
          failed = isLogFailure(preview);
        }

        if (failed) {
          item.iconPath = new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("testing.iconFailed"));
        } else {
          item.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
        }
        return item;
      });

      return items;
    } catch (e: any) {
      outputChannel.appendLine(`LogTreeProvider: ${e?.message ?? e}`);
      return [
        new LogItem("Error reading log folder", String(e?.message ?? e), "", vscode.TreeItemCollapsibleState.None)
      ];
    }
  }

  private formatBytes(bytes: number, decimals = 2): string {
    if (!+bytes) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  private formatRelativeTime(mtime: number): string {
    const diff = Date.now() - mtime;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(mtime).toLocaleDateString();
  }
}

export const logTreeProvider = new LogTreeProvider();

export class LogItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public description: string | boolean | undefined,
    public readonly logId: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command,
    public readonly tooltip?: string
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = "logItem";
  }
}
