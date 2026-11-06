/**
 * Language-server schema access under a misbehaving host: deadlines (hard + soft
 * completion budget), request counts (object-list gating, in-flight dedupe, cached
 * object list), stale-while-revalidate, targeted refresh by uris, prefetch via
 * sfx/describeMany, the semantic-token pump (no stall, no refresh ping-pong) and
 * SOQL correctness (subquery scope, polymorphic lookups, TYPEOF, value positions,
 * large FROM lists), plus a warm-completion latency budget.
 *
 * Each block spawns its own out/server.js with short deadlines (env overrides) and a
 * scriptable fake host that counts requests. Requires `npm run compile` first.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

type Field = Record<string, unknown> & { name: string; type: string };
type Describe = { name: string; fields: Field[]; childRelationships: { name: string; childSObject: string }[] };

const ref = (name: string, rel: string, to: string[]): Field => ({ name, type: "reference", relationshipName: rel, referenceTo: to });
function filler(n: number, prefix: string): Field[] {
  const out: Field[] = [];
  for (let i = 0; i < n; i++) out.push({ name: `${prefix}Field${i}__c`, type: "string", label: `${prefix} Field ${i}`, length: 255, helpText: "Help text for the field." });
  return out;
}

function baseDescribes(): Record<string, Describe> {
  return {
    Account: {
      name: "Account",
      fields: [
        { name: "Id", type: "id" },
        { name: "Name", type: "string" },
        { name: "Industry", type: "picklist", picklistValues: ["Banking", "Retail", "Technology"] },
        { name: "CreatedDate", type: "datetime" },
        { name: "IsDeleted", type: "boolean" },
        ref("OwnerId", "Owner", ["User"]),
        ref("ParentId", "Parent", ["Account"]),
        ...filler(400, "Acc"),
      ],
      childRelationships: [{ name: "Contacts", childSObject: "Contact" }, { name: "Cases", childSObject: "Case" }],
    },
    Contact: {
      name: "Contact",
      fields: [{ name: "Id", type: "id" }, { name: "LastName", type: "string" }, ref("AccountId", "Account", ["Account"]), ref("ReportsToId", "ReportsTo", ["Contact"]), ref("OwnerId", "Owner", ["User"])],
      childRelationships: [],
    },
    User: { name: "User", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }, { name: "Username", type: "string" }, ref("ManagerId", "Manager", ["User"]), ...filler(250, "Usr")], childRelationships: [] },
    Group: { name: "Group", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }, { name: "DeveloperName", type: "string" }], childRelationships: [] },
    Case: { name: "Case", fields: [{ name: "Id", type: "id" }, { name: "Status", type: "picklist", picklistValues: ["New", "Closed"] }, ref("OwnerId", "Owner", ["Group", "User"]), ref("AccountId", "Account", ["Account"])], childRelationships: [] },
    Task: { name: "Task", fields: [{ name: "Id", type: "id" }, { name: "Subject", type: "string" }, ref("WhatId", "What", ["Account", "Opportunity"]), ref("WhoId", "Who", ["Contact", "Lead"])], childRelationships: [] },
    Opportunity: { name: "Opportunity", fields: [{ name: "Id", type: "id" }, { name: "StageName", type: "string" }, ref("AccountId", "Account", ["Account"])], childRelationships: [] },
    Lead: { name: "Lead", fields: [{ name: "Id", type: "id" }, { name: "Company", type: "string" }], childRelationships: [] },
    acme__Widget__c: { name: "acme__Widget__c", fields: [{ name: "Id", type: "id" }, { name: "acme__Amount__c", type: "currency" }], childRelationships: [] },
  };
}

interface Host {
  conn: any;
  child: cp.ChildProcess;
  root: string;
  describes: Record<string, Describe>;
  objects: string[];
  hang: Set<string>;
  hangAll: { on: boolean };
  unavailable: { on: boolean };
  describeDelayMs: { v: number };
  describeManySupported: { v: boolean };
  log: { t: number; method: string; arg: string; uri: string }[];
  cancelled: string[];
  refreshes: number[];
  onRefresh?: () => void;
  count(method: string, arg?: string): number;
  open(name: string, text: string, lang?: string): Promise<string>;
  complete(uri: string, line: number, character: number, token?: any): Promise<any>;
  dispose(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let docSeq = 1;

async function startHost(env: Record<string, string>, opts: { objects?: string[]; apexFeatures?: boolean } = {}): Promise<Host> {
  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sfx-lsschema-"));
  fs.writeFileSync(path.join(root, "sfdx-project.json"), "{}");
  const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
  const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
  const describes = baseDescribes();
  const h: Host = {
    conn,
    child,
    root,
    describes,
    objects: opts.objects ?? Object.keys(describes),
    hang: new Set(),
    hangAll: { on: false },
    unavailable: { on: false },
    describeDelayMs: { v: 0 },
    describeManySupported: { v: true },
    log: [],
    cancelled: [],
    refreshes: [],
    count(method, arg) {
      return h.log.filter((e) => e.method === method && (arg === undefined || e.arg === arg)).length;
    },
    async open(name, text, lang) {
      const uri = pathToFileURL(path.join(root, name)).href;
      const languageId = lang ?? (name.endsWith(".soql") ? "soql" : "apex");
      await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId, version: docSeq++, text } });
      return uri;
    },
    complete(uri, line, character, token) {
      const params = { textDocument: { uri }, position: { line, character } };
      return token ? conn.sendRequest("textDocument/completion", params, token) : conn.sendRequest("textDocument/completion", params);
    },
    dispose() {
      try { conn.dispose(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
  const hangUntilCancelled = (token: any, label: string) =>
    new Promise<null>((resolve) => {
      token.onCancellationRequested(() => {
        h.cancelled.push(label);
        resolve(null);
      });
    });
  conn.onRequest("sfx/objectList", ({ uri }: { uri?: string }) => {
    h.log.push({ t: Date.now(), method: "objectList", arg: "", uri: uri ?? "" });
    return h.objects;
  });
  conn.onRequest("sfx/describe", async ({ uri, sobject }: { uri?: string; sobject: string }, token: any) => {
    h.log.push({ t: Date.now(), method: "describe", arg: sobject, uri: uri ?? "" });
    if (h.hangAll.on || h.hang.has(sobject)) return hangUntilCancelled(token, sobject);
    if (h.unavailable.on) throw new rpc.ResponseError(-32803, "schema unavailable: offline");
    if (h.describeDelayMs.v) await sleep(h.describeDelayMs.v);
    return h.describes[sobject] ?? null;
  });
  conn.onRequest("sfx/describeMany", async ({ uri, names }: { uri?: string; names: string[] }, token: any) => {
    h.log.push({ t: Date.now(), method: "describeMany", arg: names.join(","), uri: uri ?? "" });
    if (!h.describeManySupported.v) throw new rpc.ResponseError(-32601, "Unhandled method sfx/describeMany");
    if (h.hangAll.on || names.some((n) => h.hang.has(n))) return hangUntilCancelled(token, names.join(","));
    if (h.unavailable.on) throw new rpc.ResponseError(-32803, "schema unavailable: offline");
    return names.map((n) => h.describes[n] ?? null);
  });
  conn.onRequest("sfx/projectInfo", () => ({ namespace: "acme" }));
  conn.onRequest("sfx/objectInfo", () => ({ description: null }));
  conn.onRequest("workspace/semanticTokens/refresh", () => {
    h.refreshes.push(Date.now());
    h.onRefresh?.();
    return null;
  });
  conn.onNotification("textDocument/publishDiagnostics", () => undefined);
  conn.listen();
  await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).href,
    capabilities: { workspace: { semanticTokens: { refreshSupport: true } } },
    initializationOptions: { apexFeatures: opts.apexFeatures !== false },
  });
  await conn.sendNotification("initialized", {});
  return h;
}

const itemsOf = (res: any): any[] => (Array.isArray(res) ? res : res?.items ?? []);
const labelsOf = (res: any): string[] => itemsOf(res).map((i: any) => i.label);
/** Position of the `|` marker in `text` (removed). */
function at(text: string): { text: string; line: number; character: number } {
  const i = text.indexOf("|");
  const clean = text.slice(0, i) + text.slice(i + 1);
  const before = clean.slice(0, i);
  const line = before.split("\n").length - 1;
  return { text: clean, line, character: i - (before.lastIndexOf("\n") + 1) };
}
async function completeAt(h: Host, name: string, marked: string): Promise<any> {
  const p = at(marked);
  const uri = await h.open(name, p.text);
  return h.complete(uri, p.line, p.character);
}
let n = 0;
const nextName = (ext = "soql") => `q${n++}.${ext}`;

