import * as vscode from 'vscode';
import {
    loadSnippets,
    runSnippet,
    addSnippet,
    editSnippetFile,
    deleteSnippetByIndex,
    openSnippetEditor,
    ApexSnippet,
} from '../commands/apexSnippets';

export class ApexSnippetsPanelProvider {
    public static readonly viewType = 'adure-sfx-toolkit.snippetsPanel';
    private static _panel: vscode.WebviewPanel | undefined;

    public static async show(): Promise<void> {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        if (ApexSnippetsPanelProvider._panel) {
            ApexSnippetsPanelProvider._panel.reveal(column);
            await this.refreshPanel();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ApexSnippetsPanelProvider.viewType,
            'Apex Snippets Overview',
            column,
            { enableScripts: true }
        );

        ApexSnippetsPanelProvider._panel = panel;
        panel.webview.html = this.getHtml([]);

        panel.webview.onDidReceiveMessage(
            async (msg: { command: string; index?: number }) => {
                switch (msg.command) {
                    case 'run':
                        if (typeof msg.index === 'number') {
                            const snippets = await loadSnippets();
                            if (snippets[msg.index]) await runSnippet(snippets[msg.index]);
                        }
                        break;
                    case 'delete':
                        if (typeof msg.index === 'number') {
                            const ok = await deleteSnippetByIndex(msg.index);
                            if (ok) await this.refreshPanel();
                        }
                        break;
                    case 'add':
                        await addSnippet();
                        await this.refreshPanel();
                        break;
                    case 'refresh':
                        await this.refreshPanel();
                        break;
                    case 'openFile':
                        await editSnippetFile();
                        await this.refreshPanel();
                        break;
                    case 'edit':
                        if (typeof msg.index === 'number') {
                            const snippets = await loadSnippets();
                            if (snippets[msg.index]) await openSnippetEditor(snippets[msg.index]);
                        }
                        break;
                }
            },
            null,
            []
        );

        panel.onDidDispose(() => {
            ApexSnippetsPanelProvider._panel = undefined;
        });

        await this.refreshPanel();
    }

    public static async refreshPanel(): Promise<void> {
        const panel = ApexSnippetsPanelProvider._panel;
        if (!panel) return;
        const snippets = await loadSnippets();
        panel.webview.postMessage({ command: 'setSnippets', snippets });
    }

    private static getHtml(_snippets: ApexSnippet[]): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, system-ui, sans-serif);
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
        }
        h2 {
            margin: 0 0 12px 0;
            font-weight: 600;
        }
        .toolbar {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        button {
            padding: 6px 12px;
            font-size: 12px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
        }
        button:hover { opacity: 0.9; }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .snippet-list { margin: 0; padding: 0; list-style: none; }
        .snippet-item {
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 10px;
            background: var(--vscode-editor-inactiveSelectionBackground);
        }
        .snippet-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 6px;
        }
        .snippet-name { font-weight: 600; font-size: 14px; }
        .snippet-desc {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 8px;
        }
        .snippet-code {
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-focusBorder);
            padding: 8px 10px;
            margin: 8px 0;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .snippet-actions { display: flex; gap: 8px; }
        .empty { color: var(--vscode-descriptionForeground); padding: 24px; text-align: center; }
    </style>
</head>
<body>
    <h2>Apex Snippets</h2>
    <div class="toolbar">
        <button id="btn-add">Add Snippet</button>
        <button id="btn-file" class="secondary">Open Snippets Folder</button>
        <button id="btn-refresh" class="secondary">Refresh</button>
    </div>
    <ul class="snippet-list" id="list"></ul>
    <script>
        const vscode = acquireVsCodeApi();
        const listEl = document.getElementById('list');
        const btnAdd = document.getElementById('btn-add');
        const btnFile = document.getElementById('btn-file');
        const btnRefresh = document.getElementById('btn-refresh');

        function render(snippets) {
            if (!snippets || snippets.length === 0) {
                listEl.innerHTML = '<li class="empty">No snippets yet. Click Add Snippet or Open Snippets Folder to create one.</li>';
                return;
            }
            listEl.innerHTML = snippets.map((s, i) => {
                const codePreview = s.code.length > 200 ? s.code.substring(0, 197) + '...' : s.code;
                const esc = (t) => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                return '<li class="snippet-item">' +
                    '<div class="snippet-header">' +
                    '<span class="snippet-name">' + esc(s.name) + '</span>' +
                    '<div class="snippet-actions">' +
                    '<button data-action="run" data-index="' + i + '">Run</button>' +
                    '<button data-action="edit" data-index="' + i + '" class="secondary">Edit</button>' +
                    '<button data-action="delete" data-index="' + i + '" class="secondary">Delete</button>' +
                    '</div></div>' +
                    (s.description ? '<div class="snippet-desc">' + esc(s.description) + '</div>' : '') +
                    '<pre class="snippet-code">' + esc(codePreview) + '</pre>' +
                    '</li>';
            }).join('');
            listEl.querySelectorAll('[data-action]').forEach(el => {
                el.addEventListener('click', () => {
                    const cmd = el.getAttribute('data-action');
                    const idx = el.getAttribute('data-index');
                    vscode.postMessage({ command: cmd, index: idx !== null ? parseInt(idx, 10) : undefined });
                });
            });
        }

        window.addEventListener('message', e => {
            if (e.data && e.data.command === 'setSnippets') render(e.data.snippets);
        });

        btnAdd.addEventListener('click', () => vscode.postMessage({ command: 'add' }));
        btnFile.addEventListener('click', () => vscode.postMessage({ command: 'openFile' }));
        btnRefresh.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    </script>
</body>
</html>`;
    }
}
