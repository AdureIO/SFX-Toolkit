import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getAnonymousApexOrgList } from '../commands/executeAnonymous';
import { listApexLogs, fetchApexLogBody } from '../utils/apexLogApi';
import { getHighlightPatterns } from '../utils/apexLogHighlight';
import { getSalesforceLogDirectory } from '../utils/logPaths';
import { AuthInfo } from '../utils/authInfo';
import { isSalesforceProject } from '../utils/projectUtils';

/**
 * The Apex Workbench — a bottom-panel webview that browses debug logs for the
 * org chosen in its own org switcher (so you can read logs from any environment)
 * and displays the selected log with the same category toggles, regex search and
 * configurable highlighting as the Execute Apex results pane. Coexists with the
 * sidebar Logs/Traces views and the standalone Execute panel.
 */
export class ApexWorkbenchViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _listener?: vscode.Disposable;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	private _post(type: string, payload: Record<string, unknown> = {}): void {
		this._view?.webview.postMessage({ type, ...payload });
	}

	public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this._view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};
		view.webview.html = this._html();

		this._listener?.dispose();
		this._listener = view.webview.onDidReceiveMessage(async (data: any) => {
			switch (data?.type) {
				case 'getOrgs':
					this._post('orgList', { orgs: await getAnonymousApexOrgList() });
					break;
				case 'warmOrg':
					if (isSalesforceProject()) AuthInfo.warmAuthForOrg(data.org || null);
					break;
				case 'listLogs': {
					const rows = await listApexLogs(data.org || null);
					this._post('logList', { org: data.org || '', rows });
					break;
				}
				case 'openLog': {
					this._post('logLoading', { id: data.id });
					const text = await fetchApexLogBody(data.org || null, data.id);
					this._post('logBody', { id: data.id, text });
					break;
				}
				case 'openInEditor': {
					const text = await fetchApexLogBody(data.org || null, data.id);
					if (!text) return;
					try {
						const dir = getSalesforceLogDirectory() || os.tmpdir();
						if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
						const file = path.join(dir, `${data.id}.log`);
						fs.writeFileSync(file, text, 'utf8');
						const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
						await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
					} catch {
						const doc = await vscode.workspace.openTextDocument({ content: text, language: 'salesforce-log' });
						await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
					}
					break;
				}
			}
		});

		view.onDidDispose(() => { this._listener?.dispose(); this._listener = undefined; });
	}

	private _html(): string {
		const initial = JSON.stringify({ highlightPatterns: getHighlightPatterns() })
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e');
		return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
	* { box-sizing: border-box; }
	body { margin:0; padding:0; height:100vh; display:flex; flex-direction:column; color:var(--vscode-foreground);
		background:var(--vscode-editor-background); font-family:var(--vscode-font-family); font-size:var(--vscode-font-size,13px); }
	#bar { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); flex-shrink:0; }
	.lbl { font-size:11px; opacity:0.8; }
	select { padding:3px 6px; font-size:12px; background:var(--vscode-input-background); color:var(--vscode-input-foreground);
		border:1px solid var(--vscode-input-border, transparent); border-radius:4px; max-width:240px; }
	button { font-size:11px; padding:3px 8px; border:none; border-radius:4px; cursor:pointer;
		background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	button:hover { background:var(--vscode-button-hoverBackground); }
	button.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	#body { flex:1; display:flex; min-height:0; }
	#list { width:240px; flex:0 0 240px; border-right:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); overflow:auto; }
	#list .row { padding:5px 8px; font-size:12px; cursor:pointer; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
	#list .row:hover { background:var(--vscode-list-hoverBackground); }
	#list .row.sel { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
	#list .meta { font-size:11px; opacity:0.75; font-family:var(--vscode-editor-font-family,monospace); }
	#list .err { color:var(--vscode-errorForeground); }
	#viewer { flex:1; display:flex; flex-direction:column; min-width:0; }
	#vtools { display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); flex-shrink:0; }
	#vtools input { flex:1; min-width:60px; height:26px; padding:2px 6px; font-size:11px;
		background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); border-radius:4px; }
	#vtools input.invalid { border-color:var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
	#content { flex:1; margin:0; padding:8px; overflow:auto; white-space:pre-wrap; word-break:break-word;
		font-family:var(--vscode-editor-font-family,monospace); font-size:12px; line-height:1.4; }
	#content mark { background:var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.4)); color:inherit; border-radius:2px; }
	.muted { opacity:0.6; }
