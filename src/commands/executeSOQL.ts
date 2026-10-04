import * as vscode from "vscode";
import { reportError } from "../utils/reportError";
import { runCommandArgs } from "../utils/commandRunner";
import { Logger, outputChannel } from "../utils/outputChannel";
import { Telemetry } from "../utils/telemetry";

export async function executeSOQL() {
  const editor = vscode.window.activeTextEditor;
  let query = "";

  if (editor && !editor.selection.isEmpty) {
    query = editor.document.getText(editor.selection);
  } else {
    const input = await vscode.window.showInputBox({
      prompt: "Enter SOQL Query",
      placeHolder: "SELECT Id, Name FROM Account LIMIT 10"
    });
    if (!input) return;
    query = input;
  }

  // 'sf data query' default output is a human-readable table.
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Executing SOQL Query...",
      cancellable: true
    },
    async (_progress, token) => {
      try {
        // Don't clear the shared log channel — it holds the extension's diagnostic history.
        Logger.info(`Running SOQL query: ${query}`);

        const result = await runCommandArgs(
          "sf",
          ["data", "query", "--query", query],
          undefined,
          (chunk) => outputChannel.append(chunk),
          true,
          undefined,
          token
        );

        Logger.info("SOQL query executed successfully.");
        Telemetry.event("soqlExecute", { success: "1" });

        const doc = await vscode.workspace.openTextDocument({
          content: result,
          language: "plaintext"
        });
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage("SOQL query executed. Results opened in a new document.");
      } catch (e: any) {
        if (e?.cancelled || token.isCancellationRequested) return;
        Telemetry.event("soqlExecute", { success: "0" });
        reportError({ operation: "SOQL query", error: e });
      }
    }
  );
}
