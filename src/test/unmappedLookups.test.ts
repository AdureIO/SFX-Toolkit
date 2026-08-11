import * as assert from "assert";
import { findUnmappedLookups, ORG_ASSIGNED_LOOKUPS, orgAssignedReason } from "../utils/migrationValidate";

const refMeta = new Map<string, Map<string, string[]>>([
  ["Account", new Map([["ParentId", ["Account"]], ["OwnerId", ["User"]]])],
  ["Contact", new Map([["AccountId", ["Account"]], ["ReportsToId", ["Contact"]], ["Pricebook__c", ["Pricebook2"]]])]
]);

describe("dataMigration.findUnmappedLookups", () => {
  it("flags a lookup whose target object is not in the migration", () => {
    const nodes = [
      { sobject: "Account", includeFields: ["Id", "Name", "ParentId", "OwnerId"] },
      { sobject: "Contact", includeFields: ["Id", "AccountId", "Pricebook__c"] }
    ];
    const out = findUnmappedLookups(nodes, refMeta);
    assert.deepStrictEqual(out, [{ sobject: "Contact", field: "Pricebook__c", referenceTo: ["Pricebook2"] }]);
  });

  it("accepts a self-reference — it is re-linked after insert", () => {
    const out = findUnmappedLookups([{ sobject: "Account", includeFields: ["ParentId"] }], refMeta);
    assert.deepStrictEqual(out, []);
  });

  it("accepts a lookup to another migrated object", () => {
    const nodes = [
      { sobject: "Account", includeFields: ["Id"] },
      { sobject: "Contact", includeFields: ["AccountId"] }
    ];
    assert.deepStrictEqual(findUnmappedLookups(nodes, refMeta), []);
  });

  it("flags AccountId when Account is not included", () => {
    const out = findUnmappedLookups([{ sobject: "Contact", includeFields: ["AccountId"] }], refMeta);
    assert.deepStrictEqual(out, [{ sobject: "Contact", field: "AccountId", referenceTo: ["Account"] }]);
  });

  it("stays quiet about lookups the user can never fix", () => {
    // OwnerId/RecordTypeId/audit fields are never remappable — reporting them would be noise.
    const out = findUnmappedLookups([{ sobject: "Account", includeFields: ["OwnerId"] }], refMeta);
    assert.deepStrictEqual(out, []);
  });
});

describe("dataMigration.ORG_ASSIGNED_LOOKUPS", () => {
  it("covers the lookups the target org fills in itself", () => {
    // Recommending "add User to this migration" for OwnerId is advice nobody can follow —
    // ownership is assigned by the target org, never carried across.
    ["OwnerId", "RecordTypeId", "CreatedById", "LastModifiedById"].forEach((f) => {
      assert.ok(ORG_ASSIGNED_LOOKUPS.has(f.toLowerCase()), `${f} is org-assigned`);
    });
    assert.ok(!ORG_ASSIGNED_LOOKUPS.has("accountid"), "a real lookup stays actionable");
  });

  it("explains each one in its own terms, not as a missing object", () => {
    assert.match(orgAssignedReason("OwnerId"), /assigned by the target org/i);
    assert.match(orgAssignedReason("RecordTypeId"), /target org/i);
    assert.match(orgAssignedReason("CreatedById"), /Audit field/i);
    ["OwnerId", "RecordTypeId", "CreatedById"].forEach((f) => {
      assert.ok(!/add .* to this migration/i.test(orgAssignedReason(f)), `${f} suggests no fix`);
    });
  });
});
