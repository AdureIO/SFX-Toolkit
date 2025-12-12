import * as cp from 'child_process';
import * as vscode from 'vscode';
import { Logger } from './outputChannel';

export async function runCommand(command: string, cwd?: string): Promise<string> {
    Logger.info(`Executing Command: ${command}`);
    return new Promise((resolve, reject) => {
        cp.exec(command, { cwd: cwd ? cwd : vscode.workspace.workspaceFolders?.[0].uri.fsPath }, (err, stdout, stderr) => {
            if (err) {
                Logger.error(`Command failed: ${command}`, stderr || err.message);
                // Return stderr in the error to let caller decide
                (err as any).stderr = stderr;
                reject(err);
            } else {
                Logger.info(`Command executed successfully: ${command}`);
                resolve(stdout);
            }
        });
    });
}