// ─── Deadlines ───────────────────────────────────────────────────────────────────

describe("LS schema: deadlines with a hung host", function () {
  this.timeout(30000);
  let h: Host;
  before(async () => {
    h = await startHost({ SFX_LS_SOFT_DEADLINE_MS: "400", SFX_LS_HOST_TIMEOUT_MS: "1500" });
  });
  after(() => h?.dispose());

  it("completion answers within the soft deadline (isIncomplete), later requests too, and recovers", async () => {
    h.hang.add("Account");
    const t0 = Date.now();
    const res = await completeAt(h, nextName(), "SELECT | FROM Account");
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `first completion took ${ms}ms`);
    assert.strictEqual(res.isIncomplete, true, "partial result is marked incomplete");
    assert.ok(!labelsOf(res).includes("Industry"));

    // A second completion for the same object while the first describe is still hung
    // must not wait on the in-flight request beyond its own budget.
    const t1 = Date.now();
    const res2 = await completeAt(h, nextName(), "SELECT Id FROM Account WHERE |");
    assert.ok(Date.now() - t1 < 1000, `second completion took ${Date.now() - t1}ms`);
    assert.strictEqual(res2.isIncomplete, true);
    assert.strictEqual(h.count("describe", "Account"), 1, "deduped while in flight");

    // Host recovers; the hung request hits the hard deadline (host gets a cancel) and is not cached.
    h.hang.delete("Account");
    await sleep(1700);
    assert.ok(h.cancelled.includes("Account"), "host received $/cancelRequest for the timed-out describe");
    const res3 = await completeAt(h, nextName(), "SELECT | FROM Account");
    assert.ok(labelsOf(res3).includes("Industry"), "fields after recovery");
    assert.strictEqual(res3.isIncomplete, false);
    assert.strictEqual(h.count("describe", "Account"), 2, "timeout was not negative-cached");
  });

  it("'schema unavailable' (-32803) is transient: fast answer, not negative-cached, no single-describe storm", async () => {
    h.unavailable.on = true;
    const base = h.log.length;
    const t0 = Date.now();
    const res = await completeAt(h, nextName(), "SELECT | FROM Case WHERE AccountId IN (SELECT WhatId FROM Task)");
    assert.ok(Date.now() - t0 < 400, "rejection answers fast");
    assert.ok(!labelsOf(res).includes("Status"));
    await sleep(900); // prefetch tries describeMany once; must not fall back to per-name describes
    const manyFails = h.log.slice(base).filter((e) => e.method === "describeMany").length;
    const singlesWhileDown = h.log.slice(base).filter((e) => e.method === "describe" && e.arg !== "Case").length;
    assert.ok(manyFails <= 1, `describeMany attempts while down: ${manyFails}`);
    assert.strictEqual(singlesWhileDown, 0, "no fallback storm on SCHEMA_UNAVAILABLE");
    h.unavailable.on = false;
    const before = h.count("describe", "Case");
    const res2 = await completeAt(h, nextName(), "SELECT | FROM Case");
    assert.ok(labelsOf(res2).includes("Status"), "fields once the org answers again");
    assert.strictEqual(h.count("describe", "Case"), before + 1, "the failure was not cached as not-found");
  });

  it("a slow (not hung) describe finishes in the background so the re-request hits the cache", async () => {
    h.describeDelayMs.v = 800;
    const res = await completeAt(h, nextName(), "SELECT | FROM Opportunity");
    assert.strictEqual(res.isIncomplete, true);
    await sleep(700);
    h.describeDelayMs.v = 0;
    const before = h.count("describe", "Opportunity");
    const t0 = Date.now();
    const res2 = await completeAt(h, nextName(), "SELECT | FROM Opportunity");
    assert.ok(labelsOf(res2).includes("StageName"));
    assert.ok(Date.now() - t0 < 300);
    assert.strictEqual(h.count("describe", "Opportunity"), before, "served from cache");
  });

  it("every host request is bounded: a fully hung host leaves nothing pending past the hard deadline", async () => {
    h.hangAll.on = true;
    const uri = await h.open(nextName("cls"), "public class C {\n  void m() {\n    Lead l;\n    Object o = l.Company;\n    String s = l.\n  }\n}\n");
    const res = await h.complete(uri, 4, 17);
    assert.ok(res.isIncomplete, "member completion on a hung host is partial");
    await sleep(1800);
    const sent = h.log.filter((e) => e.method === "describe" || e.method === "describeMany").length;
    assert.ok(sent >= 1);
    assert.ok(h.cancelled.length >= 1, "timed-out requests were cancelled");
    h.hangAll.on = false;
  });
});

