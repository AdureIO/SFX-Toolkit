import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DeployOrgStatus } from "../utils/deployOrgStatus";
import { evaluatePreDeploy, orgLookupKey } from "../utils/deployStatusPure";
import { ListOptions, ListResult, saveListingCache } from "../utils/orgBrowser/metadataLister";
import { Comp, TypeInfo } from "../utils/orgBrowser/types";

const T = (name: string, extra: Partial<TypeInfo> = {}): TypeInfo => ({ name, dir: "", suffix: "", inFolder: false, metaFile: false, children: [], ...extra });
const C = (t: string, n: string, lm: number, by = "Jane"): Comp => ({ t, n, ns: "", ms: "", by, bi: "", lm, cd: 0, id: "", f: "" });

describe("DeployOrgStatus", () => {
	let dir: string;
	let seed: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-dos-"));
		seed = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-dos-seed-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(seed, { recursive: true, force: true });
	});

	const make = (list: (o: ListOptions) => Promise<ListResult>, now = () => 5000) =>
		new DeployOrgStatus({ cacheDir: dir, seedDir: seed, apiVersion: "67.0", makeCall: () => async () => "", list, now });

	it("starts from the Org Browser's cache as a seed, with that listing's time per type", async () => {
		await saveListingCache(seed, {
			v: 1,
			orgKey: "u@x",
			apiVersion: "67.0",
			listedAt: 1000,
			types: [T("ApexClass"), T("Flow")],
			comps: [C("ApexClass", "A", 10), C("Flow", "F", 20)],
			failures: [{ type: "Flow", error: "boom" }],
		});
		const s = make(async () => ({ types: [], comps: [], failures: [] }));
		assert.strictEqual(await s.load("u@x", "u@x"), true);
		assert.strictEqual(s.isListed("ApexClass"), true);
		assert.strictEqual(s.isListed("Flow"), false); // its listing failed
		assert.deepStrictEqual(s.get("ApexClass", "A"), { lm: 10, by: "Jane" });
		const snap = s.snapshot([
			{ key: "ApexClass:A", type: "ApexClass", name: "A" },
			{ key: "Flow:F", type: "Flow", name: "F" },
		]);
		assert.deepStrictEqual(snap.listed, { ApexClass: 1000 });
		assert.deepStrictEqual(snap.failed, { Flow: "boom" });
		assert.deepStrictEqual(Object.keys(snap.comps), ["ApexClass:A", "Flow:F"]);
		assert.strictEqual(snap.asOf, 1000);
	});

	it("reports no cache when there is none", async () => {
		assert.strictEqual(await make(async () => ({ types: [], comps: [], failures: [] })).load("nobody", null), false);
	});

	it("refreshes only the requested types (with their folder twin), replaces their rows, and persists them", async () => {
		let asked: ListOptions | undefined;
		const s = make(async (o) => {
			asked = o;
			return {
				types: [T("ApexClass"), T("Report"), T("ReportFolder")],
				comps: [C("ApexClass", "A", 99), C("Report", "Sales/Q1", 77), C("ReportFolder", "Sales", 70)],
				failures: [],
			};
		});
		await s.load("u@x", "u@x");
		const out = await s.refresh(["ApexClass", "Report"]);
		assert.deepStrictEqual(asked?.only?.sort(), ["ApexClass", "Report", "ReportFolder"]);
		assert.deepStrictEqual(out.listed, ["ApexClass", "Report"]);
		assert.deepStrictEqual(s.get("ApexClass", "A"), { lm: 99, by: "Jane" });
		assert.deepStrictEqual(s.get("Report", "Sales/Q1"), { lm: 77, by: "Jane" });
		// a second instance picks the persisted listing up
		const again = make(async () => ({ types: [], comps: [], failures: [] }));
		assert.strictEqual(await again.load("u@x", "u@x"), true);
		assert.strictEqual(again.isListed("Report"), true);
		assert.deepStrictEqual(again.get("ApexClass", "A"), { lm: 99, by: "Jane" });
	});

	it("a type that fails keeps its previous data and is reported; the others still update", async () => {
		let n = 0;
		const s = make(async () => {
			n++;
			return n === 1
				? { types: [T("ApexClass"), T("Flow")], comps: [C("ApexClass", "A", 1), C("Flow", "F", 1)], failures: [] }
				: { types: [T("ApexClass"), T("Flow")], comps: [C("ApexClass", "A", 2)], failures: [{ type: "Flow", error: "HTTP 500" }] };
		});
		await s.load("u@x", "u@x");
		await s.refresh(["ApexClass", "Flow"]);
		const out = await s.refresh(["ApexClass", "Flow"]);
		assert.deepStrictEqual(out.listed, ["ApexClass"]);
		assert.strictEqual(out.failed.get("Flow"), "HTTP 500");
		assert.deepStrictEqual(s.get("ApexClass", "A"), { lm: 2, by: "Jane" });
		assert.deepStrictEqual(s.get("Flow", "F"), { lm: 1, by: "Jane" }); // stale, but kept
		assert.deepStrictEqual(s.snapshot([{ key: "Flow:F", type: "Flow", name: "F" }]).failed, { Flow: "HTTP 500" });
	});

	it("a type the org does not know is reported as failed (status unknown), never as 'all new'", async () => {
		const s = make(async () => ({ types: [T("ApexClass")], comps: [], failures: [] }));
		await s.load("u@x", "u@x");
		const out = await s.refresh(["ApexClass", "SomethingOdd"]);
		assert.strictEqual(out.failed.has("SomethingOdd"), true);
		assert.strictEqual(s.isListed("SomethingOdd"), false);
		assert.strictEqual(s.isListed("ApexClass"), true);
	});

	it("a fatal error (auth, network) propagates and leaves the previous state alone", async () => {
		let boom = false;
		const s = make(async () => {
			if (boom) throw new Error("HTTP 401: INVALID_SESSION_ID");
			return { types: [T("ApexClass")], comps: [C("ApexClass", "A", 1)], failures: [] };
		});
		await s.load("u@x", "u@x");
		await s.refresh(["ApexClass"]);
		boom = true;
		await assert.rejects(() => s.refresh(["ApexClass"]), /401/);
		assert.deepStrictEqual(s.get("ApexClass", "A"), { lm: 1, by: "Jane" });
		assert.strictEqual(s.isListed("ApexClass"), true);
	});

	it("drops a result that arrives after the org changed", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const s = make(async () => {
			await gate;
			return { types: [T("ApexClass")], comps: [C("ApexClass", "A", 1)], failures: [] };
		});
		await s.load("one", "one");
		const p = s.refresh(["ApexClass"]);
		await s.load("two", "two");
		release();
		await assert.rejects(p, /Org changed/);
		assert.strictEqual(s.get("ApexClass", "A"), undefined);
	});

	it("looks local components up by their decoded name", async () => {
		const s = make(async () => ({ types: [T("Layout")], comps: [C("Layout", "Account-Account Layout", 4)], failures: [] }));
		await s.load("u@x", "u@x");
		await s.refresh(["Layout"]);
		assert.deepStrictEqual(s.get("Layout", "Account-Account%20Layout"), { lm: 4, by: "Jane" });
	});

	it("a folder-restricted refresh merges just those folders and does not make the type look fresher", async () => {
		const s = make(async (o) =>
			o.onlyFolders
				? { types: [T("Report"), T("ReportFolder")], comps: [C("Report", "Sales/Q1", 50)], failures: [] }
				: { types: [T("Report"), T("ReportFolder")], comps: [C("Report", "Sales/Q1", 10), C("Report", "Ops/B", 10)], failures: [] }
		);
		await s.load("u@x", "u@x");
		await s.refresh(["Report"]);
		const before = s.snapshot([{ key: "Report:Ops/B", type: "Report", name: "Ops/B" }]).asOf;
		const out = await s.refresh(["Report"], { onlyFolders: { Report: ["Sales"] } });
		assert.deepStrictEqual(out.listed, ["Report"]);
		assert.deepStrictEqual(s.get("Report", "Sales/Q1"), { lm: 50, by: "Jane" });
		assert.deepStrictEqual(s.get("Report", "Ops/B"), { lm: 10, by: "Jane" }); // other folders untouched
		assert.strictEqual(s.snapshot([{ key: "Report:Ops/B", type: "Report", name: "Ops/B" }]).asOf, before);
	});

	it("the pre-deploy decision uses a live listing, not the cache: a change made since the cache was written is found", async () => {
		await saveListingCache(seed, { v: 1, orgKey: "u@x", apiVersion: "67.0", listedAt: 1000, types: [T("ApexClass")], comps: [C("ApexClass", "A", 10, "Jane")], failures: [] });
		let listed = 0;
		const s = make(async () => {
			listed++;
			return { types: [T("ApexClass")], comps: [C("ApexClass", "A", 30, "Joe")], failures: [] };
		});
		await s.load("u@x", "u@x");
		const syncedAt = { "ApexClass:A": 20 };
		const selected = [{ key: "ApexClass:A", type: "ApexClass", name: "A" }];
		// Against the cache alone nothing looks changed (lm 10 < synced 20) ...
		const cached = evaluatePreDeploy({ selected, orgComps: new Map([[orgLookupKey("ApexClass", "A"), s.get("ApexClass", "A")!]]), listedTypes: new Set(["ApexClass"]), failedTypes: new Map(), syncedAt });
		assert.strictEqual(cached.needsConfirmation, false);
		// ... the live listing finds Joe's later change.
		const out = await s.refresh(["ApexClass"]);
		assert.strictEqual(listed, 1);
		const live = evaluatePreDeploy({ selected, orgComps: new Map([[orgLookupKey("ApexClass", "A"), s.get("ApexClass", "A")!]]), listedTypes: new Set(out.listed), failedTypes: out.failed, syncedAt });
		assert.deepStrictEqual(live.changed.map((c) => [c.key, c.by, c.lm]), [["ApexClass:A", "Joe", 30]]);
	});
});
