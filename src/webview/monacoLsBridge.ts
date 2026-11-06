/**
 * Shared webview-side glue between a Monaco editor and the host's ApexBufferBridge
 * (language-server completion / hover). Embedded by the ASFX Workbench (Execute +
 * SOQL tabs) and the SOQL Builder panel so both behave identically:
 *
 *   const ls = ASFXMonacoLs({ key: 'type', post: (m) => vscode.postMessage(m), busyId: 'busy',
 *     results: { completion: 'completionResult', hover: 'hoverResult', resolve: 'resolveResult' },
 *     cancel: 'cancelRequest' });
 *   ls.register(monaco, 'apex', { completion: 'getCompletions', hover: 'getHover',
 *     resolve: 'resolveCompletion', triggerCharacters: ['.', ' '] });
 *   window.addEventListener('message', (e) => { if (ls.handle(e.data)) return; … });
 *
 * • Passes the server's whole list + `incomplete` to Monaco (no cap); insert/replace
 *   ranges, additionalTextEdits, labelDetails, commands, sortText/filterText kept.
 * • Forwards triggerKind/triggerCharacter; a cancelled Monaco token posts `cancel`
 *   so the host drops/cancels the LS request.
 * • Lazy completionItem/resolve for items carrying a resolveId.
 * • The busy spinner only appears if a request takes longer than 250 ms.
 *
 * `node --check`-style compile test: src/test/monacoLsBridge.test.ts.
 */
export function monacoLsBridgeScript(): string {
	return `
window.ASFXMonacoLs = function (opts) {
	var key = opts.key || 'type';
	var reqId = 0;
	var pending = {};
	var busy = 0, busyTimer = null;
	function showBusy(on) { var b = opts.busyId ? document.getElementById(opts.busyId) : null; if (b) b.style.display = on ? 'inline-flex' : 'none'; }
	function setBusy(d) {
		busy = Math.max(0, busy + d);
		if (busy > 0) { if (!busyTimer) busyTimer = setTimeout(function () { busyTimer = null; if (busy > 0) showBusy(true); }, 250); }
		else { if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; } showBusy(false); }
	}
	function send(type, payload) { var m = {}; m[key] = type; for (var k in payload) m[k] = payload[k]; opts.post(m); }
	/** Post a request and resolve with the host's answer (null if cancelled). */
	function request(type, payload, token) {
		return new Promise(function (resolve) {
			var id = ++reqId;
			var done = false;
			function finish(v) { if (done) return; done = true; delete pending[id]; setBusy(-1); resolve(v); }
			pending[id] = finish;
			setBusy(1);
			payload.requestId = id;
			send(type, payload);
			if (token && token.onCancellationRequested) {
				token.onCancellationRequested(function () { if (done) return; send(opts.cancel, { requestId: id }); finish(null); });
			}
		});
	}
	function toMonaco(monaco, it, defRange, listId) {
		var K = monaco.languages.CompletionItemKind;
		var s = { label: it.label, kind: K[it.kind] != null ? K[it.kind] : K.Text, insertText: it.insertText != null ? it.insertText : (typeof it.label === 'string' ? it.label : it.label.label), range: it.range || defRange };
		if (it.snippet) s.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
		if (it.detail) s.detail = it.detail;
		if (it.documentation) s.documentation = typeof it.documentation === 'string' ? it.documentation : { value: it.documentation.value };
		if (it.sortText != null) s.sortText = it.sortText;
		if (it.filterText != null) s.filterText = it.filterText;
		if (it.preselect) s.preselect = true;
		if (it.commitCharacters) s.commitCharacters = it.commitCharacters;
		if (it.deprecated) s.tags = [monaco.languages.CompletionItemTag.Deprecated];
		if (it.additionalTextEdits) s.additionalTextEdits = it.additionalTextEdits.map(function (e) { return { range: e.range, text: e.text }; });
		if (it.command) s.command = it.command;
		if (it.resolveId != null) { s.__asfxList = listId; s.__asfxRid = it.resolveId; }
		return s;
	}
	function register(monaco, languageId, cfg) {
		monaco.languages.registerCompletionItemProvider(languageId, {
			triggerCharacters: cfg.triggerCharacters || [],
			provideCompletionItems: function (model, pos, context, token) {
				var payload = { text: model.getValue(), line: pos.lineNumber - 1, character: pos.column - 1,
					triggerKind: (context && typeof context.triggerKind === 'number') ? context.triggerKind + 1 : 1,
					triggerCharacter: context && context.triggerCharacter };
				if (cfg.extra) { var x = cfg.extra(); for (var k in x) payload[k] = x[k]; }
				return request(cfg.completion, payload, token).then(function (res) {
					if (!res) return { suggestions: [], incomplete: true };
					var w = model.getWordUntilPosition(pos);
					var defRange = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
					return { suggestions: (res.items || []).map(function (it) { return toMonaco(monaco, it, defRange, res.listId); }), incomplete: !!res.incomplete };
				});
			},
			resolveCompletionItem: cfg.resolve ? function (item, token) {
				if (item.__asfxRid == null) return item;
				return request(cfg.resolve, { listId: item.__asfxList, resolveId: item.__asfxRid }, token).then(function (r) {
					if (!r) return item;
					if (r.detail) item.detail = r.detail;
					if (r.documentation) item.documentation = typeof r.documentation === 'string' ? r.documentation : { value: r.documentation.value };
					if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(function (e) { return { range: e.range, text: e.text }; });
					if (r.command) item.command = r.command;
					return item;
				});
			} : undefined
		});
		if (cfg.hover) {
			monaco.languages.registerHoverProvider(languageId, {
				provideHover: function (model, pos, token) {
					var payload = { text: model.getValue(), line: pos.lineNumber - 1, character: pos.column - 1 };
					if (cfg.extra) { var x = cfg.extra(); for (var k in x) payload[k] = x[k]; }
					return request(cfg.hover, payload, token).then(function (h) {
						if (!h || !h.contents || !h.contents.length) return null;
						var range = h.range;
						if (!range) { var w = model.getWordAtPosition(pos); if (w) range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }; }
						return { range: range, contents: h.contents.map(function (v) { return { value: v }; }) };
					});
				}
			});
		}
	}
	/** Route a host message; returns true when it was one of ours. */
	function handle(msg) {
		if (!msg) return false;
		var t = msg[key];
		var r = opts.results;
		if (t !== r.completion && t !== r.hover && t !== r.resolve) return false;
		var cb = pending[msg.requestId];
		if (!cb) return true;
		if (msg.dropped) { cb(null); return true; }
		if (t === r.completion) cb({ items: msg.items || [], incomplete: !!msg.incomplete, listId: msg.listId });
		else if (t === r.hover) cb(msg.hover || null);
		else cb(msg.item || null);
		return true;
	}
	return { register: register, handle: handle };
};
`;
}

/** Monaco editor options shared by the webview editors (per-language quick suggestions). */
export function monacoQuickSuggestions(language: 'apex' | 'soql'): string {
	// Apex keeps suggestions inside strings: the server completes dynamic SOQL in
	// Database.query('…') strings (matches the extension's [apex] editor default).
	return language === 'apex'
		? "{ other: true, comments: false, strings: true }"
		: "{ other: true, comments: false, strings: false }";
}

/** Trigger characters aligned with the language server (no `_`: it's part of identifiers). */
export const APEX_TRIGGER_CHARACTERS = ['.', ' ', ',', '(', "'", '@'];
export const SOQL_TRIGGER_CHARACTERS = ['.', ' ', ',', '(', "'", '\n'];