// ─── Request counts / gating ────────────────────────────────────────────────────

describe("LS schema: request counts", function () {
  this.timeout(30000);
  let h: Host;
  before(async () => {
    h = await startHost({ SFX_LS_SOFT_DEADLINE_MS: "1500", SFX_LS_HOST_TIMEOUT_MS: "3000" });
  });
  after(() => h?.dispose());

  it("never describes non-object names (unlisted, dotted, primitives, std types)", async () => {
    const before = h.count("describe");
    const src =
      "public class C {\n  void m() {\n    Foo__c f;\n    Object a = f.Bar__c;\n    String s;\n    Integer i = s.length();\n    Mystery m;\n    Object b = m.x;\n    Object c = Database.query('SELECT Id FROM Nope__c');\n  }\n}\n";
    const uri = await h.open(nextName("cls"), src);
    await h.complete(uri, 3, 17);
    await h.complete(uri, 7, 17);
    await completeAt(h, nextName(), "SELECT | FROM Unlisted__c");
    await completeAt(h, nextName(), "SELECT Foo.| FROM Unlisted__c");
    await sleep(900); // diagnostics + prefetch passes
    const names = h.log.slice(0).filter((e) => e.method === "describe").map((e) => e.arg);
    assert.strictEqual(h.count("describe"), before, `no describes expected, got ${names.join(",")}`);
    assert.ok(!h.log.some((e) => e.method === "describeMany" && /Nope__c|Unlisted__c/.test(e.arg)));
  });

  it("resolves a namespace-optional name with ONE describe (no unprefixed probe)", async () => {
    const res = await completeAt(h, nextName(), "SELECT | FROM Widget__c");
    assert.ok(labelsOf(res).includes("acme__Amount__c"));
    assert.strictEqual(h.count("describe", "Widget__c"), 0);
    assert.ok(h.count("describe", "acme__Widget__c") + h.log.filter((e) => e.method === "describeMany" && e.arg.includes("acme__Widget__c")).length <= 1);
  });

  it("N concurrent completions for one object cost one describe", async () => {
    h.describeDelayMs.v = 200;
    const before = h.count("describe", "Lead");
    const all = await Promise.all(Array.from({ length: 8 }, () => completeAt(h, nextName(), "SELECT | FROM Lead")));
    h.describeDelayMs.v = 0;
    for (const r of all) assert.ok(labelsOf(r).includes("Company"));
    assert.strictEqual(h.count("describe", "Lead") - before, 1);
  });

  it("asks for the object list once per org until a structural refresh", async () => {
    for (let i = 0; i < 6; i++) await completeAt(h, nextName(), "SELECT Id FROM |");
    const apex = await h.open(nextName("cls"), "public class C {\n  void m() {\n    Account a = new \n  }\n}\n");
    await h.complete(apex, 2, 20);
    assert.strictEqual(h.count("objectList"), 1, "one object list per org context");
    await h.conn.sendNotification("sfx/refreshSchema", { objects: ["Account"] });
    await completeAt(h, nextName(), "SELECT Id FROM |");
    assert.strictEqual(h.count("objectList"), 1, "a targeted (non-structural) refresh keeps the list");
    await h.conn.sendNotification("sfx/refreshSchema", { structural: true });
    await completeAt(h, nextName(), "SELECT Id FROM |");
    assert.strictEqual(h.count("objectList"), 2, "structural refresh re-asks once");
  });

  it("a uris refresh drops only those documents' org contexts", async () => {
    const dirA = path.join(h.root, "pa");
    const dirB = path.join(h.root, "pb");
    for (const d of [dirA, dirB]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "sfdx-project.json"), "{}");
    }
    const p = at("SELECT | FROM Group");
    const ua = await h.open("pa/a.soql", p.text);
    const ub = await h.open("pb/b.soql", p.text);
    const inA = () => h.log.filter((e) => e.method === "describe" && e.arg === "Group" && e.uri === ua).length;
    const inB = () => h.log.filter((e) => e.method === "describe" && e.arg === "Group" && e.uri === ub).length;
    await h.complete(ua, p.line, p.character);
    await h.complete(ub, p.line, p.character);
    await sleep(800); // let prefetch settle
    const a0 = inA();
    const b0 = inB();
    assert.ok(a0 >= 1 && b0 >= 1, "each context described Group");
    await h.conn.sendNotification("sfx/refreshSchema", { uris: [ua] });
    assert.ok(labelsOf(await h.complete(ua, p.line, p.character)).includes("DeveloperName"));
    assert.ok(labelsOf(await h.complete(ub, p.line, p.character)).includes("DeveloperName"));
    assert.strictEqual(inA(), a0 + 1, "A re-described");
    assert.strictEqual(inB(), b0, "B still cached");
  });
});

