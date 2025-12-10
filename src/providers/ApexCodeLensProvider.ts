import * as vscode from 'vscode';

export class ApexCodeLensProvider implements vscode.CodeLensProvider {
    
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];

        // Simple: Just put one at the top of the file
        const range = new vscode.Range(0, 0, 0, 0);
        const cmd: vscode.Command = {
            title: "$(play) Run Anonymous Apex",
            command: "salesforce-utils.executeAnonymous"
        };
        
        lenses.push(new vscode.CodeLens(range, cmd));
        return lenses;
    }
}
