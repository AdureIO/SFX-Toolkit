import * as assert from "assert";
import { parseSoqlError } from "../utils/soqlError";

describe("parseSoqlError", () => {
  it("extracts message, code and location from a MALFORMED_QUERY", () => {
    const raw = 'HTTP 400: [{"message":"\\nWHERE sfy24__Account__c IN (SELECT Id FROM Contact)\\n     ^\\nERROR at Row:1:Column:102\\nThe selected field \'Id\' in the subquery and the left operand field in the where expression in the outer query \'sfy24__Account__c\' should point to the same object type","errorCode":"MALFORMED_QUERY"}]';
    const p = parseSoqlError(raw);
    assert.strictEqual(p.code, "MALFORMED_QUERY");
    assert.strictEqual(p.line, 1);
    assert.strictEqual(p.column, 102);
    assert.ok(p.message.startsWith("The selected field 'Id'"));
    assert.ok(!p.message.includes("ERROR at Row"));
    assert.ok(!p.message.includes("^"));
  });

  it("extracts INVALID_FIELD with location", () => {
    const raw = 'HTTP 400: [{"message":"\\nSELECT Bogus__c FROM Account\\n       ^\\nERROR at Row:1:Column:8\\nNo such column \'Bogus__c\' on entity \'Account\'.","errorCode":"INVALID_FIELD"}]';
    const p = parseSoqlError(raw);
    assert.strictEqual(p.code, "INVALID_FIELD");
    assert.strictEqual(p.line, 1);
    assert.strictEqual(p.column, 8);
    assert.ok(p.message.startsWith("No such column 'Bogus__c'"));
  });

  it("falls back gracefully without JSON/location", () => {
    const p = parseSoqlError("Something went wrong");
    assert.strictEqual(p.message, "Something went wrong");
    assert.strictEqual(p.line, undefined);
  });

  it("handles a JSON error with no positional preamble", () => {
    const raw = '[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]';
    const p = parseSoqlError(raw);
    assert.strictEqual(p.code, "INVALID_SESSION_ID");
    assert.strictEqual(p.message, "Session expired or invalid");
  });
});
