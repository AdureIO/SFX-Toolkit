import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readGzipJson, safeFileStem, writeGzipJson } from "../utils/diskCache";
import { LocalIndex, buildTypeTable, scanProject } from "../utils/orgBrowser/localIndex";
import { TypeInfo } from "../utils/orgBrowser/types";
import {
	commitMapsOf,
	commitSnapshotOf,
	changedDirs,
	indexCacheFile,
	indexOfSnapshot,
	infoForKeys,
	MAX_COMMIT_ENTRIES,
	parseIndexSnapshot,
	parseTimesFile,
	snapshotMatches,
	snapshotOfIndex,
	timesCacheFile,
	typesKeyOf,
} from "../utils/projectScanCachePure";
import {
	flushProjectScanCache,
	initProjectScanCache,
	loadCommitSnapshot,
	peekLocalIndex,
	peekLocalInfo,
	resetProjectScanCache,
	saveCommitSnapshot,
	saveLocalInfo,
	scanProjectCached,
} from "../utils/projectScanCache";

const type = (name: string, dir: string, suffix: string): TypeInfo => ({ name, dir, suffix, inFolder: false, metaFile: true, children: [] });

interface Fx {
	root: string;
	project: string;
	classes: string;
	cache: string;
}

function fixture(): Fx {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-psc-"));
	const project = path.join(root, "proj");
	const classes = path.join(project, "force-app", "main", "default", "classes");
	fs.mkdirSync(classes, { recursive: true });
	fs.writeFileSync(path.join(project, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
	for (const n of ["A", "B"]) {
		fs.writeFileSync(path.join(classes, `${n}.cls`), `public class ${n} {}`);
		fs.writeFileSync(path.join(classes, `${n}.cls-meta.xml`), "<ApexClass/>");
	}
	return { root, project, classes, cache: path.join(root, "cache") };
}

describe("disk cache (gzip JSON)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-dc-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("round-trips, replaces atomically and reads damaged / missing files as undefined", async () => {
		const file = path.join(dir, "sub", "x.json.gz");
		await writeGzipJson(file, { a: [1, 2], b: "é" });
		assert.deepStrictEqual(await readGzipJson(file), { a: [1, 2], b: "é" });
		await writeGzipJson(file, { a: 3 });
		assert.deepStrictEqual(await readGzipJson(file), { a: 3 });
		assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["x.json.gz"], "no temp file left behind");
		fs.writeFileSync(file, "not gzip");
		assert.strictEqual(await readGzipJson(file), undefined);
		assert.strictEqual(await readGzipJson(path.join(dir, "missing.json.gz")), undefined);
	});

	it("makes file stems safe", () => {
		assert.strictEqual(safeFileStem("a/b:c@d.org"), "a_b_c@d.org");
	});
});

