import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { deletePreset, listPresets, onDidChangePresets, presetsFileOf, renamePreset, savePreset } from "../utils/presetsStore";
import { migratePreset, parsePresetsFile, renameInList, serializePresets, upsertPreset } from "../utils/presetsPure";
import { presetComponents } from "../utils/deployComponentsPure";

describe("presets: reading every file format (migration)", () => {
	it("the oldest format (classPaths) becomes sourcePaths", () => {
		const p = migratePreset({ name: "Old", classPaths: ["force-app/main/default/classes/A.cls"], deployType: "RunLocalTests-unknown", testClassNames: ["ATest"] });
		assert.deepStrictEqual(p, {
			name: "Old",
			sourcePaths: ["force-app/main/default/classes/A.cls"],
			deployType: "RunRelevantTests",
			testClassNames: ["ATest"],
		});
		assert.ok(!("classPaths" in p!) && !("components" in p!));
	});

	it("a preset with sourcePaths only keeps them (the Deploy panel maps them through the local index)", () => {
		const p = migratePreset({ name: "Paths", sourcePaths: ["force-app/main/default/classes/A.cls", "force-app/main/default/classes/A.cls-meta.xml"], deployType: "NoTestRun", testClassNames: [] })!;
		assert.strictEqual(p.components, undefined);
		const r = presetComponents(p, [{ key: "ApexClass:A", files: ["force-app/main/default/classes/A.cls", "force-app/main/default/classes/A.cls-meta.xml"] }]);
		assert.deepStrictEqual(r.keys, ["ApexClass:A"]);
		assert.strictEqual(r.migrated, true);
	});

	it("a current preset round-trips unchanged, extra fields (validateOnly) kept", () => {
		const cur = {
			name: "Cur",
			components: ["ApexClass:A", "Flow:F"],
			sourcePaths: ["force-app/x"],
			deployType: "RunSpecifiedTests",
			testClassNames: ["ATest"],
			targetOrg: "me@x.org",
			validateOnly: true,
		};
		const text = JSON.stringify({ presets: [cur] }, null, 2);
		const list = parsePresetsFile(text);
		assert.deepStrictEqual(list, [cur]);
		assert.strictEqual(serializePresets(list), text);
	});

	it("drops entries without a name; non-string list items; empty org; a damaged or foreign file gives []", () => {
		assert.strictEqual(migratePreset({ sourcePaths: [] }), undefined);
		assert.strictEqual(migratePreset(null), undefined);
		const p = migratePreset({ name: "X", components: ["A:b", 3], sourcePaths: [1, "p"], targetOrg: "" })!;
		assert.deepStrictEqual([p.components, p.sourcePaths, "targetOrg" in p], [["A:b"], ["p"], false]);
		assert.deepStrictEqual(parsePresetsFile("{nope"), []);
		assert.deepStrictEqual(parsePresetsFile(JSON.stringify({ other: 1 })), []);
		assert.deepStrictEqual(parsePresetsFile(undefined), []);
	});

	it("list operations: upsert keeps the position, rename rejects clashes", () => {
		const a = migratePreset({ name: "A" })!;
		const b = migratePreset({ name: "B" })!;
		const a2 = { ...a, testClassNames: ["T"] };
		assert.deepStrictEqual(upsertPreset([a, b], a2).map((p) => p.name), ["A", "B"]);
		assert.deepStrictEqual(upsertPreset([a, b], a2)[0].testClassNames, ["T"]);
		assert.deepStrictEqual(renameInList([a, b], "A", " C ").map((p) => p.name), ["C", "B"]);
		assert.throws(() => renameInList([a, b], "A", "B"), /already exists/);
		assert.throws(() => renameInList([a, b], "Z", "Q"), /does not exist/);
		assert.throws(() => renameInList([a, b], "A", "  "), /required/);
		assert.deepStrictEqual(renameInList([a, b], "A", "A").map((p) => p.name), ["A", "B"]);
	});
});

