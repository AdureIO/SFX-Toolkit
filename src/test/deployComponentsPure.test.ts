import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	RelComponent,
	deployPathsForComponents,
	nameOfComponentKey,
	pathsToComponents,
	presetComponents,
	relativeFilesOf,
	typeOfComponentKey,
} from "../utils/deployComponentsPure";
import { LocalIndex, scanProject } from "../utils/orgBrowser/localIndex";
import { splitByVisibility } from "../utils/orgBrowser/selection";

function touch(root: string, rel: string, content = "x"): void {
	const f = path.join(root, rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, content);
}

describe("deploy components: selection → deploy arguments", () => {
	let root: string;
	let index: LocalIndex;
	const D = "force-app/main/default";

	before(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-deploy-"));
		for (const n of ["A", "B", "C"]) {
			touch(root, `${D}/classes/${n}.cls`);
			touch(root, `${D}/classes/${n}.cls-meta.xml`);
		}
		touch(root, `${D}/lwc/hello/hello.js`);
		touch(root, `${D}/lwc/hello/hello.html`);
		touch(root, `${D}/lwc/hello/hello.js-meta.xml`);
		touch(root, `${D}/lwc/other/other.js`);
		touch(root, `${D}/lwc/other/other.js-meta.xml`);
		touch(root, `${D}/objects/Acme__c/Acme__c.object-meta.xml`);
		touch(root, `${D}/objects/Acme__c/fields/Name__c.field-meta.xml`);
		touch(root, `${D}/reports/Sales/Q1.report-meta.xml`);
		touch(root, `${D}/reports/Sales/Q2.report-meta.xml`);
		index = await scanProject(root, ["force-app"]);
	});
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	const rel = (paths: string[]) => paths.map((p) => path.relative(root, p).split(path.sep).join("/"));

	it("a ticked component deploys exactly its own files, never its folder or its siblings", () => {
		const r = deployPathsForComponents(["ApexClass:A"], index.entries);
		assert.deepStrictEqual(rel(r.paths), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`]);
		assert.deepStrictEqual(r.missing, []);
	});

	it("every argument is a file: no folder path ever enters the deploy command", () => {
		const keys = [...index.entries.keys()];
		const r = deployPathsForComponents(keys, index.entries);
		for (const p of r.paths) assert.ok(fs.statSync(p).isFile(), p);
		// all of the project's files, each once
		assert.strictEqual(new Set(r.paths).size, r.paths.length);
	});

	it("selecting all classes but one never pulls in the unselected one (the old 'whole directory is pushed' bug)", () => {
		const r = deployPathsForComponents(["ApexClass:A", "ApexClass:C"], index.entries);
		assert.deepStrictEqual(rel(r.paths), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`, `${D}/classes/C.cls`, `${D}/classes/C.cls-meta.xml`]);
	});

	it("a bundle deploys its own files only; another bundle in the same folder is untouched", () => {
		const r = deployPathsForComponents(["LightningComponentBundle:hello"], index.entries);
		assert.deepStrictEqual(rel(r.paths), [`${D}/lwc/hello/hello.html`, `${D}/lwc/hello/hello.js`, `${D}/lwc/hello/hello.js-meta.xml`]);
	});

	it("an object does not drag its fields along, a field does not drag its object; folder types keep to their report", () => {
		assert.deepStrictEqual(rel(deployPathsForComponents(["CustomObject:Acme__c"], index.entries).paths), [`${D}/objects/Acme__c/Acme__c.object-meta.xml`]);
		assert.deepStrictEqual(rel(deployPathsForComponents(["CustomField:Acme__c.Name__c"], index.entries).paths), [`${D}/objects/Acme__c/fields/Name__c.field-meta.xml`]);
		assert.deepStrictEqual(rel(deployPathsForComponents(["Report:Sales/Q1"], index.entries).paths), [`${D}/reports/Sales/Q1.report-meta.xml`]);
	});

	it("hidden selections are deployed when the user says so, and dropped when they ask for the visible ones only", () => {
		const selected = ["ApexClass:A", "ApexClass:B", "Flow:Gone"];
		const visible = new Set(["ApexClass:A", "ApexClass:C"]);
		const { visible: vis, hidden } = splitByVisibility(selected, visible);
		assert.deepStrictEqual(hidden, ["ApexClass:B", "Flow:Gone"]);
		// "Deploy all": hidden ones are included, explicitly (and unknown keys are reported, not guessed)
		const all = deployPathsForComponents(selected, index.entries);
		assert.deepStrictEqual(rel(all.paths), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`, `${D}/classes/B.cls`, `${D}/classes/B.cls-meta.xml`]);
		assert.deepStrictEqual(all.missing, ["Flow:Gone"]);
		// "Deploy visible only": the visible selected ones, nothing else (C is visible but not selected)
		assert.deepStrictEqual(rel(deployPathsForComponents(vis, index.entries).paths), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`]);
	});

	it("keys are de-duplicated and paths sorted", () => {
		const r = deployPathsForComponents(["ApexClass:B", "ApexClass:A", "ApexClass:B"], index.entries);
		assert.deepStrictEqual(rel(r.paths), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`, `${D}/classes/B.cls`, `${D}/classes/B.cls-meta.xml`]);
	});

	it("relativeFilesOf gives the project-relative files written next to a saved preset", () => {
		assert.deepStrictEqual(relativeFilesOf(["ApexClass:A"], index.entries, root), [`${D}/classes/A.cls`, `${D}/classes/A.cls-meta.xml`]);
	});

	it("key helpers", () => {
		assert.strictEqual(typeOfComponentKey("CustomField:Account.Foo__c"), "CustomField");
		assert.strictEqual(nameOfComponentKey("CustomField:Account.Foo__c"), "Account.Foo__c");
		assert.strictEqual(nameOfComponentKey("Report:Sales/Q1"), "Sales/Q1");
	});
});

describe("deploy components: paths → components (presets, git)", () => {
	const comps: RelComponent[] = [
		{ key: "ApexClass:A", files: ["force-app/main/default/classes/A.cls", "force-app/main/default/classes/A.cls-meta.xml"] },
		{ key: "ApexClass:B", files: ["force-app/main/default/classes/B.cls", "force-app/main/default/classes/B.cls-meta.xml"] },
		{ key: "LightningComponentBundle:hello", files: ["force-app/main/default/lwc/hello/hello.js", "force-app/main/default/lwc/hello/hello.html"] },
		{ key: "Flow:F", files: ["force-app/main/default/flows/F.flow-meta.xml"] },
		{ key: "ApexClass:Other", files: ["other-pkg/main/classes/Other.cls"] },
	];

	it("a file path maps to its component, whichever of its files it names", () => {
		assert.deepStrictEqual(pathsToComponents(["force-app/main/default/classes/A.cls-meta.xml"], comps).keys, ["ApexClass:A"]);
		assert.deepStrictEqual(pathsToComponents(["force-app/main/default/classes/A.cls", "force-app/main/default/classes/A.cls-meta.xml"], comps).keys, ["ApexClass:A"]);
	});

	it("a file inside a bundle maps to the bundle", () => {
		assert.deepStrictEqual(pathsToComponents(["force-app/main/default/lwc/hello/hello.html"], comps).keys, ["LightningComponentBundle:hello"]);
	});

	it("a folder maps to every component with a file under it (and only those)", () => {
		assert.deepStrictEqual(pathsToComponents(["force-app/main/default/classes"], comps).keys, ["ApexClass:A", "ApexClass:B"]);
		assert.deepStrictEqual(pathsToComponents(["force-app/main/default/"], comps).keys, ["ApexClass:A", "ApexClass:B", "LightningComponentBundle:hello", "Flow:F"]);
		// a name that merely starts like a folder is not under it
		assert.deepStrictEqual(pathsToComponents(["force-app/main/def"], comps), { keys: [], unmatched: ["force-app/main/def"] });
	});

	it("normalises separators and ./ prefixes, and reports what matches nothing", () => {
		const r = pathsToComponents(["./force-app\\main\\default\\flows\\F.flow-meta.xml", "force-app/main/default/classes/Nope.cls", ""], comps);
		assert.deepStrictEqual(r.keys, ["Flow:F"]);
		assert.deepStrictEqual(r.unmatched, ["force-app/main/default/classes/Nope.cls"]);
	});
});

describe("deploy components: preset migration", () => {
	const comps: RelComponent[] = [
		{ key: "ApexClass:A", files: ["force-app/classes/A.cls", "force-app/classes/A.cls-meta.xml"] },
		{ key: "ApexClass:B", files: ["force-app/classes/B.cls", "force-app/classes/B.cls-meta.xml"] },
		{ key: "Flow:F", files: ["force-app/flows/F.flow-meta.xml"] },
	];

	it("a preset that stores component keys is used as is", () => {
		const r = presetComponents({ components: ["ApexClass:A", "Flow:F", "ApexClass:A", "garbage"], sourcePaths: ["force-app/classes"] }, comps);
		assert.deepStrictEqual(r, { keys: ["ApexClass:A", "Flow:F"], unmatched: [], migrated: false });
	});

	it("an old preset of files and folders is mapped to components through the local index", () => {
		const r = presetComponents({ sourcePaths: ["force-app/classes/B.cls", "force-app/flows", "force-app/gone/X.cls"] }, comps);
		assert.deepStrictEqual(r, { keys: ["ApexClass:B", "Flow:F"], unmatched: ["force-app/gone/X.cls"], migrated: true });
	});

	it("a whole-folder path selects every component under it; an empty old preset selects nothing", () => {
		assert.deepStrictEqual(presetComponents({ sourcePaths: ["force-app/classes"] }, comps).keys, ["ApexClass:A", "ApexClass:B"]);
		assert.deepStrictEqual(presetComponents({ sourcePaths: [] }, comps), { keys: [], unmatched: [], migrated: true });
		assert.deepStrictEqual(presetComponents({}, comps).keys, []);
	});
});
