/**
 * Pure part of the persisted project caches (no `vscode`, no I/O): what is stored of the local index, the git
 * commit times and the local change info, how a stored snapshot is read back, and when it is still valid.
 *
 *   index snapshot   the local index (`scanProject`) of one project. Valid while the package directories, the type
 *                    table and the mtime of every directory the scan walked are unchanged: the index depends only
 *                    on WHICH files exist, and a created / deleted / renamed file changes its directory's mtime.
 *   commit snapshot  `gitCommitTimes`' cache (path → newest commit time), keyed by the git HEAD it was read at;
 *                    the git code itself catches up from `<old HEAD>..HEAD` when HEAD moved.
 *   info snapshot    the last `LocalInfoMap` (change time + dirty flag per component): shown at once on open, then
 *                    always recomputed (a file edit or a new commit changes it).
 *
 * The files are gzip JSON in `globalStorage/org-browser` (`diskCache`), the directory of the listing cache.
 */
import * as crypto from "crypto";
import * as path from "path";
import { LocalInfoMap } from "./compareStatusPure";
import { LocalEntry, LocalIndex } from "./orgBrowser/localIndex";
import { TypeInfo, compKey } from "./orgBrowser/types";
import { safeFileStem } from "./diskCache";

export const SCAN_CACHE_VERSION = 1;

/** Commit-time entries kept per project; a bigger cache is dropped and rebuilt (it is only a cache). */
export const MAX_COMMIT_ENTRIES = 60000;

const posix = (p: string) => p.split(path.sep).join("/");

/** Stable short id of a project directory. */
export function projectStem(projectDir: string): string {
	return crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 12);
}

/** `<dir>/project-<stem>.index.json.gz`. */
export function indexCacheFile(dir: string, projectDir: string): string {
	return path.join(dir, safeFileStem(`project-${projectStem(projectDir)}`) + ".index.json.gz");
}

/** `<dir>/project-<stem>.times.json.gz` (commit times + local change info). */
export function timesCacheFile(dir: string, projectDir: string): string {
	return path.join(dir, safeFileStem(`project-${projectStem(projectDir)}`) + ".times.json.gz");
}

