import * as assert from "assert";
import {
	CompareInput,
	TOL_MS,
	componentLocalTime,
	compareStatus,
	computeLocalInfo,
	effectiveSyncedAt,
	fileLocalTime,
	isPathDirty,
	progressText,
} from "../utils/compareStatusPure";

const T = Date.parse("2025-06-01T10:00:00Z");
const H = 3600_000;

const st = (i: Partial<CompareInput>) => compareStatus({ orgLm: T, localT: T, dirty: false, ...i });

describe("compare status: content verified", () => {
	it("same is equal, whatever the dates or the dirty flag say", () => {
		const r = st({ content: "same", orgLm: T + 9 * H, localT: T - 9 * H, syncedAt: T, dirty: true });
		assert.deepStrictEqual(r, { status: "equal", provisional: false });
	});
});

describe("compare status: different contents, dates give the direction", () => {
	const synced = T;
	it("only the org changed since the sync", () => {
		assert.deepStrictEqual(st({ content: "different", syncedAt: synced, orgLm: T + H, localT: T - H }), { status: "changed-in-org", provisional: false });
	});
	it("only local changed (newer file, or dirty)", () => {
		assert.strictEqual(st({ content: "different", syncedAt: synced, orgLm: T, localT: T + H }).status, "changed-locally");
		assert.strictEqual(st({ content: "different", syncedAt: synced, orgLm: T, localT: T - H, dirty: true }).status, "changed-locally");
	});
	it("both changed: conflict", () => {
		assert.deepStrictEqual(st({ content: "different", syncedAt: synced, orgLm: T + H, localT: T + H }), { status: "conflict", provisional: false });
	});
	it("neither changed since the sync (dates useless): the newer side wins", () => {
		assert.strictEqual(st({ content: "different", syncedAt: synced + H, orgLm: T + 2, localT: T }).status, "changed-in-org");
		assert.strictEqual(st({ content: "different", syncedAt: synced + H, orgLm: T, localT: T + 2 }).status, "changed-locally");
		assert.strictEqual(st({ content: "different", syncedAt: synced + H, orgLm: T, localT: T }).status, "changed-locally"); // tie: local
	});
	it("the tolerance: changes within 60 s of the sync do not count", () => {
		const r = st({ content: "different", syncedAt: synced, orgLm: T + TOL_MS, localT: T + TOL_MS });
		// neither changed → the newer wins; both equal → changed-locally
		assert.strictEqual(r.status, "changed-locally");
		assert.strictEqual(st({ content: "different", syncedAt: synced, orgLm: T + TOL_MS + 1, localT: T }).status, "changed-in-org");
	});
	it("without a sync time: the org copy is older than the local file → changed locally; newer → changed in org", () => {
		assert.strictEqual(st({ content: "different", orgLm: T - H, localT: T }).status, "changed-locally");
		assert.strictEqual(st({ content: "different", orgLm: T + H, localT: T }).status, "changed-in-org");
		assert.strictEqual(st({ content: "different", orgLm: T + H, localT: T, dirty: true }).status, "conflict");
	});
});

describe("compare status: dates only (provisional)", () => {
	it("with a sync time: nothing changed → equal", () => {
		assert.deepStrictEqual(st({ syncedAt: T }), { status: "equal", provisional: true });
	});
	it("with a sync time: org / local / both", () => {
		assert.deepStrictEqual(st({ syncedAt: T, orgLm: T + H }), { status: "changed-in-org", provisional: true });
		assert.deepStrictEqual(st({ syncedAt: T, localT: T + H }), { status: "changed-locally", provisional: true });
		assert.deepStrictEqual(st({ syncedAt: T, orgLm: T + H, localT: T + H }), { status: "conflict", provisional: true });
		assert.strictEqual(st({ syncedAt: T, dirty: true }).status, "changed-locally");
	});
	it("no sync time, clean, org not newer than local: provisional equal", () => {
		assert.deepStrictEqual(st({ orgLm: T - H, localT: T }), { status: "equal", provisional: true });
		assert.deepStrictEqual(st({ orgLm: T, localT: T }), { status: "equal", provisional: true });
	});
	it("no sync time, clean, org newer than local: changed in org", () => {
		assert.deepStrictEqual(st({ orgLm: T + H, localT: T }), { status: "changed-in-org", provisional: true });
	});
	it("no sync time but dirty: changed locally (conflict when the org is newer too)", () => {
		assert.strictEqual(st({ dirty: true, orgLm: T - H }).status, "changed-locally");
		assert.strictEqual(st({ dirty: true, orgLm: T + H }).status, "conflict");
	});
});