</style></head>
<body>
<script type="application/json" id="wb-data">${initial}</script>
<div id="bar">
	<span class="lbl">Org</span>
	<select id="org"><option value="">Loading…</option></select>
	<button id="refresh" title="Refresh log list">Refresh</button>
</div>
<div id="body">
	<div id="list"><div class="muted" style="padding:8px;">Select an org to load logs.</div></div>
	<div id="viewer">
		<div id="vtools">
			<button class="qf" data-f="debug" title="Toggle USER_DEBUG, exceptions and errors">Debug</button>
			<button class="qf" data-f="soql" title="Toggle SOQL and DML">SOQL/DML</button>
			<input id="filter" type="text" placeholder="Filter (regex)…" spellcheck="false" />
			<button id="openEditor" title="Open this log in an editor">Open</button>
		</div>
		<pre id="content" class="muted">Select a log to view it.</pre>
	</div>
</div>
<script>
	const vscode = acquireVsCodeApi();
	const orgSel = document.getElementById('org');
	const listEl = document.getElementById('list');
	const content = document.getElementById('content');
	const filter = document.getElementById('filter');
	const refreshBtn = document.getElementById('refresh');
	const openEditorBtn = document.getElementById('openEditor');
	let initial = { highlightPatterns: [] };
	try { initial = JSON.parse(document.getElementById('wb-data').textContent); } catch (e) {}
	let rawLog = '', currentId = '';
	const activeToggles = { debug:false, soql:false };

	const HL = (initial.highlightPatterns||[]).map(function(p){
		let re=null; try{re=new RegExp(p.pattern,'i');}catch(e){}
		let s=''; const fg=(p.foreground||'').replace(/[^#\\w(),.%\\s-]/g,'');
		if(fg) s+='color:'+fg+';';
		if(p.fontStyle&&p.fontStyle.indexOf('bold')>=0) s+='font-weight:bold;';
		if(p.fontStyle&&p.fontStyle.indexOf('italic')>=0) s+='font-style:italic;';
		return {re:re, style:s};
	}).filter(function(p){return p.re&&p.style;});
	function lineStyle(line){ for(let i=0;i<HL.length;i++){HL[i].re.lastIndex=0; if(HL[i].re.test(line)) return HL[i].style;} return ''; }
	function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
	function hl(line, re){ if(!re) return esc(line); let o='',last=0,m; re.lastIndex=0;
		while((m=re.exec(line))!==null){ o+=esc(line.slice(last,m.index))+'<mark>'+esc(m[0])+'</mark>'; last=m.index+m[0].length; if(m.index===re.lastIndex) re.lastIndex++; }
		return o+esc(line.slice(last)); }
	const EVENT=/^\\d{2}:\\d{2}:\\d{2}\\./;
	function applyToggles(lines){ if(!activeToggles.debug&&!activeToggles.soql) return lines; const out=[]; let keep=false;
		for(let i=0;i<lines.length;i++){ const l=lines[i];
			if(EVENT.test(l)){ let m=false;
				if(activeToggles.debug&&(l.indexOf('|USER_DEBUG|')>=0||l.indexOf('FATAL_ERROR')>=0||l.indexOf('EXCEPTION_THROWN')>=0||l.indexOf('|ERROR|')>=0)) m=true;
				if(!m&&activeToggles.soql&&(l.indexOf('|SOQL_EXECUTE')>=0||l.indexOf('|DML_')>=0)) m=true;
				keep=m; if(m) out.push(l);
			} else if(keep) out.push(l);
		} return out; }
	function render(){ content.classList.remove('muted');
		const q=(filter.value||'').trim(); let re=null;
		if(q){ try{re=new RegExp(q,'gi'); filter.classList.remove('invalid');}catch(e){filter.classList.add('invalid'); re=null;} } else filter.classList.remove('invalid');
		const lines=applyToggles(rawLog.split('\\n')); const out=[];
		for(let i=0;i<lines.length;i++){ const l=lines[i]; if(re){re.lastIndex=0; if(!re.test(l)) continue;}
			const inner=hl(l,re); const st=lineStyle(l); out.push(st?'<span style="'+st+'">'+inner+'</span>':inner); }
		content.innerHTML=out.length?out.join('\\n'):'<span class="muted">No matching lines.</span>'; }

	function fmtTime(s){ try{ const d=new Date(s); return isNaN(d)?s:d.toLocaleTimeString(); }catch(e){return s;} }
	function fmtSize(n){ if(!n) return ''; if(n<1024) return n+' B'; if(n<1048576) return Math.round(n/1024)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
	function renderList(rows){
		if(!rows||!rows.length){ listEl.innerHTML='<div class="muted" style="padding:8px;">No logs for this org.</div>'; return; }
		listEl.innerHTML = rows.map(function(r){
			const err = r.status && r.status.toLowerCase()!=='success';
			return '<div class="row" data-id="'+r.id+'">'+fmtTime(r.startTime)+
				'<div class="meta'+(err?' err':'')+'">'+esc((r.operation||'')+' · '+(r.status||''))+' · '+fmtSize(r.length)+'</div></div>';
		}).join('');
		Array.prototype.forEach.call(listEl.querySelectorAll('.row'), function(el){
			el.onclick=function(){ selectRow(el); vscode.postMessage({type:'openLog', org:orgVal(), id:el.getAttribute('data-id')}); };
		});
	}
	function selectRow(el){ Array.prototype.forEach.call(listEl.querySelectorAll('.row'),function(r){r.classList.remove('sel');}); el.classList.add('sel'); currentId=el.getAttribute('data-id'); }
	function orgVal(){ return (orgSel.value||'').trim(); }
	function loadLogs(){ listEl.innerHTML='<div class="muted" style="padding:8px;">Loading…</div>'; vscode.postMessage({type:'listLogs', org:orgVal()}); }

	window.addEventListener('message', function(e){ const d=e.data; if(!d) return;
		if(d.type==='orgList'){ const orgs=d.orgs||[];
			orgSel.innerHTML = orgs.length ? orgs.map(function(o){ const def=(o.label||'').indexOf('(default)')>=0; const v=def?'':(o.username||'');
				return '<option value="'+v.replace(/"/g,'&quot;')+'">'+(o.label||o.username||'').replace(/</g,'&lt;')+'</option>'; }).join('') : '<option value="">No orgs</option>';
			vscode.postMessage({type:'warmOrg', org:orgVal()}); loadLogs();
		} else if(d.type==='logList'){ if((d.org||'')===orgVal()) renderList(d.rows||[]); }
		else if(d.type==='logLoading'){ if(d.id===currentId){ rawLog=''; content.classList.add('muted'); content.textContent='Loading log…'; } }
		else if(d.type==='logBody'){ if(d.id===currentId){ rawLog=d.text||''; render(); content.scrollTop=0; } }
	});

	orgSel.addEventListener('change', function(){ vscode.postMessage({type:'warmOrg', org:orgVal()}); loadLogs(); });
	refreshBtn.onclick=loadLogs;
	filter.addEventListener('input', render);
	openEditorBtn.onclick=function(){ if(currentId) vscode.postMessage({type:'openInEditor', org:orgVal(), id:currentId}); };
	Array.prototype.forEach.call(document.querySelectorAll('.qf'), function(b){ b.onclick=function(){ const f=b.getAttribute('data-f'); activeToggles[f]=!activeToggles[f]; b.classList.toggle('active',activeToggles[f]); render(); }; });

	vscode.postMessage({type:'getOrgs'});
</script>
</body></html>`;
	}
}
