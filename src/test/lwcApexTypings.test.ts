import * as assert from "assert";
import { typingsForClass, declarationFor, findAuraEnabledMethods, parseApexImport } from "../utils/apexAuraMethods";

const SRC = `
public class DataSourceController {
    /** Fetches event data. */
    @AuraEnabled(cacheable=true)
    public static List<Event> getEventData(Map<String, Object> params) { return null; }

    @AuraEnabled
    public static void saveAllChanges(String payload, Integer version) { }

    @AuraEnabled
    public static Boolean ping() { return true; }
}
`;

describe("lwcApexTypings", () => {
  it("emits the module name LWC imports, with real types instead of any", () => {
    const dts = typingsForClass("DataSourceController", SRC)!;
    assert.ok(dts.includes('declare module "@salesforce/apex/DataSourceController.getEventData"'));
    // List<Event> → any[], Map<String,Object> → Record<string, any>
    assert.ok(dts.includes("param: {params: Record<string, any>}"), dts);
    assert.ok(dts.includes("Promise<any[]>"), dts);
  });

  it("maps multiple params and keeps their names", () => {
    const m = findAuraEnabledMethods(SRC).find((x) => x.name === "saveAllChanges")!;
    const d = declarationFor("DataSourceController", m);
    assert.ok(d.includes("param: {payload: string, version: number}"), d);
    assert.ok(d.includes("Promise<void>"), d);
  });

  it("emits no parameter object for a no-arg method", () => {
    const m = findAuraEnabledMethods(SRC).find((x) => x.name === "ping")!;
    const d = declarationFor("DataSourceController", m);
    assert.ok(/export default function ping\(\): Promise<boolean>;/.test(d), d);
  });

  it("documents the Apex signature and the cacheable flag", () => {
    const m = findAuraEnabledMethods(SRC).find((x) => x.name === "getEventData")!;
    const d = declarationFor("DataSourceController", m);
    assert.ok(d.includes("List<Event> getEventData(Map<String, Object> params)"), d);
    assert.ok(d.includes("cacheable"), d);
    assert.ok(d.includes("Fetches event data."), d);
  });

  it("skips classes with no @AuraEnabled methods", () => {
    assert.strictEqual(typingsForClass("Plain", "public class Plain { public static void x() {} }"), undefined);
  });
});

describe("apexAuraMethods.parseApexImport", () => {
  it("parses class and method from the import specifier", () => {
    assert.deepStrictEqual(parseApexImport("@salesforce/apex/DataSourceController.getEventData"), {
      className: "DataSourceController",
      methodName: "getEventData"
    });
  });

  it("supports a namespaced class", () => {
    assert.deepStrictEqual(parseApexImport("@salesforce/apex/ns.Ctrl.doWork"), {
      className: "ns.Ctrl",
      methodName: "doWork"
    });
  });

  it("ignores non-apex module specifiers", () => {
    assert.strictEqual(parseApexImport("lightning/navigation"), undefined);
    assert.strictEqual(parseApexImport("@salesforce/schema/Account.Name"), undefined);
  });
});