describe("compare status: local time", () => {
	it("a dirty file counts by its mtime, a clean one by its last commit, a file without git by its mtime", () => {
		assert.strictEqual(fileLocalTime({ mtime: 500, commit: 100, dirty: true }), 500);
		assert.strictEqual(fileLocalTime({ mtime: 500, commit: 100, dirty: false }), 100);
		assert.strictEqual(fileLocalTime({ mtime: 500, dirty: false }), 500);
	});
	it("a component takes the newest of its files and is dirty when any file is", () => {
		const r = componentLocalTime([
			{ mtime: 900, commit: 100, dirty: false },
			{ mtime: 300, commit: 50, dirty: true },
		]);
		assert.deepStrictEqual(r, { localT: 300, dirty: true });
		assert.deepStrictEqual(componentLocalTime([]), { localT: 0, dirty: false });
	});
	it("effectiveSyncedAt takes the newer of the log and the verified time", () => {
		assert.strictEqual(effectiveSyncedAt(undefined, undefined), undefined);
		assert.strictEqual(effectiveSyncedAt(5, undefined), 5);
		assert.strictEqual(effectiveSyncedAt(undefined, 7), 7);
		assert.strictEqual(effectiveSyncedAt(5, 7), 7);
		assert.strictEqual(effectiveSyncedAt(9, 7), 9);
	});
});

describe("compare status: git data", () => {
	it("a path is dirty when it, or a folder above it, is in the status", () => {
		const dirty = new Set(["force-app/main/default/classes/A.cls", "force-app/main/default/lwc/newOne"]);
		assert.strictEqual(isPathDirty("force-app/main/default/classes/A.cls", dirty), true);
		assert.strictEqual(isPathDirty("force-app/main/default/lwc/newOne/newOne.js", dirty), true);
		assert.strictEqual(isPathDirty("force-app/main/default/classes/B.cls", dirty), false);
	});
	it("builds the local info per component: dirty → mtime, clean → commit, no git → mtime", () => {
		const comps = [
			{ key: "ApexClass:A", files: ["p/A.cls", "p/A.cls-meta.xml"] },
			{ key: "ApexClass:B", files: ["p/B.cls"] },
		];
		const mtime = (rel: string) => ({ "p/A.cls": 900, "p/A.cls-meta.xml": 800, "p/B.cls": 700 })[rel] ?? 0;
		const commits = new Map([["p/A.cls", 100], ["p/A.cls-meta.xml", 120], ["p/B.cls", 200]]);
		assert.deepStrictEqual(computeLocalInfo(comps, mtime, new Set(["p/A.cls"]), commits), { "ApexClass:A": [900, 1], "ApexClass:B": [200, 0] });
		assert.deepStrictEqual(computeLocalInfo(comps, mtime, null, null), { "ApexClass:A": [900, 0], "ApexClass:B": [700, 0] });
	});
	it("uses the scan boundary for clean files without a commit time, mtime when there is no boundary", () => {
		const comps = [{ key: "ApexClass:B", files: ["p/B.cls"] }, { key: "ApexClass:C", files: ["p/C.cls"] }];
		const mtime = () => 700;
		const commits = new Map([["p/B.cls", 200]]);
		assert.deepStrictEqual(computeLocalInfo(comps, mtime, new Set(), commits, 50), { "ApexClass:B": [200, 0], "ApexClass:C": [50, 0] });
		assert.deepStrictEqual(computeLocalInfo(comps, mtime, new Set(), commits, null), { "ApexClass:B": [200, 0], "ApexClass:C": [700, 0] });
	});
});

describe("compare status: progress text", () => {
	it("shows the counts while comparing, nothing when idle", () => {
		assert.strictEqual(progressText({ state: "running", done: 340, total: 3324, failed: 0 }), "Comparing contents 340 / 3,324");
		assert.strictEqual(progressText({ state: "paused", done: 3, total: 9, failed: 0 }), "Comparing paused 3 / 9");
		assert.strictEqual(progressText({ state: "idle", done: 9, total: 9, failed: 0 }), "");
		assert.strictEqual(progressText(null), "");
	});
});