// ─── TTL / prefetch ──────────────────────────────────────────────────────────────

describe("LS schema: stale-while-revalidate and prefetch", function () {
  this.timeout(30000);
  let h: Host;
  before(async () => {
    h = await startHost({ SFX_LS_DESCRIBE_TTL_MS: "1000", SFX_LS_HOST_TIMEOUT_MS: "3000" });
  });
  after(() => h?.dispose());

  it("serves a stale describe immediately and revalidates it in the background", async () => {
    assert.ok(labelsOf(await completeAt(h, nextName(), "SELECT | FROM Lead")).includes("Company"));
    h.describes.Lead.fields.push({ name: "Rating", type: "string" });
    await sleep(1100);
    const before = h.count("describe", "Lead");
    const stale = await completeAt(h, nextName(), "SELECT | FROM Lead");
    assert.ok(!labelsOf(stale).includes("Rating"), "stale entry served without waiting");
    await sleep(200);
    assert.strictEqual(h.count("describe", "Lead"), before + 1, "one background revalidation");
    assert.ok(labelsOf(await completeAt(h, nextName(), "SELECT | FROM Lead")).includes("Rating"), "fresh after revalidation");
  });

  it("prefetches FROM objects and their likely parents with describeMany", async () => {
    await h.open(nextName(), "SELECT Id, Account.Name, (SELECT Id FROM Cases) FROM Contact");
    await sleep(1200);
    const many = h.log.filter((e) => e.method === "describeMany").map((e) => e.arg);
    const singles = h.log.filter((e) => e.method === "describe").map((e) => e.arg);
    const warmed = (n: string) => many.some((m) => m.split(",").includes(n)) || singles.includes(n);
    assert.ok(warmed("Contact"), `Contact prefetched: ${many.join(" ; ")}`);
    assert.ok(warmed("Account"), `Account (lookup target) prefetched: ${many.join(" ; ")}`);
    assert.ok(warmed("User"), `User (Owner) prefetched: ${many.join(" ; ")}`);
    const before = h.count("describe") + h.count("describeMany");
    const p = at("SELECT Id, Account.Name, (SELECT Id FROM Cases) FROM Contact WHERE Owner.|");
    const uri = await h.open(nextName(), p.text);
    const res = await h.complete(uri, p.line, p.character);
    assert.ok(labelsOf(res).includes("Username"));
    assert.strictEqual(h.count("describe") + h.count("describeMany"), before, "completion served from the prefetched cache");
  });

  it("falls back to single describes when describeMany is not supported", async () => {
    h.describeManySupported.v = false;
    await h.conn.sendNotification("sfx/refreshSchema");
    const before = h.count("describe", "Task");
    await h.open(nextName(), "SELECT Id, Who.Name FROM Task");
    await sleep(1200);
    assert.ok(h.count("describe", "Task") > before, "Task described via the fallback");
  });
});

