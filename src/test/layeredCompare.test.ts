import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CompareTarget, ContentCompareService, RetrieveReply, RetrieveRequest } from "../utils/contentCompare";
import { digestContent, hashDigests, innerFilesOfEntry } from "../utils/contentComparePure";
import { CompareLayer, layerSummary, runLayers } from "../utils/compareLayersPure";
import { buildTypeTable } from "../utils/orgBrowser/localIndex";
import { LogStore, getSyncEntry, initRetrieveLog, recordSync, resetRetrieveLogForTests, resolveSyncPending } from "../utils/retrieveLog";
import { SyncEntry, decideSync, metaHashOf, resolvePending, splitMetaDigests } from "../utils/syncRecordPure";
import { OrgSourceCandidate, buildToolingQueries, decideTooling, orgDeveloperName, parseToolingRecords, pickCandidate, toolingQuery } from "../utils/toolingComparePure";
import {
	TrackingContext,
	decideTracking,
	isTrackingUnsupported,
	maxRevisionOf,
	parseMaxRevisionFile,
	parseSourceMembers,
	sourceMemberDeltaQuery,
	splitMemberKey,
} from "../utils/sourceTrackingPure";
import { compareSummary, sourceBreakdown } from "../utils/compareStatusPure";

const d = (text: string): string => digestContent(Buffer.from(text, "utf8"));
const table = buildTypeTable();

// ── Layer 1: the sync record ─────────────────────────────────────────────────

describe("sync record (pure)", () => {
	const rec = (o: Partial<SyncEntry> = {}): SyncEntry => ({ at: 10_000, hash: "h1", lm: 5_000, kind: "retrieve", ...o });

	it("decides same only when the org time and the local hash both equal the recorded ones", () => {
		assert.strictEqual(decideSync(rec(), 5_000, "h1"), "same");
		assert.strictEqual(decideSync(rec(), 6_000, "h1"), undefined, "org changed");
		assert.strictEqual(decideSync(rec(), 5_000, "h2"), undefined, "local changed");
		assert.strictEqual(decideSync(undefined, 5_000, "h1"), undefined);
		assert.strictEqual(decideSync(rec({ lm: undefined }), 5_000, "h1"), undefined, "pending");
	});

	it("fills a pending record from the listing, keeps it when not listed, drops it when the org changed after the operation", () => {
		const p = rec({ lm: undefined, at: 10_000 });
		assert.strictEqual(resolvePending(p, 9_000)?.lm, 9_000);
		assert.strictEqual(resolvePending(p, 10_000 + 4_000)?.lm, 14_000, "within the skew allowance");
		assert.strictEqual(resolvePending(p, undefined), p);
		assert.strictEqual(resolvePending(p, 10_000 + 6_000), null);
		const filled = rec();
		assert.strictEqual(resolvePending(filled, 99_999), filled, "a filled record is never changed");
	});

	it("hashes the meta files apart from the body", () => {
		const files = new Map([["A.cls", "t:1"], ["A.cls-meta.xml", "t:2"]]);
		const { body, meta } = splitMetaDigests(files);
		assert.deepStrictEqual([...body.keys()], ["A.cls"]);
		assert.deepStrictEqual([...meta.keys()], ["A.cls-meta.xml"]);
		assert.strictEqual(metaHashOf(files), hashDigests(meta));
		assert.strictEqual(metaHashOf(new Map([["x", "t:1"]])), undefined);
	});
});

