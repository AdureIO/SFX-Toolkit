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
 *
 * Bulk row actions: top-level rows get a checkbox (shift-click selects a range). With
 * rows selected the controls offer "Set field…" (one value for every selected row —
 * staged as normal unsaved changes, saved with Save) and Delete (rt:delete, confirmed
 * by the host). Rows are identified by Id, or by attributes.url when Id wasn't queried.
 */

export function resultsTableCss(): string {
	return `
	.rt-ctl { display:none; align-items:center; gap:6px; }
	.rt-ctl.on { display:inline-flex; }
	.rt-ctl button { font-size:11px; padding:2px 9px; border:none; border-radius:4px; cursor:pointer; }
	.rt-iconbtn { display:inline-flex; align-items:center; justify-content:center; min-width:24px; height:22px; padding:0 6px !important; font-size:13px !important; line-height:1; }
	.rt-badge { font-size:10px; font-weight:600; min-width:16px; height:16px; padding:0 4px; border-radius:8px; display:inline-flex; align-items:center; justify-content:center; background:var(--vscode-editorWarning-foreground, #cca700); color:#000; }
	.rt-save { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
	.rt-discard { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	.rt-err { color:var(--vscode-errorForeground); }
	.rt-host { position:relative; }
	.rt-scroll { position:absolute; inset:0; overflow:auto; }
	.rt-ok { color:var(--vscode-testing-iconPassed, #3fb950); }
	.rt-refresh { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	table.rt { border-collapse:collapse; width:max-content; min-width:100%; font-size:12px; }
	table.rt th, table.rt td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); padding:3px 8px; text-align:left; white-space:nowrap; vertical-align:top; max-width:380px; overflow:hidden; text-overflow:ellipsis; }
	table.rt th { position:sticky; top:0; background:var(--vscode-editor-background); z-index:1; }
	table.rt tr:nth-child(even) > td { background:rgba(128,128,128,0.06); }
	table.rt td.rt-num { color:var(--vscode-descriptionForeground); text-align:right; }
	.rt-edit { cursor:pointer; }
	td.rt-edit { min-width:42px; }
	.rt-edit:hover { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
	span.rt-edit { display:inline-block; min-width:28px; min-height:1em; }
	.rt-dirty, td.rt-dirty { background:rgba(204,167,0,0.16) !important; box-shadow: inset 3px 0 0 var(--vscode-editorWarning-foreground, #cca700); }
	.rt-ref-id { display:block; font-family:var(--vscode-editor-font-family, monospace); opacity:.6; font-size:11px; }
	.rt-ref-name { display:block; }
	table.rt input, table.rt select { width:100%; box-sizing:border-box; font:inherit; padding:1px 3px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-focusBorder); border-radius:2px; }
	table.rt .rt-nested { border-collapse:collapse; width:max-content; font-size:11px; }
	table.rt .rt-nested th, table.rt .rt-nested td { border:1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding:2px 6px; position:static; background:transparent; white-space:nowrap; max-width:none; }
	table.rt td.rt-sub { white-space:normal; max-width:none; overflow:hidden; text-overflow:clip; padding:2px; }
	.rt-relfield { display:block; }
	.rt-relfield .k { opacity:.65; }
	.rt-lookup { position:relative; }
	.rt-lookup-list { position:fixed; z-index:9999; max-height:220px; overflow:auto; background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.4)); border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.35); }
	.rt-lookup-list div.rt-opt { padding:4px 8px; cursor:pointer; font-size:12px; border-bottom:1px solid var(--vscode-panel-border, rgba(128,128,128,0.15)); }
	.rt-lookup-list div.rt-opt:last-child { border-bottom:none; }
	.rt-lookup-list div.rt-opt:hover { background:var(--vscode-list-hoverBackground); }
	.rt-lookup-list .rt-opt-id { font-family:var(--vscode-editor-font-family, monospace); opacity:.65; font-size:11px; }
	.rt-lookup-list .rt-opt-name { font-weight:600; }
	table.rt th.rt-chk, table.rt td.rt-chk { width:22px; min-width:22px; padding:3px 4px; text-align:center; }
	table.rt td.rt-chk input, table.rt th.rt-chk input { width:auto; margin:0; cursor:pointer; }
	table.rt tr.rt-selrow > td { background:var(--vscode-list-inactiveSelectionBackground, rgba(90,140,220,0.18)) !important; }
	.rt-selinfo { font-size:11px; opacity:.85; white-space:nowrap; }
	.rt-bulk { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
	.rt-del { background:var(--vscode-inputValidation-errorBackground, #5a1d1d); color:var(--vscode-errorForeground, #f48771); border:1px solid var(--vscode-inputValidation-errorBorder, transparent) !important; }
	.rt-pop { position:fixed; z-index:9998; width:300px; padding:10px; background:var(--vscode-editorWidget-background, var(--vscode-dropdown-background)); color:var(--vscode-foreground); border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.4)); border-radius:6px; box-shadow:0 4px 14px rgba(0,0,0,0.4); font-size:12px; }
	.rt-pop label { display:block; margin:0 0 3px; opacity:.8; font-size:11px; }
	.rt-pop select, .rt-pop input { width:100%; box-sizing:border-box; font:inherit; padding:3px 5px; margin-bottom:8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); border-radius:2px; }
	.rt-pop .rt-pop-hint { font-size:11px; opacity:.7; margin:-4px 0 8px; }
	.rt-pop .rt-pop-btns { display:flex; justify-content:flex-end; gap:6px; }
	.rt-pop button { font-size:11px; padding:3px 10px; border:none; border-radius:4px; cursor:pointer; }
	.rt-pop .rt-lookup-list { position:static; max-height:150px; margin:-6px 0 8px; box-shadow:none; }`;
}

