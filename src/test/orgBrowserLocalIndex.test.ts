import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildTypeTable, mapSourceFile, overwriteTargets, partialObjectKeys, readPackageDirectories, scanProject } from "../utils/orgBrowser/localIndex";

const table = buildTypeTable();
const map = (rel: string) => mapSourceFile(rel, table);

describe("orgBrowser localIndex: path mapping", () => {
	it("maps Apex classes and triggers via their -meta.xml, content files attach", () => {
		assert.deepStrictEqual(map("main/default/classes/Foo.cls-meta.xml"), { type: "ApexClass", name: "Foo", kind: "meta" });
		assert.deepStrictEqual(map("main/default/classes/Foo.cls"), { type: "ApexClass", name: "Foo", kind: "content" });
		assert.deepStrictEqual(map("main/default/triggers/AccTrg.trigger-meta.xml"), { type: "ApexTrigger", name: "AccTrg", kind: "meta" });
		assert.deepStrictEqual(map("main/default/pages/P.page-meta.xml"), { type: "ApexPage", name: "P", kind: "meta" });
		assert.deepStrictEqual(map("main/default/components/C.component"), { type: "ApexComponent", name: "C", kind: "content" });
	});

	it("maps LWC and Aura files to their bundle", () => {
		assert.deepStrictEqual(map("main/default/lwc/myCmp/myCmp.js"), { type: "LightningComponentBundle", name: "myCmp", kind: "bundle", bundleRoot: "main/default/lwc/myCmp" });
		assert.strictEqual(map("main/default/lwc/myCmp/__tests__/x.test.js")?.name, "myCmp");
		assert.deepStrictEqual(map("main/default/aura/Old/Old.cmp"), { type: "AuraDefinitionBundle", name: "Old", kind: "bundle", bundleRoot: "main/default/aura/Old" });
		assert.strictEqual(map("main/default/lwc/jsconfig.json"), null);
	});

	it("maps custom objects and their decomposed children", () => {
		assert.deepStrictEqual(map("main/default/objects/Foo__c/Foo__c.object-meta.xml"), { type: "CustomObject", name: "Foo__c", kind: "meta" });
		assert.deepStrictEqual(map("main/default/objects/Account/fields/Region__c.field-meta.xml"), { type: "CustomField", name: "Account.Region__c", kind: "meta" });
		const kids: [string, string, string][] = [
			["validationRules", "ValidationRule", "validationRule"],
			["recordTypes", "RecordType", "recordType"],
			["listViews", "ListView", "listView"],
			["webLinks", "WebLink", "webLink"],
			["compactLayouts", "CompactLayout", "compactLayout"],
			["fieldSets", "FieldSet", "fieldSet"],
			["businessProcesses", "BusinessProcess", "businessProcess"],
		];
		for (const [dir, type, suffix] of kids) {
			assert.deepStrictEqual(map(`main/default/objects/Case/${dir}/X.${suffix}-meta.xml`), { type, name: "Case.X", kind: "meta" }, dir);
		}
		assert.strictEqual(map("main/default/objects/Account/fields/Region__c.txt"), null);
	});

	it("maps static resources (file and unzipped forms), flows, layouts and custom metadata", () => {
		assert.deepStrictEqual(map("main/default/staticresources/Lib.resource-meta.xml"), { type: "StaticResource", name: "Lib", kind: "meta" });
		assert.deepStrictEqual(map("main/default/staticresources/Lib.zip"), { type: "StaticResource", name: "Lib", kind: "content" });
		assert.deepStrictEqual(map("main/default/staticresources/Dir/a/b.js"), { type: "StaticResource", name: "Dir", kind: "content" });
		assert.deepStrictEqual(map("main/default/flows/Case_Router.flow-meta.xml"), { type: "Flow", name: "Case_Router", kind: "meta" });
		assert.deepStrictEqual(map("main/default/layouts/Account-Account Layout.layout-meta.xml"), { type: "Layout", name: "Account-Account Layout", kind: "meta" });
		assert.deepStrictEqual(map("main/default/layouts/Account-Account %28Marketing%29 Layout.layout-meta.xml"), {
			type: "Layout",
			name: "Account-Account %28Marketing%29 Layout",
			kind: "meta",
		});
		assert.deepStrictEqual(map("main/default/customMetadata/Setting__mdt.Default.md-meta.xml"), { type: "CustomMetadata", name: "Setting__mdt.Default", kind: "meta" });
		assert.deepStrictEqual(map("main/default/permissionsets/Admin.permissionset-meta.xml"), { type: "PermissionSet", name: "Admin", kind: "meta" });
		assert.deepStrictEqual(map("main/default/labels/CustomLabels.labels-meta.xml"), { type: "CustomLabels", name: "CustomLabels", kind: "meta" });
	});

	it("keeps folder paths for reports, dashboards, documents and email templates", () => {
		assert.deepStrictEqual(map("main/default/reports/Sales/Pipeline.report-meta.xml"), { type: "Report", name: "Sales/Pipeline", kind: "meta" });
		assert.deepStrictEqual(map("main/default/reports/Sales.reportFolder-meta.xml"), { type: "ReportFolder", name: "Sales", kind: "meta" });
		assert.deepStrictEqual(map("main/default/email/Welcome/Hello.email-meta.xml"), { type: "EmailTemplate", name: "Welcome/Hello", kind: "meta" });
		assert.deepStrictEqual(map("main/default/email/Welcome/Hello.email"), { type: "EmailTemplate", name: "Welcome/Hello", kind: "content" });
	});

	it("uses describeMetadata types over the fallback table", () => {
		const t = buildTypeTable([{ name: "WeirdThing", dir: "weirdThings", suffix: "weird", inFolder: false, metaFile: false, children: [] }]);
		assert.deepStrictEqual(mapSourceFile("a/weirdThings/Zed.weird-meta.xml", t), { type: "WeirdThing", name: "Zed", kind: "meta" });
		assert.strictEqual(mapSourceFile("a/weirdThings/Zed.weird-meta.xml", table), null);
	});

	it("ignores files outside metadata directories", () => {
		assert.strictEqual(map("README.md"), null);
		assert.strictEqual(map("main/default/random/x.txt"), null);
	});
});

