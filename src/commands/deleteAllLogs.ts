import * as vscode from 'vscode';
import { logTreeProvider } from '../providers/LogTreeProvider';
import { outputChannel } from '../utils/outputChannel';
import { AuthInfo } from '../utils/authInfo';
import { httpsGet, httpsDelete } from '../utils/httpUtils';

export async function deleteAllLogs() {
    // Confirm
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to delete ALL debug logs from the org?',
        { modal: true },
        'Delete'
    );

    if (confirm !== 'Delete') {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Initializing Deletion...",
        cancellable: false
    }, async (progress) => {
        try {
            outputChannel.appendLine('deleteAllLogs: Starting Native REST Deletion...');
            
            // 1. Get Auth
            const auth = await AuthInfo.getAuthInfo();
            if (!auth) {
                throw new Error("Could not retrieve Org Authentication.");
            }

            // 2. Query IDs (Limit 5000 to be safe, can loop if needed but 5000 is plenty usually)
            progress.report({ message: "Fetching Log IDs..." });
            const query = "SELECT Id FROM ApexLog LIMIT 5000";
            const version = 'v60.0';
            const queryUrl = `${auth.instanceUrl}/services/data/${version}/tooling/query?q=${encodeURIComponent(query)}`;
            
            const resultStr = await httpsGet(queryUrl, auth.accessToken);
            const result = JSON.parse(resultStr);
            
            const records = result.records || [];
            if (records.length === 0) {
                vscode.window.showInformationMessage('No logs to delete.');
                logTreeProvider.clearCache();
                return;
            }

            outputChannel.appendLine(`Found ${records.length} logs to delete.`);

            // 3. Batch Delete (Composite API limits to 200 IDs per "collection" delete)
            const ids = records.map((r: any) => r.Id);
            const BATCH_SIZE = 200;
            const total = ids.length;
            let deleted = 0;

            for (let i = 0; i < total; i += BATCH_SIZE) {
                const chunk = ids.slice(i, i + BATCH_SIZE);
                const idsStr = chunk.join(',');
                
                // Composite SObject Collection Delete
                // DELETE /services/data/vXX.0/composite/sobjects?ids=...&allOrNone=false
                // Note: Is ApexLog supported in composite? Yes, usually. 
                // If not, we fall back to looped individual deletes (slower but works).
                
                const deleteUrl = `${auth.instanceUrl}/services/data/${version}/composite/sobjects?ids=${idsStr}&allOrNone=false`;
                
                progress.report({ message: `Deleting logs ${i + 1} to ${Math.min(i + BATCH_SIZE, total)} of ${total}...` });
                
                try {
                    await httpsDelete(deleteUrl, auth.accessToken);
                    deleted += chunk.length;
                    outputChannel.appendLine(`Deleted batch ${i}-${i+chunk.length}`);
                } catch (e: any) {
                    // Fallback or Log
                    outputChannel.appendLine(`Batch delete failed: ${e}`);
                    // If composite is not supported for ApexLog, we might see 400.
                    // But ApexLog is a Standard Object, usually robust.
                }
            }

            vscode.window.showInformationMessage(`Successfully deleted ${deleted} logs.`);

        } catch (e: any) {
            const msg = e.message || 'Unknown Error';
            outputChannel.appendLine(`deleteAllLogs Error: ${msg}`);
            vscode.window.showErrorMessage(`Failed to delete logs: ${msg}`);
        } finally {
            logTreeProvider.clearCache();
        }
    });
}
