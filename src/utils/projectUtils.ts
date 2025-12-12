import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function isSalesforceProject(): boolean {
    if (!vscode.workspace.workspaceFolders) {
        return false;
    }
    
    for (const folder of vscode.workspace.workspaceFolders) {
        const projectJsonPath = path.join(folder.uri.fsPath, 'sfdx-project.json');
        if (fs.existsSync(projectJsonPath)) {
            return true;
        }
    }
    
    return false;
}

