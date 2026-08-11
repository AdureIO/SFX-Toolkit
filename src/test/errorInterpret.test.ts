import * as assert from "assert";
import { interpretError, toRawError } from "../utils/errorInterpret";

describe("errorInterpret — any CLI/command failure", () => {
  it("titles the report after the operation", () => {
    const r = interpretError({ operation: "Create scratch org", raw: "boom" });
    assert.strictEqual(r.title, "Create scratch org failed");
    const many = interpretError({
      operation: "Deploy",
      failures: [{ fullName: "A", problem: "x" }, { fullName: "B", problem: "y" }],
      raw: ""
    });
    assert.strictEqual(many.title, "Deploy failed — 2 problems");
  });

  it("recognises common CLI/environment failures", () => {
    const cases: [string, RegExp][] = [
      ["ERROR running force:org:open: INVALID_SESSION_ID: Session expired or invalid", /session expired/i],
      ["No default target org set for this project", /no target org/i],
      ["connect ECONNREFUSED 52.1.2.3:443", /network/i],
      ["/bin/sh: sf: command not found", /cli not found/i],
      ["This directory is not a valid Salesforce DX project", /sfdx project/i]
    ];
    for (const [raw, expected] of cases) {
      const issue = interpretError({ operation: "Test", raw }).issues[0];
      assert.match(issue.category, expected, raw);
      assert.ok(issue.suggestion, `expected a fix for: ${raw}`);
      assert.strictEqual(issue.problem, raw, "keeps the exact message");
    }
  });

  it("toRawError normalizes Errors, CLI payloads and strings", () => {
    assert.strictEqual(toRawError("plain"), "plain");
    assert.strictEqual(toRawError(new Error("boom")), "boom");
    assert.strictEqual(toRawError({ stderr: "from stderr" }), "from stderr");
    assert.strictEqual(toRawError(undefined), "Unknown error");
  });
});

describe("errorInterpret.interpretError", () => {
  it("interprets an unknown-field component failure and keeps the original", () => {
    const r = interpretError({
      operation: "Push",
      failures: [
        {
          fileName: "classes/AccountService.cls",
          fullName: "AccountService",
          componentType: "ApexClass",
          lineNumber: 42,
          columnNumber: 9,
          problem: "Variable does not exist: Nonexistent__c"
        }
      ],
      raw: "raw output"
    });
    assert.strictEqual(r.issues.length, 1);
    const it = r.issues[0];
    assert.match(it.category, /variable|field/i);
    assert.ok(it.explanation?.includes("Nonexistent__c"), "names the offending symbol");
    assert.ok(it.suggestion && it.suggestion.length > 0, "offers a fix");
    assert.strictEqual(it.problem, "Variable does not exist: Nonexistent__c", "keeps the raw problem");
    assert.strictEqual(it.line, 42);
    assert.strictEqual(r.title, "Push failed");
  });

  it("recognises a source conflict and points at force push", () => {
    const r = interpretError({
      topError: "Conflicts detected between local and remote. Deploy blocked.",
      raw: "Conflicts detected between local and remote. Deploy blocked."
    });
    assert.ok(r.headline && /conflict/i.test(r.headline));
    assert.strictEqual(r.issues.length, 1, "top-level error becomes a single issue when no components failed");
    assert.match(r.issues[0].category, /conflict/i);
    assert.ok(/force push|ignore-conflicts/i.test(r.issues[0].suggestion ?? ""));
  });

  it("flags cascading compile errors distinctly from real ones", () => {
    const r = interpretError({
      failures: [
        { fullName: "A", componentType: "ApexClass", problem: "Dependent class is invalid and needs recompilation." },
        { fullName: "B", componentType: "ApexClass", problem: "No such column 'Foo__c' on entity 'Account'." }
      ],
      raw: ""
    });
    assert.strictEqual(r.issues.length, 2);
    assert.match(r.issues[0].category, /cascad/i);
    assert.match(r.issues[1].category, /field/i);
    assert.ok(r.issues[1].explanation?.includes("Foo__c"));
  });

  it("recovers the exact message + warnings from a CLI JSON error blob", () => {
    const raw = JSON.stringify({
      name: "ExpectedSourceFilesError",
      message: "force-app/main/ICalSubscription/classes/service/ICalExportConstants.cls-meta.xml: Expected source files for type 'ApexClass'",
      exitCode: 1,
      warnings: ["The `pushPackageDirectoriesSequentially` property is not respected by this command."]
    });
    const r = interpretError({ raw });
    assert.strictEqual(r.issues.length, 1, "the top-level CLI error becomes an issue");
    assert.match(r.issues[0].category, /incomplete component/i);
    assert.ok((r.issues[0].explanation ?? "").length > 0);
    assert.ok(r.issues[0].problem.includes("Expected source files"), "keeps the exact message");
    assert.strictEqual(r.issues[0].file, "force-app/main/ICalSubscription/classes/service/ICalExportConstants.cls-meta.xml");
    assert.strictEqual(r.warnings.length, 1, "surfaces the CLI warning");
    assert.ok(r.warnings[0].includes("pushPackageDirectoriesSequentially"));
  });

  it("shows the raw message with no filler for an unrecognised error", () => {
    const r = interpretError({
      failures: [{ fullName: "X", problem: "Some totally novel Salesforce error nobody has seen" }],
      raw: ""
    });
    assert.strictEqual(r.issues.length, 1);
    assert.strictEqual(r.issues[0].category, "Error");
    assert.strictEqual(r.issues[0].explanation, undefined, "no invented explanation");
    assert.ok(r.issues[0].problem.includes("novel"), "the real message is preserved as the content");
    assert.strictEqual(r.headline, undefined, "no vague headline for unrecognised errors");
  });

  it("recognises the isomorphic-git empty-index CLI failure", () => {
    const raw = JSON.stringify({
      name: "InternalError",
      message: "An internal error caused this command to fail. isomorphic-git error:\nIndex file is empty (.git/index)"
    });
    const r = interpretError({ raw });
    assert.strictEqual(r.issues.length, 1);
    assert.match(r.issues[0].category, /git index/i);
    assert.ok(/git reset|\.git\/index/i.test(r.issues[0].suggestion ?? ""), "suggests rebuilding the index");
    assert.ok(r.issues[0].problem.includes("Index file is empty"), "keeps the exact message");
  });
});