describe("presets store (per project file)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-presets-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("keeps the storage of every version: <project>/.vscode/deploy-presets.json", () => {
		assert.strictEqual(presetsFileOf("/p"), path.join("/p", ".vscode", "deploy-presets.json"));
	});

	it("an existing file of an older version is listed; the first save rewrites it in today's shape", async () => {
		fs.mkdirSync(path.join(dir, ".vscode"));
		fs.writeFileSync(presetsFileOf(dir), JSON.stringify({ presets: [{ name: "Old", classPaths: ["a.cls"], deployType: "NoTestRun", testClassNames: [] }] }));
		assert.deepStrictEqual((await listPresets(dir)).map((p) => [p.name, p.sourcePaths]), [["Old", ["a.cls"]]]);
		await savePreset(dir, { name: "New", components: ["ApexClass:A"] });
		const stored = JSON.parse(fs.readFileSync(presetsFileOf(dir), "utf8"));
		assert.deepStrictEqual(stored.presets.map((p: { name: string }) => p.name), ["Old", "New"]);
		assert.ok(!("classPaths" in stored.presets[0]));
		assert.deepStrictEqual(stored.presets[0].sourcePaths, ["a.cls"]);
	});

	it("save: defaults for a bare selection (the Center), replace by name, trimmed name, name required", async () => {
		const p = await savePreset(dir, { name: "  Sel  ", components: ["ApexClass:A", "Flow:F"] });
		assert.deepStrictEqual(p, { name: "Sel", sourcePaths: [], components: ["ApexClass:A", "Flow:F"], deployType: "RunRelevantTests", testClassNames: [], targetOrg: undefined });
		await savePreset(dir, { name: "Sel", components: ["ApexClass:B"], deployType: "NoTestRun", targetOrg: "o@x" });
		const list = await listPresets(dir);
		assert.strictEqual(list.length, 1);
		assert.deepStrictEqual([list[0].components, list[0].deployType, list[0].targetOrg], [["ApexClass:B"], "NoTestRun", "o@x"]);
		await assert.rejects(() => savePreset(dir, { name: "  " }), /Preset name is required/);
	});

	it("delete and rename, with the change event", async () => {
		const events: string[] = [];
		const sub = onDidChangePresets((d) => events.push(d));
		await savePreset(dir, { name: "A", components: [] });
		await savePreset(dir, { name: "B", components: [] });
		assert.strictEqual((await renamePreset(dir, "A", "C")).name, "C");
		await assert.rejects(() => renamePreset(dir, "C", "B"), /already exists/);
		assert.strictEqual(await deletePreset(dir, "B"), true);
		assert.strictEqual(await deletePreset(dir, "B"), false);
		assert.deepStrictEqual((await listPresets(dir)).map((p) => p.name), ["C"]);
		assert.deepStrictEqual(events, [dir, dir, dir, dir], "save, save, rename, delete (failed and no-op calls do not fire)");
		sub.dispose();
		await savePreset(dir, { name: "D", components: [] });
		assert.strictEqual(events.length, 4);
	});

	it("quick successive saves are serialized: none is lost", async () => {
		await Promise.all(Array.from({ length: 8 }, (_, i) => savePreset(dir, { name: `P${i}`, components: [`ApexClass:C${i}`] })));
		assert.deepStrictEqual((await listPresets(dir)).map((p) => p.name).sort(), Array.from({ length: 8 }, (_, i) => `P${i}`));
	});

	it("a project without a file lists nothing; a damaged file is replaced by the next save", async () => {
		assert.deepStrictEqual(await listPresets(dir), []);
		fs.mkdirSync(path.join(dir, ".vscode"));
		fs.writeFileSync(presetsFileOf(dir), "garbage");
		assert.deepStrictEqual(await listPresets(dir), []);
		await savePreset(dir, { name: "Fresh", components: [] });
		assert.strictEqual((await listPresets(dir)).length, 1);
	});

	it("projects are separate", async () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-presets-"));
		try {
			await savePreset(dir, { name: "A", components: [] });
			assert.deepStrictEqual(await listPresets(other), []);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
		}
	});
});