describe("sync record (retrieveLog store)", () => {
	const mem = (): LogStore & { data: Record<string, unknown> } => {
		const data: Record<string, unknown> = {};
		return { data, get: <T>(k: string, def: T) => (k in data ? (data[k] as T) : def), update: (k, v) => void (data[k] = v) };
	};
	beforeEach(() => initRetrieveLog(mem(), (org) => org ?? "default"));
	afterEach(() => resetRetrieveLogForTests());

	it("records per org and component (percent-encoded names share the org's spelling) and completes pending records from a listing", () => {
		recordSync("u@x", [{ type: "ApexClass", fullName: "A", hash: "h", lm: 100 }, { type: "Layout", fullName: "Account-Account%20Layout", hash: "l" }], "deploy", new Date(1000));
		recordSync("other", [{ type: "ApexClass", fullName: "A", hash: "o" }], "retrieve", new Date(1000));
		assert.strictEqual(getSyncEntry("u@x", "ApexClass:A")?.lm, 100);
		assert.strictEqual(getSyncEntry("u@x", "ApexClass:A")?.kind, "deploy");
		assert.strictEqual(getSyncEntry("other", "ApexClass:A")?.hash, "o");
		assert.strictEqual(getSyncEntry("u@x", "Layout:Account-Account Layout")?.lm, undefined);
		const n = resolveSyncPending("u@x", new Map([["Layout:Account-Account Layout", 900], ["ApexClass:A", 55]]));
		assert.strictEqual(n, 1, "only the pending one changes");
		assert.strictEqual(getSyncEntry("u@x", "Layout:Account-Account Layout")?.lm, 900);
		assert.strictEqual(getSyncEntry("u@x", "ApexClass:A")?.lm, 100, "a filled record is not overwritten");
		assert.strictEqual(getSyncEntry("other", "ApexClass:A")?.lm, undefined, "other orgs are untouched");
	});

	it("persists in the same store as the retrieve times and reads it back", () => {
		const m = mem();
		initRetrieveLog(m, (org) => org ?? "default");
		recordSync("u@x", [{ type: "ApexClass", fullName: "A", hash: "h", meta: "m", lm: 7 }], "retrieve");
		// a flush happens on a timer: force it through the exported function
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		(require("../utils/retrieveLog") as typeof import("../utils/retrieveLog")).flushRetrieveLog();
		initRetrieveLog(m, (org) => org ?? "default");
		assert.deepStrictEqual(getSyncEntry("u@x", "ApexClass:A")?.meta, "m");
	});

	it("drops a pending record the org changed after (its time is later than the operation)", () => {
		recordSync("u@x", [{ type: "ApexClass", fullName: "A", hash: "h" }], "retrieve", new Date(10_000));
		assert.strictEqual(resolveSyncPending("u@x", new Map([["ApexClass:A", 60_000]])), 1);
		assert.strictEqual(getSyncEntry("u@x", "ApexClass:A"), undefined);
	});
});

// ── Layer 2: Tooling API source ──────────────────────────────────────────────

