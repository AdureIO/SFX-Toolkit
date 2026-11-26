/**
 * Content diff of local components against the org's copy. One service per (project, org), used by Deploy &
 * Retrieve Metadata.
 *
 * Org copies come from `sf project retrieve start --output-dir` run inside a small STUB project in the cache
 * directory, never in the real project: `sf` insists on running in an SFDX project and on an `--output-dir`
 * inside it, and in a stub its source tracking (shadow repo, SourceMember bookkeeping) lands in the stub too.
 * The real project's files and tracking state are never touched.
 *
 * No `vscode` import: the retrieve function is injected, so the queue, the index and the comparison are
 * unit-testable with a fake retriever.
 */
import * as fs from "fs";
import * as path from "path";
import { ContentInfoMap, CompareProgress } from "./compareStatusPure";
import { readGzipJson, writeGzipJson } from "./diskCache";
import {
	CompareIndexFile,
	IndexEntry,
	NOT_COMPARABLE_TYPES,
	compareDigests,
	digestContent,
	groupByComponent,
	hashDigests,
	lookupKeyOf,
	needsCompare,
	nextEntry,
	orgCopyDirName,
	requestNameOf,
	toWire,
	verifiedSyncAt,
} from "./contentComparePure";
import { TypeTable } from "./orgBrowser/localIndex";

/** The component an org copy is asked for (`fetchOrgCopy`). */
export interface OrgCopyTarget {
	type: string;
	/** Name as the local index or the org listing has it (percent-encoded file names are decoded). */
	name: string;
}

/** One local component that exists in the org too. */
export interface CompareTarget {
	/** The panel's row key (`Type:Name` as the local index names it). */
	key: string;
	type: string;
	/** Name as the local index has it (percent-encoded file name for some types); the org name is derived from it. */
	name: string;
	/** The org's lastModifiedDate (epoch ms). */
	orgLm: number;
	/** The component's local files. */
	files: { inner: string; abs: string }[];
}

/** What the service asks the injected retriever to do. */
export interface RetrieveRequest {
	components: { type: string; fullName: string }[];
	/** Absolute output directory (inside `cwd`). */
	outputDir: string;
	/** Directory to run `sf` in: the stub project. */
	cwd: string;
	token: CancelToken;
}

export interface RetrieveReply {
	retrieved: { type: string; fullName: string }[];
	failed: { type: string; fullName: string; error: string }[];
}

/** Structurally a `vscode.CancellationToken`. */
export interface CancelToken {
	isCancellationRequested: boolean;
	onCancellationRequested: (listener: () => void) => { dispose(): void };
}

export interface CompareServiceDeps {
	/** `…/content-compare/<org>/<project hash>`: index, stub project and per-run output. */
	cacheRoot: string;
	/** The real project (its `sourceApiVersion` and `.forceignore` are mirrored into the stub). */
	projectDir: string;
	retrieve(req: RetrieveRequest): Promise<RetrieveReply>;
	table(): TypeTable;
	now?: () => number;
	/** Components per retrieve (default 150). */
	chunkSize?: number;
	/** Delay before the index is written after a chunk (default 1500 ms; 0 in tests). */
	flushDelayMs?: number;
}

interface Queued {
	target: CompareTarget;
	force: boolean;
}

export type UpdateListener = (keys: string[]) => void;
export type ProgressListener = (p: CompareProgress) => void;

/** The compare index: gzip JSON like the other caches (`diskCache`). `index.json` is the plain file older versions wrote. */
const INDEX_FILE = "index.json.gz";
const LEGACY_INDEX_FILE = "index.json";

class SimpleToken implements CancelToken {
	isCancellationRequested = false;
	private readonly listeners = new Set<() => void>();
	onCancellationRequested = (l: () => void) => {
		this.listeners.add(l);
		return { dispose: () => void this.listeners.delete(l) };
	};
	cancel(): void {
		if (this.isCancellationRequested) return;
		this.isCancellationRequested = true;
		for (const l of [...this.listeners]) l();
	}
}

async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
	let ents: fs.Dirent[];
	try {
		ents = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of ents) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) await walkFiles(p, out);
		else if (e.isFile()) out.push(p);
	}
	return out;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

