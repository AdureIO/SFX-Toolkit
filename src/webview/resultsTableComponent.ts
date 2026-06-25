/**
 * One shared results table + type-aware cell editor, embedded by BOTH SOQL
 * surfaces (the SOQL Workbench panel and the ASFX Workbench SOQL tab). The host
 * answers three messages via resultsTableHost: rt:colMeta, rt:lookup, rt:save.
 *
 * Returns CSS + a `window.ASFXResults(opts)` factory (vanilla JS, no framework):
 *   const rt = ASFXResults({ mount, post, getOrg });
 *   rt.setData(records);            // raw SF records (with attributes.type)
 *   rt.handleMessage(msg);          // route rt:colMeta / rt:lookupResult / rt:saveDone
 */

export function resultsTableCss(): string {
	return `
	.rt-bar { display:none; align-items:center; gap:8px; padding:4px 8px; font-size:12px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
	.rt-bar.dirty { display:flex; }
	.rt-bar button { font-size:11px; padding:3px 10px; border:none; border-radius:4px; cursor:pointer; }
	.rt-save { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	.rt-discard { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	.rt-scroll { overflow:auto; }
	table.rt { border-collapse:collapse; width:100%; font-size:12px; }
	table.rt th, table.rt td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); padding:3px 8px; text-align:left; white-space:nowrap; vertical-align:top; max-width:380px; overflow:hidden; text-overflow:ellipsis; }
	table.rt th { position:sticky; top:0; background:var(--vscode-editor-background); z-index:1; }
	table.rt tr:nth-child(even) td { background:rgba(128,128,128,0.06); }
	table.rt td.rt-num { color:var(--vscode-descriptionForeground); text-align:right; }
	table.rt td.rt-edit { cursor:text; }
	table.rt td.rt-edit:hover { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
	table.rt td.rt-dirty { background:var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.18)) !important; }
	table.rt td.rt-error { outline:1px solid var(--vscode-errorForeground); }
	table.rt input, table.rt select { width:100%; box-sizing:border-box; font:inherit; padding:1px 3px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:2px; }
	table.rt .rt-nested { border-collapse:collapse; width:100%; font-size:11px; }
	table.rt .rt-nested th, table.rt .rt-nested td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding:2px 6px; position:static; background:transparent; }
	.rt-lookup { position:relative; }
	.rt-lookup-list { position:absolute; left:0; right:0; top:100%; z-index:50; max-height:180px; overflow:auto; background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.4)); border-radius:4px; }
	.rt-lookup-list div { padding:3px 8px; cursor:pointer; font-size:12px; }
	.rt-lookup-list div:hover, .rt-lookup-list div.sel { background:var(--vscode-list-hoverBackground); }
	td.rt-sub { white-space:normal; max-width:none; padding:2px; }`;
}

