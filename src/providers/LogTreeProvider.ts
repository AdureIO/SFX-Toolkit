import * as vscode from 'vscode';
import { outputChannel } from '../utils/outputChannel';
import { isSalesforceProject } from '../utils/projectUtils';
import { listApexLogs, fetchApexLogHead, extractCodeUnit, type ApexLogRow } from '../utils/apexLogApi';

/**
 * Sidebar Apex-log list. Sources logs straight from the org over REST (the same
 * apexLogApi the ASFX Workbench uses) — no local .sfdx/tools/debug/logs files, no
 * CLI download/polling, no on-disk cache. Entry-point names are enriched lazily by
 * reading just the head of each log (Range request) and parsing CODE_UNIT_STARTED,
 * mirroring the workbench's logic.
 */
export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<LogItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    /** Set by polling commands so the view can show polling state. */
    public isPolling = false;

    /** Cached current listing + resolved entry-point names (in-memory only). */
    private rows: ApexLogRow[] | null = null;
    private readonly units = new Map<string, string>();
    /** Bumped on each (re)list so stale background enrichment self-cancels. */
    private enrichGen = 0;

    clearCache(): void {
        this.refresh();
    }

    /** Re-list from the org on the next render. */
    refresh(): void {
        this.rows = null;
        this._onDidChangeTreeData.fire();
    }

    /** Kept for callers (refresh command / polling): just re-list over REST. */
    async fetchNewLogsFromOrg(): Promise<void> {
        this.refresh();
    }

    getTreeItem(element: LogItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: LogItem): Promise<LogItem[]> {
        if (element) return [];
        if (!isSalesforceProject()) {
            return [new LogItem('Open an SFDX project', '', '', vscode.TreeItemCollapsibleState.None)];
        }

        // Re-list only when invalidated; an enrichment refresh rebuilds from cache (no network).
        if (this.rows === null) {
            try {
                this.rows = await listApexLogs(null);
            } catch (e: any) {
                outputChannel.appendLine(`LogTreeProvider: listApexLogs failed: ${e?.message ?? e}`);
                this.rows = [];
            }
            void this.enrichUnits(this.rows, ++this.enrichGen);
        }

        if (!this.rows.length) {
            return [new LogItem('No debug logs', 'No Apex logs in this org (run code or enable a trace).', '', vscode.TreeItemCollapsibleState.None)];
        }

        return this.rows.map((r) => this.buildItem(r));
    }

    /** Fetch each log's head and parse its entry-point code unit, in the background. */
    private async enrichUnits(rows: ApexLogRow[], gen: number): Promise<void> {
        for (const r of rows) {
            if (gen !== this.enrichGen) return; // superseded by a newer list
            if (this.units.has(r.id)) continue;
            try {
                const unit = extractCodeUnit(await fetchApexLogHead(null, r.id));
                if (unit) {
                    this.units.set(r.id, unit);
                    if (gen === this.enrichGen) this._onDidChangeTreeData.fire();
                }
            } catch {
                /* ignore — keep the operation label */
            }
        }
    }

    private buildItem(r: ApexLogRow): LogItem {
        const label = this.units.get(r.id) || r.operation || r.id;
        const failed = !!r.status && r.status.toLowerCase() !== 'success';
        const description = `${this.formatBytes(r.length)} · ${this.formatRelativeTime(r.startTime)}`;
        const tooltip =
            `Operation: ${r.operation || '—'}\nStatus: ${r.status || '—'}\nUser: ${r.user || '—'}\n` +
            `Size: ${this.formatBytes(r.length)}\nStarted: ${r.startTime ? new Date(r.startTime).toLocaleString() : '—'}\n\nID: ${r.id}`;
        const item = new LogItem(label, description, r.id, vscode.TreeItemCollapsibleState.None, {
            command: 'adure-sfx-toolkit.openLog',
            title: 'Open Log',
            arguments: [r.id],
        }, tooltip);
        item.iconPath = failed
            ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'))
            : new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
        return item;
    }

    private formatBytes(bytes: number, decimals = 2): string {
        if (!+bytes) return '0 B';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    private formatRelativeTime(startTime: string): string {
        const t = startTime ? Date.parse(startTime) : NaN;
        if (Number.isNaN(t)) return '';
        const diff = Date.now() - t;
        const seconds = Math.floor(diff / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return new Date(t).toLocaleDateString();
    }
}

export const logTreeProvider = new LogTreeProvider();

export class LogItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public description: string | boolean | undefined,
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
