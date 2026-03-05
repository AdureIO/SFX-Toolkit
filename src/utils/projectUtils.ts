import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Message shown when workspace is not an SFDX project. */
export const NOT_SFDX_PROJECT_MESSAGE = 'Open an SFDX project (folder containing sfdx-project.json) to use Salesforce features.';

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

const CONTEXT_KEY = 'adure-sfx-toolkit:isSalesforceProject';

/** Update the context key so views/commands can use "when" clauses. Call on activation and on workspace folder change. */
export function updateSalesforceProjectContext(): void {
    vscode.commands.executeCommand('setContext', CONTEXT_KEY, isSalesforceProject());
}

