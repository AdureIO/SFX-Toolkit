import * as assert from "assert";
import * as vm from "vm";
import { monacoLsBridgeScript, APEX_TRIGGER_CHARACTERS, SOQL_TRIGGER_CHARACTERS } from "../webview/monacoLsBridge";

/** Plain (main-realm) copy of a sandbox object, for deepStrictEqual. */
const j = (x: unknown) => JSON.parse(JSON.stringify(x));

/** Run the webview script in a sandbox with a fake DOM + Monaco and return its factory. */
function load() {
  const busyEl = { style: { display: "none" } };
  const timers: (() => void)[] = [];
  const sandbox: any = {
    window: {},
    document: { getElementById: (id: string) => (id === "busy" ? busyEl : null) },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => undefined,
  };
  vm.createContext(sandbox);
  new vm.Script(monacoLsBridgeScript(), { filename: "monacoLsBridge.js" }).runInContext(sandbox);
  const providers: any = {};
  const monaco = {
    languages: {
      CompletionItemKind: { Method: 0, Field: 3, Class: 5, Text: 18 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      CompletionItemTag: { Deprecated: 1 },
      registerCompletionItemProvider: (_id: string, p: any) => { providers.completion = p; },
      registerHoverProvider: (_id: string, p: any) => { providers.hover = p; },
    },
  };
  const posted: any[] = [];
  const ls = sandbox.window.ASFXMonacoLs({
    key: "type", post: (m: any) => posted.push(m), busyId: "busy", cancel: "cancelRequest",
    results: { completion: "completionResult", hover: "hoverResult", resolve: "resolveResult" },
  });
  ls.register(monaco, "apex", { completion: "getCompletions", hover: "getHover", resolve: "resolveCompletion", triggerCharacters: APEX_TRIGGER_CHARACTERS });
  const model = { getValue: () => "acc.Na", getWordUntilPosition: () => ({ startColumn: 5, endColumn: 7 }), getWordAtPosition: () => null };
  return { ls, providers, posted, model, busyEl, timers };
}

function token() {
  const cbs: (() => void)[] = [];
  return { onCancellationRequested: (cb: () => void) => cbs.push(cb), fire: () => cbs.forEach((c) => c()) };
}

describe("monacoLsBridge webview script", () => {
  it("compiles (node --check equivalent)", () => {
    assert.doesNotThrow(() => new vm.Script(monacoLsBridgeScript()));
  });

  it("trigger characters are aligned with the server and drop `_`", () => {
    assert.ok(!APEX_TRIGGER_CHARACTERS.includes("_"));
    for (const c of [".", " ", ",", "(", "'", "@"]) assert.ok(APEX_TRIGGER_CHARACTERS.includes(c), c);
    for (const c of [".", " ", ",", "(", "'", "\n"]) assert.ok(SOQL_TRIGGER_CHARACTERS.includes(c), c);
  });

  it("forwards trigger info and passes the full list + incomplete to Monaco", async () => {
    const { ls, providers, posted, model } = load();
    assert.deepStrictEqual(providers.completion.triggerCharacters, APEX_TRIGGER_CHARACTERS);
    const p = providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 7 }, { triggerKind: 1, triggerCharacter: "." }, token());
    const req = posted[0];
    assert.strictEqual(req.type, "getCompletions");
    assert.strictEqual(req.triggerKind, 2); // Monaco TriggerCharacter(1) → LSP TriggerCharacter(2)
    assert.strictEqual(req.triggerCharacter, ".");
    assert.strictEqual(req.line, 0);
    assert.strictEqual(req.character, 6);
    const items = Array.from({ length: 1000 }, (_, i) => ({ label: "F" + i, kind: "Field", insertText: "F" + i }));
    items[0] = { label: { label: "Name", description: "string" } as any, kind: "Field", insertText: "Name", range: { insert: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 7 }, replace: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 9 } } } as any;
    assert.strictEqual(ls.handle({ type: "completionResult", requestId: req.requestId, items, incomplete: true, listId: 1 }), true);
    const res = await p;
    assert.strictEqual(res.suggestions.length, 1000);
    assert.strictEqual(res.incomplete, true);
    assert.strictEqual(res.suggestions[0].kind, 3);
    assert.ok(res.suggestions[0].range.replace, "insert/replace range kept");
    assert.deepStrictEqual(j(res.suggestions[1].range), { startLineNumber: 1, endLineNumber: 1, startColumn: 5, endColumn: 7 });
  });

  it("posts a cancel when Monaco cancels and ignores the late answer", async () => {
    const { ls, providers, posted, model } = load();
    const t = token();
    const p = providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 7 }, { triggerKind: 0 }, t);
    const id = posted[0].requestId;
    t.fire();
    assert.deepStrictEqual(j(posted[1]), { type: "cancelRequest", requestId: id });
    assert.deepStrictEqual(j((await p).suggestions), []);
    assert.strictEqual(ls.handle({ type: "completionResult", requestId: id, items: [{ label: "x", kind: "Text" }] }), true);
  });

  it("shows the busy spinner only after the 250 ms delay", async () => {
    const { ls, providers, posted, model, busyEl, timers } = load();
    const p = providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 7 }, { triggerKind: 0 }, token());
    assert.strictEqual(busyEl.style.display, "none");
    timers.forEach((f) => f()); // the 250 ms timer elapses while still pending
    assert.strictEqual(busyEl.style.display, "inline-flex");
    ls.handle({ type: "completionResult", requestId: posted[0].requestId, dropped: true });
    await p;
    assert.strictEqual(busyEl.style.display, "none");
  });

  it("lazily resolves items that carry a resolve id", async () => {
    const { ls, providers, posted, model } = load();
    const p = providers.completion.provideCompletionItems(model, { lineNumber: 1, column: 7 }, { triggerKind: 0 }, token());
    ls.handle({ type: "completionResult", requestId: posted[0].requestId, items: [{ label: "a", kind: "Method", insertText: "a", resolveId: 0 }], listId: 9 });
    const [s] = (await p).suggestions;
    const rp = providers.completion.resolveCompletionItem(s, token());
    const rq = posted[1];
    assert.strictEqual(rq.type, "resolveCompletion");
    assert.strictEqual(rq.listId, 9);
    assert.strictEqual(rq.resolveId, 0);
    ls.handle({ type: "resolveResult", requestId: rq.requestId, item: { documentation: { value: "**doc**" }, detail: "void a()" } });
    const resolved = await rp;
    assert.deepStrictEqual(j(resolved.documentation), { value: "**doc**" });
    assert.strictEqual(resolved.detail, "void a()");
  });
});
