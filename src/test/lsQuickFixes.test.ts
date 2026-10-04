/**
 * Integration tests for the language server's diagnostic quick fixes (server/src/codeActions.ts):
 * SOQL/DML-in-loop bulkification, sharing keyword, System.debug removal, missing ';',
 * and "create field stub" for unknown custom fields. Spawns the bundled server
 * (../server.js relative to the compiled test), plays the extension host, applies the
 * returned edits to the text and asserts on the resulting code.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const DESCRIBES: Record<string, any> = {
  Account: {
    name: "Account",
    fields: [
      { name: "Id", type: "id" },
      { name: "Name", type: "string" },
      { name: "Description", type: "textarea" },
    ],
    childRelationships: [{ name: "Contacts", childSObject: "Contact" }],
  },
  Contact: {
    name: "Contact",
    fields: [
      { name: "Id", type: "id" },
      { name: "LastName", type: "string" },
      { name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"] },
      { name: "Parent__c", type: "reference", relationshipName: "Parent__r", referenceTo: ["Account"] },
    ],
    childRelationships: [],
  },
  acme__Widget__c: {
    name: "acme__Widget__c",
    fields: [
      { name: "Id", type: "id" },
      { name: "Name", type: "string" },
    ],
    childRelationships: [],
  },
};

let child: cp.ChildProcess;
let conn: any;
let version = 1;
let tmpRoot: string;
let docSeq = 0;
const diagnosticsByUri = new Map<string, any[]>();

async function waitForDiagnostics(uri: string, pred: (d: any[]) => boolean, timeoutMs = 4000): Promise<any[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = diagnosticsByUri.get(uri);
    if (d && pred(d)) return d;
    await new Promise((r) => setTimeout(r, 25));
  }
  return diagnosticsByUri.get(uri) ?? [];
}

function classUri(name = `Q${++docSeq}`): string {
  return pathToFileURL(path.join(tmpRoot, "force-app", "main", "default", "classes", `${name}.cls`)).href;
}

async function open(text: string, uri = classUri()): Promise<string> {
  await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: version++, text } });
  return uri;
}

function offsetAt(text: string, pos: { line: number; character: number }): number {
  let off = 0;
  for (let l = 0; l < pos.line; l++) {
    const nl = text.indexOf("\n", off);
    if (nl < 0) return text.length;
    off = nl + 1;
  }
  return off + pos.character;
}

function applyEdits(text: string, edits: { range: any; newText: string }[]): string {
  const abs = edits
    .map((e) => ({ s: offsetAt(text, e.range.start), e: offsetAt(text, e.range.end), t: e.newText }))
    .sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  for (const e of abs) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}

/** Open `text`, wait for a diagnostic with `code`, and return the quick fixes offered for it. */
async function fixesFor(text: string, code: string, opts: { source?: string; nth?: number; uri?: string } = {}) {
  const uri = await open(text, opts.uri);
  const diags = await waitForDiagnostics(uri, (d) => d.some((x) => x.code === code || (opts.source && x.source === opts.source)));
  const matching = diags.filter((x) => x.code === code || (opts.source && x.source === opts.source));
  assert.ok(matching.length > (opts.nth ?? 0), `expected a ${code} diagnostic, got ${JSON.stringify(diags.map((d) => d.code ?? d.message))}`);
  const diag = matching[opts.nth ?? 0];
  const actions: any[] = await conn.sendRequest("textDocument/codeAction", {
    textDocument: { uri },
    range: diag.range,
    context: { diagnostics: [diag] },
  });
  const quick = actions.filter((a) => a.kind === "quickfix" && a.diagnostics?.length);
  return { uri, diag, actions: quick };
}

function applyAction(text: string, uri: string, action: any): string {
  const edits = action.edit?.changes?.[uri];
  assert.ok(edits, `action has edits for the document: ${action.title}`);
  return applyEdits(text, edits);
}

before(async function () {
  this.timeout(20000);
  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
  tmpRoot = path.join(os.tmpdir(), "sfx-qf-test-" + process.pid);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpRoot, "force-app", "main", "default", "classes"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "force-app", "main", "default", "objects", "Account"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace: "acme" }),
  );

  child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
  conn.onRequest("sfx/objectList", () => Object.keys(DESCRIBES));
  conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) => DESCRIBES[sobject] ?? null);
  conn.onRequest("sfx/projectInfo", () => ({ namespace: "acme" }));
  conn.onRequest("sfx/objectInfo", () => ({ description: null }));
  conn.onNotification("textDocument/publishDiagnostics", (p: { uri: string; diagnostics: any[] }) => {
    diagnosticsByUri.set(p.uri, p.diagnostics);
  });
  conn.listen();
  await conn.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(tmpRoot).href,
    capabilities: { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] } } },
    initializationOptions: { apexFeatures: true },
  });
  await conn.sendNotification("initialized", {});
});

