import * as assert from "assert";
import {
  STUB_MARKER,
  apexTypeForField,
  isCustomObject,
  buildTypeOnlyStub,
  buildFullStub,
  augmentExistingStub,
  collectUsedObjectsFromTexts,
} from "../utils/sobjectStubSync";

describe("sobjectStubSync (pure helpers)", () => {
  it("maps Salesforce field types to Apex types", () => {
    assert.strictEqual(apexTypeForField("reference", { name: "AccountId", type: "reference" }), "Id");
    assert.strictEqual(apexTypeForField("currency", { name: "Amt", type: "currency" }), "Decimal");
    assert.strictEqual(apexTypeForField("picklist", { name: "St", type: "picklist" }), "String");
    assert.strictEqual(apexTypeForField("datetime", { name: "When", type: "datetime" }), "Datetime");
  });

  it("classifies custom / namespaced objects", () => {
    assert.ok(isCustomObject("sfy24__ProductionOrder__c"));
    assert.ok(isCustomObject("My_Setting__mdt"));
    assert.ok(isCustomObject("sfy24__Thing__e"));
    assert.ok(!isCustomObject("Account"));
    assert.ok(!isCustomObject("Contact"));
  });

  it("builds a marked type-only stub", () => {
    const s = buildTypeOnlyStub("My_Setting__mdt");
    assert.ok(s.startsWith(STUB_MARKER));
    assert.ok(/global class My_Setting__mdt \{\s*\}/.test(s));
  });

  it("builds a full stub with fields and relationships", () => {
    const s = buildFullStub("Contact", {
      name: "Contact",
      label: "Contact",
      fields: [
        { name: "Id", type: "id" },
        { name: "AccountId", type: "reference", relationshipName: "Account", referenceTo: ["Account"] },
        { name: "sfy24__Score__c", type: "double", label: "Score" },
      ],
      childRelationships: [{ name: "Cases", childSObject: "Case" }],
    });
    assert.ok(s.startsWith(STUB_MARKER));
    assert.ok(s.includes("global Id Id;"));
    assert.ok(s.includes("global Id AccountId;"));
    assert.ok(s.includes("global Account Account;"));
    assert.ok(s.includes("global Decimal sfy24__Score__c;"));
    assert.ok(s.includes("global List<Case> Cases;"));
  });

  it("extends a Salesforce-generated stub with missing fields, preserving its content", () => {
    const sfStub = "global class Account {\n    global Id Id;\n    global String Name;\n}\n";
    const d = {
      name: "Account",
      fields: [
        { name: "Id", type: "id" },                       // already declared
        { name: "Name", type: "string" },                 // already declared
        { name: "sfy24__Region__c", type: "picklist", label: "Region" }, // missing
      ],
      childRelationships: [{ name: "Contacts", childSObject: "Contact" }], // missing
    };
    const out = augmentExistingStub(sfStub, d);
    assert.ok(out.includes("global String Name;"), "preserves Salesforce content");
    assert.ok(out.includes("ASFX-AUGMENTED-START"));
    assert.ok(out.includes("global String sfy24__Region__c;"), "adds missing field");
    assert.ok(out.includes("global List<Contact> Contacts;"), "adds missing child relationship");
    assert.ok(!/Id;[\s\S]*global Id Id;/.test(out), "does not duplicate existing fields");

    // Idempotent: re-augmenting replaces the region rather than stacking it.
    const twice = augmentExistingStub(out, d);
    const count = (twice.match(/ASFX-AUGMENTED-START/g) || []).length;
    assert.strictEqual(count, 1, "single region after re-sync");
  });

  it("detects used objects, including namespace-optional references", () => {
    const objectNames = ["Account", "sfy24__ProductionOrder__c", "Unused__c"];
    const texts = [
      "public class C { void m() { Account a; List<sfy24__ProductionOrder__c> p; ProductionOrder__c q; } }",
    ];
    const used = collectUsedObjectsFromTexts(texts, objectNames, "sfy24");
    assert.ok(used.has("Account"));
    assert.ok(used.has("sfy24__ProductionOrder__c"), "matched full and un-prefixed references");
    assert.ok(!used.has("Unused__c"));
  });
});
