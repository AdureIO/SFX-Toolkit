import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getAnonymousApexOrgList, executeAnonymousForPanel } from '../commands/executeAnonymous';
import { listApexLogs, fetchApexLogBody, fetchApexLogHead, listActiveTraceFlags, deleteAllApexLogs, createUserTrace, extractCodeUnit, type ApexLogRow } from '../utils/apexLogApi';
import { getHighlightPatterns } from '../utils/apexLogHighlight';
import { getSalesforceLogDirectory } from '../utils/logPaths';
import { AuthInfo } from '../utils/authInfo';
import { getToolingApiVersion } from '../utils/constants';
import { isSalesforceProject } from '../utils/projectUtils';
import { setBufferOrgOverride } from '../utils/bufferOrgOverride';
import { getSoqlMarkers } from '../utils/soqlMarkers';
import { parseSoqlError } from '../utils/soqlError';
import { handleResultsTableMessage } from '../utils/resultsTableHost';
import { resultsTableCss, resultsTableScript } from '../webview/resultsTableComponent';
import { refreshLanguageServerSchema, setEphemeralBuffers } from '../languageClient';
import { ApexBufferBridge } from './apexBufferBridge';
import { Telemetry } from '../utils/telemetry';

const WORKBENCH_BUFFER = '.vscode/anon-workbench-buffer.apex';
const SOQL_BUFFER = '.vscode/workbench-soql-buffer.soql';

const ASFX_DIR = '.sfdx/asfx';
const HISTORY_FILE = 'workbench-apex-history.json';
const HISTORY_MAX = 10;

/**
 * The Apex Workbench — a bottom-panel webview combining, under one org switcher:
 *   • Logs tab: an org-scoped debug-log browser + viewer (toggles / regex /
 *     configurable highlighting) and an active-traces strip.
 *   • Execute tab: a Monaco editor with org-aware completion/hover/go-to-def and
 *     a results pane, running anonymous Apex against the selected org.
 * Coexists with the sidebar Logs/Traces views and the standalone Execute panel.
 */
