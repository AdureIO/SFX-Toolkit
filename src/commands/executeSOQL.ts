import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';

export async function executeSOQL() {
    const editor = vscode.window.activeTextEditor;
    let query = '';

    if (editor && !editor.selection.isEmpty) {
        query = editor.document.getText(editor.selection);
    } else {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter SOQL Query',
            placeHolder: 'SELECT Id, Name FROM Account LIMIT 10'
        });
        if (!input) return;
        query = input;
    }
    
    // Determine output format. JSON? Table?
    // Let's do a quick pick for format if we want to be fancy, or just default to human readable table.
    // 'sf data query' default output is table.
    
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Executing SOQL Query...",
        cancellable: false
    }, async () => {
        try {
            const result = await runCommand(`sf data query --query "${query}"`);
            
            // Open in new document or output channel?
            // A new document is nicer for viewing JSON or large tables.
            const doc = await vscode.workspace.openTextDocument({
                content: result,
                language: 'plaintext' // or json if we used --json
            });
            await vscode.window.showTextDocument(doc);
            
        } catch (e) {
            vscode.window.showErrorMessage(`Query failed: ${e}`);
        }
    });
}
