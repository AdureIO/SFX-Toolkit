import * as assert from "assert";
import { nameFieldOf, buildLookupSoql } from "../utils/soqlEditPure";

describe("nameFieldOf", () => {
  it("returns the describe's name field", () => {
    assert.strictEqual(nameFieldOf({ fields: [{ name: "Id" }, { name: "CaseNumber", nameField: true }] }), "CaseNumber");
    assert.strictEqual(nameFieldOf({ fields: [{ name: "Name", nameField: true }] }), "Name");
  });
  it("falls back to Name when none flagged", () => {
    assert.strictEqual(nameFieldOf({ fields: [{ name: "Id" }] }), "Name");
    assert.strictEqual(nameFieldOf(null), "Name");
  });
});

describe("buildLookupSoql", () => {
  it("queries the given name field and escapes the term", () => {
    assert.strictEqual(
      buildLookupSoql("Account", "Name", "Acme", 10),
      "SELECT Id, Name FROM Account WHERE Name LIKE '%Acme%' ORDER BY Name LIMIT 10"
    );
  });
  it("uses a non-Name name field", () => {
    assert.ok(buildLookupSoql("Case", "CaseNumber", "0001", 5).includes("WHERE CaseNumber LIKE '%0001%'"));
  });
  it("escapes quotes and wildcards", () => {
    const q = buildLookupSoql("Account", "Name", "a'b%c_d", 5);
    assert.ok(q.includes("%a\\'b\\%c\\_d%"));
  });
  it("clamps the limit", () => {
    assert.ok(buildLookupSoql("Account", "Name", "x", 999).endsWith("LIMIT 50"));
  });
});
