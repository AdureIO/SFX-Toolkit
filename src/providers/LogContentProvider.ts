import * as vscode from 'vscode';
import { Logger } from '../utils/outputChannel';
import { fetchApexLogBody } from '../utils/apexLogApi';

export class LogContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    // Map uri string -> log body (insertion order = age, oldest first)
    private logData = new Map<string, string>();
    private readonly maxCachedLogs = 10;

    // Emitter for content changes
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private getKey(uri: vscode.Uri): string {
        return uri.toString();
    }

    private parseLogId(uri: vscode.Uri): string | undefined {
        // Expected shape: sf-log://log/<logId>.log
        if (uri.scheme !== 'sf-log') return undefined;
        const authority = (uri.authority || '').toLowerCase();
        const logId = uri.path.replace(/^\/+/, '').replace(/\.log$/i, '');
        if (authority !== 'log' || !logId) return undefined;
        return logId;
    }

    /** Re-fetch a log body over REST when the in-memory copy is gone (e.g. after a window reload). */
    private async rehydrate(uri: vscode.Uri): Promise<boolean> {
        const key = this.getKey(uri);
        const logId = this.parseLogId(uri);
        if (!logId) return false;
        try {
            const content = await fetchApexLogBody(null, logId);
            if (!content) return false;
            this.logData.set(key, content);
            this.evictIfNeeded();
            Logger.info(`LogContentProvider: Rehydrated ${key} over REST`);
            return true;
        } catch (error) {
            Logger.warn(`LogContentProvider: Failed to rehydrate ${key}: ${error}`);
            return false;
        }
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const key = this.getKey(uri);
        let data = this.logData.get(key);
        if (data === undefined && (await this.rehydrate(uri))) {
            data = this.logData.get(key);
        }
        if (data === undefined) {
            Logger.warn(`LogContentProvider: No content found for ${key}`);
            return "Log content not found or cleared.";
        }
        return data;
    }

    public setContent(uri: vscode.Uri, content: string) {
        const key = this.getKey(uri);
        Logger.info(`LogContentProvider: Setting content for ${key}`);
        this.logData.delete(key); // re-insert as newest
        this.logData.set(key, content);
        this.evictIfNeeded();
        // Fire change if it existed
        this._onDidChange.fire(uri);
    }

    /** Remove cached content for a closed document to avoid unbounded memory growth. */
    public clearContent(uri: vscode.Uri): void {
        const key = this.getKey(uri);
        if (this.logData.delete(key)) {
            Logger.info(`LogContentProvider: Cleared content for ${key}`);
        }
    }

    /**
     * Keep at most maxCachedLogs bodies. Open documents are skipped (VS Code holds their text anyway and
     * clearContent drops them on close), so one open old log no longer blocks eviction of everything newer.
     */
    private evictIfNeeded(): void {
        if (this.logData.size <= this.maxCachedLogs) return;
        const open = new Set(vscode.workspace.textDocuments.map((doc) => doc.uri.toString()));
        for (const key of Array.from(this.logData.keys())) {
            if (this.logData.size <= this.maxCachedLogs) return;
            if (open.has(key)) continue;
            this.logData.delete(key);
        }
    }

    dispose(): void {
        this.logData.clear();
        this._onDidChange.dispose();
    }
}

export const logContentProvider = new LogContentProvider();
