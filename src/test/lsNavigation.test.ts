/**
 * Integration tests for the language server's navigation/refactoring features:
 * rename (+ prepareRename), go to implementation, type hierarchy, and the shared
 * symbol search behind references. Spawns the bundled server (../server.js relative
 * to the compiled test) against a temporary workspace of Apex classes.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const FILES: Record<string, string> = {
  "Shape.cls": [
    "public interface Shape {",
    "    Decimal area();",
    "    String label();",
    "}",
    "",
  ].join("\n"),
  "BaseShape.cls": [
    "public abstract class BaseShape implements Shape {",
    "    protected String name;",
    "    public BaseShape(String n) { name = n; }",
    "    public abstract Decimal area();",
    "    public virtual String label() { return name; }",
    "}",
    "",
  ].join("\n"),
  "Circle.cls": [
    "public class Circle extends BaseShape {",
    "    private Decimal radius;",
    "    public Circle(Decimal r) { super('circle'); radius = r; }",
    "    public override Decimal area() { return 3.14 * radius * radius; }",
    "    public override String label() { return 'Circle ' + name; }",
    "}",
    "",
  ].join("\n"),
  "Square.cls": [
    "public class Square implements Shape {",
    "    public Decimal side;",
    "    public Decimal area() { return side * side; }",
    "    public String label() { return 'Square'; }",
    "}",
    "",
  ].join("\n"),
  "Square.cls-meta.xml": '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion></ApexClass>\n',
  "ShapeService.cls": [
    "public with sharing class ShapeService {",          // 0
    "    public static Decimal total(List<Shape> shapes) {", // 1
    "        Decimal sum = 0;",                            // 2
    "        for (Shape s : shapes) {",                    // 3
    "            sum += s.area();",                        // 4
    "        }",                                           // 5
    "        return sum;",                                 // 6
    "    }",                                               // 7
    "    public static Decimal circleArea() {",            // 8
    "        Circle circle = new Circle(2);",              // 9
    "        Square sq = new Square();",                   // 10
    "        sq.side = 3;",                                // 11
    "        Account acc = new Account();",                // 12
    "        acc.Name = 'x';",                             // 13
    "        String sum = String.valueOf(1);",             // 14
    "        System.debug(sum);",                          // 15
    "        return circle.AREA() + sq.area();",           // 16
    "    }",                                               // 17
    "}",                                                   // 18
    "",
  ].join("\n"),
};

let child: cp.ChildProcess;
let conn: any;
let root: string;
let initResult: any;

const fileUri = (name: string) => pathToFileURL(path.join(root, name)).href;
const textOf = (name: string) => FILES[name];

/** Position of the n-th (0-based) occurrence of `needle` in a fixture file (+ `delta` chars). */
function posOf(name: string, needle: string, nth = 0, delta = 1): { line: number; character: number } {
  const lines = textOf(name).split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const at = lines[i].indexOf(needle, from);
      if (at === -1) break;
      if (seen++ === nth) return { line: i, character: at + delta };
      from = at + 1;
    }
  }
  throw new Error(`${needle} #${nth} not found in ${name}`);
}

/** Flatten a WorkspaceEdit to { uri → [lineText-with-range…] } for assertions. */
function editsOf(edit: any): { uri: string; line: number; character: number; length: number; newText: string }[] {
  const out: any[] = [];
  const push = (uri: string, edits: any[]) => {
    for (const e of edits) {
      out.push({ uri, line: e.range.start.line, character: e.range.start.character, length: e.range.end.character - e.range.start.character, newText: e.newText });
    }
  };
  if (edit?.changes) for (const uri of Object.keys(edit.changes)) push(uri, edit.changes[uri]);
  if (edit?.documentChanges) for (const dc of edit.documentChanges) if (dc.edits) push(dc.textDocument.uri, dc.edits);
  return out;
}

