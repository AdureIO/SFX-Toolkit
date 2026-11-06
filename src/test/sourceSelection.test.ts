import * as assert from "assert";
import * as path from "path";
import { buildDeployStartArgs, mapBundleMember, planSelection, type SelectionEnv } from "../utils/sourceSelection";

function env(api: typeof path.posix, projects: Record<string, string[]>, files: string[] = []): SelectionEnv {
	const sep = api.sep;
	return {
		pathApi: api,
		findProjectDir: (p) => {
			let best: string | null = null;
			for (const proj of Object.keys(projects)) {
				if (p.toLowerCase().startsWith((proj + sep).toLowerCase()) && (!best || proj.length > best.length)) best = proj;
			}
			return best;
		},
		packageDirs: (proj) => projects[proj].map((d) => api.join(proj, d)),
		exists: (p) => files.includes(p),
	};
}

describe("sourceSelection (posix)", () => {
	const P = "/ws/proj";
	const e = env(path.posix, { [P]: ["force-app"] }, [`${P}/force-app/main/default/classes/Foo.cls`]);

	it("dedupes and sorts", () => {
		const a = `${P}/force-app/main/default/classes/A.cls`;
		const b = `${P}/force-app/main/default/classes/B.cls`;
		const plan = planSelection([b, a, a], e);
		assert.deepStrictEqual(plan.groups, [{ projectDir: P, paths: [a, b] }]);
	});

	it("collapses paths nested in a selected folder", () => {
		const folder = `${P}/force-app/main/default/classes`;
		const plan = planSelection([`${folder}/A.cls`, folder + "/", `${folder}/sub/B.cls`], e);
		assert.deepStrictEqual(plan.groups[0].paths, [folder]);
	});

	it("does not treat a sibling with the same prefix as nested", () => {
		const a = `${P}/force-app/main/default/classes`;
		const b = `${P}/force-app/main/default/classes2`;
		assert.deepStrictEqual(planSelection([a, b], e).groups[0].paths, [a, b]);
	});

	it("skips paths outside package directories and reports them", () => {
		const readme = `${P}/README.md`;
		const outside = "/elsewhere/x.cls";
		const plan = planSelection([readme, outside, `${P}/force-app/a.cls`], e);
		assert.deepStrictEqual(plan.skipped, [readme, outside]);
		assert.deepStrictEqual(plan.groups[0].paths, [`${P}/force-app/a.cls`]);
	});

	it("returns no groups when everything is skipped", () => {
		assert.deepStrictEqual(planSelection([`${P}/README.md`], e), { groups: [], skipped: [`${P}/README.md`] });
	});

	it("maps -meta.xml onto its content file when it exists, and dedupes the pair", () => {
		const cls = `${P}/force-app/main/default/classes/Foo.cls`;
		const plan = planSelection([`${cls}-meta.xml`, cls], e);
		assert.deepStrictEqual(plan.groups[0].paths, [cls]);
	});

	it("keeps -meta.xml files that have no content file", () => {
		const f = `${P}/force-app/main/default/objects/Acc/fields/X__c.field-meta.xml`;
		assert.deepStrictEqual(planSelection([f], e).groups[0].paths, [f]);
	});

	it("maps LWC and Aura bundle members to the bundle folder", () => {
		const lwc = `${P}/force-app/main/default/lwc/cmp`;
		const aura = `${P}/force-app/main/default/aura/Cmp`;
		const plan = planSelection([`${lwc}/cmp.js`, `${lwc}/__tests__/cmp.test.js`, `${aura}/CmpController.js`], e);
		assert.deepStrictEqual(plan.groups[0].paths, [aura, lwc]);
	});

	it("does not remap the lwc folder or a bundle folder itself", () => {
		const lwcDir = `${P}/force-app/main/default/lwc`;
		assert.strictEqual(mapBundleMember(path.posix, lwcDir), lwcDir);
		assert.strictEqual(mapBundleMember(path.posix, `${lwcDir}/cmp`), `${lwcDir}/cmp`);
		assert.strictEqual(mapBundleMember(path.posix, `${lwcDir}/cmp/cmp.js`), `${lwcDir}/cmp`);
	});

	it("groups per project for nested projects, using the nearest project", () => {
		const outer = "/ws";
		const inner = "/ws/billing";
		const e2 = env(path.posix, { [outer]: ["force-app"], [inner]: ["force-app"] });
		const a = "/ws/force-app/a.cls";
		const b = "/ws/billing/force-app/b.cls";
		const plan = planSelection([b, a], e2);
		assert.deepStrictEqual(plan.groups, [
			{ projectDir: outer, paths: [a] },
			{ projectDir: inner, paths: [b] },
		]);
	});

	it("honours multiple package directories", () => {
		const e2 = env(path.posix, { [P]: ["force-app", "unpackaged/src"] });
		const plan = planSelection([`${P}/unpackaged/src/x.cls`, `${P}/force-app/y.cls`, `${P}/unpackaged/z.cls`], e2);
		assert.deepStrictEqual(plan.groups[0].paths, [`${P}/force-app/y.cls`, `${P}/unpackaged/src/x.cls`]);
		assert.strictEqual(plan.skipped.length, 1);
	});
});

describe("sourceSelection (windows paths)", () => {
	const P = "C:\\ws\\proj";
	const e = env(path.win32, { [P]: ["force-app"] }, [`${P}\\force-app\\classes\\Foo.cls`]);

	it("is case-insensitive and collapses nested paths", () => {
		const plan = planSelection([`${P}\\force-app\\classes`, `C:\\ws\\proj\\FORCE-APP\\classes\\A.cls`], e);
		assert.deepStrictEqual(plan.groups[0].paths, [`${P}\\force-app\\classes`]);
	});

	it("maps bundle members and meta files with backslashes", () => {
		const bundle = `${P}\\force-app\\lwc\\cmp`;
		const plan = planSelection([`${bundle}\\cmp.html`, `${P}\\force-app\\classes\\Foo.cls-meta.xml`], e);
		assert.deepStrictEqual(plan.groups[0].paths, [`${P}\\force-app\\classes\\Foo.cls`, bundle]);
	});

	it("skips outside paths", () => {
		const plan = planSelection([`${P}\\other\\a.cls`], e);
		assert.deepStrictEqual(plan.groups, []);
		assert.strictEqual(plan.skipped.length, 1);
	});
});

describe("buildDeployStartArgs", () => {
	it("builds ONE call with multiple -d, --json and the target org", () => {
		assert.deepStrictEqual(buildDeployStartArgs(["/a", "/b"], "me@org", { json: true }), [
			"project", "deploy", "start", "-d", "/a", "-d", "/b", "--target-org", "me@org", "--json",
		]);
	});
	it("omits org and json when not requested", () => {
		assert.deepStrictEqual(buildDeployStartArgs(["/a"], null), ["project", "deploy", "start", "-d", "/a"]);
	});
});
