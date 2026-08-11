import * as vscode from "vscode";
import { reportError } from "../utils/reportError";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";

export async function metadataDiff() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor. Open a metadata file to compare.");
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const relativePath = path.relative(workspaceRoot, filePath);
  const fileName = path.basename(filePath);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Comparing ${fileName} with org...`,
      cancellable: true
    },
    async (_progress, token) => {
      let localBackup: string | undefined;
      try {
        _progress.report({ message: "Saving local copy..." });
        localBackup = fs.readFileSync(filePath, "utf8");

        _progress.report({ message: "Retrieving from org..." });
        await runCommand(
          `sf project retrieve start -d ${escapeShellArg(relativePath)} --json`,
          workspaceRoot,
          undefined,
          true,
          token
        );

        const orgContent = fs.readFileSync(filePath, "utf8");

        _progress.report({ message: "Restoring local file..." });
        fs.writeFileSync(filePath, localBackup, "utf8");

        if (orgContent === localBackup) {
          vscode.window.showInformationMessage(`${fileName} is identical to the org version.`);
          return;
        }

        const tmpFile = path.join(os.tmpdir(), `org-${Date.now()}-${fileName}`);
        fs.writeFileSync(tmpFile, orgContent, "utf8");

        await vscode.commands.executeCommand(
          "vscode.diff",
          vscode.Uri.file(tmpFile),
          editor.document.uri,
          `Org ↔ Local: ${fileName}`
        );
      } catch (e: any) {
        if (localBackup !== undefined) {
          try {
            fs.writeFileSync(filePath, localBackup, "utf8");
          } catch {
            /* best effort restore */
          }
        }
        if (e.cancelled) return;

        const msg = e.message || String(e);
        if (msg.includes("No results found") || msg.includes("does not exist") || msg.includes("NOT_FOUND")) {
          vscode.window.showWarningMessage(`${fileName} does not exist in the org.`);
        } else {
          Logger.error("Metadata diff failed", e);
          reportError({ operation: "Compare with org", error: e });
        }
      }
    }
  );
}
