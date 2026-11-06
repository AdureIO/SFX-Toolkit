import * as assert from "assert";
import {
  ambientModuleNames,
  labelInsert,
  messageChannelFileBase,
  messageChannelInsert,
  parseSalesforceImport,
  parseSchemaPath,
  relationshipTarget,
  schemaEntries,
} from "../providers/lwcImportItems";

describe("LWC @salesforce import items", () => {
  it("parses the import being typed", () => {
    assert.deepStrictEqual(parseSalesforceImport("import X from '@salesforce/schema/Account.Na"), { kind: "schema", partial: "Account.Na" });
    assert.deepStrictEqual(parseSalesforceImport("import L from \"@salesforce/label/"), { kind: "label", partial: "" });
    assert.strictEqual(parseSalesforceImport("import x from 'lwc'"), null);
  });

  it("label pick right after `label/` inserts c.MyLabel", () => {
    assert.deepStrictEqual(labelInsert("MyLabel", ""), { insertText: "c.MyLabel", filterText: "MyLabel", replaceLength: 0 });
  });

  it("label pick after `label/c.My` replaces the partial without doubling the prefix", () => {
    const ins = labelInsert("MyLabel", "c.My");
    assert.strictEqual(ins.insertText, "c.MyLabel");
    assert.strictEqual(ins.replaceLength, 4);
    assert.strictEqual(ins.filterText, "c.MyLabel");
    assert.strictEqual(labelInsert("MyLabel", "My").filterText, "MyLabel");
  });

  it("message channel modules get __c; definition strips it", () => {
    assert.strictEqual(messageChannelInsert("Record_Selected"), "Record_Selected__c");
    assert.strictEqual(messageChannelInsert("Already__c"), "Already__c");
    assert.strictEqual(messageChannelFileBase("Record_Selected__c"), "Record_Selected");
    assert.strictEqual(messageChannelFileBase("NoSuffix"), "NoSuffix");
  });

  it("parses schema paths (object, field, relationship span)", () => {
    assert.deepStrictEqual(parseSchemaPath("Acc"), { relationships: [], prefix: "Acc" });
    assert.deepStrictEqual(parseSchemaPath("Account."), { object: "Account", relationships: [], prefix: "" });
    assert.deepStrictEqual(parseSchemaPath("Account.Owner.Na"), { object: "Account", relationships: ["Owner"], prefix: "Na" });
  });

  it("builds field + relationship entries and resolves relationship targets", () => {
    const fields = [
      { name: "Name", type: "string", label: "Account Name" },
      { name: "OwnerId", type: "reference", relationshipName: "Owner", referenceTo: ["User"] },
      { name: "Parent__c", type: "reference", relationshipName: "Parent__r", referenceTo: ["Account"] },
    ];
    const e = schemaEntries(fields);
    assert.deepStrictEqual(e.map((x) => [x.name, x.isRelationship]), [["Name", false], ["OwnerId", false], ["Parent__c", false], ["Owner", true], ["Parent__r", true]]);
    assert.strictEqual(e[0].detail, "Account Name · string");
    assert.strictEqual(relationshipTarget(fields, "owner"), "User");
    assert.strictEqual(relationshipTarget(fields, "Parent__r"), "Account");
    assert.strictEqual(relationshipTarget(fields, "Nope"), null);
  });

  it("reads ambient module names from typings (skips wildcards)", () => {
    const dts = `declare module "@salesforce/schema/Account.Id" {\n const Id:any;\n}\ndeclare module '@salesforce/label/c.Hello' {}\ndeclare module "@salesforce/schema/*" {}`;
    assert.deepStrictEqual(ambientModuleNames(dts), ["@salesforce/schema/Account.Id", "@salesforce/label/c.Hello"]);
  });
});
