import * as assert from "assert";
import * as path from "path";
import { buildUpdateSummary, isNotFoundFailure, resolvePackageDirPaths } from "../utils/updateProjectPure";

describe("updateProjectPure", () => {
	it("resolves absolute, existing, unique package dirs", () => {
		const root = path.join(path.sep, "p");
		const ok = new Set([path.join(root, "force-app"), path.join(root, "x")]);
		assert.deepStrictEqual(
			resolvePackageDirPaths(root, ["force-app", "gone", "force-app", "x"], (p) => ok.has(p)),
			[path.join(root, "force-app"), path.join(root, "x")]
		);
	});
	it("detects not-found failures", () => {
		assert.ok(isNotFoundFailure("No source-backed components present in the org"));
		assert.ok(!isNotFoundFailure("Insufficient access"));
	});
	it("builds summaries", () => {
		assert.strictEqual(buildUpdateSummary("Org", 5, []).text, "Updated 5 components from Org.");
		const s = buildUpdateSummary("Org", 5, [{ error: "Component not found" }, { error: "Component not found" }, { error: "boom" }]);
		assert.strictEqual(s.text, "Updated 5 components from Org; 2 components no longer exist in the org; 1 failed.");
		assert.ok(s.hasRealFailures);
		assert.strictEqual(buildUpdateSummary("Org", 1, [{ error: "not found" }]).text, "Updated 1 components from Org; 1 component no longer exists in the org.");
	});
});
