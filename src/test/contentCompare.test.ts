import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CancelToken, CompareTarget, ContentCompareService, RetrieveReply, RetrieveRequest } from "../utils/contentCompare";
import { innerFilesOfEntry } from "../utils/contentComparePure";
import { buildTypeTable } from "../utils/orgBrowser/localIndex";

const table = buildTypeTable();

interface Fixture {
	root: string;
	project: string;
	pkg: string;
	cache: string;
}

function fixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-cc-"));
	const project = path.join(root, "proj");
	const pkg = path.join(project, "force-app", "main", "default");
	fs.mkdirSync(path.join(pkg, "classes"), { recursive: true });
	fs.writeFileSync(path.join(project, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "62.0" }));
	fs.writeFileSync(path.join(project, ".forceignore"), "**/*.ignored\n");
	return { root, project, pkg, cache: path.join(root, "cache") };
}

function writeClass(f: Fixture, name: string, body: string): CompareTarget {
	const cls = path.join(f.pkg, "classes", `${name}.cls`);
	const meta = `${cls}-meta.xml`;
	fs.writeFileSync(cls, body);
	fs.writeFileSync(meta, "<ApexClass/>");
	const entry = { type: "ApexClass", name, key: `ApexClass:${name}`, files: [cls, meta], primary: cls };
	return { key: entry.key, type: "ApexClass", name, orgLm: 1000, files: innerFilesOfEntry(entry, [f.pkg], table) };
}

