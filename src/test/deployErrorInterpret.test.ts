import * as assert from "assert";
import { interpretDeployFailure } from "../utils/deployErrorInterpret";

describe("deployErrorInterpret.interpretDeployFailure", () => {
  it("interprets an unknown-field component failure and keeps the original", () => {
    const r = interpretDeployFailure({
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
    assert.strictEqual(r.title, "Push failed — 1 problem");
  });

  it("recognises a source conflict and points at force push", () => {
    const r = interpretDeployFailure({
      topError: "Conflicts detected between local and remote. Deploy blocked.",
      raw: "Conflicts detected between local and remote. Deploy blocked."
    });
    assert.ok(r.headline && /conflict/i.test(r.headline));
    assert.strictEqual(r.issues.length, 1, "top-level error becomes a single issue when no components failed");
    assert.match(r.issues[0].category, /conflict/i);
    assert.ok(/force push|ignore-conflicts/i.test(r.issues[0].suggestion ?? ""));
  });

  it("flags cascading compile errors distinctly from real ones", () => {
    const r = interpretDeployFailure({
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
    const r = interpretDeployFailure({ raw });
    assert.strictEqual(r.issues.length, 1, "the top-level CLI error becomes an issue");
    assert.match(r.issues[0].category, /incomplete component/i);
    assert.ok((r.issues[0].explanation ?? "").length > 0);
    assert.ok(r.issues[0].problem.includes("Expected source files"), "keeps the exact message");
    assert.strictEqual(r.issues[0].file, "force-app/main/ICalSubscription/classes/service/ICalExportConstants.cls-meta.xml");
    assert.strictEqual(r.warnings.length, 1, "surfaces the CLI warning");
    assert.ok(r.warnings[0].includes("pushPackageDirectoriesSequentially"));
  });

  it("shows the raw message with no filler for an unrecognised error", () => {
    const r = interpretDeployFailure({
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
    const r = interpretDeployFailure({ raw });
    assert.strictEqual(r.issues.length, 1);
    assert.match(r.issues[0].category, /git index/i);
    assert.ok(/git reset|\.git\/index/i.test(r.issues[0].suggestion ?? ""), "suggests rebuilding the index");
    assert.ok(r.issues[0].problem.includes("Index file is empty"), "keeps the exact message");
  });
});
