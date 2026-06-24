import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeAnonymousForPanel, getAnonymousApexOrgList } from '../commands/executeAnonymous';
import { openLogById } from '../commands/listLogs';
import { isSalesforceProject } from '../utils/projectUtils';

const BUFFER_RELATIVE_PATH = '.vscode/anon-apex-buffer.apex';
const ASFX_DIR = '.sfdx/asfx';
const APEX_LAST_FILE = 'apex-last.txt';
const APEX_HISTORY_FILE = 'apex-history.json';
const APEX_HISTORY_MAX = 10;

/**
 * The Execute Apex panel — a real Monaco editor (Apex syntax + the extension's
 * org-aware IntelliSense) for anonymous Apex, with a results/error pane, org
 * selector and history. Completion is bridged to the editor's real providers
 * (our language server + the Salesforce Apex extension) via
 * `vscode.executeCompletionItemProvider` on the persisted `.apex` buffer.
 */
export class AnonymousApexViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _messageListener?: vscode.Disposable;
	private _bufferDoc?: vscode.TextDocument;

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
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return '';
		}
	}

	private async writeBuffer(content: string): Promise<void> {
		const uri = this.getBufferUri();
		if (!uri) return;
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		} catch {
			/* best-effort persist */
		}
	}

	private getApexStorageDir(): string | null {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return root ? path.join(root, ASFX_DIR) : null;
	}

	private async loadApexState(): Promise<{ lastCode: string; history: string[] }> {
		let lastCode = '';
		const history: string[] = [];
		const dir = this.getApexStorageDir();
		if (dir) {
			try {
				const lastPath = path.join(dir, APEX_LAST_FILE);
				if (fs.existsSync(lastPath)) lastCode = fs.readFileSync(lastPath, 'utf8');
			} catch { /* ignore */ }
			try {
				const histPath = path.join(dir, APEX_HISTORY_FILE);
				if (fs.existsSync(histPath)) {
					const parsed = JSON.parse(fs.readFileSync(histPath, 'utf8'));
					if (Array.isArray(parsed)) history.push(...parsed);
				}
			} catch { /* ignore */ }
		}
		if (!lastCode.trim()) lastCode = await this.readBuffer();
		return { lastCode, history };
	}

	/** Persist the current editor content as the restored-on-reload snapshot. */
	private saveLastCode(code: string): void {
		const dir = this.getApexStorageDir();
		if (!dir) return;
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, APEX_LAST_FILE), code, 'utf8');
		} catch { /* best-effort persist */ }
	}

	private async saveApexOnExecute(code: string): Promise<string[]> {
		const dir = this.getApexStorageDir();
		if (!dir) return [];
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, APEX_LAST_FILE), code, 'utf8');
			let history: string[] = [];
			const histPath = path.join(dir, APEX_HISTORY_FILE);
			if (fs.existsSync(histPath)) {
				try {
					const parsed = JSON.parse(fs.readFileSync(histPath, 'utf8'));
					history = Array.isArray(parsed) ? parsed : [];
				} catch { /* ignore */ }
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

	/** Keep the persisted buffer document open & in sync so completion providers see current text. */
	private async syncBufferDoc(text: string): Promise<vscode.TextDocument | undefined> {
		const uri = this.getBufferUri();
		if (!uri) return undefined;
		if (!this._bufferDoc || this._bufferDoc.isClosed) {
			try {
				await this.writeBuffer(this._bufferDoc ? text : await this.readBuffer());
				this._bufferDoc = await vscode.workspace.openTextDocument(uri);
			} catch {
				return undefined;
			}
		}
		const doc = this._bufferDoc;
		if (doc.getText() !== text) {
			const edit = new vscode.WorkspaceEdit();
			const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			edit.replace(uri, full, text);
			try {
				await vscode.workspace.applyEdit(edit);
			} catch {
				/* ignore */
			}
		}
		return doc;
	}

	/** The identifier prefix immediately before the cursor (for client-side filtering). */
	private static prefixAt(text: string, line: number, character: number): string {
		const lineText = text.split('\n')[line] ?? '';
		const m = /([A-Za-z0-9_]+)$/.exec(lineText.slice(0, character));
		return (m ? m[1] : '').toLowerCase();
	}

	/** Resolve completions from the real editor providers for the current buffer text/position. */
	private async getRealCompletions(text: string, line: number, character: number): Promise<unknown[]> {
		const doc = await this.syncBufferDoc(text);
		if (!doc) return [];
		try {
			const list = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				doc.uri,
				new vscode.Position(line, character),
			);
			let items = list?.items ?? [];
			// `executeCompletionItemProvider` returns the providers' raw, unfiltered
			// results — for SObject/type completion that's the whole org (thousands).
			// We must filter by the typed prefix ourselves *before* capping, or the
			// match (e.g. the namespace-optional `filterText`) gets truncated away.
			const prefix = AnonymousApexViewProvider.prefixAt(text, line, character);
			if (prefix) {
				const matches = (s?: string) => !!s && s.toLowerCase().startsWith(prefix);
				items = items.filter((it) => {
					const label = typeof it.label === 'string' ? it.label : it.label.label;
					// filterText carries the namespace-optional form (acme__Foo__c → Foo__c).
					return matches(it.filterText) || matches(label) || (it.filterText ?? '').toLowerCase().includes(prefix);
				});
			}
			return items.slice(0, 200).map((it) => {
				const label = typeof it.label === 'string' ? it.label : it.label.label;
				const isSnippet = it.insertText instanceof vscode.SnippetString;
				const insert = typeof it.insertText === 'string' ? it.insertText : (it.insertText as vscode.SnippetString | undefined)?.value ?? label;
				const doc2 = typeof it.documentation === 'string' ? it.documentation : (it.documentation as vscode.MarkdownString | undefined)?.value;
				return {
					label,
					insertText: insert,
					isSnippet,
					kind: typeof it.kind === 'number' ? it.kind : 0,
					detail: it.detail,
					documentation: doc2,
					sortText: it.sortText,
					filterText: it.filterText,
				};
			});
		} catch {
			return [];
		}
	}

	/** Resolve hover info from the real editor providers for the current buffer text/position. */
	private async getRealHover(text: string, line: number, character: number): Promise<{ contents: string[] } | null> {
		const doc = await this.syncBufferDoc(text);
		if (!doc) return null;
		try {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				doc.uri,
				new vscode.Position(line, character),
			);
			const contents: string[] = [];
			for (const h of hovers ?? []) {
				for (const c of h.contents) {
					const value = typeof c === 'string' ? c : (c as vscode.MarkdownString).value;
					if (value && value.trim()) contents.push(value);
				}
			}
			return contents.length ? { contents } : null;
		} catch {
			return null;
		}
	}

	private _post(type: string, payload: Record<string, unknown> = {}): void {
		this._view?.webview.postMessage({ type, ...payload });
	}

	public async resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): Promise<void> {
		this._view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri,
				vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor', 'min'),
			],
		};

		const { lastCode, history } = await this.loadApexState();
		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, lastCode, history);

		this._messageListener?.dispose();
		this._messageListener = webviewView.webview.onDidReceiveMessage(async (data: any) => {
			switch (data?.type) {
				case 'getOrgs': {
					this._post('orgList', { orgs: await getAnonymousApexOrgList() });
					break;
				}
				case 'getCompletions': {
					const items = await this.getRealCompletions(data.text || '', data.line || 0, data.character || 0);
					this._post('completionResult', { requestId: data.requestId, items });
					break;
				}
				case 'getHover': {
					const hover = await this.getRealHover(data.text || '', data.line || 0, data.character || 0);
					this._post('hoverResult', { requestId: data.requestId, hover });
					break;
				}
				case 'execute': {
					if (!isSalesforceProject()) {
						this._post('showError', { message: 'Open an SFDX project (folder containing sfdx-project.json) to use this feature.' });
						return;
					}
					await this.writeBuffer(data.code || '');
					this._post('executeStarted', {});
					const result = await executeAnonymousForPanel(data.code || '', data.targetOrg || undefined);
					this._post('executeResult', {
						success: result.success,
						error: result.errorMessage || '',
						log: result.log || '',
						logId: result.logId || '',
					});
					if (result.success) {
						this._post('historyUpdated', { history: await this.saveApexOnExecute(data.code || '') });
					}
					break;
				}
				case 'openLog': {
					if (typeof data.logId === 'string' && data.logId) {
						await openLogById(data.logId, vscode.ViewColumn.Beside, 'sf-anon-log', true, data.targetOrg || undefined);
					}
					break;
				}
				case 'openInEditor': {
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
					break;
				}
				case 'contentChanged': {
					if (typeof data.code === 'string') {
						await this.writeBuffer(data.code);   // for completion/hover providers
						this.saveLastCode(data.code);        // restored-on-reload snapshot
					}
					break;
				}
			}
		});

		// When the panel is hidden / focus moves away, ask the webview to flush its
		// current content immediately (don't wait out the debounce) so nothing is lost.
		webviewView.onDidChangeVisibility(() => {
			if (!webviewView.visible) this._post('flush');
		});

		webviewView.onDidDispose(() => {
			this._messageListener?.dispose();
			this._messageListener = undefined;
		});
	}

	private _getHtmlForWebview(webview: vscode.Webview, initialContent = '', history: string[] = []): string {
		const monacoBase = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs'),
		);
		const cspSource = webview.cspSource;
		const initialData = JSON.stringify({ lastCode: initialContent || '', history: Array.isArray(history) ? history : [] })
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-eval' 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; worker-src blob:; connect-src ${cspSource};">
<title>Execute Apex</title>
<style>
	* { box-sizing: border-box; }
	body { margin: 0; padding: 6px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
		font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
		height: 100vh; display: flex; flex-direction: column; gap: 6px; }
	.row { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
	.label { font-size: 11px; opacity: 0.85; }
	select { flex: 1; min-width: 0; padding: 4px 8px; font-size: 12px;
		background: var(--vscode-input-background); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
	#main { flex: 1; display: flex; gap: 6px; min-height: 120px; }
	#editor { flex: 1; min-width: 0; border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; overflow: hidden; }
	#results { flex: 1; min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 4px; overflow: hidden; background: var(--vscode-editor-background); }
	#results-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 11px;
		opacity: 0.9; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); flex-shrink: 0; }
	#open-log-btn { display: none; font-size: 11px; padding: 2px 8px; border: none; border-radius: 4px; cursor: pointer;
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	#result-content { flex: 1; margin: 0; padding: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word;
		font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.4; }
	#result-content.error { color: var(--vscode-errorForeground); }
	#result-content.muted { opacity: 0.6; }
	#error-box { padding: 8px; font-size: 12px; line-height: 1.4; white-space: pre-wrap; word-break: break-word;
		background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder);
		color: var(--vscode-errorForeground); border-radius: 4px; display: none; flex-shrink: 0; max-height: 140px; overflow: auto; }
	#error-box.visible { display: block; }
	.actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
	button { padding: 6px 14px; font-size: 13px; border: none; border-radius: 4px; cursor: pointer;
		background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.shortcut-hint { font-size: 10px; opacity: 0.6; margin-left: 4px; }
</style>
</head>
<body>
<script type="application/json" id="apex-initial-data">${initialData}</script>
<div class="row"><span class="label">History</span>
	<select id="history-select" title="Reopen a previous snippet"><option value="">History</option></select></div>
<div class="row"><span class="label">Target org</span>
	<select id="org-select" title="Org to execute against"><option value="">Loading…</option></select></div>
<div id="main">
	<div id="editor"></div>
	<div id="results">
		<div id="results-header"><span id="results-title">Result</span><button id="open-log-btn" title="Open the full debug log in an editor">Open log</button></div>
		<pre id="result-content" class="muted">Run code to see the result and debug log here.</pre>
	</div>
</div>
<div id="error-box" role="alert"></div>
<div class="actions">
	<button id="execute-btn" title="Execute (Ctrl+Enter)">Execute<span class="shortcut-hint">Ctrl+Enter</span></button>
	<button id="open-editor-btn" class="secondary" title="Open this buffer as a full editor tab">Open in Editor</button>
	<button id="clear-btn" class="secondary">Clear</button>
</div>

<script src="${monacoBase}/loader.js"></script>
<script>
	const vscode = acquireVsCodeApi();
	const errorBox = document.getElementById('error-box');
	const orgSelect = document.getElementById('org-select');
	const historySelect = document.getElementById('history-select');
	const resultContent = document.getElementById('result-content');
	const resultsTitle = document.getElementById('results-title');
	const openLogBtn = document.getElementById('open-log-btn');
	let currentLogId = '';
	let editor = null;
	let saveTimer = null;
	let initial = { lastCode: '', history: [] };
	try { initial = JSON.parse(document.getElementById('apex-initial-data').textContent); } catch (e) {}

	function showError(msg) { errorBox.textContent = msg || ''; errorBox.classList.toggle('visible', !!msg); }
	function setResult(text, mode) {
		resultContent.textContent = text || '';
		resultContent.classList.toggle('error', mode === 'error');
		resultContent.classList.toggle('muted', mode === 'muted');
	}
	function setHistory(items) {
		while (historySelect.options.length > 1) historySelect.remove(1);
		(items || []).forEach((q) => {
			const opt = document.createElement('option');
			opt.value = q; opt.textContent = (q.length > 50 ? q.slice(0, 47) + '…' : q).replace(/\\s+/g, ' '); opt.title = q;
			historySelect.appendChild(opt);
		});
	}
	setHistory(initial.history);

	// ── completion bridge ───────────────────────────────────────────────
	let reqId = 0; const pending = {};
	// VS Code CompletionItemKind → Monaco CompletionItemKind
	function mapKind(k) {
		const M = monaco.languages.CompletionItemKind;
		const T = { 0:M.Text,1:M.Method,2:M.Function,3:M.Constructor,4:M.Field,5:M.Variable,6:M.Class,
			7:M.Interface,8:M.Module,9:M.Property,10:M.Unit,11:M.Value,12:M.Enum,13:M.Keyword,14:M.Snippet,
			15:M.Color,16:M.File,17:M.Reference,18:M.Folder,19:M.EnumMember,20:M.Constant,21:M.Struct,
			22:M.Event,23:M.Operator,24:M.TypeParameter };
		return T[k] != null ? T[k] : M.Text;
	}

	window.addEventListener('message', (e) => {
		const d = e.data; if (!d) return;
		if (d.type === 'showError') showError(d.message || '');
		else if (d.type === 'orgList') {
			const orgs = d.orgs || [];
			orgSelect.innerHTML = orgs.length
				? orgs.map(o => '<option value="' + (o.username || '').replace(/"/g, '&quot;') + '">' + (o.label || o.username || '').replace(/</g, '&lt;') + '</option>').join('')
				: '<option value="">No orgs</option>';
		} else if (d.type === 'historyUpdated') setHistory(d.history || []);
		else if (d.type === 'completionResult') { const cb = pending[d.requestId]; if (cb) { delete pending[d.requestId]; cb(d.items || []); } }
		else if (d.type === 'hoverResult') { const cb = pending[d.requestId]; if (cb) { delete pending[d.requestId]; cb(d.hover || null); } }
		else if (d.type === 'flush') flushContent();
		else if (d.type === 'executeStarted') { resultsTitle.textContent = 'Running…'; openLogBtn.style.display = 'none'; currentLogId = ''; setResult('Executing…', 'muted'); }
		else if (d.type === 'executeResult') {
			if (!d.success) {
				resultsTitle.textContent = 'Error';
				setResult(d.error || 'Execution failed.', 'error');
				openLogBtn.style.display = 'none';
			} else {
				resultsTitle.textContent = d.log ? 'Debug log' : 'Result';
				setResult(d.log || 'Executed successfully. (No debug log — enable trace logging to capture one.)', d.log ? null : 'muted');
				currentLogId = d.logId || '';
				openLogBtn.style.display = currentLogId ? '' : 'none';
				// Jump to the end of the log (most recent output).
				resultContent.scrollTop = resultContent.scrollHeight;
			}
		}
	});
	vscode.postMessage({ type: 'getOrgs' });

	require.config({ paths: { vs: '${monacoBase}' } });
	self.MonacoEnvironment = {
		getWorkerUrl: function () {
			return URL.createObjectURL(new Blob(
				["self.MonacoEnvironment={baseUrl:'" + '${monacoBase}' + "/'};importScripts('" + '${monacoBase}' + "/base/worker/workerMain.js');"],
				{ type: 'text/javascript' }));
		}
	};

	require(['vs/editor/editor.main'], function () {
		monaco.languages.register({ id: 'apex' });
		monaco.languages.setMonarchTokensProvider('apex', {
			ignoreCase: true,
			keywords: ['abstract','after','before','break','catch','class','continue','delete','do','else','enum','extends',
				'final','finally','for','get','global','if','implements','insert','instanceof','interface','merge','new','null',
				'on','override','private','protected','public','return','set','static','super','switch','testmethod','this','throw',
				'transient','trigger','try','undelete','update','upsert','virtual','void','webservice','when','while','with','without',
				'sharing','true','false','select','from','where','limit','order','by','group','having','and','or','not','like','in'],
			typeKeywords: ['Boolean','Date','Datetime','Decimal','Double','Id','Integer','Long','Object','String','Blob','Time',
				'List','Map','Set','SObject','Account','Contact','Lead','Opportunity','Case','System','Database','Test','Schema','Limits'],
			tokenizer: {
				root: [
					[/\\/\\/.*$/, 'comment'],
					[/\\/\\*/, 'comment', '@comment'],
					[/'(?:[^'\\\\]|\\\\.)*'/, 'string'],
					[/@[a-zA-Z_][\\w]*/, 'annotation'],
					[/\\[/, 'string.soql', '@soql'],
					[/\\b\\d+(\\.\\d+)?\\b/, 'number'],
					[/[a-zA-Z_][\\w]*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
				],
				comment: [ [/[^*/]+/, 'comment'], [/\\*\\//, 'comment', '@pop'], [/[*/]/, 'comment'] ],
				soql: [ [/'(?:[^'\\\\]|\\\\.)*'/, 'string'], [/\\]/, 'string.soql', '@pop'],
					[/[a-zA-Z_][\\w]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }], [/./, 'string.soql'] ],
			},
		});
		monaco.languages.setLanguageConfiguration('apex', {
			comments: { lineComment: '//', blockComment: ['/*', '*/'] },
			brackets: [['{','}'],['[',']'],['(',')']],
			autoClosingPairs: [{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:"'",close:"'"}],
		});

		monaco.languages.registerHoverProvider('apex', {
			provideHover: function (model, position) {
				return new Promise(function (resolve) {
					const id = ++reqId;
					pending[id] = function (hover) {
						if (!hover || !hover.contents || !hover.contents.length) { resolve(null); return; }
						const word = model.getWordAtPosition(position);
						const range = word ? { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
							startColumn: word.startColumn, endColumn: word.endColumn } : undefined;
						resolve({ range: range, contents: hover.contents.map(function (v) { return { value: v }; }) });
					};
					vscode.postMessage({ type: 'getHover', requestId: id,
						text: model.getValue(), line: position.lineNumber - 1, character: position.column - 1 });
				});
			},
		});

		monaco.languages.registerCompletionItemProvider('apex', {
			triggerCharacters: ['.', ' ', '(', ',', '_'],
			provideCompletionItems: function (model, position) {
				return new Promise(function (resolve) {
					const id = ++reqId;
					pending[id] = function (items) {
						const word = model.getWordUntilPosition(position);
						const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
							startColumn: word.startColumn, endColumn: word.endColumn };
						resolve({ suggestions: items.map(function (it) {
							return { label: it.label, kind: mapKind(it.kind),
								insertText: it.insertText || it.label,
								insertTextRules: it.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
								detail: it.detail,
								documentation: it.documentation ? { value: it.documentation } : undefined,
								sortText: it.sortText, filterText: it.filterText, range: range };
						}) });
					};
					vscode.postMessage({ type: 'getCompletions', requestId: id,
						text: model.getValue(), line: position.lineNumber - 1, character: position.column - 1 });
				});
			},
		});

		const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
		editor = monaco.editor.create(document.getElementById('editor'), {
			value: initial.lastCode || '',
			language: 'apex',
			theme: dark ? 'vs-dark' : 'vs',
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 13,
			tabSize: 4,
			quickSuggestions: true,
			// Render suggest/hover widgets at the document-body level so they aren't
			// clipped or mispositioned inside the small panel editor container.
			fixedOverflowWidgets: true,
		});

		editor.onDidChangeModelContent(function () {
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(function () { vscode.postMessage({ type: 'contentChanged', code: editor.getValue() }); }, 500);
		});
		// Flush immediately when focus leaves the editor, so edits persist even if
		// the panel is hidden/disposed before the debounce fires.
		editor.onDidBlurEditorText(flushContent);
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, doExecute);
	});

	// Persist the current editor content right now (cancel any pending debounce).
	function flushContent() {
		if (!editor) return;
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		vscode.postMessage({ type: 'contentChanged', code: editor.getValue() });
	}
	window.addEventListener('blur', flushContent);
	document.addEventListener('visibilitychange', function () { if (document.hidden) flushContent(); });

	function doExecute() {
		showError('');
		vscode.postMessage({ type: 'execute', code: editor ? editor.getValue() : '', targetOrg: (orgSelect.value || '').trim() || undefined });
	}

	historySelect.addEventListener('change', function () {
		const code = historySelect.value;
		if (code && editor) { editor.setValue(code); editor.focus(); }
		historySelect.selectedIndex = 0;
	});
	openLogBtn.onclick = function () { if (currentLogId) vscode.postMessage({ type: 'openLog', logId: currentLogId, targetOrg: (orgSelect.value || '').trim() || undefined }); };
	document.getElementById('execute-btn').onclick = doExecute;
	document.getElementById('open-editor-btn').onclick = function () { vscode.postMessage({ type: 'openInEditor', code: editor ? editor.getValue() : '' }); };
	document.getElementById('clear-btn').onclick = function () { if (editor) { editor.setValue(''); editor.focus(); } showError(''); vscode.postMessage({ type: 'contentChanged', code: '' }); };
</script>
</body>
</html>`;
	}
}
