/**
 * Apex completion quality + cost tests for the language server (out/server.js).
 *
 * A fake host answers schema requests with a 150 ms delay and counts every describe,
 * over a generated temp workspace (DTO hierarchy, inner types, enums, a large class).
 * Covers: label sets for receiver expressions (calls, chains, indexes, statics, inner
 * types, enums, generics, relationships), describe counts (no junk describes of
 * workspace/standard types, at most one per relationship hop), payload and latency
 * budgets, lazy documentation, error recovery (unbalanced `{`), unsaved-buffer
 * visibility, SOQL bind/date-literal handling and a fast server exit.
 *
 * Requires `npm run compile` first (out/server.js + out/serverParseWorker.js).
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const DESCRIBE_DELAY_MS = 150;

type Field = Record<string, unknown> & { name: string; type: string };
const fields = (names: string[], extra: Field[] = []): Field[] => [
  { name: "Id", type: "id" },
  ...names.map((n) => ({ name: n, type: "string" })),
  ...extra,
];
const DESCRIBES: Record<string, { name: string; fields: Field[]; childRelationships: { name: string; childSObject: string }[] }> = {
  Account: {
    name: "Account",
    fields: fields(["Name", "Industry"], [{ name: "OwnerId", type: "reference", relationshipName: "Owner", referenceTo: ["User"] }]),
    childRelationships: [{ name: "Contacts", childSObject: "Contact" }],
  },
  Contact: {
    name: "Contact",
    fields: fields(["LastName"], [{ name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"] }]),
    childRelationships: [],
  },
  User: {
    name: "User",
    fields: fields(["Username"], [
      { name: "ManagerId", type: "reference", relationshipName: "Manager", referenceTo: ["User"] },
      { name: "ProfileId", type: "reference", relationshipName: "Profile", referenceTo: ["Profile"] },
    ]),
    childRelationships: [],
  },
  Profile: { name: "Profile", fields: fields(["Name"]), childRelationships: [] },
  acme__Widget__c: { name: "acme__Widget__c", fields: fields(["acme__Amount__c"]), childRelationships: [] },
};
const OBJECTS = Object.keys(DESCRIBES);

// ─── Workspace fixture ───────────────────────────────────────────────────────────

const root = path.join(os.tmpdir(), `sfx-apexcompl-${process.pid}`);
const classes = path.join(root, "force-app", "main", "default", "classes");
const nsRoot = path.join(root, "nsproj");
const FILES: Record<string, string> = {
  "BaseDto.cls": [
    "public virtual class BaseDto {",
    "  public Id recordId;",
    "  protected String externalKey;",
    "  public Boolean isValid() { return true; }",
    "}",
  ].join("\n"),
  "AccountDto.cls": [
    "public class AccountDto extends BaseDto {",
    "  public String name;",
    "  public Decimal revenue;",
    "  public Account record;",
    "  private Integer secret;",
    "  public List<ContactDto> contacts;",
    "  public static AccountDto fromRecord(Account a) { return new AccountDto(); }",
    "  public static AccountDto empty() { return new AccountDto(); }",
    "  public Contact primaryContact() { return null; }",
    "  public void rename(String newName, Boolean notify) { }",
    "}",
  ].join("\n"),
  "ContactDto.cls": ["public class ContactDto {", "  public String email;", "}"].join("\n"),
  "Wrapper.cls": [
    "public class Wrapper {",
    "  public static Integer staticCounter;",
    "  public Integer instanceCount;",
    "  public class Inner { public Integer innerCount; public String innerLabel; }",
    "  public enum Mode { FAST, SLOW, OFF }",
    "}",
  ].join("\n"),
  "Status.cls": "public enum Status { ACTIVE, INACTIVE, PENDING }",
};
// A large class (~3,000 lines) for cross-file lookup latency.
function bigClass(): string {
  const out = ["public class Big {"];
  for (let i = 0; i < 600; i++) {
    out.push(`  public Integer field${i};`);
    out.push(`  public String method${i}(Integer a, String b) {`);
    out.push(`    if (a > ${i}) { return b; }`);
    out.push(`    return String.valueOf(a);`);
    out.push(`  }`);
  }
  out.push("}");
  return out.join("\n");
}

let child: cp.ChildProcess;
let conn: any;
let seq = 1;
const describeLog: string[] = [];

async function describeDelta<T>(fn: () => Promise<T>): Promise<{ res: T; described: string[] }> {
  const before = describeLog.length;
  const res = await fn();
  return { res, described: describeLog.slice(before) };
}

function itemsOf(res: any): any[] {
  return Array.isArray(res) ? res : res?.items ?? [];
}
function labelsOf(res: any): string[] {
  return itemsOf(res).map((i: any) => i.label);
}

/** Open `src` (cursor marked with `|`) as a new document and complete at the cursor. */
async function completeAt(src: string, opts: { dir?: string; trigger?: string } = {}): Promise<any> {
  const offset = src.indexOf("|");
  assert.ok(offset >= 0, "cursor marker missing");
  const text = src.slice(0, offset) + src.slice(offset + 1);
  const before = text.slice(0, offset).split("\n");
  const position = { line: before.length - 1, character: before[before.length - 1].length };
  const n = seq++;
  const uri = pathToFileURL(path.join(opts.dir ?? classes, `T${n}.cls`)).href;
  await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text } });
  const context = opts.trigger ? { triggerKind: 2, triggerCharacter: opts.trigger } : { triggerKind: 1 };
  return conn.sendRequest("textDocument/completion", { textDocument: { uri }, position, context });
}

