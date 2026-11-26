/**
 * Persisted project caches (extension host side, no `vscode`): the local index, the git commit times and the last
 * local change info of a project, in `globalStorage/org-browser` next to the org listing cache, gzip JSON through
 * `diskCache`. Stored so the next opening of Deploy & Retrieve Metadata paints at once (also across VS Code sessions).
 *
 *   scanProjectCached   `scanProject`, but a stored index whose directories are unchanged is returned without a scan
 *   peekLocalIndex      the stored index without validating it (paint at once, validate in the background)
 *   commit / info       see `localChangeInfo`
 *
 * What is valid when is in `projectScanCachePure`.
 */
import * as fs from "fs";
import * as path from "path";
import { readGzipJson, writeGzipJson } from "./diskCache";
import { LocalInfoMap } from "./compareStatusPure";
import { LocalIndex, buildTypeTable, scanProject } from "./orgBrowser/localIndex";
import { TypeInfo } from "./orgBrowser/types";
import {
	CommitSnapshot,
	IndexSnapshot,
	InfoSnapshot,
	TimesFile,
	changedDirs,
	emptyTimes,
	indexCacheFile,
	indexOfSnapshot,
	infoForKeys,
	parseIndexSnapshot,
	parseTimesFile,
	snapshotMatches,
	snapshotOfIndex,
	timesCacheFile,
	typesKeyOf,
} from "./projectScanCachePure";

let cacheDir: string | undefined;

/** Call once on activation with `<globalStorage>/org-browser`. Without it everything still works, just uncached. */
export function initProjectScanCache(dir: string): void {
	cacheDir = dir;
}

/** For tests: forget everything held in memory. */
export function resetProjectScanCache(): void {
	memo.clear();
	inflight.clear();
	times.clear();
	for (const t of writeTimers.values()) clearTimeout(t);
	writeTimers.clear();
}

// ── Local index ────────────────────────────────────────────────────────────────

interface Held {
	snap: IndexSnapshot;
	index: LocalIndex;
}
const memo = new Map<string, Held>();
const inflight = new Map<string, Promise<CachedScan>>();

export interface CachedScan {
	index: LocalIndex;
	/** The stored index was still valid: nothing was scanned. */
	reused: boolean;
	ms: number;
}

async function held(projectDir: string): Promise<Held | undefined> {
	const m = memo.get(projectDir);
	if (m) return m;
	if (!cacheDir) return undefined;
	const snap = parseIndexSnapshot(await readGzipJson(indexCacheFile(cacheDir, projectDir)), projectDir);
	if (!snap) return undefined;
	const h = { snap, index: indexOfSnapshot(snap, projectDir) };
	if (!memo.has(projectDir)) memo.set(projectDir, h);
	return memo.get(projectDir);
}

/** The index as a panel may mutate its own copy of the Map (the entries themselves are read-only everywhere). */
const copyOf = (i: LocalIndex): LocalIndex => ({ entries: new Map(i.entries), scannedAt: i.scannedAt });

/** The stored index for these package directories, NOT checked against the disk; undefined when there is none. */
export async function peekLocalIndex(projectDir: string, pkgDirs: readonly string[], types: readonly TypeInfo[]): Promise<LocalIndex | undefined> {
	const h = await held(projectDir);
	return h && snapshotMatches(h.snap, pkgDirs, typesKeyOf(types)) ? copyOf(h.index) : undefined;
}

async function currentMtimes(projectDir: string, snap: IndexSnapshot): Promise<Map<string, number | undefined>> {
	const out = new Map<string, number | undefined>();
	const rels = Object.keys(snap.dirs);
	for (let i = 0; i < rels.length; i += 64) {
		await Promise.all(
			rels.slice(i, i + 64).map(async (rel) => {
				try {
					out.set(rel, (await fs.promises.stat(path.resolve(projectDir, ...rel.split("/")))).mtimeMs);
				} catch {
					out.set(rel, undefined);
				}
			})
		);
	}
	return out;
}

/**
 * The project's local index. A stored index is reused when its package directories and type table match and no
 * directory it walked changed (one `stat` per directory instead of a full scan); otherwise (or with `force`) the
 * project is scanned and the result stored. Concurrent calls for the same project share one run.
 */
