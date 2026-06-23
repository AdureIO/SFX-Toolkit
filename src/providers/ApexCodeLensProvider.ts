import * as vscode from "vscode";

export class ApexCodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];

    // Anonymous Apex only applies to .apex scratch files — never to .cls classes
    // (incl. test classes), which the Salesforce extension may also tag as "apex".
    if (!/\.apex$/i.test(document.uri.path)) {
      return lenses;
    }

    // Top-of-file lens for anonymous Apex execution.
    // NOTE: test-run CodeLenses were intentionally removed — Apex test running is
    // handled by VS Code's native Testing view (see ApexTestController) and by the
    // official Salesforce extension, so we don't add competing "Run Test" lenses.
    const topRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(topRange, {
        title: "$(play) Run Anonymous Apex",
        command: "adure-sfx-toolkit.executeAnonymous"
      })
    );

    return lenses;
  }
}
