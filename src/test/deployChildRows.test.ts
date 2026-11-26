import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deployPathsForComponents } from "../utils/deployComponentsPure";
import { LocalIndex, OBJECT_CHILD_TYPES, scanProject } from "../utils/orgBrowser/localIndex";
import { SyncRow } from "../utils/syncCenterPure";
import { historyDeployLocalKeys, rowDeployLocalKeys, rowRetrieveRef } from "../utils/syncCenterUiPure";

/** Deploying / retrieving a child row (field, validation rule …) must touch only that child, never its object. */
describe("deploy & retrieve: child rows stay children", () => {
	const D = "force-app/main/default/objects/Acme__c";
	const CHILDREN: { type: string; dir: string; suffix: string }[] = [
		{ type: "CustomField", dir: "fields", suffix: "field" },
		{ type: "ValidationRule", dir: "validationRules", suffix: "validationRule" },
		{ type: "RecordType", dir: "recordTypes", suffix: "recordType" },
		{ type: "ListView", dir: "listViews", suffix: "listView" },
		{ type: "WebLink", dir: "webLinks", suffix: "webLink" },
		{ type: "FieldSet", dir: "fieldSets", suffix: "fieldSet" },
		{ type: "CompactLayout", dir: "compactLayouts", suffix: "compactLayout" },
		{ type: "BusinessProcess", dir: "businessProcesses", suffix: "businessProcess" },
		{ type: "Index", dir: "indexes", suffix: "index" },
		{ type: "SharingReason", dir: "sharingReasons", suffix: "sharingReason" },
	];
	let root: string;
	let index: LocalIndex;
	let locals: { type: string; name: string; key: string }[];

	const touch = (rel: string) => {
		const f = path.join(root, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, "x");
	};
	const rel = (paths: string[]) => paths.map((p) => path.relative(root, p).split(path.sep).join("/"));
	const row = (type: string, name: string, localKey: string | undefined, status: SyncRow["status"] = "changed-locally"): SyncRow =>
		({ key: `${type}:${name}`, type, name, localKey, local: !!localKey, inOrg: true, status, code: 0, provisional: false }) as SyncRow;

	before(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-childrows-"));
		touch(`${D}/Acme__c.object-meta.xml`);
		for (const c of CHILDREN) {
			for (const n of ["X", "Y"]) touch(`${D}/${c.dir}/${n}.${c.suffix}-meta.xml`);
		}
		index = await scanProject(root, ["force-app"]);
		locals = [...index.entries.values()];
	});
	after(() => fs.rmSync(root, { recursive: true, force: true }));

	for (const c of CHILDREN) {
		it(`${c.type} row: deploys only its own file (no object file, no sibling)`, () => {
			assert.ok(OBJECT_CHILD_TYPES.has(c.type));
			const name = `Acme__c.X`;
			const entry = index.entries.get(`${c.type}:${name}`);
			assert.ok(entry, "indexed as its own entry");
			const keys = rowDeployLocalKeys(row(c.type, name, entry!.key), locals, OBJECT_CHILD_TYPES);
			assert.deepStrictEqual(keys, [entry!.key]);
			assert.deepStrictEqual(rel(deployPathsForComponents(keys, index.entries).paths), [`${D}/${c.dir}/X.${c.suffix}-meta.xml`]);
		});

		it(`${c.type} row: a retrieve is child-only unless "whole object" is on`, () => {
			assert.deepStrictEqual(rowRetrieveRef({ type: c.type, name: "Acme__c.X" }, false, OBJECT_CHILD_TYPES), { type: c.type, fullName: "Acme__c.X" });
			assert.deepStrictEqual(rowRetrieveRef({ type: c.type, name: "Acme__c.X" }, true, OBJECT_CHILD_TYPES), { type: "CustomObject", fullName: "Acme__c" });
		});
	}

	it("history re-run of a field deploys only that field", () => {
		const r = historyDeployLocalKeys(["CustomField:Acme__c.X"], locals, OBJECT_CHILD_TYPES);
		assert.strictEqual(r.missing, 0);
		assert.deepStrictEqual(rel(deployPathsForComponents(r.keys, index.entries).paths), [`${D}/fields/X.field-meta.xml`]);
	});

	it("an object row (CustomObject, in the project) deploys its object file only, not its children", () => {
		const entry = index.entries.get("CustomObject:Acme__c")!;
		const keys = rowDeployLocalKeys(row("CustomObject", "Acme__c", entry.key), locals, OBJECT_CHILD_TYPES);
		assert.deepStrictEqual(rel(deployPathsForComponents(keys, index.entries).paths), [`${D}/Acme__c.object-meta.xml`]);
	});

	it("a partial object row (standard object, only children in the project) deploys its children, as designed", () => {
		const keys = rowDeployLocalKeys(row("CustomObject", "Other__c", undefined, "partial"), [{ type: "CustomField", name: "Other__c.F__c", key: "CustomField:Other__c.F__c" }], OBJECT_CHILD_TYPES);
		assert.deepStrictEqual(keys, ["CustomField:Other__c.F__c"]);
	});
});
