/**
 * Ground-truth tests for Go to Definition on Apex (language server).
 *
 * The workspace comes from helpers/defWorkspace.ts: every use of a member is marked and
 * paired with its declaration NAME, so each query asserts the exact target uri + range
 * across local calls, statics, receiver chains, inheritance / overrides, overloads (by
 * argument count and argument types), constructors, properties, enums, inner and
 * namespaced types, case-different names, unopened target files, an unsaved target
 * buffer, triggers, test classes, SOQL binds, string concatenations and a file with a
 * syntax error. A 2000-class workspace checks precision and the warm latency budget.
 * Set DEF_REPORT=1 to print the per-category results.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import { writeRefFixture, buildRefFixture, RefFixture, ExpLoc } from "./helpers/refWorkspace";
import { buildDefFixture, targetOf } from "./helpers/defWorkspace";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

interface Server {
	conn: any;
	child: cp.ChildProcess;
	root: string;
	fx: RefFixture;
	opened: Set<string>;
}

async function startServer(fx: RefFixture): Promise<Server> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-defs-")));
	writeRefFixture(root, fx);
	const serverPath = path.join(__dirname, "..", "server.js");
	assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
	const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
	const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
	conn.onRequest("sfx/objectList", () => ["Account", "Contact"]);
	conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) =>
		sobject === "Account" ? { name: "Account", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }], childRelationships: [] } : null,
	);
	conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => names.map(() => null));
	conn.onRequest("sfx/projectInfo", () => ({ namespace: "myns" }));
	conn.onRequest("sfx/objectInfo", () => ({ description: null }));
	conn.onNotification("textDocument/publishDiagnostics", () => undefined);
	conn.onNotification("window/showMessage", () => undefined);
	conn.listen();
	await conn.sendRequest("initialize", {
		processId: process.pid,
		rootUri: pathToFileURL(root).href,
		capabilities: {},
		initializationOptions: { apexFeatures: true },
	});
	await conn.sendNotification("initialized", {});
	const s: Server = { conn, child, root, fx, opened: new Set() };
	for (const [rel, text] of Object.entries(fx.buffers)) await open(s, rel, text);
	return s;
}

function stopServer(s: Server | undefined): void {
	if (!s) return;
	try { s.conn.dispose(); } catch { /* ignore */ }
	try { s.child.kill(); } catch { /* ignore */ }
	try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const uriOf = (s: Server, rel: string) => pathToFileURL(path.join(s.root, rel)).href;
const relOf = (s: Server, uri: string) => path.relative(s.root, fileURLToPath(uri));

async function open(s: Server, rel: string, text?: string): Promise<void> {
	if (s.opened.has(rel)) return;
	s.opened.add(rel);
	await s.conn.sendNotification("textDocument/didOpen", {
		textDocument: { uri: uriOf(s, rel), languageId: "apex", version: 1, text: text ?? s.fx.files[rel] },
	});
}

type Got = { file: string; line: number; character: number; length: number };
const fmt = (l: { file: string; line: number; character: number; length?: number } | undefined) =>
	l ? `${path.basename(l.file)}:${l.line + 1}:${l.character + 1}${l.length !== undefined ? "+" + l.length : ""}` : "none";

/** Go to definition at `delta` characters into the anchor (default: one in). */
async function defAt(s: Server, anchor: string, delta = 1): Promise<{ got: Got[]; ms: number }> {
	const a = s.fx.anchors.get(anchor);
	assert.ok(a, `anchor ${anchor}`);
	await open(s, a.file);
	const t0 = Date.now();
	const res = await s.conn.sendRequest("textDocument/definition", {
		textDocument: { uri: uriOf(s, a.file) },
		position: { line: a.line, character: a.character + delta },
	});
	const ms = Date.now() - t0;
	const list: any[] = res == null ? [] : Array.isArray(res) ? res : [res];
	const got = list.map((l) => {
		const range = l.range ?? l.targetSelectionRange;
		return { file: relOf(s, l.uri ?? l.targetUri), line: range.start.line, character: range.start.character, length: range.end.character - range.start.character };
	});
	return { got, ms };
}

const sameAs = (g: Got, e: ExpLoc) => g.file === e.file && g.line === e.line && g.character === e.character && g.length === e.length;

