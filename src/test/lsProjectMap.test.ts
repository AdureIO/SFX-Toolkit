import * as assert from "assert";
import { buildProjectMap, partitionKey } from "../utils/lsProjectMap";

describe("lsProjectMap (host → server project map)", () => {
	const projects = [
		{ dir: "/w/a", kind: "sfdx" as const, name: "a" },
		{ dir: "/w/b", kind: "sfdx" as const, name: "b" },
		{ dir: "/w/m", kind: "mdapi" as const, name: "m" },
	];
	const orgs: Record<string, string> = { "/w/a": "u1@x.com", "/w/b": "u1@x.com", "/w/m": "__default__", "/w/deep": "u2@x.com" };

	it("keys partitions by the default org, or by directory when none resolves", () => {
		assert.strictEqual(partitionKey("u@x.com", "/d"), "org:u@x.com");
		assert.strictEqual(partitionKey("__default__", "/d"), "dir:/d");
		const m = buildProjectMap({ projects, orgKeyOf: (d) => orgs[d], namespaceOf: (d) => (d === "/w/a" ? "nsa" : null) });
		assert.deepStrictEqual(m.projects.map((p) => p.partition), ["org:u1@x.com", "org:u1@x.com", "dir:/w/m"]);
		assert.deepStrictEqual(m.projects.map((p) => p.namespace), ["nsa", null, null]);
	});

	it("adds nested SFDX projects the registry does not list, once", () => {
		const m = buildProjectMap({ projects, extraDirs: ["/w/deep", "/w/a"], orgKeyOf: (d) => orgs[d], namespaceOf: () => null });
		assert.deepStrictEqual(m.projects.map((p) => p.dir), ["/w/a", "/w/b", "/w/m", "/w/deep"]);
		assert.strictEqual(m.projects[3].partition, "org:u2@x.com");
	});

	it("pins workbench buffers to their org override, else to the active project", () => {
		const m = buildProjectMap({
			projects,
			activeDir: "/w/b",
			orgKeyOf: (d) => orgs[d],
			namespaceOf: () => null,
			buffers: [
				{ uri: "asfx-buffer:///1", overrideOrgKey: "other@x.com" },
				{ uri: "asfx-buffer:///2" },
				{ uri: "asfx-buffer:///3", overrideOrgKey: "__default__" },
			],
		});
		assert.deepStrictEqual(m.buffers, {
			"asfx-buffer:///1": "org:other@x.com",
			"asfx-buffer:///2": "org:u1@x.com",
			"asfx-buffer:///3": "org:u1@x.com",
		});
		assert.strictEqual(m.activeDir, "/w/b");
	});
});
