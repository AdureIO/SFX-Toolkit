import { reportError } from '../utils/reportError';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/outputChannel';
import { projectDirOfFile } from '../utils/projectUtils';
import { forceignoreRoot, gitignoreRoot, ignoreEntry, type IgnoreEnv } from '../utils/ignoreTargetPure';

async function appendToFile(filePath: string, entry: string): Promise<boolean> {
    try {
        let content = '';
        if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, 'utf8');
        }
        const lines = content.split('\n').map(l => l.trim());
        if (lines.includes(entry.trim())) {
            vscode.window.showInformationMessage(`"${entry}" already in ${path.basename(filePath)}.`);
            return false;
        }
        const newline = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
        fs.appendFileSync(filePath, newline + entry + '\n', 'utf8');
        return true;
    } catch (e: any) {
        Logger.error(`Failed to update ${filePath}`, e);
        reportError({ operation: `Update ${path.basename(filePath)}`, error: e });
        return false;
    }
}

const ignoreEnv: IgnoreEnv = {
    exists: (p) => fs.existsSync(p),
    isDirectory: (p) => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
    },
};

function workspaceFolderOf(uri: vscode.Uri): string | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function addTo(uri: vscode.Uri | undefined, fileName: '.gitignore' | '.forceignore'): Promise<void> {
    if (!uri) {
        uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
    }
    const ws = workspaceFolderOf(uri);
    const root = fileName === '.gitignore'
        ? gitignoreRoot(uri.fsPath, ws, ignoreEnv)
        : forceignoreRoot(uri.fsPath, projectDirOfFile(uri.fsPath), ws);
    if (!root) return;

    const rel = ignoreEntry(uri.fsPath, root, ignoreEnv);
    if (await appendToFile(path.join(root, fileName), rel)) {
        vscode.window.showInformationMessage(`Added "${rel}" to ${fileName}`);
    }
}

export async function addToGitignore(uri?: vscode.Uri): Promise<void> {
    await addTo(uri, '.gitignore');
}

export async function addToForceignore(uri?: vscode.Uri): Promise<void> {
    await addTo(uri, '.forceignore');
}

export async function addToIgnore(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
    }

    const picked = await vscode.window.showQuickPick(
        [
            { label: '$(git-commit) .gitignore', target: 'git' },
            { label: '$(cloud) .forceignore', target: 'force' },
            { label: '$(checklist) Both', target: 'both' },
        ],
        { placeHolder: 'Add to which ignore file?' }
    );
    if (!picked) return;

    if (picked.target === 'git' || picked.target === 'both') {
        await addToGitignore(uri);
    }
    if (picked.target === 'force' || picked.target === 'both') {
        await addToForceignore(uri);
    }
}
