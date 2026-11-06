import * as assert from "assert";
import { shouldForwardDiagnostics } from "../utils/diagnosticsFilter";

describe("shouldForwardDiagnostics", () => {
  it("drops asfx-buffer: documents", () => {
    assert.strictEqual(shouldForwardDiagnostics("asfx-buffer:///proj/.vscode/anon-workbench-buffer.apex"), false);
  });
  it("forwards file: documents", () => {
    assert.strictEqual(shouldForwardDiagnostics("file:///proj/force-app/classes/A.cls"), true);
  });
});
