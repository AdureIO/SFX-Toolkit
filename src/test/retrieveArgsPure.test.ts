import * as assert from "assert";
import { buildRetrieveArgs } from "../utils/retrieveEnginePure";

describe("retrieve args", () => {
	it("a normal retrieve into the project has no output dir and does not skip the conflict check", () => {
		assert.deepStrictEqual(buildRetrieveArgs("me@x.org", "metadata", ["ApexClass:A", "Flow:F"]), [
			"project", "retrieve", "start", "--json", "--target-org", "me@x.org", "-m", "ApexClass:A", "-m", "Flow:F",
		]);
		assert.deepStrictEqual(buildRetrieveArgs(null, "path", ["force-app/x"]), ["project", "retrieve", "start", "--json", "-d", "force-app/x"]);
	});
	it("the read-only copy for the content compare goes to --output-dir and ignores tracking conflicts", () => {
		const args = buildRetrieveArgs("me@x.org", "metadata", ["ApexClass:A"], { outputDir: "/cache/stub/run-1", ignoreConflicts: true });
		assert.deepStrictEqual(args, [
			"project", "retrieve", "start", "--json", "--target-org", "me@x.org", "--output-dir", "/cache/stub/run-1", "--ignore-conflicts", "-m", "ApexClass:A",
		]);
	});
});
