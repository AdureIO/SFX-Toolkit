import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeAnonymousApex, getAnonymousApexOrgList } from '../commands/executeAnonymous';
import { isSalesforceProject } from '../utils/projectUtils';
import { ApexCompletionProvider } from './ApexCompletionProvider';

const BUFFER_RELATIVE_PATH = '.vscode/anon-apex-buffer.apex';
const ASFX_DIR = '.sfdx/asfx';
const APEX_LAST_FILE = 'apex-last.txt';
const APEX_HISTORY_FILE = 'apex-history.json';
const APEX_HISTORY_MAX = 10;

export class AnonymousApexViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _messageListener?: vscode.Disposable;

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

		if (this._messageListener) {
			this._messageListener.dispose();
		}
		this._messageListener = webviewView.webview.onDidReceiveMessage(async (data: { type: string; code?: string; targetOrg?: string; textUpToCursor?: string; surroundingText?: string }) => {
			if (data.type === 'getOrgs') {
				const orgs = await getAnonymousApexOrgList();
				webviewView.webview.postMessage({ type: 'orgList', orgs });
			} else if (data.type === 'getCompletions') {
				try {
					const org = (data.targetOrg && data.targetOrg.trim()) ? data.targetOrg.trim() : null;
					const items = await ApexCompletionProvider.getItems(
						data.textUpToCursor || '',
						data.surroundingText || '',
						org
					);
					webviewView.webview.postMessage({ type: 'completionResult', items });
				} catch {
					webviewView.webview.postMessage({ type: 'completionResult', items: [] });
				}
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
			} else if (data.type === 'openInEditor') {
				const bufferUri = this.getBufferUri();
				if (bufferUri) {
					await this.writeBuffer(data.code || (await this.readBuffer()));
					try {
						const doc = await vscode.workspace.openTextDocument(bufferUri);
						await vscode.window.showTextDocument(doc, { preview: false });
					} catch {
						await vscode.commands.executeCommand('vscode.open', bufferUri);
					}
				}
			} else if (data.type === 'contentChanged' && typeof data.code === 'string') {
				await this.writeBuffer(data.code);
			}
		});

		webviewView.onDidDispose(() => {
			if (this._messageListener) {
				this._messageListener.dispose();
				this._messageListener = undefined;
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
		.editor-wrap {
			flex: 1;
			min-height: 120px;
			position: relative;
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 4px;
			overflow: hidden;
		}
		.editor-wrap:focus-within {
			outline: 1px solid var(--vscode-focusBorder);
		}
		#highlight-layer {
			position: absolute;
			top: 0; left: 0; right: 0; bottom: 0;
			padding: 8px;
			font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			white-space: pre-wrap;
			word-wrap: break-word;
			overflow: auto;
			pointer-events: none;
			color: transparent;
			background: var(--vscode-input-background);
		}
		#apex-editor {
			position: relative;
			width: 100%;
			height: 100%;
			padding: 8px;
			font-family: var(--vscode-editor-font-family, 'Consolas', 'Monaco', monospace);
			font-size: var(--vscode-editor-font-size, 13px);
			line-height: 1.5;
			resize: none;
			border: none;
			background: transparent;
			color: var(--vscode-input-foreground);
			caret-color: var(--vscode-editorCursor-foreground, var(--vscode-input-foreground));
			z-index: 1;
		}
		#apex-editor:focus { outline: none; }
		#apex-editor::placeholder { color: var(--vscode-input-placeholderForeground); }
		.hl-kw { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
		.hl-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
		.hl-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
		.hl-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
		.hl-cmt { color: var(--vscode-symbolIcon-enumeratorForeground, #6a9955); font-style: italic; }
		.hl-ann { color: var(--vscode-symbolIcon-interfaceForeground, #dcdcaa); }
		.hl-method { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
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
		#error-box.visible { display: block; }
		.actions {
			display: flex;
			gap: 8px;
			margin-top: 8px;
			flex-shrink: 0;
			flex-wrap: wrap;
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
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.shortcut-hint { font-size: 10px; opacity: 0.6; margin-left: 4px; }
		#completion-dropdown {
			position: absolute;
			z-index: 200;
			background: var(--vscode-editorSuggestWidget-background, var(--vscode-editor-background));
			border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-editorGroup-border));
			border-radius: 3px;
			box-shadow: 0 4px 14px rgba(0,0,0,0.35);
			max-height: 210px;
			overflow-y: auto;
			min-width: 220px;
			max-width: 420px;
			display: none;
		}
		#completion-dropdown.visible { display: block; }
		.ci {
			padding: 3px 10px;
			cursor: pointer;
			font-size: 12px;
			font-family: var(--vscode-editor-font-family, monospace);
			display: flex;
			align-items: baseline;
			gap: 6px;
			white-space: nowrap;
		}
		.ci.sel, .ci:hover {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}
		.ci-kind { font-size: 10px; opacity: 0.55; min-width: 22px; }
		.ci-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
		.ci-detail { font-size: 10px; opacity: 0.55; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
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
	<div class="editor-wrap">
		<div id="highlight-layer" aria-hidden="true"></div>
		<textarea id="apex-editor" placeholder="System.debug('Hello');&#10;Integer i = 1 + 1;" spellcheck="false"></textarea>
		<div id="completion-dropdown"></div>
	</div>
	<div id="error-box" class="" role="alert"></div>
	<div class="actions">
		<button id="execute-btn" title="Execute (Ctrl+Enter)">Execute<span class="shortcut-hint">Ctrl+Enter</span></button>
		<button id="open-editor-btn" class="secondary" title="Open in VS Code editor for full Apex language support">Open in Editor</button>
		<button id="clear-btn" class="secondary">Clear</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const editor = document.getElementById('apex-editor');
		const highlightLayer = document.getElementById('highlight-layer');
		const errorBox = document.getElementById('error-box');
		const orgSelect = document.getElementById('org-select');
		const historySelect = document.getElementById('history-select');
		const initialEl = document.getElementById('apex-initial-data');

		const APEX_KEYWORDS = /\\b(abstract|after|before|break|catch|class|continue|delete|do|else|enum|extends|final|finally|for|get|global|if|implements|import|in|insert|instanceof|interface|merge|new|null|on|override|private|protected|public|return|set|static|super|switch|testmethod|this|throw|transient|trigger|try|undelete|update|upsert|virtual|void|webservice|when|while|with|without|sharing)\\b/g;
		const APEX_TYPES = /\\b(Boolean|Date|Datetime|Decimal|Double|Id|Integer|Long|Object|String|Blob|List|Map|Set|Account|Contact|Lead|Opportunity|Case|Task|System|Database|Test|Assert|UserInfo|Schema|Limits|ApexPages|Messaging)\\b/g;
		const APEX_ANNOTATIONS = /@\\w+/g;

		function escapeHtml(s) {
			return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
		}

		function highlightApex(code) {
			let html = '';
			let i = 0;
			while (i < code.length) {
				if (code[i] === '/' && code[i+1] === '/') {
					const end = code.indexOf('\\n', i);
					const slice = end === -1 ? code.slice(i) : code.slice(i, end);
					html += '<span class="hl-cmt">' + escapeHtml(slice) + '</span>';
					i += slice.length;
				} else if (code[i] === '/' && code[i+1] === '*') {
					const end = code.indexOf('*/', i + 2);
					const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
					html += '<span class="hl-cmt">' + escapeHtml(slice) + '</span>';
					i += slice.length;
				} else if (code[i] === "'" ) {
					let j = i + 1;
					while (j < code.length && code[j] !== "'" && code[j] !== '\\n') {
						if (code[j] === '\\\\') j++;
						j++;
					}
					if (j < code.length && code[j] === "'") j++;
					html += '<span class="hl-str">' + escapeHtml(code.slice(i, j)) + '</span>';
					i = j;
				} else if (code[i] === '@' && /[a-zA-Z]/.test(code[i+1] || '')) {
					const m = code.slice(i).match(/^@\\w+/);
					if (m) {
						html += '<span class="hl-ann">' + escapeHtml(m[0]) + '</span>';
						i += m[0].length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else if (/[a-zA-Z_]/.test(code[i])) {
					const m = code.slice(i).match(/^[a-zA-Z_]\\w*/);
					if (m) {
						const word = m[0];
						const nextChar = code[i + word.length];
						if (APEX_KEYWORDS.test(word)) {
							APEX_KEYWORDS.lastIndex = 0;
							html += '<span class="hl-kw">' + escapeHtml(word) + '</span>';
						} else if (APEX_TYPES.test(word)) {
							APEX_TYPES.lastIndex = 0;
							html += '<span class="hl-type">' + escapeHtml(word) + '</span>';
						} else if (nextChar === '(') {
							html += '<span class="hl-method">' + escapeHtml(word) + '</span>';
						} else {
							html += escapeHtml(word);
						}
						i += word.length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else if (/[0-9]/.test(code[i])) {
					const m = code.slice(i).match(/^[0-9]+(\\.[0-9]+)?/);
					if (m) {
						html += '<span class="hl-num">' + escapeHtml(m[0]) + '</span>';
						i += m[0].length;
					} else {
						html += escapeHtml(code[i]);
						i++;
					}
				} else {
					html += escapeHtml(code[i]);
					i++;
				}
			}
			return html + '\\n';
		}

		function syncHighlight() {
			highlightLayer.innerHTML = highlightApex(editor.value);
		}

		editor.addEventListener('scroll', () => {
			highlightLayer.scrollTop = editor.scrollTop;
			highlightLayer.scrollLeft = editor.scrollLeft;
		});
		setTimeout(syncHighlight, 0);
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
			if (code) { editor.value = code; editor.focus(); syncHighlight(); }
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
			if (e.data.type === 'completionResult') renderDropdown(e.data.items || []);
		});

		// ─── Completion dropdown ──────────────────────────────────────────────
		const dropdown = document.getElementById('completion-dropdown');
		let _completionItems = [];
		let _selIdx = -1;

		const KIND_LABEL = { 0:'txt', 1:'mtd', 4:'fld', 5:'var', 6:'cls', 13:'kwd' };

		function getCaretCoords() {
			const mirror = document.createElement('div');
			const cs = window.getComputedStyle(editor);
			['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
			 'paddingTop','paddingRight','paddingBottom','paddingLeft',
			 'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
			 'boxSizing','whiteSpace','wordWrap','width'].forEach(p => { mirror.style[p] = cs[p]; });
			mirror.style.cssText += ';position:absolute;visibility:hidden;height:auto;overflow:hidden;';
			mirror.style.whiteSpace = 'pre-wrap';
			mirror.style.wordWrap = 'break-word';
			const textBefore = editor.value.substring(0, editor.selectionStart);
			mirror.textContent = textBefore;
			const span = document.createElement('span');
			span.textContent = '\\u200b';
			mirror.appendChild(span);
			editor.parentElement.appendChild(mirror);
			const sr = span.getBoundingClientRect();
			const er = editor.getBoundingClientRect();
			editor.parentElement.removeChild(mirror);
			return { x: sr.left - er.left + editor.scrollLeft, y: sr.bottom - er.top + editor.scrollTop };
		}

		function renderDropdown(items) {
			_completionItems = items;
			_selIdx = items.length > 0 ? 0 : -1;
			if (items.length === 0) { hideDropdown(); return; }
			dropdown.innerHTML = '';
			items.slice(0, 60).forEach((item, i) => {
				const el = document.createElement('div');
				el.className = 'ci' + (i === 0 ? ' sel' : '');
				el.dataset.i = String(i);
				const k = document.createElement('span'); k.className = 'ci-kind'; k.textContent = KIND_LABEL[item.kind] || '·';
				const l = document.createElement('span'); l.className = 'ci-label'; l.textContent = item.label;
				el.appendChild(k); el.appendChild(l);
				if (item.detail) { const d = document.createElement('span'); d.className = 'ci-detail'; d.textContent = item.detail; el.appendChild(d); }
				el.addEventListener('mousedown', ev => { ev.preventDefault(); applyCompletion(i); });
				dropdown.appendChild(el);
			});
			const coords = getCaretCoords();
			const dropH = 214;
			let top = coords.y + 2;
			if (top + dropH > editor.offsetHeight) top = coords.y - dropH - 2;
			dropdown.style.left = Math.min(coords.x, Math.max(0, editor.offsetWidth - 240)) + 'px';
			dropdown.style.top = Math.max(0, top) + 'px';
			dropdown.classList.add('visible');
		}

		function hideDropdown() {
			dropdown.classList.remove('visible');
			_completionItems = [];
			_selIdx = -1;
		}

		function moveSelection(delta) {
			if (_completionItems.length === 0) return;
			_selIdx = (_selIdx + delta + _completionItems.length) % _completionItems.length;
			dropdown.querySelectorAll('.ci').forEach((el, i) => el.classList.toggle('sel', i === _selIdx));
			const sel = dropdown.querySelector('.ci.sel');
			if (sel) sel.scrollIntoView({ block: 'nearest' });
		}

		function applyCompletion(idx) {
			if (idx < 0 || idx >= _completionItems.length) return;
			const insertText = _completionItems[idx].insertText || _completionItems[idx].label;
			const pos = editor.selectionStart;
			const text = editor.value;
			let wordStart = pos;
			while (wordStart > 0 && /\\w/.test(text[wordStart - 1])) wordStart--;
			editor.value = text.substring(0, wordStart) + insertText + text.substring(pos);
			editor.selectionStart = editor.selectionEnd = wordStart + insertText.length;
			editor.focus();
			syncHighlight();
			scheduleSave();
			hideDropdown();
		}

		function requestCompletions(autoTrigger) {
			const pos = editor.selectionStart;
			const text = editor.value;
			const lineStart = text.lastIndexOf('\\n', pos - 1) + 1;
			const textUpToCursor = text.substring(lineStart, pos);
			if (autoTrigger && !textUpToCursor.endsWith('.')) {
				const m = textUpToCursor.match(/(\\w+)$/);
				if (!m || m[1].length < 2) { hideDropdown(); return; }
			}
			const lines = text.split('\\n');
			const curLine = text.substring(0, pos).split('\\n').length - 1;
			const s = Math.max(0, curLine - 4), en = Math.min(lines.length - 1, curLine + 4);
			const surroundingText = lines.slice(s, en + 1).join('\\n');
			vscode.postMessage({ type: 'getCompletions', textUpToCursor, surroundingText, targetOrg: orgSelect.value || undefined });
		}

		// Close dropdown when clicking outside
		document.addEventListener('mousedown', e => { if (!dropdown.contains(e.target) && e.target !== editor) hideDropdown(); });
		let _hlRaf;
		function scheduleHighlight() {
			if (_hlRaf) cancelAnimationFrame(_hlRaf);
			_hlRaf = requestAnimationFrame(() => { _hlRaf = null; syncHighlight(); });
		}
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
		editor.addEventListener('input', () => { scheduleSave(); scheduleHighlight(); });

		function doExecute() {
			showError('');
			const targetOrg = (orgSelect.value || '').trim();
			vscode.postMessage({ type: 'execute', code: editor.value, targetOrg: targetOrg || undefined });
		}

		document.getElementById('execute-btn').onclick = doExecute;

		editor.addEventListener('keydown', (e) => {
			// Completion dropdown navigation
			if (dropdown.classList.contains('visible')) {
				if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return; }
				if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-1); return; }
				if (e.key === 'Escape')    { e.preventDefault(); hideDropdown(); return; }
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					applyCompletion(_selIdx);
					return;
				}
			}
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				doExecute();
				return;
			}
			if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
				e.preventDefault();
				requestCompletions(false);
				return;
			}
			if (e.key === 'Tab' && !dropdown.classList.contains('visible')) {
				e.preventDefault();
				const start = editor.selectionStart;
				const end = editor.selectionEnd;
				editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
				editor.selectionStart = editor.selectionEnd = start + 4;
				syncHighlight();
				scheduleSave();
			}
		});

		editor.addEventListener('input', () => {
			// Auto-trigger on dot or when continuing to type a word
			const pos = editor.selectionStart;
			const ch = editor.value[pos - 1];
			if (ch === '.') {
				requestCompletions(false);
			} else {
				requestCompletions(true);
			}
		});

		document.getElementById('open-editor-btn').onclick = () => {
			vscode.postMessage({ type: 'openInEditor' });
		};

		document.getElementById('clear-btn').onclick = () => {
			editor.value = '';
			editor.focus();
			showError('');
			syncHighlight();
			vscode.postMessage({ type: 'contentChanged', code: '' });
		};
	</script>
</body>
</html>`;
	}
}
