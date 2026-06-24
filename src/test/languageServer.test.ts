/**
 * Integration tests for the ASFX language server (out/server.js). Spawns the
 * bundled server, plays the role of the extension host (answering the schema /
 * project-info requests with fixtures), and drives it over LSP — covering SOQL
 * completion, inline + dynamic SOQL in Apex, Apex symbols/diagnostics/member
 * completion, go-to-definition, signature help, hover, SObject click-through,
 * per-document org resolution, namespace-optional matching, and result weighting.
 *
 * Requires `npm run compile` first (the test:unit script does this) so that
 * out/server.js exists.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL, fileURLToPath } from "url";
// vscode-jsonrpc exposes its Node entry via an exports map with no `main`, which
// the project's classic TS module resolution can't follow. Load via require —
// Node honors the exports map at runtime; tsc types it as `any`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

// ─── Fixtures (the "org" the fake host serves) ──────────────────────────────────

const OBJECTS = [
  "Account", "Contact", "Opportunity", "sfy24__ProductionOrder__c",
  "AccountHistory", "AccountShare", "My_Setting__mdt", "sfy24__ProductionOrder__History",
];

type Field = Record<string, unknown> & { name: string; type: string };
type Describe = Record<string, unknown> & { name: string; fields: Field[]; childRelationships: { name: string; childSObject: string }[] };
const DESCRIBES: Record<string, Describe> = {
  Account: {
    name: "Account",
    label: "Account",
    labelPlural: "Accounts",
    keyPrefix: "001",
    custom: false,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    fields: [
      { name: "Id", type: "id", sortable: true, groupable: true, nillable: false },
      { name: "Name", type: "string", label: "Account Name", length: 255, sortable: true, nillable: false },
      { name: "Industry", type: "picklist", label: "Industry", helpText: "The primary industry", picklistValues: ["Banking", "Retail", "Technology"] },
      { name: "CreatedDate", type: "datetime", sortable: true },
      { name: "SystemModstamp", type: "datetime", sortable: true },
    ],
    childRelationships: [{ name: "Contacts", childSObject: "Contact" }],
  },
  Contact: {
    name: "Contact",
    fields: [
      { name: "Id", type: "id" },
      { name: "LastName", type: "string" },
      { name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"], sortable: true },
    ],
    childRelationships: [],
  },
  sfy24__ProductionOrder__c: {
    name: "sfy24__ProductionOrder__c",
    label: "Production Order",
    fields: [
      { name: "Id", type: "id" },
      { name: "Name", type: "string" },
      { name: "sfy24__Amount__c", type: "currency", label: "Amount" },
    ],
    childRelationships: [],
  },
};

// ─── Harness ────────────────────────────────────────────────────────────────────

let child: cp.ChildProcess;
let conn: any;
let version = 1;

function labelsOf(res: any): string[] {
  const items = Array.isArray(res) ? res : res.items;
  return items.map((i: any) => i.label);
}
function itemsOf(res: any): any[] {
  return Array.isArray(res) ? res : res.items;
}

async function openAndComplete(uri: string, languageId: string, text: string, line: number, character: number) {
  await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId, version: version++, text } });
  return conn.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line, character } });
}
function newUri(lang: "soql" | "apex"): string {
  const n = version;
  return lang === "apex" ? `file:///tmp/T${n}.cls` : `file:///tmp/t${n}.soql`;
}
async function complete(text: string, line: number, character: number, lang: "soql" | "apex" = "soql") {
  return openAndComplete(newUri(lang), lang, text, line, character);
}

before(async function () {
  this.timeout(20000);
  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
  child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));

  conn.onRequest("sfx/objectList", () => OBJECTS);
  conn.onRequest("sfx/describe", ({ uri, sobject }: { uri?: string; sobject: string }) => {
    const d = DESCRIBES[sobject];
    if (!d) return null;
    if (uri && uri.includes("adcore") && sobject === "Account") {
      return { ...d, fields: [...d.fields, { name: "Adcore__c", type: "string", sortable: true }] };
    }
    return d;
  });
  conn.onRequest("sfx/projectInfo", () => ({ namespace: "sfy24" }));
  conn.onRequest("sfx/objectInfo", ({ sobject }: { sobject: string }) =>
    sobject === "Account" ? { description: "Customer accounts and prospects." } : { description: null },
  );
  conn.listen();

  const tmpRoot = path.join(os.tmpdir(), "sfx-test-" + process.pid);
  fs.mkdirSync(tmpRoot, { recursive: true });
  await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(tmpRoot).href,
    capabilities: {},
    initializationOptions: { apexFeatures: true },
  });
  await conn.sendNotification("initialized", {});
});

after(() => {
  try { conn?.dispose(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
});

// ─── SOQL completion ─────────────────────────────────────────────────────────────

describe("SOQL completion", () => {
  it("completes objects after FROM", async () => {
    const labels = labelsOf(await complete("SELECT Id FROM ", 0, 15));
    assert.ok(labels.includes("Account") && labels.includes("Contact"));
  });

  it("completes fields after SELECT", async () => {
    const labels = labelsOf(await complete("SELECT  FROM Account", 0, 7));
    assert.ok(labels.includes("Id") && labels.includes("Name") && labels.includes("Industry"));
  });

  it("includes relationship names and traverses them", async () => {
    const fromContact = labelsOf(await complete("SELECT  FROM Contact", 0, 7));
    assert.ok(fromContact.includes("Account"), "relationship name present");
    const traversed = labelsOf(await complete("SELECT Account. FROM Contact", 0, 15));
    assert.ok(traversed.includes("Id") && traversed.includes("Name"), "traversed to Account fields");
  });

  it("completes child relationships and their fields in subqueries", async () => {
    const rels = labelsOf(await complete("SELECT Id, (SELECT  FROM ) FROM Account", 0, 25));
    assert.ok(rels.includes("Contacts"));
    const fields = labelsOf(await complete("SELECT Id, (SELECT  FROM Contacts) FROM Account", 0, 19));
    assert.ok(fields.includes("LastName"));
  });

  it("completes picklist values in WHERE", async () => {
    const vals = labelsOf(await complete("SELECT Id FROM Account WHERE Industry = ", 0, 40));
    assert.ok(vals.includes("'Banking'") && vals.includes("'Technology'"));
  });
});

// ─── SOQL in Apex ────────────────────────────────────────────────────────────────

describe("SOQL in Apex", () => {
  it("completes inside inline [SELECT …]", async () => {
    const src = "public class C {\n  void m() {\n    List<Account> a = [SELECT  FROM Account];\n  }\n}\n";
    const labels = labelsOf(await complete(src, 2, 30, "apex"));
    assert.ok(labels.includes("Id") && labels.includes("Industry"));
  });

  it("completes inside a Database.query('…') string", async () => {
    const src = "public class C {\n  void m() {\n    List<Account> a = Database.query('SELECT  FROM Account');\n  }\n}\n";
    const col = src.split("\n")[2].indexOf("SELECT ") + "SELECT ".length;
    const labels = labelsOf(await complete(src, 2, col, "apex"));
    assert.ok(labels.includes("Id") && labels.includes("Name"));
  });

  it("does not offer SOQL completion outside a query", async () => {
    const labels = labelsOf(await complete("public class T {\n  Integer x = 1;\n}\n", 1, 12, "apex"));
    assert.strictEqual(labels.length, 0);
  });

  it("completes SObject type names in a declaration position (namespace-optional)", async () => {
    // Typing a type name without its namespace prefix should match.
    const src = "public class C {\n  void m() {\n    ProductionOrder__c\n  }\n}\n";
    const col = src.split("\n")[2].length; // end of "    ProductionOrder__c"
    const items = itemsOf(await complete(src, 2, col, "apex"));
    const obj = items.find((i) => i.label === "sfy24__ProductionOrder__c");
    assert.ok(obj, "namespaced object offered as a type");
    assert.strictEqual(obj.filterText, "ProductionOrder__c", "matches without the namespace");
  });

  it("suggests the assigned type first after `new`", async () => {
    const src = "public class C {\n  void m() {\n    sfy24__ProductionOrder__c po = new \n  }\n}\n";
    const col = src.split("\n")[2].length; // end of "    ... = new "
    const items = itemsOf(await complete(src, 2, col, "apex"));
    const top = items.find((i) => i.label === "sfy24__ProductionOrder__c");
    assert.ok(top, "expected type is in the list");
    assert.strictEqual(top.sortText, "0_sfy24__ProductionOrder__c", "ranked first");
    assert.ok(top.insertText.startsWith("sfy24__ProductionOrder__c("), "inserts a constructor call");
    assert.strictEqual(top.filterText, "ProductionOrder__c", "namespace-optional match");
  });
});

// ─── Apex symbols, diagnostics, member completion ───────────────────────────────

describe("Apex language features", () => {
  async function documentSymbol(text: string) {
    const uri = `file:///tmp/Outline${version++}.cls`;
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text } });
    return conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
  }

  it("produces an outline of classes, methods and fields", async () => {
    const syms: any = await documentSymbol("public class Acme {\n  public String name;\n  public Integer add(Integer a, Integer b) { return a + b; }\n}\n");
    const cls = syms.find((s: any) => s.name === "Acme");
    assert.ok(cls, "class present");
    const children = (cls.children || []).map((c: any) => c.name);
    assert.ok(children.includes("name") && children.includes("add"));
  });

  it("member completion resolves SObject fields via declared type", async () => {
    const src = "public class C {\n  void m() {\n    Account a;\n    a.;\n  }\n}\n";
    const labels = labelsOf(await complete(src, 3, 6, "apex"));
    assert.ok(labels.includes("Id") && labels.includes("Industry"));
  });

  it("member completion resolves `this` and user types", async () => {
    const thisSrc = "public class C {\n  String title;\n  void go() {}\n  void m() {\n    this.;\n  }\n}\n";
    assert.ok(labelsOf(await complete(thisSrc, 4, 9, "apex")).includes("title"));
    const userSrc = "public class C {\n  public class Inner {\n    Integer count;\n  }\n  void m() {\n    Inner x;\n    x.;\n  }\n}\n";
    assert.ok(labelsOf(await complete(userSrc, 6, 6, "apex")).includes("count"));
  });

  it("resolves the receiver type even with a nearby parse error (text fallback)", async () => {
    // The `Integer x = ;` line breaks parsing of the method body, but the
    // receiver's type must still resolve via the text scan.
    const src = "public class C {\n  void m() {\n    Integer x = ;\n    sfy24__ProductionOrder__c po = new sfy24__ProductionOrder__c();\n    po.\n  }\n}\n";
    const labels = labelsOf(await complete(src, 4, 7, "apex"));
    assert.ok(labels.includes("Name") && labels.includes("sfy24__Amount__c"));
  });

  it("go-to-definition lands on in-file declarations", async () => {
    const uri = `file:///tmp/Def${version++}.cls`;
    const src = "public class C {\n  Integer total;\n  void m() { total = 1; }\n}\n";
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: src } });
    const loc: any = await conn.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 2, character: 14 } });
    const one = Array.isArray(loc) ? loc[0] : loc;
    assert.strictEqual(one.range.start.line, 1);
  });

  it("signature help shows user method signatures with active parameter", async () => {
    const uri = `file:///tmp/Sig${version++}.cls`;
    const src = "public class C {\n  Integer add(Integer a, Integer b) { return a + b; }\n  void m() {\n    Integer r = add(1, \n  }\n}\n";
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: src } });
    const help: any = await conn.sendRequest("textDocument/signatureHelp", { textDocument: { uri }, position: { line: 3, character: 23 } });
    assert.ok(help.signatures[0].label.includes("add(Integer a, Integer b)"));
    assert.strictEqual(help.activeParameter, 1);
  });
});

// ─── Hover ───────────────────────────────────────────────────────────────────────

describe("Hover", () => {
  async function hover(text: string, line: number, character: number, lang: "soql" | "apex") {
    const uri = newUri(lang);
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: lang, version: 1, text } });
    const res: any = await conn.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line, character } });
    return res && res.contents ? res.contents.value : null;
  }

  it("shows declared type for an Apex variable", async () => {
    const h = await hover("public class C {\n  Integer total;\n  void m() { total = 1; }\n}\n", 2, 14, "apex");
    assert.ok(h && h.includes("total : Integer"));
  });

  it("enriches SObject field hover with label, length, help and picklist values", async () => {
    const name = await hover("SELECT Name FROM Account", 0, 8, "soql");
    assert.ok(name && name.includes("(255)") && name.includes("Account Name"));
    const ind = await hover("SELECT Industry FROM Account", 0, 8, "soql");
    assert.ok(ind && ind.includes("The primary industry") && ind.includes("Banking"));
  });

  it("enriches SObject (object) hover with label, key prefix, counts and CRUD", async () => {
    const h = await hover("SELECT Id FROM Account", 0, 17, "soql"); // hover the object name
    assert.ok(h && h.includes("SObject Account"), `hover: ${JSON.stringify(h)}`);
    assert.ok(h.includes("Accounts"), "plural label");
    assert.ok(h.includes("001"), "key prefix");
    assert.ok(h.includes("fields"), "field count");
    assert.ok(h.includes("createable"), "CRUD flags");
    assert.ok(h.includes("Customer accounts and prospects."), "admin description");
  });
});

// ─── SObject click-through ──────────────────────────────────────────────────────

describe("SObject click-through", () => {
  it("go-to-definition opens a generated schema stub at the field line", async () => {
    const uri = `file:///tmp/click${version++}.soql`;
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "soql", version: 1, text: "SELECT Name FROM Account" } });
    const loc: any = await conn.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 8 } });
    const one = Array.isArray(loc) ? loc[0] : loc;
    assert.ok(one.uri.endsWith("Account.cls"));
    const content = fs.readFileSync(fileURLToPath(one.uri), "utf8").split("\n");
    assert.ok(/\bName\b/.test(content[one.range.start.line]));
  });
});

// ─── Completion item layout ──────────────────────────────────────────────────────

describe("Completion item layout", () => {
  it("puts type inline, owner on the right, and provenance in the doc popup", async () => {
    const items = itemsOf(await complete("SELECT  FROM Account", 0, 7));
    const name = items.find((i) => i.label === "Name");
    assert.ok(/string/.test(name.labelDetails.detail), "type inline");
    assert.strictEqual(name.labelDetails.description, "Account", "owner on the right");
    assert.notStrictEqual(name.labelDetails.description, "ASFX");
    assert.ok(name.documentation.value.includes("ASFX Toolkit"), "provenance in popup");
  });

  it("shows relationship target inline", async () => {
    const items = itemsOf(await complete("SELECT  FROM Contact", 0, 7));
    const rel = items.find((i) => i.label === "Account");
    assert.ok(/→ Account/.test(rel.labelDetails.detail));
  });
});

// ─── Per-document org resolution ────────────────────────────────────────────────

describe("Per-document org resolution", () => {
  it("resolves a sub-project's own org from the document path", async () => {
    const adcore = labelsOf(await openAndComplete("file:///repo/adcore/force-app/main/default/q.soql", "soql", "SELECT  FROM Account", 0, 7));
    const root = labelsOf(await openAndComplete("file:///repo/force-app/main/default/q.soql", "soql", "SELECT  FROM Account", 0, 7));
    assert.ok(adcore.includes("Adcore__c"), "adcore path sees its sub-project field");
    assert.ok(!root.includes("Adcore__c"), "root path does not");
  });
});

// ─── Namespace-optional matching ────────────────────────────────────────────────

describe("Namespace-optional matching", () => {
  it("sets filterText to the un-prefixed name (label keeps the namespace)", async () => {
    const items = itemsOf(await complete("SELECT Id FROM ", 0, 15));
    const obj = items.find((i) => i.label === "sfy24__ProductionOrder__c");
    assert.strictEqual(obj.filterText, "ProductionOrder__c");
  });

  it("resolves an object typed without its namespace prefix", async () => {
    const labels = labelsOf(await complete("SELECT  FROM ProductionOrder__c", 0, 7));
    assert.ok(labels.includes("Id") && labels.includes("sfy24__Amount__c"));
    const items = itemsOf(await complete("SELECT  FROM ProductionOrder__c", 0, 7));
    const fld = items.find((i) => i.label === "sfy24__Amount__c");
    assert.strictEqual(fld.filterText, "Amount__c");
  });
});

// ─── Completion weighting ────────────────────────────────────────────────────────

describe("Completion weighting", () => {
  it("sorts auxiliary objects below business objects", async () => {
    const items = itemsOf(await complete("SELECT Id FROM ", 0, 15));
    const tier = (l: string) => items.find((i) => i.label === l)?.sortText?.[0];
    assert.strictEqual(tier("Account"), "0");
    assert.strictEqual(tier("sfy24__ProductionOrder__c"), "0");
    assert.strictEqual(tier("My_Setting__mdt"), "1");
    assert.strictEqual(tier("AccountHistory"), "2");
    assert.strictEqual(tier("AccountShare"), "2");
    assert.strictEqual(tier("sfy24__ProductionOrder__History"), "2");
  });

  it("sorts audit fields below business fields", async () => {
    const items = itemsOf(await complete("SELECT  FROM Account", 0, 7));
    const tier = (l: string) => items.find((i) => i.label === l)?.sortText?.[0];
    assert.strictEqual(tier("Name"), "0");
    assert.strictEqual(tier("Industry"), "0");
    assert.strictEqual(tier("CreatedDate"), "2");
    assert.strictEqual(tier("SystemModstamp"), "2");
  });
});

// ─── Coexistence: org-aware member completion runs even when Apex features are
// gated off (Salesforce Apex extension present). It's additive, not duplicate. ──

describe("Org-aware member completion with Apex features off", () => {
  let child2: cp.ChildProcess;
  let conn2: any;

  before(async function () {
    this.timeout(20000);
    const serverPath = path.join(__dirname, "..", "server.js");
    child2 = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
    conn2 = rpc.createMessageConnection(new rpc.StreamMessageReader(child2.stdout!), new rpc.StreamMessageWriter(child2.stdin!));
    conn2.onRequest("sfx/objectList", () => OBJECTS);
    conn2.onRequest("sfx/describe", ({ sobject }: { sobject: string }) => DESCRIBES[sobject] || null);
    conn2.onRequest("sfx/projectInfo", () => ({ namespace: "sfy24" }));
    conn2.listen();
    await conn2.sendRequest("initialize", {
      processId: process.pid, rootUri: null, capabilities: {},
      initializationOptions: { apexFeatures: false },
    });
    await conn2.sendNotification("initialized", {});
  });
  after(() => {
    try { conn2?.dispose(); } catch { /* ignore */ }
    try { child2?.kill(); } catch { /* ignore */ }
  });

  it("completes SObject fields on a typed local even with apexFeatures off", async () => {
    const uri = "file:///tmp/off1.cls";
    const src = "public class C {\n  void m() {\n    sfy24__ProductionOrder__c po = new sfy24__ProductionOrder__c();\n    po.\n  }\n}\n";
    await conn2.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: src } });
    const res = await conn2.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 7 } });
    const labels = (Array.isArray(res) ? res : res.items).map((i: any) => i.label);
    assert.ok(labels.includes("Name") && labels.includes("sfy24__Amount__c"));
  });

  it("shows SObject field hover even with apexFeatures off", async () => {
    const uri = "file:///tmp/offh.cls";
    const src = "public class C {\n  void m() {\n    sfy24__ProductionOrder__c po = new sfy24__ProductionOrder__c();\n    po.sfy24__Amount__c = 1;\n  }\n}\n";
    await conn2.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: src } });
    const res: any = await conn2.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 10 } });
    const value = res && res.contents ? res.contents.value : "";
    assert.ok(value.includes("sfy24__Amount__c") && value.includes("Amount"), `hover: ${JSON.stringify(value)}`);
  });
});
