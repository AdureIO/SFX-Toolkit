import * as assert from "assert";
import { isProductionOrg } from "../utils/orgSafety";
import type { OrgRecord } from "../utils/orgListCache";

function record(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    username: "user@prod.com",
    isSandbox: false,
    isDevHub: false,
    isScratch: false,
    isDefault: false,
    ...overrides
  };
}

describe("orgSafety.isProductionOrg", () => {
  it("treats non-sandbox non-devhub non-scratch as production", () => {
    assert.strictEqual(isProductionOrg(record({})), true);
  });

  it("does not treat sandboxes as production", () => {
    assert.strictEqual(isProductionOrg(record({ isSandbox: true })), false);
  });

  it("does not treat scratch orgs as production", () => {
    assert.strictEqual(isProductionOrg(record({ isScratch: true })), false);
  });

  it("treats Dev Hubs as production for safety warnings", () => {
    assert.strictEqual(isProductionOrg(record({ isDevHub: true })), true);
  });
});