/** A method body inside a class; `members` go at class level. */
function inMethod(body: string, members = ""): string {
  return `public class Main {\n${members}\n  void m() {\n${body}\n  }\n}\n`;
}

function includesAll(labels: string[], want: string[]): void {
  const missing = want.filter((w) => !labels.includes(w));
  assert.deepStrictEqual(missing, [], `missing ${missing.join(",")} in: ${labels.slice(0, 40).join(",")}`);
}
function includesNone(labels: string[], banned: string[]): void {
  const present = banned.filter((w) => labels.includes(w));
  assert.deepStrictEqual(present, [], `unexpected ${present.join(",")}`);
}

describe("Apex completion (generated workspace, counting host)", () => {
before(async function () {
  this.timeout(30000);
  fs.mkdirSync(classes, { recursive: true });
  fs.mkdirSync(nsRoot, { recursive: true });
  for (const [f, body] of Object.entries(FILES)) fs.writeFileSync(path.join(classes, f), body);
  fs.writeFileSync(path.join(classes, "Big.cls"), bigClass());

  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
  child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
  const describeOne = async (name: string) => {
    describeLog.push(name);
    await new Promise((r) => setTimeout(r, DESCRIBE_DELAY_MS));
    return DESCRIBES[name] ?? null;
  };
  conn.onRequest("sfx/objectList", () => OBJECTS);
  conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) => describeOne(sobject));
  conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => Promise.all(names.map(describeOne)));
  conn.onRequest("sfx/projectInfo", ({ uri }: { uri?: string }) => ({ namespace: uri && uri.includes("nsproj") ? "acme" : null }));
  conn.onRequest("sfx/objectInfo", () => ({ description: null }));
  conn.onNotification("textDocument/publishDiagnostics", () => undefined);
  conn.listen();
  await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: {},
    initializationOptions: { apexFeatures: true },
  });
  await conn.sendNotification("initialized", {});
});