describe("tooling compare (pure)", () => {
	it("builds the queries per type with the right objects and fields", () => {
		assert.strictEqual(toolingQuery("ApexClass", ["A", "B'x"]), "SELECT Name, NamespacePrefix, Body FROM ApexClass WHERE Name IN ('A','B\\'x')");
		assert.ok(toolingQuery("ApexTrigger", ["T"]).includes("FROM ApexTrigger"));
		assert.ok(toolingQuery("ApexPage", ["P"]).startsWith("SELECT Name, NamespacePrefix, Markup FROM ApexPage"));
		assert.ok(toolingQuery("ApexComponent", ["C"]).includes("Markup FROM ApexComponent"));
		assert.strictEqual(
			toolingQuery("LightningComponentBundle", ["c1"]),
			"SELECT LightningComponentBundle.DeveloperName, LightningComponentBundle.NamespacePrefix, FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundle.DeveloperName IN ('c1')"
		);
		assert.strictEqual(
			toolingQuery("AuraDefinitionBundle", ["a1"]),
			"SELECT AuraDefinitionBundle.DeveloperName, AuraDefinitionBundle.NamespacePrefix, DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundle.DeveloperName IN ('a1')"
		);
	});

	it("batches ~1,000 classes into a handful of requests, each URL below the limit, every name once", () => {
		const targets = Array.from({ length: 1000 }, (_, i) => ({ type: "ApexClass", name: `Some_Typical_Class_Name_${i}`, ns: "" }));
		const qs = buildToolingQueries(targets);
		assert.ok(qs.length >= 2 && qs.length <= 8, `got ${qs.length} requests`);
		for (const q of qs) assert.ok(encodeURIComponent(q.soql).length <= 9000);
		assert.strictEqual(new Set(qs.flatMap((q) => q.names)).size, 1000);
		assert.deepStrictEqual(buildToolingQueries([{ type: "Flow", name: "F", ns: "" }]), [], "types without a Tooling source are not queried");
	});

	it("derives the org's developer name (percent-decoding, own namespace prefix stripped)", () => {
		assert.strictEqual(orgDeveloperName({ type: "ApexClass", name: "Foo", ns: "" }), "Foo");
		assert.strictEqual(orgDeveloperName({ type: "ApexClass", name: "pkg__Foo", ns: "pkg" }), "Foo");
	});

	it("turns Apex records into per-file digests with the local normalisation (CRLF, trailing blanks)", () => {
		const m = parseToolingRecords("ApexClass", [
			{ Name: "A", NamespacePrefix: null, Body: "public class A {  \r\n}\r\n\r\n" },
			{ Name: "Hidden", NamespacePrefix: "pkg", Body: null },
		]);
		assert.strictEqual(m.get("ApexClass:A")![0].files!.get("A.cls"), d("public class A {\n}"));
		assert.strictEqual(m.get("ApexClass:Hidden")![0].files, undefined, "managed code without readable source is undecidable");
		assert.strictEqual(m.get("ApexClass:Hidden")![0].ns, "pkg");
		const p = parseToolingRecords("ApexPage", [{ Name: "P", NamespacePrefix: null, Markup: "<apex:page/>" }]);
		assert.strictEqual(p.get("ApexPage:P")![0].files!.get("P.page"), d("<apex:page/>"));
		const t = parseToolingRecords("ApexTrigger", [{ Name: "T", NamespacePrefix: null, Body: "trigger T on Account (before insert) {}" }]);
		assert.ok(t.get("ApexTrigger:T")![0].files!.has("T.trigger"));
	});

	it("aggregates the files of an LWC bundle (meta file ignored; a file without source makes the bundle undecidable)", () => {
		const rec = (file: string, source: string | null) => ({ LightningComponentBundle: { DeveloperName: "foo", NamespacePrefix: null }, FilePath: file, Source: source });
		const m = parseToolingRecords("LightningComponentBundle", [rec("lwc/foo/foo.js", "export default 1;\n"), rec("lwc/foo/foo.html", "<template></template>"), rec("lwc/foo/foo.js-meta.xml", "<x/>")]);
		const files = m.get("LightningComponentBundle:foo")![0].files!;
		assert.deepStrictEqual([...files.keys()].sort(), ["foo/foo.html", "foo/foo.js"]);
		assert.strictEqual(files.get("foo/foo.js"), d("export default 1;"));
		const bad = parseToolingRecords("LightningComponentBundle", [rec("lwc/foo/foo.js", "x"), rec("lwc/foo/foo.css", null)]);
		assert.strictEqual(bad.get("LightningComponentBundle:foo")![0].files, undefined);
	});

	it("maps Aura definition types to the local file names; an unknown definition type makes the bundle undecidable", () => {
		const rec = (defType: string, source: string) => ({ AuraDefinitionBundle: { DeveloperName: "bar", NamespacePrefix: null }, DefType: defType, Source: source });
		const m = parseToolingRecords("AuraDefinitionBundle", [rec("COMPONENT", "<aura:component/>"), rec("CONTROLLER", "({})"), rec("HELPER", "({})"), rec("STYLE", ".THIS{}"), rec("RENDERER", "({})")]);
		assert.deepStrictEqual([...m.get("AuraDefinitionBundle:bar")![0].files!.keys()].sort(), ["bar/bar.cmp", "bar/bar.css", "bar/barController.js", "bar/barHelper.js", "bar/barRenderer.js"]);
		const u = parseToolingRecords("AuraDefinitionBundle", [rec("COMPONENT", "x"), rec("SOMETHING_NEW", "y")]);
		assert.strictEqual(u.get("AuraDefinitionBundle:bar")![0].files, undefined);
	});

	it("picks the candidate of the right namespace, none when ambiguous", () => {
		const a: OrgSourceCandidate = { ns: "", files: new Map() };
		const b: OrgSourceCandidate = { ns: "pkg", files: new Map() };
		assert.strictEqual(pickCandidate([a, b], ""), a);
		assert.strictEqual(pickCandidate([a, b], "pkg"), b);
		assert.strictEqual(pickCandidate([b], ""), undefined);
		assert.strictEqual(pickCandidate([a, { ...a }], ""), undefined);
		assert.strictEqual(pickCandidate(undefined, ""), undefined);
	});

	describe("decision", () => {
		const local = new Map([["A.cls", d("body")], ["A.cls-meta.xml", d("<meta/>")]]);
		const orgSame = new Map([["A.cls", d("body")]]);
		const sync: SyncEntry = { at: 1, hash: "x", lm: 500, meta: metaHashOf(local), kind: "retrieve" };

		it("a different body is different, whatever the meta files say", () => {
			assert.strictEqual(decideTooling({ local, org: new Map([["A.cls", d("other")]]), orgLm: 500 }), "different");
		});
		it("equal body and meta vouched for by the sync record (org time unchanged, meta unchanged) is same", () => {
			assert.strictEqual(decideTooling({ local, org: orgSame, orgLm: 500, syncRecord: sync }), "same");
		});
		it("equal body but no vouching (no record, org time moved, meta edited locally) is left to the retrieve", () => {
			assert.strictEqual(decideTooling({ local, org: orgSame, orgLm: 500 }), undefined);
			assert.strictEqual(decideTooling({ local, org: orgSame, orgLm: 600, syncRecord: sync }), undefined);
			const edited = new Map(local).set("A.cls-meta.xml", d("<meta v='2'/>"));
			assert.strictEqual(decideTooling({ local: edited, org: orgSame, orgLm: 500, syncRecord: sync }), undefined);
			assert.strictEqual(decideTooling({ local, org: orgSame, orgLm: 500, syncRecord: { ...sync, lm: undefined } }), undefined);
		});
		it("a component without meta files is decided by its body alone", () => {
			assert.strictEqual(decideTooling({ local: new Map([["A.cls", d("body")]]), org: orgSame, orgLm: 1 }), "same");
		});
		it("an unreadable org side is undecided; bundles: every file must match, a missing or extra file is different", () => {
			assert.strictEqual(decideTooling({ local, org: undefined, orgLm: 500 }), undefined);
			const lwcLocal = new Map([["foo/foo.js", d("a")], ["foo/foo.html", d("b")]]);
			assert.strictEqual(decideTooling({ local: lwcLocal, org: new Map([["foo/foo.js", d("a")], ["foo/foo.html", d("b")]]), orgLm: 1 }), "same");
			assert.strictEqual(decideTooling({ local: lwcLocal, org: new Map([["foo/foo.js", d("a")]]), orgLm: 1 }), "different");
			assert.strictEqual(decideTooling({ local: lwcLocal, org: new Map([["foo/foo.js", d("a")], ["foo/foo.html", d("b")], ["foo/foo.css", d("c")]]), orgLm: 1 }), "different");
		});
	});
});

