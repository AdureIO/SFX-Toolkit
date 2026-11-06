import * as assert from "assert";
import * as vm from "vm";
import { monacoSoqlInputScript, SOQL_INPUT_MSG } from "../webview/monacoSoqlInput";
import { SOQL_TRIGGER_CHARACTERS } from "../webview/monacoLsBridge";

const j = (x: unknown) => JSON.parse(JSON.stringify(x));

/** Minimal DOM element. */
function el(id = "") {
	const listeners: Record<string, ((e?: any) => void)[]> = {};
	const e: any = {
		id, value: "", style: {}, children: [] as any[], className: "", placeholder: "", textContent: "",
		appendChild(c: any) { e.children.push(c); return c; },
		remove() { /* detached */ },
		setAttribute(k: string, v: string) { e[k] = v; },
		addEventListener(t: string, fn: (ev?: any) => void) { (listeners[t] = listeners[t] || []).push(fn); },
		fire(t: string, ev?: any) { (listeners[t] || []).forEach((f) => f(ev)); },
		focus() { e.focused = true; },
	};
	return e;
}

/** Fake Monaco editor + namespace recording what the input script does. */
function fakeMonaco() {
	const editors: any[] = [];
	const providers: any = {};
	const markers: any[] = [];
	let modelSeq = 0;
	const monaco: any = {
		KeyMod: { CtrlCmd: 2048, WinCtrl: 256 }, KeyCode: { Enter: 3 },
		MarkerSeverity: { Error: 8 },
		languages: {
			registered: [] as string[],
			register: (l: any) => monaco.languages.registered.push(l.id),
			setMonarchTokensProvider: () => undefined,
			CompletionItemKind: { Field: 3, Text: 18 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 }, CompletionItemTag: { Deprecated: 1 },
			registerCompletionItemProvider: (_id: string, p: any) => { providers.completion = p; },
			registerHoverProvider: (_id: string, p: any) => { providers.hover = p; },
		},
		editor: {
			setTheme: () => undefined,
			setModelMarkers: (_m: any, owner: string, list: any[]) => markers.push({ owner, list }),
			create(host: any, o: any) {
				let value = o.value;
				const change: ((e: any) => void)[] = [], focus: (() => void)[] = [], blur: (() => void)[] = [];
				const commands: Record<number, () => void> = {};
				const uri = `inmemory://model/${++modelSeq}`;
				const model = { uri: { toString: () => uri }, getValue: () => value, getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }), getWordAtPosition: () => null };
				const ed: any = {
					host, options: o, model, commands,
					getValue: () => value,
					setValue: (v: string) => { value = v; change.forEach((f) => f({ isFlush: true })); },
					type: (v: string) => { value = v; change.forEach((f) => f({ isFlush: false })); },
					getModel: () => model, focus: () => { ed.focused = true; }, layout: () => undefined, getContentHeight: () => 40,
					addCommand: (k: number, fn: () => void) => { commands[k] = fn; },
					onDidChangeModelContent: (f: any) => change.push(f),
					onDidFocusEditorText: (f: any) => focus.push(f), onDidBlurEditorText: (f: any) => blur.push(f),
					onDidContentSizeChange: () => undefined,
					fireFocus: () => focus.forEach((f) => f()), fireBlur: () => blur.forEach((f) => f()),
				};
				editors.push(ed);
				return ed;
			},
		},
	};
	return { monaco, editors, providers, markers };
}