after(() => {
  try { conn?.dispose(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Receiver expressions ────────────────────────────────────────────────────────

describe("Apex completion: receiver expressions", () => {
  it("method-call receiver: getDto(). → instance members incl. inherited, no private/static", async () => {
    const { res, described } = await describeDelta(() =>
      completeAt(inMethod("    getDto().|", "  AccountDto getDto() { return null; }")),
    );
    const labels = labelsOf(res);
    includesAll(labels, ["name", "revenue", "record", "contacts", "primaryContact", "recordId", "isValid"]);
    includesNone(labels, ["secret", "fromRecord", "empty", "externalKey"]);
    assert.deepStrictEqual(described, [], "workspace classes are never described");
  });

  it("chains: localDto.record. → SObject fields of Account", async () => {
    const labels = labelsOf(await completeAt(inMethod("    AccountDto localDto = new AccountDto();\n    localDto.record.|")));
    includesAll(labels, ["Name", "Industry", "Owner", "Contacts"]);
  });

  it("static access: AccountDto. → statics only", async () => {
    const { res, described } = await describeDelta(() => completeAt(inMethod("    AccountDto.|")));
    const labels = labelsOf(res);
    includesAll(labels, ["fromRecord", "empty"]);
    includesNone(labels, ["name", "revenue", "isValid"]);
    assert.deepStrictEqual(described, []);
  });

  it("Wrapper. → static field, inner class and inner enum; Wrapper.Mode. → values", async () => {
    const { res, described } = await describeDelta(() => completeAt(inMethod("    Wrapper.|")));
    const labels = labelsOf(res);
    includesAll(labels, ["staticCounter", "Inner", "Mode"]);
    includesNone(labels, ["instanceCount"]);
    includesAll(labelsOf(await completeAt(inMethod("    Wrapper.Mode.|"))), ["FAST", "SLOW", "OFF", "values", "valueOf"]);
    const inner = labelsOf(await completeAt(inMethod("    Wrapper.Inner inn = new Wrapper.Inner();\n    inn.|")));
    includesAll(inner, ["innerCount", "innerLabel"]);
    assert.deepStrictEqual(described, []);
  });

  it("enums: Status. → constants; a Status variable → enum instance methods", async () => {
    const { res, described } = await describeDelta(async () => {
      const s = labelsOf(await completeAt(inMethod("    Status.|")));
      const v = labelsOf(await completeAt(inMethod("    Status st;\n    st.|")));
      return { s, v };
    });
    includesAll(res.s, ["ACTIVE", "INACTIVE", "PENDING", "values"]);
    includesAll(res.v, ["name", "ordinal"]);
    includesNone(res.v, ["ACTIVE"]);
    assert.deepStrictEqual(described, []);
  });

  it("generics: List / Map methods without describes; list index and map get → element type", async () => {
    const { res, described } = await describeDelta(() => completeAt(inMethod("    List<Account> accs;\n    accs.|")));
    includesAll(labelsOf(res), ["add", "size", "get", "isEmpty"]);
    assert.deepStrictEqual(described, [], "List<Account>. needs no describe");
    const idx = labelsOf(await completeAt(inMethod("    List<Account> accs;\n    accs[0].|")));
    includesAll(idx, ["Name", "Industry"]);
    const mapGet = labelsOf(await completeAt(inMethod("    Map<Id, List<Contact>> byAcc;\n    byAcc.get(null)[0].|")));
    includesAll(mapGet, ["LastName", "Account"]);
    const m = await describeDelta(() => completeAt(inMethod("    Map<String, Wrapper.Inner> mm;\n    mm.|")));
    includesAll(labelsOf(m.res), ["get", "put", "keySet", "values"]);
    assert.deepStrictEqual(m.described, []);
  });

  it("relationships: at most one describe per hop (acc.Owner.Manager.Profile.)", async () => {
    const { res, described } = await describeDelta(() =>
      completeAt(inMethod("    Account acc;\n    acc.Owner.Manager.Profile.|")),
    );
    includesAll(labelsOf(res), ["Name"]);
    assert.ok(described.length <= 3, `describes: ${described.join(",")}`);
    assert.strictEqual(new Set(described).size, described.length, `duplicate describes: ${described.join(",")}`);
    for (const d of described) assert.ok(["Account", "User", "Profile"].includes(d), `junk describe ${d}`);
  });

  it("Schema.SObjectType.Account.fields. → fields; only real objects are described", async () => {
    const { res, described } = await describeDelta(() => completeAt(inMethod("    Schema.SObjectType.Account.fields.|")));
    includesAll(labelsOf(res), ["Name", "Industry"]);
    for (const d of described) assert.strictEqual(d, "Account");
  });

  it("constructor parens of non-SObjects trigger no describe", async () => {
    const { described } = await describeDelta(async () => {
      await completeAt(inMethod("    HttpRequest r = new HttpRequest(|"));
      await completeAt(inMethod("    AccountDto d = new AccountDto(|"));
      await completeAt(inMethod("    Wrapper.Inner i = new Wrapper.Inner(|"));
    });
    assert.deepStrictEqual(described, []);
  });

  it("namespaced project: workspace and standard types still trigger no describe", async () => {
    const { res, described } = await describeDelta(async () => {
      const w = labelsOf(await completeAt(inMethod("    Wrapper.|"), { dir: nsRoot }));
      const l = labelsOf(await completeAt(inMethod("    List<String> l;\n    l.|"), { dir: nsRoot }));
      return { w, l };
    });
    includesAll(res.w, ["staticCounter"]);
    includesAll(res.l, ["add", "size"]);
    assert.deepStrictEqual(described, []);
  });
});

// ─── Bare identifiers, new, assignment ───────────────────────────────────────────

describe("Apex completion: bare identifiers and `new`", () => {
  it("bare prefix: locals, members and types, small payload", async () => {
    const res = await completeAt(
      inMethod("    Account acc;\n    AccountDto localDto;\n    Acc|", "  Account cachedAccount;"),
    );
    const labels = labelsOf(res);
    includesAll(labels, ["acc", "cachedAccount", "Account", "AccountDto"]);
    const kb = JSON.stringify(res).length / 1024;
    assert.ok(kb < 20, `payload ${kb.toFixed(1)} KB`);
    const loc = labelsOf(await completeAt(inMethod("    AccountDto localDto;\n    loc|")));
    includesAll(loc, ["localDto"]);
  });

  it("only locals visible at the cursor (block scopes)", async () => {
    const labels = labelsOf(await completeAt(inMethod("    if (true) { Integer inner1 = 1; }\n    Integer outer1;\n    o|")));
    includesAll(labels, ["outer1"]);
    const all = labelsOf(await completeAt(inMethod("    if (true) { Integer inner1 = 1; }\n    in|")));
    includesNone(all, ["inner1"]);
  });

  it("`new ` lists constructable types within budget", async () => {
    await completeAt(inMethod("    Account a3 = new |"), { trigger: " " }); // first request scans type headers
    await new Promise((r) => setTimeout(r, 100));
    const res = await completeAt(inMethod("    Account a3 = new |"), { trigger: " " });
    const labels = labelsOf(res);
    includesAll(labels, ["Account", "AccountDto"]);
    includesNone(labels, ["Status", "Database", "System", "Schema"]);
    const kb = JSON.stringify(res).length / 1024;
    assert.ok(kb < 120 || res.isIncomplete, `payload ${kb.toFixed(1)} KB`);
  });

  it("`= ` offers a constructor only for a known constructable type", async () => {
    const ok = labelsOf(await completeAt(inMethod("    Account a4 = |"), { trigger: " " }));
    assert.ok(ok.some((l) => /^new Account\(/.test(l)), `got: ${ok.join(",")}`);
    const unknown = itemsOf(await completeAt(inMethod("    Blah__Unknown x = |"), { trigger: " " }));
    assert.strictEqual(unknown.length, 0);
    const space = itemsOf(await completeAt(inMethod("    Integer x = 5;\n    x |"), { trigger: " " }));
    assert.strictEqual(space.length, 0, "a space trigger outside `new`/`=` returns nothing");
  });
});

// ─── Item shape, lazy docs ───────────────────────────────────────────────────────

describe("Apex completion: items", () => {
  it("method items carry labelDetails and a call snippet; fields sort before methods", async () => {
    const items = itemsOf(await completeAt(inMethod("    AccountDto d;\n    d.|")));
    const pc = items.find((i) => i.label === "primaryContact");
    assert.ok(pc, "primaryContact item");
    assert.ok(pc.labelDetails && /\(/.test(pc.labelDetails.detail ?? ""), JSON.stringify(pc.labelDetails));
    assert.strictEqual(pc.insertText, "primaryContact()", "no-arg call inserts the parens as plain text");
    const rn = items.find((i) => i.label === "rename");
    assert.ok(rn && /String newName/.test(rn.labelDetails?.detail ?? ""), JSON.stringify(rn?.labelDetails));
    assert.strictEqual(rn.insertTextFormat, 2, "a call with params is a snippet");
    assert.ok(/^rename\(/.test(rn.insertText ?? ""), rn.insertText);
    const nm = items.find((i) => i.label === "name");
    assert.ok(nm && (nm.sortText ?? nm.label) < (pc.sortText ?? pc.label), "fields before methods");
  });

  it("documentation is lazy: absent in the list, filled by completionItem/resolve", async () => {
    const items = itemsOf(await completeAt(inMethod("    Account acc;\n    acc.|")));
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.documentation === undefined), "no eager documentation");
    const name = items.find((i) => i.label === "Name");
    const resolved: any = await conn.sendRequest("completionItem/resolve", name);
    const doc = typeof resolved.documentation === "string" ? resolved.documentation : resolved.documentation?.value;
    assert.ok(doc && /Account\.Name/.test(doc) && /ASFX Toolkit/.test(doc), doc);
    const dto = itemsOf(await completeAt(inMethod("    AccountDto d;\n    d.|"))).find((i) => i.label === "revenue");
    const r2: any = await conn.sendRequest("completionItem/resolve", dto);
    assert.ok(r2.documentation, "user member resolves documentation");
  });
});

// ─── Robustness ──────────────────────────────────────────────────────────────────

describe("Apex completion: robustness", () => {
  it("an unbalanced `{` above keeps the full member list for this.", async () => {
    const members = Array.from({ length: 30 }, (_, i) => `  Integer helper${i};`).join("\n");
    const uri = pathToFileURL(path.join(classes, `Broken${seq++}.cls`)).href;
    const good = `public class Broken {\n${members}\n  void a() {\n    Integer z;\n  }\n  void m() {\n    this.\n  }\n}\n`;
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: good } });
    await conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
    const lines = good.split("\n");
    const zLine = lines.findIndex((l) => l.includes("Integer z;"));
    await conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: zLine, character: 0 }, end: { line: zLine, character: 0 } }, text: "    if (z > 0) {\n" }],
    });
    await new Promise((r) => setTimeout(r, 600)); // let the broken buffer parse
    const thisLine = zLine + 1 + lines.slice(zLine).findIndex((l) => l.includes("this."));
    const res = await conn.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: thisLine, character: 9 },
      context: { triggerKind: 2, triggerCharacter: "." },
    });
    const labels = labelsOf(res);
    includesAll(labels, ["helper0", "helper15", "helper29"]);
  });

  it("an unsaved edit to another class is visible to cross-file completion", async () => {
    const file = path.join(classes, "ContactDto.cls");
    const uri = pathToFileURL(file).href;
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: FILES["ContactDto.cls"] } });
    await conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "public class ContactDto {\n  public String email;\n  public String unsavedPhone;\n}" }],
    });
    await new Promise((r) => setTimeout(r, 400));
    const labels = labelsOf(await completeAt(inMethod("    ContactDto c;\n    c.|")));
    includesAll(labels, ["email", "unsavedPhone"]);
  });

  it("SOQL date literals with a colon are not bind variables; `:` binds offer locals", async () => {
    const lit = labelsOf(await completeAt(inMethod("    Integer localN = 1;\n    List<Account> r = [SELECT Id FROM Account WHERE CreatedDate = LAST_N_DAYS:|];")));
    includesNone(lit, ["localN"]);
    const bind = labelsOf(await completeAt(inMethod("    Integer localN = 1;\n    List<Account> r = [SELECT Id FROM Account WHERE Name = :loc|];")));
    includesAll(bind, ["localN"]);
  });
});

