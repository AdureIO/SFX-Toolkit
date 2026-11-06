import * as vscode from "vscode";
import { reportError } from "../utils/reportError";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";

/** Org-side copies for the diff editor live here; swept so they never accumulate. */
const DIFF_TMP_DIR = path.join(os.tmpdir(), "asfx-metadata-diff");
const DIFF_TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Remove org copies older than an hour (left behind by a crashed/closed window). */
function sweepOldDiffFiles(): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(DIFF_TMP_DIR)) {
      const f = path.join(DIFF_TMP_DIR, name);
      try {
        if (now - fs.statSync(f).mtimeMs > DIFF_TMP_MAX_AGE_MS) fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir doesn't exist yet */
  }
}

/** Delete the temp org copy as soon as its diff document is closed. */
function deleteWhenClosed(tmpFile: string): void {
  const sub = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (doc.uri.scheme === "file" && doc.uri.fsPath === tmpFile) {
      sub.dispose();
      fs.promises.unlink(tmpFile).catch(() => undefined);
    }
  });
}

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

        sweepOldDiffFiles();
        fs.mkdirSync(DIFF_TMP_DIR, { recursive: true });
        const tmpFile = path.join(DIFF_TMP_DIR, `org-${Date.now()}-${fileName}`);
        fs.writeFileSync(tmpFile, orgContent, "utf8");
        deleteWhenClosed(tmpFile);

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
