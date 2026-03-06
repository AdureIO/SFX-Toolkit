import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runCommand } from '../utils/commandRunner';
import { Logger } from '../utils/outputChannel';

export async function metadataDiff() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor. Open a metadata file to compare.');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const relativePath = path.relative(workspaceRoot, filePath);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Comparing ${path.basename(filePath)} with org...`,
        cancellable: true
    }, async (_progress, token) => {
        try {
            const tmpDir = path.join(os.tmpdir(), 'asfxt-diff-' + Date.now());
            fs.mkdirSync(tmpDir, { recursive: true });

            await runCommand(
                `sf project retrieve start -d "${relativePath}" --target-metadata-dir "${tmpDir}"`,
                undefined, undefined, true, token
            );

            const orgFilePath = path.join(tmpDir, relativePath);
            if (!fs.existsSync(orgFilePath)) {
                const files = findFilesRecursive(tmpDir);
                const matching = files.find(f => path.basename(f) === path.basename(filePath));
                if (matching) {
                    await openDiff(vscode.Uri.file(matching), editor.document.uri, path.basename(filePath));
                } else {
                    vscode.window.showWarningMessage('Could not find the retrieved file. The metadata may not exist in the org.');
                }
            } else {
                await openDiff(vscode.Uri.file(orgFilePath), editor.document.uri, path.basename(filePath));
            }
        } catch (e: any) {
            if (e.cancelled) return;
            Logger.error('Metadata diff failed', e);
            vscode.window.showErrorMessage(`Compare failed: ${e.message || e}`);
        }
    });
}

function findFilesRecursive(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findFilesRecursive(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

async function openDiff(orgUri: vscode.Uri, localUri: vscode.Uri, filename: string) {
    await vscode.commands.executeCommand('vscode.diff', orgUri, localUri, `Org ↔ Local: ${filename}`);
}
