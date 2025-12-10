import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';

export async function quickTrace() {
    // Current User, 24 hours (1440 min), Debug Level 'SFDC_DevConsole' (default widely used)
    await createTrace(1440, null);
}

export async function createTrace(durationMinutes: number, userId: string | null, debugLevelId: string | null = null) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating Debug Trace...",
        cancellable: false
    }, async () => {
        try {
            // 1. Get User ID if not provided (Current User)
            let targetUserId = userId;
            if (!targetUserId) {
                const userRes = await runCommand('sf org display user --json');
                const userJson = JSON.parse(userRes);
                if (userJson.status !== 0) throw new Error('Failed to get current user info');
                targetUserId = userJson.result.id;
            }

            // 2. Get DebugLevel ID
            let targetDebugLevelId = debugLevelId;
            if (!targetDebugLevelId) {
                // Query for 'SFDC_DevConsole' which is standard standard.
                const dlQuery = "SELECT Id FROM DebugLevel WHERE DeveloperName = 'SFDC_DevConsole'";
                const dlRes = await runCommand(`sf data query -q "${dlQuery}" -t --json`);
                const dlJson = JSON.parse(dlRes);
                
                if (dlJson.result.records && dlJson.result.records.length > 0) {
                    targetDebugLevelId = dlJson.result.records[0].Id;
                } else {
                    // If not found, find ANY debug level
                    const anyDlRes = await runCommand(`sf data query -q "SELECT Id FROM DebugLevel LIMIT 1" -t --json`);
                    const anyDlJson = JSON.parse(anyDlRes);
                    if (anyDlJson.result.records && anyDlJson.result.records.length > 0) {
                        targetDebugLevelId = anyDlJson.result.records[0].Id;
                    } else {
                        throw new Error("No Debug Level found. Please create one in Salesforce first.");
                    }
                }
            }

            // 3. Set Expiration
            const now = new Date();
            now.setMinutes(now.getMinutes() + durationMinutes);
            // Salesforce expects ISO string
            const expirationDate = now.toISOString();

            // 3.5 Cleanup: Delete existing active traces for this user
            // Salesforce limits, and having multiple active can be confusing or error.
            try {
                const existingQuery = `SELECT Id FROM TraceFlag WHERE TracedEntityId='${targetUserId}'`;
                const existingRes = await runCommand(`sf data query -q "${existingQuery}" -t --json`);
                const existingJson = JSON.parse(existingRes);
                if (existingJson.status === 0 && existingJson.result.records) {
                     for(const rec of existingJson.result.records) {
                         // Delete quietly
                         await runCommand(`sf data delete record -s TraceFlag -i ${rec.Id} -t`);
                     }
                }
            } catch(e) { 
                console.warn('Failed to cleanup old traces', e); 
            }

            // 4. Create TraceFlag
            // We use 'sf data create record'
            // Fields: DebugLevelId, LogType='USER_DEBUG', TracedEntityId, ExpirationDate
            const createCmd = `sf data create record -s TraceFlag -v "DebugLevelId='${targetDebugLevelId}' LogType='USER_DEBUG' TracedEntityId='${targetUserId}' ExpirationDate='${expirationDate}'" -t --json`;
            await runCommand(createCmd);

            vscode.window.showInformationMessage(`Debug trace set for ${durationMinutes} minutes.`);
            vscode.commands.executeCommand('salesforce-utils.refreshTraces');
        
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to set trace: ${e.stderr || e.message}`);
        }
    });
}

export async function deleteTrace(traceId: string) {
     if (!traceId) return;
     
     // Confirm? optional. Let's just delete to be "Quick".
     // Actually, UI usually implies right-click delete is explicit.
     
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Trace...",
        cancellable: false
    }, async () => {
         try {
             await runCommand(`sf data delete record -s TraceFlag -i ${traceId} -t`);
             vscode.window.showInformationMessage('Trace flag deleted.');
             vscode.commands.executeCommand('salesforce-utils.refreshTraces');
         } catch (e: any) {
             vscode.window.showErrorMessage(`Failed to delete trace: ${e.message}`);
         }
    });
}