// ─── Semantic tokens pump ────────────────────────────────────────────────────────

describe("LS schema: semantic-token pump", function () {
  this.timeout(40000);

  it("does not stall after an unanswered describe (refresh restarts it)", async () => {
    // No diagnostics (apexFeatures off): only the semantic-token pump describes.
    const h = await startHost({ SFX_LS_HOST_TIMEOUT_MS: "20000" }, { apexFeatures: false });
    try {
      h.hangAll.on = true;
      const uri = await h.open(nextName("cls"), "public class P {\n  void f() {\n    Contact c;\n    String s = c.Account.Name;\n  }\n}\n");
      await h.conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });
      await sleep(500);
      const hung = h.log.filter((e) => e.method === "describe" || e.method === "describeMany").length;
      assert.ok(hung >= 1, "pump asked the host");
      h.hangAll.on = false;
      await h.conn.sendNotification("sfx/refreshSchema");
      await h.conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } });
      await sleep(800);
      const after = h.log.filter((e) => e.method === "describe" || e.method === "describeMany").length;
      assert.ok(after > hung, "pump fetched again after the refresh (not wedged on the hung request)");
    } finally {
      h.dispose();
    }
  });

  it("settles with 400 objects: at most one refresh per 5 s afterwards", async () => {
    const NO = 400;
    const objects = Array.from({ length: NO }, (_, i) => `Obj${i}__c`).concat(["Account"]);
    const h = await startHost({}, { objects });
    try {
      for (const o of objects) {
        if (o === "Account") continue;
        h.describes[o] = { name: o, fields: [{ name: "Id", type: "id" }, { name: "Fld__c", type: "double" }, ref("Parent__c", "Parent__r", ["Account"])], childRelationships: [] };
      }
      let txt = "public class P {\n void f(){\n";
      for (let i = 0; i < NO; i++) txt += `  Obj${i}__c o${i} = new Obj${i}__c(); o${i}.Fld__c = 1; String s${i} = o${i}.Parent__r.Name;\n`;
      txt += " }\n}\n";
      const uris: string[] = [];
      h.onRefresh = () => {
        for (const u of uris) h.conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri: u } }).catch(() => undefined);
      };
      for (let d = 0; d < 3; d++) {
        const u = await h.open(`pp${d}.cls`, txt);
        uris.push(u);
        h.conn.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri: u } }).catch(() => undefined);
      }
      await sleep(4000);
      const settledAt = Date.now();
      const describesAtSettle = h.count("describe") + h.count("describeMany");
      await sleep(5000);
      const late = h.refreshes.filter((t) => t >= settledAt).length;
      assert.ok(late <= 1, `refreshes after settling: ${late} (total ${h.refreshes.length})`);
      const describesAfter = h.count("describe") + h.count("describeMany");
      assert.ok(describesAfter - describesAtSettle <= 2, `host requests after settling: ${describesAfter - describesAtSettle}`);
      const singles = h.count("describe");
      assert.ok(singles + h.count("describeMany") < NO * 1.5, `describe traffic bounded: ${singles} singles, ${h.count("describeMany")} batches`);
    } finally {
      h.dispose();
    }
  });
});

