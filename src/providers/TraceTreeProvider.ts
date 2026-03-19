import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import { isSalesforceProject } from '../utils/projectUtils';
import { Logger } from '../utils/outputChannel';

export class TraceTreeProvider implements vscode.TreeDataProvider<TraceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TraceItem | undefined | null | void> = new vscode.EventEmitter<TraceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TraceItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private timer: NodeJS.Timeout | undefined;

    constructor() { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Clear the expiration timer (e.g. on extension deactivate) to avoid leaking. */
    clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    getTreeItem(element: TraceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TraceItem): Promise<TraceItem[]> {
        if (element) {
            return [];
        }
        if (!isSalesforceProject()) {
            return [new TraceItem('Open an SFDX project', '', '', vscode.TreeItemCollapsibleState.None)];
        }

        try {
            // Fetch all TraceFlag records visible to the current user (Tooling API)
            // Includes traces for this user, Automated Process, and other users they can see
            const query = `SELECT Id, TracedEntity.Name, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag ORDER BY ExpirationDate DESC`;
            const result = await runCommand(`sf data query -q "${query}" -t --json`);
            const parsed = JSON.parse(result);

            if (parsed.status !== 0) {
                return [new TraceItem('Error fetching traces', '', '', vscode.TreeItemCollapsibleState.None)];
            }

            const traces: any[] = parsed.result.records;
            if (!traces || traces.length === 0) {
                if (this.timer) clearTimeout(this.timer);
                return [new TraceItem('No debug traces', '', '', vscode.TreeItemCollapsibleState.None)];
            }

            // Track next expiration for auto-refresh
            let nextExpirationTime: number | null = null;
            const now = new Date();

            const traceItems = traces.map((trace: any) => {
                const label = trace.TracedEntity?.Name || 'Unknown Entity';
                const expirationDate = new Date(trace.ExpirationDate);
                const isActive = expirationDate > now;
                
                // Track soonest future expiration
                if (isActive) {
                    const time = expirationDate.getTime();
                    if (!nextExpirationTime || time < nextExpirationTime) {
                        nextExpirationTime = time;
                    }
                }

                const statusStr = isActive ? 'Active' : 'Expired';
                // 'check' for active, 'circle-slash' for expired (red)
                const icon = isActive ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'));
                
                let timeInfo = '';
                if (isActive) {
                    const diffMs = expirationDate.getTime() - now.getTime();
                    const diffMin = Math.round(diffMs / 60000);
                    if (diffMin < 60) timeInfo = diffMin + 'min remaining';
                    else timeInfo = Math.round(diffMin / 60) + 'h ' + (diffMin % 60) + 'min remaining';
                } else {
                    timeInfo = 'Expired ' + expirationDate.toLocaleString();
                }
                const description = `[${statusStr}] ${trace.DebugLevel?.DeveloperName} - ${timeInfo}`;
                
                const item = new TraceItem(
                    label,
                    description,
                    trace.Id,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'adure-sfx-toolkit.editTrace', // Placeholder
                        title: 'Edit Trace',
                        arguments: [trace.Id]
                    }
                );
                item.iconPath = icon;
                return item;
            });

            // Schedule refresh
            if (nextExpirationTime) {
                this.scheduleRefresh(nextExpirationTime);
            } else {
               // No active traces needing a timer
               if(this.timer) clearTimeout(this.timer);
            }
            
            return traceItems;

        } catch (e: any) {
            const msg = e?.message || String(e);

            // Common CLI/installation issues
            if (msg.includes('not found') || msg.includes('ENOENT') || msg.includes('command not found')) {
                Logger.warn('Salesforce CLI (sf) not found — trace view unavailable');
                return [
                    new TraceItem(
                        'Salesforce CLI not found',
                        'Install sf CLI to view traces',
                        '',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }
            if (msg.includes('No default') || msg.includes('target-org') || msg.includes('authenticate')) {
                return [
                    new TraceItem(
                        'No default org set',
                        'Connect an org first',
                        '',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }

            // Handle Salesforce Edge / HTML error pages (HTTP 420 etc.) more cleanly.
            if (
                msg.includes('ERROR_HTTP_420') ||
                msg.includes('HTTP response contains html content') ||
                msg.includes('Status Codes and Error Responses')
            ) {
                const shortMessage =
                    'Salesforce org is returning an HTML error page (HTTP 420). Check that the org is up and reachable.';
                Logger.error('Error fetching traces (HTTP 420 / HTML response)', shortMessage);
                vscode.window.showErrorMessage(
                    'Could not load debug traces: org is not reachable or still being set up (HTTP 420).'
                );
                return [
                    new TraceItem(
                        'Org not reachable',
                        'Salesforce returned an HTML error page (HTTP 420). Try again in a few minutes.',
                        '',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }

            Logger.error('Error fetching traces', e);
            return [
                new TraceItem(
                    'Could not load traces',
                    'Check "Adure SFX Toolkit" output for details',
                    '',
                    vscode.TreeItemCollapsibleState.None
                ),
            ];
        }
    }

    private scheduleRefresh(expirationTime: number) {
        if (this.timer) clearTimeout(this.timer);
        
        const now = Date.now();
        const delay = expirationTime - now + 1000; // +1s buffer
        
        if (delay > 0) {
            // max delay for setTimeout is roughly 24 days, unlikely to exceed for debugging
            this.timer = setTimeout(() => {
                this.refresh();
            }, delay);
        }
    }
}

export class TraceItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly traceId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.contextValue = 'traceItem';
    }
}
