import * as assert from "assert";
import {
  extractDeployResult,
  mapLiveStatus,
  isTerminalStatus,
  toApiDeployResult,
  statsFromResult,
  coverageFromResult,
  formatStatus,
  formatElapsed,
  formatResultSummary,
  affectedSchemaObjects,
  componentSuccessList,
  parseRetrievedComponents,
  schemaObjectFromPath,
  type RawDeployResult,
} from "../utils/deployStatusMap";

describe("deployStatusMap.extractDeployResult", () => {
  it("unwraps the `deployResult` envelope", () => {
    const dr = extractDeployResult({ id: "0Af", deployResult: { status: "InProgress" } });
    assert.strictEqual(dr?.status, "InProgress");
  });
  it("accepts a flat result", () => {
    const dr = extractDeployResult({ status: "Succeeded" });
    assert.strictEqual(dr?.status, "Succeeded");
  });
  it("returns null for non-objects", () => {
    assert.strictEqual(extractDeployResult(null), null);
    assert.strictEqual(extractDeployResult("x"), null);
  });
});

describe("deployStatusMap.mapLiveStatus", () => {
  it("maps counts and derives done from a terminal status", () => {
    const dr: RawDeployResult = {
      status: "Succeeded",
      numberComponentsDeployed: 10,
      numberComponentsTotal: 10,
      numberTestsCompleted: 5,
      numberTestsTotal: 5,
    };
    const s = mapLiveStatus(dr);
    assert.strictEqual(s.status, "Succeeded");
    assert.strictEqual(s.componentsDeployed, 10);
    assert.strictEqual(s.testsTotal, 5);
    assert.strictEqual(s.done, true);
  });
  it("honors the explicit done flag while InProgress", () => {
    assert.strictEqual(mapLiveStatus({ status: "InProgress", done: true }).done, true);
    assert.strictEqual(mapLiveStatus({ status: "InProgress" }).done, false);
  });
  it("defaults missing status to Pending and counts to 0", () => {
    const s = mapLiveStatus({});
    assert.strictEqual(s.status, "Pending");
    assert.strictEqual(s.componentsTotal, 0);
    assert.strictEqual(s.done, false);
  });
});

describe("deployStatusMap.isTerminalStatus", () => {
  it("recognizes terminal states", () => {
    for (const s of ["Succeeded", "Failed", "Canceled", "SucceededPartial"]) {
      assert.ok(isTerminalStatus(s), s);
    }
  });
  it("rejects in-flight states", () => {
    for (const s of ["Pending", "InProgress", "Canceling", undefined]) {
      assert.ok(!isTerminalStatus(s as string), String(s));
    }
  });
});

describe("deployStatusMap.toApiDeployResult", () => {
  it("carries component failures through for diagnostics", () => {
    const dr: RawDeployResult = {
      status: "Failed",
      numberComponentErrors: 1,
      details: { componentFailures: [{ fileName: "classes/A.cls", lineNumber: 3, problem: "boom" }] },
    };
    const api = toApiDeployResult(dr);
    assert.strictEqual(api.status, "Failed");
    const failures = api.details?.componentFailures;
    assert.ok(Array.isArray(failures) && failures[0].fileName === "classes/A.cls");
  });
});

describe("deployStatusMap.statsFromResult", () => {
  it("maps completed/errors to passed/failed", () => {
    const stats = statsFromResult({
      numberComponentsDeployed: 7,
      numberComponentErrors: 2,
      numberTestsCompleted: 9,
      numberTestErrors: 1,
    });
    assert.deepStrictEqual(stats, { components: 7, componentErrors: 2, testsPassed: 9, testsFailed: 1 });
  });
});

