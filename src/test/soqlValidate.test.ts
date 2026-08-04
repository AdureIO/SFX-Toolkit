/**
 * Unit tests for the pure SOQL field validator (no VS Code / network deps).
 * Locks the bug fixes: unknown-field detection, namespace-optional matching,
 * and the conservative skips (subqueries, functions, TYPEOF, literals, values).
 */
import * as assert from "assert";
import { validateSoqlFields, topLevelFromObject } from "../utils/soqlValidate";

// Schema for an "Account-like" object used across the cases.
const fields = new Set<string>([
  "id", "name", "industry",
  "sfy24__order_date__c", "order_date__c", // namespaced + namespaceless form (as the host builds it)
]);
const rels = new Set<string>(["account", "owner"]);

function badFields(text: string): string[] {
  return validateSoqlFields(text, fields, rels).map((m) => m.message.match(/'([^']+)'/)?.[1] ?? "");
}

describe("topLevelFromObject", () => {
  it("returns the main object", () => {
    assert.strictEqual(topLevelFromObject("SELECT Id FROM Account"), "Account");
    assert.strictEqual(topLevelFromObject("select id from sfLma__License__c"), "sfLma__License__c");
  });
  it("ignores a subquery's FROM", () => {
    assert.strictEqual(topLevelFromObject("SELECT Id, (SELECT Id FROM Contacts) FROM Account"), "Account");
  });
  it("returns null without a FROM", () => {
    assert.strictEqual(topLevelFromObject("SELECT Id"), null);
  });
});

describe("validateSoqlFields", () => {
  it("accepts known fields", () => {
    assert.deepStrictEqual(badFields("SELECT Id, Name, Industry FROM Account"), []);
  });

  it("flags an unknown field in SELECT", () => {
    assert.deepStrictEqual(badFields("SELECT Id, Bogus FROM Account"), ["Bogus"]);
  });

  it("flags an unknown field in WHERE", () => {
    assert.deepStrictEqual(badFields("SELECT Id FROM Account WHERE Bogus < TODAY"), ["Bogus"]);
  });

  it("namespace-optional: accepts namespaced and bare custom field", () => {
    assert.deepStrictEqual(badFields("SELECT sfy24__Order_Date__c FROM Account"), []);
    assert.deepStrictEqual(badFields("SELECT Order_Date__c FROM Account"), []);
  });

  it("does not flag date/value literals on the right of an operator", () => {
    assert.deepStrictEqual(badFields("SELECT Id FROM Account WHERE Id < TODAY"), []);
  });

  it("skips fields inside a subquery (depth > 0)", () => {
    assert.deepStrictEqual(badFields("SELECT Id, (SELECT Bogus FROM Contacts) FROM Account"), []);
  });

  it("skips fields inside a WHERE semi-join subquery", () => {
    assert.deepStrictEqual(badFields("SELECT Id FROM Account WHERE Id IN (SELECT Bogus FROM Lead)"), []);
  });

  it("skips function arguments (no false positives)", () => {
    assert.deepStrictEqual(badFields("SELECT COUNT(Bogus) FROM Account"), []);
  });

  it("accepts a relationship root in a dotted path", () => {
    assert.deepStrictEqual(badFields("SELECT Account.Name FROM Account"), []);
    assert.deepStrictEqual(badFields("SELECT Owner.Whatever FROM Account"), []); // deep path not validated
  });

  it("flags an unknown root of a dotted path", () => {
    assert.deepStrictEqual(badFields("SELECT Nope.Name FROM Account"), ["Nope"]);
  });

  it("always allows Id", () => {
    assert.deepStrictEqual(badFields("SELECT Id FROM Account WHERE Id != null"), []);
  });

  it("reports the marker on the right line and column", () => {
    const markers = validateSoqlFields("SELECT Id,\n  Bogus\nFROM Account", fields, rels);
    assert.strictEqual(markers.length, 1);
    assert.strictEqual(markers[0].line, 1);
    assert.strictEqual(markers[0].startCol, 2);
    assert.strictEqual(markers[0].endCol, 7);
  });
});
