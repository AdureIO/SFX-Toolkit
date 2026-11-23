import * as assert from "assert";
import * as path from "path";
import {
	DiscoveryFs,
	discoverProjects,
	isProjectMarkerPath,
	projectOfFileIn,
	sameProjects,
	selectActiveProjectIn,
} from "../utils/projectDiscoveryPure";

/** In-memory tree: `files` are absolute file paths; directories are derived. `mdapi` lists MDAPI dirs. */
function fakeFs(files: string[], mdapi: string[] = []): DiscoveryFs & { reads: string[] } {
	const set = new Set(files);
	const dirs = new Map<string, Set<string>>();
	const add = (parent: string, child: string) => {
		if (!dirs.has(parent)) dirs.set(parent, new Set());
		dirs.get(parent)!.add(child);
	};
	for (const f of files) {
		let cur = f;
		for (;;) {
			const parent = path.dirname(cur);
			if (parent === cur) break;
			if (cur !== f) add(parent, path.basename(cur));
			cur = parent;
		}
	}
	const reads: string[] = [];
	return {
		reads,
		readdir: (d) => {
			reads.push(d);
			return [...(dirs.get(d) ?? [])];
		},
		exists: (p) => set.has(p),
		isMdapiFolder: (d) => mdapi.includes(d),
	};
}

const W = path.join(path.sep, "w");
const p = (...s: string[]) => path.join(W, ...s);

describe("discoverProjects", () => {
	it("finds a project at the workspace root and does not look inside it", () => {
		const fsx = fakeFs([p("sfdx-project.json"), p("pkg", "sfdx-project.json"), p("pkg", "x", "sfdx-project.json")]);
		const found = discoverProjects([W], fsx);
		assert.deepStrictEqual(found.map((f) => f.dir), [W]);
		assert.strictEqual(found[0].kind, "sfdx");
		assert.strictEqual(found[0].name, "w");
		assert.strictEqual(found[0].workspaceFolder, W);
		assert.deepStrictEqual(fsx.reads, [], "no scan below a found project");
	});

	it("finds projects at depth 1 and 2 but not at depth 3", () => {
		const fsx = fakeFs([
			p("a", "sfdx-project.json"),
			p("b", "c", "sfdx-project.json"),
			p("d", "e", "f", "sfdx-project.json"),
		]);
		const found = discoverProjects([W], fsx);
		assert.deepStrictEqual(found.map((f) => f.name), ["a", "b/c"]);
	});

	it("skips dot folders and build/vendor folders", () => {
		const files = ["node_modules", "out", "dist", "build", "target", "vendor", "bin", "obj", "coverage", "tmp", ".hidden"].map((n) =>
			p(n, "sfdx-project.json")
		);
		files.push(p("real", "sfdx-project.json"));
		assert.deepStrictEqual(discoverProjects([W], fakeFs(files)).map((f) => f.name), ["real"]);
	});

	it("detects MDAPI projects and prefers SFDX when both markers are present", () => {
		const fsx = fakeFs([p("m", "src", "package.xml"), p("s", "sfdx-project.json"), p("s", "src", "package.xml")], [p("m"), p("s")]);
		const found = discoverProjects([W], fsx);
		assert.deepStrictEqual(found.map((f) => [f.name, f.kind]), [["m", "mdapi"], ["s", "sfdx"]]);
	});

	it("does not descend into a found MDAPI project", () => {
		const fsx = fakeFs([p("m", "src", "package.xml"), p("m", "inner", "sfdx-project.json")], [p("m")]);
		assert.deepStrictEqual(discoverProjects([W], fsx).map((f) => f.name), ["m"]);
	});

	it("orders by workspace-folder order, then path", () => {
		const W2 = path.join(path.sep, "z");
		const fsx = fakeFs([p("b", "sfdx-project.json"), p("a", "sfdx-project.json"), path.join(W2, "a", "sfdx-project.json")]);
		const found = discoverProjects([W2, W], fsx);
		assert.deepStrictEqual(found.map((f) => f.dir), [path.join(W2, "a"), p("a"), p("b")]);
		assert.strictEqual(found[0].workspaceFolder, W2);
	});

	it("de-duplicates overlapping workspace folders", () => {
		const fsx = fakeFs([p("a", "sfdx-project.json")]);
		assert.deepStrictEqual(discoverProjects([W, p("a")], fsx).map((f) => f.dir), [p("a")]);
	});

	it("honours a custom depth", () => {
		const fsx = fakeFs([p("a", "b", "c", "sfdx-project.json")]);
		assert.strictEqual(discoverProjects([W], fsx, 2).length, 0);
		assert.strictEqual(discoverProjects([W], fsx, 3).length, 1);
	});
});

