import * as assert from "assert";
import * as path from "path";
import { assignOrgs, distinctOrgs, orgLabelOf, spansMultipleOrgs, summarizeOrgs } from "../utils/perProjectOrg";
import { forceignoreRoot, gitignoreRoot, ignoreEntry, findUpward, type IgnoreEnv } from "../utils/ignoreTargetPure";
import { classTestId, cliTestName, methodTestId, parseTestId } from "../utils/apexTestIds";

describe("perProjectOrg", () => {
	const groups = [{ projectDir: "/ws/a", paths: ["x"] }, { projectDir: "/ws/b", paths: ["y"] }, { projectDir: "/ws/c", paths: ["z"] }];
	const orgs: Record<string, { username: string; displayName: string } | null> = {
		"/ws/a": { username: "a@x.com", displayName: "OrgA" },
		"/ws/b": { username: "b@x.com", displayName: "OrgB" },
		"/ws/c": { username: "a@x.com", displayName: "OrgA" },
	};

	it("gives every group its own project's org", () => {
		const a = assignOrgs(groups, (d) => orgs[d]);
		assert.deepStrictEqual(a.map((x) => x.org.username), ["a@x.com", "b@x.com", "a@x.com"]);
		assert.strictEqual(a[1].group.projectDir, "/ws/b");
	});

	it("summarises distinct orgs and detects a multi-org selection", () => {
		const a = assignOrgs(groups, (d) => orgs[d]);
		assert.strictEqual(distinctOrgs(a).length, 2);
		assert.strictEqual(summarizeOrgs(a), "OrgA, OrgB");
		assert.strictEqual(spansMultipleOrgs(a), true);
		assert.strictEqual(spansMultipleOrgs(assignOrgs([groups[0], groups[2]], (d) => orgs[d])), false);
	});

	it("keeps unresolved orgs as null and labels them generically", () => {
		const a = assignOrgs([groups[0]], () => null);
		assert.strictEqual(a[0].org.username, null);
		assert.strictEqual(orgLabelOf(a[0].org), "default org");
	});
});

describe("ignoreTargetPure", () => {
	const files = new Set(["/repo/.git", "/repo/proj/sfdx-project.json", "/repo/proj/force-app/main/default/classes"]);
	const dirs = new Set(["/repo/proj/force-app/main/default/classes"]);
	const env: IgnoreEnv = { pathApi: path.posix, exists: (p) => files.has(p), isDirectory: (p) => dirs.has(p) };

	it("finds the git root by walking up to .git", () => {
		assert.strictEqual(gitignoreRoot("/repo/proj/force-app/main/default/classes/A.cls", "/repo/proj", env), "/repo");
	});

	it("falls back to the workspace folder when there is no .git", () => {
		assert.strictEqual(gitignoreRoot("/other/x/A.cls", "/other", env), "/other");
		assert.strictEqual(findUpward("/other/x/A.cls", ".git", env), undefined);
	});

	it("puts .forceignore at the project root, else the workspace folder", () => {
		assert.strictEqual(forceignoreRoot("/repo/proj/a.cls", "/repo/proj", "/repo"), "/repo/proj");
		assert.strictEqual(forceignoreRoot("/repo/a.cls", undefined, "/repo"), "/repo");
	});

	it("builds entries relative to the ignore file's directory, folders with a trailing slash", () => {
		assert.strictEqual(ignoreEntry("/repo/proj/force-app/main/default/classes/A.cls", "/repo/proj", env), "force-app/main/default/classes/A.cls");
		assert.strictEqual(ignoreEntry("/repo/proj/force-app/main/default/classes", "/repo", env), "proj/force-app/main/default/classes/");
	});
});

describe("apexTestIds", () => {
	it("ids differ per project for the same class name", () => {
		assert.notStrictEqual(classTestId("/ws/a", "FooTest"), classTestId("/ws/b", "FooTest"));
	});

	it("round-trips class and method ids", () => {
		assert.deepStrictEqual(parseTestId(classTestId("/ws/a", "FooTest")), { projectDir: "/ws/a", className: "FooTest" });
		assert.deepStrictEqual(parseTestId(methodTestId("/ws/a", "FooTest", "works")), { projectDir: "/ws/a", className: "FooTest", method: "works" });
	});

	it("tolerates '::' in the project dir", () => {
		assert.deepStrictEqual(parseTestId(classTestId("/ws/a::b", "T")), { projectDir: "/ws/a::b", className: "T" });
	});

	it("rejects foreign ids and builds CLI names", () => {
		assert.strictEqual(parseTestId("something"), undefined);
		assert.strictEqual(cliTestName(parseTestId(methodTestId("/p", "C", "m"))!), "C.m");
		assert.strictEqual(cliTestName(parseTestId(classTestId("/p", "C"))!), "C");
	});
});