export function resultsTableScript(): string {
	return `
	window.ASFXResults = function (opts) {
		var mount = opts.mount, post = opts.post, getOrg = opts.getOrg;
		var records = [], columns = [], meta = {}, rootType = '', changes = {}, lookupSeq = 0, lookupCbs = {}, saveErrors = [];
		function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
		function subRecords(v){ return (v && typeof v==='object' && Array.isArray(v.records)) ? v.records : null; }
		function isRelObj(v){ return v && typeof v==='object' && v.attributes && !Array.isArray(v.records); }
		function deriveColumns(recs){ var seen={}, cols=[]; recs.forEach(function(r){ Object.keys(r||{}).forEach(function(k){ if(k!=='attributes' && !seen[k]){ seen[k]=1; cols.push(k); } }); }); return cols; }
		function fmeta(field){ var m=meta[rootType]; return m && m[field.toLowerCase()]; }
		function dirtyCount(){ var n=0; for(var id in changes){ n+=Object.keys(changes[id]).length; } return n; }

		function setData(recs){ records=recs||[]; rootType=(records[0]&&records[0].attributes&&records[0].attributes.type)||''; columns=deriveColumns(records); changes={}; render();
			var types={}; records.forEach(function(r){ if(r.attributes&&r.attributes.type) types[r.attributes.type]=1; });
			post({ type:'rt:colMeta', org:getOrg(), sobjects:Object.keys(types) }); }

		function displayValue(v){ if(v==null) return ''; if(subRecords(v)) return ''; if(isRelObj(v)){ var k=Object.keys(v).filter(function(x){return x!=='attributes';}); return k.length?String(v[k[0]]):''; } if(typeof v==='object') return JSON.stringify(v); return String(v); }

		function cellInner(v){ var sub=subRecords(v);
			if(sub){ if(!sub.length) return '<span style="opacity:.6">0 rows</span>'; var sc=[],s={}; sub.forEach(function(rr){ Object.keys(rr).forEach(function(k){ if(k!=='attributes'&&!s[k]){s[k]=1;sc.push(k);} }); });
				var h='<table class="rt-nested"><thead><tr>'+sc.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
				sub.forEach(function(rr){ h+='<tr>'+sc.map(function(c){ return '<td>'+esc(displayValue(rr[c]))+'</td>'; }).join('')+'</tr>'; }); return h+'</tbody></table>'; }
			return esc(displayValue(v)); }

		function render(){ if(!records.length){ mount.innerHTML='<div style="padding:8px;opacity:.6">No rows.</div>'; return; }
			var errHtml = saveErrors.length ? '<span style="color:var(--vscode-errorForeground)">'+esc(saveErrors.join(' · '))+'</span>' : '';
			var bar='<div class="rt-bar'+((dirtyCount()||saveErrors.length)?' dirty':'')+'"><span>'+dirtyCount()+' unsaved change(s)</span><button class="rt-save">Save</button><button class="rt-discard">Discard</button>'+errHtml+'</div>';
			var html='<div class="rt-scroll"><table class="rt"><thead><tr><th class="rt-num">#</th>'+columns.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
			for(var i=0;i<records.length;i++){ var r=records[i]; var id=r.Id||r.id||(r.attributes&&r.attributes.url)||'';
				html+='<tr data-rec="'+esc(id)+'">'+'<td class="rt-num">'+(i+1)+'</td>'+columns.map(function(c){
					var v=r[c]; var sub=subRecords(v); var fm=fmeta(c);
					var editable = !sub && !isRelObj(v) && fm && fm.updateable && c.indexOf('.')===-1;
					var cls = sub?'rt-sub':(editable?'rt-edit':'');
					var chg = changes[id] && (c in changes[id]); if(chg) cls+=' rt-dirty';
					var shown = chg ? (changes[id][c]==null?'':String(changes[id][c])) : cellInner(v);
					return '<td class="'+cls+'" data-field="'+esc(c)+'"'+(editable?' tabindex="0"':'')+'>'+shown+'</td>'; }).join('')+'</tr>'; }
			mount.innerHTML=bar+html+'</tbody></table></div>';
			var b=mount.querySelector('.rt-save'); if(b) b.onclick=save; var d=mount.querySelector('.rt-discard'); if(d) d.onclick=function(){ changes={}; render(); };
			mount.querySelectorAll('td.rt-edit').forEach(function(td){ td.onclick=function(){ beginEdit(td); }; });
		}

		function setChange(id, field, val){ if(!changes[id]) changes[id]={}; changes[id][field]=val; }

		function beginEdit(td){ if(td.querySelector('input,select')) return;
			var id=td.parentNode.getAttribute('data-rec'); var field=td.getAttribute('data-field'); var fm=fmeta(field)||{type:'string'};
			var cur = (changes[id]&&field in changes[id]) ? changes[id][field] : rawValue(id, field);
			var commit=function(val){ setChange(id, field, val); render(); };
			if(fm.type==='boolean'){ var sel=document.createElement('select'); ['true','false'].forEach(function(o){ var op=document.createElement('option'); op.value=o; op.textContent=o; if(String(cur)===o) op.selected=true; sel.appendChild(op); }); td.innerHTML=''; td.appendChild(sel); sel.focus(); sel.onchange=function(){ commit(sel.value==='true'); }; sel.onblur=function(){ render(); }; return; }
			if((fm.type==='picklist'||fm.type==='multipicklist') && fm.picklistValues){ var s=document.createElement('select'); var blank=document.createElement('option'); blank.value=''; blank.textContent='--none--'; s.appendChild(blank); fm.picklistValues.forEach(function(p){ var op=document.createElement('option'); op.value=p; op.textContent=p; if(String(cur)===p) op.selected=true; s.appendChild(op); }); td.innerHTML=''; td.appendChild(s); s.focus(); s.onchange=function(){ commit(s.value||null); }; s.onblur=function(){ render(); }; return; }
			if(fm.type==='reference' && fm.referenceTo && fm.referenceTo.length){ beginLookup(td, id, field, fm.referenceTo[0], commit); return; }
			var input=document.createElement('input');
			input.type = (fm.type==='int'||fm.type==='double'||fm.type==='currency'||fm.type==='percent'||fm.type==='long')?'number':(fm.type==='date'?'date':(fm.type==='datetime'?'datetime-local':'text'));
			input.value = cur==null?'':String(cur);
			td.innerHTML=''; td.appendChild(input); input.focus(); input.select&&input.select();
			input.onkeydown=function(e){ if(e.key==='Enter'){ input.blur(); } else if(e.key==='Escape'){ render(); } };
			input.onblur=function(){ var v=input.value; if(v==='') commit(null); else if(input.type==='number') commit(Number(v)); else commit(v); };
		}

		function beginLookup(td, id, field, refObject, commit){ td.innerHTML='';
			var wrap=document.createElement('div'); wrap.className='rt-lookup';
			var input=document.createElement('input'); input.placeholder='Search '+refObject+'…'; wrap.appendChild(input);
			var list=document.createElement('div'); list.className='rt-lookup-list'; list.style.display='none'; wrap.appendChild(list);
			td.appendChild(wrap); input.focus();
			var t=null;
			input.oninput=function(){ if(t) clearTimeout(t); var q=input.value.trim(); if(!q){ list.style.display='none'; return; } t=setTimeout(function(){ var rid=++lookupSeq; lookupCbs[rid]=function(hits){ list.innerHTML=hits.map(function(h){ return '<div data-id="'+esc(h.id)+'">'+esc(h.name)+' <span style="opacity:.6">'+esc(h.id)+'</span></div>'; }).join('')||'<div style="opacity:.6">No matches</div>'; list.style.display='block'; list.querySelectorAll('div[data-id]').forEach(function(o){ o.onclick=function(){ commit(o.getAttribute('data-id')); }; }); }; post({ type:'rt:lookup', org:getOrg(), requestId:rid, refObject:refObject, query:q }); }, 250); };
			input.onkeydown=function(e){ if(e.key==='Escape') render(); };
			input.onblur=function(){ setTimeout(function(){ if(td.isConnected && td.querySelector('.rt-lookup')) render(); }, 200); };
		}

		function rawValue(id, field){ for(var i=0;i<records.length;i++){ var r=records[i]; if((r.Id||r.id)===id){ var v=r[field]; return isRelObj(v)?'' : (subRecords(v)?'' : v); } } return ''; }

		function save(){ saveErrors=[]; var payload=[]; for(var id in changes){ if(Object.keys(changes[id]).length) payload.push({ id:id, sobjectType:rootType, fields:changes[id] }); } if(!payload.length) return; post({ type:'rt:save', org:getOrg(), changes:payload }); }

		function onSaveDone(results){ saveErrors=[]; (results||[]).forEach(function(rr){ if(rr.error) saveErrors.push(rr.id+': '+rr.error); else { delete changes[rr.id]; } }); render(); }

		function handleMessage(msg){ if(msg.type==='rt:colMeta'){ meta=msg.meta||{}; render(); }
			else if(msg.type==='rt:lookupResult'){ var cb=lookupCbs[msg.requestId]; if(cb){ delete lookupCbs[msg.requestId]; cb(msg.hits||[]); } }
			else if(msg.type==='rt:saveDone'){ onSaveDone(msg.results); } }

		return { setData:setData, handleMessage:handleMessage, hasChanges:function(){ return dirtyCount()>0; } };
	};`;
}
