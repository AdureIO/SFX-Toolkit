/**
 * Local change info of a project's components for the status compare: file mtimes, git commit times (one bounded,
 * early-stopping `git log` over the package directories, cached by HEAD and updated incrementally) and the git-dirty set. Host side (runs `git`, reads
 * file stats); the time math lives in compareStatusPure.
 */
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "./commandRunner";
import * as vscode from "vscode";
import { LocalInfoMap, computeLocalInfo, isPathDirty } from "./compareStatusPure";
import { GitLogScanResult, GitLogScan, LineSplitter, MAX_SCAN_COMMITS } from "./gitLogScanPure";
import { LocalEntry } from "./orgBrowser/localIndex";
import { Logger } from "./outputChannel";
import { loadCommitSnapshot, saveCommitSnapshot, saveLocalInfo } from "./projectScanCache";
import { commitMapsOf, commitSnapshotOf } from "./projectScanCachePure";

const posix = (p: string) => p.split(path.sep).join("/");

interface CommitCache {
	head: string;
	dirsKey: string;
	/** Path → newest commit time found by a scan. */
	times: Map<string, number>;
	/** Paths a scan did not find: path → the oldest commit time that scan read ("unchanged since at least then"). */
	bounds: Map<string, number>;
}
const commitCache = new Map<string, CommitCache>();

export interface CommitTimes {
	/** Needed path (relative to the project) → time of the newest commit touching it. */
	times: Map<string, number>;
	/**
	 * Time of the oldest commit the bounded scan read; the local time of every needed path missing from `times`
	 * ("unchanged since at least then"). Null = nothing to bound with (empty log): use the file mtime.
	 */
	boundary: number | null;
	/** The git HEAD the times are valid for. */
	head: string;
}

/** One `git log` scan, streamed line by line; git is killed as soon as the accumulator is done. */
async function scanGitLog(projectDir: string, packageDirs: string[], needed: Iterable<string> | null, range?: string): Promise<GitLogScanResult> {
	const scan = new GitLogScan(needed);
	if (scan.done) return scan.result();
	const args = ["-c", "core.quotepath=false", "log", "--format=%x00%ct", "--name-only", "--relative", "--no-renames", "-n", String(MAX_SCAN_COMMITS)];
	if (range) args.push(range);
	if (packageDirs.length > 0) args.push("--", ...packageDirs);
	const cts = new vscode.CancellationTokenSource();
	const splitter = new LineSplitter();
	const feed = (lines: string[]) => {
		for (const l of lines) {
			if (scan.feedLine(l)) {
				cts.cancel();
				return;
			}
		}
	};
	try {
		await runCommandArgs("git", args, projectDir, (chunk) => !scan.done && feed(splitter.push(chunk)), false, 180000, cts.token);
		if (!scan.done) feed(splitter.flush());
	} catch (e) {
		// Killed by us after the last needed path was found: not an error.
		if (!scan.done) throw e;
	} finally {
		cts.dispose();
	}
	return scan.result();
}

/**
 * Commit times of the `needed` paths (project-relative, forward slashes): one bounded, early-stopping
 * `git log` (max 1000 commits, killed once every needed path is found). Null when the project is not in a git
 * repository, has no commit, or `git` failed. Cached per project by the HEAD sha; when HEAD moves the cache is
 * updated from `<oldHead>..HEAD` (full bounded scan if the old head is not an ancestor).
 */