describe("project scan cache: snapshots", () => {
	let f: Fx;
	beforeEach(() => {
		f = fixture();
	});
	afterEach(() => fs.rmSync(f.root, { recursive: true, force: true }));

	async function scanned(): Promise<{ index: LocalIndex; dirs: Map<string, number> }> {
		const dirs = new Map<string, number>();
		const index = await scanProject(f.project, ["force-app"], buildTypeTable(), dirs);
		return { index, dirs };
	}

	it("serialises the index with project-relative paths and reads it back identically", async () => {
		const { index, dirs } = await scanned();
		const snap = snapshotOfIndex(f.project, ["force-app"], "", index, dirs);
		assert.ok(snap.entries.every((e) => e.f.every((x) => !path.isAbsolute(x))), "paths are relative");
		assert.ok(Object.keys(snap.dirs).includes("force-app/main/default/classes"));
		const back = indexOfSnapshot(parseIndexSnapshot(JSON.parse(JSON.stringify(snap)), f.project)!, f.project);
		assert.deepStrictEqual([...back.entries.keys()].sort(), ["ApexClass:A", "ApexClass:B"]);
		const a = back.entries.get("ApexClass:A")!;
		const orig = index.entries.get("ApexClass:A")!;
		assert.deepStrictEqual(a.files.sort(), orig.files.sort());
		assert.strictEqual(a.primary, orig.primary);
		assert.strictEqual(back.scannedAt, index.scannedAt);
	});

	it("keeps the bundle root of a bundle entry", async () => {
		const lwc = path.join(f.project, "force-app", "main", "default", "lwc", "foo");
		fs.mkdirSync(lwc, { recursive: true });
		fs.writeFileSync(path.join(lwc, "foo.js"), "x");
		const { index, dirs } = await scanned();
		const back = indexOfSnapshot(snapshotOfIndex(f.project, ["force-app"], "", index, dirs), f.project);
		assert.strictEqual(back.entries.get("LightningComponentBundle:foo")?.root, lwc);
	});

	it("rejects a file of another version, another project or a damaged one", async () => {
		const { index, dirs } = await scanned();
		const snap = snapshotOfIndex(f.project, ["force-app"], "", index, dirs);
		assert.ok(parseIndexSnapshot(snap, f.project));
		assert.strictEqual(parseIndexSnapshot({ ...snap, v: 2 }, f.project), null);
		assert.strictEqual(parseIndexSnapshot(snap, "/other/project"), null);
		assert.strictEqual(parseIndexSnapshot({ ...snap, entries: [{ t: "ApexClass" }] }, f.project), null);
		assert.strictEqual(parseIndexSnapshot(null, f.project), null);
		assert.strictEqual(parseIndexSnapshot("x", f.project), null);
	});

	it("is valid only for the same package directories and type table (no types yet accepts the richer snapshot)", () => {
		const snap = { pkgDirs: ["force-app"], typesKey: typesKeyOf([type("ApexClass", "classes", "cls")]) };
		assert.ok(snapshotMatches(snap, ["force-app"], snap.typesKey));
		assert.ok(!snapshotMatches(snap, ["force-app", "other"], snap.typesKey));
		assert.ok(!snapshotMatches(snap, ["other"], snap.typesKey));
		assert.ok(!snapshotMatches(snap, ["force-app"], typesKeyOf([type("Foo", "foos", "foo")])));
		assert.ok(snapshotMatches(snap, ["force-app"], ""), "the listing is not loaded yet: the stored index is the better answer");
		assert.strictEqual(typesKeyOf([]), "");
		assert.strictEqual(typesKeyOf([type("A", "a", "x"), type("B", "b", "y")]), typesKeyOf([type("B", "b", "y"), type("A", "a", "x")]), "order does not matter");
	});

	it("lists the directories whose mtime changed or that are gone", () => {
		const snap = { dirs: { "a": 10, "a/b": 20, "c": 30 } };
		assert.deepStrictEqual(changedDirs(snap, new Map([["a", 10], ["a/b", 20], ["c", 30]])), []);
		assert.deepStrictEqual(changedDirs(snap, new Map([["a", 10], ["a/b", 21], ["c", undefined]])).sort(), ["a/b", "c"]);
		assert.deepStrictEqual(changedDirs(snap, new Map([["a", 10]])).sort(), ["a/b", "c"], "not stat-ed = gone");
	});

	it("keeps the commit cache only for the same package dirs and drops one that grew too big", () => {
		const snap = commitSnapshotOf("abc1234", "force-app", new Map([["x", 1]]), new Map([["y", 2]]))!;
		const maps = commitMapsOf(JSON.parse(JSON.stringify(snap)), "force-app")!;
		assert.strictEqual(maps.head, "abc1234");
		assert.strictEqual(maps.times.get("x"), 1);
		assert.strictEqual(maps.bounds.get("y"), 2);
		assert.strictEqual(commitMapsOf(snap, "other"), undefined);
		assert.strictEqual(commitMapsOf(undefined, "force-app"), undefined);
		const big = new Map<string, number>();
		for (let i = 0; i <= MAX_COMMIT_ENTRIES; i++) big.set(`p${i}`, i);
		assert.strictEqual(commitSnapshotOf("h", "d", big, new Map()), null);
	});

	it("restricts the stored change info to the components that exist", () => {
		const snap = { at: 1, head: "h", info: { "ApexClass:A": [10, 0] as [number, number], "ApexClass:Gone": [5, 1] as [number, number] } };
		assert.deepStrictEqual(infoForKeys(snap, ["ApexClass:A", "ApexClass:New"]), { "ApexClass:A": [10, 0] });
		assert.strictEqual(infoForKeys(snap, ["ApexClass:New"]), undefined);
		assert.strictEqual(infoForKeys(undefined, ["x"]), undefined);
	});

	it("validates the times file", () => {
		assert.ok(parseTimesFile({ v: 1, projectDir: "/p" }, "/p"));
		assert.strictEqual(parseTimesFile({ v: 1, projectDir: "/q" }, "/p"), null);
		assert.strictEqual(parseTimesFile({ v: 1, projectDir: "/p", commits: { head: 1 } }, "/p"), null);
		assert.strictEqual(parseTimesFile({ v: 1, projectDir: "/p", info: { at: "x" } }, "/p"), null);
	});

	it("names the files after the project (stable, different per project)", () => {
		assert.strictEqual(indexCacheFile("/c", "/p/a"), indexCacheFile("/c", "/p/a"));
		assert.notStrictEqual(indexCacheFile("/c", "/p/a"), indexCacheFile("/c", "/p/b"));
		assert.notStrictEqual(indexCacheFile("/c", "/p/a"), timesCacheFile("/c", "/p/a"));
		assert.ok(indexCacheFile("/c", "/p/a").endsWith(".index.json.gz"));
	});
});

