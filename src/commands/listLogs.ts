import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getSalesforceLogDirectory } from "../utils/logPaths";
import { AuthInfo } from "../utils/authInfo";
import { httpsGet } from "../utils/httpUtils";
import { logContentProvider } from "../providers/LogContentProvider";

/**
 * List log files from .sfdx/tools/debug/logs (where Salesforce extensions save logs)
 * and let the user pick one to open.
 */
export async function listLogs() {
  const logDir = getSalesforceLogDirectory();
  if (!logDir || !fs.existsSync(logDir)) {
    vscode.window.showInformationMessage(
      "No log folder found. Logs appear in .sfdx/tools/debug/logs when Salesforce extensions save them."
    );
    return;
  }

  const names = fs.readdirSync(logDir).filter((n) => n.endsWith(".log"));
  if (names.length === 0) {
    vscode.window.showInformationMessage("No debug logs in .sfdx/tools/debug/logs.");
    return;
  }

  type LogPickItem = vscode.QuickPickItem & { logId: string };
  const items: LogPickItem[] = names
    .map((name): LogPickItem | null => {
      const full = path.join(logDir, name);
      try {
        const stat = fs.statSync(full);
        return {
          label: name,
          description: `${(stat.size / 1024).toFixed(1)} KB · ${stat.mtime.toLocaleString()}`,
          logId: name.replace(/\.log$/i, "")
        };
      } catch {
        return null;
      }
    })
    .filter((i): i is LogPickItem => i !== null);

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a log to open",
    matchOnDescription: true
  });

  if (selected) {
    await openLogById(selected.logId);
  }
}

import { getToolingApiVersion } from "../utils/constants";

/**
 * Open a log by id (filename without .log).
 * Uses REST to fetch log body when auth is available and targetOrg not set; otherwise uses CLI.
 * @param skipProgress - when true, do not show "Opening Log..." (e.g. when already in execute flow)
 * @param targetOrg - when set, fetch log from this org via CLI (required when log is from non-default org)
 */
export async function openLogById(
  logId: string,
  viewColumn?: vscode.ViewColumn,
  _scheme: string = "sf-log",
  skipProgress?: boolean,
  targetOrg?: string
) {
  const { runCommand } = await import("../utils/commandRunner");
  const logDir = getSalesforceLogDirectory();
  if (!logDir) {
    vscode.window.showErrorMessage("Open a workspace folder to open logs.");
    return;
  }
  const dir: string = logDir;
  const orgFlag = targetOrg ? ` -o ${targetOrg}` : "";
  async function doOpen(token?: vscode.CancellationToken): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const logPath = path.join(dir, `${logId}.log`);
    const needFetch = targetOrg || !fs.existsSync(logPath);

    if (needFetch) {
      if (targetOrg) {
        await runCommand(`sf apex get log -i ${logId} -d "${dir}"${orgFlag}`, undefined, undefined, true, token);
      } else {
        const auth = await AuthInfo.getAuthInfo();
        if (auth) {
          try {
            const url = `${auth.instanceUrl}/services/data/${getToolingApiVersion()}/tooling/sobjects/ApexLog/${logId}/Body`;
            const body = await httpsGet(url, auth.accessToken);
            fs.writeFileSync(logPath, body);
          } catch {
            await runCommand(`sf apex get log -i ${logId} -d "${dir}"`, undefined, undefined, true, token);
          }
        } else {
          await runCommand(`sf apex get log -i ${logId} -d "${dir}"`, undefined, undefined, true, token);
        }
      }
    }

    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf-8");
      const scheme = _scheme || "sf-log";
      const uri = vscode.Uri.parse(`${scheme}://log/${logId}`);
      logContentProvider.setContent(uri, content);
      const doc = await vscode.workspace.openTextDocument(uri);
      try {
        vscode.languages.setTextDocumentLanguage(doc, "salesforce-log");
      } catch {
        // ignore
      }
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: viewColumn ?? vscode.ViewColumn.Active });
      return;
    }

    throw new Error("Log file could not be found or retrieved.");
  }

  if (skipProgress) {
    try {
      await doOpen();
    } catch (e: any) {
      if (!e.cancelled) vscode.window.showErrorMessage(`Error opening log: ${e.stderr ?? e.message ?? e}`);
    }
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Opening Log...", cancellable: true },
    async (_progress, token) => {
      try {
        await doOpen(token);
      } catch (e: any) {
        if (e.cancelled) return;
        vscode.window.showErrorMessage(`Error opening log: ${e.stderr ?? e.message ?? e}`);
      }
    }
  );
}