function load(opts: { withMonaco?: boolean } = {}) {
	const els: Record<string, any> = { "q1": el("q1"), "q2": el("q2"), "org1": el("org1"), "org2": el("org2"), "busy": el("busy") };
	els.org1.value = "src@x.com";
	els.org2.value = "other@x.com";
	const timers: (() => void)[] = [];
	const fm = fakeMonaco();
	const amdCalls: any[] = [];
	const sandbox: any = {
		document: { getElementById: (id: string) => els[id] || null, createElement: () => el(), body: { classList: { contains: (c: string) => c === "vscode-dark" } } },
		setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
		clearTimeout: () => undefined,
		console,
		URL: { createObjectURL: () => "blob:x" }, Blob: function () { /* */ },
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	if (opts.withMonaco !== false) {
		const amd: any = (deps: string[], ok: () => void) => { amdCalls.push(deps); sandbox.monaco = fm.monaco; ok(); };
		amd.config = (c: any) => amdCalls.push(c);
		sandbox.require = amd;
	}
	vm.createContext(sandbox);
	new vm.Script(monacoSoqlInputScript(), { filename: "monacoSoqlInput.js" }).runInContext(sandbox);
	const posted: any[] = [];
	const post = (m: any) => posted.push(m);
	return { sandbox, els, timers, posted, post, amdCalls, ...fm };
}

const flushTimers = (timers: (() => void)[]) => timers.splice(0).forEach((f) => f());

describe("monacoSoqlInput webview script", () => {
	it("compiles (node --check equivalent)", () => {
		assert.doesNotThrow(() => new vm.Script(monacoSoqlInputScript()));
	});

	it("creates a dark SOQL Monaco editor and behaves like a textarea", () => {
		const t = load();
		const inputs: string[] = [];
		const q = t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "https://x/vs", post: t.post, value: "SELECT Id FROM Account",
			getOrg: () => t.els.org1.value, placeholder: "SELECT …", onInput: () => inputs.push(q.value) });
		assert.deepStrictEqual(j(t.amdCalls[0]), { paths: { vs: "https://x/vs" } });
		assert.deepStrictEqual(t.monaco.languages.registered, ["soql"]);
		const ed = t.editors[0];
		assert.strictEqual(ed.options.language, "soql");
		assert.strictEqual(ed.options.theme, "vs-dark");
		assert.strictEqual(ed.options.fixedOverflowWidgets, true);
		assert.strictEqual(q.value, "SELECT Id FROM Account");
		q.value = "SELECT Name FROM Contact"; // programmatic → no input event
		assert.strictEqual(ed.getValue(), "SELECT Name FROM Contact");
		assert.deepStrictEqual(inputs, []);
		ed.type("SELECT Name FROM Lead"); // user edit → input event
		assert.deepStrictEqual(inputs, ["SELECT Name FROM Lead"]);
		q.focus();
		assert.ok(ed.focused);
		assert.deepStrictEqual(j(t.providers.completion.triggerCharacters), SOQL_TRIGGER_CHARACTERS);
	});

	it("buffers value set before Monaco loads", () => {
		const t = load();
		let ready: (() => void) | undefined;
		t.sandbox.require = Object.assign((_d: string[], ok: () => void) => { ready = () => { t.sandbox.monaco = t.monaco; ok(); }; }, { config: () => undefined });
		const q = t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post });
		q.value = "SELECT Id FROM Case";
		assert.strictEqual(q.value, "SELECT Id FROM Case");
		ready!();
		assert.strictEqual(t.editors[0].getValue(), "SELECT Id FROM Case");
	});

	it("Ctrl/Cmd+Enter runs; blur callback fires", () => {
		const t = load();
		let runs = 0, blurs = 0;
		t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post, onRun: () => runs++, onBlur: () => blurs++ });
		const ed = t.editors[0];
		ed.commands[2048 | 3]();
		ed.commands[256 | 3]();
		ed.fireBlur();
		assert.strictEqual(runs, 2);
		assert.strictEqual(blurs, 1);
	});

	it("syncs the org (on create, select change, focus — only when it changed) and validates", () => {
		const t = load();
		t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post, value: "SELECT Id FROM Account", getOrg: () => t.els.org1.value, orgSelectId: "org1" });
		assert.deepStrictEqual(j(t.posted), [{ command: SOQL_INPUT_MSG.setOrg, org: "src@x.com" }]);
		t.els.org1.fire("change"); // same org → nothing
		t.editors[0].fireFocus();
		assert.strictEqual(t.posted.length, 1);
		t.els.org1.value = "sandbox@x.com";
		t.els.org1.fire("change");
		assert.deepStrictEqual(j(t.posted[1]), { command: SOQL_INPUT_MSG.setOrg, org: "sandbox@x.com" });
		flushTimers(t.timers);
		assert.deepStrictEqual(j(t.posted[2]), { command: SOQL_INPUT_MSG.validate, input: "q1", org: "sandbox@x.com", text: "SELECT Id FROM Account" });
	});

	it("completion requests carry the org of the input owning the model (two inputs, one LS glue)", async () => {
		const t = load();
		const a = t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post, getOrg: () => t.els.org1.value });
		t.sandbox.ASFXSoqlInput({ containerId: "q2", monacoBase: "b", post: t.post, getOrg: () => t.els.org2.value });
		assert.deepStrictEqual(t.monaco.languages.registered, ["soql"], "language registered once");
		t.posted.length = 0;
		const p1 = t.providers.completion.provideCompletionItems(t.editors[0].model, { lineNumber: 1, column: 1 }, { triggerKind: 0 }, undefined);
		const p2 = t.providers.completion.provideCompletionItems(t.editors[1].model, { lineNumber: 1, column: 1 }, { triggerKind: 0 }, undefined);
		assert.strictEqual(t.posted[0].command, SOQL_INPUT_MSG.completion);
		assert.strictEqual(t.posted[0].org, "src@x.com");
		assert.strictEqual(t.posted[1].org, "other@x.com");
		assert.notStrictEqual(t.posted[0].requestId, t.posted[1].requestId);
		// Any input's handle() routes the shared replies.
		assert.strictEqual(a.handle({ command: SOQL_INPUT_MSG.completion, requestId: t.posted[1].requestId, items: [{ label: "Name", kind: "Field" }], listId: 1 }), true);
		assert.strictEqual(a.handle({ command: SOQL_INPUT_MSG.completion, requestId: t.posted[0].requestId, dropped: true }), true);
		assert.strictEqual((await p2).suggestions.length, 1);
		assert.strictEqual((await p1).suggestions.length, 0);
		assert.strictEqual(a.handle({ command: "init" }), false);
	});

	it("applies markers only to the matching, unchanged input", () => {
		const t = load();
		const a = t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post, value: "SELECT Foo FROM Account" });
		t.markers.length = 0;
		const mk = [{ line: 0, startCol: 7, endCol: 10, message: "No such column 'Foo'" }];
		assert.strictEqual(a.handle({ command: SOQL_INPUT_MSG.markers, input: "q2", text: "SELECT Foo FROM Account", markers: mk }), true);
		assert.strictEqual(a.handle({ command: SOQL_INPUT_MSG.markers, input: "q1", text: "stale", markers: mk }), true);
		assert.strictEqual(t.markers.length, 0);
		a.handle({ command: SOQL_INPUT_MSG.markers, input: "q1", text: "SELECT Foo FROM Account", markers: mk });
		assert.deepStrictEqual(j(t.markers[0]), { owner: "asfx-soql", list: [{ severity: 8, message: "No such column 'Foo'", startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 11 }] });
	});

	it("falls back to a plain textarea when Monaco's loader is missing", () => {
		const t = load({ withMonaco: false });
		const inputs: number[] = [];
		let runs = 0;
		const q = t.sandbox.ASFXSoqlInput({ containerId: "q1", monacoBase: "b", post: t.post, value: "SELECT Id FROM Account", placeholder: "SELECT …", onInput: () => inputs.push(1), onRun: () => runs++ });
		const ta = t.els.q1.children.find((c: any) => c.className === "asfx-soql-fallback");
		assert.ok(ta, "textarea created");
		assert.strictEqual(ta.value, "SELECT Id FROM Account");
		assert.strictEqual(ta.placeholder, "SELECT …");
		q.value = "x";
		assert.strictEqual(ta.value, "x");
		ta.fire("input");
		ta.fire("keydown", { key: "Enter", metaKey: true, preventDefault() { /* */ } });
		assert.deepStrictEqual(inputs, [1]);
		assert.strictEqual(runs, 1);
	});
});