/** The original text each edit replaces (checks ranges are exact identifier spans). */
function replacedTexts(edit: any): string[] {
  return editsOf(edit).map((e) => {
    const name = path.basename(new URL(e.uri).pathname);
    return textOf(name).split("\n")[e.line].slice(e.character, e.character + e.length);
  });
}

function countByFile(edit: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of editsOf(edit)) {
    const name = path.basename(new URL(e.uri).pathname);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

async function rejects(p: Promise<any>, re?: RegExp): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    if (re) assert.match(String(e?.message ?? e), re);
    return String(e?.message ?? e);
  }
  assert.fail("expected the request to be rejected");
}

before(async function () {
  this.timeout(20000);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-nav-")));
  for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(root, name), text);

  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
  child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
  conn.onRequest("sfx/objectList", () => ["Account", "Contact"]);
  conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) =>
    sobject === "Account" ? { name: "Account", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }], childRelationships: [] } : null,
  );
  conn.onRequest("sfx/projectInfo", () => ({ namespace: null }));
  conn.onRequest("sfx/objectInfo", () => ({ description: null }));
  conn.onNotification("textDocument/publishDiagnostics", () => undefined);
  conn.listen();
  initResult = await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {
      workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] } },
    },
    initializationOptions: { apexFeatures: true },
  });
  await conn.sendNotification("initialized", {});
  // Requests run on open documents; Square.cls stays closed (read from disk) until a test opens it.
  for (const name of ["ShapeService.cls", "Shape.cls", "BaseShape.cls", "Circle.cls"]) {
    await conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri: fileUri(name), languageId: "apex", version: 1, text: textOf(name) },
    });
  }
});

