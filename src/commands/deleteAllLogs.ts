import * as vscode from "vscode";
import { outputChannel } from "../utils/outputChannel";
import { deleteAllApexLogs } from "../utils/apexLogApi";

/**
 * Delete all debug logs from the org via the Tooling API (apexLogApi — the same
 * batched REST path the workbench uses). No CLI, no local .sfdx log files.
 */
export async function deleteAllLogs() {
  const confirm = await vscode.window.showWarningMessage(
    "Delete ALL debug logs from the org?",
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Deleting logs...", cancellable: false },
    async () => {
      try {
        const deleted = await deleteAllApexLogs(null);
        vscode.window.showInformationMessage(
          deleted > 0 ? `Deleted ${deleted} log(s) from the org.` : "No logs to delete."
        );
      } catch (e: any) {
        const msg = e?.message ?? "Unknown error";
        outputChannel.appendLine(`deleteAllLogs: ${msg}`);
        vscode.window.showErrorMessage(`Failed to delete logs: ${msg}`);
      }
    }
  );
}
