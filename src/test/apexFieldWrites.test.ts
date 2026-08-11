import * as assert from "assert";
import { findFieldWrites, isApexTestClass, findApexCalls } from "../utils/apexFieldWrites";

const has = (writes: { object: string; field: string }[], object: string, field: string) =>
  writes.some((w) => w.object === object && w.field === field);

describe("apexFieldWrites.findFieldWrites", () => {
  it("finds assignment writes when the receiver type is known", () => {
    const body = `
      public class AccountService {
        public void touch() {
          Account acc = new Account();
          acc.Name = 'x';
          acc.Rating = 'Hot';
          update acc;
        }
      }`;
    const w = findFieldWrites(body);
    assert.ok(has(w, "Account", "Name"));
    assert.ok(has(w, "Account", "Rating"));
  });

  it("reads constructor named args as writes", () => {
    const w = findFieldWrites(`Contact c = new Contact(FirstName = 'A', Email = 'a@b.c');`);
    assert.ok(has(w, "Contact", "FirstName"));
    assert.ok(has(w, "Contact", "Email"));
  });

  it("handles for-each loop element types and dynamic put()", () => {
    const body = `
      for (Opportunity o : opps) {
        o.StageName = 'Closed Won';
        o.put('Amount', 100);
      }`;
    const w = findFieldWrites(body);
    assert.ok(has(w, "Opportunity", "StageName"));
    assert.ok(has(w, "Opportunity", "Amount"));
  });

  it("uses the trigger's object for Trigger.new loop variables", () => {
    const body = `for (Account a : Trigger.new) { a.Description = 'set'; }`;
    const w = findFieldWrites(body, { defaultObject: "Account" });
    assert.ok(has(w, "Account", "Description"));
  });

  it("does not record a write when the receiver type is unknown", () => {
    const w = findFieldWrites(`something.Mystery__c = 5;`);
    assert.strictEqual(w.length, 0, "no type for `something` → no invented object");
  });

  it("detects test classes so their setup writes can be skipped", () => {
    assert.ok(isApexTestClass("@isTest\npublic class FooTest { }"));
    assert.ok(isApexTestClass("public class Bar { static testMethod void t() {} }"));
    assert.ok(!isApexTestClass("public class AccountService { void m() {} }"));
  });

  it("finds calls to other known Apex classes (static + constructor), skipping stdlib and self", () => {
    const known = new Set(["Handler", "OwnerService", "Util"]);
    const body = `
      public class Handler {
        void run() {
          OwnerService.assign(acc);         // static call
          Util u = new Util();              // constructor
          System.debug('x');                // stdlib → skipped
          Handler.selfHelper();             // self → skipped
        }
      }`;
    const calls = findApexCalls(body, known, "Handler");
    assert.deepStrictEqual(calls.sort(), ["OwnerService", "Util"]);
  });

  it("ignores comparisons and strings/comments", () => {
    const body = `
      // acc.Ghost = 'no';
      Account acc = new Account();
      if (acc.Rating == 'Hot') { String s = 'acc.Fake = 1'; }`;
    const w = findFieldWrites(body);
    assert.ok(!has(w, "Account", "Ghost"), "commented write ignored");
    assert.ok(!has(w, "Account", "Rating"), "comparison is not a write");
    assert.ok(!has(w, "Account", "Fake"), "write inside a string ignored");
  });
});
