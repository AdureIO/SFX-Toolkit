import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import { logContentProvider } from '../providers/LogContentProvider';
import * as fs from 'fs';

interface SalesforceLog {
    Id: string;
    Application: string;
    DurationMilliseconds: number;
    Location: string;
    LogLength: number;
    LogUser: {
        Name: string;
    };
    Operation: string;
    Request: string;
    StartTime: string;
    Status: string;
}

export async function listLogs() {
    try {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Fetching Salesforce Logs...",
            cancellable: false
        }, async () => {
            // Fetch logs using SOQL (progress used implicitly via window state, no need to report increments for simple fetch)
            const result = await runCommand('sf apex list log --json');
            const parsed = JSON.parse(result);
            
            if (parsed.status !== 0) {
                vscode.window.showErrorMessage(`Failed to list logs: ${parsed.message}`);
                return;
            }

            const logs: SalesforceLog[] = parsed.result;
            if (!logs || logs.length === 0) {
                vscode.window.showInformationMessage('No debug logs found.');
                return;
            }

            const items: vscode.QuickPickItem[] = logs.map(log => ({
                label: `${log.LogUser.Name} - ${log.Status}`,
                description: `${log.Operation} (${log.DurationMilliseconds}ms)`,
                detail: `${log.StartTime} - ${log.Id} - ${log.LogLength} bytes`,
                logId: log.Id
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a log to download and open'
            });

            if (selected) {
                const logItem = selected as any;
                await openLogById(logItem.logId);
            }
        });
    } catch (e) {
        vscode.window.showErrorMessage(`Error listing logs: ${e}`);
    }
}

export async function openLogById(logId: string, viewColumn?: vscode.ViewColumn, scheme: string = 'sf-log') {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Opening Log...",
        cancellable: false
    }, async (progress) => {
        try {
             // We assume the log was downloaded during list population (eager fetch).
             // Check temp dir.
             const os = require('os');
             const path = require('path');
             const fs = require('fs');
             const tempDir = path.join(os.tmpdir(), 'salesforce-vscode-logs');
             const logPath = path.join(tempDir, `${logId}.log`);
             
             if (!fs.existsSync(logPath)) {
                 // Fallback: Download it now if for some reason it's missing (e.g. temp cleared)
                 await runCommand(`sf apex get log -i ${logId} -d "${tempDir}"`);
             }
             
             if (fs.existsSync(logPath)) {
                    const content = fs.readFileSync(logPath, 'utf8');
                    
                    // Use custom scheme for Read-Only / No-Save behavior
                    const uri = vscode.Uri.parse(`${scheme}://${logId}/${logId}.log`);
                    
                    logContentProvider.setContent(uri, content);
                    
                    const doc = await vscode.workspace.openTextDocument(uri);
                    try { vscode.languages.setTextDocumentLanguage(doc, 'salesforce-log'); } catch(e){}
                    
                    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: viewColumn });
                    
                    // Do NOT delete file, keep cache as requested ("download directly and keep it like that")
                    // If we delete, next open needs download.
                    return;
             }
             
             throw new Error("Log file could not be retrieved.");

        } catch (e: any) {
            const msg = e.stderr || e.message;
            vscode.window.showErrorMessage(`Error opening log: ${msg}`);
        }
    });
}