// ─── Latency ─────────────────────────────────────────────────────────────────────

describe("Apex completion: latency", () => {
  const p95 = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

  it("cross-file members of a 3,000-line class: first lookup bounded, repeats fast", async () => {
    const t0 = Date.now();
    const first = labelsOf(await completeAt(inMethod("    Big b;\n    b.|")));
    const firstMs = Date.now() - t0;
    includesAll(first, ["field0", "method599"]);
    assert.ok(firstMs < 1500, `first lookup ${firstMs} ms`);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = Date.now();
      await completeAt(inMethod("    Big b;\n    b.|"));
      times.push(Date.now() - t);
    }
    assert.ok(p95(times) < 100, `p95 ${p95(times)} ms (${times.join(",")})`);
  });

  it("completion right after an edit does not wait for the parse", async () => {
    const uri = pathToFileURL(path.join(classes, `Edit${seq++}.cls`)).href;
    const text = inMethod("    AccountDto localDto;\n    \n", Array.from({ length: 200 }, (_, i) => `  Integer f${i};`).join("\n"));
    await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text } });
    await conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
    const line = text.split("\n").findIndex((l) => l === "    ");
    const times: number[] = [];
    for (let v = 2; v < 12; v++) {
      await conn.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: v },
        contentChanges: [{ range: { start: { line, character: 0 }, end: { line, character: 200 } }, text: `    localDto.` }],
      });
      const t = Date.now();
      const res = await conn.sendRequest("textDocument/completion", {
        textDocument: { uri },
        position: { line, character: 13 },
        context: { triggerKind: 2, triggerCharacter: "." },
      });
      times.push(Date.now() - t);
      includesAll(labelsOf(res), ["name", "revenue"]);
    }
    assert.ok(p95(times) < 100, `p95 ${p95(times)} ms (${times.join(",")})`);
  });
});

// ─── Shutdown ────────────────────────────────────────────────────────────────────

describe("Apex completion: shutdown", () => {
  it("the server exits within 1 s of shutdown/exit with the parse worker running", async function () {
    this.timeout(5000);
    const exited = new Promise<number>((resolve) => child.once("exit", () => resolve(Date.now())));
    await conn.sendRequest("shutdown");
    const t0 = Date.now();
    await conn.sendNotification("exit");
    const t1 = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    assert.ok(t1 > 0 && t1 - t0 < 1000, `exit took ${t1 < 0 ? ">3000" : t1 - t0} ms`);
  });
});
});