export async function gitCommitTimes(projectDir: string, packageDirs: string[], needed: ReadonlySet<string>): Promise<CommitTimes | null> {
	let head = "";
	try {
		head = (await runCommandArgs("git", ["rev-parse", "HEAD"], projectDir, undefined, false, 10000)).trim().split(/\s+/).pop() ?? "";
	} catch {
		return null;
	}
	if (!/^[0-9a-f]{7,64}$/i.test(head)) return null;
	const dirsKey = packageDirs.join("|");
	try {
		let cache = commitCache.get(projectDir);
		if (!cache) {
			// A cache stored by an earlier session (or another panel's window): HEAD moved since → caught up below.
			const stored = commitMapsOf(await loadCommitSnapshot(projectDir), dirsKey);
			if (stored) {
				cache = { head: stored.head, dirsKey, times: stored.times, bounds: stored.bounds };
				commitCache.set(projectDir, cache);
			}
		}
		let changed = false;
		if (cache && cache.dirsKey !== dirsKey) cache = undefined;
		if (cache && cache.head !== head) {
			let ok = false;
			try {
				await runCommandArgs("git", ["merge-base", "--is-ancestor", cache.head, head], projectDir, undefined, false, 10000);
				ok = true;
			} catch {
				ok = false;
			}
			if (ok) {
				const r = await scanGitLog(projectDir, packageDirs, null, `${cache.head}..${head}`);
				if (r.capped) {
					ok = false;
				} else {
					for (const [p, t] of r.times) {
						cache.times.set(p, t);
						cache.bounds.delete(p);
					}
					cache.head = head;
					changed = true;
				}
			}
			if (!ok) cache = undefined;
		}
		if (!cache) {
			cache = { head, dirsKey, times: new Map(), bounds: new Map() };
			commitCache.set(projectDir, cache);
			changed = true;
		}
		const unresolved = [...needed].filter((p) => !cache!.times.has(p) && !cache!.bounds.has(p));
		if (unresolved.length > 0) {
			const r = await scanGitLog(projectDir, packageDirs, unresolved);
			for (const [p, t] of r.times) cache.times.set(p, t);
			// Not found: unchanged since at least the oldest commit read (none read = empty log: stays unresolved, mtime).
			if (r.boundary !== null) for (const p of unresolved) if (!r.times.has(p)) cache.bounds.set(p, r.boundary);
			changed = true;
		}
		if (changed) void saveCommitSnapshot(projectDir, commitSnapshotOf(cache.head, cache.dirsKey, cache.times, cache.bounds));
		let boundary: number | null = null;
		for (const p of needed) {
			if (cache.times.has(p)) continue;
			const b = cache.bounds.get(p);
			if (b !== undefined && (boundary === null || b > boundary)) boundary = b; // max: a valid upper bound for every path
		}
		return { times: cache.times, boundary, head };
	} catch (e) {
		Logger.info(`Compare: could not read the git history of ${projectDir}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
		return null;
	}
}

/**
 * `[localT, dirty]` per component key. `dirtyPaths` = the git status paths (project-relative); null = git is
 * not available (mtimes only, no dirty info).
 */
export async function readLocalInfo(projectDir: string, entries: Iterable<LocalEntry>, packageDirs: string[], dirtyPaths: string[] | null): Promise<LocalInfoMap> {
	const comps = [...entries].map((e) => ({ key: e.key, files: e.files.map((f) => posix(path.relative(projectDir, f))) }));
	const mtimes = new Map<string, number>();
	const all = [...new Set(comps.flatMap((c) => c.files))];
	for (let i = 0; i < all.length; i += 64) {
		await Promise.all(
			all.slice(i, i + 64).map(async (rel) => {
				try {
					mtimes.set(rel, (await fs.promises.stat(path.join(projectDir, ...rel.split("/")))).mtimeMs);
				} catch {
					mtimes.set(rel, 0);
				}
			})
		);
	}
	const dirty = dirtyPaths === null ? null : new Set(dirtyPaths);
	// Only the files of clean components need a commit time; dirty files use their mtime.
	const needed = dirty ? new Set(all.filter((rel) => !isPathDirty(rel, dirty))) : new Set<string>();
	const commits = dirty === null ? null : await gitCommitTimes(projectDir, packageDirs, needed);
	const info = computeLocalInfo(comps, (rel) => mtimes.get(rel) ?? 0, dirty, commits?.times ?? null, commits?.boundary ?? null);
	void saveLocalInfo(projectDir, commits?.head ?? null, info);
	return info;
}