describe("deployStatusMap.coverageFromResult", () => {
  it("computes covered/pct from locations", () => {
    const rows = coverageFromResult({
      details: { runTestResult: { codeCoverage: [{ name: "A", numLocations: 10, numLocationsNotCovered: 2 }] } },
    });
    assert.deepStrictEqual(rows, [{ name: "A", covered: 8, total: 10, pct: 80 }]);
  });
  it("treats zero-location classes as 100%", () => {
    const rows = coverageFromResult({ details: { runTestResult: { codeCoverage: [{ name: "B", numLocations: 0 }] } } });
    assert.strictEqual(rows[0].pct, 100);
  });
});

describe("deployStatusMap.affectedSchemaObjects (smart refresh)", () => {
  it("returns nothing for a pure Apex/LWC deploy", () => {
    const r = affectedSchemaObjects([
      { componentType: "ApexClass", fullName: "MyController" },
      { componentType: "LightningComponentBundle", fullName: "myCmp" },
    ]);
    assert.deepStrictEqual(r.objects, []);
    assert.strictEqual(r.structural, false);
  });

  it("maps a CustomField to its object, non-structural", () => {
    const r = affectedSchemaObjects([{ componentType: "CustomField", fullName: "Account.Foo__c" }]);
    assert.deepStrictEqual(r.objects, ["Account"]);
    assert.strictEqual(r.structural, false);
  });

  it("marks a CustomObject as structural", () => {
    const r = affectedSchemaObjects([{ componentType: "CustomObject", fullName: "MyObj__c" }]);
    assert.deepStrictEqual(r.objects, ["MyObj__c"]);
    assert.strictEqual(r.structural, true);
  });

  it("dedupes and mixes object + fields", () => {
    const r = affectedSchemaObjects([
      { componentType: "CustomField", fullName: "Account.A__c" },
      { componentType: "CustomField", fullName: "Account.B__c" },
      { componentType: "ApexClass", fullName: "X" },
    ]);
    assert.deepStrictEqual(r.objects, ["Account"]);
    assert.strictEqual(r.structural, false);
  });

  it("reads retrieve-style `type` too", () => {
    const r = affectedSchemaObjects([{ type: "CustomField", fullName: "Contact.C__c" }]);
    assert.deepStrictEqual(r.objects, ["Contact"]);
  });
});

describe("deployStatusMap.componentSuccessList", () => {
  it("normalizes a single object, array, or missing", () => {
    assert.strictEqual(componentSuccessList({}).length, 0);
    assert.strictEqual(componentSuccessList({ details: { componentSuccesses: { fullName: "A" } } }).length, 1);
    assert.strictEqual(componentSuccessList({ details: { componentSuccesses: [{ fullName: "A" }, { fullName: "B" }] } }).length, 2);
  });
});

describe("deployStatusMap.parseRetrievedComponents", () => {
  it("reads result.files", () => {
    const json = JSON.stringify({ result: { files: [{ type: "CustomField", fullName: "Account.X__c" }] } });
    const comps = parseRetrievedComponents(json);
    assert.ok(comps && comps[0].type === "CustomField");
  });
  it("falls back to result.inboundFiles", () => {
    const json = JSON.stringify({ result: { inboundFiles: [{ type: "ApexClass", fullName: "Y" }] } });
    assert.strictEqual(parseRetrievedComponents(json)?.length, 1);
  });
  it("returns null on unparseable output", () => {
    assert.strictEqual(parseRetrievedComponents("not json"), null);
    assert.strictEqual(parseRetrievedComponents(JSON.stringify({ result: {} })), null);
  });
});

describe("deployStatusMap.schemaObjectFromPath", () => {
  it("detects a field file (non-structural)", () => {
    const r = schemaObjectFromPath("/p/force-app/main/default/objects/Account/fields/Foo__c.field-meta.xml");
    assert.deepStrictEqual(r, { object: "Account", structural: false });
  });
  it("detects an object file (structural)", () => {
    const r = schemaObjectFromPath("/p/force-app/main/default/objects/MyObj__c/MyObj__c.object-meta.xml");
    assert.deepStrictEqual(r, { object: "MyObj__c", structural: true });
  });
  it("ignores non-field object sub-metadata", () => {
    assert.strictEqual(schemaObjectFromPath("/p/objects/Account/recordTypes/RT.recordType-meta.xml"), null);
  });
  it("ignores non-schema files", () => {
    assert.strictEqual(schemaObjectFromPath("/p/force-app/main/default/classes/MyClass.cls"), null);
  });
  it("handles Windows separators", () => {
    const r = schemaObjectFromPath("C:\\p\\objects\\Account\\fields\\Bar__c.field-meta.xml");
    assert.deepStrictEqual(r, { object: "Account", structural: false });
  });
});