export class ContentCompareService {
	private index: CompareIndexFile = { v: 1, entries: {} };
	private loaded: Promise<void> | undefined;
	private readonly queue = new Map<string, Queued>();
	private work: Queued[] = [];
	private running = false;
	/** A run is in progress (planning or retrieving). */
	private busy = false;
	private paused = false;
	private disposed = false;
	private token: SimpleToken | undefined;
	/** Bumped by `cancelAll`: a plan made before it is dropped. */
	private epoch = 0;
	private dropCurrent = false;
	private done = 0;
	private total = 0;
	private failed = 0;
	private readonly updateListeners = new Set<UpdateListener>();
	private readonly progressListeners = new Set<ProgressListener>();
	private readonly digestCache = new Map<string, { mtimeMs: number; size: number; digest: string }>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private flushTail: Promise<void> = Promise.resolve();
	private idleWaiters: (() => void)[] = [];
	/** Tail of the chain that serializes the `sf` retrieves into the stub project (compare chunks, on-demand copies). */
	private lockTail: Promise<void> = Promise.resolve();

	constructor(private readonly deps: CompareServiceDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	// ── Index ────────────────────────────────────────────────────────────────────

	/** Read the persisted index and digest cache (once). Safe to call repeatedly. */
	load(): Promise<void> {
		if (!this.loaded) {
			this.loaded = (async () => {
				let raw = await readGzipJson<CompareIndexFile>(path.join(this.deps.cacheRoot, INDEX_FILE));
				if (!raw) {
					try {
						raw = JSON.parse(await fs.promises.readFile(path.join(this.deps.cacheRoot, LEGACY_INDEX_FILE), "utf8")) as CompareIndexFile;
					} catch {
						/* no index yet */
					}
				}
				if (raw && raw.v === 1 && raw.entries && typeof raw.entries === "object") {
					this.index = { v: 1, entries: raw.entries };
					// The digests of the local files read last time: a file whose mtime and size are unchanged is not read again.
					for (const [abs, d] of Object.entries(raw.digests ?? {})) {
						if (Array.isArray(d) && typeof d[0] === "number" && typeof d[1] === "number" && typeof d[2] === "string") this.digestCache.set(abs, { mtimeMs: d[0], size: d[1], digest: d[2] });
					}
				}
				await this.sweepRunDirs();
			})();
		}
		return this.loaded;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		const delay = this.deps.flushDelayMs ?? 1500;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, delay);
		(this.flushTimer as { unref?: () => void }).unref?.();
	}