/** Fingerprint of the type table the index was built with ("" = no described types, the built-in table). */
export function typesKeyOf(types: readonly TypeInfo[]): string {
	if (types.length === 0) return "";
	const lines = types.map((t) => `${t.name}|${t.dir}|${t.suffix}`).sort();
	return crypto.createHash("sha1").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// ── Index snapshot ─────────────────────────────────────────────────────────────

interface SnapEntry {
	/** type */
	t: string;
	/** name */
	n: string;
	/** files, relative to the project (forward slashes) */
	f: string[];
	/** bundle root, relative */
	r?: string;
	/** primary file, relative */
	p: string;
}

export interface IndexSnapshot {
	v: typeof SCAN_CACHE_VERSION;
	projectDir: string;
	pkgDirs: string[];
	typesKey: string;
	scannedAt: number;
	/** Directory (relative to the project) → mtime read before it was listed. */
	dirs: Record<string, number>;
	entries: SnapEntry[];
}

/** The stored form of a scanned index. `dirMtimes`: absolute directory → mtime (`scanProject`'s `dirsOut`). */
export function snapshotOfIndex(projectDir: string, pkgDirs: readonly string[], typesKey: string, index: LocalIndex, dirMtimes: ReadonlyMap<string, number>): IndexSnapshot {
	const rel = (abs: string) => posix(path.relative(projectDir, abs));
	const dirs: Record<string, number> = {};
	for (const [abs, m] of dirMtimes) dirs[rel(abs)] = m;
	const entries: SnapEntry[] = [];
	for (const e of index.entries.values()) {
		entries.push({ t: e.type, n: e.name, f: e.files.map(rel), ...(e.root ? { r: rel(e.root) } : {}), p: rel(e.primary) });
	}
	return { v: SCAN_CACHE_VERSION, projectDir, pkgDirs: [...pkgDirs], typesKey, scannedAt: index.scannedAt, dirs, entries };
}

/** Validate a stored file; null when it is of another version / project or damaged. */
export function parseIndexSnapshot(raw: unknown, projectDir: string): IndexSnapshot | null {
	const s = raw as Partial<IndexSnapshot> | null | undefined;
	if (!s || s.v !== SCAN_CACHE_VERSION || s.projectDir !== projectDir) return null;
	if (!Array.isArray(s.pkgDirs) || typeof s.typesKey !== "string" || typeof s.scannedAt !== "number") return null;
	if (!s.dirs || typeof s.dirs !== "object" || !Array.isArray(s.entries)) return null;
	for (const e of s.entries) {
		if (!e || typeof e.t !== "string" || typeof e.n !== "string" || typeof e.p !== "string" || !Array.isArray(e.f)) return null;
	}
	return s as IndexSnapshot;
}

/** The index of a snapshot (absolute paths again). */
export function indexOfSnapshot(snap: IndexSnapshot, projectDir: string): LocalIndex {
	const abs = (rel: string) => path.resolve(projectDir, ...rel.split("/"));
	const entries = new Map<string, LocalEntry>();
	for (const e of snap.entries) {
		const key = compKey(e.t, e.n);
		entries.set(key, { type: e.t, name: e.n, key, files: e.f.map(abs), ...(e.r ? { root: abs(e.r) } : {}), primary: abs(e.p) });
	}
	return { entries, scannedAt: snap.scannedAt };
}

/**
 * The snapshot was built for these package directories and this type table. A scan with no described types yet
 * (`typesKey` "", the listing is still loading) accepts a snapshot built with the org's types: that one is richer.
 */
export function snapshotMatches(snap: Pick<IndexSnapshot, "pkgDirs" | "typesKey">, pkgDirs: readonly string[], typesKey: string): boolean {
	if (snap.pkgDirs.length !== pkgDirs.length || snap.pkgDirs.some((d, i) => d !== pkgDirs[i])) return false;
	return typesKey === "" || snap.typesKey === typesKey;
}

/** Cached directories whose mtime differs now, or that are gone (`current` undefined). Empty = the index is still valid. */
export function changedDirs(snap: Pick<IndexSnapshot, "dirs">, current: ReadonlyMap<string, number | undefined>): string[] {
	const out: string[] = [];
	for (const [rel, m] of Object.entries(snap.dirs)) {
		if (current.get(rel) !== m) out.push(rel);
	}
	return out;
}

// ── Times file (commit times + local change info) ──────────────────────────────

export interface CommitSnapshot {
	head: string;
	dirsKey: string;
	times: Record<string, number>;
	bounds: Record<string, number>;
}

export interface InfoSnapshot {
	at: number;
	head: string | null;
	info: LocalInfoMap;
}

export interface TimesFile {
	v: typeof SCAN_CACHE_VERSION;
	projectDir: string;
	commits?: CommitSnapshot;
	info?: InfoSnapshot;
}

export function emptyTimes(projectDir: string): TimesFile {
	return { v: SCAN_CACHE_VERSION, projectDir };
}

export function parseTimesFile(raw: unknown, projectDir: string): TimesFile | null {
	const t = raw as Partial<TimesFile> | null | undefined;
	if (!t || t.v !== SCAN_CACHE_VERSION || t.projectDir !== projectDir) return null;
	const c = t.commits;
	const commitsOk = !c || (typeof c.head === "string" && typeof c.dirsKey === "string" && !!c.times && typeof c.times === "object" && !!c.bounds && typeof c.bounds === "object");
	const i = t.info;
	const infoOk = !i || (typeof i.at === "number" && !!i.info && typeof i.info === "object");
	if (!commitsOk || !infoOk) return null;
	return t as TimesFile;
}

/** The git cache as stored (null when it has grown past `MAX_COMMIT_ENTRIES`: not worth keeping). */
export function commitSnapshotOf(head: string, dirsKey: string, times: ReadonlyMap<string, number>, bounds: ReadonlyMap<string, number>): CommitSnapshot | null {
	if (times.size + bounds.size > MAX_COMMIT_ENTRIES) return null;
	return { head, dirsKey, times: Object.fromEntries(times), bounds: Object.fromEntries(bounds) };
}

/** A stored commit cache as the maps `gitCommitTimes` works on; undefined when it was built for other package dirs. */
export function commitMapsOf(snap: CommitSnapshot | undefined, dirsKey: string): { head: string; times: Map<string, number>; bounds: Map<string, number> } | undefined {
	if (!snap || snap.dirsKey !== dirsKey) return undefined;
	return { head: snap.head, times: new Map(Object.entries(snap.times)), bounds: new Map(Object.entries(snap.bounds)) };
}

/** The stored change info restricted to the components that exist now (a stale entry of a deleted component is dropped). */
export function infoForKeys(snap: InfoSnapshot | undefined, keys: Iterable<string>): LocalInfoMap | undefined {
	if (!snap) return undefined;
	const out: LocalInfoMap = {};
	let n = 0;
	for (const k of keys) {
		const v = snap.info[k];
		if (v) {
			out[k] = v;
			n++;
		}
	}
	return n > 0 ? out : undefined;
}
