import * as vscode from "vscode";
import { reportError } from "../utils/reportError";
import { deleteAllApexLogs } from "../utils/apexLogApi";
import { LiveLogService } from "../utils/liveLogService";

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
        const { deleted, failed, firstError } = await deleteAllApexLogs(null);
        void LiveLogService.clear(null);
        if (failed) {
          vscode.window.showWarningMessage(`Deleted ${deleted} log(s); ${failed} could not be deleted: ${firstError}`);
        } else {
          vscode.window.showInformationMessage(
            deleted > 0 ? `Deleted ${deleted} log(s) from the org.` : "No logs to delete."
          );
        }
      } catch (e: any) {
        reportError({ operation: "Delete all logs", error: e });
      }
    }
  );
}
