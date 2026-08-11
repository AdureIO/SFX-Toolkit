import * as assert from "assert";
import { findAuraEnabledMethods, formatSignature, apexTypeToTs } from "../utils/apexAuraMethods";

const SRC = `
public with sharing class DataSourceController {
    /**
     * Fetches event data for the planner.
     * @param params filter criteria
     */
    @AuraEnabled(cacheable=true)
    public static List<Event> getEventData(Map<String, Object> params) {
        return null;
    }

    @AuraEnabled
    public static void saveAllChanges(PlannerSaveParams plannerSaveParams) { }

    @AuraEnabled(cacheable=true)
    public static Integer getEventDataTotalCount(Map<String, Object> params, Boolean includeArchived) {
        return 0;
    }

    // not exposed
    public static String helper(String a) { return a; }
}
`;

describe("apexAuraMethods.findAuraEnabledMethods", () => {
  const methods = findAuraEnabledMethods(SRC);

  it("finds only @AuraEnabled methods", () => {
    assert.deepStrictEqual(
      methods.map((m) => m.name).sort(),
      ["getEventData", "getEventDataTotalCount", "saveAllChanges"]
    );
  });

  it("captures the real return type and typed parameters", () => {
    const m = methods.find((x) => x.name === "getEventData")!;
    assert.strictEqual(m.returnType, "List<Event>");
    assert.deepStrictEqual(m.params, [{ type: "Map<String, Object>", name: "params" }]);
    assert.strictEqual(formatSignature(m), "List<Event> getEventData(Map<String, Object> params)");
  });

  it("does not split generics on their inner comma", () => {
    const m = methods.find((x) => x.name === "getEventDataTotalCount")!;
    assert.deepStrictEqual(m.params, [
      { type: "Map<String, Object>", name: "params" },
      { type: "Boolean", name: "includeArchived" }
    ]);
  });

  it("tracks the cacheable flag and a void return", () => {
    assert.strictEqual(methods.find((x) => x.name === "getEventData")!.cacheable, true);
    const save = methods.find((x) => x.name === "saveAllChanges")!;
    assert.strictEqual(save.cacheable, false);
    assert.strictEqual(save.returnType, "void");
  });

  it("locates the method for go-to-definition and keeps its ApexDoc", () => {
    const m = methods.find((x) => x.name === "getEventData")!;
    assert.strictEqual(SRC.split("\n")[m.line].includes("getEventData"), true, "line points at the declaration");
    assert.ok(m.doc?.includes("Fetches event data"), "ApexDoc captured");
    assert.ok(m.doc?.includes("@param params"));
  });

  it("ignores commented-out annotations", () => {
    const m = findAuraEnabledMethods(`
      public class C {
        // @AuraEnabled
        // public static String ghost(String a) { return a; }
        /* @AuraEnabled public static String ghost2() { return null; } */
      }`);
    assert.strictEqual(m.length, 0);
  });
});

describe("apexAuraMethods.apexTypeToTs", () => {
  it("maps primitives, collections and unknowns", () => {
    assert.strictEqual(apexTypeToTs("String"), "string");
    assert.strictEqual(apexTypeToTs("Id"), "string");
    assert.strictEqual(apexTypeToTs("Integer"), "number");
    assert.strictEqual(apexTypeToTs("Decimal"), "number");
    assert.strictEqual(apexTypeToTs("Boolean"), "boolean");
    assert.strictEqual(apexTypeToTs("void"), "void");
    assert.strictEqual(apexTypeToTs("List<Account>"), "any[]");
    assert.strictEqual(apexTypeToTs("List<String>"), "string[]");
    assert.strictEqual(apexTypeToTs("Map<String, Object>"), "Record<string, any>");
    assert.strictEqual(apexTypeToTs("Map<Id, List<Contact>>"), "Record<string, any[]>");
    assert.strictEqual(apexTypeToTs("MyCustomType"), "any");
  });
});
