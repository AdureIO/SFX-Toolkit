/**
 * Local-vs-org status of a component, shared by the Deploy Metadata panel and the Org Browser. Pure (no
 * `vscode`, no DOM): runs in the webviews, the extension host and the tests.
 *
 * Two inputs decide the status:
 *   - dates (instant): the org's lastModifiedDate against the last sync (toolkit retrieve / deploy log, or the
 *     last content-verified "same"), and the local change time against the same baseline;
 *   - contents (background): `same` / `different` from the content diff. `same` is final; `different` only says
 *     "not equal", the direction still comes from the dates.
 * A result decided by dates alone is `provisional`.
 */

/** Dates closer than this are the same moment (clock skew between the org and this machine, deploy latency). */
export const TOL_MS = 60_000;

export type CompareStatus = "equal" | "changed-locally" | "changed-in-org" | "conflict";
export type ContentResult = "same" | "different";

export interface CompareInput {
	/** The org's lastModifiedDate (epoch ms). */
	orgLm: number;
	/** The last time both sides were known to be in sync (retrieve / deploy log, content-verified equal): epoch ms. */
	syncedAt?: number;
	/** Local change time (see `fileLocalTime` / `componentLocalTime`); epoch ms. */
	localT: number;
	/** Git reports any of the component's files as changed or untracked. */
	dirty: boolean;
	/** Result of the content diff; undefined = not compared (yet) or the compare failed. */
	content?: ContentResult;
}

export interface CompareResult {
	status: CompareStatus;
	/** Decided by dates only: the contents were not compared. */
	provisional: boolean;
}

/** The status of a component present on both sides. */
export function compareStatus(i: CompareInput): CompareResult {
	if (i.content === "same") return { status: "equal", provisional: false };

	const synced = i.syncedAt;
	let orgChanged: boolean;
	let localChanged: boolean;
	if (synced !== undefined) {
		orgChanged = i.orgLm > synced + TOL_MS;
		localChanged = i.dirty || i.localT > synced + TOL_MS;
	} else {
		orgChanged = i.orgLm > i.localT + TOL_MS;
		localChanged = i.dirty || !orgChanged;
	}

	if (i.content === "different") {
		if (orgChanged && localChanged) return { status: "conflict", provisional: false };
		if (orgChanged) return { status: "changed-in-org", provisional: false };
		if (localChanged) return { status: "changed-locally", provisional: false };
		// Dates are useless (neither side changed since the baseline): the newer side wins.
		return { status: i.orgLm > i.localT ? "changed-in-org" : "changed-locally", provisional: false };
	}

	// Heuristic only.
	if (synced === undefined && !i.dirty && !orgChanged) return { status: "equal", provisional: true };
	if (orgChanged && localChanged) return { status: "conflict", provisional: true };
	if (orgChanged) return { status: "changed-in-org", provisional: true };
	if (localChanged) return { status: "changed-locally", provisional: true };
	return { status: "equal", provisional: true };
}

// ── Status codes (one value per row; the filter vocabularies index into the name lists) ──

/** Shared by both panels: 0 = local only / org only, then the four compare statuses. */
export const CODE_ABSENT = 0;
export const CODE_EQUAL = 1;
export const CODE_CHANGED_LOCALLY = 2;
export const CODE_CHANGED_IN_ORG = 3;
export const CODE_CONFLICT = 4;

export const COMPARE_CODES: Record<CompareStatus, number> = {
	equal: CODE_EQUAL,
	"changed-locally": CODE_CHANGED_LOCALLY,
	"changed-in-org": CODE_CHANGED_IN_ORG,
	conflict: CODE_CONFLICT,
};

/** Is the code one of the four "present on both sides" statuses? */
export const isComparedCode = (code: number): boolean => code >= CODE_EQUAL && code <= CODE_CONFLICT;

/** Lower-case `status:` aliases the two panels share (old and new names). */
export function sharedStatusAliases(): Record<string, string> {
	return {
		equal: "equal",
		same: "equal",
		"changed-locally": "changed-locally",
		changedlocally: "changed-locally",
		"modified-locally": "changed-locally",
		modified: "changed-locally",
		local: "changed-locally",
		dirty: "changed-locally",
		"changed-in-org": "changed-in-org",
		changedinorg: "changed-in-org",
		"org-changed": "changed-in-org",
		changed: "changed-in-org",
		conflict: "conflict",
		unknown: "unknown",
	};
}

/** `status:inorg` and friends: present on both sides, whatever the compare result. */
export const anyComparedShorthand = (v: number): boolean => isComparedCode(v);

// ── Local change time ──────────────────────────────────────────────────────────

export interface LocalFileTimes {
	/** File mtime (epoch ms). */
	mtime: number;
	/** Time of the last git commit that touched the file (epoch ms); undefined = never committed / no git. */
	commit?: number;
	/** Git reports the file as changed or untracked. */
	dirty: boolean;
}

/** One file's local change time: dirty → its mtime; else its last commit; else (no git / not committed) its mtime. */
export function fileLocalTime(f: LocalFileTimes): number {
	if (f.dirty) return f.mtime;
	return f.commit ?? f.mtime;
}

