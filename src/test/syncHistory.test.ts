import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	HistoryEntry,
	MAX_COMPONENTS,
	MAX_ENTRIES,
	MAX_LABEL,
	MAX_ERRORS,
	NewHistoryEntry,
	addEntry,
	cleanLabel,
	componentKeysFromDeploy,
	historyErrorsFromDeploy,
	historyErrorsFromRetrieve,
	normalizeEntry,
	parseHistory,
	serializeHistory,
} from "../utils/historyPure";
import { HistoryStore, historyFileStem } from "../utils/historyStore";

let n = 0;
const newId = () => `id-${++n}`;
const base = (over: Partial<NewHistoryEntry> = {}): NewHistoryEntry => ({
	kind: "deploy",
	org: "me@x.org",
	at: 1000,
	durationMs: 1234.6,
	components: ["ApexClass:A"],
	ok: true,
	source: "center",
	...over,
});

describe("history label (Deploy name)", () => {
	it("is stored trimmed and capped, and left out when empty", () => {
		assert.strictEqual(normalizeEntry(base({ label: "  Sprint   42\n hotfix " }), newId).label, "Sprint 42 hotfix");
		assert.strictEqual(normalizeEntry(base({ label: "x".repeat(500) }), newId).label?.length, MAX_LABEL);
		assert.ok(!("label" in normalizeEntry(base({ label: "   " }), newId)));
		assert.ok(!("label" in normalizeEntry(base(), newId)));
		assert.strictEqual(cleanLabel(42), undefined);
	});

	it("survives serialisation; a damaged stored label is dropped", () => {
		const e = normalizeEntry(base({ label: "Release 7" }), newId);
		assert.strictEqual(parseHistory(serializeHistory([e]))[0].label, "Release 7");
		const bad = JSON.stringify({ v: 1, entries: [{ ...e, label: { a: 1 } }] });
		const back = parseHistory(bad);
		assert.strictEqual(back.length, 1);
		assert.ok(!("label" in back[0]));
	});

	it("an old entry without a label reads back unchanged", () => {
		const e = normalizeEntry(base(), newId);
		assert.deepStrictEqual(parseHistory(serializeHistory([e])), [e]);
	});
});

describe("history entries", () => {
	it("normalizes: id, rounded duration, count, optional fields only when set", () => {
		const e = normalizeEntry(base(), newId);
		assert.ok(e.id.startsWith("id-"));
		assert.strictEqual(e.durationMs, 1235);
		assert.strictEqual(e.componentCount, 1);
		assert.ok(!("errors" in e) && !("deployId" in e) && !("testLevel" in e));
		const f = normalizeEntry(base({ id: "mine", testLevel: "RunLocalTests", deployId: "0Af1", ok: false, errors: [{ message: "x" }] }), newId);
		assert.deepStrictEqual([f.id, f.testLevel, f.deployId], ["mine", "RunLocalTests", "0Af1"]);
		assert.deepStrictEqual(f.errors, [{ message: "x" }]);
	});

	it("caps errors at 50 and components at 1000 (the real count is kept)", () => {
		const errors = Array.from({ length: 80 }, (_, i) => ({ component: `ApexClass:C${i}`, message: "m".repeat(2000) }));
		const comps = Array.from({ length: 1500 }, (_, i) => `ApexClass:C${i}`);
		const e = normalizeEntry(base({ ok: false, errors, components: comps }), newId);
		assert.strictEqual(e.errors!.length, MAX_ERRORS);
		assert.ok(e.errors![0].message.length <= 600);
		assert.strictEqual(e.components.length, MAX_COMPONENTS);
		assert.strictEqual(e.componentCount, 1500);
	});

	it("keeps the specified tests of a run (capped), and none when there are none", () => {
		assert.ok(!("tests" in normalizeEntry(base({ tests: [] }), newId)));
		assert.deepStrictEqual(normalizeEntry(base({ testLevel: "RunSpecifiedTests", tests: ["ATest", "BTest"] }), newId).tests, ["ATest", "BTest"]);
		const many = Array.from({ length: 300 }, (_, i) => `T${i}`);
		assert.strictEqual(normalizeEntry(base({ tests: many }), newId).tests!.length, 200);
	});

	it("adds newest first and caps at 200", () => {
		let list: HistoryEntry[] = [];
		for (let i = 0; i < 205; i++) list = addEntry(list, normalizeEntry(base({ at: i }), newId));
		assert.strictEqual(list.length, MAX_ENTRIES);
		assert.strictEqual(list[0].at, 204);
		assert.strictEqual(list[199].at, 5);
	});

	it("an entry with a known id replaces the old one", () => {
		const a = normalizeEntry(base({ id: "x", ok: false }), newId);
		const b = normalizeEntry(base({ id: "x", ok: true }), newId);
		const list = addEntry(addEntry([], a), b);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0].ok, true);
	});

	it("serialize / parse round-trip; damaged, foreign and partly invalid files are tolerated", () => {
		const list = [normalizeEntry(base(), newId), normalizeEntry(base({ kind: "retrieve", source: "orgBrowser" }), newId)];
		assert.deepStrictEqual(parseHistory(serializeHistory(list)), list);
		assert.deepStrictEqual(parseHistory(undefined), []);
		assert.deepStrictEqual(parseHistory("{nope"), []);
		assert.deepStrictEqual(parseHistory(JSON.stringify({ v: 2, entries: list })), []);
		const mixed = JSON.stringify({ v: 1, entries: [list[0], { id: 1 }, { ...list[1], kind: "bogus" }, null] });
		assert.deepStrictEqual(parseHistory(mixed), [list[0]]);
	});
});