// ── Layer 3: source tracking ─────────────────────────────────────────────────

describe("source tracking (pure)", () => {
	const file = {
		serverMaxRevisionCounter: 50,
		sourceMembers: {
			"ApexClass###A": { serverRevisionCounter: 10, lastRetrievedFromServer: 10, memberType: "ApexClass", isNameObsolete: false },
			"ApexClass###B": { serverRevisionCounter: 20, lastRetrievedFromServer: 15, memberType: "ApexClass", isNameObsolete: false },
			"ApexClass###C": { serverRevisionCounter: 30, lastRetrievedFromServer: null, memberType: "ApexClass", isNameObsolete: false },
			"CustomField__Account.X__c": { serverRevisionCounter: 5, lastRetrievedFromServer: 5, memberType: "CustomField", isNameObsolete: false },
		},
	};

	it("parses maxRevision.json (both key styles); anything else is undefined", () => {
		const t = parseMaxRevisionFile(file)!;
		assert.strictEqual(t.maxRevision, 50);
		assert.strictEqual(t.members.get("ApexClass:A")!.retrieved, 10);
		assert.strictEqual(t.members.get("ApexClass:C")!.retrieved, null);
		assert.ok(t.members.has("CustomField:Account.X__c"));
		assert.strictEqual(parseMaxRevisionFile({}), undefined);
		assert.strictEqual(parseMaxRevisionFile(null), undefined);
		assert.deepStrictEqual(splitMemberKey("ApexClass###Foo"), { type: "ApexClass", name: "Foo" });
		assert.deepStrictEqual(splitMemberKey("ApexClass__Foo"), { type: "ApexClass", name: "Foo" });
		assert.strictEqual(splitMemberKey("nothing"), undefined);
	});

	it("parses SourceMember records, keeps the highest revision per member, and reads the probe", () => {
		const m = parseSourceMembers([
			{ MemberType: "ApexClass", MemberName: "A", RevisionCounter: 60, IsNameObsolete: false },
			{ MemberType: "ApexClass", MemberName: "A", RevisionCounter: 55, IsNameObsolete: false },
			{ MemberType: "Layout", MemberName: "Account-Account%20Layout", RevisionCounter: 61, IsNameObsolete: true },
			{ MemberType: "ApexClass" },
		]);
		assert.strictEqual(m.get("ApexClass:A")!.rev, 60);
		assert.strictEqual(m.get("Layout:Account-Account Layout")!.obsolete, true);
		assert.strictEqual(m.size, 2);
		assert.strictEqual(maxRevisionOf([{ RevisionCounter: 7 }, { RevisionCounter: 9 }]), 9);
		assert.strictEqual(maxRevisionOf([]), undefined);
		assert.strictEqual(sourceMemberDeltaQuery(50), "SELECT MemberType, MemberName, RevisionCounter, IsNameObsolete FROM SourceMember WHERE RevisionCounter > 50");
	});

	it("tells an org without source tracking from a transient failure", () => {
		assert.strictEqual(isTrackingUnsupported(400, "sObject type 'SourceMember' is not supported."), true);
		assert.strictEqual(isTrackingUnsupported(400, "[{\"errorCode\":\"INVALID_TYPE\"}]"), true);
		assert.strictEqual(isTrackingUnsupported(503, "INVALID_TYPE"), false);
		assert.strictEqual(isTrackingUnsupported(undefined, "ETIMEDOUT"), false);
	});

	describe("decision", () => {
		const ctx = (changed: [string, number][] = [], incomplete = false): TrackingContext => ({
			local: parseMaxRevisionFile(file)!,
			changedInOrg: new Map(changed.map(([k, rev]) => [k, { rev, obsolete: false }])),
			incomplete,
		});
		const rec = (hash = "h"): SyncEntry => ({ at: 1, hash, lm: 1, kind: "deploy" });

		it("same: retrieved at the org's revision, unchanged in the org since, local contents as recorded", () => {
			assert.strictEqual(decideTracking("ApexClass:A", ctx(), rec(), "h"), "same");
		});
		it("undecided: changed in the org, behind the CLI's revision, never retrieved, unknown member, local edit, no record, cut-off delta", () => {
			assert.strictEqual(decideTracking("ApexClass:A", ctx([["ApexClass:A", 60]]), rec(), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:B", ctx(), rec(), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:C", ctx(), rec(), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:Z", ctx(), rec(), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:A", ctx(), rec("old"), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:A", ctx(), undefined, "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:A", ctx([], true), rec(), "h"), undefined);
			assert.strictEqual(decideTracking("ApexClass:A", undefined, rec(), "h"), undefined);
		});
	});
});

// ── Orchestration ────────────────────────────────────────────────────────────

describe("layer orchestration", () => {
	type It = { key: string };
	const items: It[] = ["a", "b", "c", "d", "e"].map((key) => ({ key }));
	const layer = (name: "sync" | "tooling" | "tracking", decides: Record<string, "same" | "different">, batch?: number): CompareLayer<It> & { seen: string[][] } => {
		const seen: string[][] = [];
		return {
			name,
			batch,
			seen,
			async run(its) {
				seen.push(its.map((i) => i.key));
				return new Map(its.filter((i) => decides[i.key]).map((i) => [i.key, decides[i.key]]));
			},
		};
	};
	let t = 0;
	const opts = (log: string[], stopped = () => false) => ({
		now: () => (t += 5),
		isStopped: stopped,
		onDecided: (l: string, m: Map<string, string>) => void log.push(`${l}:${[...m.keys()].join("")}`),
	});

	it("passes undecided components from layer to layer; what no layer decides is returned for the retrieve", async () => {
		const log: string[] = [];
		const l1 = layer("sync", { a: "same" });
		const l2 = layer("tooling", { b: "different", c: "same" });
		const l3 = layer("tracking", { d: "same" });
		const r = await runLayers(items, [l1, l2, l3], opts(log));
		assert.deepStrictEqual(l1.seen, [["a", "b", "c", "d", "e"]]);
		assert.deepStrictEqual(l2.seen, [["b", "c", "d", "e"]]);
		assert.deepStrictEqual(l3.seen, [["d", "e"]]);
		assert.deepStrictEqual(r.undecided.map((i) => i.key), ["e"]);
		assert.deepStrictEqual(log, ["sync:a", "tooling:bc", "tracking:d"]);
		assert.deepStrictEqual(r.stats.map((s) => [s.name, s.input, s.decided]), [["sync", 5, 1], ["tooling", 4, 2], ["tracking", 2, 1]]);
		assert.strictEqual(r.stopped, false);
	});

	it("runs a layer in batches and reports each batch", async () => {
		const log: string[] = [];
		const l = layer("tooling", { a: "same", d: "same" }, 2);
		const r = await runLayers(items, [l], opts(log));
		assert.deepStrictEqual(l.seen, [["a", "b"], ["c", "d"], ["e"]]);
		assert.deepStrictEqual(log, ["tooling:a", "tooling:d"]);
		assert.deepStrictEqual(r.undecided.map((i) => i.key), ["b", "c", "e"]);
	});

	it("a layer that fails leaves its input to the next layers (and the retrieve)", async () => {
		const log: string[] = [];
		const boom: CompareLayer<It> = { name: "tooling", async run() { throw new Error("HTTP 403"); } };
		const l3 = layer("tracking", { a: "same" });
		const r = await runLayers(items, [boom, l3], opts(log));
		assert.strictEqual(r.stats[0].error, "HTTP 403");
		assert.deepStrictEqual(l3.seen[0], ["a", "b", "c", "d", "e"]);
		assert.deepStrictEqual(r.undecided.map((i) => i.key), ["b", "c", "d", "e"]);
	});

	it("stops between batches / layers when paused or cancelled, returning everything not decided", async () => {
		const log: string[] = [];
		let stop = false;
		const l1 = layer("sync", { a: "same" }, 2);
		const o = opts(log, () => stop);
		const inner = o.onDecided;
		o.onDecided = (l, m) => {
			inner(l, m);
			stop = true;
		};
		const r = await runLayers(items, [l1, layer("tooling", { b: "same" })], o);
		assert.strictEqual(r.stopped, true);
		assert.deepStrictEqual(l1.seen, [["a", "b"]]);
		assert.deepStrictEqual(r.undecided.map((i) => i.key), ["b", "c", "d", "e"]);
	});

	it("summarises the counts per layer", () => {
		assert.strictEqual(layerSummary({ sync: 512, tooling: 180, tracking: 0, retrieve: 40 }), "512 sync · 180 tooling · 40 retrieve");
		assert.strictEqual(layerSummary({}), "");
	});

	it("counts the verified results per deciding layer for the tooltip (a result without source was made by a retrieve)", () => {
		const info = { a: [1, 1, 1, 1], b: [2, 1, 0, 2], c: [1, 1, 1, 4], d: [1, 1, 1] as [number, number, number], e: [0, 1, 1] as [number, number, number] };
		assert.deepStrictEqual(sourceBreakdown(info as never, ["a", "b", "c", "d", "e", "zz"]), { sync: 1, tooling: 1, tracking: 0, retrieve: 2 });
		assert.deepStrictEqual(compareSummary(info as never, ["a", "e"]), { verified: 1, lastAt: 1 });
	});
});

// ── The service with the layers ──────────────────────────────────────────────

describe("content compare service: layers", () => {
	let root: string;
	let project: string;
	let pkg: string;
	let cache: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-layers-"));
		project = path.join(root, "proj");
		pkg = path.join(project, "force-app", "main", "default");
		fs.mkdirSync(path.join(pkg, "classes"), { recursive: true });
		fs.writeFileSync(path.join(project, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }));
		cache = path.join(root, "cache");
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	function cls(name: string, body: string, orgLm = 1000): CompareTarget {
		const c = path.join(pkg, "classes", `${name}.cls`);
		fs.writeFileSync(c, body);
		fs.writeFileSync(`${c}-meta.xml`, "<ApexClass/>");
		const e = { type: "ApexClass", name, key: `ApexClass:${name}`, files: [c, `${c}-meta.xml`], primary: c };
		return { key: e.key, type: "ApexClass", name, orgLm, files: innerFilesOfEntry(e, [pkg], table) };
	}
	const hashOf = (t: CompareTarget): string => {
		const m = new Map<string, string>();
		for (const f of t.files) m.set(f.inner, digestContent(fs.readFileSync(f.abs)));
		return hashDigests(m);
	};

	class Retriever {
		calls: RetrieveRequest[] = [];
		orgCls = new Map<string, string>();
		async retrieve(req: RetrieveRequest): Promise<RetrieveReply> {
			this.calls.push(req);
			const retrieved: { type: string; fullName: string }[] = [];
			for (const c of req.components) {
				fs.mkdirSync(path.join(req.outputDir, "classes"), { recursive: true });
				fs.writeFileSync(path.join(req.outputDir, "classes", `${c.fullName}.cls`), this.orgCls.get(c.fullName) ?? "");
				fs.writeFileSync(path.join(req.outputDir, "classes", `${c.fullName}.cls-meta.xml`), "<ApexClass/>");
				retrieved.push(c);
			}
			return { retrieved, failed: [] };
		}
	}

	function svc(r: Retriever, extra: Partial<ConstructorParameters<typeof ContentCompareService>[0]> = {}): ContentCompareService {
		return new ContentCompareService({ cacheRoot: cache, projectDir: project, retrieve: (q) => r.retrieve(q), table: () => table, flushDelayMs: 0, ...extra });
	}

	it("a matching sync record decides without any org call; the result carries the source and is solid for the grid", async () => {
		const r = new Retriever();
		const a = cls("A", "same body");
		const rec: SyncEntry = { at: 1, hash: hashOf(a), lm: 1000, kind: "deploy" };
		const logs: string[] = [];
		const s = svc(r, { syncRecord: (l) => (l === "ApexClass:A" ? rec : undefined), log: (l) => logs.push(l) });
		const progress: string[] = [];
		s.onDidProgress((p) => progress.push(`${p.state}:${p.done}/${p.total}`));
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(r.calls.length, 0);
		assert.deepStrictEqual(s.contentInfo()["ApexClass:A"].slice(0, 1).concat(s.contentInfo()["ApexClass:A"][3] as number), [1, 1], "same, source 1 = sync");
		assert.ok(progress.includes("running:1/1"));
		assert.ok(logs.some((l) => /1 sync/.test(l)), logs.join("\n"));
		assert.deepStrictEqual([...(await s.verifiedEqualNow([a]))], ["ApexClass:A"]);
	});

	it("only one side changed: the sync record leaves it to the next layers; it flows to the retrieve", async () => {
		const r = new Retriever();
		r.orgCls.set("A", "edited locally");
		const a = cls("A", "same body");
		const rec: SyncEntry = { at: 1, hash: hashOf(a), lm: 1000, kind: "retrieve" };
		fs.writeFileSync(path.join(pkg, "classes", "A.cls"), "edited locally");
		const s = svc(r, { syncRecord: () => rec });
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(r.calls.length, 1);
		const w = s.contentInfo()["ApexClass:A"];
		assert.strictEqual(w[0], 1);
		assert.strictEqual(w[3], 4, "decided by the retrieve");
	});

	it("tooling decides code components (same / different); the rest of the batch is retrieved", async () => {
		const r = new Retriever();
		r.orgCls.set("A", "alpha");
		const a = cls("A", "alpha");
		const b = cls("B", "beta local");
		const c = cls("C", "gamma");
		r.orgCls.set("C", "gamma");
		const seen: string[][] = [];
		const s = svc(r, {
			toolingSources: async (targets) => {
				seen.push(targets.map((t) => t.name));
				return new Map<string, OrgSourceCandidate[]>([
					["ApexClass:A", [{ ns: "", files: new Map([["A.cls", d("alpha")]]) }]],
					["ApexClass:B", [{ ns: "", files: new Map([["B.cls", d("beta ORG")]]) }]],
					// C: hidden source → undecided
					["ApexClass:C", [{ ns: "", files: undefined }]],
				]);
			},
		});
		s.request([a, b, c]);
		await s.whenIdle();
		assert.deepStrictEqual(seen, [["A", "B", "C"]]);
		const info = s.contentInfo();
		assert.strictEqual(info["ApexClass:B"][0], 2, "different from the Tooling source");
		assert.strictEqual(info["ApexClass:B"][3], 2);
		assert.strictEqual(info["ApexClass:A"][3], 4, "equal body without a vouched meta file goes to the retrieve");
		assert.deepStrictEqual(r.calls[0].components.map((x) => x.fullName).sort(), ["A", "C"]);
		assert.strictEqual(info["ApexClass:C"][3], 4);
	});

	it("tooling with a vouching sync record decides same without a retrieve; non-code types never reach it", async () => {
		const r = new Retriever();
		const a = cls("A", "alpha");
		const metaOnly = new Map<string, string>();
		for (const f of a.files) if (f.inner.endsWith("-meta.xml")) metaOnly.set(f.inner, digestContent(fs.readFileSync(f.abs)));
		const rec: SyncEntry = { at: 1, hash: "other", lm: 1000, meta: hashDigests(metaOnly), kind: "retrieve" };
		const flow: CompareTarget = { key: "Flow:F", type: "Flow", name: "F", orgLm: 1, files: [] };
		let asked: string[] = [];
		const s = svc(r, {
			syncRecord: (l) => (l === "ApexClass:A" ? rec : undefined),
			toolingSources: async (t) => {
				asked = t.map((x) => x.type);
				return new Map([["ApexClass:A", [{ ns: "", files: new Map([["A.cls", d("alpha")]]) }]]]);
			},
		});
		s.request([a, flow]);
		await s.whenIdle();
		assert.deepStrictEqual(asked, ["ApexClass"]);
		assert.strictEqual(r.calls.length, 0);
		assert.deepStrictEqual([s.contentInfo()["ApexClass:A"][0], s.contentInfo()["ApexClass:A"][3]], [1, 2]);
	});

	it("a failing Tooling call does not fail the compare: everything flows to the retrieve", async () => {
		const r = new Retriever();
		r.orgCls.set("A", "alpha");
		const a = cls("A", "alpha");
		const logs: string[] = [];
		const s = svc(r, { toolingSources: async () => { throw new Error("HTTP 400 INVALID_FIELD"); }, log: (l) => logs.push(l) });
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(r.calls.length, 1);
		assert.strictEqual(s.contentInfo()["ApexClass:A"][0], 1);
		assert.ok(logs.some((l) => /tooling 0\/1.*failed: HTTP 400/.test(l)), logs.join("\n"));
	});

	it("source tracking decides what the earlier layers left (changed members stay undecided); progress counts every layer", async () => {
		const r = new Retriever();
		r.orgCls.set("B", "b");
		const a = cls("A", "a");
		const b = cls("B", "b");
		const ctx: TrackingContext = {
			local: parseMaxRevisionFile({
				serverMaxRevisionCounter: 9,
				sourceMembers: {
					"ApexClass###A": { serverRevisionCounter: 3, lastRetrievedFromServer: 3, memberType: "ApexClass", isNameObsolete: false },
					"ApexClass###B": { serverRevisionCounter: 4, lastRetrievedFromServer: 4, memberType: "ApexClass", isNameObsolete: false },
				},
			})!,
			changedInOrg: new Map([["ApexClass:B", { rev: 12, obsolete: false }]]),
		};
		const recs: Record<string, SyncEntry> = {
			"ApexClass:A": { at: 1, hash: hashOf(a), lm: 999, kind: "deploy" }, // org time moved: the sync layer cannot decide
			"ApexClass:B": { at: 1, hash: hashOf(b), lm: 999, kind: "deploy" },
		};
		const last: string[] = [];
		const s = svc(r, { syncRecord: (l) => recs[l], trackingContext: async () => ctx });
		s.onDidProgress((p) => last.push(`${p.done}/${p.total}`));
		s.request([a, b]);
		await s.whenIdle();
		assert.strictEqual(s.contentInfo()["ApexClass:A"][3], 3, "A: tracking");
		assert.strictEqual(s.contentInfo()["ApexClass:B"][3], 4, "B: changed in the org, compared by retrieve");
		assert.strictEqual(r.calls.length, 1);
		assert.deepStrictEqual(r.calls[0].components.map((x) => x.fullName), ["B"]);
		assert.strictEqual(last[last.length - 1], "2/2");
	});

	it("cancel stops across layers: nothing is retrieved, nothing is recorded after it", async () => {
		const r = new Retriever();
		const a = cls("A", "a");
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const s = svc(r, {
			toolingSources: async () => {
				await gate;
				return new Map([["ApexClass:A", [{ ns: "", files: new Map([["A.cls", d("a")]]) }]]]);
			},
		});
		s.request([a]);
		await new Promise((res) => setTimeout(res, 30));
		s.cancelAll();
		release();
		await s.whenIdle();
		assert.strictEqual(r.calls.length, 0);
		assert.deepStrictEqual(s.contentInfo(), {});
	});

	it("without layers (none injected) behaves as before: everything is retrieved", async () => {
		const r = new Retriever();
		r.orgCls.set("A", "a");
		const a = cls("A", "a");
		const s = svc(r);
		s.request([a]);
		await s.whenIdle();
		assert.strictEqual(r.calls.length, 1);
		assert.strictEqual(s.contentInfo()["ApexClass:A"][3], 4);
	});
});
