import { reportError } from '../utils/reportError';
import * as vscode from 'vscode';
import { runCommandArgs } from '../utils/commandRunner';
import { Logger } from '../utils/outputChannel';
import { getQuickTraceDuration, getQuickTraceDebugLevel } from '../utils/constants';

/** Salesforce record id (15/18 alphanumeric). Anything else is rejected before it reaches SOQL/CLI. */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
/** DebugLevel.DeveloperName: letters, digits, underscores. */
const DEV_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isSalesforceId(value: unknown): value is string {
    return typeof value === 'string' && SF_ID_RE.test(value);
}

function requireId(value: unknown, what: string): string {
    if (!isSalesforceId(value)) throw new Error(`Invalid ${what} id: ${String(value)}`);
    return value;
}

/** Run an `sf` command without a shell (argv) — no quoting/injection concerns. */
function sf(args: string[], token?: vscode.CancellationToken): Promise<string> {
    return runCommandArgs('sf', args, undefined, undefined, true, undefined, token);
}

export async function quickTrace() {
    // Current User, 4 hours (240 min), Debug Level 'SFDC_DevConsole' (default widely used)
    await createTrace(getQuickTraceDuration(), null);
}

export async function createTrace(durationMinutes: number, userId: string | null, debugLevelId: string | null = null) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Creating Debug Trace...",
        cancellable: true
    }, async (_progress, token) => {
        try {
            let targetUserId = userId;
            if (!targetUserId) {
                const userRes = await sf(['org', 'display', 'user', '--json'], token);
                const userJson = JSON.parse(userRes);
                if (userJson.status !== 0) throw new Error('Failed to get current user info');
                targetUserId = userJson.result?.id;
            }
            targetUserId = requireId(targetUserId, 'user');

            let targetDebugLevelId = debugLevelId;
            if (!targetDebugLevelId) {
                const levelName = getQuickTraceDebugLevel();
                let records: any[] = [];
                if (DEV_NAME_RE.test(levelName)) {
                    const dlRes = await sf(['data', 'query', '-q', `SELECT Id FROM DebugLevel WHERE DeveloperName = '${levelName}'`, '-t', '--json'], token);
                    records = JSON.parse(dlRes).result?.records ?? [];
                } else {
                    Logger.warn(`Ignoring invalid quick-trace debug level name: ${levelName}`);
                }

                if (records.length > 0) {
                    targetDebugLevelId = records[0].Id;
                } else {
                    const anyDlRes = await sf(['data', 'query', '-q', 'SELECT Id FROM DebugLevel LIMIT 1', '-t', '--json'], token);
                    const anyRecords: any[] = JSON.parse(anyDlRes).result?.records ?? [];
                    if (anyRecords.length > 0) {
                        targetDebugLevelId = anyRecords[0].Id;
                    } else {
                        throw new Error("No Debug Level found. Please create one in Salesforce first.");
                    }
                }
            }
            targetDebugLevelId = requireId(targetDebugLevelId, 'debug level');

            const minutes = Math.max(1, Math.min(1440, Math.floor(Number(durationMinutes) || 0)));
            const now = new Date();
            now.setMinutes(now.getMinutes() + minutes);
            const expirationDate = now.toISOString();

            try {
                const existingRes = await sf(['data', 'query', '-q', `SELECT Id FROM TraceFlag WHERE TracedEntityId='${targetUserId}'`, '-t', '--json'], token);
                const existingJson = JSON.parse(existingRes);
                if (existingJson.status === 0 && Array.isArray(existingJson.result?.records)) {
                    for (const rec of existingJson.result.records) {
                        if (!isSalesforceId(rec?.Id)) continue;
                        await sf(['data', 'delete', 'record', '-s', 'TraceFlag', '-i', rec.Id, '-t'], token);
                    }
                }
            } catch (e: any) {
                if (e.cancelled) return;
                Logger.warn('Failed to cleanup old traces: ' + (e?.message || e));
            }

            await sf([
                'data', 'create', 'record', '-s', 'TraceFlag',
                '-v', `DebugLevelId='${targetDebugLevelId}' LogType='USER_DEBUG' TracedEntityId='${targetUserId}' ExpirationDate='${expirationDate}'`,
                '-t', '--json'
            ], token);

            vscode.window.showInformationMessage(`Debug trace set for ${minutes} minutes.`);
            void vscode.commands.executeCommand('adure-sfx-toolkit.refreshTraces').then(undefined, () => undefined);

        } catch (e: any) {
            if (e.cancelled) return;
            reportError({ operation: "Create debug trace", error: e });
        }
    });
}

export async function deleteTrace(traceId: string) {
    if (!traceId) return;
    if (!isSalesforceId(traceId)) {
        reportError({ operation: "Delete debug trace", error: `Invalid trace flag id: ${traceId}` });
        return;
    }

    const confirm = await vscode.window.showWarningMessage('Delete this trace flag?', 'Delete', 'Cancel');
    if (confirm !== 'Delete') return;

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Trace...",
        cancellable: true
    }, async (_progress, token) => {
        try {
            await sf(['data', 'delete', 'record', '-s', 'TraceFlag', '-i', traceId, '-t'], token);
            vscode.window.showInformationMessage('Trace flag deleted.');
            void vscode.commands.executeCommand('adure-sfx-toolkit.refreshTraces').then(undefined, () => undefined);
        } catch (e: any) {
            if (e.cancelled) return;
            reportError({ operation: "Delete debug trace", error: e });
        }
    });
}
