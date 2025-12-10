import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runCommand } from '../utils/commandRunner';
import { openLogById } from './listLogs';

// Track last executed file for Rerun capability
let lastAnonymousContent: string = '';

export async function executeAnonymous() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        // Fallback: If no editor, try to rerun last?
        if (lastAnonymousContent) {
            await executeContent(lastAnonymousContent);
            return;
        }
        vscode.window.showErrorMessage('No active editor.');
        return;
    }

    const doc = editor.document;
    const text = doc.getText(editor.selection.isEmpty ? undefined : editor.selection);

    if (!text.trim()) {
         vscode.window.showInformationMessage('No code to execute.');
         return;
    }

    // Save if dirty
    if (doc.isDirty && !doc.isUntitled) {
        await doc.save(); 
    }
    
    lastAnonymousContent = text;
    await executeContent(text);
}

export async function rerunLastApex() {
    if (!lastAnonymousContent) {
        vscode.window.showInformationMessage('No previous Apex execution found to rerun.');
        return;
    }
    await executeContent(lastAnonymousContent);
}

async function executeContent(text: string) {
    // Create temp file for execution
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `anon-${Date.now()}.apex`);
    fs.writeFileSync(tmpFile, text);

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Executing Anonymous Apex...",
        cancellable: false
    }, async () => {
        try {
            // 1. Get User
            let userId: string; 
            try {
                const userRes = await runCommand('sf org display user --json');
                const userJson = JSON.parse(userRes);
                if (userJson.status === 0) {
                    userId = userJson.result.id;
                } else {
                    throw new Error("Could not determine current user.");
                }
            } catch (e) {
                userId = ''; 
            }

            let oldHeadLogId: string | null = null;
            
            // 2. Pre-Check: Get current latest log ID
            let query = "SELECT Id FROM ApexLog";
            if (userId) query += ` WHERE LogUserId = '${userId}'`;
            query += " ORDER BY StartTime DESC LIMIT 1";
            
            try {
                const prevRes = await runCommand(`sf data query -q "${query}" -t --json`);
                const prevJson = JSON.parse(prevRes);
                if (prevJson.status === 0 && prevJson.result.records?.length > 0) {
                    oldHeadLogId = prevJson.result.records[0].Id;
                }
            } catch(e){}

            // 3. Execute
            const res = await runCommand(`sf apex run -f "${tmpFile}"`);
            
            // 4. Query Log (Again)
            const logRes = await runCommand(`sf data query -q "${query}" -t --json`);
            const logJson = JSON.parse(logRes);

            // Check if we found a log, AND it is different from the old HEAD
            if (logJson.status === 0 && logJson.result.records && logJson.result.records.length > 0) {
                const logId = logJson.result.records[0].Id;
                
                if (logId === oldHeadLogId) {
                    // No new log generated
                     vscode.window.showWarningMessage("Code executed successfully, but NO NEW debug log was generated. Please check if a Trace Flag is active for your user.");
                     const channel = vscode.window.createOutputChannel("Salesforce Apex Execution");
                     channel.clear();
                     channel.append(res);
                     channel.show();
                     return;
                }
                
                // 4. Open in Split Bottom
                // Strategy: 
                // A) If we are in the Primary Source Editor (ViewColumn 1 usually), split DOWN.
                // B) If we are already in a Log View (ViewColumn 2/Bottom), just replace it.
                
                let targetColumn = vscode.ViewColumn.Beside; // Fallback
                
                if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn === vscode.ViewColumn.One) {
                     // We are in main editor.
                     // Check if there is already a 'Bottom' group (e.g. ViewColumn 2 implies split)
                     // Hard to check accurately without complicated API.
                     // Simple approach: Run 'workbench.action.splitEditorDown'.
                     // But we don't want to duplicate the source file. 
                     
                     // Better: "openLogById" with a specific column?
                     // VS Code API 'vscode.window.showTextDocument' takes a column. 
                     // Column 'Beside' splits horizontally (Side by Side) by default settings, 
                     // but user asked for "Bottom".
                     // Resetting user layout preference is intrusive.
                     // However, we can use `workbench.action.moveEditorToBelowGroup` immediately after opening?
                     
                     // Let's try:
                     // 1. Open Log 'Beside' (Standard split).
                     // 2. Then move it 'Down'??
                     
                     // Actually, just calling 'workbench.action.splitEditorDown' explicitly CREATES the bottom group active with current file.
                     // Then we open log in Active (which is bottom).
                     await vscode.commands.executeCommand('workbench.action.splitEditorDown');
                     targetColumn = vscode.ViewColumn.Active; 
                } else {
                    // We are likely already in the split or re-running.
                    // Just stay here.
                    targetColumn = vscode.ViewColumn.Active;
                }
                
                await openLogById(logId, targetColumn, 'sf-anon-log');

            } else {
                 vscode.window.showWarningMessage("Code executed, but no debug log was found.");
                 const channel = vscode.window.createOutputChannel("Salesforce Apex Execution");
                 channel.clear();
                 channel.append(res);
                 channel.show();
            }

        } catch (e: any) {
            vscode.window.showErrorMessage(`Execution failed.`);
            const channel = vscode.window.createOutputChannel("Salesforce Apex Execution");
            channel.clear();
            channel.appendLine("Error executing Anonymous Apex:");
            channel.appendLine(e.stderr || e.message);
            channel.show();
        } finally {
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        }
    });
}