describe("project scan cache: scanProjectCached", () => {
	let f: Fx;
	beforeEach(() => {
		f = fixture();
		resetProjectScanCache();
		initProjectScanCache(f.cache);
	});
	afterEach(async () => {
		await flushProjectScanCache();
		resetProjectScanCache();
		fs.rmSync(f.root, { recursive: true, force: true });
	});

	const scan = (opts?: { force?: boolean }) => scanProjectCached(f.project, ["force-app"], [], opts);
	const settle = () => new Promise((r) => setTimeout(r, 60));

	it("scans once, then reuses the stored index while no directory changed", async () => {
		const first = await scan();
		assert.strictEqual(first.reused, false);
		assert.strictEqual(first.index.entries.size, 2);
		const again = await scan();
		assert.strictEqual(again.reused, true);
		assert.deepStrictEqual([...again.index.entries.keys()].sort(), [...first.index.entries.keys()].sort());
	});

	it("survives a restart: a new process reads the file and needs no scan", async () => {
		await scan();
		await settle();
		assert.ok(fs.existsSync(indexCacheFile(f.cache, f.project)));
		resetProjectScanCache(); // a fresh session
		const stored = await peekLocalIndex(f.project, ["force-app"], []);
		assert.strictEqual(stored?.entries.size, 2, "peek paints from the file");
		const r = await scan();
		assert.strictEqual(r.reused, true);
	});

	it("rescans when a file is created, deleted or renamed", async () => {
		await scan();
		const c = path.join(f.classes, "C.cls");
		fs.writeFileSync(c, "public class C {}");
		fs.writeFileSync(`${c}-meta.xml`, "<ApexClass/>");
		const added = await scan();
		assert.strictEqual(added.reused, false);
		assert.ok(added.index.entries.has("ApexClass:C"));
		assert.strictEqual((await scan()).reused, true, "the new state is stored");
		fs.rmSync(c);
		fs.rmSync(`${c}-meta.xml`);
		const removed = await scan();
		assert.strictEqual(removed.reused, false);
		assert.ok(!removed.index.entries.has("ApexClass:C"));
		fs.renameSync(path.join(f.classes, "B.cls-meta.xml"), path.join(f.classes, "B2.cls-meta.xml"));
		assert.strictEqual((await scan()).reused, false);
	});

	it("rescans when a new directory appears anywhere below a package directory", async () => {
		await scan();
		const lwc = path.join(f.project, "force-app", "main", "default", "lwc", "foo");
		fs.mkdirSync(lwc, { recursive: true });
		fs.writeFileSync(path.join(lwc, "foo.js"), "x");
		const r = await scan();
		assert.strictEqual(r.reused, false);
		assert.ok(r.index.entries.has("LightningComponentBundle:foo"));
	});

	it("does not rescan for a plain edit of a file (the file set is the same)", async () => {
		await scan();
		fs.writeFileSync(path.join(f.classes, "A.cls"), "public class A { Integer x; }");
		assert.strictEqual((await scan()).reused, true);
	});

	it("`force` always scans; other package dirs or a different type table invalidate", async () => {
		await scan();
		assert.strictEqual((await scan({ force: true })).reused, false);
		assert.strictEqual((await scanProjectCached(f.project, ["force-app", "other"], [])).reused, false);
		const typed = [type("ApexClass", "classes", "cls")];
		assert.strictEqual((await scanProjectCached(f.project, ["force-app"], typed)).reused, false, "stored without types, now with");
		assert.strictEqual((await scanProjectCached(f.project, ["force-app"], typed)).reused, true);
		assert.strictEqual((await scanProjectCached(f.project, ["force-app"], [])).reused, true, "no types yet: the typed index is kept");
		assert.strictEqual((await scanProjectCached(f.project, ["force-app"], [type("Foo", "foos", "foo")])).reused, false);
	});

	it("shares one run between concurrent callers and hands each its own Map", async () => {
		const [a, b] = await Promise.all([scan(), scan()]);
		assert.notStrictEqual(a.index.entries, b.index.entries);
		a.index.entries.clear();
		assert.strictEqual(b.index.entries.size, 2);
		assert.strictEqual((await scan()).index.entries.size, 2);
	});

	it("an unreadable or foreign index file is ignored (scan instead)", async () => {
		fs.mkdirSync(f.cache, { recursive: true });
		fs.writeFileSync(indexCacheFile(f.cache, f.project), "garbage");
		const r = await scan();
		assert.strictEqual(r.reused, false);
		assert.strictEqual(r.index.entries.size, 2);
	});

	it("stores commit times and the last change info per project, across restarts", async () => {
		await saveCommitSnapshot(f.project, commitSnapshotOf("abc1234", "force-app", new Map([["force-app/x.cls", 5]]), new Map()));
		await saveLocalInfo(f.project, "abc1234", { "ApexClass:A": [100, 0], "ApexClass:B": [200, 1] });
		await flushProjectScanCache();
		assert.ok(fs.existsSync(timesCacheFile(f.cache, f.project)));
		resetProjectScanCache();
		const commits = await loadCommitSnapshot(f.project);
		assert.strictEqual(commits?.head, "abc1234");
		assert.strictEqual(commits?.times["force-app/x.cls"], 5);
		assert.deepStrictEqual(await peekLocalInfo(f.project, ["ApexClass:B", "ApexClass:Z"]), { "ApexClass:B": [200, 1] });
		// Saving the commits again keeps the info (one file, two parts).
		await saveCommitSnapshot(f.project, null);
		await flushProjectScanCache();
		resetProjectScanCache();
		assert.strictEqual(await loadCommitSnapshot(f.project), undefined);
		assert.ok(await peekLocalInfo(f.project, ["ApexClass:A"]));
	});
});
