import * as cp from 'child_process';
import * as vscode from 'vscode';

export async function runCommand(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.exec(command, { cwd: cwd ? cwd : vscode.workspace.workspaceFolders?.[0].uri.fsPath }, (err, stdout, stderr) => {
            if (err) {
                // Return stderr in the error to let caller decide
                (err as any).stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}
