/**
 * Parse worker pool (server/src/parseWorkerClient.ts), loaded like sobjectStubAsync.test.ts
 * does (transpiled on the fly, outside the tsc rootDir) and driven against a scripted
 * stand-in worker, so scheduling, crashes, termination and reaping are deterministic.
 * The last test starts the real server with a pool of 3 and checks it still exits fast.
 *
 * Stand-in worker protocol: `{id, text}` replies `{id, ok, result: {text, thread}}` after
 * `SLOW:<ms>` (or immediately); text `CRASH` kills the worker thread.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { buildRefFixture, writeRefFixture } from "./helpers/refWorkspace";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ts = require("typescript");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const WORKER_SRC = `
const { parentPort, threadId } = require("worker_threads");
parentPort.on("message", (m) => {
  const t = m.text || "";
  if (t === "CRASH") process.exit(3);
  const reply = () => parentPort.postMessage({ id: m.id, ok: true, result: { text: t, thread: threadId } });
  if (t.startsWith("SLOW:")) setTimeout(reply, parseInt(t.slice(5), 10) || 0);
  else reply();
});
`;

let dir: string;
let mod: any;
let pool: any;

function loadModule(): any {
	const src = path.join(__dirname, "..", "..", "server", "src", "parseWorkerClient.ts");
	const out = ts.transpileModule(fs.readFileSync(src, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
	fs.writeFileSync(path.join(dir, "parseWorkerClient.js"), out.outputText);
	// In-thread fallback stand-in: marks results so tests can tell them from worker results.
	fs.writeFileSync(path.join(dir, "apexSymbols.js"), `exports.parseApex = (t) => ({ text: t, fallback: true });`);
	fs.writeFileSync(path.join(dir, "worker.js"), WORKER_SRC);
	return require(path.join(dir, "parseWorkerClient.js"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parse worker pool", function () {
	this.timeout(15000);

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-pool-"));
		mod = loadModule();
	});
	after(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	beforeEach(() => {
		pool = mod.ParseWorker;
		pool.terminate();
		pool.workerPath = path.join(dir, "worker.js");
		pool.maxWorkers = 3;
		pool.idleMs = 30000;
		// A fresh client state per test (the module singleton is reused).
		pool.disabled = false;
		pool.crashes = 0;
	});
	afterEach(() => {
		pool.terminate();
	});

	it("N concurrent parses with pool size 3 complete correctly, across 3 workers", async () => {
		const texts = Array.from({ length: 12 }, (_, i) => `SLOW:40 #${i}`);
		const res = await Promise.all(texts.map((t) => pool.parseText(t, "background")));
		assert.deepStrictEqual(res.map((r: any) => r.text), texts);
		assert.ok(!res.some((r: any) => r.fallback), "all parsed by workers");
		assert.strictEqual(new Set(res.map((r: any) => r.thread)).size, 3);
		assert.strictEqual(pool.stats.workers, 3);
	});

	it("starts extra workers only when work queues up", async () => {
		const a = await pool.parseText("one");
		assert.strictEqual(a.text, "one");
		assert.strictEqual(pool.stats.workers, 1);
		await pool.parseText("two");
		assert.strictEqual(pool.stats.workers, 1, "sequential parses reuse the first worker");
	});

	it("an interactive request overtakes queued background ones", async () => {
		pool.maxWorkers = 1;
		const order: string[] = [];
		const track = (p: Promise<any>, name: string) => p.then(() => void order.push(name));
		const all = [track(pool.parseText("SLOW:80 blocker", "background"), "blocker")];
		for (let i = 0; i < 5; i++) all.push(track(pool.parseText(`SLOW:5 bg${i}`, "background"), `bg${i}`));
		all.push(track(pool.parseText("SLOW:5 ui", "interactive"), "ui"));
		await Promise.all(all);
		assert.deepStrictEqual(order.slice(0, 2), ["blocker", "ui"], order.join(","));
		assert.deepStrictEqual(order.slice(2), ["bg0", "bg1", "bg2", "bg3", "bg4"], "FIFO within a class");
	});

	it("parseFileLite defaults to background, parseText to interactive", async () => {
		pool.maxWorkers = 1;
		const order: string[] = [];
		const track = (p: Promise<any>, name: string) => p.then(() => void order.push(name));
		const f = path.join(dir, "x.cls");
		fs.writeFileSync(f, "x");
		const all = [track(pool.parseText("SLOW:60 blocker"), "blocker"), track(pool.parseFileLite(f), "file"), track(pool.parseText("doc"), "doc")];
		await Promise.all(all);
		assert.deepStrictEqual(order, ["blocker", "doc", "file"]);
	});

	it("a worker crash fails (falls back) only the in-flight request and the pool continues", async () => {
		pool.maxWorkers = 2;
		const slow = Array.from({ length: 4 }, (_, i) => pool.parseText(`SLOW:30 s${i}`, "background"));
		const crashed = await pool.parseText("CRASH", "background");
		assert.strictEqual(crashed.fallback, true, "in-flight request falls back to the main thread");
		const rest = await Promise.all(slow);
		assert.deepStrictEqual(rest.map((r: any) => r.text), [0, 1, 2, 3].map((i) => `SLOW:30 s${i}`));
		assert.strictEqual(pool.stats.crashes, 1);
		assert.strictEqual(pool.stats.disabled, false);
		const after = await pool.parseText("after");
		assert.strictEqual(after.fallback, undefined, "later parses run on a (new) worker");
		assert.strictEqual(after.text, "after");
	});

	it("repeated crashes disable the pool and parses fall back to the main thread", async () => {
		pool.maxWorkers = 1;
		for (let i = 0; i < 3; i++) assert.strictEqual((await pool.parseText("CRASH")).fallback, true);
		assert.strictEqual(pool.stats.disabled, true);
		assert.strictEqual(pool.offThread, false);
		const r = await pool.parseText("plain");
		assert.strictEqual(r.fallback, true);
	});

	it("falls back to the main thread when the worker file is missing", async () => {
		pool.workerPath = path.join(dir, "nope.js");
		const r = await pool.parseText("x");
		assert.strictEqual(r.fallback, true);
		assert.strictEqual(pool.offThread, false);
	});

	it("terminate() stops all workers and leaves no promise pending", async () => {
		const settled: string[] = [];
		const ps = Array.from({ length: 10 }, (_, i) =>
			pool.parseText(`SLOW:2000 j${i}`, i % 2 ? "background" : "interactive").then(
				() => settled.push("ok"),
				(e: any) => settled.push(e.terminated ? "terminated" : "err"),
			),
		);
		await sleep(100);
		assert.strictEqual(pool.stats.workers, 3);
		assert.ok(pool.stats.queued > 0 && pool.stats.busy === 3, JSON.stringify(pool.stats));
		pool.terminate();
		assert.strictEqual(pool.stats.workers, 0);
		const done = await Promise.race([Promise.all(ps).then(() => true), sleep(1000).then(() => false)]);
		assert.ok(done, "every promise settled");
		assert.deepStrictEqual(new Set(settled), new Set(["terminated"]));
		// The pool is reusable afterwards (lazy restart).
		assert.strictEqual((await pool.parseText("again")).text, "again");
	});

	it("reaps idle workers beyond the first", async () => {
		pool.idleMs = 150;
		await Promise.all(Array.from({ length: 9 }, (_, i) => pool.parseText(`SLOW:30 ${i}`, "background")));
		assert.strictEqual(pool.stats.workers, 3);
		await sleep(600);
		assert.strictEqual(pool.stats.workers, 1, "extra workers terminated, first kept");
		assert.strictEqual((await pool.parseText("still works")).text, "still works");
	});
});

describe("parse worker pool: size", function () {
	let dir2: string;
	let m: any;
	let saved: string | undefined;
	before(() => {
		dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-poolsize-"));
		const prev = dir;
		dir = dir2;
		m = loadModule();
		dir = prev;
	});
	after(() => fs.rmSync(dir2, { recursive: true, force: true }));
	beforeEach(() => {
		saved = process.env.ASFX_PARSE_WORKERS;
		delete process.env.ASFX_PARSE_WORKERS;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.ASFX_PARSE_WORKERS;
		else process.env.ASFX_PARSE_WORKERS = saved;
		m.ParseWorker.configure(undefined);
	});

	it("defaults to 1 without env or option", () => {
		assert.strictEqual(m.poolSize(), 1);
		assert.strictEqual(m.poolSize(undefined), 1);
	});
	it("the option sets the size, clamped to 1..4", () => {
		assert.strictEqual(m.poolSize(3), 3);
		assert.strictEqual(m.poolSize(4), 4);
		assert.strictEqual(m.poolSize(9), 4);
		assert.strictEqual(m.poolSize(0), 1);
		assert.strictEqual(m.poolSize(-2), 1);
		assert.strictEqual(m.poolSize(2.7), 2);
		assert.strictEqual(m.poolSize(NaN), 1);
	});
	it("the env var overrides the option", () => {
		process.env.ASFX_PARSE_WORKERS = "6";
		assert.strictEqual(m.poolSize(2), 6);
		process.env.ASFX_PARSE_WORKERS = "99";
		assert.strictEqual(m.poolSize(2), 16);
	});
	it("a size-1 pool never grows and keeps its only worker", async () => {
		const p = m.ParseWorker;
		p.terminate();
		p.workerPath = path.join(dir2, "worker.js");
		p.maxWorkers = undefined;
		p.idleMs = 100;
		p.disabled = false;
		p.crashes = 0;
		p.configure(1);
		await Promise.all(Array.from({ length: 6 }, (_, i) => p.parseText(`SLOW:20 ${i}`, "background")));
		assert.strictEqual(p.stats.workers, 1);
		await sleep(400);
		assert.strictEqual(p.stats.workers, 1, "last worker is kept");
		p.configure(3);
		await Promise.all(Array.from({ length: 9 }, (_, i) => p.parseText(`SLOW:30 ${i}`, "background")));
		assert.strictEqual(p.stats.workers, 3, "configured size is used");
		p.terminate();
	});
});

describe("parse worker pool: server shutdown", function () {
	it("the server exits within 1 s of shutdown/exit with 3 workers busy", async function () {
		this.timeout(60000);
		const fx = buildRefFixture({ fillers: 600, bulk: 60 });
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-poolexit-")));
		writeRefFixture(root, fx);
		const serverPath = path.join(__dirname, "..", "server.js");
		assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
		const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ASFX_PARSE_WORKERS: "3" } });
		const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
		try {
			conn.onRequest("sfx/objectList", () => ["Account"]);
			conn.onRequest("sfx/describe", () => null);
			conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => names.map(() => null));
			conn.onRequest("sfx/projectInfo", () => ({ namespace: "myns" }));
			conn.onRequest("sfx/objectInfo", () => ({ description: null }));
			conn.onNotification("textDocument/publishDiagnostics", () => undefined);
			conn.onNotification("window/showMessage", () => undefined);
			conn.listen();
			await conn.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions: { apexFeatures: true } });
			await conn.sendNotification("initialized", {});
			const a = fx.anchors.get("DS")!;
			const uri = pathToFileURL(path.join(root, a.file)).href;
			await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: fx.files[a.file] } });
			// Kick off a cold Find References (bulk parses on the workers) and shut down mid-flight.
			conn.sendRequest("textDocument/references", { textDocument: { uri }, position: { line: a.line, character: a.character + 1 }, context: { includeDeclaration: true } }).catch(() => undefined);
			await sleep(400);
			const exited = new Promise<number>((resolve) => child.once("exit", () => resolve(Date.now())));
			await conn.sendRequest("shutdown");
			const t0 = Date.now();
			await conn.sendNotification("exit");
			const t1 = await Promise.race([exited, sleep(3000).then(() => -1)]);
			assert.ok(t1 > 0 && t1 - t0 < 1000, `exit took ${t1 < 0 ? ">3000" : t1 - t0} ms`);
		} finally {
			try { conn.dispose(); } catch { /* ignore */ }
			try { child.kill(); } catch { /* ignore */ }
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
