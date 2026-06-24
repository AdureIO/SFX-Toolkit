import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { executeAnonymousForPanel, getAnonymousApexOrgList } from '../commands/executeAnonymous';
import { isSalesforceProject } from '../utils/projectUtils';
import { getHighlightPatterns } from '../utils/apexLogHighlight';
import { AuthInfo } from '../utils/authInfo';

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
	private _lastLog = '';

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

	/**
	 * Keep a single backing document for the buffer file open & in sync so the
	 * completion/hover providers see the current text. This document is the ONLY
	 * writer of the file: we never fs-write it while it's open (doing both caused
	 * "the content of the file is newer" save conflicts). Updates go through
	 * applyEdit + save; durable panel state lives separately in apex-last.txt.
	 */
	private async syncBufferDoc(text: string): Promise<vscode.TextDocument | undefined> {
		const uri = this.getBufferUri();
		if (!uri) return undefined;
		if (!this._bufferDoc || this._bufferDoc.isClosed) {
			try {
				// Create the file once if it doesn't exist (providers need a real URI).
				try {
					await vscode.workspace.fs.stat(uri);
				} catch {
					await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
					await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''));
				}
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
				await doc.save(); // keep disk in sync via the document itself (no rival fs writer)
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

	/** Resolve a definition location from the real providers and open it in an editor. */
	private async gotoDefinition(text: string, line: number, character: number): Promise<void> {
		const doc = await this.syncBufferDoc(text);
		if (!doc) return;
		try {
			const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
				'vscode.executeDefinitionProvider',
				doc.uri,
				new vscode.Position(line, character),
			);
			const first = (res ?? [])[0];
			if (!first) return;
			const uri = 'targetUri' in first ? first.targetUri : first.uri;
			const range = 'targetUri' in first ? (first.targetSelectionRange ?? first.targetRange) : first.range;
			// Skip self-references into the hidden buffer (can't reveal a webview editor).
			if (uri.toString() === doc.uri.toString()) return;
			await vscode.window.showTextDocument(uri, { selection: range, preview: false });
		} catch {
			/* no definition */
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
				case 'warmOrg': {
					// Pre-fetch the selected org's token so the first run isn't cold
					// (the panel targets a specific org username, not the default key).
					if (isSalesforceProject()) AuthInfo.warmAuthForOrg(typeof data.org === 'string' && data.org ? data.org : null);
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
				case 'gotoDefinition': {
					await this.gotoDefinition(data.text || '', data.line || 0, data.character || 0);
					break;
				}
				case 'execute': {
					if (!isSalesforceProject()) {
						this._post('showError', { message: 'Open an SFDX project (folder containing sfdx-project.json) to use this feature.' });
						return;
					}
					this._post('executeStarted', {});
					const result = await executeAnonymousForPanel(data.code || '', data.targetOrg || undefined);
					this._lastLog = result.log || '';
					this._post('executeResult', {
						success: result.success,
						error: result.errorMessage || '',
						log: result.log || '',
						hasLog: !!(result.log && result.log.trim()),
					});
					if (result.success) {
						this._post('historyUpdated', { history: await this.saveApexOnExecute(data.code || '') });
					}
					break;
				}
				case 'openLog': {
					// Open the inline debug log (from the SOAP response) in an editor.
					if (this._lastLog.trim()) {
						const doc = await vscode.workspace.openTextDocument({ content: this._lastLog, language: 'salesforce-log' });
						await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
					}
					break;
				}
				case 'openInEditor': {
					// Open the single backing document (kept in sync via syncBufferDoc),
					// never an independent fs write, to avoid save conflicts.
					const doc = await this.syncBufferDoc(typeof data.code === 'string' ? data.code : await this.readBuffer());
					if (doc) {
						try {
							await vscode.window.showTextDocument(doc, { preview: false });
						} catch {
							await vscode.commands.executeCommand('vscode.open', doc.uri);
						}
					}
					break;
				}
				case 'contentChanged': {
					if (typeof data.code === 'string') {
						await this.syncBufferDoc(data.code);   // single-writer update for completion/hover
						this.saveLastCode(data.code);          // restored-on-reload snapshot
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
		const initialData = JSON.stringify({ lastCode: initialContent || '', history: Array.isArray(history) ? history : [], highlightPatterns: getHighlightPatterns() })
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
	#main { flex: 1; display: flex; flex-direction: row; min-height: 120px; }
	#editor { flex: 1 1 auto; min-width: 120px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; overflow: hidden; }
	/* Drag handle to resize the results pane horizontally (drag left/right). */
	#splitter { flex: 0 0 8px; width: 8px; cursor: col-resize; display: flex; justify-content: center; }
	#splitter::before { content: ''; display: block; height: 100%; width: 3px; border-radius: 2px;
		background: var(--vscode-panel-border, rgba(128,128,128,0.3)); }
	#splitter:hover::before { background: var(--vscode-focusBorder, rgba(0,120,212,0.6)); }
	#results { flex: 0 0 auto; width: 45%; min-width: 140px; display: flex; flex-direction: column;
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; overflow: hidden; background: var(--vscode-editor-background); }
	#results-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 11px;
		opacity: 0.95; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); flex-shrink: 0; }
	.results-tools { display: flex; align-items: center; gap: 6px; }
	#result-filter { display: none; width: 200px; max-width: 40vw; padding: 2px 6px; font-size: 11px;
		background: var(--vscode-input-background); color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
	#result-filter.invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
	#filter-presets { display: none; gap: 4px; }
	#filter-presets .qf { font-size: 11px; padding: 2px 7px; border: none; border-radius: 4px; cursor: pointer;
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	#filter-presets .qf:hover { background: var(--vscode-button-hoverBackground); }
	#filter-presets .qf.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	#open-log-btn { display: none; font-size: 11px; padding: 2px 8px; border: none; border-radius: 4px; cursor: pointer;
		background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	#result-content { flex: 1; margin: 0; padding: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word;
		font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.4; }
	#result-content mark { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.4)); color: inherit; border-radius: 2px; }
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
	<div id="splitter" title="Drag to resize the results pane"></div>
	<div id="results">
		<div id="results-header">
			<span id="results-title">Result</span>
			<div class="results-tools">
				<span id="filter-presets">
					<button class="qf" data-f="debug" title="Toggle: USER_DEBUG, exceptions and errors">Debug</button>
					<button class="qf" data-f="soql" title="Toggle: SOQL and DML operations">SOQL/DML</button>
				</span>
				<input id="result-filter" type="text" placeholder="Filter (regex)…" title="Show only log lines matching this regular expression; matches are highlighted" spellcheck="false" />
				<button id="open-log-btn" title="Open the full debug log in an editor">Open log</button>
			</div>
		</div>
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
	const resultFilter = document.getElementById('result-filter');
	const filterPresets = document.getElementById('filter-presets');
	const splitter = document.getElementById('splitter');
	const resultsPane = document.getElementById('results');
	let rawLog = '';
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
	function escapeHtml(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
	// Highlight regex matches within one line (input is raw text; output is escaped HTML).
	function highlightLine(line, re) {
		if (!re) return escapeHtml(line);
		let out = '', last = 0, m;
		re.lastIndex = 0;
		while ((m = re.exec(line)) !== null) {
			out += escapeHtml(line.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
			last = m.index + m[0].length;
			if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width matches
		}
		return out + escapeHtml(line.slice(last));
	}
	// Configured line-color rules (shared with the .log decorator via settings).
	const HL = ((initial.highlightPatterns) || []).map(function (p) {
		let re = null;
		try { re = new RegExp(p.pattern, 'i'); } catch (e) { re = null; }
		let style = '';
		const fg = (p.foreground || '').replace(/[^#\\w(),.%\\s-]/g, '');
		if (fg) style += 'color:' + fg + ';';
		if (p.fontStyle && p.fontStyle.indexOf('bold') >= 0) style += 'font-weight:bold;';
		if (p.fontStyle && p.fontStyle.indexOf('italic') >= 0) style += 'font-style:italic;';
		return { re: re, style: style };
	}).filter(function (p) { return p.re && p.style; });

	// First matching rule's inline style for a line (empty when none match).
	function lineStyle(line) {
		for (let i = 0; i < HL.length; i++) { HL[i].re.lastIndex = 0; if (HL[i].re.test(line)) return HL[i].style; }
		return '';
	}

	// Combinable category toggles (union), aligned with the .log Debug / SOQL filters.
	const activeToggles = { debug: false, soql: false };
	const EVENT_START = /^\\d{2}:\\d{2}:\\d{2}\\./;
	// Event-aware union filter: keep an event's start line if it matches an active
	// toggle, plus its continuation lines (stack traces, JSON bodies).
	function applyToggles(lines) {
		if (!activeToggles.debug && !activeToggles.soql) return lines;
		const out = [];
		let keep = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (EVENT_START.test(line)) {
				let m = false;
				if (activeToggles.debug && (line.indexOf('|USER_DEBUG|') >= 0 || line.indexOf('FATAL_ERROR') >= 0 || line.indexOf('EXCEPTION_THROWN') >= 0 || line.indexOf('|ERROR|') >= 0)) m = true;
				if (!m && activeToggles.soql && (line.indexOf('|SOQL_EXECUTE') >= 0 || line.indexOf('|DML_') >= 0)) m = true;
				keep = m;
				if (m) out.push(line);
			} else if (keep) {
				out.push(line);
			}
		}
		return out;
	}

	// Render the debug log: category toggles (union), then the user's regex search
	// box (line-level + match highlight), then the configured per-line color rules.
	function renderLog() {
		resultContent.classList.remove('error', 'muted');
		const q = (resultFilter.value || '').trim();
		let re = null;
		if (q) {
			try { re = new RegExp(q, 'gi'); resultFilter.classList.remove('invalid'); }
			catch (e) { resultFilter.classList.add('invalid'); re = null; }
		} else {
			resultFilter.classList.remove('invalid');
		}
		const lines = applyToggles(rawLog.split('\\n'));
		const out = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (re) { re.lastIndex = 0; if (!re.test(line)) continue; }
			const inner = highlightLine(line, re);
			const style = lineStyle(line);
			out.push(style ? '<span style="' + style + '">' + inner + '</span>' : inner);
		}
		resultContent.innerHTML = out.length ? out.join('\\n') : '<span style="opacity:0.6">No matching lines.</span>';
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
				? orgs.map(function (o) {
					// The default org maps to value "" so it reuses the token warmed at
					// startup (cached under the default key, not its username).
					const isDefault = (o.label || '').indexOf('(default)') >= 0;
					const val = isDefault ? '' : (o.username || '');
					return '<option value="' + val.replace(/"/g, '&quot;') + '">' + (o.label || o.username || '').replace(/</g, '&lt;') + '</option>';
				}).join('')
				: '<option value="">No orgs</option>';
			// Warm the selected org's token so the first run is fast (no-op if default).
			vscode.postMessage({ type: 'warmOrg', org: (orgSelect.value || '').trim() });
		} else if (d.type === 'historyUpdated') setHistory(d.history || []);
		else if (d.type === 'completionResult') { const cb = pending[d.requestId]; if (cb) { delete pending[d.requestId]; cb(d.items || []); } }
		else if (d.type === 'hoverResult') { const cb = pending[d.requestId]; if (cb) { delete pending[d.requestId]; cb(d.hover || null); } }
		else if (d.type === 'flush') flushContent();
		else if (d.type === 'executeStarted') {
			resultsTitle.textContent = 'Running…'; setTools(false); rawLog = ''; setResult('Executing…', 'muted');
		}
		else if (d.type === 'executeResult') {
			if (!d.success) {
				resultsTitle.textContent = 'Error';
				rawLog = ''; setTools(false);
				setResult(d.error || 'Execution failed.', 'error');
			} else if (d.hasLog) {
				resultsTitle.textContent = 'Debug log';
				rawLog = d.log || '';
				setTools(true);
				renderLog();
				resultContent.scrollTop = resultContent.scrollHeight; // jump to latest output
			} else {
				resultsTitle.textContent = 'Result';
				rawLog = ''; setTools(false);
				setResult('Executed successfully.', 'muted');
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
		// Ctrl/Cmd+click → go to definition (resolved by the host's real providers,
		// opened in a regular editor since the webview can't host VS Code editors).
		editor.onMouseDown(function (e) {
			if ((e.event.ctrlKey || e.event.metaKey) && e.target && e.target.position) {
				const p = e.target.position;
				vscode.postMessage({ type: 'gotoDefinition', text: editor.getValue(), line: p.lineNumber - 1, character: p.column - 1 });
			}
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
	openLogBtn.onclick = function () { vscode.postMessage({ type: 'openLog' }); };
	resultFilter.addEventListener('input', renderLog);

	// Show/hide the log tools (filter + presets + open) together.
	function setTools(on) {
		openLogBtn.style.display = on ? 'inline-block' : 'none';
		resultFilter.style.display = on ? 'inline-block' : 'none';
		filterPresets.style.display = on ? 'inline-flex' : 'none';
	}

	// Category toggles (combinable, like the .log filters). They do NOT touch the
	// search box — that stays free for the user's own regex.
	Array.prototype.forEach.call(document.querySelectorAll('.qf'), function (b) {
		b.onclick = function () {
			const f = b.getAttribute('data-f');
			activeToggles[f] = !activeToggles[f];
			b.classList.toggle('active', activeToggles[f]);
			renderLog();
		};
	});

	// ── results pane: drag the splitter to resize its width (persisted) ───────
	(function () {
		const saved = (function () { try { return (vscode.getState() || {}).resultsWidth; } catch (e) { return null; } })();
		if (saved && saved > 140) resultsPane.style.width = saved + 'px';
		let dragging = false, startX = 0, startW = 0;
		splitter.addEventListener('mousedown', function (e) {
			dragging = true; startX = e.clientX; startW = resultsPane.getBoundingClientRect().width;
			document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
			e.preventDefault();
		});
		window.addEventListener('mousemove', function (e) {
			if (!dragging) return;
			// Results sits on the right; dragging the handle left (clientX decreases) grows it.
			const max = Math.max(140, window.innerWidth - 160);
			const w = Math.min(max, Math.max(140, startW + (startX - e.clientX)));
			resultsPane.style.width = w + 'px';
		});
		window.addEventListener('mouseup', function () {
			if (!dragging) return;
			dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
			try { const s = vscode.getState() || {}; s.resultsWidth = resultsPane.getBoundingClientRect().width; vscode.setState(s); } catch (e) {}
		});
	})();
	orgSelect.addEventListener('change', function () { vscode.postMessage({ type: 'warmOrg', org: (orgSelect.value || '').trim() }); });
	document.getElementById('execute-btn').onclick = doExecute;
	document.getElementById('open-editor-btn').onclick = function () { vscode.postMessage({ type: 'openInEditor', code: editor ? editor.getValue() : '' }); };
	document.getElementById('clear-btn').onclick = function () { if (editor) { editor.setValue(''); editor.focus(); } showError(''); vscode.postMessage({ type: 'contentChanged', code: '' }); };
</script>
</body>
</html>`;
	}
}