/** Test-class / category of a use anchor `c.KEY.tag`. */
function categoryOf(anchor: string): string {
	const tag = anchor.split(".")[2] ?? "";
	const m = /^[a-z]+/.exec(tag)![0];
	const table: Record<string, string> = {
		new: "constructors",
		i: "instance receivers (local/param/field/property, case-insensitive)",
		h: "inherited methods, interface receivers",
		ch: "receiver chains (calls, indexing, generics, for-each)",
		s: "statics (class, subclass, namespaced, case-insensitive)",
		p: "properties and fields",
		in: "inner classes",
		e: "enums",
		o: "overloads (count and argument types)",
		f: "missing member: falls back to the receiver's class",
		q: "SOQL binds / string concatenation",
		b: "unsaved edits in an open target",
		se: "syntax error elsewhere in the file",
		t: "test classes",
		tr: "triggers",
		run: "this / super / bare calls",
		self: "this / super / bare calls",
	};
	return table[m] ?? m;
}

const usesOf = (fx: RefFixture) => [...fx.anchors.keys()].filter((k) => k.startsWith("c."));

describe("definition: ground truth", function () {
	this.timeout(60000);
	let s: Server;
	before(async function () {
		this.timeout(60000);
		s = await startServer(buildDefFixture());
	});
	after(() => stopServer(s));

	const results = new Map<string, { pass: number; fail: string[] }>();
	after(() => {
		if (!process.env.DEF_REPORT) return;
		for (const [cat, r] of [...results].sort()) console.log(`  ${r.fail.length ? "FAIL" : "ok  "} ${cat}: ${r.pass}/${r.pass + r.fail.length}${r.fail.length ? "  " + r.fail.slice(0, 6).join(" | ") : ""}`);
	});

	it("every use lands on the exact declaration name (all categories)", async () => {
		const byCat = new Map<string, string[]>();
		for (const anchor of usesOf(s.fx)) {
			const exp = targetOf(s.fx, anchor);
			assert.ok(exp, `target for ${anchor}`);
			const { got } = await defAt(s, anchor);
			const cat = categoryOf(anchor);
			const r = results.get(cat) ?? { pass: 0, fail: [] };
			results.set(cat, r);
			if (got.length === 1 && sameAs(got[0], exp)) r.pass++;
			else {
				r.fail.push(`${anchor} -> ${got.map(fmt).join(",") || "none"} (want ${fmt(exp)})`);
				const l = byCat.get(cat) ?? [];
				l.push(r.fail[r.fail.length - 1]);
				byCat.set(cat, l);
			}
		}
		assert.deepStrictEqual(Object.fromEntries(byCat), {});
	});

	it("an unresolvable receiver never lands on a same-named member of another type", async () => {
		for (const a of [...s.fx.anchors.keys()].filter((k) => k.startsWith("x."))) {
			const { got } = await defAt(s, a);
			assert.deepStrictEqual(got.map(fmt), [], a);
		}
	});

	it("the cursor may be anywhere on the identifier (start, middle, end)", async () => {
		for (const anchor of ["c.dspeak.i1", "c.kind.s5", "c.over1s.o3", "c.bark.ch9", "c.dctor1.new1", "c.red.e2", "c.aname.q1", "c.speak.ch15"]) {
			const a = s.fx.anchors.get(anchor)!;
			const exp = targetOf(s.fx, anchor)!;
			for (const delta of [0, Math.floor(a.length / 2), a.length]) {
				const { got } = await defAt(s, anchor, delta);
				assert.ok(got.length === 1 && sameAs(got[0], exp), `${anchor}+${delta}: ${got.map(fmt).join(",")} want ${fmt(exp)}`);
			}
		}
	});

	it("a declaration name resolves to itself, a closed target is found without being opened", async () => {
		const { got } = await defAt(s, "d.dspeak");
		assert.ok(got.length === 1 && sameAs(got[0], s.fx.anchors.get("d.dspeak")!));
		assert.ok(!s.opened.has(s.fx.anchors.get("d.holder")!.file), "Holder.cls (target of many calls) stays closed");
	});

	it("follows unsaved edits made after the target was indexed", async () => {
		const edited = path.join(s.root, "force-app/main/default/classes/Edited.cls");
		const uri = pathToFileURL(edited).href;
		const text = fs.readFileSync(edited, "utf8");
		// The buffer is open from the start (it differs from disk); now type more above the method.
		const cur = (s.fx.buffers["force-app/main/default/classes/Edited.cls"] as string);
		const next = "// three\n// more\n" + cur;
		await s.conn.sendNotification("textDocument/didChange", {
			textDocument: { uri, version: 2 },
			contentChanges: [{ text: next }],
		});
		const { got } = await defAt(s, "c.fresh.b1");
		assert.strictEqual(got.length, 1);
		const exp = s.fx.anchors.get("d.fresh")!;
		assert.strictEqual(got[0].line, exp.line + 2, "range comes from the edited buffer, not the disk or the first buffer");
		assert.ok(text.length > 0);
	});
});

