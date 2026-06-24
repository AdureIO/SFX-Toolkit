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

/**
 * Walk up from a file path to the nearest directory containing sfdx-project.json.
 * Lets nested/sub-projects (e.g. billing/force-app/...) resolve their own org/config
 * instead of always using the workspace root. Returns null if none is found.
 */
export function findSfdxProjectDir(filePath: string): string | null {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

const CONTEXT_KEY = 'adure-sfx-toolkit:isSalesforceProject';

/** Update the context key so views/commands can use "when" clauses. Call on activation and on workspace folder change. */
export function updateSalesforceProjectContext(): void {
    vscode.commands.executeCommand('setContext', CONTEXT_KEY, isSalesforceProject());
}

