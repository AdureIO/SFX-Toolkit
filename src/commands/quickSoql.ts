import * as vscode from "vscode";
import { SOQLEditorProvider } from "../providers/SOQLEditorProvider";

export async function quickSoqlFromSelection(extensionUri: vscode.Uri) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor.");
    return;
  }

  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) {
    vscode.window.showInformationMessage("Select an SObject name or field to query.");
    return;
  }

  const text = selection.trim();

  const isObjectName = /^[A-Z]\w+(__c|__mdt|__e|__b)?$/i.test(text) && !text.includes(".");
  const isFieldRef = /^\w+\.\w+$/i.test(text);

  let query: string;
  if (isObjectName) {
    query = `SELECT Id, Name FROM ${text} LIMIT 50`;
  } else if (isFieldRef) {
    const [obj, field] = text.split(".");
    query = `SELECT Id, ${field} FROM ${obj} LIMIT 50`;
  } else {
    query = `SELECT Id FROM ${text} LIMIT 50`;
  }

  await SOQLEditorProvider.show(extensionUri, query);
}