/** Fake `sf`: writes the org's copy of each requested component the way `retrieve --output-dir` leaves them. */
class FakeOrg {
	calls: RetrieveRequest[] = [];
	copies = new Map<string, { cls: string; extra?: Record<string, string> }>();
	missing = new Set<string>();
	gate: Promise<void> | undefined;
	async retrieve(req: RetrieveRequest): Promise<RetrieveReply> {
		this.calls.push(req);
		if (this.gate) {
			await new Promise<void>((resolve, reject) => {
				req.token.onCancellationRequested(() => reject(Object.assign(new Error("Command cancelled."), { cancelled: true })));
				void this.gate!.then(resolve);
			});
		}
		const retrieved: { type: string; fullName: string }[] = [];
		const failed: { type: string; fullName: string; error: string }[] = [];
		for (const c of req.components) {
			const org = this.copies.get(c.fullName);
			if (!org || this.missing.has(c.fullName)) {
				failed.push({ ...c, error: "Not returned by the org" });
				continue;
			}
			const dir = path.join(req.outputDir, "classes");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${c.fullName}.cls`), org.cls);
			fs.writeFileSync(path.join(dir, `${c.fullName}.cls-meta.xml`), "<ApexClass/>");
			for (const [rel, body] of Object.entries(org.extra ?? {})) {
				fs.mkdirSync(path.dirname(path.join(req.outputDir, rel)), { recursive: true });
				fs.writeFileSync(path.join(req.outputDir, rel), body);
			}
			retrieved.push(c);
		}
		return { retrieved, failed };
	}
}

function service(f: Fixture, org: FakeOrg, chunkSize = 150, now?: () => number): ContentCompareService {
	return new ContentCompareService({
		cacheRoot: f.cache,
		projectDir: f.project,
		retrieve: (r) => org.retrieve(r),
		table: () => table,
		chunkSize,
		flushDelayMs: 0,
		now,
	});
}

describe("content compare service", () => {
	let f: Fixture;
	beforeEach(() => {
		f = fixture();
	});
	afterEach(() => {
		fs.rmSync(f.root, { recursive: true, force: true });
	});

	it("compares local files with the org copy: same (line endings and trailing blanks ignored) and different", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "public class A {\n}\n");
		const b = writeClass(f, "B", "public class B {}\n");
		org.copies.set("A", { cls: "public class A {  \r\n}\r\n\r\n" });
		org.copies.set("B", { cls: "public class B { /* changed in org */ }\n" });
		const s = service(f, org);
		s.request([a, b]);
		await s.whenIdle();
		const info = s.contentInfo();
		assert.strictEqual(info["ApexClass:A"][0], 1);
		assert.strictEqual(info["ApexClass:B"][0], 2);
		assert.strictEqual(org.calls.length, 1);
		assert.deepStrictEqual(org.calls[0].components.map((c) => `${c.type}:${c.fullName}`).sort(), ["ApexClass:A", "ApexClass:B"]);
	});

	it("runs sf inside a stub project in the cache (never the real project), mirrors its API version and ignore file, and cleans the output", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "x");
		org.copies.set("A", { cls: "x" });
		const s = service(f, org);
		const before = fs.readdirSync(f.pkg);
		s.request([a]);
		await s.whenIdle();
		const req = org.calls[0];
		assert.strictEqual(req.cwd, path.join(f.cache, "stub"));
		assert.ok(req.outputDir.startsWith(req.cwd + path.sep), "the output dir lies inside the stub project");
		assert.ok(!req.cwd.startsWith(f.project));
		const stubCfg = JSON.parse(fs.readFileSync(path.join(req.cwd, "sfdx-project.json"), "utf8"));
		assert.strictEqual(stubCfg.sourceApiVersion, "62.0");
		assert.strictEqual(fs.readFileSync(path.join(req.cwd, ".forceignore"), "utf8"), "**/*.ignored\n");
		assert.ok(!fs.existsSync(req.outputDir), "the run directory is removed");
		assert.deepStrictEqual(fs.readdirSync(f.pkg), before);
		assert.ok(!fs.existsSync(path.join(f.project, ".sf")));
	});

	it("ignores the org's files of OTHER components, but an own file the local side lacks makes it different", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "x");
		org.copies.set("A", { cls: "x", extra: { "objects/Account/fields/Other__c.field-meta.xml": "<f/>" } });
		const s = service(f, org);
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(s.contentInfo()["ApexClass:A"][0], 1);

		const b = writeClass(f, "B", "y");
		fs.rmSync(path.join(f.pkg, "classes", "B.cls-meta.xml"));
		const bOnlyCls = { ...b, files: b.files.filter((x) => x.inner === "B.cls") };
		org.copies.set("B", { cls: "y" });
		s.request([bOnlyCls]);
		await s.whenIdle();
		assert.strictEqual(s.contentInfo()["ApexClass:B"][0], 2); // the org has B.cls-meta.xml too
	});

	it("skips what was compared already, and compares again when the org time or the local contents change", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "v1");
		org.copies.set("A", { cls: "v1" });
		const s = service(f, org);
		s.request([a]);
		await s.whenIdle();
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 1, "unchanged: no second retrieve");

		s.request([{ ...a, orgLm: 2000 }]);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 2, "org time changed");

		fs.writeFileSync(path.join(f.pkg, "classes", "A.cls"), "v2 local");
		s.request([{ ...a, orgLm: 2000 }]);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 3, "local contents changed");
		assert.strictEqual(s.contentInfo()["ApexClass:A"][0], 2);

		s.request([{ ...a, orgLm: 2000 }], true);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 4, "force");
	});

	it("persists the index: a new service knows the results and needs no retrieve", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "same");
		org.copies.set("A", { cls: "same" });
		let t = 5000;
		const s1 = service(f, org, 150, () => t);
		s1.request([a]);
		await s1.whenIdle();
		await s1.flush();
		const org2 = new FakeOrg();
		const s2 = service(f, org2);
		s2.request([a]);
		await s2.whenIdle();
		assert.strictEqual(org2.calls.length, 0);
		assert.strictEqual(s2.contentInfo()["ApexClass:A"][0], 1);
		assert.strictEqual(s2.verifiedSyncAt("ApexClass:A"), 5000);
		t = 0;
	});

	it("keeps the last verified-equal time as baseline when a later compare says different", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "same");
		org.copies.set("A", { cls: "same" });
		let t = 1000;
		const s = service(f, org, 150, () => t);
		s.request([a]);
		await s.whenIdle();
		t = 9000;
		org.copies.set("A", { cls: "org changed" });
		s.request([{ ...a, orgLm: 5000 }]);
		await s.whenIdle();
		const w = s.contentInfo()["ApexClass:A"];
		assert.deepStrictEqual(w, [2, 9000, 1000]);
		assert.strictEqual(s.verifiedSyncAt("ApexClass:A"), 1000);
	});

	it("reports stale results with only the baseline", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "same");
		org.copies.set("A", { cls: "same" });
		const s = service(f, org, 150, () => 1000);
		s.request([a]);
		await s.whenIdle();
		assert.deepStrictEqual((await s.validContentInfo([a]))["ApexClass:A"], [1, 1000, 1000]);
		assert.deepStrictEqual((await s.validContentInfo([{ ...a, orgLm: 2 }]))["ApexClass:A"], [0, 1000, 1000]);
		assert.ok((await s.verifiedEqualNow([a])).has("ApexClass:A"));
		assert.ok(!(await s.verifiedEqualNow([{ ...a, orgLm: 2 }])).has("ApexClass:A"));
	});

	it("a component the org does not return stays uncompared and is counted as failed", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "x");
		const g = writeClass(f, "Gone", "x");
		org.copies.set("A", { cls: "x" });
		const s = service(f, org);
		s.request([a, g]);
		await s.whenIdle();
		assert.strictEqual(s.contentInfo()["ApexClass:A"][0], 1);
		assert.strictEqual(s.contentInfo()["ApexClass:Gone"], undefined);
		assert.strictEqual(s.progress().failed, 1);
	});

	it("never compares a Profile", async () => {
		const org = new FakeOrg();
		const s = service(f, org);
		s.request([{ key: "Profile:Admin", type: "Profile", name: "Admin", orgLm: 1, files: [] }]);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 0);
	});

	it("works through chunks, reports progress and pushes each chunk's results", async () => {
		const org = new FakeOrg();
		const targets: CompareTarget[] = [];
		for (let i = 0; i < 5; i++) {
			targets.push(writeClass(f, `C${i}`, `body ${i}`));
			org.copies.set(`C${i}`, { cls: `body ${i}` });
		}
		const s = service(f, org, 2);
		const updates: string[][] = [];
		const progress: string[] = [];
		s.onDidUpdate((k) => updates.push(k));
		s.onDidProgress((p) => progress.push(`${p.state}:${p.done}/${p.total}`));
		s.request(targets);
		await s.whenIdle();
		assert.strictEqual(org.calls.length, 3);
		assert.deepStrictEqual(updates.map((u) => u.length), [2, 2, 1]);
		assert.ok(progress.includes("running:2/5") && progress.includes("running:4/5") && progress.includes("running:5/5"), progress.join(","));
		assert.strictEqual(progress[progress.length - 1].startsWith("idle:"), true);
	});

	it("pause cancels the running retrieve and keeps the rest queued; resume finishes", async () => {
		const org = new FakeOrg();
		const targets: CompareTarget[] = [];
		for (let i = 0; i < 4; i++) {
			targets.push(writeClass(f, `P${i}`, `b${i}`));
			org.copies.set(`P${i}`, { cls: `b${i}` });
		}
		let release!: () => void;
		org.gate = new Promise<void>((r) => (release = r));
		const s = service(f, org, 2);
		s.request(targets);
		// wait until the first retrieve is in flight
		for (let i = 0; i < 200 && org.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		assert.strictEqual(org.calls.length, 1);
		s.pause();
		for (let i = 0; i < 100 && s.progress().state !== "paused"; i++) await new Promise((r) => setTimeout(r, 5));
		assert.strictEqual(s.progress().state, "paused");
		assert.deepStrictEqual(Object.keys(s.contentInfo()), []);
		org.gate = undefined;
		release();
		s.resume();
		await s.whenIdle();
		assert.strictEqual(Object.keys(s.contentInfo()).length, 4);
		assert.strictEqual(s.progress().state, "idle");
	});

	it("dispose stops the queue", async () => {
		const org = new FakeOrg();
		const a = writeClass(f, "A", "x");
		org.copies.set("A", { cls: "x" });
		const s = service(f, org);
		await s.dispose();
		s.request([a]);
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(org.calls.length, 0);
	});
});

// A type check only: the injected token is what the real runner expects.
const _t: CancelToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
void _t;
