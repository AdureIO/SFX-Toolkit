import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeAnonymousApex, getAnonymousApexOrgList } from '../commands/executeAnonymous';
import { isSalesforceProject } from '../utils/projectUtils';

const BUFFER_RELATIVE_PATH = '.vscode/anon-apex-buffer.apex';
const ASFX_DIR = '.sfdx/asfx';
const APEX_LAST_FILE = 'apex-last.txt';
const APEX_HISTORY_FILE = 'apex-history.json';
const APEX_HISTORY_MAX = 10;

export class AnonymousApexViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	private getBufferUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) return undefined;
		return vscode.Uri.joinPath(root, BUFFER_RELATIVE_PATH);
	}

	private async readBuffer(): Promise<string> {
		const uri = this.getBufferUri();
		if (!uri) return '';
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			return new TextDecoder().decode(bytes);
		} catch {
			return '';
		}
	}

	private async writeBuffer(content: string): Promise<void> {
		const uri = this.getBufferUri();
		if (!uri) return;
		try {
			const dir = vscode.Uri.joinPath(uri, '..');
			await vscode.workspace.fs.createDirectory(dir);
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		} catch (e) {
			// best-effort persist
		}
	}

	private getApexStorageDir(): string | null {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) return null;
		return path.join(root, ASFX_DIR);
	}

	private async loadApexState(): Promise<{ lastCode: string; history: string[] }> {
		let lastCode = '';
		const history: string[] = [];
		const dir = this.getApexStorageDir();
		if (dir) {
			try {
				const lastPath = path.join(dir, APEX_LAST_FILE);
				if (fs.existsSync(lastPath)) lastCode = fs.readFileSync(lastPath, 'utf8');
			} catch {
				// ignore
			}
			try {
				const histPath = path.join(dir, APEX_HISTORY_FILE);
				if (fs.existsSync(histPath)) {
					const raw = fs.readFileSync(histPath, 'utf8');
					const parsed = JSON.parse(raw);
					if (Array.isArray(parsed)) history.push(...parsed);
				}
			} catch {
				// ignore
			}
		}
		if (!lastCode.trim()) {
			lastCode = await this.readBuffer();
		}
		return { lastCode, history };
	}

	private async saveApexOnExecute(code: string): Promise<string[]> {
		const dir = this.getApexStorageDir();
		if (!dir) return [];
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const lastPath = path.join(dir, APEX_LAST_FILE);
			fs.writeFileSync(lastPath, code, 'utf8');
			let history: string[] = [];
			const histPath = path.join(dir, APEX_HISTORY_FILE);
			if (fs.existsSync(histPath)) {
				try {
					const raw = fs.readFileSync(histPath, 'utf8');
					history = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
				} catch {
					// ignore
				}
			}
			const trimmed = code.trim();
			if (trimmed) {
				history = [trimmed, ...history.filter((q) => q.trim() !== trimmed)].slice(0, APEX_HISTORY_MAX);
				fs.writeFileSync(histPath, JSON.stringify(history, null, 0), 'utf8');
			}
			return history;
		} catch {
			return [];
		}
	}

	private _showErrorInPanel(webviewView: vscode.WebviewView, message: string): void {
		if (webviewView?.webview) {
			webviewView.webview.postMessage({ type: 'showError', message });
		}
	}

	public async resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): Promise<void> {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		const { lastCode, history } = await this.loadApexState();
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, lastCode, history);

		webviewView.webview.onDidReceiveMessage(async (data: { type: string; code?: string; targetOrg?: string }) => {
			if (data.type === 'getOrgs') {
				const orgs = await getAnonymousApexOrgList();
				webviewView.webview.postMessage({ type: 'orgList', orgs });
			} else if (data.type === 'execute' && typeof data.code === 'string') {
				if (!isSalesforceProject()) {
					this._showErrorInPanel(webviewView, 'Open an SFDX project (folder containing sfdx-project.json) to use this feature.');
					return;
				}
				await this.writeBuffer(data.code);
				try {
					const result = await executeAnonymousApex(data.code, {
						fromPanel: true,
						targetOrg: data.targetOrg || undefined
					});
					if (result.success) {
						this._showErrorInPanel(webviewView, '');
						const newHistory = await this.saveApexOnExecute(data.code);
						webviewView.webview.postMessage({ type: 'historyUpdated', history: newHistory });
					} else {
						this._showErrorInPanel(webviewView, result.errorMessage);
					}
				} catch (e: any) {
					const message = e?.message || e?.stderr || String(e);
					this._showErrorInPanel(webviewView, message);
				}
			} else if (data.type === 'contentChanged' && typeof data.code === 'string') {
				await this.writeBuffer(data.code);
			}
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview, initialContent: string = '', history: string[] = []): string {
		const initialData = JSON.stringify({ lastCode: initialContent || '', history: Array.isArray(history) ? history : [] });
		const initialDataEscaped = initialData.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
	<title>Execute Apex</title>
	<style>
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 8px;
			font-family: var(--vscode-font-family, var(--vscode-editor-font-family, 'Segoe UI', sans-serif));
			font-size: var(--vscode-font-size, 13px);
			color: var(--vscode-foreground);
			background: var(--vscode-editor-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
		}
		.label {
			font-size: 11px;
			opacity: 0.9;
			margin-bottom: 4px;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 6px;
			flex-shrink: 0;
		}
		#org-select, #history-select {
			flex: 1;
			min-width: 0;
			padding: 4px 8px;
			font-size: 12px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 4px;
		}
		#apex-editor {
			flex: 1;
			min-height: 120px;
			width: 100%;
			padding: 8px;
			font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			resize: none;
			border: 1px solid var(--vscode-input-border, transparent);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 4px;
		}
		#apex-editor:focus {
			outline: 1px solid var(--vscode-focusBorder);
		}
		#apex-editor::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}
		#error-box {
			margin-top: 8px;
			padding: 8px;
			font-size: 12px;
			line-height: 1.4;
			white-space: pre-wrap;
			word-break: break-word;
			background: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
			color: var(--vscode-errorForeground);
			border-radius: 4px;
			display: none;
			flex-shrink: 0;
			max-height: 120px;
			overflow: auto;
		}
		#error-box.visible {
			display: block;
		}
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 8px;
			flex-shrink: 0;
		}
		button {
			padding: 6px 14px;
			font-size: 13px;
			border: none;
			border-radius: 4px;
			cursor: pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.secondary:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
	</style>
</head>
<body>
	<script type="application/json" id="apex-initial-data">${initialDataEscaped}</script>
	<div class="row">
		<span class="label" style="margin-bottom:0">History</span>
		<select id="history-select" title="Reopen a previous snippet">
			<option value="">History</option>
		</select>
	</div>
	<div class="row">
		<span class="label" style="margin-bottom:0">Target org</span>
		<select id="org-select" title="Org to execute against">
			<option value="">Loading...</option>
		</select>
	</div>
	<div class="label">Apex (anonymous execution)</div>
	<textarea id="apex-editor" placeholder="System.debug('Hello');&#10;Integer i = 1 + 1;"></textarea>
	<div id="error-box" class="" role="alert"></div>
	<div class="actions">
		<button id="execute-btn" title="Execute against default org">Execute</button>
		<button id="clear-btn" class="secondary">Clear</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const editor = document.getElementById('apex-editor');
		const errorBox = document.getElementById('error-box');
		const orgSelect = document.getElementById('org-select');
		const historySelect = document.getElementById('history-select');
		const initialEl = document.getElementById('apex-initial-data');
		if (initialEl && initialEl.textContent) {
			try {
				const data = JSON.parse(initialEl.textContent);
				if (data.lastCode != null) editor.value = data.lastCode;
				(data.history || []).forEach((q, i) => {
					const opt = document.createElement('option');
					opt.value = String(i);
					opt.textContent = (q.length > 50 ? q.slice(0, 47) + '...' : q).replace(/\\s+/g, ' ');
					opt.title = q;
					historySelect.appendChild(opt);
				});
			} catch (e) {}
		}
		function setHistoryDropdown(items) {
			while (historySelect.options.length > 1) historySelect.remove(1);
			(items || []).forEach((q, i) => {
				const opt = document.createElement('option');
				opt.value = String(i);
				opt.textContent = (q.length > 50 ? q.slice(0, 47) + '...' : q).replace(/\\s+/g, ' ');
				opt.title = q;
				historySelect.appendChild(opt);
			});
		}
		historySelect.addEventListener('change', () => {
			if (historySelect.value === '') return;
			const opt = historySelect.options[historySelect.selectedIndex];
			const code = opt ? opt.title : '';
			if (code) { editor.value = code; editor.focus(); }
			historySelect.selectedIndex = 0;
		});
		vscode.postMessage({ type: 'getOrgs' });
		window.addEventListener('message', (e) => {
			if (!e.data) return;
			if (e.data.type === 'showError') showError(e.data.message || '');
			if (e.data.type === 'orgList') {
				const orgs = e.data.orgs || [];
				orgSelect.innerHTML = orgs.length ? orgs.map(o => '<option value="' + (o.username || '').replace(/"/g, '&quot;') + '">' + (o.label || o.username || '').replace(/</g, '&lt;') + '</option>').join('') : '<option value="">No orgs</option>';
			}
			if (e.data.type === 'historyUpdated') setHistoryDropdown(e.data.history || []);
		});
		let saveTimeout = null;
		function scheduleSave() {
			if (saveTimeout) clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				vscode.postMessage({ type: 'contentChanged', code: editor.value });
				saveTimeout = null;
			}, 500);
		}
		function showError(msg) {
			errorBox.textContent = msg || '';
			errorBox.classList.toggle('visible', !!msg);
		}
		editor.addEventListener('input', scheduleSave);
		document.getElementById('execute-btn').onclick = () => {
			showError('');
			const targetOrg = (orgSelect.value || '').trim();
			vscode.postMessage({ type: 'execute', code: editor.value, targetOrg: targetOrg || undefined });
		};
		document.getElementById('clear-btn').onclick = () => {
			editor.value = '';
			editor.focus();
			showError('');
			vscode.postMessage({ type: 'contentChanged', code: '' });
		};
	</script>
</body>
</html>`;
	}
}
