import * as vscode from 'vscode';

// Filter Modes
export type FilterType = 'DEBUG' | 'SOQL' | 'DML';

export class LogContentProvider implements vscode.TextDocumentContentProvider {
    // Map uri string -> { original: string, activeFilters: Set<FilterType> }
    private logData = new Map<string, { original: string, activeFilters: Set<FilterType> }>();
    
    // Emitter for content changes
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        const data = this.logData.get(uri.toString());
        if (!data) {
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
        this.logData.set(uri.toString(), { original: content, activeFilters: new Set() });
        // Fire change if it existed
        this._onDidChange.fire(uri);
    }
    
    public toggleFilter(uri: vscode.Uri, type: FilterType) {
        const data = this.logData.get(uri.toString());
        if (!data) return;
        
        if (data.activeFilters.has(type)) {
            data.activeFilters.delete(type);
        } else {
            data.activeFilters.add(type);
        }
        
        this.logData.set(uri.toString(), data);
        this._onDidChange.fire(uri); 
    }
    
    // Check if a specific filter is active
    public isFilterActive(uri: vscode.Uri, type: FilterType): boolean {
        return this.logData.get(uri.toString())?.activeFilters.has(type) || false;
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
                    if (line.includes('|SOQL_EXECUTE')) matches = true;
                }
                if (!matches && filters.has('DML')) {
                    if (line.includes('|DML_')) matches = true;
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
