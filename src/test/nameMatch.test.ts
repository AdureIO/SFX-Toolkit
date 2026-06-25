import * as assert from "assert";
import { matchesNamespaceOptional } from "../utils/nameMatch";

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
