/**
 * One shared results table + type-aware cell editor, embedded by BOTH SOQL
 * surfaces (the SOQL Workbench panel and the ASFX Workbench SOQL tab). The host
 * answers three messages via resultsTableHost: rt:colMeta, rt:lookup, rt:save.
 *
 *   const rt = ASFXResults({ mount, controls, post, getOrg });
 *   rt.setData(records);            // raw SF records (with attributes.type)
 *   rt.handleMessage(msg);          // rt:colMeta / rt:lookupResult / rt:saveDone
 *
 * Editing is tracked per record Id (+ its sobjectType), so top-level rows,
 * child-subquery rows and selected related (parent) records can all be edited and
 * saved in one pass. Save/Discard render into the host-provided `controls` element
 * (so they sit in the existing results header, not an extra bar).
 */

export function resultsTableCss(): string {
	return `
	.rt-ctl { display:none; align-items:center; gap:6px; }
	.rt-ctl.on { display:inline-flex; }
	.rt-ctl button { font-size:11px; padding:2px 9px; border:none; border-radius:4px; cursor:pointer; }
	.rt-save { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	.rt-discard { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	.rt-err { color:var(--vscode-errorForeground); }
	.rt-scroll { overflow:auto; max-width:100%; }
	table.rt { border-collapse:collapse; width:max-content; min-width:100%; font-size:12px; }
	table.rt th, table.rt td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); padding:3px 8px; text-align:left; white-space:nowrap; vertical-align:top; max-width:380px; overflow:hidden; text-overflow:ellipsis; }
	table.rt th { position:sticky; top:0; background:var(--vscode-editor-background); z-index:1; }
	table.rt tr:nth-child(even) > td { background:rgba(128,128,128,0.06); }
	table.rt td.rt-num { color:var(--vscode-descriptionForeground); text-align:right; }
	.rt-edit { cursor:text; }
	.rt-edit:hover { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
	.rt-dirty { background:var(--vscode-inputValidation-warningBackground, rgba(255,200,0,0.22)) !important; box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground, #cca700); }
	table.rt input, table.rt select { width:100%; box-sizing:border-box; font:inherit; padding:1px 3px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:2px; }
	table.rt .rt-nested { border-collapse:collapse; width:100%; font-size:11px; }
	table.rt .rt-nested th, table.rt .rt-nested td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding:2px 6px; position:static; background:transparent; }
	td.rt-sub { white-space:normal; max-width:none; padding:2px; }
	.rt-relfield { display:block; }
	.rt-relfield .k { opacity:.65; }
	.rt-lookup { position:relative; }
	.rt-lookup-list { position:fixed; z-index:9999; max-height:220px; overflow:auto; background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.4)); border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.35); }
	.rt-lookup-list div.rt-opt { padding:4px 8px; cursor:pointer; font-size:12px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); }
	.rt-lookup-list div.rt-opt:last-child { border-bottom:none; }
	.rt-lookup-list div.rt-opt:hover { background:var(--vscode-list-hoverBackground); }
	.rt-lookup-list .rt-opt-id { font-family:var(--vscode-editor-font-family, monospace); opacity:.65; font-size:11px; }
	.rt-lookup-list .rt-opt-name { font-weight:600; }`;
}