export class ApexWorkbenchViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _listener?: vscode.Disposable;
	private _lastLog = '';
	private readonly _bridge = new ApexBufferBridge(WORKBENCH_BUFFER);
	private readonly _soqlBridge = new ApexBufferBridge(SOQL_BUFFER, 'soql');
	/** Cache of fetched log bodies (id → { text, unit }) so re-opening is instant. */
	private readonly _bodyCache = new Map<string, { text: string; unit: string | null }>();
	/** Cache of parsed entry-point code units (id → unit) for the list. */
	private readonly _unitCache = new Map<string, string | null>();
	/** Bumped on each list load so stale background enrichment self-cancels. */
	private _enrichGen = 0;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	private _post(type: string, payload: Record<string, unknown> = {}): void {
		this._view?.webview.postMessage({ type, ...payload });
	}

	private _storageDir(): string | null {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return root ? path.join(root, ASFX_DIR) : null;
	}

	private _loadHistory(): string[] {
		const dir = this._storageDir();
		if (!dir) return [];
		try {
			const p = path.join(dir, HISTORY_FILE);
			if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : []; }
		} catch { /* ignore */ }
		return [];
	}

	private _saveHistory(code: string): string[] {
		const dir = this._storageDir();
		const trimmed = (code || '').trim();
		if (!dir || !trimmed) return this._loadHistory();
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const hist = [trimmed, ...this._loadHistory().filter((q) => q.trim() !== trimmed)].slice(0, HISTORY_MAX);
			fs.writeFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(hist, null, 0), 'utf8');
			return hist;
		} catch {
			return this._loadHistory();
		}
	}

	public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this._view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri,
				vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor', 'min'),
			],
		};
		const initialCode = await this._bridge.readBuffer();
		const initialSoql = await this._soqlBridge.readBuffer();
		view.webview.html = this._html(view.webview, initialCode, initialSoql);

		this._listener?.dispose();
		this._listener = view.webview.onDidReceiveMessage(async (data: any) => {
			// Shared results-table component messages (column meta / lookup / save).
			if (await handleResultsTableMessage(data, (m) => view.webview.postMessage(m))) return;
			switch (data?.type) {
				case 'getOrgs':
					this._post('orgList', { orgs: await getAnonymousApexOrgList() });
					break;
				case 'warmOrg': {
					const org = (typeof data.org === 'string' && data.org) ? data.org : null;
					if (isSalesforceProject()) AuthInfo.warmAuthForOrg(org);
					// Point both workbench buffers' IntelliSense at the selected org and
					// clear the server's schema cache so completion reflects it.
					const apexUri = this._bridge.getBufferUri();
					const soqlUri = this._soqlBridge.getBufferUri();
					if (apexUri) setBufferOrgOverride(apexUri.fsPath, org);
					if (soqlUri) setBufferOrgOverride(soqlUri.fsPath, org);
					// Mark these buffers ephemeral so go-to-def never writes stubs for them.
					setEphemeralBuffers([apexUri?.toString(), soqlUri?.toString()].filter((u): u is string => !!u));
					refreshLanguageServerSchema();
					break;
				}
				// ── Logs ────────────────────────────────────────────────────────────
				case 'listLogs': {
					const rows = await listApexLogs(data.org || null);
					// Send cached code units up front so already-known names show instantly.
					const units: Record<string, string> = {};
					for (const r of rows) { const u = this._unitCache.get(r.id); if (u) units[r.id] = u; }
					this._post('logList', { org: data.org || '', rows, units });
					void this._enrichUnits(data.org || null, rows, ++this._enrichGen);
					break;
				}
				case 'listTraces':
					this._post('traceInfo', { org: data.org || '', ...(await listActiveTraceFlags(data.org || null)) });
					break;
				case 'quickTrace': {
					const ok = await createUserTrace(data.org || null);
					vscode.window.showInformationMessage(ok ? 'Quick trace started for the selected org.' : 'Could not start the trace.');
					this._post('traceInfo', { org: data.org || '', ...(await listActiveTraceFlags(data.org || null)) });
					break;
				}
				case 'newTrace': {
					const input = await vscode.window.showInputBox({
						prompt: 'Debug trace duration (minutes) for the selected org',
						value: '60', validateInput: (v) => (/^\d+$/.test(v) && +v > 0 ? null : 'Enter a positive number of minutes'),
					});
					if (input === undefined) break;
					const ok = await createUserTrace(data.org || null, parseInt(input, 10));
					vscode.window.showInformationMessage(ok ? `Trace created (${input} min) for the selected org.` : 'Could not create the trace.');
					this._post('traceInfo', { org: data.org || '', ...(await listActiveTraceFlags(data.org || null)) });
					break;
				}
				case 'deleteAllLogs': {
					const pick = await vscode.window.showWarningMessage(
						'Delete all debug logs for the selected org?', { modal: true }, 'Delete all');
					if (pick !== 'Delete all') break;
					const n = await deleteAllApexLogs(data.org || null);
					vscode.window.showInformationMessage(`Deleted ${n} log${n === 1 ? '' : 's'}.`);
					this._post('logList', { org: data.org || '', rows: await listApexLogs(data.org || null) });
					break;
				}
				case 'openLog': {
					const cached = this._bodyCache.get(data.id);
					if (cached) { this._post('logBody', { id: data.id, text: cached.text, unit: cached.unit }); break; }
					this._post('logLoading', { id: data.id });
					const text = await fetchApexLogBody(data.org || null, data.id);
					const unit = extractCodeUnit(text);
					if (this._bodyCache.size > 20) this._bodyCache.delete(this._bodyCache.keys().next().value as string);
					this._bodyCache.set(data.id, { text, unit });
					this._unitCache.set(data.id, unit);
					this._post('logBody', { id: data.id, text, unit });
					break;
				}
				case 'openLogInEditor': {
					const text = await fetchApexLogBody(data.org || null, data.id);
					if (text) await this._openLogFile(`${data.id}.log`, text);
					break;
				}
				// ── Execute (editor bridge + run) ────────────────────────────────────
				case 'getCompletions':
					this._post('completionResult', { requestId: data.requestId, items: await this._bridge.completions(data.text || '', data.line || 0, data.character || 0) });
					break;
				case 'getHover':
					this._post('hoverResult', { requestId: data.requestId, hover: await this._bridge.hover(data.text || '', data.line || 0, data.character || 0) });
					break;
				case 'gotoDefinition': {
					const inBuf = await this._bridge.gotoDefinition(data.text || '', data.line || 0, data.character || 0);
					// In-buffer target (a function/class declared in the same anonymous block):
					// move the webview editor's cursor instead of opening the hidden doc.
					if (inBuf) this._post('revealDefinition', { line: inBuf.line, character: inBuf.character });
					break;
				}
				case 'contentChanged':
					if (typeof data.code === 'string') await this._bridge.update(data.code);
					break;
				case 'execute': {
					if (!isSalesforceProject()) { this._post('execResult', { success: false, error: 'Open an SFDX project to use this feature.' }); return; }
					Telemetry.event('apexExecute', { surface: 'panel' });
					this._post('execStarted', {});
					const result = await executeAnonymousForPanel(data.code || '', data.org || undefined);
					this._lastLog = result.log || '';
					this._post('execResult', { success: result.success, error: result.errorMessage || '', log: result.log || '', hasLog: !!(result.log && result.log.trim()) });
					if (result.success) this._post('historyUpdated', { history: this._saveHistory(data.code || '') });
					break;
				}
				case 'openExecLog':
					if (this._lastLog.trim()) await this._openLogFile(`anon-apex-${Date.now()}.log`, this._lastLog);
					break;
				// ── SOQL tab (editor bridge + run) ───────────────────────────────────
				case 'getSoqlCompletions':
					this._post('completionResult', { requestId: data.requestId, items: await this._soqlBridge.completions(data.text || '', data.line || 0, data.character || 0) });
					break;
				case 'getSoqlHover':
					this._post('hoverResult', { requestId: data.requestId, hover: await this._soqlBridge.hover(data.text || '', data.line || 0, data.character || 0) });
					break;
				case 'soqlChanged':
					if (typeof data.query === 'string') await this._soqlBridge.update(data.query);
					break;
				case 'runSoql': {
					this._post('soqlStarted', {});
					this._post('soqlResult', await this._runSoql(data.org || null, data.query || ''));
					break;
				}
				case 'openSoqlWorkbench':
					await vscode.commands.executeCommand('adure-sfx-toolkit.openSOQLEditor', typeof data.query === 'string' ? data.query : undefined, data.org || '');
					break;
				case 'validateSoql':
					this._post('soqlMarkers', { markers: await getSoqlMarkers(data.org || null, data.query || '') });
					break;
			}
		});

		view.onDidDispose(() => { this._listener?.dispose(); this._listener = undefined; });
	}

	/**
	 * Fill in each log's executed code unit in the background: fetch just the head
	 * of each body (Range request) in small concurrent batches and stream the
	 * parsed name to the webview. Self-cancels when a newer list load supersedes it.
	 */
	private async _enrichUnits(org: string | null, rows: ApexLogRow[], gen: number): Promise<void> {
		const ids = rows.map((r) => r.id).filter((id) => !this._unitCache.has(id)).slice(0, 50);
		for (let i = 0; i < ids.length; i += 4) {
			if (gen !== this._enrichGen) return; // a newer list load took over
			await Promise.all(
				ids.slice(i, i + 4).map(async (id) => {
					const head = await fetchApexLogHead(org, id);
					const unit = head ? extractCodeUnit(head) : null;
					this._unitCache.set(id, unit);
					if (unit && gen === this._enrichGen) this._post('logUnit', { org: org ?? '', id, unit });
				})
			);
		}
	}

	/** Run a SOQL query against `org` and return the raw records for the shared table. */
	private async _runSoql(org: string | null, query: string): Promise<Record<string, unknown>> {
		if (!query.trim()) return { error: 'Enter a query.' };
		const version = getToolingApiVersion();
		try {
			const { body } = await AuthInfo.get(org, (a) =>
				`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/query?q=${encodeURIComponent(query)}`
			);
			const data = JSON.parse(body);
			const records: any[] = (data.records ?? []).slice(0, 2000);
			return { records, total: data.totalSize ?? records.length, returned: records.length, done: data.done !== false };
		} catch (e: any) {
			const p = parseSoqlError(e?.message ?? String(e));
			return { error: p.code ? `${p.code}: ${p.message}` : p.message, errorDetails: p.details, errorLine: p.line, errorColumn: p.column };
		}
	}

	private async _openLogFile(name: string, text: string): Promise<void> {
		try {
			const dir = getSalesforceLogDirectory() || os.tmpdir();
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, name);
			fs.writeFileSync(file, text, 'utf8');
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
		} catch {
			const doc = await vscode.workspace.openTextDocument({ content: text, language: 'salesforce-log' });
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
		}
	}

	private _html(webview: vscode.Webview, initialCode: string, initialSoql: string): string {
		const monacoBase = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs'));
		const cspSource = webview.cspSource;
		const pollSeconds = vscode.workspace.getConfiguration('adure-sfx-toolkit').get<number>('pollingIntervalSeconds', 5);
		const data = JSON.stringify({ highlightPatterns: getHighlightPatterns(), code: initialCode || '', soql: initialSoql || '', pollSeconds, history: this._loadHistory() })
			.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
		return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-eval' 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; worker-src blob:; connect-src ${cspSource};">
<style>
	* { box-sizing:border-box; }
	body { margin:0; padding:0; height:100vh; display:flex; flex-direction:column; color:var(--vscode-foreground);
		background:var(--vscode-editor-background); font-family:var(--vscode-font-family); font-size:var(--vscode-font-size,13px); }
	#bar { display:flex; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); flex-shrink:0; }
	#title { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; white-space:nowrap; }
	.lbl { font-size:11px; opacity:0.7; }
	select { padding:4px 8px; font-size:12px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:6px; max-width:220px; }
	#tracePill { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:11px; font-size:11px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); white-space:nowrap; }
	#tracePill.on { background:rgba(21,210,116,0.18); color:#15d274; }
	#busy { display:none; align-items:center; gap:5px; font-size:11px; opacity:0.85; white-space:nowrap; }
	.spinner { width:11px; height:11px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; display:inline-block; animation:asfx-spin .8s linear infinite; }
	@keyframes asfx-spin { to { transform:rotate(360deg); } }
	/* Let the completion popup grow tall even when the editor is short. */
	.monaco-editor .suggest-widget { max-height:360px !important; }
	.monaco-editor .suggest-widget .monaco-list { max-height:340px !important; }
	button { font-size:11px; padding:4px 10px; border:none; border-radius:6px; cursor:pointer; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	button:hover { background:var(--vscode-button-hoverBackground); }
	button.primary { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	button.icon { padding:4px 6px; display:inline-flex; align-items:center; justify-content:center; }
	button.icon svg { width:14px; height:14px; display:block; }
	button.icon svg path, button.icon svg circle { fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; }
	button.icon svg .fill { fill:currentColor; stroke:none; }
	button.icon.on { background:rgba(21,210,116,0.22); color:#15d274; }
	.tabs { display:inline-flex; gap:2px; padding:2px; background:var(--vscode-input-background); border-radius:8px; }
	.tab { padding:4px 14px; font-size:12px; cursor:pointer; color:var(--vscode-foreground); border-radius:6px; }
	.tab.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); font-weight:500; }
	.page { flex:1; min-height:0; display:none; }
	.page.active { display:flex; }
	/* logs */
	#list { width:240px; flex:0 0 240px; border-right:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); display:flex; flex-direction:column; }
	#listRows { flex:1; overflow:auto; }
	.row { padding:5px 8px; font-size:12px; cursor:pointer; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
	.row:hover { background:var(--vscode-list-hoverBackground); }
	.row.sel { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
	.meta { font-size:11px; opacity:0.75; font-family:var(--vscode-editor-font-family,monospace); }
	.err { color:var(--vscode-errorForeground); }
	#traces { border-top:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); padding:6px 8px; font-size:11px; display:flex; align-items:center; justify-content:space-between; }
	.viewer { flex:1; display:flex; flex-direction:column; min-width:0; }
	.vtools { display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); flex-shrink:0; }
	.vtools input { flex:1; min-width:50px; height:26px; padding:2px 6px; font-size:11px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); border-radius:4px; }
	.vtools input.invalid { border-color:var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
	.qf { border-radius:11px; padding:3px 11px; }
	.qf.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	#listHead { padding:7px 10px; font-size:11px; opacity:0.7; display:flex; justify-content:space-between; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); }
	.row { padding:7px 10px; }
	.content { flex:1; margin:0; padding:8px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family:var(--vscode-editor-font-family,monospace); font-size:12px; line-height:1.4; }
	.content mark { background:var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.4)); color:inherit; border-radius:2px; }
	.content.error { color:var(--vscode-errorForeground); }
	.muted { opacity:0.6; }
	/* soql results table */
	#soqlResults table { border-collapse:collapse; width:100%; font-size:12px; }
	#soqlResults th, #soqlResults td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); padding:3px 8px; text-align:left; white-space:nowrap; vertical-align:top; max-width:360px; overflow:hidden; text-overflow:ellipsis; }
	#soqlResults th { position:sticky; top:0; background:var(--vscode-editor-background); z-index:1; }
	#soqlResults tr:nth-child(even) td { background:rgba(128,128,128,0.06); }
	#soqlResults td:has(.nested) { white-space:normal; max-width:none; padding:2px; }
	#soqlResults table.nested { border-collapse:collapse; width:100%; font-size:11px; margin:0; }
	#soqlResults table.nested th, #soqlResults table.nested td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding:2px 6px; white-space:nowrap; }
	#soqlResults table.nested th { position:static; background:rgba(128,128,128,0.12); }
	#soqlResults .rownum { color:var(--vscode-descriptionForeground); text-align:right; }
	/* execute */
	#editor { flex:1 1 auto; min-width:120px; border:1px solid var(--vscode-input-border, transparent); border-radius:4px; overflow:hidden; }
	#splitX { flex:0 0 8px; width:8px; cursor:col-resize; display:flex; justify-content:center; }
	#splitX::before { content:''; display:block; height:100%; width:3px; border-radius:2px; background:var(--vscode-panel-border, rgba(128,128,128,0.3)); }
	#execResults { flex:0 0 auto; width:45%; min-width:140px; display:flex; flex-direction:column; border:1px solid var(--vscode-input-border, transparent); border-radius:4px; overflow:hidden; }
	#execPage { flex-direction:column; padding:6px; gap:6px; }
	#execTop { flex:1; display:flex; min-height:0; }
	#execActions { display:flex; gap:8px; flex-shrink:0; }
	${resultsTableCss()}
</style></head>
<body>
<script type="application/json" id="wb-data">${data}</script>
<div id="bar">
	<span class="tabs"><span class="tab active" data-t="logs">Logs</span><span class="tab" data-t="exec">Anonymous Apex</span><span class="tab" data-t="soql">SOQL</span></span>
	<span style="flex:1;"></span>
	<span id="busy" title="Loading schema from the org…"><span class="spinner"></span>schema…</span>
	<select id="org" title="Target org for logs, execution and queries"><option value="">Loading…</option></select>
	<span id="tracePill" title="Active debug traces">Trace: —</span>
</div>

<div id="page-logs" class="page active">
	<div id="list">
		<div id="listHead">
			<span>Debug logs <span id="logCount"></span></span>
			<span style="display:inline-flex; gap:4px;">
				<button id="listen" class="icon" title="Listen for new logs (poll)" aria-label="Listen for new logs"><svg viewBox="0 0 16 16"><circle class="fill" cx="8" cy="8" r="1.6"/><path d="M4.8 4.8a4.5 4.5 0 0 0 0 6.4"/><path d="M11.2 4.8a4.5 4.5 0 0 1 0 6.4"/></svg></button>
				<button id="refresh" class="icon" title="Refresh logs &amp; traces" aria-label="Refresh"><svg viewBox="0 0 16 16"><path d="M13.6 8a5.6 5.6 0 1 1-1.7-4"/><path d="M13.9 2.3v3.2h-3.2"/></svg></button>
				<button id="deleteAll" class="icon" title="Delete all logs" aria-label="Delete all logs"><svg viewBox="0 0 16 16"><path d="M2.8 4.2h10.4"/><path d="M6 4.2V2.6h4v1.6"/><path d="M4.6 4.2l.6 9.2h5.6l.6-9.2"/></svg></button>
			</span>
		</div>
		<div id="listRows"><div class="muted" style="padding:8px;">Loading logs…</div></div>
		<div id="traces">
			<span class="lbl">Traces</span>
			<span style="display:inline-flex; gap:4px;">
				<button id="quickTrace" class="icon" title="Quick trace (selected org)" aria-label="Quick trace"><svg viewBox="0 0 16 16"><path class="fill" d="M9 1.5 3.5 9H7l-1 5.5L12 6.5H8.5l.5-5z"/></svg></button>
				<button id="newTrace" class="icon" title="New trace (choose duration)" aria-label="New trace"><svg viewBox="0 0 16 16"><path d="M8 3v10"/><path d="M3 8h10"/></svg></button>
				<button id="refreshTraces" class="icon" title="Refresh traces" aria-label="Refresh traces"><svg viewBox="0 0 16 16"><path d="M13.6 8a5.6 5.6 0 1 1-1.7-4"/><path d="M13.9 2.3v3.2h-3.2"/></svg></button>
			</span>
		</div>
	</div>
	<div class="viewer">
		<div class="vtools">
			<button class="qf" data-pane="log" data-f="debug" title="Toggle USER_DEBUG, exceptions and errors">Debug</button>
			<button class="qf" data-pane="log" data-f="soql" title="Toggle SOQL and DML">SOQL/DML</button>
			<input data-pane="log" type="text" placeholder="Filter (regex)…" spellcheck="false" />
			<button id="logOpen" class="icon" title="Open this log in an editor" aria-label="Open log in editor"><svg viewBox="0 0 16 16"><path d="M9 3h4v4"/><path d="M13 3 7.5 8.5"/><path d="M11 9.5V13H3V5h3.5"/></svg></button>
		</div>
		<pre id="logContent" class="content muted">Select a log to view it.</pre>
	</div>
</div>

<div id="page-exec" class="page" style="flex-direction:column; padding:6px; gap:6px;">
	<div id="execTop">
		<div id="editor"></div>
		<div id="splitX"></div>
		<div id="execResults">
			<div class="vtools">
				<span id="execTitle" style="font-size:11px; opacity:0.9; margin-right:auto;">Result</span>
				<button class="qf" data-pane="exec" data-f="debug" title="Toggle USER_DEBUG, exceptions and errors">Debug</button>
				<button class="qf" data-pane="exec" data-f="soql" title="Toggle SOQL and DML">SOQL/DML</button>
				<input data-pane="exec" type="text" placeholder="Filter (regex)…" spellcheck="false" style="display:none;" />
				<button id="execOpen" title="Open the debug log in an editor" style="display:none;">Open log</button>
			</div>
			<pre id="execContent" class="content muted">Run code to see the result and debug log here.</pre>
		</div>
	</div>
	<div id="execActions">
		<button id="run" class="primary" title="Execute (Ctrl+Enter)">Execute</button>
		<button id="clear">Clear</button>
		<select id="history" title="Reopen a previous snippet" style="margin-left:auto; max-width:240px;"><option value="">History</option></select>
	</div>
</div>

<div id="page-soql" class="page" style="flex-direction:column; padding:6px; gap:6px;">
	<div id="soqlTop" style="flex:1; display:flex; min-height:0;">
		<div id="soqlEditor" style="flex:0 0 42%; min-width:160px; border:1px solid var(--vscode-input-border, transparent); border-radius:4px; overflow:hidden;"></div>
		<div id="soqlSplit" style="flex:0 0 8px; cursor:col-resize; display:flex; justify-content:center;"><span style="height:100%; width:3px; border-radius:2px; background:var(--vscode-panel-border, rgba(128,128,128,0.3));"></span></div>
		<div id="soqlResultsPane" style="flex:1; min-width:0; display:flex; flex-direction:column; border:1px solid var(--vscode-input-border, transparent); border-radius:4px; overflow:hidden;">
			<div class="vtools"><span id="soqlStatus" class="muted" style="margin-right:auto;">Run a query to see results.</span><span id="soqlCtl" class="rt-ctl"></span></div>
			<div id="soqlResults" style="flex:1; overflow:auto;"></div>
		</div>
	</div>
	<div id="execActions">
		<button id="runSoql" class="primary" title="Run query (Ctrl+Enter)">Run</button>
		<button id="openSoqlWb">Open in SOQL Workbench</button>
		<button id="clearSoql">Clear</button>
	</div>
</div>

<script src="${monacoBase}/loader.js"></script>
<script>${resultsTableScript()}</script>
<script>
	const vscode = acquireVsCodeApi();
	let initial = { highlightPatterns: [], code: '' };
	try { initial = JSON.parse(document.getElementById('wb-data').textContent); } catch (e) {}
	const orgSel = document.getElementById('org');
	function orgVal(){ return (orgSel.value||'').trim(); }

	const HL = (initial.highlightPatterns||[]).map(function(p){
		let re=null; try{re=new RegExp(p.pattern,'i');}catch(e){}
		let s=''; const fg=(p.foreground||'').replace(/[^#\\w(),.%\\s-]/g,'');
		if(fg) s+='color:'+fg+';'; if(p.fontStyle&&p.fontStyle.indexOf('bold')>=0) s+='font-weight:bold;'; if(p.fontStyle&&p.fontStyle.indexOf('italic')>=0) s+='font-style:italic;';
		return {re:re, style:s};
	}).filter(function(p){return p.re&&p.style;});
	function lineStyle(line){ for(let i=0;i<HL.length;i++){HL[i].re.lastIndex=0; if(HL[i].re.test(line)) return HL[i].style;} return ''; }
	function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
	function hl(line,re){ if(!re) return esc(line); let o='',last=0,m; re.lastIndex=0; while((m=re.exec(line))!==null){ o+=esc(line.slice(last,m.index))+'<mark>'+esc(m[0])+'</mark>'; last=m.index+m[0].length; if(m.index===re.lastIndex) re.lastIndex++; } return o+esc(line.slice(last)); }
	const EVENT=/^\\d{2}:\\d{2}:\\d{2}\\./;

	// A reusable log viewer bound to a content <pre>, a filter input and its toggle buttons.
	function makeViewer(contentEl, filterEl){
		const toggles={debug:false,soql:false}; let raw='';
		function applyToggles(lines){ if(!toggles.debug&&!toggles.soql) return lines; const out=[]; let keep=false;
			for(let i=0;i<lines.length;i++){ const l=lines[i];
				if(EVENT.test(l)){ let m=false;
					if(toggles.debug&&(l.indexOf('|USER_DEBUG|')>=0||l.indexOf('FATAL_ERROR')>=0||l.indexOf('EXCEPTION_THROWN')>=0||l.indexOf('|ERROR|')>=0)) m=true;
					if(!m&&toggles.soql&&(l.indexOf('|SOQL_EXECUTE')>=0||l.indexOf('|DML_')>=0)) m=true;
					keep=m; if(m) out.push(l);
				} else if(keep) out.push(l);
			} return out; }
		function render(){ contentEl.classList.remove('error','muted');
			const q=(filterEl.value||'').trim(); let re=null;
			if(q){ try{re=new RegExp(q,'gi'); filterEl.classList.remove('invalid');}catch(e){filterEl.classList.add('invalid'); re=null;} } else filterEl.classList.remove('invalid');
			const lines=applyToggles(raw.split('\\n')); const out=[]; const MAX=8000; let truncated=false;
			for(let i=0;i<lines.length;i++){ const l=lines[i]; if(re){re.lastIndex=0; if(!re.test(l)) continue;}
				if(out.length>=MAX){ truncated=true; break; }
				const inner=hl(l,re); const st=lineStyle(l); out.push(st?'<span style="'+st+'">'+inner+'</span>':inner); }
			if(!out.length){ contentEl.innerHTML='<span class="muted">No matching lines.</span>'; return; }
			contentEl.innerHTML=out.join('\\n')+(truncated?('\\n<span class="muted">… showing first '+MAX+' of '+lines.length+' lines — filter, or Open to see all.</span>'):''); }
		filterEl.addEventListener('input', render);
		return { setLog:function(t){ raw=t||''; render(); contentEl.scrollTop=0; }, render:render, toggles:toggles,
			setText:function(t,muted){ raw=''; contentEl.classList.toggle('muted',!!muted); contentEl.classList.remove('error'); contentEl.textContent=t||''; },
			setError:function(t){ raw=''; contentEl.classList.remove('muted'); contentEl.classList.add('error'); contentEl.textContent=t||''; } };
	}
	const logView = makeViewer(document.getElementById('logContent'), document.querySelector('input[data-pane="log"]'));
	const execView = makeViewer(document.getElementById('execContent'), document.querySelector('input[data-pane="exec"]'));
	Array.prototype.forEach.call(document.querySelectorAll('.qf'), function(b){ b.onclick=function(){ const v=b.getAttribute('data-pane')==='log'?logView:execView; const f=b.getAttribute('data-f'); v.toggles[f]=!v.toggles[f]; b.classList.toggle('active',v.toggles[f]); v.render(); }; });

	// ── tabs ──────────────────────────────────────────────────────────────────
	function setTab(t){ Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(el){el.classList.toggle('active',el.getAttribute('data-t')===t);});
		document.getElementById('page-logs').classList.toggle('active', t==='logs');
		document.getElementById('page-exec').classList.toggle('active', t==='exec');
		document.getElementById('page-soql').classList.toggle('active', t==='soql');
		// Monaco editors created in a hidden tab lay out at 0px — relayout on show.
		setTimeout(function(){ if(t==='exec'&&editor) editor.layout(); if(t==='soql'&&soqlEd) soqlEd.layout(); }, 0); }
	Array.prototype.forEach.call(document.querySelectorAll('.tab'), function(el){ el.onclick=function(){ setTab(el.getAttribute('data-t')); }; });

	// ── logs ──────────────────────────────────────────────────────────────────
	const listRows=document.getElementById('listRows'); let currentId=''; let lastRows=[]; const unitById={};
	function fmtTime(s){ try{const d=new Date(s); return isNaN(d)?s:d.toLocaleTimeString();}catch(e){return s;} }
	function fmtSize(n){ if(!n) return ''; if(n<1024) return n+' B'; if(n<1048576) return Math.round(n/1024)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
	function renderList(rows){ lastRows=rows||[]; document.getElementById('logCount').textContent=(rows&&rows.length)?rows.length:'';
		if(!rows||!rows.length){ listRows.innerHTML='<div class="muted" style="padding:8px;">No logs.</div>'; return; }
		listRows.innerHTML=rows.map(function(r){ const err=r.status&&r.status.toLowerCase()!=='success'; const unit=unitById[r.id];
			const head = unit ? esc(unit) : (esc(r.operation||'')||fmtTime(r.startTime));
			return '<div class="row" data-id="'+r.id+'"><div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'+head+'</div><div class="meta'+(err?' err':'')+'">'+fmtTime(r.startTime)+' · '+esc(r.status||'')+' · '+fmtSize(r.length)+'</div></div>'; }).join('');
		Array.prototype.forEach.call(listRows.querySelectorAll('.row'), function(el){
			if(el.getAttribute('data-id')===currentId) el.classList.add('sel'); // keep selection across refreshes
			el.onclick=function(){
				Array.prototype.forEach.call(listRows.querySelectorAll('.row'),function(r){r.classList.remove('sel');}); el.classList.add('sel');
				currentId=el.getAttribute('data-id'); logView.setText('Loading log…', true); vscode.postMessage({type:'openLog', org:orgVal(), id:currentId}); }; }); }
	function loadLogs(){ listRows.innerHTML='<div class="muted" style="padding:8px;">Loading…</div>'; vscode.postMessage({type:'listLogs', org:orgVal()}); vscode.postMessage({type:'listTraces', org:orgVal()}); }
	document.getElementById('logOpen').onclick=function(){ if(currentId) vscode.postMessage({type:'openLogInEditor', org:orgVal(), id:currentId}); };
	document.getElementById('quickTrace').onclick=function(){ vscode.postMessage({type:'quickTrace', org:orgVal()}); };
	document.getElementById('newTrace').onclick=function(){ vscode.postMessage({type:'newTrace', org:orgVal()}); };
	document.getElementById('refreshTraces').onclick=function(){ vscode.postMessage({type:'listTraces', org:orgVal()}); };
	document.getElementById('deleteAll').onclick=function(){ vscode.postMessage({type:'deleteAllLogs', org:orgVal()}); };
	document.getElementById('refresh').onclick=loadLogs;

	// Switching org: clear the loaded data, then warm + auto-refresh for the new org.
	orgSel.addEventListener('change', function(){
		currentId='';
		logView.setText('Select a log to view it.', true);
		execView.setText('Run code to see the result and debug log here.', true);
		document.getElementById('execTitle').textContent='Result';
		document.getElementById('execOpen').style.display='none';
		document.querySelector('input[data-pane="exec"]').style.display='none';
		const pill=document.getElementById('tracePill'); pill.classList.remove('on'); pill.textContent='Trace: —';
		vscode.postMessage({type:'warmOrg', org:orgVal()});
		scheduleSoqlValidate();
		loadLogs();
	});

	// Listen for new logs: poll the selected org's log list on an interval.
	let listenTimer=null; const pollMs=Math.max(2,(initial.pollSeconds||5))*1000;
	const listenBtn=document.getElementById('listen');
	listenBtn.onclick=function(){
		if(listenTimer){ clearInterval(listenTimer); listenTimer=null; listenBtn.classList.remove('on'); listenBtn.title='Listen for new logs (poll)'; }
		else { listenBtn.classList.add('on'); listenBtn.title='Listening… (click to stop)'; vscode.postMessage({type:'listLogs', org:orgVal()});
			listenTimer=setInterval(function(){ vscode.postMessage({type:'listLogs', org:orgVal()}); }, pollMs); }
	};

	// ── execute editor ─────────────────────────────────────────────────────────
	let editor=null, saveTimer=null, reqId=0; const pending={};
	let busyCount=0; function setBusy(d){ busyCount=Math.max(0,busyCount+d); const b=document.getElementById('busy'); if(b) b.style.display=busyCount>0?'inline-flex':'none'; }
	let soqlEd=null, soqlTimer=null;
	function mapKind(k){ const M=monaco.languages.CompletionItemKind; const T={0:M.Text,1:M.Method,2:M.Function,3:M.Constructor,4:M.Field,5:M.Variable,6:M.Class,7:M.Interface,8:M.Module,9:M.Property,10:M.Unit,11:M.Value,12:M.Enum,13:M.Keyword,14:M.Snippet,15:M.Color,16:M.File,17:M.Reference,18:M.Folder,19:M.EnumMember,20:M.Constant,21:M.Struct,22:M.Event,23:M.Operator,24:M.TypeParameter}; return T[k]!=null?T[k]:M.Text; }
	require.config({ paths:{ vs:'${monacoBase}' } });
	self.MonacoEnvironment={ getWorkerUrl:function(){ return URL.createObjectURL(new Blob(["self.MonacoEnvironment={baseUrl:'"+'${monacoBase}'+"/'};importScripts('"+'${monacoBase}'+"/base/worker/workerMain.js');"],{type:'text/javascript'})); } };
	require(['vs/editor/editor.main'], function(){
		monaco.languages.register({ id:'apex' });
		monaco.languages.setMonarchTokensProvider('apex', { ignoreCase:true,
			keywords:['abstract','after','before','break','catch','class','continue','delete','do','else','enum','extends','final','finally','for','get','global','if','implements','insert','instanceof','interface','merge','new','null','on','override','private','protected','public','return','set','static','super','switch','testmethod','this','throw','transient','trigger','try','undelete','update','upsert','virtual','void','webservice','when','while','with','without','sharing','true','false','select','from','where','limit','order','by','group','having','and','or','not','like','in'],
			typeKeywords:['Boolean','Date','Datetime','Decimal','Double','Id','Integer','Long','Object','String','Blob','Time','List','Map','Set','SObject','Account','Contact','System','Database','Test','Schema','Limits'],
			tokenizer:{ root:[[/\\/\\/.*$/,'comment'],[/\\/\\*/,'comment','@comment'],[/'(?:[^'\\\\]|\\\\.)*'/,'string'],[/@[a-zA-Z_][\\w]*/,'annotation'],[/\\[/,'string.soql','@soql'],[/\\b\\d+(\\.\\d+)?\\b/,'number'],[/[a-zA-Z_][\\w]*/,{cases:{'@keywords':'keyword','@typeKeywords':'type','@default':'identifier'}}]],
				comment:[[/[^*/]+/,'comment'],[/\\*\\//,'comment','@pop'],[/[*/]/,'comment']],
				soql:[[/'(?:[^'\\\\]|\\\\.)*'/,'string'],[/\\]/,'string.soql','@pop'],[/[a-zA-Z_][\\w]*/,{cases:{'@keywords':'keyword','@default':'identifier'}}],[/./,'string.soql']] } });
		monaco.languages.setLanguageConfiguration('apex',{ comments:{lineComment:'//',blockComment:['/*','*/']}, brackets:[['{','}'],['[',']'],['(',')']], autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'(',close:')'},{open:"'",close:"'"}] });
		monaco.languages.registerHoverProvider('apex',{ provideHover:function(model,pos){ return new Promise(function(resolve){ const id=++reqId; pending[id]=function(h){ if(!h||!h.contents||!h.contents.length){resolve(null);return;} const w=model.getWordAtPosition(pos); const range=w?{startLineNumber:pos.lineNumber,endLineNumber:pos.lineNumber,startColumn:w.startColumn,endColumn:w.endColumn}:undefined; resolve({range:range,contents:h.contents.map(function(v){return{value:v};})}); }; setBusy(1); vscode.postMessage({type:'getHover',requestId:id,text:model.getValue(),line:pos.lineNumber-1,character:pos.column-1}); }); } });
		monaco.languages.registerCompletionItemProvider('apex',{ triggerCharacters:['.',' ','(',',','_'], provideCompletionItems:function(model,pos){ return new Promise(function(resolve){ const id=++reqId; pending[id]=function(items){ const w=model.getWordUntilPosition(pos); const range={startLineNumber:pos.lineNumber,endLineNumber:pos.lineNumber,startColumn:w.startColumn,endColumn:w.endColumn}; resolve({suggestions:items.map(function(it){ return {label:it.label,kind:mapKind(it.kind),insertText:it.insertText||it.label,insertTextRules:it.isSnippet?monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet:undefined,detail:it.detail,documentation:it.documentation?{value:it.documentation}:undefined,sortText:it.sortText,filterText:it.filterText,range:range}; })}); }; setBusy(1); vscode.postMessage({type:'getCompletions',requestId:id,text:model.getValue(),line:pos.lineNumber-1,character:pos.column-1}); }); } });
		const dark=document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
		editor=monaco.editor.create(document.getElementById('editor'),{ value:initial.code||'', language:'apex', theme:dark?'vs-dark':'vs', automaticLayout:true, minimap:{enabled:false}, scrollBeyondLastLine:false, fontSize:13, tabSize:4, quickSuggestions:true, quickSuggestionsDelay:200, fixedOverflowWidgets:true });
		editor.onDidChangeModelContent(function(){ if(saveTimer) clearTimeout(saveTimer); saveTimer=setTimeout(function(){ vscode.postMessage({type:'contentChanged',code:editor.getValue()}); },500); });
		editor.onMouseDown(function(e){ if((e.event.ctrlKey||e.event.metaKey)&&e.target&&e.target.position){ const p=e.target.position; vscode.postMessage({type:'gotoDefinition',text:editor.getValue(),line:p.lineNumber-1,character:p.column-1}); } });
		// addAction (not addCommand) scopes the keybinding to THIS editor instance; with two
		// editors, addCommand's shared registry let the SOQL editor clobber Cmd+Enter here.
		editor.addAction({ id:'asfx.execApex', label:'Execute Anonymous Apex', keybindings:[monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter, monaco.KeyMod.WinCtrl|monaco.KeyCode.Enter], run:function(){ doRun(); } });

		// ── SOQL editor ───────────────────────────────────────────────────────
		monaco.languages.register({ id:'soql' });
		monaco.languages.setMonarchTokensProvider('soql',{ ignoreCase:true,
			keywords:['SELECT','FROM','WHERE','LIMIT','OFFSET','ORDER','BY','GROUP','HAVING','AND','OR','NOT','LIKE','IN','INCLUDES','EXCLUDES','ASC','DESC','NULLS','FIRST','LAST','COUNT','COUNT_DISTINCT','AVG','MIN','MAX','SUM','TYPEOF','WHEN','THEN','ELSE','END','USING','SCOPE','FOR','VIEW','REFERENCE','UPDATE','TRACKING','NULL','TRUE','FALSE'],
			tokenizer:{ root:[[/'(?:[^'\\\\]|\\\\.)*'/,'string'],[/\\b\\d+(\\.\\d+)?\\b/,'number'],[/[a-zA-Z_][\\w.]*/,{cases:{'@keywords':'keyword','@default':'identifier'}}]] } });
		soqlEd=monaco.editor.create(document.getElementById('soqlEditor'),{ value:initial.soql||'SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 50', language:'soql', theme:dark?'vs-dark':'vs', automaticLayout:true, minimap:{enabled:false}, scrollBeyondLastLine:false, fontSize:13, quickSuggestions:true, quickSuggestionsDelay:200, fixedOverflowWidgets:true });
		soqlEd.onDidChangeModelContent(function(){ if(soqlTimer) clearTimeout(soqlTimer); soqlTimer=setTimeout(function(){ vscode.postMessage({type:'soqlChanged',query:soqlEd.getValue()}); },500); });
		soqlEd.onDidChangeModelContent(scheduleSoqlValidate);
		scheduleSoqlValidate();
		soqlEd.addAction({ id:'asfx.runSoql', label:'Run SOQL Query', keybindings:[monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter, monaco.KeyMod.WinCtrl|monaco.KeyCode.Enter], run:function(){ doRunSoql(); } });
		monaco.languages.registerCompletionItemProvider('soql',{ triggerCharacters:['.',' ',',','('], provideCompletionItems:function(model,pos){ return new Promise(function(resolve){ const id=++reqId; pending[id]=function(items){ const w=model.getWordUntilPosition(pos); const range={startLineNumber:pos.lineNumber,endLineNumber:pos.lineNumber,startColumn:w.startColumn,endColumn:w.endColumn}; resolve({suggestions:items.map(function(it){ return {label:it.label,kind:mapKind(it.kind),insertText:it.insertText||it.label,insertTextRules:it.isSnippet?monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet:undefined,detail:it.detail,documentation:it.documentation?{value:it.documentation}:undefined,sortText:it.sortText,filterText:it.filterText,range:range}; })}); }; setBusy(1); vscode.postMessage({type:'getSoqlCompletions',requestId:id,text:model.getValue(),line:pos.lineNumber-1,character:pos.column-1}); }); } });
		monaco.languages.registerHoverProvider('soql',{ provideHover:function(model,pos){ return new Promise(function(resolve){ const id=++reqId; pending[id]=function(h){ if(!h||!h.contents||!h.contents.length){resolve(null);return;} resolve({contents:h.contents.map(function(v){return{value:v};})}); }; setBusy(1); vscode.postMessage({type:'getSoqlHover',requestId:id,text:model.getValue(),line:pos.lineNumber-1,character:pos.column-1}); }); } });
	});
	function flush(){ if(!editor) return; if(saveTimer){clearTimeout(saveTimer);saveTimer=null;} vscode.postMessage({type:'contentChanged',code:editor.getValue()}); }
	window.addEventListener('blur', flush);
	function doRun(){ vscode.postMessage({type:'execute', code:editor?editor.getValue():'', org:orgVal()||undefined}); }
	document.getElementById('run').onclick=doRun;
	document.getElementById('clear').onclick=function(){ if(editor){editor.setValue('');editor.focus();} vscode.postMessage({type:'contentChanged',code:''}); };

	// ── SOQL tab actions ────────────────────────────────────────────────────────
	function doRunSoql(){ if(!soqlEd) return; vscode.postMessage({type:'runSoql', org:orgVal()||undefined, query:soqlEd.getValue()}); }
	let soqlValTimer=null;
	function scheduleSoqlValidate(){ if(soqlValTimer) clearTimeout(soqlValTimer); soqlValTimer=setTimeout(function(){ if(soqlEd) vscode.postMessage({type:'validateSoql', org:orgVal(), query:soqlEd.getValue()}); },400); }
	document.getElementById('runSoql').onclick=doRunSoql;
	document.getElementById('openSoqlWb').onclick=function(){ vscode.postMessage({type:'openSoqlWorkbench', query:soqlEd?soqlEd.getValue():'', org:orgVal()}); };
	document.getElementById('clearSoql').onclick=function(){ if(soqlEd){soqlEd.setValue('');soqlEd.focus();} vscode.postMessage({type:'soqlChanged',query:''}); };
	(function(){ const sp=document.getElementById('soqlSplit'); const ed=document.getElementById('soqlEditor'); let drag=false,sx=0,sw=0;
		sp.addEventListener('mousedown',function(e){drag=true;sx=e.clientX;sw=ed.getBoundingClientRect().width;document.body.style.cursor='col-resize';document.body.style.userSelect='none';e.preventDefault();});
		window.addEventListener('mousemove',function(e){ if(!drag)return; const max=Math.max(160,window.innerWidth-200); ed.style.flex='0 0 '+Math.min(max,Math.max(160,sw+(e.clientX-sx)))+'px'; });
		window.addEventListener('mouseup',function(){drag=false;document.body.style.cursor='';document.body.style.userSelect='';}); })();
	function setSoqlErrMarker(line,col,text){ if(!soqlEd||!line) return; try{ const model=soqlEd.getModel(); let c=col||1,e=c+1; const w=model.getWordAtPosition({lineNumber:line,column:c}); if(w){c=w.startColumn;e=w.endColumn;} monaco.editor.setModelMarkers(model,'asfx-soql-error',[{severity:monaco.MarkerSeverity.Error,message:text,startLineNumber:line,startColumn:c,endLineNumber:line,endColumn:e}]); }catch(x){} }
	function clearSoqlErrMarker(){ if(soqlEd) try{ monaco.editor.setModelMarkers(soqlEd.getModel(),'asfx-soql-error',[]); }catch(x){} }
	const soqlTable = ASFXResults({ mount: document.getElementById('soqlResults'), controls: document.getElementById('soqlCtl'), post: vscode.postMessage, getOrg: function(){ return orgVal(); }, onRefresh: function(){ doRunSoql(); } });
	function renderSoql(d){ const status=document.getElementById('soqlStatus');
		if(d.error){ status.className=''; status.style.color='var(--vscode-errorForeground)'; status.textContent=d.error;
			document.getElementById('soqlResults').innerHTML = d.errorDetails ? '<pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:8px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;opacity:0.85;">'+esc(d.errorDetails)+'</pre>' : '';
			setSoqlErrMarker(d.errorLine,d.errorColumn,d.error); return; }
		clearSoqlErrMarker();
		status.style.color=''; status.className='muted';
		const recs=d.records||[];
		status.textContent=(d.returned||recs.length)+' of '+(d.total||recs.length)+' rows'+(d.done===false?' · more available, open in workbench':'');
		soqlTable.setData(recs); }
	const historySel=document.getElementById('history');
	function setHistory(items){ while(historySel.options.length>1) historySel.remove(1);
		(items||[]).forEach(function(q){ const o=document.createElement('option'); o.value=q; o.textContent=(q.length>50?q.slice(0,47)+'…':q).replace(/\\s+/g,' '); o.title=q; historySel.appendChild(o); }); }
	setHistory(initial.history);
	historySel.addEventListener('change', function(){ const code=historySel.value; if(code&&editor){ editor.setValue(code); editor.focus(); vscode.postMessage({type:'contentChanged',code:code}); } historySel.selectedIndex=0; });
	const execTitle=document.getElementById('execTitle'); const execFilter=document.querySelector('input[data-pane="exec"]'); const execOpen=document.getElementById('execOpen');
	execOpen.onclick=function(){ vscode.postMessage({type:'openExecLog'}); };

	// ── execute results splitter ────────────────────────────────────────────────
	(function(){ const sp=document.getElementById('splitX'); const pane=document.getElementById('execResults'); let drag=false,sx=0,sw=0;
		sp.addEventListener('mousedown',function(e){ drag=true; sx=e.clientX; sw=pane.getBoundingClientRect().width; document.body.style.cursor='col-resize'; document.body.style.userSelect='none'; e.preventDefault(); });
		window.addEventListener('mousemove',function(e){ if(!drag) return; const max=Math.max(140,window.innerWidth-160); pane.style.width=Math.min(max,Math.max(140,sw+(sx-e.clientX)))+'px'; });
		window.addEventListener('mouseup',function(){ drag=false; document.body.style.cursor=''; document.body.style.userSelect=''; }); })();

	// ── messages ────────────────────────────────────────────────────────────────
	window.addEventListener('message', function(e){ const d=e.data; if(!d) return;
		if(d.type && d.type.indexOf('rt:')===0){ soqlTable.handleMessage(d); return; }
		if(d.type==='completionResult'){ setBusy(-1); const cb=pending[d.requestId]; if(cb){ delete pending[d.requestId]; cb(d.items||[]); } return; }
		if(d.type==='hoverResult'){ setBusy(-1); const cb=pending[d.requestId]; if(cb){ delete pending[d.requestId]; cb(d.hover||null); } return; }
		if(d.type==='revealDefinition'){ if(editor){ const ln=(d.line||0)+1, col=(d.character||0)+1; editor.setPosition({lineNumber:ln,column:col}); editor.revealLineInCenter(ln); editor.focus(); } return; }
		if(d.type==='soqlMarkers'){ if(soqlEd){ try{ monaco.editor.setModelMarkers(soqlEd.getModel(),'asfx-soql',(d.markers||[]).map(function(m){ return {severity:monaco.MarkerSeverity.Error,message:m.message,startLineNumber:m.line+1,startColumn:m.startCol+1,endLineNumber:m.line+1,endColumn:m.endCol+1}; })); }catch(e){} } return; }
		if(d.type==='soqlStarted'){ const s=document.getElementById('soqlStatus'); s.className='muted'; s.style.color=''; s.textContent='Running…'; document.getElementById('soqlResults').innerHTML=''; return; }
		if(d.type==='soqlResult'){ renderSoql(d); return; }
		if(d.type==='orgList'){ const orgs=d.orgs||[];
			orgSel.innerHTML=orgs.length?orgs.map(function(o){ const def=(o.label||'').indexOf('(default)')>=0; const v=def?'':(o.username||''); return '<option value="'+v.replace(/"/g,'&quot;')+'">'+(o.label||o.username||'').replace(/</g,'&lt;')+'</option>'; }).join(''):'<option value="">No orgs</option>';
			vscode.postMessage({type:'warmOrg', org:orgVal()}); loadLogs(); }
		else if(d.type==='logList'){ if((d.org||'')!==orgVal()) return; if(d.units){ for(const k in d.units) unitById[k]=d.units[k]; } renderList(d.rows||[]); }
		else if(d.type==='logUnit'){ if((d.org||'')!==orgVal()||!d.unit) return; unitById[d.id]=d.unit; const row=listRows.querySelector('.row[data-id="'+d.id+'"]'); if(row&&row.firstElementChild) row.firstElementChild.textContent=d.unit; }
		else if(d.type==='logLoading'){ if(d.id===currentId) logView.setText('Loading log…', true); }
		else if(d.type==='logBody'){ if(d.unit){ unitById[d.id]=d.unit; const r=listRows.querySelector('.row[data-id="'+d.id+'"]'); if(r&&r.firstElementChild) r.firstElementChild.textContent=d.unit; } if(d.id===currentId) logView.setLog(d.text||''); }
		else if(d.type==='historyUpdated'){ setHistory(d.history||[]); }
		else if(d.type==='traceInfo'){ if((d.org||'')!==orgVal()) return;
			const pill=document.getElementById('tracePill'); pill.classList.toggle('on', d.count>0); pill.textContent= d.count>0 ? ('Trace: '+d.count+' on') : 'Trace: off'; }
		else if(d.type==='execStarted'){ execTitle.textContent='Running…'; execOpen.style.display='none'; execFilter.style.display='none'; execView.setText('Executing…', true); }
		else if(d.type==='execResult'){
			if(!d.success){ execTitle.textContent='Error'; execOpen.style.display='none'; execFilter.style.display='none'; execView.setError(d.error||'Execution failed.'); }
			else if(d.hasLog){ execTitle.textContent='Debug log'; execOpen.style.display='inline-block'; execFilter.style.display='inline-block'; execView.setLog(d.log||''); }
			else { execTitle.textContent='Result'; execOpen.style.display='none'; execFilter.style.display='none'; execView.setText('Executed successfully.', true); } }
	});
	vscode.postMessage({type:'getOrgs'});
</script>
</body></html>`;
	}
}
