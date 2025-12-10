import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';

export class TraceTreeProvider implements vscode.TreeDataProvider<TraceItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<TraceItem | undefined | null | void> = new vscode.EventEmitter<TraceItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TraceItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private timer: NodeJS.Timeout | undefined;

    constructor() { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TraceItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TraceItem): Promise<TraceItem[]> {
        if (element) {
            return [];
        }

        try {
            // Fetch TraceFlag records via Tooling API
            const query = `SELECT Id, TracedEntity.Name, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag ORDER BY ExpirationDate DESC`;
            const result = await runCommand(`sf data query -q "${query}" -t --json`);
            const parsed = JSON.parse(result);

            if (parsed.status !== 0) {
                return [new TraceItem('Error fetching traces', '', '', vscode.TreeItemCollapsibleState.None)];
            }

            const traces: any[] = parsed.result.records;
            if (!traces || traces.length === 0) {
                if (this.timer) clearTimeout(this.timer);
                return [new TraceItem('No active traces', '', '', vscode.TreeItemCollapsibleState.None)];
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
                
                const description = `[${statusStr}] ${trace.DebugLevel?.DeveloperName} - Exp: ${expirationDate.toLocaleString()}`;
                
                const item = new TraceItem(
                    label,
                    description,
                    trace.Id,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'salesforce-utils.editTrace', // Placeholder
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
             console.error(e);
             return [new TraceItem('Error: ' + e.message, '', '', vscode.TreeItemCollapsibleState.None)];
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
