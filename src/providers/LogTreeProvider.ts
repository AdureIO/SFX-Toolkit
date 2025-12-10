import * as vscode from 'vscode';
import { runCommand } from '../utils/commandRunner';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { outputChannel } from '../utils/outputChannel';
import { AuthInfo } from '../utils/authInfo';
import { httpsGet } from '../utils/httpUtils';

export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<LogItem | undefined | null | void> = new vscode.EventEmitter<LogItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LogItem | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache for detail strings (Trigger/Class names) derived from log body
    public isPolling = false;
    private isFetching = false;
    private cachedLogs: LogItem[] = [];
    private lastSuccessDate: string | null = null; // Track latest log time for incremental fetch

    constructor() { }
    
    public clearCache() {
        this.cachedLogs = [];
        this.lastSuccessDate = null;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: LogItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: LogItem): Promise<LogItem[]> {
        if (element) {
            return []; // No children for logs currently
        }

        // Debounce / Busy Check
        if (this.isFetching) {
            outputChannel.appendLine('LogTreeProvider: Busy fetching, returning cache.');
            return this.cachedLogs;
        }
        this.isFetching = true;

        try {
            outputChannel.appendLine(`LogTreeProvider: Fetching logs... (Polling: ${this.isPolling})`);
            
            // Construct Query: Incremental vs Initial
            let query = '';
            if (!this.lastSuccessDate || this.cachedLogs.length === 0) {
                // Initial Load (Last 10)
                query = `SELECT Id, LogUser.Name, Operation, Status, DurationMilliseconds, StartTime, LogLength, Location FROM ApexLog ORDER BY StartTime DESC LIMIT 10`;
                outputChannel.appendLine('LogTreeProvider: Initial Fetch (LIMIT 10)');
            } else {
                // Incremental Fetch (Newer than last known)
                // Note: StartTime format in SOQL matches ISO? Yes.
                query = `SELECT Id, LogUser.Name, Operation, Status, DurationMilliseconds, StartTime, LogLength, Location FROM ApexLog WHERE StartTime > ${this.lastSuccessDate} ORDER BY StartTime DESC`;
                outputChannel.appendLine(`LogTreeProvider: Incremental Fetch (> ${this.lastSuccessDate})`);
            }
            
            const result = await runCommand(`sf data query -q "${query}" -t --json`);
            const parsed = JSON.parse(result);

            if (parsed.status !== 0) {
                const msg = `Failed to list logs: ${parsed.message}`;
                outputChannel.appendLine(msg);
                // If failure is due to query parsing or connection, keep cache.
                // If polling, just log.
                if (!this.isPolling) {
                     vscode.window.showErrorMessage(msg);
                }
                return this.cachedLogs; 
            }

            const newLogs: any[] = parsed.result.records;
            
            if (!newLogs || newLogs.length === 0) {
                 // No new logs. Return cache.
                 if (this.cachedLogs.length === 0) {
                     return [new LogItem('No debug logs found', '', '', vscode.TreeItemCollapsibleState.None)];
                 }
                 return this.cachedLogs;
            }
            
            // Fix: If it was initial load, we might get logs we already potentially saw if we did a hard refresh?
            // Actually, if cachedLogs was 0, we take them all.
            // If incremental, we take them all (they are all > lastDate).
            
            outputChannel.appendLine(`LogTreeProvider: Found ${newLogs.length} new logs.`);

            // 2. Download Content for NEW Logs (Fast REST API)
            const tempDir = path.join(os.tmpdir(), 'salesforce-vscode-logs');
            if (!fs.existsSync(tempDir)) {
                 try { fs.mkdirSync(tempDir, { recursive: true }); } catch(e) {}
            }
            
            // Try to get Auth for fast fetch
            const auth = await AuthInfo.getAuthInfo();

            // Define the fetch task
            const fetchTask = async () => {
                await Promise.all(newLogs.map(async (log) => {
                     const logFile = path.join(tempDir, `${log.Id}.log`);
                     if (!fs.existsSync(logFile)) {
                         try {
                             if (auth) {
                                 // Fast Way: Direct HTTP
                                 // Endpoint: /services/data/v60.0/tooling/sobjects/ApexLog/{ID}/Body
                                 // Note: Instance URL usually doesn't need trailing slash?
                                 const version = 'v60.0';
                                 const url = `${auth.instanceUrl}/services/data/${version}/tooling/sobjects/ApexLog/${log.Id}/Body`;
                                 const body = await httpsGet(url, auth.accessToken);
                                 fs.writeFileSync(logFile, body);
                             } else {
                                 // Fallback: Slow CLI
                                 await runCommand(`sf apex get log -i ${log.Id} -d "${tempDir}"`);
                             }
                         } catch (e) {
                             outputChannel.appendLine(`Failed to download log ${log.Id}: ${e}`);
                             // If REST fails, try fallback?
                             // Can try/catch inside block. 
                         }
                     }
                }));
            };

            // If polling, run silently. If manual (and initial load), show progress.
            if (this.isPolling) {
                await fetchTask();
            } else {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Downloading ${newLogs.length} New Logs...`,
                    cancellable: false
                }, fetchTask);
            }

            const newItems = newLogs.map((log: any) => {
                // Formatting timestamp
                const startTime = new Date(log.StartTime).toLocaleString();
                
                // Icon
                const isSuccess = log.Status === 'Success';
                const icon = isSuccess ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')) : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                
                // Label Logic
                let trigger = log.Operation;
                const logFile = path.join(tempDir, `${log.Id}.log`);
                
                if (fs.existsSync(logFile)) {
                    try {
                        const body = fs.readFileSync(logFile, 'utf8');
                        const match = body.match(/\|CODE_UNIT_STARTED\|\[.*?\]\|.*?\|(.*)$/m);
                        if (match && match[1]) {
                            trigger = match[1];
                        }
                    } catch (e) { }
                } else if (log.Location && log.Location !== 'System') {
                    // Fallback
                    trigger += ` : ${log.Location}`;
                }
                
                const item = new LogItem(
                    trigger,
                    `${log.LogUser.Name} - ${log.Status} (${log.DurationMilliseconds}ms) @ ${startTime}`,
                    log.Id,
                    vscode.TreeItemCollapsibleState.None,
                    {
                        command: 'salesforce-utils.openLog',
                        title: 'Open Log',
                        arguments: [log.Id]
                    },
                    `ID: ${log.Id}\nUser: ${log.LogUser.Name}\nStatus: ${log.Status}\nSize: ${this.formatBytes(log.LogLength)}\nTime: ${startTime}\nOperation: ${log.Operation}\nLocation: ${log.Location}`
                );
                item.iconPath = icon;
                
                // Add formatted size to description for quick view
                item.description = `${log.LogUser.Name} - ${log.Status} (${this.formatBytes(log.LogLength)}) @ ${startTime}`;
                return item;
            });

            // Update Cache: Prepend new items
            // Filter duplicates just in case (though query should prevent it)
            const existingIds = new Set(this.cachedLogs.map(i => i.contextValue)); // contextValue is not set to ID? 
            // LogItem(label, desc, id ...). VSCode TreeItem uses `id` property.
            // LogItem implementation passes `log.Id` as `id`.
            
            // Clean up old "No logs found" item if present
            if (this.cachedLogs.length === 1 && this.cachedLogs[0].label === 'No debug logs found') {
                this.cachedLogs = [];
            }
            
            this.cachedLogs.unshift(...newItems);
            
            // Update latest Time from the freshest log (first in newLogs, since ordered by desc)
            if (newLogs.length > 0) {
                 // log.StartTime is string ISO 8601 usually.
                 // Ensure valid Date comparison if needed?
                 // StartTime > '2023-...' works in SOQL.
                 // We should store the raw string from the record.
                 this.lastSuccessDate = newLogs[0].StartTime;
            }
            
            return this.cachedLogs;

        } catch (e: any) {
            outputChannel.appendLine(`Error in getChildren: ${e}`);
            return this.cachedLogs;
        } finally {
            this.isFetching = false;
        }
    }
    private formatBytes(bytes: number, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }
}
export const logTreeProvider = new LogTreeProvider();
export class LogItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public description: string | boolean | undefined, // Mutable
        public readonly logId: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command,
        public readonly tooltip?: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        this.tooltip = tooltip;
        this.contextValue = 'logItem';
    }
}
