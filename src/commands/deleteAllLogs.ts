import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logTreeProvider } from '../providers/LogTreeProvider';
import { getSalesforceLogDirectory } from '../utils/logPaths';
import { outputChannel } from '../utils/outputChannel';
import { AuthInfo } from '../utils/authInfo';
import { httpsGet, httpsDelete } from '../utils/httpUtils';
import { runCommand } from '../utils/commandRunner';
import { getToolingApiVersion, getParallelDeletes } from '../utils/constants';

/** Delete one ApexLog via Tooling API (used when REST is available). */
async function deleteOneViaTooling(instanceUrl: string, accessToken: string, id: string): Promise<void> {
    const deleteUrl = `${instanceUrl}/services/data/${getToolingApiVersion()}/tooling/sobjects/ApexLog/${id}`;
    await httpsDelete(deleteUrl, accessToken);
}

/** Delete one ApexLog via CLI (fallback when at log limit or 401). */
async function deleteOneViaCli(id: string): Promise<void> {
    await runCommand(`sf data delete record -s ApexLog -i ${id} -t --json`);
}

/** Remove all log files from .sfdx/tools/debug/logs (local copies used by our view and SF extensions). */
function removeLocalLogFiles(): number {
    const tempDir = getSalesforceLogDirectory();
    if (!tempDir || !fs.existsSync(tempDir)) return 0;
    let removed = 0;
    try {
        const names = fs.readdirSync(tempDir);
        for (const name of names) {
            const full = path.join(tempDir, name);
            try {
                if (fs.statSync(full).isFile()) {
                    fs.unlinkSync(full);
                    removed++;
                }
            } catch {
                // ignore per-file errors
            }
        }
    } catch (e) {
        outputChannel.appendLine(`deleteAllLogs: Could not clear local log folder: ${e}`);
    }
    return removed;
}

export async function deleteAllLogs() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to delete ALL debug logs from the org and clear local log cache?',
        { modal: true },
        'Delete'
    );

    if (confirm !== 'Delete') {
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting logs...",
        cancellable: false
    }, async (progress) => {
        try {
            outputChannel.appendLine('deleteAllLogs: Fetching log IDs (Tooling API)...');

            // 1. Get a fresh token to reduce 401s (clear cache then fetch)
            AuthInfo.clearCache();
            const auth = await AuthInfo.getAuthInfo();

            // 2. Get log IDs: prefer Tooling query; if no auth or query fails, use CLI (works when org at limit)
            let ids: string[] = [];
            const query = "SELECT Id FROM ApexLog LIMIT 5000";

            if (auth) {
                try {
                    progress.report({ message: "Fetching log IDs..." });
                    const queryUrl = `${auth.instanceUrl}/services/data/${getToolingApiVersion()}/tooling/query?q=${encodeURIComponent(query)}`;
                    const resultStr = await httpsGet(queryUrl, auth.accessToken);
                    const result = JSON.parse(resultStr);
                    const records = result.records || [];
                    ids = records.map((r: any) => r.Id);
                } catch (e: any) {
                    outputChannel.appendLine(`deleteAllLogs: Tooling query failed (${e.message}), trying CLI...`);
                }
            }

            if (ids.length === 0) {
                try {
                    progress.report({ message: "Fetching log IDs via CLI..." });
                    const cliResult = await runCommand(`sf data query -q "${query}" -t --json`);
                    const parsed = JSON.parse(cliResult);
                    if (parsed.status === 0 && parsed.result?.records) {
                        ids = parsed.result.records.map((r: any) => r.Id);
                    }
                } catch (e: any) {
                    outputChannel.appendLine(`deleteAllLogs: CLI query failed: ${e.message}`);
                }
            }

            if (ids.length === 0) {
                const localRemoved = removeLocalLogFiles();
                if (localRemoved > 0) {
                    vscode.window.showInformationMessage(`No logs in org. Cleared ${localRemoved} local log file(s).`);
                } else {
                    vscode.window.showInformationMessage('No logs to delete.');
                }
                logTreeProvider.clearCache();
                return;
            }

            outputChannel.appendLine(`deleteAllLogs: Found ${ids.length} log(s). Deleting via Tooling API...`);

            // 3. Delete in org: try Tooling API first; on 401/403 or repeated failures, switch to CLI
            let deleted = 0;
            let useCli = false;

            for (let i = 0; i < ids.length; i += getParallelDeletes()) {
                const chunk = ids.slice(i, i + getParallelDeletes());
                progress.report({ message: `Deleting ${Math.min(i + getParallelDeletes(), ids.length)} / ${ids.length}...` });

                if (useCli || !auth) {
                    for (const id of chunk) {
                        try {
                            await deleteOneViaCli(id);
                            deleted++;
                        } catch (e: any) {
                            if (!e.message?.includes('does not exist')) {
                                outputChannel.appendLine(`deleteAllLogs: CLI delete failed for ${id}: ${e.message}`);
                            }
                        }
                    }
                    continue;
                }

                const results = await Promise.allSettled(
                    chunk.map((id) => deleteOneViaTooling(auth!.instanceUrl, auth!.accessToken, id))
                );
                let failed = 0;
                for (let j = 0; j < results.length; j++) {
                    if (results[j].status === 'fulfilled') {
                        deleted++;
                    } else {
                        failed++;
                        const err = (results[j] as PromiseRejectedResult).reason;
                        const msg = err?.message ?? String(err);
                        if (msg.includes('401') || msg.includes('403')) {
                            outputChannel.appendLine(`deleteAllLogs: Got 401/403, switching to CLI for remaining deletes.`);
                            useCli = true;
                        } else {
                            outputChannel.appendLine(`deleteAllLogs: Tooling delete failed for ${chunk[j]}: ${msg}`);
                        }
                    }
                }
                if (useCli) {
                    for (let j = 0; j < results.length; j++) {
                        if (results[j].status === 'rejected') {
                            try {
                                await deleteOneViaCli(chunk[j]);
                                deleted++;
                            } catch (e: any) {
                                if (!e.message?.includes('does not exist')) {
                                    outputChannel.appendLine(`deleteAllLogs: CLI delete failed for ${chunk[j]}: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            }

            const localRemoved = removeLocalLogFiles();
            if (localRemoved > 0) {
                outputChannel.appendLine(`deleteAllLogs: Removed ${localRemoved} local log file(s).`);
            }

            vscode.window.showInformationMessage(
                `Deleted ${deleted} log(s) from org${localRemoved > 0 ? ` and ${localRemoved} local file(s)` : ''}.`
            );
        } catch (e: any) {
            const msg = e.message || 'Unknown Error';
            outputChannel.appendLine(`deleteAllLogs Error: ${msg}`);
            vscode.window.showErrorMessage(`Failed to delete logs: ${msg}`);
        } finally {
            logTreeProvider.clearCache();
        }
    });
}