describe("projectOfFileIn / selectActiveProjectIn", () => {
	const fsx = fakeFs([p("a", "sfdx-project.json"), p("a", "nested", "sfdx-project.json"), p("b", "sfdx-project.json")]);
	// discovery never nests, so build a nested list by hand to test "deepest wins"
	const list = [
		{ dir: p("a"), kind: "sfdx" as const, name: "a", workspaceFolder: W },
		{ dir: p("a", "nested"), kind: "sfdx" as const, name: "a/nested", workspaceFolder: W },
		{ dir: p("b"), kind: "sfdx" as const, name: "b", workspaceFolder: W },
	];

	it("the deepest containing project wins", () => {
		assert.strictEqual(projectOfFileIn(list, p("a", "nested", "force-app", "X.cls"))?.name, "a/nested");
		assert.strictEqual(projectOfFileIn(list, p("a", "force-app", "X.cls"))?.name, "a");
		assert.strictEqual(projectOfFileIn(list, p("c", "X.cls")), undefined);
	});

	it("does not match a sibling that only shares a name prefix", () => {
		assert.strictEqual(projectOfFileIn(list, p("ab", "X.cls")), undefined);
	});

	it("active: editor file, then last persisted, then first", () => {
		const projects = discoverProjects([W], fsx);
		assert.strictEqual(selectActiveProjectIn(projects, p("b", "x.cls"), p("a"))?.name, "b");
		assert.strictEqual(selectActiveProjectIn(projects, p("elsewhere", "x.cls"), p("b"))?.name, "b");
		assert.strictEqual(selectActiveProjectIn(projects, undefined, p("b"))?.name, "b");
		assert.strictEqual(selectActiveProjectIn(projects, undefined, p("gone"))?.name, "a");
		assert.strictEqual(selectActiveProjectIn(projects, undefined, undefined)?.name, "a");
		assert.strictEqual(selectActiveProjectIn([], p("b", "x.cls"), p("b")), undefined);
	});
});

describe("sameProjects / isProjectMarkerPath", () => {
	it("compares project lists by dir, kind and name", () => {
		const a = [{ dir: "/x", kind: "sfdx" as const, name: "x", workspaceFolder: "/" }];
		assert.strictEqual(sameProjects(a, [{ ...a[0] }]), true);
		assert.strictEqual(sameProjects(a, [{ ...a[0], kind: "mdapi" }]), false);
		assert.strictEqual(sameProjects(a, []), false);
	});

	it("only marker files within the discovery depth can change discovery", () => {
		assert.strictEqual(isProjectMarkerPath(["sfdx-project.json"]), true);
		assert.strictEqual(isProjectMarkerPath(["a", "b", "sfdx-project.json"]), true);
		assert.strictEqual(isProjectMarkerPath(["a", "b", "c", "sfdx-project.json"]), false);
		assert.strictEqual(isProjectMarkerPath(["src", "package.xml"]), true);
		assert.strictEqual(isProjectMarkerPath(["a", "b", "src", "package.xml"]), true);
		assert.strictEqual(isProjectMarkerPath(["a", "b", "c", "src", "package.xml"]), false);
		assert.strictEqual(isProjectMarkerPath(["package.xml"]), false, "not under src/");
		assert.strictEqual(isProjectMarkerPath(["manifest", "package.xml"]), false);
		assert.strictEqual(isProjectMarkerPath(["node_modules", "x", "sfdx-project.json"]), false);
		assert.strictEqual(isProjectMarkerPath([".git", "sfdx-project.json"]), false);
		assert.strictEqual(isProjectMarkerPath(["a", "other.json"]), false);
	});
});
