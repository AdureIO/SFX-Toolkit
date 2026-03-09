import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeAnonymousApex } from './executeAnonymous';
import { Logger } from '../utils/outputChannel';

const SNIPPETS_FILE = '.vscode/apex-snippets.json';

export interface ApexSnippet {
    name: string;
    code: string;
    description?: string;
    targetOrg?: string;
}

function getSnippetsPath(): string | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    return path.join(root, SNIPPETS_FILE);
}

export async function loadSnippets(): Promise<ApexSnippet[]> {
    const filePath = getSnippetsPath();
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function saveSnippets(snippets: ApexSnippet[]): Promise<void> {
    const filePath = getSnippetsPath();
    if (!filePath) return;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(snippets, null, 2), 'utf8');
}

export async function addSnippet(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    let initialCode = '';
    if (editor && !editor.selection.isEmpty) {
        initialCode = editor.document.getText(editor.selection);
    }

    const name = await vscode.window.showInputBox({
        prompt: 'Snippet name',
        placeHolder: 'e.g. Reset Account Flags',
        validateInput: v => v.trim() ? null : 'Name is required',
    });
    if (!name) return;

    const code = await vscode.window.showInputBox({
        prompt: 'Apex code to execute',
        value: initialCode,
        placeHolder: "System.debug('Hello');",
        validateInput: v => v.trim() ? null : 'Code is required',
    });
    if (!code) return;

    const description = await vscode.window.showInputBox({
        prompt: 'Description (optional)',
        placeHolder: 'Resets all flag fields on test accounts',
    });

    const snippets = await loadSnippets();
    snippets.push({ name: name.trim(), code: code.trim(), description: description?.trim() || undefined });
    await saveSnippets(snippets);

    vscode.window.showInformationMessage(`Snippet "${name}" saved.`);
    vscode.commands.executeCommand('adure-sfx-toolkit.refreshSnippets');
}

export async function editSnippetFile(): Promise<void> {
    const filePath = getSnippetsPath();
    if (!filePath) return;
    if (!fs.existsSync(filePath)) {
        await saveSnippets([{
            name: 'Example Snippet',
            code: "System.debug('Hello from snippet!');",
            description: 'A simple debug snippet',
        }]);
    }
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
}

export async function runSnippet(snippet?: ApexSnippet | { code?: string; name?: string; targetOrg?: string }): Promise<void> {
    if (!snippet || !snippet.code) {
        const snippets = await loadSnippets();
        if (snippets.length === 0) {
            const action = await vscode.window.showInformationMessage(
                'No snippets configured. Create one?', 'Create Snippet', 'Open Snippets File'
            );
            if (action === 'Create Snippet') await addSnippet();
            else if (action === 'Open Snippets File') await editSnippetFile();
            return;
        }

        type SnippetPick = vscode.QuickPickItem & { snippet: ApexSnippet };
        const items: SnippetPick[] = snippets.map(s => ({
            label: `$(play) ${s.name}`,
            description: s.description || '',
            detail: s.code.length > 80 ? s.code.substring(0, 77) + '...' : s.code,
            snippet: s,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select snippet to execute',
        });
        if (!picked) return;
        snippet = picked.snippet;
    }

    const result = await executeAnonymousApex(snippet.code!, { fromPanel: false, targetOrg: snippet.targetOrg });
    if (!result.success) {
        Logger.error(`Snippet "${snippet.name || 'unnamed'}" failed`);
    }
}

export async function deleteSnippet(): Promise<void> {
    const snippets = await loadSnippets();
    if (snippets.length === 0) {
        vscode.window.showInformationMessage('No snippets to delete.');
        return;
    }

    const picked = await vscode.window.showQuickPick(
        snippets.map((s, i) => ({ label: s.name, description: s.description || '', index: i })),
        { placeHolder: 'Select snippet to delete' }
    );
    if (!picked) return;

    const confirm = await vscode.window.showWarningMessage(
        `Delete snippet "${picked.label}"?`, 'Delete', 'Cancel'
    );
    if (confirm !== 'Delete') return;

    snippets.splice((picked as any).index, 1);
    await saveSnippets(snippets);
    vscode.window.showInformationMessage(`Snippet "${picked.label}" deleted.`);
    vscode.commands.executeCommand('adure-sfx-toolkit.refreshSnippets');
}

export class SnippetTreeProvider implements vscode.TreeDataProvider<SnippetItem> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    refresh(): void { this._onDidChange.fire(); }

    getTreeItem(element: SnippetItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<SnippetItem[]> {
        const snippets = await loadSnippets();
        if (snippets.length === 0) {
            const item = new vscode.TreeItem('No snippets configured', vscode.TreeItemCollapsibleState.None);
            item.command = { command: 'adure-sfx-toolkit.editSnippetFile', title: 'Configure Snippets' };
            return [item as any];
        }
        return snippets.map(s => new SnippetItem(s));
    }
}

class SnippetItem extends vscode.TreeItem {
    constructor(public readonly snippet: ApexSnippet) {
        super(snippet.name, vscode.TreeItemCollapsibleState.None);
        this.description = snippet.description || '';
        this.tooltip = snippet.code;
        this.iconPath = new vscode.ThemeIcon('play');
        this.contextValue = 'snippetItem';
        this.command = {
            command: 'adure-sfx-toolkit.runSnippet',
            title: 'Run Snippet',
            arguments: [snippet],
        };
    }
}
