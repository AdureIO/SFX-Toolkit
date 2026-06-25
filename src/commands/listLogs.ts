import * as vscode from 'vscode';
import { logContentProvider } from '../providers/LogContentProvider';
import { listApexLogs, fetchApexLogBody } from '../utils/apexLogApi';

/**
 * List the org's recent Apex logs (over REST, same as the sidebar/workbench) and
 * let the user pick one to open. No dependency on local .sfdx/tools/debug/logs files.
 */
export async function listLogs() {
    type LogPickItem = vscode.QuickPickItem & { logId: string };
    const rows = await listApexLogs(null);
    if (!rows.length) {
        vscode.window.showInformationMessage('No Apex logs in this org (run code or enable a trace).');
        return;
    }
    const items: LogPickItem[] = rows.map((r) => ({
        label: r.operation || r.id,
        description: `${(r.length / 1024).toFixed(1)} KB · ${r.status || ''} · ${r.startTime ? new Date(r.startTime).toLocaleString() : ''}`,
        logId: r.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a log to open',
        matchOnDescription: true
    });

    if (selected) {
        await openLogById(selected.logId);
    }
}

/**
 * Open a log by id. Fetches the body over REST via apexLogApi (default org, or
 * `targetOrg` when the log belongs to another environment) and feeds it to the
 * shared content provider — no local files, no CLI.
 * @param skipProgress - when true, do not show "Opening Log..." (e.g. already in execute flow)
 * @param targetOrg - when set, fetch the log from this org (non-default)
 */
export async function openLogById(
    logId: string,
    viewColumn?: vscode.ViewColumn,
    _scheme: string = 'sf-log',
    skipProgress?: boolean,
    targetOrg?: string
) {
    async function doOpen(): Promise<void> {
        const body = await fetchApexLogBody(targetOrg ?? null, logId);
        if (!body) throw new Error('Log body could not be retrieved.');
        const scheme = _scheme || 'sf-log';
        const uri = vscode.Uri.parse(`${scheme}://log/${logId}`);
        logContentProvider.setContent(uri, body);
        const doc = await vscode.workspace.openTextDocument(uri);
        try {
            vscode.languages.setTextDocumentLanguage(doc, 'salesforce-log');
        } catch {
            // ignore
        }
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: viewColumn ?? vscode.ViewColumn.Active });
    }

    if (skipProgress) {
        try {
            await doOpen();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Error opening log: ${e?.message ?? e}`);
        }
        return;
    }

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Opening Log...', cancellable: false },
        async () => {
            try {
                await doOpen();
            } catch (e: any) {
                vscode.window.showErrorMessage(`Error opening log: ${e?.message ?? e}`);
            }
        }
    );
}
