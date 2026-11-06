import * as assert from "assert";
import {
  RequestGate,
  completionToWire,
  definitionTargets,
  hoverToWire,
  lspKindToMonacoName,
  vscodeCompletionItemToLsp,
} from "../providers/bufferBridgeCore";

const pos = { line: 2, character: 10 };
const r = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

describe("bufferBridgeCore: completion conversion", () => {
  it("keeps every item (no 200 cap) and passes isIncomplete through", () => {
    const items = Array.from({ length: 4500 }, (_, i) => ({ label: `Item${i}`, kind: 7 }));
    const out = completionToWire({ isIncomplete: true, items }, { position: pos });
    assert.strictEqual(out.items.length, 4500);
    assert.strictEqual(out.incomplete, true);
    const arr = completionToWire(items.slice(0, 3), { position: pos });
    assert.strictEqual(arr.incomplete, false);
    assert.strictEqual(arr.items.length, 3);
  });

  it("maps every LSP kind to a Monaco kind name", () => {
    const expected = ["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"];
    expected.forEach((name, i) => assert.strictEqual(lspKindToMonacoName(i + 1), name));
    assert.strictEqual(lspKindToMonacoName(undefined), "Text");
    assert.strictEqual(lspKindToMonacoName(99), "Text");
  });

  it("converts textEdit ranges (single + insert/replace) to 1-based Monaco ranges", () => {
    const out = completionToWire(
      [
        { label: "Name", textEdit: { range: r(2, 8, 2, 10), newText: "Name" } },
        { label: "Owner", textEdit: { insert: r(2, 8, 2, 10), replace: r(2, 8, 2, 14), newText: "Owner" } },
      ],
      { position: pos },
    );
    assert.deepStrictEqual(out.items[0].range, { startLineNumber: 3, startColumn: 9, endLineNumber: 3, endColumn: 11 });
    assert.deepStrictEqual(out.items[1].range, {
      insert: { startLineNumber: 3, startColumn: 9, endLineNumber: 3, endColumn: 11 },
      replace: { startLineNumber: 3, startColumn: 9, endLineNumber: 3, endColumn: 15 },
    });
  });

  it("drops edit ranges Monaco would reject (other line / multi-line) but keeps the item", () => {
    const out = completionToWire([{ label: "X", textEdit: { range: r(1, 0, 2, 10), newText: "X()" } }], { position: pos });
    assert.strictEqual(out.items.length, 1);
    assert.strictEqual(out.items[0].range, undefined);
    assert.strictEqual(out.items[0].insertText, "X()");
  });

  it("keeps additionalTextEdits, labelDetails, snippet format, sortText/filterText, docs and Monaco commands", () => {
    const [w] = completionToWire(
      [
        {
          label: "query",
          labelDetails: { detail: "(String q)", description: "Database" },
          kind: 2,
          insertText: "query(${1:q})",
          insertTextFormat: 2,
          additionalTextEdits: [{ range: r(0, 0, 0, 0), newText: "// x\n" }],
          sortText: "0_query",
          filterText: "query",
          documentation: { kind: "markdown", value: "**doc**" },
          command: { command: "editor.action.triggerParameterHints", title: "hints" },
          tags: [1],
        },
      ],
      { position: pos },
    ).items;
    assert.deepStrictEqual(w.label, { label: "query", detail: "(String q)", description: "Database" });
    assert.strictEqual(w.kind, "Method");
    assert.strictEqual(w.snippet, true);
    assert.strictEqual(w.insertText, "query(${1:q})");
    assert.deepStrictEqual(w.additionalTextEdits, [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "// x\n" }]);
    assert.strictEqual(w.sortText, "0_query");
    assert.strictEqual(w.filterText, "query");
    assert.deepStrictEqual(w.documentation, { value: "**doc**" });
    assert.strictEqual(w.command?.id, "editor.action.triggerParameterHints");
    assert.strictEqual(w.deprecated, true);
  });

  it("drops commands Monaco can't run in the webview; plaintext docs stay strings", () => {
    const [w] = completionToWire([{ label: "a", command: { command: "sfx.server.only", title: "" }, documentation: { kind: "plaintext", value: "plain" } }], { position: pos }).items;
    assert.strictEqual(w.command, undefined);
    assert.strictEqual(w.documentation, "plain");
  });

  it("applies CompletionList.itemDefaults (editRange, insertTextFormat)", () => {
    const [w] = completionToWire(
      { isIncomplete: false, itemDefaults: { editRange: r(2, 7, 2, 10), insertTextFormat: 2 }, items: [{ label: "Id" }] },
      { position: pos },
    ).items;
    assert.deepStrictEqual(w.range, { startLineNumber: 3, startColumn: 8, endLineNumber: 3, endColumn: 11 });
    assert.strictEqual(w.snippet, true);
  });

  it("collapses exact duplicates (no duplicate labels from one list)", () => {
    const out = completionToWire([{ label: "Name", kind: 5 }, { label: "Name", kind: 5 }, { label: "Name", kind: 7 }], { position: pos });
    assert.strictEqual(out.items.length, 2);
  });

  it("attaches resolve ids that index the returned raw list", () => {
    const out = completionToWire([{ label: "a" }, { label: "a" }, { label: "b", data: { k: 1 } }], { position: pos, withResolveIds: true });
    assert.deepStrictEqual(out.items.map((i) => i.resolveId), [0, 1]);
    assert.strictEqual(out.raw[out.items[1].resolveId!].label, "b");
  });

  it("normalizes VS Code items on the fallback path (0-based kind, SnippetString, insert/replace range)", () => {
    const lsp = vscodeCompletionItemToLsp({
      label: { label: "Foo", description: "cls" },
      kind: 6, // vscode Class
      insertText: { value: "Foo($1)" },
      range: { inserting: r(2, 8, 2, 10), replacing: r(2, 8, 2, 12) },
      sortText: "1",
    });
    const [w] = completionToWire([lsp], { position: pos }).items;
    assert.strictEqual(w.kind, "Class");
    assert.strictEqual(w.snippet, true);
    assert.strictEqual(w.insertText, "Foo($1)");
    assert.ok(w.range && "insert" in w.range);
    assert.deepStrictEqual(w.label, { label: "Foo", detail: undefined, description: "cls" });
  });
});

