import * as vscode from 'vscode';
import {
    loadSnippets, ApexSnippet, onDidChangeSnippets, createSnippetsWatcher,
    getSnippetFilter, initSnippetFilterStore, pickSnippetFilter,
} from '../commands/apexSnippets';
import { isWorkspaceUsable } from '../utils/projectUtils';
import { onDidChangeProjects, projects } from '../utils/projectRegistry';
import { ALL_PROJECTS, filterSnippets } from '../utils/snippetsPure';
import { samePath } from '../utils/projectDiscoveryPure';

/** Tree item for one snippet in the Apex Snippets sidebar view. */
export class SnippetItem extends vscode.TreeItem {
    constructor(
        public readonly snippet: ApexSnippet,
        public readonly index: number,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(snippet.name, collapsibleState);
        this.description = snippet.description || undefined;
        const code = snippet.code.length > 200 ? snippet.code.substring(0, 197) + '...' : snippet.code;
        this.tooltip = snippet.projectName && snippet.description ? `${snippet.projectName}\n\n${code}` : code;
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

export class SnippetTreeProvider implements vscode.TreeDataProvider<SnippetItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<SnippetItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SnippetItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private readonly _disposables: vscode.Disposable[] = [];
    private _view?: vscode.TreeView<SnippetItem>;

    /** @param state workspaceState that persists the project filter (the view lists the snippets of all projects). */
    constructor(state?: vscode.Memento) {
        if (state) initSnippetFilterStore(state);
        // Add/delete from the overview panel, the palette, or on disk all land here.
        this._disposables.push(
            onDidChangeSnippets(() => this.refresh()),
            createSnippetsWatcher(),
            // Projects came or went: the badge / filter / watched folders change.
            onDidChangeProjects(() => this.refresh())
        );
    }

    /** Show the active filter next to the view title. */
    attachView(view: vscode.TreeView<SnippetItem>): void {
        this._view = view;
        this._updateDescription();
    }

    /** View-title command: choose "All projects" or one project. */
    async pickFilter(): Promise<void> {
        if (await pickSnippetFilter()) this.refresh();
    }

    private _updateDescription(): void {
        if (!this._view) return;
        const filter = getSnippetFilter();
        const p = filter === ALL_PROJECTS ? undefined : projects().find((x) => samePath(x.dir, filter));
        this._view.description = p ? p.name : undefined;
    }

    refresh(): void {
        this._updateDescription();
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this._disposables.forEach((d) => d.dispose());
        this._disposables.length = 0;
        this._onDidChangeTreeData.dispose();
    }

    getTreeItem(element: SnippetItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SnippetItem): Promise<SnippetItem[]> {
        if (element) return [];

        if (!isWorkspaceUsable()) {
            return [new SnippetItem(
                { name: 'Open an SFDX project', code: '' },
                -1
            )];
        }

        const snippets = filterSnippets(await loadSnippets(), getSnippetFilter());
        if (!snippets.length) {
            return [new SnippetItem(
                { name: 'No snippets yet', code: '', description: 'Use Add Snippet or Open Snippets Folder to create one.' },
                -1
            )];
        }

        return snippets.map((s, i) => new SnippetItem(s, i));
    }
}