export function scanProjectCached(projectDir: string, pkgDirs: string[], types: readonly TypeInfo[], opts: { force?: boolean } = {}): Promise<CachedScan> {
	const typesKey = typesKeyOf(types);
	const id = `${projectDir}|${typesKey}|${opts.force ? 1 : 0}`;
	const running = inflight.get(id);
	if (running) return running.then((r) => ({ ...r, index: copyOf(r.index) }));
	const p = (async (): Promise<CachedScan> => {
		const t0 = Date.now();
		if (!opts.force) {
			const h = await held(projectDir);
			if (h && snapshotMatches(h.snap, pkgDirs, typesKey) && changedDirs(h.snap, await currentMtimes(projectDir, h.snap)).length === 0) {
				return { index: copyOf(h.index), reused: true, ms: Date.now() - t0 };
			}
		}
		const dirs = new Map<string, number>();
		const index = await scanProject(projectDir, pkgDirs, buildTypeTable(types as TypeInfo[]), dirs);
		const snap = snapshotOfIndex(projectDir, pkgDirs, typesKey, index, dirs);
		memo.set(projectDir, { snap, index });
		if (cacheDir) void writeGzipJson(indexCacheFile(cacheDir, projectDir), snap).catch(() => undefined);
		return { index: copyOf(index), reused: false, ms: Date.now() - t0 };
	})().finally(() => inflight.delete(id));
	inflight.set(id, p);
	return p;
}

// ── Commit times + local change info ───────────────────────────────────────────

const times = new Map<string, Promise<TimesFile>>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function timesOf(projectDir: string): Promise<TimesFile> {
	let p = times.get(projectDir);
	if (!p) {
		p = (async () => {
			const raw = cacheDir ? await readGzipJson(timesCacheFile(cacheDir, projectDir)) : undefined;
			return parseTimesFile(raw, projectDir) ?? emptyTimes(projectDir);
		})();
		times.set(projectDir, p);
	}
	return p;
}

function scheduleTimesWrite(projectDir: string, file: TimesFile): void {
	if (!cacheDir || writeTimers.has(projectDir)) return;
	const dir = cacheDir;
	const t = setTimeout(() => {
		writeTimers.delete(projectDir);
		void writeGzipJson(timesCacheFile(dir, projectDir), file).catch(() => undefined);
	}, 1500);
	(t as { unref?: () => void }).unref?.();
	writeTimers.set(projectDir, t);
}

/** The git commit cache stored for the project (undefined when none). */
export async function loadCommitSnapshot(projectDir: string): Promise<CommitSnapshot | undefined> {
	return (await timesOf(projectDir)).commits;
}

/** Store the project's git commit cache (written to disk after a short delay). */
export async function saveCommitSnapshot(projectDir: string, snap: CommitSnapshot | null): Promise<void> {
	const f = await timesOf(projectDir);
	if (snap) f.commits = snap;
	else delete f.commits;
	scheduleTimesWrite(projectDir, f);
}

/** The last stored local change info for the components that exist now (to paint before the real read finishes). */
export async function peekLocalInfo(projectDir: string, keys: Iterable<string>): Promise<LocalInfoMap | undefined> {
	return infoForKeys((await timesOf(projectDir)).info, keys);
}

/** Store the freshly read local change info. */
export async function saveLocalInfo(projectDir: string, head: string | null, info: LocalInfoMap): Promise<void> {
	const f = await timesOf(projectDir);
	const snap: InfoSnapshot = { at: Date.now(), head, info };
	f.info = snap;
	scheduleTimesWrite(projectDir, f);
}

/** Write what is pending now (deactivate / tests). */
export async function flushProjectScanCache(): Promise<void> {
	if (!cacheDir) return;
	const dir = cacheDir;
	for (const [projectDir, t] of [...writeTimers]) {
		clearTimeout(t);
		writeTimers.delete(projectDir);
		const f = await times.get(projectDir);
		if (f) await writeGzipJson(timesCacheFile(dir, projectDir), f).catch(() => undefined);
	}
}