export function resultsTableScript(): string {
	return `
	window.ASFXResults = function (opts) {
		var mount = opts.mount, controls = opts.controls, post = opts.post, getOrg = opts.getOrg, onRefresh = opts.onRefresh;
		var records = [], columns = [], meta = {}, rootType = '', changes = {}, lookupSeq = 0, lookupCbs = {}, saveErrors = [], nameById = {}, namesRequested = {}, saveOk = false;
		var objMeta = {}, selected = {}, lastSelIdx = -1, deleting = false, pop = null;
		function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
		function subRecords(v){ return (v && typeof v==='object' && Array.isArray(v.records)) ? v.records : null; }
		function isRelObj(v){ return v && typeof v==='object' && v.attributes && !Array.isArray(v.records); }
		function typeOf(r){ return r && r.attributes && r.attributes.type; }
		// Id, or (when Id wasn't selected) the record id at the end of attributes.url.
		function idOf(r){ if(!r) return null; if(r.Id || r.id) return r.Id || r.id; var u=r.attributes && r.attributes.url; var last=u ? String(u).split('/').pop() : ''; return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(last) ? last : null; }
		function deriveColumns(recs){ var seen={}, cols=[]; recs.forEach(function(r){ Object.keys(r||{}).forEach(function(k){ if(k!=='attributes' && !seen[k]){ seen[k]=1; cols.push(k); } }); }); return cols; }
		function fmeta(type, field){ var m=meta[type]; return m && m[String(field).toLowerCase()]; }
		function dirtyCount(){ var n=0; for(var id in changes){ n+=Object.keys(changes[id].fields).length; } return n; }
		function changedVal(id, field){ return changes[id] && (field in changes[id].fields) ? changes[id].fields[field] : undefined; }

		function collectTypes(recs, set){ recs.forEach(function(r){ var t=typeOf(r); if(t) set[t]=1; Object.keys(r||{}).forEach(function(k){ if(k==='attributes') return; var v=r[k]; var sub=subRecords(v); if(sub) collectTypes(sub,set); else if(isRelObj(v)){ var pt=typeOf(v); if(pt) set[pt]=1; } }); }); }

		function setData(recs){ closePop(); records=recs||[]; rootType=typeOf(records[0])||''; columns=deriveColumns(records); changes={}; saveErrors=[]; nameById={}; namesRequested={}; selected={}; lastSelIdx=-1; deleting=false; render();
			var set={}; collectTypes(records, set); post({ type:'rt:colMeta', org:getOrg(), sobjects:Object.keys(set) }); }

		function displayValue(v){ if(v==null) return ''; if(typeof v==='object') return ''; return String(v); }
		function isRef(type, field){ var fm=fmeta(type, field); return fm && fm.type==='reference' && fm.referenceTo && fm.referenceTo.length===1 ? fm.referenceTo[0] : null; }
		// Stacked id (line 1) + resolved Name (line 2) for a lookup/master-detail value.
		function refDisplay(id){ if(!id) return ''; var nm=nameById[id]; return '<span class="rt-ref-id">'+esc(id)+'</span>'+(nm?'<span class="rt-ref-name">'+esc(nm)+'</span>':''); }
		function valueDisplay(type, field, value){ var ref=isRef(type, field); if(ref && value && typeof value!=='object') return refDisplay(String(value)); return esc(displayValue(value)); }

		// Resolve the Name of every lookup/MD value on screen, one request per target object.
		function requestNames(){ var byObj={}; function scan(type, field, value){ var ref=isRef(type, field); if(!ref || !value || typeof value==='object') return; var id=String(value); if(nameById[id]!==undefined || namesRequested[id]) return; (byObj[ref]=byObj[ref]||[]).push(id); namesRequested[id]=1; }
			records.forEach(function(r){ var rt=typeOf(r); columns.forEach(function(c){ var v=r[c]; if(isRelObj(v)){ var pt=typeOf(v); Object.keys(v).forEach(function(k){ if(k!=='attributes') scan(pt,k,v[k]); }); } else { var sub=subRecords(v); if(sub){ sub.forEach(function(rr){ var ct=typeOf(rr); Object.keys(rr).forEach(function(k){ if(k!=='attributes') scan(ct,k,rr[k]); }); }); } else scan(rt,c,v); } }); });
			Object.keys(byObj).forEach(function(ref){ post({ type:'rt:resolveNames', org:getOrg(), refObject:ref, ids:byObj[ref] }); }); }

		// An editable inline element carrying its record id/type/field.
		function editSpan(id, type, field, value){
			var dirty = changedVal(id, field) !== undefined;
			var shown = dirty ? changes[id].fields[field] : value;
			return '<span class="rt-edit'+(dirty?' rt-dirty':'')+'" data-rec="'+esc(id)+'" data-type="'+esc(type)+'" data-field="'+esc(field)+'">'+valueDisplay(type,field,shown)+'</span>';
		}

		function cellHtml(r, col){ var v=r[col]; var sub=subRecords(v);
			if(sub){ if(!sub.length) return '<span style="opacity:.6">0 rows</span>'; return nestedTable(sub); }
			if(isRelObj(v)){ // related (parent) object — edit selected sub-fields if its Id is present
				var pid=idOf(v), pt=typeOf(v); var keys=Object.keys(v).filter(function(k){ return k!=='attributes' && k!=='Id' && k!=='id'; });
				return keys.map(function(k){ var sv=v[k]; var fm=pid&&fmeta(pt,k); var ed = fm && fm.updateable && typeof sv!=='object';
					return '<span class="rt-relfield"><span class="k">'+esc(k)+': </span>'+(ed?editSpan(pid,pt,k,sv):valueDisplay(pt,k,sv))+'</span>'; }).join('') || esc(displayValue(v)); }
			return ''; }

		function nestedTable(sub){ var sc=[],s={}; sub.forEach(function(rr){ Object.keys(rr).forEach(function(k){ if(k!=='attributes'&&!s[k]){s[k]=1;sc.push(k);} }); });
			var ct=typeOf(sub[0])||'';
			var h='<table class="rt-nested"><thead><tr>'+sc.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
			sub.forEach(function(rr){ var cid=idOf(rr); h+='<tr>'+sc.map(function(c){ var v=rr[c]; if(typeof v==='object') return '<td>'+esc(displayValue(v))+'</td>'; var fm=fmeta(ct,c); var ed=cid&&fm&&fm.updateable&&c!=='Id';
				if(ed){ var dirty=changedVal(cid,c)!==undefined; var shown=dirty?changes[cid].fields[c]:v; return '<td class="rt-edit'+(dirty?' rt-dirty':'')+'" title="Double-click to edit" data-rec="'+esc(cid)+'" data-type="'+esc(ct)+'" data-field="'+esc(c)+'">'+valueDisplay(ct,c,shown)+'</td>'; }
				return '<td>'+valueDisplay(ct,c,v)+'</td>'; }).join('')+'</tr>'; });
			return h+'</tbody></table>'; }

		function renderControls(){ if(!controls) return;
			var dc=dirtyCount(); var html='';
			if(onRefresh) html += '<button class="rt-refresh rt-iconbtn" title="Refresh results">↻</button>';
			if(dc) html += '<span class="rt-badge" title="'+dc+' unsaved change(s)">'+dc+'</span><button class="rt-save rt-iconbtn" title="Save changes">💾</button><button class="rt-discard rt-iconbtn" title="Discard changes">✕</button>';
			var sc=selCount();
			if(sc){ html += '<span class="rt-selinfo">'+sc+' selected</span>';
				if(bulkFields().length) html += '<button class="rt-bulk" title="Set one field to the same value on every selected row">Set field…</button>';
				if(canDelete()) html += '<button class="rt-del" title="Delete the selected records"'+(deleting?' disabled':'')+'>'+(deleting?'Deleting…':'Delete')+'</button>';
				html += '<button class="rt-discard rt-iconbtn rt-clearsel" title="Clear selection">☐</button>'; }
			if(saveErrors.length) html += '<span class="rt-err">'+esc(saveErrors.slice(0,3).join(' · '))+(saveErrors.length>3?' (+'+(saveErrors.length-3)+' more)':'')+'</span>';
			else if(saveOk) html += '<span class="rt-ok" title="Changes saved">✓</span>';
			controls.className = 'rt-ctl'+(html?' on':'');
			controls.innerHTML = html;
			var rf=controls.querySelector('.rt-refresh'); if(rf) rf.onclick=function(){ saveOk=false; onRefresh(); };
			var s=controls.querySelector('.rt-save'); if(s) s.onclick=save;
			var d=controls.querySelector('.rt-discard:not(.rt-clearsel)'); if(d) d.onclick=function(){ changes={}; saveErrors=[]; render(); };
			var cs=controls.querySelector('.rt-clearsel'); if(cs) cs.onclick=function(){ selected={}; lastSelIdx=-1; closePop(); render(); };
			var bk=controls.querySelector('.rt-bulk'); if(bk) bk.onclick=function(){ openBulkPop(bk); };
			var dl=controls.querySelector('.rt-del'); if(dl) dl.onclick=deleteSelected;
		}

		function scalarTd(r, c){ var v=r[c]; var rid=idOf(r); var fm=fmeta(rootType, c); var editable = rid && fm && fm.updateable && c.indexOf('.')===-1;
			if(editable){ var dirty=changedVal(rid,c)!==undefined; var shown=dirty?changes[rid].fields[c]:v;
				return '<td class="rt-edit'+(dirty?' rt-dirty':'')+'" title="Double-click to edit" data-rec="'+esc(rid)+'" data-type="'+esc(rootType)+'" data-field="'+esc(c)+'">'+valueDisplay(rootType,c,shown)+'</td>'; }
			return '<td>'+valueDisplay(rootType,c,v)+'</td>'; }

		function render(){ renderControls();
			mount.classList.add('rt-host');
			if(!records.length){ mount.innerHTML='<div style="padding:8px;opacity:.6">No rows.</div>'; return; }
			// Preserve scroll position across re-renders (an edit rebuilds the table; without this it jumps to top-left).
			var prev=mount.querySelector('.rt-scroll'); var sl=prev?prev.scrollLeft:0, st=prev?prev.scrollTop:0;
			var selectable=isSelectable();
			var html='<div class="rt-scroll"><table class="rt"><thead><tr>'+(selectable?'<th class="rt-chk"><input type="checkbox" class="rt-selall" title="Select all rows"></th>':'')+'<th class="rt-num">#</th>'+columns.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead><tbody>';
			for(var i=0;i<records.length;i++){ var r=records[i]; var rid=idOf(r); var on=!!(rid && selected[rid]);
				html+='<tr'+(on?' class="rt-selrow"':'')+'>'+(selectable?'<td class="rt-chk">'+(rid?'<input type="checkbox" class="rt-sel" data-idx="'+i+'"'+(on?' checked':'')+'>':'')+'</td>':'')+'<td class="rt-num">'+(i+1)+'</td>'+columns.map(function(c){ var v=r[c]; var sub=subRecords(v); if(sub) return '<td class="rt-sub">'+cellHtml(r,c)+'</td>'; if(isRelObj(v)) return '<td>'+cellHtml(r,c)+'</td>'; return scalarTd(r,c); }).join('')+'</tr>'; }
			mount.innerHTML=html+'</tbody></table></div>';
			mount.querySelectorAll('.rt-edit').forEach(function(el){ el.ondblclick=function(e){ e.stopPropagation(); beginEdit(el); }; });
			if(selectable) wireSelection();
			// Safety net: auto table-layout can under-size a cell holding a nested table, clipping it.
			// Force each subquery column to at least its nested table's real width so the row widens and scrolls.
			mount.querySelectorAll('td.rt-sub').forEach(function(td){ var nt=td.querySelector('.rt-nested'); if(nt){ var w=nt.scrollWidth; if(w) td.style.minWidth=(w+6)+'px'; } });
			var now=mount.querySelector('.rt-scroll'); var tbl=mount.querySelector('table.rt');
			// Deterministically fill the visible width (CSS min-width:100% behaves inconsistently across the two
			// container layouts); the table still grows past this when its content is wider, so scroll is preserved.
			if(now && tbl){ tbl.style.minWidth=now.clientWidth+'px'; }
			if(now){ now.scrollLeft=sl; now.scrollTop=st; }
			requestNames();
		}

		// ── Row selection ─────────────────────────────────────────────────────────
		function isSelectable(){ return !!rootType && records.some(function(r){ return !!idOf(r); }); }
		function selCount(){ return Object.keys(selected).length; }
		function selectedIds(){ return Object.keys(selected); }
		function canDelete(){ var om=objMeta[rootType]; return !om || om.deletable !== false; }
		function wireSelection(){
			var all=mount.querySelector('.rt-selall'); var boxes=mount.querySelectorAll('.rt-sel'); var n=selCount();
			if(all){ all.checked = n>0 && n===boxes.length; all.indeterminate = n>0 && n<boxes.length;
				all.onclick=function(){ var on=all.checked; selected={}; if(on) records.forEach(function(r){ var id=idOf(r); if(id) selected[id]=1; }); lastSelIdx=-1; render(); }; }
			boxes.forEach(function(b){ b.onclick=function(e){ var idx=+b.getAttribute('data-idx'); var on=b.checked;
				// Shift-click: apply this box's new state to the whole range since the last click.
				var from = (e.shiftKey && lastSelIdx>=0) ? Math.min(lastSelIdx, idx) : idx, to = (e.shiftKey && lastSelIdx>=0) ? Math.max(lastSelIdx, idx) : idx;
				for(var i=from;i<=to;i++){ var id=idOf(records[i]); if(!id) continue; if(on) selected[id]=1; else delete selected[id]; }
				lastSelIdx=idx; render(); }; });
		}

		// ── Bulk "set field" ──────────────────────────────────────────────────────
		// Updateable scalar fields of the root object: queried columns first, then the rest A–Z.
		function bulkFields(){ var m=meta[rootType]; if(!m) return [];
			var out=[], seen={};
			columns.forEach(function(c){ var l=c.toLowerCase(); if(m[l] && m[l].updateable && c.indexOf('.')===-1){ out.push(c); seen[l]=1; } });
			Object.keys(m).sort().forEach(function(l){ if(!seen[l] && m[l].updateable) out.push(m[l].name || l); });
			return out; }
		function closePop(){ if(pop && pop.parentNode) pop.parentNode.removeChild(pop); pop=null; document.removeEventListener('mousedown', popOutside, true); }
		function popOutside(e){ if(pop && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.rt-bulk'))) closePop(); }
		function openBulkPop(anchor){ if(pop){ closePop(); return; }
			var fields=bulkFields(); if(!fields.length) return;
			pop=document.createElement('div'); pop.className='rt-pop';
			pop.innerHTML='<label>Field</label><select class="rt-pop-field"></select><label>Value</label><div class="rt-pop-val"></div><div class="rt-pop-hint"></div>'
				+'<div class="rt-pop-btns"><button class="rt-discard rt-pop-cancel">Cancel</button><button class="rt-save rt-pop-apply">Apply to '+selCount()+' row'+(selCount()===1?'':'s')+'</button></div>';
			var fsel=pop.querySelector('.rt-pop-field'); fields.forEach(function(f){ var o=document.createElement('option'); o.value=f; o.textContent=f; fsel.appendChild(o); });
			var valBox=pop.querySelector('.rt-pop-val'), hint=pop.querySelector('.rt-pop-hint'); var getVal=function(){ return null; };
			function build(){ var fm=fmeta(rootType, fsel.value)||{type:'string'}; valBox.innerHTML=''; getVal=valueEditor(valBox, fm);
				hint.textContent = 'Type: '+fm.type+'. Leave empty to clear the field. Changes are staged — press 💾 to save.'; }
			fsel.onchange=build; build();
			pop.querySelector('.rt-pop-cancel').onclick=closePop;
			pop.querySelector('.rt-pop-apply').onclick=function(){ applyBulk(fsel.value, getVal()); closePop(); };
			document.body.appendChild(pop);
			var r=anchor.getBoundingClientRect(); var left=Math.max(4, Math.min(r.left, window.innerWidth-308)); pop.style.left=left+'px'; pop.style.top=(r.bottom+4)+'px';
			setTimeout(function(){ document.addEventListener('mousedown', popOutside, true); }, 0);
			var first=valBox.querySelector('input,select'); if(first) first.focus(); }
		// Type-aware value input for the bulk popover; returns a getter for the typed value (null = clear).
		function valueEditor(box, fm){
			if(fm.type==='boolean'){ var b=mkSelect(['true','false'], 'true'); box.appendChild(b); return function(){ return b.value==='true'; }; }
			if((fm.type==='picklist'||fm.type==='multipicklist') && fm.picklistValues){ var p=mkSelect([''].concat(fm.picklistValues), ''); box.appendChild(p); return function(){ return p.value||null; }; }
			if(fm.type==='reference' && fm.referenceTo && fm.referenceTo.length){ return lookupEditor(box, fm.referenceTo[0]); }
			var input=document.createElement('input');
			var num=(fm.type==='int'||fm.type==='double'||fm.type==='currency'||fm.type==='percent'||fm.type==='long');
			input.type = num?'number':(fm.type==='date'?'date':(fm.type==='datetime'?'datetime-local':'text'));
			box.appendChild(input);
			input.onkeydown=function(e){ if(e.key==='Enter'){ var ap=pop&&pop.querySelector('.rt-pop-apply'); if(ap) ap.click(); } else if(e.key==='Escape') closePop(); };
			return function(){ var v=input.value; if(v==='') return null; return num?Number(v):v; }; }
		function lookupEditor(box, refObject){ var chosen=null, t=null;
			var input=document.createElement('input'); input.placeholder='Search '+refObject+'… (or paste an Id)'; box.appendChild(input);
			var list=document.createElement('div'); list.className='rt-lookup-list'; list.style.display='none'; box.appendChild(list);
			input.oninput=function(){ chosen=null; if(t) clearTimeout(t); var q=input.value.trim(); if(!q){ list.style.display='none'; return; }
				t=setTimeout(function(){ var rid=++lookupSeq; lookupCbs[rid]=function(hits){
					list.innerHTML=hits.length ? hits.map(function(h){ return '<div class="rt-opt" data-id="'+esc(h.id)+'" data-name="'+esc(h.name)+'"><div class="rt-opt-id">'+esc(h.id)+'</div><div class="rt-opt-name">'+esc(h.name)+'</div></div>'; }).join('') : '<div class="rt-opt" style="opacity:.6">No matches</div>';
					list.style.display='block';
					list.querySelectorAll('div[data-id]').forEach(function(o){ o.onmousedown=function(ev){ ev.preventDefault(); chosen=o.getAttribute('data-id'); nameById[chosen]=o.getAttribute('data-name'); input.value=o.getAttribute('data-name')+' ('+chosen+')'; list.style.display='none'; }; }); };
					post({ type:'rt:lookup', org:getOrg(), requestId:rid, refObject:refObject, query:q }); }, 250); };
			return function(){ if(chosen) return chosen; var v=input.value.trim(); if(!v) return null; return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v) ? v : null; }; }
		function applyBulk(field, val){ var ids=selectedIds(); if(!ids.length || !field) return;
			var isCol=columns.some(function(c){ return c.toLowerCase()===field.toLowerCase(); });
			if(!isCol) columns.push(field); // show the staged value even when the field wasn't queried
			ids.forEach(function(id){ if(isCol){ if(normVal(val)===normVal(rawValue(id, field))){ if(changes[id]){ delete changes[id].fields[field]; if(!Object.keys(changes[id].fields).length) delete changes[id]; } } else setChange(id, rootType, field, val); }
				else setChange(id, rootType, field, val); });
			saveOk=false; render(); }

		// ── Bulk delete (the host confirms, deletes in batches of 200, reports per row) ──
		function deleteSelected(){ var ids=selectedIds(); if(!ids.length || deleting) return; deleting=true; saveErrors=[]; renderControls();
			post({ type:'rt:delete', org:getOrg(), sobjectType:rootType, ids:ids }); }
		function onDeleteDone(msg){ deleting=false; if(msg.cancelled){ renderControls(); return; }
			var gone={}; saveErrors=[]; (msg.results||[]).forEach(function(rr){ if(rr.error) saveErrors.push(rr.id+': '+rr.error); else gone[rr.id]=1; });
			records=records.filter(function(r){ return !gone[idOf(r)]; });
			Object.keys(gone).forEach(function(id){ delete selected[id]; delete changes[id]; });
			lastSelIdx=-1; render(); }

		function setChange(id, type, field, val){ if(!changes[id]) changes[id]={ type:type, fields:{} }; changes[id].fields[field]=val; }
		function normVal(v){ return v==null ? '' : String(v); }
		// Record a change only if it actually differs from the original value; otherwise clear it
		// (so merely opening an editor and leaving it untouched never marks the cell dirty).
		function applyChange(id, type, field, val){ if(normVal(val)===normVal(rawValue(id, field))){ if(changes[id]){ delete changes[id].fields[field]; if(!Object.keys(changes[id].fields).length) delete changes[id]; } } else setChange(id, type, field, val); render(); }

		// Freeze the cell's current width so swapping text for an input doesn't reflow the column (no jump).
		function lockWidth(el){ var w=Math.ceil(el.getBoundingClientRect().width); if(w){ el.style.boxSizing='border-box'; el.style.width=w+'px'; el.style.minWidth=w+'px'; } }

		function beginEdit(el){ if(el.querySelector('input,select')) return;
			lockWidth(el);
			var id=el.getAttribute('data-rec'), type=el.getAttribute('data-type'), field=el.getAttribute('data-field'); var fm=fmeta(type, field)||{type:'string'};
			var cur = changedVal(id, field); if(cur===undefined) cur = rawValue(id, field);
			var commit=function(val){ applyChange(id, type, field, val); };
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
				list.innerHTML=hits.length ? hits.map(function(h){ return '<div class="rt-opt" data-id="'+esc(h.id)+'" data-name="'+esc(h.name)+'"><div class="rt-opt-id">'+esc(h.id)+'</div><div class="rt-opt-name">'+esc(h.name)+'</div></div>'; }).join('') : '<div class="rt-opt" style="opacity:.6">No matches</div>';
				place(); list.style.display='block';
				list.querySelectorAll('div[data-id]').forEach(function(o){ o.onmousedown=function(ev){ ev.preventDefault(); done=true; if(list.parentNode) list.parentNode.removeChild(list); var nid=o.getAttribute('data-id'); nameById[nid]=o.getAttribute('data-name'); commit(nid); }; });
			}; post({ type:'rt:lookup', org:getOrg(), requestId:rid, refObject:refObject, query:q }); }, 250); };
			input.onkeydown=function(e){ if(e.key==='Escape') teardown(); };
			input.onblur=function(){ setTimeout(teardown, 200); };
		}

		function findRecDeep(id){ var found=null; (function walk(recs){ for(var i=0;i<recs.length;i++){ var r=recs[i]; if(idOf(r)===id){ found=r; return; } for(var k in r){ if(k==='attributes') continue; var v=r[k]; var sub=subRecords(v); if(sub) walk(sub); else if(isRelObj(v) && idOf(v)===id) { found=v; return; } } } })(records); return found; }
		function rawValue(id, field){ var r=findRecDeep(id); if(!r) return ''; var v=r[field]; return (typeof v==='object')?'':v; }

		function save(){ saveErrors=[]; var payload=[]; for(var id in changes){ if(Object.keys(changes[id].fields).length) payload.push({ id:id, sobjectType:changes[id].type, fields:changes[id].fields }); } if(!payload.length) return; post({ type:'rt:save', org:getOrg(), changes:payload }); }
		function onSaveDone(results, cancelled){ if(cancelled){ renderControls(); return; } saveErrors=[]; (results||[]).forEach(function(rr){ if(rr.error) saveErrors.push(rr.id+': '+rr.error); else delete changes[rr.id]; });
			if(!saveErrors.length){ saveOk=true; setTimeout(function(){ saveOk=false; renderControls(); }, 4000);
				// Reload from the org so cells show the persisted values (otherwise they'd revert to the stale originals).
				if(onRefresh){ onRefresh(); return; } }
			render(); }

		function handleMessage(msg){ if(msg.type==='rt:colMeta'){ meta=msg.meta||{}; objMeta=msg.objMeta||{}; render(); }
			else if(msg.type==='rt:lookupResult'){ var cb=lookupCbs[msg.requestId]; if(cb){ delete lookupCbs[msg.requestId]; cb(msg.hits||[]); } }
			else if(msg.type==='rt:names'){ var nm=msg.names||{}; var got=false; for(var k in nm){ nameById[k]=nm[k]; got=true; } if(got) render(); }
			else if(msg.type==='rt:saveDone'){ onSaveDone(msg.results, msg.cancelled); }
			else if(msg.type==='rt:deleteDone'){ onDeleteDone(msg); } }

		return { setData:setData, handleMessage:handleMessage, hasChanges:function(){ return dirtyCount()>0; }, selectedCount:selCount };
	};`;
}