// ─── SOQL correctness ────────────────────────────────────────────────────────────

describe("LS schema: SOQL correctness", function () {
  this.timeout(30000);
  let h: Host;
  before(async () => {
    const objects = [...Object.keys(baseDescribes())];
    for (let i = 0; i < 2500; i++) objects.push(`Obj${i}__c`);
    h = await startHost({}, { objects });
  });
  after(() => h?.dispose());

  it("resolves dotted paths in a child subquery against the subquery's object", async () => {
    const labels = labelsOf(await completeAt(h, nextName(), "SELECT Id, (SELECT ReportsTo.| FROM Contacts) FROM Account"));
    assert.ok(labels.includes("LastName"), `Contact fields via Contacts → Contact.ReportsTo: ${labels.slice(0, 10).join(",")}`);
    const labels2 = labelsOf(await completeAt(h, nextName(), "SELECT Id, (SELECT Account.| FROM Contacts) FROM Account"));
    assert.ok(labels2.includes("Industry"));
    assert.ok(!h.log.some((e) => e.arg === "Contacts"), "never describes the relationship name");
  });

  it("completes child subquery fields and nested child relationship names", async () => {
    const labels = labelsOf(await completeAt(h, nextName(), "SELECT Id, (SELECT | FROM Contacts) FROM Account"));
    assert.ok(labels.includes("LastName"));
    const rels = labelsOf(await completeAt(h, nextName(), "SELECT Id, (SELECT Id FROM |) FROM Account"));
    assert.ok(rels.includes("Contacts") && rels.includes("Cases"));
  });

  it("polymorphic lookups offer Name fields (not just the first target) plus TYPEOF", async () => {
    const labels = labelsOf(await completeAt(h, nextName(), "SELECT Owner.| FROM Case"));
    for (const f of ["Id", "Name", "Type", "Alias", "Email"]) assert.ok(labels.includes(f), `Name field ${f}: ${labels.join(",")}`);
    assert.ok(!labels.includes("DeveloperName"), "not Group-only fields");
    const sel = itemsOf(await completeAt(h, nextName(), "SELECT Id, | FROM Task"));
    const ty = sel.find((i: any) => i.label === "TYPEOF What");
    assert.ok(ty, "TYPEOF snippet for a polymorphic lookup");
    assert.match(ty.insertText, /TYPEOF What WHEN \$\{1\|Account,Opportunity\|\} THEN/);
    const single = labelsOf(await completeAt(h, nextName(), "SELECT Owner.| FROM Account"));
    assert.ok(single.includes("Username"), "single-target lookup still resolves to User");
  });

  it("offers a TYPEOF item after `What.` that replaces the whole token (soql file, inline Apex, subquery)", async () => {
    const find = (res: any) => itemsOf(res).find((i: any) => String(i.label).startsWith("TYPEOF What"));
    const range = (r: any) => [r.start.line, r.start.character, r.end.line, r.end.character];

    // .soql file
    const soql = await completeAt(h, nextName(), "SELECT Id, What.| FROM Task");
    const item = find(soql);
    assert.ok(item, "TYPEOF item after What.");
    assert.equal(item.label, "TYPEOF What …");
    assert.equal(item.kind, 15, "Snippet kind");
    assert.equal(item.insertTextFormat, 2);
    assert.deepEqual(range(item.textEdit.range), [0, 11, 0, 16]);
    assert.equal(item.textEdit.newText, "TYPEOF What WHEN ${1:Account} THEN ${2:Id, Name} ${3:WHEN ${4:Opportunity} THEN ${5:Id, Name}} ELSE ${6:Id} END");
    assert.ok(labelsOf(soql).includes("Name") && labelsOf(soql).includes("Type"), "Name fields are still offered");
    const first = [...itemsOf(soql)].sort((a: any, b: any) => ((a.sortText ?? a.label) < (b.sortText ?? b.label) ? -1 : 1))[0];
    assert.equal(first, itemsOf(soql).find((i: any) => i.label === item.label), "sorts first");

    // other polymorphic lookup: the first two targets, in order
    const own = itemsOf(await completeAt(h, nextName(), "SELECT Owner.| FROM Case")).find((i: any) => i.label === "TYPEOF Owner …");
    assert.ok(own);
    assert.match(own.textEdit.newText, /^TYPEOF Owner WHEN \$\{1:Group\} THEN \$\{2:Id, Name\} \$\{3:WHEN \$\{4:User\} THEN/);

    // multi-line .soql: range on the cursor's line
    const ml = find(await completeAt(h, nextName(), "SELECT Id,\n  What.|\nFROM Task"));
    assert.deepEqual(range(ml.textEdit.range), [1, 2, 1, 7]);

    // inline Apex on a line with leading code
    const apex = find(await completeAt(h, nextName("cls"), "public class A {\n  void m() {\n    List<Task> ts = [SELECT Id, What.| FROM Task];\n  }\n}"));
    assert.ok(apex, "TYPEOF item in inline SOQL");
    const lineLen = "    List<Task> ts = [SELECT Id, What.".length;
    assert.deepEqual(range(apex.textEdit.range), [2, lineLen - 5, 2, lineLen]);

    // inline Apex query spanning lines: range on the later line is relative to the line start
    const apex2 = find(await completeAt(h, nextName("cls"), "class A { void m() { x = [SELECT Id,\n    What.| FROM Task]; } }"));
    assert.ok(apex2);
    assert.deepEqual(range(apex2.textEdit.range), [1, 4, 1, 9]);

    // child subquery SELECT list
    const sub = itemsOf(await completeAt(h, nextName(), "SELECT Id, (SELECT Owner.| FROM Cases) FROM Account")).find((i: any) => i.label === "TYPEOF Owner …");
    assert.ok(sub, "TYPEOF item in a subquery SELECT list");
    assert.deepEqual(range(sub.textEdit.range), [0, 19, 0, 25]);
  });

  it("does not offer the TYPEOF-after-dot item outside a SELECT field list or for non-polymorphic lookups", async () => {
    const has = (res: any) => itemsOf(res).some((i: any) => String(i.label).startsWith("TYPEOF "));
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Id FROM Task WHERE What.|")), "WHERE");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Id FROM Task ORDER BY What.|")), "ORDER BY");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Id FROM Task GROUP BY What.|")), "GROUP BY");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Id FROM Case WHERE AccountId IN (SELECT Id FROM Task WHERE What.|)")), "subquery WHERE");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT toLabel(What.|) FROM Task")), "inside a function call");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Id, Account.| FROM Opportunity")), "non-polymorphic Account.");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Owner.| FROM Account")), "single-target Owner");
    assert.ok(!has(await completeAt(h, nextName(), "SELECT Account.Owner.| FROM Contact")), "nested path");
    // the plain field-list TYPEOF snippet is unchanged
    const ty = itemsOf(await completeAt(h, nextName(), "SELECT Id, | FROM Task")).find((i: any) => i.label === "TYPEOF What");
    assert.ok(ty);
    assert.match(ty.insertText, /TYPEOF What WHEN \$\{1\|Account,Opportunity\|\} THEN/);
  });

  it("TYPEOF: WHEN offers the targets, THEN offers that type's fields", async () => {
    const when = labelsOf(await completeAt(h, nextName(), "SELECT TYPEOF What WHEN | FROM Task"));
    assert.deepStrictEqual(when.sort(), ["Account", "Opportunity"]);
    const then = labelsOf(await completeAt(h, nextName(), "SELECT TYPEOF What WHEN Opportunity THEN | END FROM Task"));
    assert.ok(then.includes("StageName"), `Opportunity fields: ${then.slice(0, 8).join(",")}`);
    const then2 = labelsOf(await completeAt(h, nextName(), "SELECT TYPEOF What WHEN Account THEN Name, | FROM Task"));
    assert.ok(then2.includes("Industry"));
  });

  it("value positions: picklist values first, no placeholders, quote-aware insert", async () => {
    const res = itemsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE Industry = '|"));
    const labels = res.map((i: any) => i.label);
    for (const bad of ["nnn", "nnn.nnn", "abc123", "YYYY-MM-DD", "YYYY-MM-DDThh:mm:ssZ", "ISOCODEnnn.nn", "TODAY", "TRUE"]) {
      assert.ok(!labels.includes(bad), `no ${bad} for a picklist`);
    }
    const sorted = [...res].sort((a: any, b: any) => String(a.sortText ?? a.label).localeCompare(String(b.sortText ?? b.label)));
    assert.deepStrictEqual(sorted.slice(0, 3).map((i: any) => i.label), ["'Banking'", "'Retail'", "'Technology'"]);
    const banking = res.find((i: any) => i.label === "'Banking'");
    assert.strictEqual(banking.insertText, "Banking'", "opening quote already typed → not inserted again");
    const bare = itemsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE Industry = |")).find((i: any) => i.label === "'Banking'");
    assert.strictEqual(bare.insertText, "'Banking'");
    const closed = itemsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE Industry = '|'")).find((i: any) => i.label === "'Banking'");
    assert.strictEqual(closed.insertText, "Banking", "auto-closed quote → insert only the value");
  });

  it("date literals only (once) for date/datetime fields; TRUE/FALSE for booleans", async () => {
    const dt = labelsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE CreatedDate > |"));
    assert.strictEqual(dt.filter((l) => l === "TODAY").length, 1, "TODAY exactly once");
    assert.ok(dt.includes("LAST_N_DAYS:n"));
    assert.ok(!dt.includes("YYYY-MM-DD") && !dt.includes("nnn"));
    const str = labelsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE Name = |"));
    assert.ok(!str.includes("TODAY") && !str.includes("abc123") && !str.includes("TRUE"));
    const bool = labelsOf(await completeAt(h, nextName(), "SELECT Id FROM Account WHERE IsDeleted = |"));
    assert.ok(bool.includes("TRUE") && bool.includes("FALSE") && !bool.includes("TODAY"));
  });

  it("caps a large FROM list (prefix-filtered, isIncomplete)", async () => {
    const res = await completeAt(h, nextName(), "SELECT Id FROM |");
    assert.ok(itemsOf(res).length <= 200, `capped: ${itemsOf(res).length}`);
    assert.strictEqual(res.isIncomplete, true);
    assert.ok(labelsOf(res).includes("Account"), "business objects ranked first");
    const typed = await completeAt(h, nextName(), "SELECT Id FROM Obj1234|");
    assert.ok(labelsOf(typed).includes("Obj1234__c"), "prefix filter on the server");
  });

  it("warm completion p95 < 15 ms at any depth", async () => {
    const cases = [
      "SELECT | FROM Account",
      "SELECT Owner.Manager.Manager.| FROM Contact",
      "SELECT Id, (SELECT Account.Owner.| FROM Contacts) FROM Account",
      "SELECT Id FROM Account WHERE Industry = '|",
    ];
    for (const c of cases) {
      const p = at(c);
      const uri = await h.open(nextName(), p.text);
      await h.complete(uri, p.line, p.character); // warm
      await sleep(50);
      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = process.hrtime.bigint();
        const r = await h.complete(uri, p.line, p.character);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.ok(itemsOf(r).length > 0, `items for ${c}`);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95)];
      assert.ok(p95 < 15, `p95 ${p95.toFixed(1)}ms for ${c}`);
    }
  });
});
