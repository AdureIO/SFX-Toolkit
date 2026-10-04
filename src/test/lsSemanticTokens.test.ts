/**
 * Integration tests for semantic highlighting in the ASFX language server
 * (textDocument/semanticTokens/full, /full/delta, /range + workspace refresh).
 * Spawns the bundled out/server.js, plays the extension host (object list +
 * describes from fixtures) and checks how identifiers are classified — in
 * particular that SObject fields are told apart from local variables.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const OBJECTS = ["Account", "Contact", "Opportunity"];
const DESCRIBES: Record<string, any> = {
  Account: {
    name: "Account",
    fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }, { name: "Industry", type: "picklist" }],
    childRelationships: [{ name: "Contacts", childSObject: "Contact" }],
  },
  Contact: {
    name: "Contact",
    fields: [
      { name: "Id", type: "id" },
      { name: "LastName", type: "string" },
      { name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"] },
    ],
    childRelationships: [],
  },
  Opportunity: {
    name: "Opportunity",
    fields: [
      { name: "Id", type: "id" },
      { name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"] },
    ],
    childRelationships: [],
  },
};

interface Server {
  child: cp.ChildProcess;
  conn: any;
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
  caps: any;
  describeCalls: string[];
  refreshes: number;
}

async function startServer(initOptions: Record<string, unknown>): Promise<Server> {
  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
  const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
  const s: Server = { child, conn, legend: { tokenTypes: [], tokenModifiers: [] }, caps: {}, describeCalls: [], refreshes: 0 };
  conn.onRequest("sfx/objectList", () => OBJECTS);
  conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) => {
    s.describeCalls.push(sobject);
    return DESCRIBES[sobject] ?? null;
  });
  conn.onRequest("sfx/projectInfo", () => ({ namespace: null }));
  conn.onRequest("sfx/objectInfo", () => ({ description: null }));
  conn.onRequest("workspace/semanticTokens/refresh", () => {
    s.refreshes++;
    return null;
  });
  conn.onNotification("textDocument/publishDiagnostics", () => undefined);
  conn.listen();
  const tmpRoot = path.join(os.tmpdir(), "sfx-semtok-" + process.pid);
  fs.mkdirSync(tmpRoot, { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "Helper.cls"), "public class Helper {\n  public static String greet(String w) { return w; }\n}\n");
  const res = await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(tmpRoot).href,
    capabilities: { workspace: { semanticTokens: { refreshSupport: true } } },
    initializationOptions: initOptions,
  });
  await conn.sendNotification("initialized", {});
  s.caps = res.capabilities;
  s.legend = res.capabilities.semanticTokensProvider?.legend ?? s.legend;
  return s;
}
function stopServer(s?: Server): void {
  try { s?.conn.dispose(); } catch { /* ignore */ }
  try { s?.child.kill(); } catch { /* ignore */ }
}

interface Decoded { line: number; char: number; text: string; type: string; mods: string[] }
function decode(s: Server, text: string, data: number[]): Decoded[] {
  const lines = text.split("\n");
  const out: Decoded[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
    const mods = s.legend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b));
    out.push({ line, char, text: lines[line].substr(char, data[i + 2]), type: s.legend.tokenTypes[data[i + 3]], mods });
  }
  return out;
}
/** The token for the `nth` occurrence of `word` on `line`. */
function tokAt(toks: Decoded[], text: string, line: number, word: string, nth = 0): Decoded | undefined {
  const l = text.split("\n")[line];
  let idx = -1;
  for (let k = 0; k <= nth; k++) {
    idx = l.indexOf(word, idx + 1);
    while (idx >= 0 && (/\w/.test(l[idx - 1] ?? "") || /\w/.test(l[idx + word.length] ?? ""))) idx = l.indexOf(word, idx + 1);
  }
  return toks.find((t) => t.line === line && t.char === idx);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let version = 1;
async function open(s: Server, uri: string, text: string, languageId = "apex"): Promise<void> {
  await s.conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId, version: version++, text } });
}
async function full(s: Server, uri: string): Promise<{ resultId?: string; data: number[] }> {
  return s.conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });
}

