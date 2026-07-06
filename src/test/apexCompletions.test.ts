import * as assert from "assert";
import { parseContext, fieldAndRelationItems, CompletionKind } from "../utils/apexCompletions";

describe("parseContext — SOQL in Apex", () => {
  it("single-line SELECT offers fields of the FROM object", () => {
    const line = "List<Contact> cs = [SELECT ";
    const window = "List<Contact> cs = [SELECT  FROM Contact];";
    const ctx = parseContext(line, window);
    assert.strictEqual(ctx.type, "soqlField");
    assert.strictEqual(ctx.sobjectName, "Contact");
    assert.strictEqual(ctx.prefix, "");
    assert.ok(!ctx.relPath || ctx.relPath.length === 0);
  });

  it("captures a single relationship hop (Account__r.<field>)", () => {
    const line = "List<Contact> cs = [SELECT Account__r.Na";
    const window = "List<Contact> cs = [SELECT Account__r.Na FROM Contact];";
    const ctx = parseContext(line, window);
    assert.strictEqual(ctx.type, "soqlField");
    assert.strictEqual(ctx.sobjectName, "Contact");
    assert.deepStrictEqual(ctx.relPath, ["Account__r"]);
    assert.strictEqual(ctx.prefix, "Na");
  });

  it("captures multiple relationship hops (Owner.Manager.<field>)", () => {
    const line = "[SELECT Owner.Manager.Prof";
    const window = "[SELECT Owner.Manager.Prof FROM Case]";
    const ctx = parseContext(line, window);
    assert.strictEqual(ctx.type, "soqlField");
    assert.strictEqual(ctx.sobjectName, "Case");
    assert.deepStrictEqual(ctx.relPath, ["Owner", "Manager"]);
    assert.strictEqual(ctx.prefix, "Prof");
  });

  it("detects a SELECT that began on an earlier line via beforeCursor", () => {
    const currentLine = "       Owner.";
    const before = "List<Contact> cs = [\n  SELECT Id,\n       Owner.";
    const window = before + "Name\n  FROM Contact\n];";
    const ctx = parseContext(currentLine, window, before);
    assert.strictEqual(ctx.type, "soqlField");
    assert.strictEqual(ctx.sobjectName, "Contact");
    assert.deepStrictEqual(ctx.relPath, ["Owner"]);
  });

  it("does NOT treat Apex member access after a closed query as SOQL", () => {
    // `acc.` sits after a completed [ ... ] query in the window.
    const currentLine = "acc.";
    const before = "List<Account> a = [SELECT Id FROM Account];\nacc.";
    const window = before;
    const ctx = parseContext(currentLine, window, before);
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "acc");
  });

  it("still recognizes the FROM clause", () => {
    const line = "[SELECT Id FROM Acc";
    const ctx = parseContext(line, line);
    assert.strictEqual(ctx.type, "soqlFrom");
    assert.strictEqual(ctx.prefix, "Acc");
  });

  it("plain Apex dot-access stays member", () => {
    const line = "System.deb";
    const ctx = parseContext(line, line);
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "System");
    assert.strictEqual(ctx.prefix, "deb");
    assert.deepStrictEqual(ctx.relPath, []);
  });
});

describe("parseContext — SObject instance relationship drilling", () => {
  it("single member access carries no hops", () => {
    const ctx = parseContext("account.Na");
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "account");
    assert.deepStrictEqual(ctx.relPath, []);
    assert.strictEqual(ctx.prefix, "Na");
  });

  it("drills one relationship hop (account.Contact.<field>)", () => {
    const ctx = parseContext("account.Contact.Na");
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "account");
    assert.deepStrictEqual(ctx.relPath, ["Contact"]);
    assert.strictEqual(ctx.prefix, "Na");
  });

  it("drills multiple relationship hops (c.Account.Owner.<field>)", () => {
    const ctx = parseContext("c.Account.Owner.Ema");
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "c");
    assert.deepStrictEqual(ctx.relPath, ["Account", "Owner"]);
    assert.strictEqual(ctx.prefix, "Ema");
  });

  it("bare dot after the root lists the root's own fields (empty prefix)", () => {
    const ctx = parseContext("account.Custom__r.");
    assert.strictEqual(ctx.type, "member");
    assert.strictEqual(ctx.objectName, "account");
    assert.deepStrictEqual(ctx.relPath, ["Custom__r"]);
    assert.strictEqual(ctx.prefix, "");
  });
});

describe("fieldAndRelationItems", () => {
  const entries = [
    { name: "Name", type: "string" },
    { name: "AccountId", type: "reference" },
    { name: "Account", type: "reference", rel: true, target: "Account" },
    { name: "MyLookup__r", type: "reference", rel: true, target: "Custom__c" },
  ];

  it("emits both fields and relationship pseudo-fields", () => {
    const items = fieldAndRelationItems(entries, "");
    const labels = items.map(i => i.label);
    assert.ok(labels.includes("Account"));
    assert.ok(labels.includes("MyLookup__r"));
    assert.ok(labels.includes("Name"));
  });

  it("marks relationships as Class kind with a target in detail", () => {
    const rel = fieldAndRelationItems(entries, "MyLookup").find(i => i.label === "MyLookup__r");
    assert.ok(rel);
    assert.strictEqual(rel!.kind, CompletionKind.Class);
    assert.match(rel!.detail || "", /Custom__c/);
  });

  it("filters by prefix", () => {
    const items = fieldAndRelationItems(entries, "acc");
    const labels = items.map(i => i.label).sort();
    assert.deepStrictEqual(labels, ["Account", "AccountId"]);
  });
});
