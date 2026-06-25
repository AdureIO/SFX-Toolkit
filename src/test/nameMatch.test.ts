import * as assert from "assert";
import { matchesNamespaceOptional, fuzzyScore } from "../utils/nameMatch";

describe("matchesNamespaceOptional", () => {
  it("matches at the start", () => {
    assert.ok(matchesNamespaceOptional("Account", "acc"));
    assert.ok(matchesNamespaceOptional("Widget__c", "wid"));
    assert.ok(matchesNamespaceOptional("Foo__c", "foo"));
  });
  it("matches right after a namespace boundary", () => {
    assert.ok(matchesNamespaceOptional("acme__Foo__c", "foo"));
    assert.ok(matchesNamespaceOptional("acme__Widget__c", "wid"));
    assert.ok(matchesNamespaceOptional("sfy24__Order_Date__c", "order_date"));
  });
  it("does not match unrelated text", () => {
    assert.ok(!matchesNamespaceOptional("acme__Foo__c", "bar"));
    assert.ok(!matchesNamespaceOptional("Account", "xyz"));
  });
  it("empty prefix matches anything", () => {
    assert.ok(matchesNamespaceOptional("Anything", ""));
  });
  it("does not match a mid-segment substring", () => {
    // 'oo' is inside Foo but not at a start/boundary → no match
    assert.ok(!matchesNamespaceOptional("acme__Foo__c", "oo"));
  });
});

describe("fuzzyScore", () => {
  const obj = "adser__IsvaOrgDim__c";
  it("scores a namespace-optional prefix highest", () => {
    assert.ok(fuzzyScore(obj, "isva") >= 1000);
    assert.ok(fuzzyScore(obj, "adser") >= 1000);
  });
  it("matches a mid-name substring (the reported case)", () => {
    assert.ok(fuzzyScore(obj, "orgdi") > 0, "OrgDi should match");
    assert.ok(fuzzyScore(obj, "dim") > 0, "Dim should match");
  });
  it("matches a subsequence", () => {
    assert.ok(fuzzyScore(obj, "odm") > 0); // O…r…g…D…i…m → o,d,m in order
    assert.ok(fuzzyScore(obj, "iod") > 0);
  });
  it("ranks prefix > substring > subsequence", () => {
    assert.ok(fuzzyScore(obj, "isva") > fuzzyScore(obj, "orgdi"));
    assert.ok(fuzzyScore(obj, "orgdi") > fuzzyScore(obj, "odm"));
  });
  it("returns -1 when characters are absent or out of order", () => {
    assert.strictEqual(fuzzyScore(obj, "xyz"), -1);
    assert.strictEqual(fuzzyScore(obj, "mid"), -1); // m before i,d not in order
  });
  it("empty query scores 0 (keep all)", () => {
    assert.strictEqual(fuzzyScore(obj, ""), 0);
  });
});