describe("bufferBridgeCore: hover + definition", () => {
  it("flattens MarkupContent / MarkedString[] / vscode Hover[]", () => {
    assert.deepStrictEqual(hoverToWire({ contents: { kind: "markdown", value: "**A**" }, range: r(0, 1, 0, 4) }), {
      contents: ["**A**"],
      range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 },
    });
    assert.deepStrictEqual(hoverToWire({ contents: ["x", { language: "apex", value: "Integer i" }] })?.contents, ["x", "```apex\nInteger i\n```"]);
    assert.deepStrictEqual(hoverToWire([{ contents: [{ value: "md" }] }, { contents: ["  "] }])?.contents, ["md"]);
    assert.strictEqual(hoverToWire(null), null);
    assert.strictEqual(hoverToWire({ contents: [] }), null);
  });

  it("normalizes Location, Location[] and LocationLink[]", () => {
    assert.deepStrictEqual(definitionTargets({ uri: "file:///a.cls", range: r(1, 2, 1, 5) }), [{ uri: "file:///a.cls", range: r(1, 2, 1, 5) }]);
    assert.deepStrictEqual(
      definitionTargets([{ targetUri: "asfx-buffer:/x.apex", targetRange: r(0, 0, 9, 0), targetSelectionRange: r(3, 4, 3, 8) }]),
      [{ uri: "asfx-buffer:/x.apex", range: r(3, 4, 3, 8) }],
    );
    assert.deepStrictEqual(definitionTargets(null), []);
  });
});

class FakeSource {
  cancelled = false;
  disposed = false;
  cancel() { this.cancelled = true; }
  dispose() { this.disposed = true; }
}

describe("bufferBridgeCore: RequestGate", () => {
  const tick = () => new Promise((res) => setTimeout(res, 0));

  it("serializes work in arrival order", async () => {
    const gate = new RequestGate(() => new FakeSource());
    const log: string[] = [];
    const slow = (name: string, ms: number) => async () => { log.push(name + ">"); await new Promise((res) => setTimeout(res, ms)); log.push("<" + name); };
    await Promise.all([gate.run("sync", undefined, slow("a", 15)), gate.run("sync", undefined, slow("b", 1))]);
    assert.deepStrictEqual(log, ["a>", "<a", "b>", "<b"]);
  });

  it("drops superseded same-kind requests before they run and cancels the running one", async () => {
    const gate = new RequestGate(() => new FakeSource());
    const ran: number[] = [];
    let firstSource: FakeSource | undefined;
    let release!: () => void;
    const blocker = new Promise<void>((res) => (release = res));
    const p1 = gate.run("completion", 1, async (s) => { firstSource = s; ran.push(1); await blocker; return 1; });
    await tick();
    const p2 = gate.run("completion", 2, async () => { ran.push(2); return 2; });
    const p3 = gate.run("completion", 3, async () => { ran.push(3); return 3; });
    const h = gate.run("hover", 4, async () => { ran.push(4); return 4; }); // other kind: not superseded
    assert.ok(firstSource?.cancelled, "running request 1 got cancelled by newer request");
    release();
    const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, h]);
    assert.deepStrictEqual(r1, { dropped: false, value: 1 });
    assert.deepStrictEqual(r2, { dropped: true });
    assert.deepStrictEqual(r3, { dropped: false, value: 3 });
    assert.deepStrictEqual(r4, { dropped: false, value: 4 });
    assert.deepStrictEqual(ran, [1, 3, 4]);
    assert.ok(firstSource?.disposed);
  });

  it("webview cancel drops a queued request and cancels a running one", async () => {
    const gate = new RequestGate(() => new FakeSource());
    let src: FakeSource | undefined;
    let release!: () => void;
    const blocker = new Promise<void>((res) => (release = res));
    const p1 = gate.run("hover", 10, async (s) => { src = s; await blocker; return "h"; });
    const p2 = gate.run("completion", 11, async () => "c");
    await tick();
    gate.cancel(11);
    gate.cancel(10);
    assert.ok(src?.cancelled);
    release();
    assert.deepStrictEqual(await p1, { dropped: false, value: "h" });
    assert.deepStrictEqual(await p2, { dropped: true });
  });

  it("keeps the chain alive after a failing task", async () => {
    const gate = new RequestGate(() => new FakeSource());
    await assert.rejects(gate.run("sync", undefined, async () => { throw new Error("boom"); }));
    assert.deepStrictEqual(await gate.run("sync", undefined, async () => 7), { dropped: false, value: 7 });
  });
});
