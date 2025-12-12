import * as vscode from 'vscode';
import { Logger } from '../utils/outputChannel';

// Filter Modes
export type FilterType = 'DEBUG' | 'SOQL';

export class LogContentProvider implements vscode.TextDocumentContentProvider {
    // Map uri string -> { original: string, activeFilters: Set<FilterType> }
    private logData = new Map<string, { original: string, activeFilters: Set<FilterType> }>();
    
    // Emitter for content changes
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private getKey(uri: vscode.Uri): string {
        return uri.toString();
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        const key = this.getKey(uri);
        const data = this.logData.get(key);
        if (!data) {
            Logger.warn(`LogContentProvider: No content found for ${key}`);
            return "Log content not found or cleared.";
        }
        
        // If no filters are active, return original (Show All)
        if (data.activeFilters.size === 0) {
            return data.original;
        }
        
        // Otherwise, union of active filters
        return this.getFilteredContent(data.original, data.activeFilters);
    }
    
    public setContent(uri: vscode.Uri, content: string) {
        const key = this.getKey(uri);
        Logger.info(`LogContentProvider: Setting content for ${key}`);
        this.logData.set(key, { original: content, activeFilters: new Set() });
        // Fire change if it existed
        this._onDidChange.fire(uri);
    }
    
    public toggleFilter(uri: vscode.Uri, type: FilterType) {
        const key = this.getKey(uri);
        const data = this.logData.get(key);
        
        if (!data) {
            Logger.error(`LogContentProvider: Failed to toggle filter ${type} for ${key} - Content not found`);
            return;
        }
        
        if (data.activeFilters.has(type)) {
            Logger.info(`LogContentProvider: Removing filter ${type} for ${key}`);
            data.activeFilters.delete(type);
        } else {
            Logger.info(`LogContentProvider: Adding filter ${type} for ${key}`);
            data.activeFilters.add(type);
        }
        
        this.logData.set(key, data);
        this._onDidChange.fire(uri); 
    }
    
    // Check if a specific filter is active
    public isFilterActive(uri: vscode.Uri, type: FilterType): boolean {
        const key = this.getKey(uri);
        return this.logData.get(key)?.activeFilters.has(type) || false;
    }

    private getFilteredContent(original: string, filters: Set<FilterType>): string {
        const lines = original.split('\n');
        
        let keepNext = false;
        // Simplified regex: Matches Line starting with Timestamp HH:MM:SS
        const eventStartRegex = /^\d{2}:\d{2}:\d{2}\./;

        return lines.filter(line => {
            const isEventStart = eventStartRegex.test(line);

            if (isEventStart) {
                // Determine if this new event matches any filter
                let matches = false;
                
                if (filters.has('DEBUG')) {
                    if (line.includes('|USER_DEBUG|') || line.includes('FATAL_ERROR') || line.includes('EXCEPTION_THROWN') || line.includes('|ERROR|')) matches = true;
                }
                if (!matches && filters.has('SOQL')) {
                    // Combine SOQL and DML
                    if (line.includes('|SOQL_EXECUTE') || line.includes('|DML_')) matches = true;
                }
                
                keepNext = matches;
                return matches;
            } else {
                // Continuation line (e.g. JSON body, stack trace)
                // Keep it if the previous event was kept
                return keepNext;
            }
        }).join('\n');
    }
}

export const logContentProvider = new LogContentProvider();