	/** Write the index (and the local digests) now: gzip JSON, temp file + rename; writes never overlap. */
	flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const run = this.flushTail.then(async () => {
			try {
				const digests: Record<string, [number, number, string]> = {};
				for (const [abs, d] of this.digestCache) digests[abs] = [d.mtimeMs, d.size, d.digest];
				const file: CompareIndexFile = { v: 1, entries: this.index.entries, digests };
				await writeGzipJson(path.join(this.deps.cacheRoot, INDEX_FILE), file);
				await fs.promises.rm(path.join(this.deps.cacheRoot, LEGACY_INDEX_FILE), { force: true });
			} catch {
				/* the index is a cache */
			}
		});
		this.flushTail = run;
		return run;
	}

	/** The wire form of the compare results of `keys` (default: all) for the webviews. Keys are the panels' row keys. */
	contentInfo(keys?: Iterable<string>): ContentInfoMap {
		const out: ContentInfoMap = {};
		const ks = keys ?? Object.keys(this.index.entries);
		for (const k of ks) {
			const e = this.index.entries[k];
			if (e) out[k] = toWire(e);
		}
		return out;
	}

	/**
	 * The results that are still valid for `targets` (same org time and same local contents as when compared).
	 * A result gone stale is sent as `[0, comparedAt, verifiedAt]`: no verdict, but the last time both sides
	 * were verified equal stays available as the baseline of the date rules.
	 */
	async validContentInfo(targets: readonly CompareTarget[]): Promise<ContentInfoMap> {
		await this.load();
		const out: ContentInfoMap = {};
		for (const t of targets) {
			const e = this.index.entries[t.key];
			if (!e) continue;
			let valid = false;
			if (e.orgLm === t.orgLm) {
				const local = await this.localDigests(t);
				valid = !!local && hashDigests(local) === e.localHash;
			}
			if (valid) out[t.key] = toWire(e);
			else {
				const v = verifiedSyncAt(e);
				if (v !== undefined) out[t.key] = [0, e.comparedAt, v];
			}
		}
		return out;
	}

	/** The last time this component was verified equal to the org, or undefined. */
	verifiedSyncAt(key: string): number | undefined {
		return verifiedSyncAt(this.index.entries[key]);
	}

	/** Components compared "same" against exactly this org version and these local contents. */
	async verifiedEqualNow(targets: readonly CompareTarget[]): Promise<Set<string>> {
		await this.load();
		const out = new Set<string>();
		for (const t of targets) {
			const e = this.index.entries[t.key];
			if (!e || e.result !== "same" || e.orgLm !== t.orgLm) continue;
			const local = await this.localDigests(t);
			if (local && hashDigests(local) === e.localHash) out.add(t.key);
		}
		return out;
	}

	/** Forget every result (tests, "force" over everything). */
	clearIndex(keys?: Iterable<string>): void {
		if (!keys) this.index = { v: 1, entries: {} };
		else for (const k of keys) delete this.index.entries[k];
		this.scheduleFlush();
	}

	// ── Listeners / progress ─────────────────────────────────────────────────────

	onDidUpdate(l: UpdateListener): { dispose(): void } {
		this.updateListeners.add(l);
		return { dispose: () => void this.updateListeners.delete(l) };
	}

	onDidProgress(l: ProgressListener): { dispose(): void } {
		this.progressListeners.add(l);
		return { dispose: () => void this.progressListeners.delete(l) };
	}

	progress(): CompareProgress {
		const active = this.busy || this.queue.size > 0 || this.work.length > 0;
		return { state: this.paused && active ? "paused" : active ? "running" : "idle", done: this.done, total: this.total, failed: this.failed };
	}

	private emitProgress(): void {
		const p = this.progress();
		for (const l of [...this.progressListeners]) l(p);
	}

	private emitUpdate(keys: string[]): void {
		if (keys.length === 0) return;
		for (const l of [...this.updateListeners]) l(keys);
	}

	/** Resolves when nothing is queued or running (tests). */
	whenIdle(): Promise<void> {
		if (!this.running && this.queue.size === 0 && this.work.length === 0) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	// ── Queue ────────────────────────────────────────────────────────────────────

	/**
	 * Queue components for comparison. Ones whose org time and local contents are unchanged since their last
	 * compare are skipped, unless `force`. Starts the background run unless paused.
	 */
	request(targets: readonly CompareTarget[], force = false): void {
		if (this.disposed) return;
		for (const t of targets) {
			if (NOT_COMPARABLE_TYPES.has(t.type)) continue;
			const prev = this.queue.get(t.key);
			this.queue.set(t.key, { target: t, force: force || !!prev?.force });
		}
		this.kick();
	}

	private kick(): void {
		if (this.running || this.paused || this.disposed) return;
		if (this.queue.size === 0 && this.work.length === 0) return;
		this.running = true;
		this.busy = true;
		void this.loop().catch(() => undefined).finally(() => {
			this.running = false;
			// Requests that arrived while the last chunk was finishing.
			if (!this.paused && !this.disposed && (this.queue.size > 0 || this.work.length > 0)) this.kick();
			else this.settle();
		});
		this.emitProgress();
	}

	private settle(): void {
		if (this.running || this.queue.size > 0 || this.work.length > 0) return;
		const w = this.idleWaiters;
		this.idleWaiters = [];
		for (const r of w) r();
	}

	/** Stop the running retrieve now; what is left stays queued for `resume()`. */
	pause(): void {
		this.paused = true;
		this.token?.cancel();
		this.emitProgress();
	}

	/** The user's Cancel: drop the queue and the planned work, stop the running retrieve; nothing is put back. */
	cancelAll(): void {
		this.epoch++;
		this.queue.clear();
		this.work = [];
		this.dropCurrent = !!this.token;
		this.token?.cancel();
		this.emitProgress();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.kick();
		this.emitProgress();
	}

	/** Stop for good: drop the queue, kill the running retrieve, write the index. */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.queue.clear();
		this.work = [];
		this.token?.cancel();
		this.updateListeners.clear();
		this.progressListeners.clear();
		this.settle();
		await this.flush();
	}

	// ── The run ──────────────────────────────────────────────────────────────────

	private async loop(): Promise<void> {
		try {
			await this.runLoop();
		} finally {
			this.busy = false;
			this.emitProgress();
		}
	}

	private async runLoop(): Promise<void> {
		await this.load();
		if (this.work.length === 0 && this.queue.size === 0) return;
		if (this.work.length === 0) {
			// A fresh run: progress starts again.
			this.done = 0;
			this.total = 0;
			this.failed = 0;
		}
		while (!this.disposed && !this.paused) {
			if (this.queue.size > 0) {
				const batch = [...this.queue.values()];
				this.queue.clear();
				const epoch = this.epoch;
				const todo = await this.plan(batch);
				// Cancelled while hashing: the plan is dropped.
				if (epoch !== this.epoch) {
					this.emitProgress();
					continue;
				}
				// Pausing while hashing: put the batch back, it is cheap to hash again.
				if (this.paused || this.disposed) {
					for (const q of batch) if (!this.queue.has(q.target.key)) this.queue.set(q.target.key, q);
					break;
				}
				this.work.push(...todo);
				this.total += todo.length;
				this.emitProgress();
			}
			if (this.work.length === 0) {
				if (this.queue.size === 0) break;
				continue;
			}
			const size = this.deps.chunkSize ?? 150;
			const group = this.work.splice(0, size);
			const token = new SimpleToken();
			this.token = token;
			try {
				const keys = await this.runChunk(group, token);
				this.done += group.length;
				this.emitUpdate(keys);
				this.emitProgress();
			} catch (e) {
				if (token.isCancellationRequested) {
					// Paused or disposed mid-retrieve: the chunk goes back to the front. Cancelled by the user: it is dropped.
					if (!this.dropCurrent) this.work.unshift(...group);
					this.dropCurrent = false;
					break;
				}
				// A chunk that blew up: its components stay uncompared (provisional).
				this.failed += group.length;
				this.done += group.length;
				this.emitProgress();
			} finally {
				this.token = undefined;
			}
		}
		if (this.work.length === 0 && this.queue.size === 0) {
			await this.flush();
		} else {
			this.scheduleFlush();
		}
	}

	/** Which of the queued components need a (re)compare: never compared, or org time / local contents changed. */
	private async plan(batch: Queued[]): Promise<Queued[]> {
		const todo: Queued[] = [];
		for (const q of batch) {
			if (this.disposed || this.paused) return todo;
			if (q.force) {
				todo.push(q);
				continue;
			}
			const local = await this.localDigests(q.target);
			const hash = local ? hashDigests(local) : "";
			if (local && needsCompare(this.index.entries[q.target.key], q.target.orgLm, hash)) todo.push(q);
		}
		return todo;
	}

	/** Digests of a component's local files (`inner → digest`); null when a file vanished meanwhile and none is left. */
	private async localDigests(t: CompareTarget): Promise<Map<string, string> | null> {
		const out = new Map<string, string>();
		for (const f of t.files) {
			try {
				const st = await fs.promises.stat(f.abs);
				const cached = this.digestCache.get(f.abs);
				if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
					out.set(f.inner, cached.digest);
					continue;
				}
				const digest = digestContent(await fs.promises.readFile(f.abs));
				this.digestCache.set(f.abs, { mtimeMs: st.mtimeMs, size: st.size, digest });
				this.scheduleFlush();
				out.set(f.inner, digest);
			} catch {
				/* a file removed since the scan: the component's local set shrinks (→ different) */
			}
		}
		return out.size > 0 ? out : null;
	}

	// ── Stub project ─────────────────────────────────────────────────────────────

	private stubDir(): string {
		return path.join(this.deps.cacheRoot, "stub");
	}

	/** Create / refresh the stub SFDX project `sf` runs in. */
	private async ensureStub(): Promise<string> {
		const stub = this.stubDir();
		await fs.promises.mkdir(path.join(stub, "force-app", "main", "default"), { recursive: true });
		let sourceApiVersion: string | undefined;
		try {
			const cfg = JSON.parse(await fs.promises.readFile(path.join(this.deps.projectDir, "sfdx-project.json"), "utf8"));
			if (typeof cfg?.sourceApiVersion === "string") sourceApiVersion = cfg.sourceApiVersion;
		} catch {
			/* the real project's config is optional here */
		}
		const cfg = { packageDirectories: [{ path: "force-app", default: true }], ...(sourceApiVersion ? { sourceApiVersion } : {}) };
		const body = JSON.stringify(cfg, null, 2) + "\n";
		const file = path.join(stub, "sfdx-project.json");
		let cur = "";
		try {
			cur = await fs.promises.readFile(file, "utf8");
		} catch {
			/* new stub */
		}
		if (cur !== body) await fs.promises.writeFile(file, body, "utf8");
		// The project's ignore rules decide which files the org copy holds, as they do for a retrieve into the project.
		try {
			await fs.promises.copyFile(path.join(this.deps.projectDir, ".forceignore"), path.join(stub, ".forceignore"));
		} catch {
			await fs.promises.rm(path.join(stub, ".forceignore"), { force: true });
		}
		return stub;
	}

	private async sweepRunDirs(): Promise<void> {
		try {
			for (const n of await fs.promises.readdir(this.stubDir())) {
				if (n.startsWith("run-")) await fs.promises.rm(path.join(this.stubDir(), n), { recursive: true, force: true });
			}
		} catch {
			/* no stub yet */
		}
		// Half-written org copies of an interrupted run.
		try {
			for (const n of await fs.promises.readdir(this.orgCopyRoot())) {
				if (n.includes(".tmp-")) await fs.promises.rm(path.join(this.orgCopyRoot(), n), { recursive: true, force: true });
			}
		} catch {
			/* no copies yet */
		}
	}

	private locked<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.lockTail.then(fn, fn);
		this.lockTail = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	// ── Org copies ───────────────────────────────────────────────────────────────

	/** `<cacheRoot>/org`: the kept org copies, one directory per component. */
	orgCopyRoot(): string {
		return path.join(this.deps.cacheRoot, "org");
	}

	private orgCopyDir(key: string): string {
		return path.join(this.orgCopyRoot(), orgCopyDirName(key));
	}

	/**
	 * The org copy kept of a component by the last compare (or `fetchOrgCopy`): `inner path → absolute path`.
	 * `key` is a row key in either form (`Layout:Account-Account%20Layout` and `Layout:Account-Account Layout` are the same copy).
	 * undefined when there is none.
	 */
	orgCopyFiles(key: string): Map<string, string> | undefined {
		const dir = this.orgCopyDir(key);
		const out = new Map<string, string>();
		const walk = (d: string, prefix: string): void => {
			let ents: fs.Dirent[];
			try {
				ents = fs.readdirSync(d, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of ents) {
				if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + "/");
				else if (e.isFile()) out.set(prefix + e.name, path.join(d, e.name));
			}
		};
		walk(dir, "");
		return out.size > 0 ? out : undefined;
	}

	/** Replace the kept copy of `key` with `files` (`inner → file in the run directory`); the files are moved. */
	private async storeOrgCopy(key: string, files: ReadonlyMap<string, { abs: string }>): Promise<void> {
		const dest = this.orgCopyDir(key);
		const tmp = `${dest}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
		await fs.promises.rm(tmp, { recursive: true, force: true });
		await fs.promises.mkdir(tmp, { recursive: true });
		try {
			for (const [inner, f] of files) {
				if (inner.split("/").includes("..")) continue;
				const to = path.join(tmp, ...inner.split("/"));
				await fs.promises.mkdir(path.dirname(to), { recursive: true });
				try {
					await fs.promises.rename(f.abs, to);
				} catch {
					await fs.promises.copyFile(f.abs, to);
				}
			}
			await fs.promises.rm(dest, { recursive: true, force: true });
			await fs.promises.rename(tmp, dest);
		} catch (e) {
			await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
			throw e;
		}
	}

	/**
	 * Retrieve ONE component's org copy now (a Profile, which is never auto-compared, or a component not
	 * compared yet) into the kept copies and return its files. Not a compare result: the index and the
	 * progress are untouched. Rejects when the org does not return the component.
	 */
	fetchOrgCopy(target: OrgCopyTarget): Promise<Map<string, string>> {
		return this.locked(async () => {
			const lookup = lookupKeyOf(target.type, target.name);
			const stub = await this.ensureStub();
			const outputDir = path.join(stub, `run-${this.now()}-${Math.floor(Math.random() * 1e6)}`);
			await fs.promises.mkdir(outputDir, { recursive: true });
			try {
				const reply = await this.deps.retrieve({
					components: [{ type: target.type, fullName: requestNameOf(target.type, target.name) }],
					outputDir,
					cwd: stub,
					token: new SimpleToken(),
				});
				const files = (await walkFiles(outputDir)).map((abs) => ({ rel: toPosix(path.relative(outputDir, abs)), abs }));
				const orgFiles = groupByComponent(files, this.deps.table()).get(lookup);
				const ok = reply.retrieved.some((r) => lookupKeyOf(r.type, r.fullName) === lookup);
				if (!ok || !orgFiles || orgFiles.size === 0) {
					const why = reply.failed.find((f) => lookupKeyOf(f.type, f.fullName) === lookup)?.error;
					throw new Error(`The org did not return ${lookup}${why ? `: ${why}` : "."}`);
				}
				await this.storeOrgCopy(lookup, orgFiles);
				return this.orgCopyFiles(lookup) ?? new Map<string, string>();
			} finally {
				await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
			}
		});
	}

	// ── One chunk ────────────────────────────────────────────────────────────────

	/** Retrieve the org copies of `group`, compare, record, keep the org copies. Returns the keys that got a result. */
	private runChunk(group: Queued[], token: SimpleToken): Promise<string[]> {
		return this.locked(() => this.runChunkLocked(group, token));
	}

	private async runChunkLocked(group: Queued[], token: SimpleToken): Promise<string[]> {
		if (token.isCancellationRequested) throw new Error("cancelled");
		const stub = await this.ensureStub();
		const outputDir = path.join(stub, `run-${this.now()}-${Math.floor(Math.random() * 1e6)}`);
		await fs.promises.mkdir(outputDir, { recursive: true });
		try {
			const reqByLookup = new Map<string, Queued>();
			for (const q of group) reqByLookup.set(lookupKeyOf(q.target.type, q.target.name), q);
			const components = [...reqByLookup.values()].map((q) => ({ type: q.target.type, fullName: requestNameOf(q.target.type, q.target.name) }));
			const reply = await this.deps.retrieve({ components, outputDir, cwd: stub, token });
			if (token.isCancellationRequested) throw new Error("cancelled");

			const okLookup = new Set(reply.retrieved.map((r) => lookupKeyOf(r.type, r.fullName)));
			// Org files, grouped by component (only the components asked for are looked at).
			const files = (await walkFiles(outputDir)).map((abs) => ({ rel: toPosix(path.relative(outputDir, abs)), abs }));
			const orgGroups = groupByComponent(files, this.deps.table());

			const done: string[] = [];
			const at = this.now();
			for (const [lookup, q] of reqByLookup) {
				const orgFiles = orgGroups.get(lookup);
				if (!okLookup.has(lookup) || !orgFiles || orgFiles.size === 0) {
					this.failed++;
					continue;
				}
				const orgDigests = new Map<string, string>();
				for (const [inner, f] of orgFiles) orgDigests.set(inner, digestContent(await fs.promises.readFile(f.abs)));
				// The org copy stays (the diff opens it); only the run directory is removed below.
				await this.storeOrgCopy(lookup, orgFiles).catch(() => undefined);
				const local = await this.localDigests(q.target);
				if (!local) {
					this.failed++;
					continue;
				}
				const result = compareDigests(local, orgDigests);
				const prev: IndexEntry | undefined = this.index.entries[q.target.key];
				this.index.entries[q.target.key] = nextEntry(prev, q.target.orgLm, hashDigests(local), result, at);
				done.push(q.target.key);
			}
			this.scheduleFlush();
			return done;
		} finally {
			await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