describe("definition: 2000-class workspace", function () {
	this.timeout(180000);
	let s: Server;
	before(async function () {
		this.timeout(180000);
		s = await startServer(buildDefFixture({ fillers: 2000 }));
	});
	after(() => stopServer(s));

	it("stays exact next to 2000 classes that reuse the member names, cold < 2 s, warm p95 < 50 ms", async () => {
		const uses = usesOf(s.fx);
		const cold = await defAt(s, "c.dspeak.i1");
		assert.ok(cold.ms < 2000, `cold definition took ${cold.ms} ms`);
		const times: number[] = [];
		const wrong: string[] = [];
		for (let round = 0; round < 3; round++) {
			for (const anchor of uses) {
				const exp = targetOf(s.fx, anchor)!;
				const { got, ms } = await defAt(s, anchor);
				if (round > 0) times.push(ms);
				if (!(got.length === 1 && sameAs(got[0], exp))) wrong.push(`${anchor} -> ${got.map(fmt).join(",") || "none"} (want ${fmt(exp)})`);
			}
		}
		times.sort((a, b) => a - b);
		const p95 = times[Math.floor(times.length * 0.95)];
		if (process.env.DEF_REPORT) console.log(`  latency (2000 classes): cold ${cold.ms} ms, warm p50 ${times[times.length >> 1]} ms, p95 ${p95} ms, max ${times[times.length - 1]} ms`);
		assert.deepStrictEqual([...new Set(wrong)], []);
		assert.ok(p95 < 50, `warm p95 ${p95} ms`);
	});
});

describe("definition: overloads that differ in generic type arguments", function () {
	this.timeout(60000);
	let s: Server;
	before(async function () {
		this.timeout(60000);
		s = await startServer(buildRefFixture());
	});
	after(() => stopServer(s));

	const SYMS = ["GLS", "GLI", "GMA", "GMS", "GQA", "GQC"];

	it("every proven call lands on the overload with exactly that parameterised type", async () => {
		const wrong: string[] = [];
		let checked = 0;
		for (const sym of SYMS) {
			const decl = s.fx.anchors.get(sym)!;
			for (const use of s.fx.expected.get(sym)!.filter((e) => e.cat !== "decl" && e.cat !== "undetermined")) {
				const { got } = await defAtLoc(s, use);
				checked++;
				if (!(got.length === 1 && sameAs(got[0], { ...decl, cat: "decl" }))) wrong.push(`${sym}:${use.cat} -> ${got.map(fmt).join(",") || "none"}`);
			}
		}
		assert.ok(checked >= 13, `checked ${checked} calls`);
		assert.deepStrictEqual(wrong, []);
	});

	it("an argument whose generic arguments are unknown takes the first declared overload", async () => {
		const first = s.fx.anchors.get("GLS")!;
		const use = s.fx.expected.get("GLS")!.find((e) => e.cat === "undetermined")!;
		const { got } = await defAtLoc(s, use);
		assert.ok(got.length === 1 && sameAs(got[0], { ...first, cat: "decl" }), got.map(fmt).join(","));
		const firstQ = s.fx.anchors.get("GQA")!;
		const q = await defAtLoc(s, s.fx.expected.get("GQA")!.find((e) => e.cat === "undetermined")!);
		assert.ok(q.got.length === 1 && sameAs(q.got[0], { ...firstQ, cat: "decl" }));
	});
});

/** Go to definition at the start (+1) of an expected-reference span. */
async function defAtLoc(s: Server, loc: ExpLoc): Promise<{ got: Got[] }> {
	await open(s, loc.file);
	const res = await s.conn.sendRequest("textDocument/definition", {
		textDocument: { uri: uriOf(s, loc.file) },
		position: { line: loc.line, character: loc.character + 1 },
	});
	const list: any[] = res == null ? [] : Array.isArray(res) ? res : [res];
	return {
		got: list.map((l) => {
			const range = l.range ?? l.targetSelectionRange;
			return { file: relOf(s, l.uri ?? l.targetUri), line: range.start.line, character: range.start.character, length: range.end.character - range.start.character };
		}),
	};
}