describe("history errors and components of a result", () => {
	it("deploy: component failures, then failing tests and coverage warnings", () => {
		const errs = historyErrorsFromDeploy({
			details: {
				componentFailures: [{ componentType: "ApexClass", fullName: "A", problem: "Bad" }, { fullName: "Loose", problem: "Odd" }],
				runTestResult: { failures: [{ name: "ATest", methodName: "m", message: "boom" }], codeCoverageWarnings: [{ name: "B", message: "75% needed" }] },
			},
		});
		assert.deepStrictEqual(errs, [
			{ component: "ApexClass:A", message: "Bad" },
			{ component: "Loose", message: "Odd" },
			{ component: "ApexClass:ATest", message: "m: boom" },
			{ component: "ApexClass:B", message: "75% needed" },
		]);
	});

	it("deploy: a single failure object, else the top-level message, else the CLI text", () => {
		assert.deepStrictEqual(historyErrorsFromDeploy({ details: { componentFailures: { componentType: "Flow", fullName: "F", problem: "p" } } }), [{ component: "Flow:F", message: "p" }]);
		assert.deepStrictEqual(historyErrorsFromDeploy({ errorMessage: "Org-wide  coverage\nlow" }), [{ message: "Org-wide coverage low" }]);
		assert.deepStrictEqual(historyErrorsFromDeploy(undefined, "spawn sf ENOENT"), [{ message: "spawn sf ENOENT" }]);
		assert.deepStrictEqual(historyErrorsFromDeploy(undefined), []);
	});

	it("deploy errors are capped at 50", () => {
		const failures = Array.from({ length: 70 }, (_, i) => ({ componentType: "ApexClass", fullName: `C${i}`, problem: "p" }));
		assert.strictEqual(historyErrorsFromDeploy({ details: { componentFailures: failures } }).length, 50);
	});

	it("retrieve: failed components with their message", () => {
		assert.deepStrictEqual(historyErrorsFromRetrieve([{ type: "Layout", fullName: "L", error: "not found" }]), [{ component: "Layout:L", message: "not found" }]);
	});

	it("component keys of a deploy result: successes and failures, no duplicates, nothing without a type", () => {
		const keys = componentKeysFromDeploy({
			details: {
				componentSuccesses: [{ componentType: "ApexClass", fullName: "A" }, { componentType: "", fullName: "package.xml" }, { componentType: "ApexClass", fullName: "A" }],
				componentFailures: { componentType: "Flow", fullName: "F" },
			},
		});
		assert.deepStrictEqual(keys, ["ApexClass:A", "Flow:F"]);
		assert.deepStrictEqual(componentKeysFromDeploy(undefined), []);
	});
});

describe("history store", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-hist-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("stores per project under <sha1(projectDir)[0:12]>.json, debounced, and flushes synchronously", async () => {
		const changed: string[] = [];
		const s = new HistoryStore(dir, { delayMs: 20, newId, onChange: (p) => changed.push(p) });
		s.add("/proj/a", base());
		s.add("/proj/a", base({ kind: "delete" }));
		s.add("/proj/b", base({ kind: "retrieve", source: "orgBrowser" }));
		assert.deepStrictEqual(changed, ["/proj/a", "/proj/a", "/proj/b"]);
		assert.ok(!fs.existsSync(s.fileOf("/proj/a")), "not written yet (debounced)");
		await new Promise((r) => setTimeout(r, 80));
		assert.strictEqual(path.basename(s.fileOf("/proj/a")), `${historyFileStem("/proj/a")}.json`);
		assert.ok(/^[0-9a-f]{12}$/.test(historyFileStem("/proj/a")));
		assert.ok(fs.existsSync(s.fileOf("/proj/a")) && fs.existsSync(s.fileOf("/proj/b")));
		// A new store reads what was written; newest first.
		const again = new HistoryStore(dir, { newId });
		assert.deepStrictEqual(again.get("/proj/a").map((e) => e.kind), ["delete", "deploy"]);
		assert.strictEqual(again.get("/proj/b").length, 1);
		assert.deepStrictEqual(again.get("/proj/none"), []);
	});

	it("flush() writes pending changes at once (deactivate) and clear() empties", () => {
		const s = new HistoryStore(dir, { delayMs: 60_000, newId });
		s.add("/p", base());
		assert.ok(!fs.existsSync(s.fileOf("/p")));
		s.flush();
		assert.strictEqual(parseHistory(fs.readFileSync(s.fileOf("/p"), "utf8")).length, 1);
		s.clear("/p");
		s.flush();
		assert.strictEqual(parseHistory(fs.readFileSync(s.fileOf("/p"), "utf8")).length, 0);
		assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
	});

	it("caps at 200 per project", () => {
		const s = new HistoryStore(dir, { newId });
		for (let i = 0; i < 230; i++) s.add("/p", base({ at: i }));
		assert.strictEqual(s.get("/p").length, 200);
		assert.strictEqual(s.get("/p")[0].at, 229);
	});

	it("a damaged file starts an empty history", () => {
		const s = new HistoryStore(dir, { newId });
		fs.writeFileSync(s.fileOf("/p"), "not json");
		assert.deepStrictEqual(s.get("/p"), []);
	});
});
