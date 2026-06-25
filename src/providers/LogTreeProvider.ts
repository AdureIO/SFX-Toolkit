import * as vscode from 'vscode';
import { isSalesforceProject } from '../utils/projectUtils';
import { type ApexLogRow } from '../utils/apexLogApi';
import { LiveLogService, type LogSnapshot } from '../utils/liveLogService';

/**
 * Sidebar Apex-log list. Backed by the shared LiveLogService (the same source the
 * ASFX Workbench Logs tab uses) — REST only, no local files. The list is event-driven
 * and goes live automatically while a debug trace is active. The provider just renders
 * the latest snapshot the service pushes for the default org.
 */
export class LogTreeProvider implements vscode.TreeDataProvider<LogItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<LogItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private snapshot: LogSnapshot = { rows: [], units: {}, live: false };
    private sub?: vscode.Disposable;

    /**
     * Subscribe/unsubscribe to the live service based on view visibility, so we only
     * discover (and live-poll) while the Logs view is actually shown.
     */
    setActive(active: boolean): void {
        if (active && !this.sub) {
            this.sub = LiveLogService.subscribe(null, (snap) => {
                this.snapshot = snap;
                this._onDidChangeTreeData.fire();
            });
        } else if (!active && this.sub) {
            this.sub.dispose();
            this.sub = undefined;
        }
    }

    clearCache(): void {
        this.refresh();
    }

    /** Force an immediate re-list (event-driven trigger). */
    refresh(): void {
        void LiveLogService.refresh(null);
    }

    /** Kept for callers (refresh command): re-list now. */
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
        const rows = this.snapshot.rows;
        if (!rows.length) {
            return [new LogItem('No debug logs', 'No Apex logs in this org (run code or enable a trace).', '', vscode.TreeItemCollapsibleState.None)];
        }
        return rows.map((r) => this.buildItem(r));
    }

    private buildItem(r: ApexLogRow): LogItem {
        const label = this.snapshot.units[r.id] || r.operation || r.id;
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