after(() => {
  try { conn?.dispose(); } catch { /* ignore */ }
  try { child?.kill(); } catch { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const wrap = (body: string, params = "List<Account> accounts, List<Contact> contacts, String nm") =>
  `public with sharing class Svc {\n    public void run(${params}) {\n${body}    }\n}\n`;

// ─── SOQL in loop ─────────────────────────────────────────────────────────────────

describe("Quick fix: SOQL in loop", () => {
  it("hoists a loop-independent query before the loop", async () => {
    const text = wrap(
      "        for (Account acc : accounts) {\n" +
      "            List<Contact> cs = [SELECT Id FROM Contact WHERE LastName = :nm];\n" +
      "            acc.Description = 'n' + cs.size();\n" +
      "        }\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-soql-in-loop");
    const hoist = actions.find((a) => /Move SOQL query out of the loop/.test(a.title));
    assert.ok(hoist, `hoist offered: ${actions.map((a) => a.title)}`);
    assert.strictEqual(hoist.isPreferred, true);
    const out = applyAction(text, uri, hoist);
    assert.strictEqual(
      out,
      wrap(
        "        List<Contact> contactRecords = [SELECT Id FROM Contact WHERE LastName = :nm];\n" +
        "        for (Account acc : accounts) {\n" +
        "            List<Contact> cs = contactRecords;\n" +
        "            acc.Description = 'n' + cs.size();\n" +
        "        }\n",
      ),
    );
    // Idempotent: the result has no SOQL-in-loop diagnostic left (so no fix either).
    const u2 = await open(out);
    const d2 = await waitForDiagnostics(u2, (d) => d.length >= 0);
    assert.ok(!d2.some((d) => d.code === "asfx-soql-in-loop"));
  });

  it("re-indents a multi-line query and keeps CRLF line endings", async () => {
    const text = wrap(
      "        for (Integer i = 0; i < 3; i++) {\n" +
      "            for (Contact c : [SELECT Id\n" +
      "                              FROM Contact]) {\n" +
      "                c.LastName = 'x';\n" +
      "            }\n" +
      "        }\n",
    ).replace(/\n/g, "\r\n");
    const { uri, actions } = await fixesFor(text, "asfx-soql-in-loop");
    const hoist = actions.find((a) => /Move SOQL/.test(a.title));
    assert.ok(hoist, `hoist offered: ${actions.map((a) => a.title)}`);
    const out = applyAction(text, uri, hoist);
    assert.ok(
      out.includes(
        "        List<Contact> contactRecords = [SELECT Id\r\n                          FROM Contact];\r\n        for (Integer i = 0; i < 3; i++) {\r\n            for (Contact c : contactRecords) {\r\n",
      ),
      out,
    );
  });

  it("bulkifies a query bound to the loop variable (list → Map<Id, List<>>)", async () => {
    const text = wrap(
      "        for (Account acc : accounts) {\n" +
      "            List<Contact> cs = [SELECT Id, LastName FROM Contact WHERE AccountId = :acc.Id];\n" +
      "            acc.Description = 'n' + cs.size();\n" +
      "        }\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-soql-in-loop");
    const bulk = actions.find((a) => /Bulkify SOQL/.test(a.title));
    assert.ok(bulk, `bulkify offered: ${actions.map((a) => a.title)}`);
    assert.ok(!actions.some((a) => /Move SOQL/.test(a.title)), "no plain hoist for a loop-dependent query");
    assert.strictEqual(
      applyAction(text, uri, bulk),
      wrap(
        "        Set<Id> accountIds = new Set<Id>();\n" +
        "        Map<Id, List<Contact>> contactsByAccountId = new Map<Id, List<Contact>>();\n" +
        "        for (Account acc : accounts) {\n" +
        "            accountIds.add(acc.Id);\n" +
        "            contactsByAccountId.put(acc.Id, new List<Contact>());\n" +
        "        }\n" +
        "        for (Contact rec : [SELECT Id, LastName, AccountId FROM Contact WHERE AccountId IN :accountIds]) {\n" +
        "            contactsByAccountId.get(rec.AccountId).add(rec);\n" +
        "        }\n" +
        "        for (Account acc : accounts) {\n" +
        "            List<Contact> cs = contactsByAccountId.get(acc.Id);\n" +
        "            acc.Description = 'n' + cs.size();\n" +
        "        }\n",
      ),
    );
  });

  it("bulkifies a single-row lookup by Id (Map<Id, SObject>)", async () => {
    const text = wrap(
      "        for (Contact c : contacts) {\n" +
      "            Account a = [SELECT Name FROM Account WHERE Id = :c.AccountId];\n" +
      "            c.LastName = a.Name;\n" +
      "        }\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-soql-in-loop");
    const bulk = actions.find((a) => /Bulkify SOQL/.test(a.title));
    assert.ok(bulk, `bulkify offered: ${actions.map((a) => a.title)}`);
    assert.strictEqual(
      applyAction(text, uri, bulk),
      wrap(
        "        Set<Id> accountIds = new Set<Id>();\n" +
        "        for (Contact c : contacts) {\n" +
        "            accountIds.add(c.AccountId);\n" +
        "        }\n" +
        "        Map<Id, Account> accountsById = new Map<Id, Account>([SELECT Name FROM Account WHERE Id IN :accountIds]);\n" +
        "        for (Contact c : contacts) {\n" +
        "            Account a = accountsById.get(c.AccountId);\n" +
        "            c.LastName = a.Name;\n" +
        "        }\n",
      ),
    );
  });

  it("bulkifies on a custom lookup field when the describe says it's a reference", async () => {
    const text = wrap(
      "        for (Contact c : contacts) {\n" +
      "            List<Account> parents = [SELECT Id FROM Account WHERE Id = :c.Parent__c];\n" +
      "            c.LastName = 'p' + parents.size();\n" +
      "        }\n",
    );
    const { actions } = await fixesFor(text, "asfx-soql-in-loop");
    assert.ok(actions.some((a) => /Bulkify SOQL/.test(a.title)), `bulkify offered: ${actions.map((a) => a.title)}`);
  });

  it("offers nothing for ambiguous patterns", async () => {
    const cases = [
      // two binds / OR
      "        for (Account acc : accounts) {\n            List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :acc.Id OR LastName = :nm];\n            acc.Description = '' + cs.size();\n        }\n",
      // single-row assignment, loop-independent (hoisting would change when it throws)
      "        for (Account acc : accounts) {\n            Contact c = [SELECT Id FROM Contact WHERE LastName = :nm LIMIT 1];\n            acc.Description = c.Id;\n        }\n",
      // DML in the same loop could change what later iterations read
      "        for (Account acc : accounts) {\n            List<Contact> cs = [SELECT Id FROM Contact WHERE LastName = :nm];\n            update cs;\n        }\n",
      // bind on a non-Id field
      "        for (Account acc : accounts) {\n            List<Contact> cs = [SELECT Id FROM Contact WHERE LastName = :acc.Name];\n            acc.Description = '' + cs.size();\n        }\n",
      // LIMIT with a loop-dependent bind
      "        for (Account acc : accounts) {\n            List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :acc.Id LIMIT 5];\n            acc.Description = '' + cs.size();\n        }\n",
      // loop over a method call (can't safely iterate twice)
      "        for (Account acc : getAccounts()) {\n            List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :acc.Id];\n            acc.Description = '' + cs.size();\n        }\n",
      // bind on a variable mutated in the loop
      "        String key = '';\n        for (Account acc : accounts) {\n            key = acc.Name;\n            List<Contact> cs = [SELECT Id FROM Contact WHERE LastName = :key];\n            acc.Description = '' + cs.size();\n        }\n",
    ];
    for (const body of cases) {
      const { actions } = await fixesFor(wrap(body), "asfx-soql-in-loop");
      assert.deepStrictEqual(actions.map((a) => a.title), [], `no fix expected for:\n${body}`);
    }
  });
});

// ─── DML in loop ──────────────────────────────────────────────────────────────────

describe("Quick fix: DML in loop", () => {
  it("collects the loop variable and updates once after the loop", async () => {
    const text = wrap(
      "        for (Account acc : accounts) {\n" +
      "            acc.Name = 'x';\n" +
      "            update acc;\n" +
      "        }\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-dml-in-loop");
    const fix = actions.find((a) => /Bulkify DML/.test(a.title));
    assert.ok(fix, `offered: ${actions.map((a) => a.title)}`);
    const out = applyAction(text, uri, fix);
    assert.strictEqual(
      out,
      wrap(
        "        List<Account> accountsToUpdate = new List<Account>();\n" +
        "        for (Account acc : accounts) {\n" +
        "            acc.Name = 'x';\n" +
        "            accountsToUpdate.add(acc);\n" +
        "        }\n" +
        "        update accountsToUpdate;\n",
      ),
    );
    const u2 = await open(out);
    const d2 = await waitForDiagnostics(u2, (d) => d.length >= 0);
    assert.ok(!d2.some((d) => d.code === "asfx-dml-in-loop"), "fixed code has no DML-in-loop diagnostic");
  });

  it("collects a record declared in the loop body (insert)", async () => {
    const text = wrap(
      "        for (Account acc : accounts) {\n" +
      "            Contact c = new Contact(LastName = acc.Name);\n" +
      "            insert c;\n" +
      "        }\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-dml-in-loop");
    const fix = actions.find((a) => /Bulkify DML/.test(a.title));
    assert.ok(fix, `offered: ${actions.map((a) => a.title)}`);
    assert.strictEqual(
      applyAction(text, uri, fix),
      wrap(
        "        List<Contact> contactsToInsert = new List<Contact>();\n" +
        "        for (Account acc : accounts) {\n" +
        "            Contact c = new Contact(LastName = acc.Name);\n" +
        "            contactsToInsert.add(c);\n" +
        "        }\n" +
        "        insert contactsToInsert;\n",
      ),
    );
  });

  it("offers nothing when the record is used after the DML, or for Database.* / try / return", async () => {
    const cases = [
      "        for (Account acc : accounts) {\n            Contact c = new Contact(LastName = acc.Name);\n            insert c;\n            acc.Description = c.Id;\n        }\n",
      "        for (Account acc : accounts) {\n            Database.update(acc);\n        }\n",
      "        for (Account acc : accounts) {\n            try {\n                update acc;\n            } catch (Exception e) {\n            }\n        }\n",
      "        for (Account acc : accounts) {\n            update acc;\n            if (acc.Name == nm) {\n                return;\n            }\n        }\n",
      "        for (Account acc : accounts) {\n            update accounts;\n        }\n",
    ];
    for (const body of cases) {
      const { actions } = await fixesFor(wrap(body), "asfx-dml-in-loop");
      assert.deepStrictEqual(actions.map((a) => a.title), [], `no fix expected for:\n${body}`);
    }
  });
});

// ─── Sharing ──────────────────────────────────────────────────────────────────────

describe("Quick fix: missing sharing", () => {
  it("adds 'with sharing' (preferred) or 'inherited sharing'", async () => {
    const text = "public virtual class Shr {\n    public class Inner {}\n}\n";
    const { uri, actions } = await fixesFor(text, "asfx-missing-sharing");
    assert.deepStrictEqual(actions.map((a) => a.title), ["Add 'with sharing'", "Add 'inherited sharing'"]);
    assert.strictEqual(actions[0].isPreferred, true);
    assert.strictEqual(applyAction(text, uri, actions[0]), "public virtual with sharing class Shr {\n    public class Inner {}\n}\n");
    assert.strictEqual(applyAction(text, uri, actions[1]), "public virtual inherited sharing class Shr {\n    public class Inner {}\n}\n");
  });

  it("is not offered for test classes", async () => {
    const { actions } = await fixesFor("@IsTest\npublic class ShrTest {\n}\n", "asfx-missing-sharing");
    assert.deepStrictEqual(actions, []);
  });
});

// ─── System.debug / syntax ────────────────────────────────────────────────────────

describe("Quick fix: System.debug and missing ';'", () => {
  it("removes one System.debug line, or all of them", async () => {
    const text = wrap(
      "        Integer x = 1;\n" +
      "        System.debug('a; b');\n" +
      "        System.debug(x); x++;\n",
    );
    const { uri, actions } = await fixesFor(text, "asfx-debug-statement");
    const one = actions.find((a) => a.title === "Remove System.debug() statement");
    const all = actions.find((a) => /Remove all System\.debug/.test(a.title));
    assert.ok(one && all, `offered: ${actions.map((a) => a.title)}`);
    assert.strictEqual(applyAction(text, uri, one), wrap("        Integer x = 1;\n        System.debug(x); x++;\n"));
    assert.strictEqual(applyAction(text, uri, all), wrap("        Integer x = 1;\n        x++;\n"));
  });

  it("inserts a missing ';' after the previous token", async () => {
    const text = wrap("        Integer x = 1 // one\n        x++;\n");
    const uri = await open(text);
    const diags = await waitForDiagnostics(uri, (d) => d.some((x) => /missing ';'/.test(x.message)));
    const diag = diags.find((x) => /missing ';'/.test(x.message));
    assert.ok(diag, `syntax diagnostic: ${JSON.stringify(diags.map((d) => d.message))}`);
    const actions: any[] = await conn.sendRequest("textDocument/codeAction", { textDocument: { uri }, range: diag.range, context: { diagnostics: [diag] } });
    const fix = actions.find((a) => a.title === "Insert missing ';'");
    assert.ok(fix, `offered: ${actions.map((a) => a.title)}`);
    assert.strictEqual(applyAction(text, uri, fix), wrap("        Integer x = 1; // one\n        x++;\n"));
  });
});

// ─── Unknown field → field stub ───────────────────────────────────────────────────

describe("Quick fix: create field stub", () => {
  const src =
    "public with sharing class Fs {\n" +
    "    public void m() {\n" +
    "        Account a = new Account();\n" +
    "        a.Foo_Bar__c = 'x';\n" +
    "        a.Nope = 'y';\n" +
    "        acme__Widget__c w = new acme__Widget__c();\n" +
    "        w.acme__TotalAmount__c = 1;\n" +
    "    }\n" +
    "}\n";

  async function stubActions(field: string) {
    const uri = classUri();
    await open(src, uri);
    const diags = await waitForDiagnostics(uri, (d) => d.filter((x) => x.source === "asfx-apex-schema").length >= 3);
    const diag = diags.find((x) => x.source === "asfx-apex-schema" && x.message.startsWith(`'${field}'`));
    assert.ok(diag, `schema diagnostic for ${field}: ${JSON.stringify(diags.map((d) => d.message))}`);
    const actions: any[] = await conn.sendRequest("textDocument/codeAction", { textDocument: { uri }, range: diag.range, context: { diagnostics: [diag] } });
    return { diag, actions: actions.filter((a) => a.kind === "quickfix" && a.diagnostics?.length) };
  }

  it("tags unknown-field diagnostics with a code and { object, field } data", async () => {
    const { diag } = await stubActions("Foo_Bar__c");
    assert.strictEqual(diag.code, "asfx-unknown-field");
    assert.deepStrictEqual(diag.data, { field: "Foo_Bar__c", object: "Account" });
  });

  it("creates the field-meta.xml in the existing objects/<Object> folder", async () => {
    const { actions } = await stubActions("Foo_Bar__c");
    assert.strictEqual(actions.length, 1, actions.map((a) => a.title).join(","));
    const a = actions[0];
    assert.strictEqual(a.title, "Create field Account.Foo_Bar__c (Text(255))");
    const target = pathToFileURL(path.join(tmpRoot, "force-app", "main", "default", "objects", "Account", "fields", "Foo_Bar__c.field-meta.xml")).href;
    const [create, insert] = a.edit.documentChanges;
    assert.strictEqual(create.kind, "create");
    assert.strictEqual(create.uri, target);
    assert.strictEqual(insert.textDocument.uri, target);
    const xml: string = insert.edits[0].newText;
    assert.ok(xml.includes("<fullName>Foo_Bar__c</fullName>") && xml.includes("<label>Foo Bar</label>"), xml);
    assert.ok(xml.includes("<type>Text</type>") && xml.includes("<length>255</length>"), xml);
  });

  it("strips the project namespace and defaults to main/default/objects for objects not in source", async () => {
    const { actions } = await stubActions("acme__TotalAmount__c");
    assert.strictEqual(actions.length, 1, actions.map((a) => a.title).join(","));
    assert.strictEqual(actions[0].title, "Create field Widget__c.TotalAmount__c (Text(255))");
    const target = pathToFileURL(path.join(tmpRoot, "force-app", "main", "default", "objects", "Widget__c", "fields", "TotalAmount__c.field-meta.xml")).href;
    assert.strictEqual(actions[0].edit.documentChanges[0].uri, target);
    assert.ok(actions[0].edit.documentChanges[1].edits[0].newText.includes("<label>Total Amount</label>"));
  });

  it("is not offered for standard (non __c) fields or when the file already exists", async () => {
    assert.deepStrictEqual((await stubActions("Nope")).actions, []);
    const file = path.join(tmpRoot, "force-app", "main", "default", "objects", "Account", "fields", "Foo_Bar__c.field-meta.xml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "<CustomField/>");
    try {
      assert.deepStrictEqual((await stubActions("Foo_Bar__c")).actions, []);
    } finally {
      fs.rmSync(file);
    }
  });
});