/** A component's local change time and dirty flag: the newest of its files. */
export function componentLocalTime(files: readonly LocalFileTimes[]): { localT: number; dirty: boolean } {
	let localT = 0;
	let dirty = false;
	for (const f of files) {
		const t = fileLocalTime(f);
		if (t > localT) localT = t;
		if (f.dirty) dirty = true;
	}
	return { localT, dirty };
}

/**
 * Parse `git log --format=%x00%ct --name-only` (newest commit first) into path → newest commit time (ms).
 * Each commit is `\0<unix seconds>\n\n<path>\n<path>…`.
 */
export function parseGitLogTimes(out: string): Map<string, number> {
	const map = new Map<string, number>();
	for (const block of out.split("\0")) {
		if (!block) continue;
		const lines = block.split(/\r?\n/);
		const secs = Number(lines[0]?.trim());
		if (!Number.isFinite(secs) || secs <= 0) continue;
		const ms = secs * 1000;
		for (let k = 1; k < lines.length; k++) {
			const p = lines[k].trim();
			if (!p) continue;
			const prev = map.get(p);
			if (prev === undefined || ms > prev) map.set(p, ms);
		}
	}
	return map;
}

/** The newest time both sides were known in sync: the toolkit's retrieve / deploy log or a content-verified "same". */
export function effectiveSyncedAt(logTime?: number, verifiedAt?: number): number | undefined {
	if (logTime === undefined) return verifiedAt;
	if (verifiedAt === undefined) return logTime;
	return Math.max(logTime, verifiedAt);
}

// ── Messages host → webview ────────────────────────────────────────────────────

/** `[localT, dirty 0|1]` per component key. */
export type LocalInfoMap = Record<string, [number, number]>;
/** `[result 1 = same / 2 = different, comparedAt, sameAt (0 = never)]` per component key. */
export type ContentInfoMap = Record<string, [number, number, number]>;

export interface ComparePush {
	/** Replace (true) or merge into (false) the webview's content map. */
	full: boolean;
	content: ContentInfoMap;
}

export interface CompareProgress {
	/** `idle`: nothing running; `running`: comparing; `paused`: stopped for a deploy (resumes after it). */
	state: "idle" | "running" | "paused";
	done: number;
	total: number;
	/** Components the last run could not compare. */
	failed: number;
}

/** The status line text, e.g. "Comparing contents 340 / 3,324". Empty when idle. */
export function progressText(p: CompareProgress | null | undefined): string {
	if (!p || p.state === "idle") return "";
	const n = (x: number) => x.toLocaleString("en-US");
	if (p.total === 0) return p.state === "paused" ? "Comparing paused" : "Comparing contents…";
	return `${p.state === "paused" ? "Comparing paused" : "Comparing contents"} ${n(p.done)} / ${n(p.total)}`;
}

/** Decode the wire form of a content result. */
export function contentFromCode(code: number | undefined): ContentResult | undefined {
	return code === 1 ? "same" : code === 2 ? "different" : undefined;
}

// ── Local info of a whole project ──────────────────────────────────────────────

/** Is the project-relative path itself, or a folder above it, in the git status (an untracked folder shows as one entry)? */
export function isPathDirty(rel: string, dirty: ReadonlySet<string>): boolean {
	if (dirty.has(rel)) return true;
	let i = rel.lastIndexOf("/");
	while (i > 0) {
		if (dirty.has(rel.slice(0, i))) return true;
		i = rel.lastIndexOf("/", i - 1);
	}
	return false;
}

export interface LocalComponentFiles {
	key: string;
	/** Project-relative paths, forward slashes. */
	files: string[];
}

/**
 * `[localT, dirty]` for each component. `dirty` null = not a git repository (mtimes only, never dirty);
 * `commits` null = no commit times (same).
 */
export function computeLocalInfo(
	comps: Iterable<LocalComponentFiles>,
	mtimeOf: (rel: string) => number,
	dirty: ReadonlySet<string> | null,
	commits: ReadonlyMap<string, number> | null,
	/**
	 * Time of the oldest commit the bounded git scan read: a path with no commit time in `commits` is unchanged
	 * since at least then, so it is used as its local time. It is an UPPER bound on the real last-change time,
	 * which is safe for the status rules (`orgLm > localT + TOL` → changed in org: a larger localT can only
	 * make that rule stricter, never wrongly report an org change). null = no bound (mtime fallback).
	 */
	boundary: number | null = null
): LocalInfoMap {
	const out: LocalInfoMap = {};
	for (const c of comps) {
		const files: LocalFileTimes[] = c.files.map((rel) => ({
			mtime: mtimeOf(rel),
			commit: commits ? (commits.get(rel) ?? boundary ?? undefined) : undefined,
			dirty: dirty ? isPathDirty(rel, dirty) : false,
		}));
		const r = componentLocalTime(files);
		out[c.key] = [r.localT, r.dirty ? 1 : 0];
	}
	return out;
}