describe("deployStatusMap.formatElapsed", () => {
  it("formats under a minute as m:ss.d (tenths)", () => {
    assert.strictEqual(formatElapsed(0), "0:00.0");
    assert.strictEqual(formatElapsed(5000), "0:05.0");
    assert.strictEqual(formatElapsed(65000), "1:05.0");
    assert.strictEqual(formatElapsed(23450), "0:23.4");
  });
  it("formats past an hour as h:mm:ss.d", () => {
    assert.strictEqual(formatElapsed(3600_000 + 125_000), "1:02:05.0");
  });
});

describe("deployStatusMap.formatStatus", () => {
  it("shows Canceling verbatim", () => {
    assert.strictEqual(formatStatus(mapLiveStatus({ status: "Canceling" })), "Canceling…");
  });
  it("appends a timer when elapsedMs is present", () => {
    const s = { ...mapLiveStatus({ status: "InProgress", numberComponentsDeployed: 2, numberComponentsTotal: 5 }), elapsedMs: 23000 };
    const msg = formatStatus(s);
    assert.match(msg, /2\/5 components/);
    assert.match(msg, /0:23/);
  });
  it("includes the org stateDetail", () => {
    const msg = formatStatus(mapLiveStatus({ status: "InProgress", stateDetail: "Processing Type: ApexClass" }));
    assert.match(msg, /Processing Type: ApexClass/);
  });
});

describe("deployStatusMap.formatResultSummary", () => {
  it("summarizes components and tests", () => {
    const s = formatResultSummary({
      numberComponentsDeployed: 40, numberComponentsTotal: 40,
      numberTestsCompleted: 20, numberTestsTotal: 20,
    });
    assert.strictEqual(s, "40/40 components · 20/20 tests");
  });
  it("shows component and test errors", () => {
    const s = formatResultSummary({
      numberComponentsDeployed: 38, numberComponentsTotal: 40, numberComponentErrors: 2,
      numberTestsCompleted: 18, numberTestsTotal: 20, numberTestErrors: 2,
    });
    assert.match(s, /38\/40 components \(2 errors\)/);
    assert.match(s, /20\/20 tests \(2 failed\)/);
  });
  it("appends errorStatusCode + errorMessage", () => {
    const s = formatResultSummary({ numberComponentsTotal: 1, errorStatusCode: "INVALID_FIELD", errorMessage: "No such column 'X'" });
    assert.match(s, /INVALID_FIELD: No such column 'X'/);
  });
  it("returns just the error when there are no counts", () => {
    assert.strictEqual(formatResultSummary({ errorStatusCode: "UNKNOWN_EXCEPTION", errorMessage: "boom" }), "UNKNOWN_EXCEPTION: boom");
  });
  it("shows a Deploying line with component progress", () => {
    const msg = formatStatus(mapLiveStatus({ status: "InProgress", numberComponentsDeployed: 3, numberComponentsTotal: 8 }));
    assert.match(msg, /Deploying/);
    assert.match(msg, /3\/8 components/);
  });
  it("switches to Running tests once tests are in flight", () => {
    const msg = formatStatus(mapLiveStatus({ status: "InProgress", numberComponentsDeployed: 8, numberComponentsTotal: 8, numberTestsCompleted: 2, numberTestsTotal: 10 }));
    assert.match(msg, /Running tests/);
    assert.match(msg, /2\/10 tests/);
  });
});