after(() => {
  try { conn?.dispose(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

const req = (method: string, name: string, pos: { line: number; character: number }, extra: object = {}) =>
  conn.sendRequest(method, { textDocument: { uri: fileUri(name) }, position: pos, ...extra });

describe("navigation capabilities", () => {
  it("advertises rename (with prepare), implementation and type hierarchy", () => {
    const caps = initResult.capabilities;
    assert.deepStrictEqual(caps.renameProvider, { prepareProvider: true });
    assert.strictEqual(caps.implementationProvider, true);
    assert.strictEqual(caps.typeHierarchyProvider, true);
  });
});

describe("rename", () => {
  it("prepareRename returns the identifier range and placeholder for a local", async () => {
    const res: any = await req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "sum += "));
    assert.strictEqual(res.placeholder, "sum");
    assert.deepStrictEqual(res.range, { start: { line: 4, character: 12 }, end: { line: 4, character: 15 } });
  });

  it("renames a local only inside its own method (same name elsewhere untouched)", async () => {
    const edit = await req("textDocument/rename", "ShapeService.cls", posOf("ShapeService.cls", "sum = 0"), { newName: "acc2" });
    const edits = editsOf(edit);
    assert.deepStrictEqual(edits.map((e) => e.line).sort((a, b) => a - b), [2, 4, 6]);
    assert.ok(edits.every((e) => e.newText === "acc2"));
  });

  it("renames a field across files (typed receiver), case-insensitively, not SObject fields", async () => {
    const edit = await req("textDocument/rename", "ShapeService.cls", posOf("ShapeService.cls", "sq.side", 0, 4), { newName: "width" });
    assert.deepStrictEqual(countByFile(edit), { "Square.cls": 3, "ShapeService.cls": 1 });
    assert.ok(replacedTexts(edit).every((t) => t === "side"));
  });

  it("renames an inherited protected field including bare uses in subclasses, skipping acc.Name", async () => {
    const edit = await req("textDocument/rename", "BaseShape.cls", posOf("BaseShape.cls", "String name", 0, 8), { newName: "title" });
    assert.deepStrictEqual(countByFile(edit), { "BaseShape.cls": 3, "Circle.cls": 1 });
  });

  it("renames a method with its whole override/implementation family and call sites", async () => {
    const edit = await req("textDocument/rename", "Circle.cls", posOf("Circle.cls", "area()"), { newName: "computeArea" });
    assert.deepStrictEqual(countByFile(edit), {
      "Shape.cls": 1,
      "BaseShape.cls": 1,
      "Circle.cls": 1,
      "Square.cls": 1,
      "ShapeService.cls": 3,
    });
    // Exact original spans, including the differently-cased call `circle.AREA()`.
    assert.deepStrictEqual(replacedTexts(edit).sort(), ["AREA", "area", "area", "area", "area", "area", "area"]);
  });

  it("renames a class, its constructor and type uses, but not a same-named variable; renames the files", async () => {
    const edit: any = await req("textDocument/rename", "Circle.cls", posOf("Circle.cls", "class Circle", 0, 7), { newName: "Disc" });
    assert.deepStrictEqual(countByFile(edit), { "Circle.cls": 2, "ShapeService.cls": 2 });
    assert.ok(replacedTexts(edit).every((t) => t === "Circle"), "variable `circle` must not be renamed");
    const renames = edit.documentChanges.filter((d: any) => d.kind === "rename");
    assert.deepStrictEqual(renames.map((r: any) => [path.basename(new URL(r.oldUri).pathname), path.basename(new URL(r.newUri).pathname)]), [["Circle.cls", "Disc.cls"]]);
    // File renames come after all text edits.
    const lastEdit = edit.documentChanges.map((d: any) => !!d.edits).lastIndexOf(true);
    const firstRename = edit.documentChanges.findIndex((d: any) => d.kind === "rename");
    assert.ok(lastEdit < firstRename);
  });

  it("renames Square.cls and its -meta.xml with the class", async () => {
    const edit: any = await req("textDocument/rename", "ShapeService.cls", posOf("ShapeService.cls", "new Square", 0, 5), { newName: "Quad" });
    assert.deepStrictEqual(countByFile(edit), { "Square.cls": 1, "ShapeService.cls": 2 });
    const renames = edit.documentChanges.filter((d: any) => d.kind === "rename").map((r: any) => path.basename(new URL(r.newUri).pathname));
    assert.deepStrictEqual(renames, ["Quad.cls", "Quad.cls-meta.xml"]);
  });

  it("rejects schema, standard library, keywords and unresolvable symbols", async () => {
    await rejects(req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "Account acc", 0, 2)), /schema|not declared/i);
    await rejects(req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "acc.Name", 0, 5)), /Account/);
    await rejects(req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "String sum", 0, 2)), /standard/i);
    await rejects(req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "System.debug", 0, 8)), /standard/i);
    await rejects(req("textDocument/prepareRename", "ShapeService.cls", posOf("ShapeService.cls", "public static")), /keyword/i);
  });

  it("rejects invalid or reserved new names and type-name clashes", async () => {
    const at = posOf("ShapeService.cls", "sum = 0");
    await rejects(req("textDocument/rename", "ShapeService.cls", at, { newName: "1abc" }), /identifier/);
    await rejects(req("textDocument/rename", "ShapeService.cls", at, { newName: "trigger" }), /reserved/);
    await rejects(req("textDocument/rename", "ShapeService.cls", at, { newName: "a__b" }), /underscore/);
    await rejects(req("textDocument/rename", "Circle.cls", posOf("Circle.cls", "class Circle", 0, 7), { newName: "square" }), /already exists/);
  });

  it("uses the open buffer's unsaved text", async () => {
    const uri = fileUri("Square.cls");
    const text = textOf("Square.cls").replace("return 'Square';", "return 'Square' + side;");
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text } });
    try {
      const edit = await req("textDocument/rename", "Square.cls", posOf("Square.cls", "Decimal side", 0, 9), { newName: "width" });
      assert.deepStrictEqual(countByFile(edit), { "Square.cls": 4, "ShapeService.cls": 1 });
      const sq = editsOf(edit).filter((e) => e.uri === uri);
      assert.ok(sq.some((e) => e.line === 3), "edit on the unsaved line");
      assert.ok(editsOf(edit).filter((e) => e.uri === uri).every((e) => e.newText === "width"));
    } finally {
      await conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
  });
});