export function resultsTableScript(): string {
	return `
	window.ASFXResults = function (opts) {
		var mount = opts.mount, controls = opts.controls, post = opts.post, getOrg = opts.getOrg;
		var records = [], columns = [], meta = {}, rootType = '', changes = {}, lookupSeq = 0, lookupCbs = {}, saveErrors = [];
		function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
		function subRecords(v){ return (v && typeof v==='object' && Array.isArray(v.records)) ? v.records : null; }
		function isRelObj(v){ return v && typeof v==='object' && v.attributes && !Array.isArray(v.records); }
		function typeOf(r){ return r && r.attributes && r.attributes.type; }
		function idOf(r){ return r && (r.Id || r.id); }
		function deriveColumns(recs){ var seen={}, cols=[]; recs.forEach(function(r){ Object.keys(r||{}).forEach(function(k){ if(k!=='attributes' && !seen[k]){ seen[k]=1; cols.push(k); } }); }); return cols; }
		function fmeta(type, field){ var m=meta[type]; return m && m[String(field).toLowerCase()]; }
		function dirtyCount(){ var n=0; for(var id in changes){ n+=Object.keys(changes[id].fields).length; } return n; }
		function changedVal(id, field){ return changes[id] && (field in changes[id].fields) ? changes[id].fields[field] : undefined; }

		function collectTypes(recs, set){ recs.forEach(function(r){ var t=typeOf(r); if(t) set[t]=1; Object.keys(r||{}).forEach(function(k){ if(k==='attributes') return; var v=r[k]; var sub=subRecords(v); if(sub) collectTypes(sub,set); else if(isRelObj(v)){ var pt=typeOf(v); if(pt) set[pt]=1; } }); }); }

		function setData(recs){ records=recs||[]; rootType=typeOf(records[0])||''; columns=deriveColumns(records); changes={}; saveErrors=[]; render();
			var set={}; collectTypes(records, set); post({ type:'rt:colMeta', org:getOrg(), sobjects:Object.keys(set) }); }

		function displayValue(v){ if(v==null) return ''; if(typeof v==='object') return ''; return String(v); }

		// An editable inline element carrying its record id/type/field.
		function editSpan(id, type, field, value){
			var dirty = changedVal(id, field) !== undefined;
			var shown = dirty ? changes[id].fields[field] : value;
			return '<span class="rt-edit'+(dirty?' rt-dirty':'')+'" data-rec="'+esc(id)+'" data-type="'+esc(type)+'" data-field="'+esc(field)+'">'+esc(shown==null?'':shown)+'</span>';
		}
		function readonlySpan(value){ return esc(displayValue(value)); }

		function cellHtml(r, col){ var v=r[col]; var sub=subRecords(v);
			if(sub){ if(!sub.length) return '<span style="opacity:.6">0 rows</span>'; return nestedTable(sub); }
			if(isRelObj(v)){ // related (parent) object — edit selected sub-fields if its Id is present
				var pid=idOf(v), pt=typeOf(v); var keys=Object.keys(v).filter(function(k){ return k!=='attributes' && k!=='Id' && k!=='id'; });
				return keys.map(function(k){ var sv=v[k]; var fm=pid&&fmeta(pt,k); var ed = fm && fm.updateable && typeof sv!=='object';
					return '<span class="rt-relfield"><span class="k">'+esc(k)+': </span>'+(ed?editSpan(pid,pt,k,sv):readonlySpan(sv))+'</span>'; }).join('') || readonlySpan(v); }
			// scalar top-level field
			var rid=idOf(r); var fm=fmeta(rootType, col); var editable = rid && fm && fm.updateable && col.indexOf('.')===-1;
			return editable ? editSpan(rid, rootType, col, v) : esc(displayValue(v)); }

		function nestedTable(sub){ var sc=[],s={}; sub.forEach(function(rr){ Object.keys(rr).forEach(function(k){ if(k!=='attributes'&&!s[k]){s[k]=1;sc.push(k);} }); });
			var ct=typeOf(sub[0])||'';
			var h='<table class="rt-nested"><thead><tr>'+sc.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
			sub.forEach(function(rr){ var cid=idOf(rr); h+='<tr>'+sc.map(function(c){ var v=rr[c]; if(typeof v==='object') return '<td>'+esc(displayValue(v))+'</td>'; var fm=fmeta(ct,c); var ed=cid&&fm&&fm.updateable&&c!=='Id'; return '<td>'+(ed?editSpan(cid,ct,c,v):esc(displayValue(v)))+'</td>'; }).join('')+'</tr>'; });
			return h+'</tbody></table>'; }

		function renderControls(){ if(!controls) return;
			var on = dirtyCount() || saveErrors.length;
			controls.className = 'rt-ctl'+(on?' on':'');
			controls.innerHTML = on ? ('<span>'+dirtyCount()+' change(s)</span><button class="rt-save">Save</button><button class="rt-discard">Discard</button>'+(saveErrors.length?'<span class="rt-err">'+esc(saveErrors.join(' · '))+'</span>':'')) : '';
			var s=controls.querySelector('.rt-save'); if(s) s.onclick=save; var d=controls.querySelector('.rt-discard'); if(d) d.onclick=function(){ changes={}; saveErrors=[]; render(); };
		}

		function render(){ renderControls();
			if(!records.length){ mount.innerHTML='<div style="padding:8px;opacity:.6">No rows.</div>'; return; }
			var html='<div class="rt-scroll"><table class="rt"><thead><tr><th class="rt-num">#</th>'+columns.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
			for(var i=0;i<records.length;i++){ var r=records[i];
				html+='<tr><td class="rt-num">'+(i+1)+'</td>'+columns.map(function(c){ var sub=subRecords(r[c]); return '<td'+(sub?' class="rt-sub"':'')+'>'+cellHtml(r,c)+'</td>'; }).join('')+'</tr>'; }
			mount.innerHTML=html+'</tbody></table></div>';
			mount.querySelectorAll('.rt-edit').forEach(function(el){ el.onclick=function(e){ e.stopPropagation(); beginEdit(el); }; });
		}

		function setChange(id, type, field, val){ if(!changes[id]) changes[id]={ type:type, fields:{} }; changes[id].fields[field]=val; }

		function beginEdit(el){ if(el.querySelector('input,select')) return;
			var id=el.getAttribute('data-rec'), type=el.getAttribute('data-type'), field=el.getAttribute('data-field'); var fm=fmeta(type, field)||{type:'string'};
			var cur = changedVal(id, field); if(cur===undefined) cur = rawValue(id, field);
			var commit=function(val){ setChange(id, type, field, val); render(); };
			if(fm.type==='boolean'){ var sel=mkSelect(['true','false'], String(cur)); replace(el, sel); sel.onchange=function(){ commit(sel.value==='true'); }; sel.onblur=render; return; }
			if((fm.type==='picklist'||fm.type==='multipicklist') && fm.picklistValues){ var s2=mkSelect([''].concat(fm.picklistValues), cur==null?'':String(cur)); replace(el, s2); s2.onchange=function(){ commit(s2.value||null); }; s2.onblur=render; return; }
			if(fm.type==='reference' && fm.referenceTo && fm.referenceTo.length){ beginLookup(el, fm.referenceTo[0], commit); return; }
			var input=document.createElement('input');
			input.type = (fm.type==='int'||fm.type==='double'||fm.type==='currency'||fm.type==='percent'||fm.type==='long')?'number':(fm.type==='date'?'date':(fm.type==='datetime'?'datetime-local':'text'));
			input.value = cur==null?'':String(cur); replace(el, input); input.focus(); input.select&&input.select();
			input.onkeydown=function(e){ if(e.key==='Enter') input.blur(); else if(e.key==='Escape') render(); };
			input.onblur=function(){ var v=input.value; if(v==='') commit(null); else if(input.type==='number') commit(Number(v)); else commit(v); };
		}
		function mkSelect(values, cur){ var s=document.createElement('select'); values.forEach(function(o){ var op=document.createElement('option'); op.value=o; op.textContent=o===''?'--none--':o; if(String(cur)===o) op.selected=true; s.appendChild(op); }); return s; }
		function replace(el, node){ el.innerHTML=''; el.appendChild(node); node.focus && node.focus(); }

		function beginLookup(el, refObject, commit){ el.innerHTML='';
			var wrap=document.createElement('div'); wrap.className='rt-lookup'; var input=document.createElement('input'); input.placeholder='Search '+refObject+'…'; wrap.appendChild(input); el.appendChild(wrap); input.focus();
			// The dropdown lives on <body> with fixed positioning so cell/scroll overflow can't clip it.
			var list=document.createElement('div'); list.className='rt-lookup-list'; list.style.display='none'; document.body.appendChild(list);
			var t=null, done=false;
			function place(){ var r=input.getBoundingClientRect(); list.style.left=r.left+'px'; list.style.top=(r.bottom+2)+'px'; list.style.minWidth=Math.max(r.width,220)+'px'; }
			function teardown(){ if(done) return; done=true; if(list.parentNode) list.parentNode.removeChild(list); render(); }
			input.oninput=function(){ if(t) clearTimeout(t); var q=input.value.trim(); if(!q){ list.style.display='none'; return; } t=setTimeout(function(){ var rid=++lookupSeq; lookupCbs[rid]=function(hits){
				list.innerHTML=hits.length ? hits.map(function(h){ return '<div class="rt-opt" data-id="'+esc(h.id)+'"><div class="rt-opt-id">'+esc(h.id)+'</div><div class="rt-opt-name">'+esc(h.name)+'</div></div>'; }).join('') : '<div class="rt-opt" style="opacity:.6">No matches</div>';
				place(); list.style.display='block';
				list.querySelectorAll('div[data-id]').forEach(function(o){ o.onmousedown=function(ev){ ev.preventDefault(); done=true; if(list.parentNode) list.parentNode.removeChild(list); commit(o.getAttribute('data-id')); }; });
			}; post({ type:'rt:lookup', org:getOrg(), requestId:rid, refObject:refObject, query:q }); }, 250); };
			input.onkeydown=function(e){ if(e.key==='Escape') teardown(); };
			input.onblur=function(){ setTimeout(teardown, 200); };
		}

		function findRecDeep(id){ var found=null; (function walk(recs){ for(var i=0;i<recs.length;i++){ var r=recs[i]; if(idOf(r)===id){ found=r; return; } for(var k in r){ if(k==='attributes') continue; var v=r[k]; var sub=subRecords(v); if(sub) walk(sub); else if(isRelObj(v) && idOf(v)===id) { found=v; return; } } } })(records); return found; }
		function rawValue(id, field){ var r=findRecDeep(id); if(!r) return ''; var v=r[field]; return (typeof v==='object')?'':v; }

		function save(){ saveErrors=[]; var payload=[]; for(var id in changes){ if(Object.keys(changes[id].fields).length) payload.push({ id:id, sobjectType:changes[id].type, fields:changes[id].fields }); } if(!payload.length) return; post({ type:'rt:save', org:getOrg(), changes:payload }); }
		function onSaveDone(results){ saveErrors=[]; (results||[]).forEach(function(rr){ if(rr.error) saveErrors.push(rr.id+': '+rr.error); else delete changes[rr.id]; }); render(); }

		function handleMessage(msg){ if(msg.type==='rt:colMeta'){ meta=msg.meta||{}; render(); }
			else if(msg.type==='rt:lookupResult'){ var cb=lookupCbs[msg.requestId]; if(cb){ delete lookupCbs[msg.requestId]; cb(msg.hits||[]); } }
			else if(msg.type==='rt:saveDone'){ onSaveDone(msg.results); } }

		return { setData:setData, handleMessage:handleMessage, hasChanges:function(){ return dirtyCount()>0; } };
	};`;
}
