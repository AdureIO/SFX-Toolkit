import * as assert from "assert";
import {
  typingsForClass,
  declarationFor,
  findAuraEnabledMethods,
  parseApexImport,
  findApexTypeShapes,
  interfacesForShapes,
  apexTypeToTs
} from "../utils/apexAuraMethods";

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

// ── Custom Apex types become real interfaces instead of `any` ────────────────────────────────

const CUSTOM = `
public with sharing class DataSourceController {
    @AuraEnabled(cacheable=true)
    public static PlannerData getEventData(EventQueryParams params) { return null; }

    public class EventQueryParams {
        @AuraEnabled public String objectType;
        @AuraEnabled public Integer pageSize;
        @AuraEnabled public List<String> fields { get; set; }
    }

    public class PlannerData {
        @AuraEnabled public List<EventQueryParams> events;
        @AuraEnabled public Boolean hasMore;
    }
}
`;

describe("apexAuraMethods — custom Apex types", () => {
  const shapes = findApexTypeShapes(CUSTOM);
  const known = new Set(shapes.map((s) => s.name));

  it("finds inner classes and their @AuraEnabled members", () => {
    assert.deepStrictEqual(shapes.map((s) => s.name).sort(), ["EventQueryParams", "PlannerData"]);
    const q = shapes.find((s) => s.name === "EventQueryParams")!;
    assert.deepStrictEqual(q.properties, [
      { type: "String", name: "objectType" },
      { type: "Integer", name: "pageSize" },
      { type: "List<String>", name: "fields" }
    ]);
  });

  it("references the interface instead of collapsing to any", () => {
    assert.strictEqual(apexTypeToTs("EventQueryParams", known), "EventQueryParams");
    assert.strictEqual(apexTypeToTs("List<PlannerData>", known), "PlannerData[]");
    assert.strictEqual(apexTypeToTs("EventQueryParams"), "any", "without the type set it still degrades");
  });

  it("emits the method signature with the real types", () => {
    const dts = typingsForClass("DataSourceController", CUSTOM, known)!;
    assert.ok(dts.includes("param: {params: EventQueryParams}"), dts);
    assert.ok(dts.includes("Promise<PlannerData>"), dts);
  });

  it("emits ambient interfaces with mapped member types", () => {
    const out = interfacesForShapes(shapes);
    assert.ok(out.includes("interface EventQueryParams {"), out);
    assert.ok(out.includes("objectType?: string;"), out);
    assert.ok(out.includes("pageSize?: number;"), out);
    assert.ok(out.includes("fields?: string[];"), out);
    assert.ok(out.includes("events?: EventQueryParams[];"), `nested custom types resolve too:\n${out}`);
    assert.ok(out.includes("hasMore?: boolean;"), out);
  });
});
