import * as vscode from 'vscode';
import { loadSnippets, ApexSnippet } from '../commands/apexSnippets';
import { isSalesforceProject } from '../utils/projectUtils';

/** Tree item for one snippet in the Apex Snippets sidebar view. */
export class SnippetItem extends vscode.TreeItem {
    constructor(
        public readonly snippet: ApexSnippet,
        public readonly index: number,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(snippet.name, collapsibleState);
        this.description = snippet.description || undefined;
        this.tooltip = snippet.code.length > 200 ? snippet.code.substring(0, 197) + '...' : snippet.code;
        this.contextValue = index >= 0 ? 'snippetItem' : 'snippetPlaceholder';
        this.iconPath = new vscode.ThemeIcon(index >= 0 ? 'code' : 'info');
        if (index >= 0) {
            this.command = {
                command: 'adure-sfx-toolkit.editSnippet',
                title: 'Open Snippet',
                arguments: [snippet],
            };
        }
    }
}

export class SnippetTreeProvider implements vscode.TreeDataProvider<SnippetItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SnippetItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SnippetItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SnippetItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SnippetItem): Promise<SnippetItem[]> {
        if (element) return [];

        if (!isSalesforceProject()) {
            return [new SnippetItem(
                { name: 'Open an SFDX project', code: '' },
                -1
            )];
        }

        const snippets = await loadSnippets();
        if (!snippets.length) {
            return [new SnippetItem(
                { name: 'No snippets yet', code: '', description: 'Use Add Snippet or Open Snippets Folder to create one.' },
                -1
            )];
        }

        return snippets.map((s, i) => new SnippetItem(s, i));
    }
}
