import { monacoLsBridgeScript, monacoQuickSuggestions, SOQL_TRIGGER_CHARACTERS } from "./monacoLsBridge";

/**
 * A Monaco SOQL query input for form-style webview panels (Data Export, REST Explorer,
 * Data Migration). Same editor, theme, tokenizer and language-server completion / hover
 * as the SOQL Builder panel and the ASFX Workbench SOQL tab — the panel's host side
 * routes these messages through a SoqlInputRouter (src/providers/soqlInputRouter.ts)
 * onto one virtual `asfx-buffer:` document per panel.
 *
 *   <div id="q-editor" class="asfx-soql-input"></div>
 *   const q = ASFXSoqlInput({ containerId: 'q-editor', monacoBase: '…/vs',
 *     post: (m) => vscode.postMessage(m), getOrg: () => orgSelect.value, orgSelectId: 'org',
 *     placeholder: 'SELECT …', onRun: run, onInput: changed, onBlur: left });
 *   window.addEventListener('message', (e) => { if (q.handle(e.data)) return; … });
 *   q.value = 'SELECT Id FROM Account'; q.value; q.focus();
 *
 * The returned object is textarea-compatible (`value` get/set, `focus()`), so panel code
 * that used `textarea.value` keeps working. `onInput` fires for user edits only (not for
 * `value = …`, like a textarea's input event). If Monaco can't load, a plain textarea is
 * used instead (same API, no completion).
 *
 * Several inputs on one page share one ASFXMonacoLs (request ids stay unique) and one
 * 'soql' language registration; every completion / hover request carries the org of the
 * input that owns the model, so the host pins the buffer's org override per request.
 *
 * Messages (key `command`): see SOQL_INPUT_MSG.
 * Compile + behaviour test: src/test/monacoSoqlInput.test.ts.
 */
export const SOQL_INPUT_MSG = {
	completion: "soqlLsCompletions",
	hover: "soqlLsHover",
	resolve: "soqlLsResolve",
	cancel: "soqlLsCancel",
	setOrg: "soqlLsSetOrg",
	validate: "soqlLsValidate",
	markers: "soqlLsMarkers",
} as const;

/** Styles for the editor container (input-like frame, placeholder, tall suggest widget). */
export function monacoSoqlInputCss(): string {
	return `
.asfx-soql-input { position: relative; width: 100%; min-height: 60px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(128,128,128,0.35))); border-radius: 3px; overflow: hidden; background: var(--vscode-editor-background); }
.asfx-soql-input:focus-within { border-color: var(--vscode-focusBorder); }
.asfx-soql-input .asfx-soql-ph { position: absolute; top: 6px; left: 12px; right: 8px; pointer-events: none; z-index: 1; color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 19px; white-space: pre-wrap; overflow: hidden; opacity: .8; }
.asfx-soql-input textarea.asfx-soql-fallback { width: 100%; height: 100%; min-height: 80px; border: none; outline: none; resize: vertical; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.monaco-editor .suggest-widget { max-height: 360px !important; }
.monaco-editor .suggest-widget .monaco-list { max-height: 340px !important; }
`;
}

