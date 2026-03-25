import * as vscode from "vscode";

export class ApexCodeLensProvider implements vscode.CodeLensProvider {
  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();

    // Top-of-file lens for anonymous Apex execution
    const topRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(topRange, {
        title: "$(play) Run Anonymous Apex",
        command: "adure-sfx-toolkit.executeAnonymous"
      })
    );

    // If this is a test class, add "Run All Tests in Class" lens
    const isTestClass = /@isTest/i.test(text);
    if (isTestClass) {
      lenses.push(
        new vscode.CodeLens(topRange, {
          title: "$(beaker) Run All Tests in Class",
          command: "adure-sfx-toolkit.runLocalTests"
        })
      );
    }

    // Add lenses for individual @isTest or testMethod methods
    const methodRegex = /(?:@isTest|testMethod)\s+(?:static\s+)?(?:void|[\w<>\[\]]+)\s+(\w+)\s*\(/gi;
    let match;
    while ((match = methodRegex.exec(text)) !== null) {
      const pos = document.positionAt(match.index);
      const range = new vscode.Range(pos, pos);
      const methodName = match[1];
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(play) Run Test: ${methodName}`,
          command: "adure-sfx-toolkit.runLocalTests",
          arguments: [methodName]
        })
      );
    }

    return lenses;
  }
}