const SRC = [
  "public abstract class Svc implements Queueable {", //                           0
  "    public static final Integer MAX = 10;", //                                  1
  "    private List<Account> accounts;", //                                        2
  "    @Deprecated public String label { get; set; }", //                          3
  "    public enum Color { RED, GREEN }", //                                       4
  "    public abstract void run();", //                                            5
  "    public static String go(Contact con, final Integer n) {", //                6
  "        Account acc = new Account(Name = 'x');", //                             7
  "        String name = acc.Name;", //                                            8
  "        String own = con.Account.Name;", //                                     9
  "        List<Contact> cs = [SELECT Id, Account.Name FROM Contact WHERE LastName = :name LIMIT :n];", // 10
  "        System.debug(cs[0].LastName + Account.Name + MAX + Color.RED + label);", // 11
  "        Helper.greet(name);", //                                                12
  "        for (Account a : accounts) { name = a.Name; }", //                     13
  "        return name;", //                                                       14
  "    }", //                                                                      15
  "}", //                                                                         16
  "",
].join("\n");

describe("Semantic tokens", function () {
  this.timeout(20000);
  let s: Server;
  before(async () => {
    s = await startServer({ apexFeatures: true });
  });
  after(() => stopServer(s));

  it("advertises full/delta/range with a standard legend plus SObject modifiers", () => {
    const p = s.caps.semanticTokensProvider;
    assert.ok(p, "semanticTokensProvider capability");
    assert.deepStrictEqual(p.full, { delta: true });
    assert.strictEqual(p.range, true);
    for (const t of ["class", "interface", "enum", "enumMember", "type", "method", "property", "variable", "parameter", "namespace"]) {
      assert.ok(s.legend.tokenTypes.includes(t), t);
    }
    for (const m of ["declaration", "static", "readonly", "abstract", "deprecated", "defaultLibrary", "sobject", "sobjectField"]) {
      assert.ok(s.legend.tokenModifiers.includes(m), m);
    }
  });

  it("classifies declarations, members, locals, parameters and SObject fields", async () => {
    const uri = "file:///tmp/semtok/Svc.cls";
    await open(s, uri, SRC);
    const res = await full(s, uri);
    const toks = decode(s, SRC, res.data);
    const is = (line: number, word: string, type: string, mods: string[] = [], nth = 0) => {
      const t = tokAt(toks, SRC, line, word, nth);
      assert.ok(t, `no token for '${word}' on line ${line}`);
      assert.strictEqual(t!.type, type, `'${word}' line ${line}: type ${t!.type}`);
      for (const m of mods) assert.ok(t!.mods.includes(m), `'${word}' line ${line}: missing ${m} (has ${t!.mods})`);
    };
    const notMod = (line: number, word: string, mod: string, nth = 0) => {
      const t = tokAt(toks, SRC, line, word, nth);
      assert.ok(t && !t.mods.includes(mod), `'${word}' line ${line} should not have ${mod}`);
    };
    is(0, "Svc", "class", ["declaration", "abstract"]);
    is(0, "Queueable", "class", ["defaultLibrary"]);
    is(1, "MAX", "property", ["declaration", "static", "readonly"]);
    is(2, "Account", "type", ["sobject"]);
    is(2, "accounts", "property", ["declaration"]);
    is(3, "label", "property", ["declaration", "deprecated"]);
    is(4, "Color", "enum", ["declaration"]);
    is(4, "RED", "enumMember", ["declaration"]);
    is(5, "run", "method", ["declaration", "abstract"]);
    is(6, "go", "method", ["declaration", "static"]);
    is(6, "con", "parameter", ["declaration"]);
    is(6, "n", "parameter", ["declaration", "readonly"]);
    is(7, "acc", "variable", ["declaration"]);
    is(7, "Name", "property", ["sobjectField"]); // new Account(Name = …)
    // The main goal: SObject field vs local variable.
    is(8, "name", "variable", ["declaration"]);
    is(8, "acc", "variable");
    notMod(8, "acc", "sobjectField");
    is(8, "Name", "property", ["sobjectField"]);
    is(9, "con", "parameter");
    is(9, "Account", "property", ["sobjectField"]);
    // (`Name` after the hop needs Contact's describe — covered by the refresh test below)
    // SOQL
    is(10, "Id", "property", ["sobjectField"]);
    is(10, "Account", "property", ["sobjectField"]);
    is(10, "Contact", "type", ["sobject"], 1);
    is(10, "LastName", "property", ["sobjectField"]);
    is(10, "name", "variable", [], 0); // `:name` bind is the local, not a field
    notMod(10, "name", "sobjectField");
    is(10, "n", "parameter");
    // Expressions
    is(11, "System", "namespace", ["defaultLibrary"]);
    is(11, "debug", "method", ["static", "defaultLibrary"]);
    is(11, "cs", "variable");
    is(11, "LastName", "property", ["sobjectField"]); // cs[0].LastName
    is(11, "Account", "type", ["sobject"]);
    is(11, "Name", "property", ["sobjectField", "static"]); // Account.Name
    is(11, "MAX", "property", ["static", "readonly"]);
    is(11, "RED", "enumMember");
    is(11, "label", "property", ["deprecated"]);
    is(12, "Helper", "class");
    is(12, "greet", "method");
    is(13, "a", "variable", ["declaration"]);
    is(13, "accounts", "property");
    is(13, "Name", "property", ["sobjectField"]);
    is(14, "name", "variable");
  });

  it("walks relationship hops once the describe arrives, and asks the client to refresh", async () => {
    const before = s.refreshes;
    const uri = "file:///tmp/semtok/Hop.cls";
    const text = "public class Hop {\n  void m(Opportunity o) {\n    String x = o.Account.Industry;\n  }\n}\n";
    await open(s, uri, text);
    const first = decode(s, text, (await full(s, uri)).data);
    // Opportunity's describe isn't cached yet: `Account` is still a field, the hop target unknown.
    assert.ok(tokAt(first, text, 2, "Account")!.mods.includes("sobjectField"));
    assert.strictEqual(tokAt(first, text, 2, "Industry"), undefined);
    const start = Date.now();
    while (Date.now() - start < 4000 && s.refreshes === before) await sleep(25);
    assert.ok(s.refreshes > before, "workspace/semanticTokens/refresh sent after the describe arrived");
    assert.ok(s.describeCalls.includes("Opportunity"), "fetched Opportunity describe for the hop");
    const toks = decode(s, text, (await full(s, uri)).data);
    const ind = tokAt(toks, text, 2, "Industry")!;
    assert.strictEqual(ind.type, "property");
    assert.ok(ind.mods.includes("sobjectField"), `Industry mods: ${ind.mods}`);
  });

  it("never bursts describes: at most a few per pass, only for relationship hops", async () => {
    // Own server with schema validation off, so only highlighting asks for describes.
    const own = await startServer({ apexFeatures: false, apexValidateSchema: false });
    try {
    const s = own;
    const n0 = s.describeCalls.length;
    const lines = ["public class Many {", "  void m() {"];
    for (let i = 0; i < 40; i++) lines.push(`    Obj${i}__c o${i} = new Obj${i}__c(); String v${i} = o${i}.Name; String w${i} = o${i}.Parent__r.Name;`);
    lines.push("  }", "}", "");
    const text = lines.join("\n");
    const uri = "file:///tmp/semtok/Many.cls";
    await open(s, uri, text);
    const res = await full(s, uri);
    const toks = decode(s, text, res.data);
    const v = tokAt(toks, text, 2, "Name")!;
    assert.ok(v.mods.includes("sobjectField"), "custom-suffix SObject member is a field without any describe");
    await sleep(500);
    const fetched = s.describeCalls.length - n0;
    assert.ok(fetched <= 5, `expected ≤5 describes for one pass, got ${fetched}`);
    } finally {
      stopServer(own);
    }
  });

  it("returns deltas against the previous result id", async () => {
    const uri = "file:///tmp/semtok/Delta.cls";
    const v1 = "public class D {\n  void m() {\n    Account a = new Account();\n    a.Name = 'x';\n  }\n}\n";
    await open(s, uri, v1);
    const r1 = await full(s, uri);
    assert.ok(r1.resultId, "resultId");
    const v2 = "public class D {\n  void m() {\n    Integer i = 0;\n    Account a = new Account();\n    a.Name = 'x';\n  }\n}\n";
    await s.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: version++ },
      contentChanges: [{ text: v2 }],
    });
    const d = await s.conn.sendRequest("textDocument/semanticTokens/full/delta", {
      textDocument: { uri },
      previousResultId: r1.resultId,
    });
    assert.ok(Array.isArray(d.edits), "delta has edits");
    assert.notStrictEqual(d.resultId, r1.resultId);
    const applied = r1.data.slice();
    for (const e of [...d.edits].sort((a: any, b: any) => b.start - a.start)) applied.splice(e.start, e.deleteCount, ...(e.data ?? []));
    const r2 = await full(s, uri);
    assert.deepStrictEqual(applied, r2.data, "applying the delta yields the new full result");
    assert.ok(d.edits.reduce((n: number, e: any) => n + (e.data?.length ?? 0), 0) < r2.data.length, "delta is smaller than full");
    // Unchanged document → empty delta
    const d2 = await s.conn.sendRequest("textDocument/semanticTokens/full/delta", { textDocument: { uri }, previousResultId: r2.resultId });
    assert.deepStrictEqual(d2.edits, []);
  });

  it("serves /range as a subset of the full result", async () => {
    const uri = "file:///tmp/semtok/Svc.cls";
    const res = await s.conn.sendRequest("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: { start: { line: 8, character: 0 }, end: { line: 9, character: 200 } },
    });
    const toks = decode(s, SRC, res.data);
    assert.ok(toks.length > 0 && toks.every((t) => t.line >= 8 && t.line <= 9));
    assert.ok(toks.some((t) => t.text === "Name" && t.mods.includes("sobjectField")));
  });

  it("highlights fields in .soql documents", async () => {
    const uri = "file:///tmp/semtok/q.soql";
    const text = "SELECT Id, Name, COUNT(Id) cnt FROM Account WHERE Industry = 'x'";
    await open(s, uri, text, "soql");
    const toks = decode(s, text, (await full(s, uri)).data);
    assert.ok(tokAt(toks, text, 0, "Name")!.mods.includes("sobjectField"));
    assert.strictEqual(tokAt(toks, text, 0, "Account")!.type, "type");
    assert.ok(!tokAt(toks, text, 0, "cnt"), "aggregate alias is not a field");
  });

  it("tokenizes a 3000-line class quickly", async () => {
    const body: string[] = ["public class Big {", "  private List<Account> accounts;"];
    let i = 0;
    while (body.length < 3000) {
      body.push(
        `  public static String m${i}(Contact con, Integer n) {`,
        "    Account acc = new Account(Name = 'x');",
        "    String name = acc.Name + con.Account.Name;",
        "    List<Contact> cs = [SELECT Id, LastName FROM Contact WHERE LastName = :name LIMIT :n];",
        "    for (Account a : accounts) { name += a.Name; }",
        "    System.debug(cs[0].LastName);",
        "    return name;",
        "  }",
      );
      i++;
    }
    body.push("}", "");
    const text = body.join("\n");
    const uri = "file:///tmp/semtok/Big.cls";
    await open(s, uri, text);
    const t0 = Date.now();
    const res = await full(s, uri);
    const first = Date.now() - t0;
    // Edit → recompute (warm)
    const text2 = text.replace("private List<Account> accounts;", "private List<Account> accounts2;");
    await s.conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: version++ }, contentChanges: [{ text: text2 }] });
    const t1 = Date.now();
    await full(s, uri);
    const second = Date.now() - t1;
    console.log(`      3000-line class: ${res.data.length / 5} tokens, first request ${first}ms, after edit ${second}ms (round-trip incl. IPC)`);
    assert.ok(second < 200, `recompute took ${second}ms`);
  });
});

describe("Semantic tokens setting", function () {
  this.timeout(20000);
  let s: Server | undefined;
  after(() => stopServer(s));
  it("does not advertise the capability when apexSemanticHighlighting is false", async () => {
    s = await startServer({ apexFeatures: true, apexSemanticHighlighting: false });
    assert.strictEqual(s.caps.semanticTokensProvider, undefined);
  });
});