/** The webview script: the shared LS glue (ASFXMonacoLs) + window.ASFXSoqlInput. */
export function monacoSoqlInputScript(): string {
	return monacoLsBridgeScript() + `
(function () {
	var M = ${JSON.stringify(SOQL_INPUT_MSG)};
	// Page-level state shared by every input on the page.
	var shared = null;
	function getShared(opts) {
		if (shared) return shared;
		shared = { byModel: {}, registered: false, configured: false,
			ls: window.ASFXMonacoLs({ key: 'command', post: opts.post, busyId: opts.busyId, cancel: M.cancel,
				results: { completion: M.completion, hover: M.hover, resolve: M.resolve } }) };
		return shared;
	}
	function themeName() {
		var c = document.body ? document.body.classList : null;
		if (!c) return 'vs';
		if (c.contains('vscode-high-contrast-light')) return 'vs';
		return (c.contains('vscode-dark') || c.contains('vscode-high-contrast')) ? 'vs-dark' : 'vs';
	}
	function registerLanguage(S, monaco) {
		if (S.registered) return;
		S.registered = true;
		monaco.languages.register({ id: 'soql' });
		monaco.languages.setMonarchTokensProvider('soql', { ignoreCase: true,
			keywords: ['select','from','where','limit','offset','order','by','group','having','asc','desc','nulls','first','last','and','or','not','like','in','includes','excludes','null','true','false','count','count_distinct','sum','avg','min','max','using','scope','with','data','category','for','view','reference','update','tracking','viewstat','typeof','when','then','else','end'],
			tokenizer: { root: [ [/'(?:[^'\\\\]|\\\\.)*'/, 'string'], [/\\b\\d+(\\.\\d+)?\\b/, 'number'], [/[a-zA-Z_][\\w.]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }] ] } });
		S.ls.register(monaco, 'soql', { completion: M.completion, hover: M.hover, resolve: M.resolve,
			triggerCharacters: ${JSON.stringify(SOQL_TRIGGER_CHARACTERS)},
			// Each request carries the org of the input that owns the model.
			extra: function (model) { var inst = model && model.uri ? S.byModel[model.uri.toString()] : null; return inst ? { org: inst.org() } : {}; } });
		if (typeof MutationObserver === 'function' && document.body) {
			new MutationObserver(function () { try { monaco.editor.setTheme(themeName()); } catch (x) {} })
				.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		}
	}

	window.ASFXSoqlInput = function (opts) {
		var S = getShared(opts);
		var id = opts.containerId;
		var host = document.getElementById(id);
		var editor = null, fallback = null, monacoNs = null, pending = opts.value || '';
		var lastOrg, valTimer = null, placeholderEl = null;
		var minH = opts.minHeight || 80, maxH = opts.maxHeight || 260;
		function org() { try { return (opts.getOrg && opts.getOrg()) || ''; } catch (e) { return ''; } }
		function getValue() { return editor ? editor.getValue() : (fallback ? fallback.value : pending); }
		function updatePlaceholder() { if (placeholderEl) placeholderEl.style.display = getValue() ? 'none' : ''; }
		function call(fn) { if (fn) { try { fn(); } catch (e) { console.error(e); } } }
		function scheduleValidate() {
			if (!editor || opts.validate === false) return;
			if (valTimer) clearTimeout(valTimer);
			valTimer = setTimeout(function () { valTimer = null; if (editor) opts.post({ command: M.validate, input: id, org: org(), text: editor.getValue() }); }, 400);
		}
		/** Tell the host which org the buffer's IntelliSense should use (only when it changed). */
		function syncOrg() {
			var o = org();
			if (o === lastOrg) return;
			lastOrg = o;
			opts.post({ command: M.setOrg, org: o });
			scheduleValidate();
		}
		function setValue(v) {
			v = v == null ? '' : String(v);
			if (editor) { if (editor.getValue() !== v) editor.setValue(v); }
			else if (fallback) fallback.value = v;
			else pending = v;
			updatePlaceholder();
		}
		function fit() {
			if (!editor || !host) return;
			var h = Math.max(minH, Math.min(maxH, Math.ceil(editor.getContentHeight()) + 2));
			if (host.style.height !== h + 'px') { host.style.height = h + 'px'; editor.layout(); }
		}
		function useFallback() {
			if (editor || fallback || !host) return;
			fallback = document.createElement('textarea');
			fallback.className = 'asfx-soql-fallback';
			fallback.spellcheck = false;
			if (opts.placeholder) fallback.placeholder = opts.placeholder;
			if (opts.ariaLabel) fallback.setAttribute('aria-label', opts.ariaLabel);
			fallback.value = pending;
			fallback.addEventListener('input', function () { call(opts.onInput); });
			fallback.addEventListener('blur', function () { call(opts.onBlur); });
			fallback.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && opts.onRun) { e.preventDefault(); call(opts.onRun); } });
			if (placeholderEl) { placeholderEl.remove(); placeholderEl = null; }
			host.appendChild(fallback);
			host.style.height = 'auto';
		}
		function create(monaco) {
			if (!host || editor) return;
			monacoNs = monaco;
			registerLanguage(S, monaco);
			editor = monaco.editor.create(host, { value: pending, language: 'soql', theme: themeName(), automaticLayout: true,
				minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, lineNumbers: 'off', glyphMargin: false, folding: false,
				lineDecorationsWidth: 10, lineNumbersMinChars: 0, renderLineHighlight: 'none', overviewRulerLanes: 0, wordWrap: 'on',
				padding: { top: 6, bottom: 6 }, scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 8 },
				quickSuggestions: ${monacoQuickSuggestions("soql")}, quickSuggestionsDelay: 200, fixedOverflowWidgets: true,
				ariaLabel: opts.ariaLabel || 'SOQL query' });
			pending = '';
			S.byModel[editor.getModel().uri.toString()] = { org: org };
			if (opts.onRun) {
				editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, function () { call(opts.onRun); });
				editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Enter, function () { call(opts.onRun); });
			}
			editor.onDidChangeModelContent(function (e) {
				updatePlaceholder();
				try { monaco.editor.setModelMarkers(editor.getModel(), 'asfx-soql', []); } catch (x) {}
				scheduleValidate();
				// A programmatic \`value = …\` (setValue → flush) is not user input, like a textarea.
				if (!e || !e.isFlush) call(opts.onInput);
			});
			editor.onDidFocusEditorText(syncOrg);
			if (opts.onBlur) editor.onDidBlurEditorText(function () { call(opts.onBlur); });
			if (editor.onDidContentSizeChange) editor.onDidContentSizeChange(fit);
			fit();
			updatePlaceholder();
			syncOrg();
			scheduleValidate();
		}

		if (host) {
			host.style.height = minH + 'px';
			if (opts.placeholder) {
				placeholderEl = document.createElement('div');
				placeholderEl.className = 'asfx-soql-ph';
				placeholderEl.textContent = opts.placeholder;
				host.appendChild(placeholderEl);
			}
		}
		if (opts.orgSelectId) {
			var sel = document.getElementById(opts.orgSelectId);
			if (sel && sel.addEventListener) sel.addEventListener('change', syncOrg);
		}
		var amd = typeof window.require === 'function' ? window.require : null;
		if (!amd || !opts.monacoBase || !host) {
			useFallback();
		} else {
			try {
				if (!S.configured) {
					S.configured = true;
					var base = opts.monacoBase;
					amd.config({ paths: { vs: base } });
					self.MonacoEnvironment = { getWorkerUrl: function () { return URL.createObjectURL(new Blob(["self.MonacoEnvironment={baseUrl:'" + base + "/'};importScripts('" + base + "/base/worker/workerMain.js');"], { type: 'text/javascript' })); } };
				}
				amd(['vs/editor/editor.main'], function () { try { create(window.monaco); } catch (e) { console.error(e); editor = null; useFallback(); } }, function () { useFallback(); });
			} catch (e) { useFallback(); }
		}

		return {
			get value() { return getValue(); },
			set value(v) { setValue(v); },
			focus: function () { if (editor) editor.focus(); else if (fallback) fallback.focus(); },
			/** Re-send the org when the panel changed its selection programmatically. */
			syncOrg: syncOrg,
			/** Route a host message; true when it was a SOQL-input message. */
			handle: function (msg) {
				if (!msg) return false;
				if (msg.command === M.markers) {
					if (msg.input === id && editor && monacoNs && (msg.text == null || msg.text === editor.getValue())) {
						try {
							monacoNs.editor.setModelMarkers(editor.getModel(), 'asfx-soql', (msg.markers || []).map(function (m) {
								return { severity: monacoNs.MarkerSeverity.Error, message: m.message, startLineNumber: m.line + 1, startColumn: m.startCol + 1, endLineNumber: m.line + 1, endColumn: m.endCol + 1 };
							}));
						} catch (x) {}
					}
					return true;
				}
				return S.ls.handle(msg);
			}
		};
	};
})();
`;
}
