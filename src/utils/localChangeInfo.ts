/**
 * Local change info of a project's components for the status compare: file mtimes, git commit times (one
 * `git log` over the package directories, cached by HEAD) and the git-dirty set. Host side (runs `git`, reads
 * file stats); the time math lives in compareStatusPure.
 */
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "./commandRunner";
import { LocalInfoMap, computeLocalInfo, parseGitLogTimes } from "./compareStatusPure";
import { LocalEntry } from "./orgBrowser/localIndex";
import { Logger } from "./outputChannel";

const posix = (p: string) => p.split(path.sep).join("/");

interface CommitCache {
	head: string;
	dirsKey: string;
	map: Map<string, number>;
}
const commitCache = new Map<string, CommitCache>();

/**
 * Path (relative to the project) → time of the newest commit touching it. Null when the project is not in a
 * git repository, has no commit, or `git` failed. Cached per project by the HEAD sha.
 */
export async function gitCommitTimes(projectDir: string, packageDirs: string[]): Promise<Map<string, number> | null> {
	let head = "";
	try {
		head = (await runCommandArgs("git", ["rev-parse", "HEAD"], projectDir, undefined, false, 10000)).trim().split(/\s+/).pop() ?? "";
	} catch {
		return null;
	}
	if (!/^[0-9a-f]{7,64}$/i.test(head)) return null;
	const dirsKey = packageDirs.join("|");
	const hit = commitCache.get(projectDir);
	if (hit && hit.head === head && hit.dirsKey === dirsKey) return hit.map;
	try {
		const args = ["-c", "core.quotepath=false", "log", "--format=%x00%ct", "--name-only", "--relative", "--no-renames"];
		if (packageDirs.length > 0) args.push("--", ...packageDirs);
		const out = await runCommandArgs("git", args, projectDir, undefined, false, 180000);
		const map = parseGitLogTimes(out);
		commitCache.set(projectDir, { head, dirsKey, map });
		return map;
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
	const commits = dirtyPaths === null ? null : await gitCommitTimes(projectDir, packageDirs);
	return computeLocalInfo(comps, (rel) => mtimes.get(rel) ?? 0, dirtyPaths === null ? null : new Set(dirtyPaths), commits);
}
