import * as vscode from "vscode";
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

  // Determine output format. JSON? Table?
  // Let's do a quick pick for format if we want to be fancy, or just default to human readable table.
  // 'sf data query' default output is table.

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Executing SOQL Query...",
      cancellable: true
    },
    async () => {
      try {
        outputChannel.clear();
        Logger.info(`Running SOQL query: ${query}`);

        const result = await runCommandArgs(
          "sf",
          ["data", "query", "--query", query],
          undefined,
          (chunk) => outputChannel.append(chunk),
          true
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
        if (e.cancelled) return;
        Telemetry.event("soqlExecute", { success: "0" });
        Logger.error("SOQL query failed", e);
        outputChannel.show();
        vscode.window
          .showErrorMessage('SOQL query failed. Check "Adure SFX Toolkit" output for details.', "View Log")
          .then((choice) => {
            if (choice === "View Log") {
              outputChannel.show();
            }
          });
      }
    }
  );
}
