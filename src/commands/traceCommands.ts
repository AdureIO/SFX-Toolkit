import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import { Logger } from '../utils/outputChannel';
import { getQuickTraceDuration, getQuickTraceDebugLevel } from '../utils/constants';

export async function quickTrace() {
    // Current User, 4 hours (240 min), Debug Level 'SFDC_DevConsole' (default widely used)
    await createTrace(getQuickTraceDuration(), null);
}

export async function createTrace(durationMinutes: number, userId: string | null, debugLevelId: string | null = null) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating Debug Trace...",
        cancellable: true
    }, async (_progress, token) => {
        try {
            let targetUserId = userId;
            if (!targetUserId) {
                const userRes = await runCommand('sf org display user --json', undefined, undefined, true, token);
                const userJson = JSON.parse(userRes);
                if (userJson.status !== 0) throw new Error('Failed to get current user info');
                targetUserId = userJson.result.id;
            }

            let targetDebugLevelId = debugLevelId;
            if (!targetDebugLevelId) {
                const dlQuery = `SELECT Id FROM DebugLevel WHERE DeveloperName = '${getQuickTraceDebugLevel()}'`;
                const dlRes = await runCommand(`sf data query -q "${dlQuery}" -t --json`, undefined, undefined, true, token);
                const dlJson = JSON.parse(dlRes);

                if (dlJson.result.records && dlJson.result.records.length > 0) {
                    targetDebugLevelId = dlJson.result.records[0].Id;
                } else {
                    const anyDlRes = await runCommand(`sf data query -q "SELECT Id FROM DebugLevel LIMIT 1" -t --json`, undefined, undefined, true, token);
                    const anyDlJson = JSON.parse(anyDlRes);
                    if (anyDlJson.result.records && anyDlJson.result.records.length > 0) {
                        targetDebugLevelId = anyDlJson.result.records[0].Id;
                    } else {
                        throw new Error("No Debug Level found. Please create one in Salesforce first.");
                    }
                }
            }

            const now = new Date();
            now.setMinutes(now.getMinutes() + durationMinutes);
            const expirationDate = now.toISOString();

            try {
                const existingQuery = `SELECT Id FROM TraceFlag WHERE TracedEntityId='${targetUserId}'`;
                const existingRes = await runCommand(`sf data query -q "${existingQuery}" -t --json`, undefined, undefined, true, token);
                const existingJson = JSON.parse(existingRes);
                if (existingJson.status === 0 && existingJson.result.records) {
                     for (const rec of existingJson.result.records) {
                         await runCommand(`sf data delete record -s TraceFlag -i ${rec.Id} -t`, undefined, undefined, true, token);
                     }
                }
            } catch (e: any) {
                if (e.cancelled) return;
                Logger.warn('Failed to cleanup old traces: ' + (e?.message || e));
            }

            const createCmd = `sf data create record -s TraceFlag -v "DebugLevelId='${targetDebugLevelId}' LogType='USER_DEBUG' TracedEntityId='${targetUserId}' ExpirationDate='${expirationDate}'" -t --json`;
            await runCommand(createCmd, undefined, undefined, true, token);

            vscode.window.showInformationMessage(`Debug trace set for ${durationMinutes} minutes.`);
            vscode.commands.executeCommand('adure-sfx-toolkit.refreshTraces');

        } catch (e: any) {
            if (e.cancelled) return;
            reportError({ operation: "Create debug trace", error: e });
        }
    });
}

export async function deleteTrace(traceId: string) {
     if (!traceId) return;
     
    const confirm = await vscode.window.showWarningMessage('Delete this trace flag?', 'Delete', 'Cancel');
    if (confirm !== 'Delete') return;

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Trace...",
        cancellable: true
    }, async (_progress, token) => {
         try {
             await runCommand(`sf data delete record -s TraceFlag -i ${traceId} -t`, undefined, undefined, true, token);
             vscode.window.showInformationMessage('Trace flag deleted.');
             vscode.commands.executeCommand('adure-sfx-toolkit.refreshTraces');
         } catch (e: any) {
             if (e.cancelled) return;
             reportError({ operation: "Delete debug trace", error: e });
         }
    });
}
