import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/outputChannel';

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

function getRelativePath(uri: vscode.Uri): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    let rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
    try {
        if (fs.statSync(uri.fsPath).isDirectory()) {
            if (!rel.endsWith('/')) rel += '/';
        }
    } catch { /* ignore */ }
    return rel;
}

export async function addToGitignore(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const rel = getRelativePath(uri);
    if (!rel) return;

    const gitignorePath = path.join(root, '.gitignore');
    if (await appendToFile(gitignorePath, rel)) {
        vscode.window.showInformationMessage(`Added "${rel}" to .gitignore`);
    }
}

export async function addToForceignore(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const rel = getRelativePath(uri);
    if (!rel) return;

    const forceignorePath = path.join(root, '.forceignore');
    if (await appendToFile(forceignorePath, rel)) {
        vscode.window.showInformationMessage(`Added "${rel}" to .forceignore`);
    }
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