describe("orgBrowser localIndex: project scan", () => {
	let root: string;
	const write = (rel: string, content = "x") => {
		const p = path.join(root, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	};
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "orgbrowser-proj-"));
		write("sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }, { path: "extra" }] }));
		write("force-app/main/default/classes/Foo.cls");
		write("force-app/main/default/classes/Foo.cls-meta.xml");
		write("force-app/main/default/lwc/myCmp/myCmp.js");
		write("force-app/main/default/lwc/myCmp/myCmp.html");
		write("force-app/main/default/lwc/myCmp/myCmp.js-meta.xml");
		write("force-app/main/default/objects/Account/fields/Region__c.field-meta.xml");
		write("force-app/main/default/objects/Account/validationRules/Must.validationRule-meta.xml");
		write("force-app/main/default/staticresources/Lib.resource-meta.xml");
		write("force-app/main/default/staticresources/Lib.zip");
		write("extra/main/default/flows/F.flow-meta.xml");
		write("node_modules/x/classes/Nope.cls-meta.xml");
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	it("reads package directories from sfdx-project.json", () => {
		assert.deepStrictEqual(readPackageDirectories(root), ["force-app", "extra"]);
		assert.deepStrictEqual(readPackageDirectories(path.join(root, "nope")), []);
	});

	it("indexes components across package directories", async () => {
		const idx = await scanProject(root, readPackageDirectories(root));
		assert.deepStrictEqual([...idx.entries.keys()].sort(), [
			"ApexClass:Foo",
			"CustomField:Account.Region__c",
			"Flow:F",
			"LightningComponentBundle:myCmp",
			"StaticResource:Lib",
			"ValidationRule:Account.Must",
		]);
	});

	it("collects all files of a component, picks a primary file and overwrite targets", async () => {
		const idx = await scanProject(root, ["force-app"]);
		const cls = idx.entries.get("ApexClass:Foo")!;
		assert.strictEqual(cls.files.length, 2);
		assert.ok(cls.primary.endsWith("Foo.cls"));
		assert.deepStrictEqual(overwriteTargets(cls).sort(), cls.files.sort());

		const lwc = idx.entries.get("LightningComponentBundle:myCmp")!;
		assert.strictEqual(lwc.files.length, 3);
		assert.ok(lwc.primary.endsWith("myCmp.js"));
		assert.deepStrictEqual(overwriteTargets(lwc), [path.join(root, "force-app", "main", "default", "lwc", "myCmp")]);

		const sr = idx.entries.get("StaticResource:Lib")!;
		assert.strictEqual(sr.files.length, 2);
		assert.ok(sr.primary.endsWith("Lib.zip"));
	});

	it("does not index a content file without its -meta.xml", async () => {
		write("force-app/main/default/classes/Orphan.cls");
		const idx = await scanProject(root, ["force-app"]);
		assert.ok(!idx.entries.has("ApexClass:Orphan"));
	});

	it("CustomObject with its object file is indexed (In project), not partial", async () => {
		write("force-app/main/default/objects/Account/Account.object-meta.xml");
		const idx = await scanProject(root, ["force-app"]);
		assert.ok(idx.entries.has("CustomObject:Account"));
		assert.deepStrictEqual(partialObjectKeys(idx.entries), []);
	});

	it("an object folder with only children is partial (no CustomObject entry)", async () => {
		write("force-app/main/default/objects/Contact/listViews/All.listView-meta.xml");
		const idx = await scanProject(root, ["force-app"]);
		assert.ok(!idx.entries.has("CustomObject:Account"));
		assert.deepStrictEqual(partialObjectKeys(idx.entries).sort(), ["CustomObject:Account", "CustomObject:Contact"]);
	});

	it("tolerates a missing package directory", async () => {
		const idx = await scanProject(root, ["does-not-exist"]);
		assert.strictEqual(idx.entries.size, 0);
	});
});