describe("references (shared symbol search)", () => {
  it("finds an inherited field's uses across the hierarchy but not SObject fields of the same name", async () => {
    const locs: any[] = await req("textDocument/references", "Circle.cls", posOf("Circle.cls", "+ name", 0, 3), { context: { includeDeclaration: true } });
    const files = locs.map((l) => path.basename(new URL(l.uri).pathname)).sort();
    assert.deepStrictEqual(files, ["BaseShape.cls", "BaseShape.cls", "BaseShape.cls", "Circle.cls"]);
  });

  it("honors includeDeclaration: false", async () => {
    const locs: any[] = await req("textDocument/references", "ShapeService.cls", posOf("ShapeService.cls", "sum = 0"), { context: { includeDeclaration: false } });
    assert.deepStrictEqual(locs.map((l) => l.range.start.line).sort((a, b) => a - b), [4, 6]);
  });
});

describe("go to implementation", () => {
  const names = (locs: any[]) => locs.map((l) => path.basename(new URL(l.uri).pathname)).sort();

  it("interface → implementing classes (transitively)", async () => {
    const locs = await req("textDocument/implementation", "Shape.cls", posOf("Shape.cls", "interface Shape", 0, 11));
    assert.deepStrictEqual(names(locs), ["BaseShape.cls", "Circle.cls", "Square.cls"]);
  });

  it("abstract class → subclasses", async () => {
    const locs = await req("textDocument/implementation", "BaseShape.cls", posOf("BaseShape.cls", "class BaseShape", 0, 7));
    assert.deepStrictEqual(names(locs), ["Circle.cls"]);
  });

  it("interface method → implementing methods (abstract declarations excluded)", async () => {
    const locs: any[] = await req("textDocument/implementation", "Shape.cls", posOf("Shape.cls", "area"));
    assert.deepStrictEqual(names(locs), ["Circle.cls", "Square.cls"]);
    assert.ok(locs.every((l) => l.range.end.character - l.range.start.character === 4));
  });

  it("virtual method and call site through the interface type", async () => {
    const fromVirtual = await req("textDocument/implementation", "BaseShape.cls", posOf("BaseShape.cls", "label"));
    assert.deepStrictEqual(names(fromVirtual), ["Circle.cls"]);
    const fromCall = await req("textDocument/implementation", "ShapeService.cls", posOf("ShapeService.cls", "s.area", 0, 3));
    assert.deepStrictEqual(names(fromCall), ["Circle.cls", "Square.cls"]);
  });
});

describe("type hierarchy", () => {
  it("prepare + supertypes + subtypes", async () => {
    const items: any[] = await req("textDocument/prepareTypeHierarchy", "ShapeService.cls", posOf("ShapeService.cls", "Circle circle"));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].name, "Circle");
    const sup1: any[] = await conn.sendRequest("typeHierarchy/supertypes", { item: items[0] });
    assert.deepStrictEqual(sup1.map((i) => i.name), ["BaseShape"]);
    const sup2: any[] = await conn.sendRequest("typeHierarchy/supertypes", { item: sup1[0] });
    assert.deepStrictEqual(sup2.map((i) => i.name), ["Shape"]);
    assert.strictEqual(sup2[0].kind, 11 /* Interface */);
    const subs: any[] = await conn.sendRequest("typeHierarchy/subtypes", { item: sup2[0] });
    assert.deepStrictEqual(subs.map((i) => i.name).sort(), ["BaseShape", "Square"]);
    // selectionRange is the declared name in its file.
    const sq = subs.find((i) => i.name === "Square");
    assert.deepStrictEqual(sq.selectionRange, { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } });
  });

  it("returns nothing for non-types", async () => {
    const items = await req("textDocument/prepareTypeHierarchy", "ShapeService.cls", posOf("ShapeService.cls", "Account acc", 0, 2));
    assert.ok(!items || items.length === 0);
  });
});
