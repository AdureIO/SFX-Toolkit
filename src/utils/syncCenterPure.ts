/**
 * Deploy & Retrieve Metadata: the union row model and the button / quick-action rules. Pure (no `vscode`, no
 * DOM): runs in the extension host, the webview and the tests.
 *
 * Rows are the union of the local index (`scanProject`) and the org listing, keyed by `compKey(type, name)`
 * with the NAME AS THE ORG LISTS IT: local file names percent-encode some characters
 * (`Account-Account%20Layout`), so a local name is decoded the way `orgLookupKey` does. A row remembers the
 * key the local index knows it by (`localKey`): the local-side maps (change info, content compare results,
 * entries to deploy) are keyed by that.
 *
 * The status of a component present on both sides is `compareStatus` (compareStatusPure), the same engine the
 * Deploy panel and the Org Browser use. Nothing of those rules is repeated here.
 */
import { Comp, compKey } from "./orgBrowser/types";
import { StatusVocab } from "./orgBrowser/filter";
import {
	CODE_CHANGED_IN_ORG,
	CODE_CHANGED_LOCALLY,
	CODE_CONFLICT,
	CODE_EQUAL,
	COMPARE_CODES,
	ContentInfoMap,
	LocalInfoMap,
	anyComparedShorthand,
	compareStatus,
	contentFromCode,
	effectiveSyncedAt,
	sharedStatusAliases,
} from "./compareStatusPure";
import { orgLookupKey } from "./deployStatusPure";

// ── Statuses ───────────────────────────────────────────────────────────────────

/** The row status, one value per row. */
export type SyncStatus =
	| "only-local"
	| "equal"
	| "changed-locally"
	| "changed-in-org"
	| "conflict"
	| "partial"
	| "unknown"
	| "only-org";

/** Codes: 1..4 are the shared compare codes (compareStatusPure); the index into `SYNC_STATUS_NAMES`. */
export const SC_ONLY_LOCAL = 0;
export const SC_EQUAL = CODE_EQUAL;
export const SC_CHANGED_LOCALLY = CODE_CHANGED_LOCALLY;
export const SC_CHANGED_IN_ORG = CODE_CHANGED_IN_ORG;
export const SC_CONFLICT = CODE_CONFLICT;
export const SC_PARTIAL = 5;
export const SC_UNKNOWN = 6;
export const SC_ONLY_ORG = 7;

/** Facet names; the row's `code` is the index. */
export const SYNC_STATUS_NAMES = ["only-local", "equal", "changed-locally", "changed-in-org", "conflict", "partial", "unknown", "only-org"] as const;

export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
	"only-local": "Only local",
	equal: "Equal",
	"changed-locally": "Changed locally",
	"changed-in-org": "Changed in org (latest)",
	conflict: "Conflict",
	partial: "Partly local",
	unknown: "Not compared / unknown",
	"only-org": "Only in org",
};

/**
 * The options of the status filter group, each with the index of its count in `Facets.status`. The names keep their
 * code as index (the "In project" option comes first in the list but its count sits after the names), so a count
 * is never read from a neighbour's slot.
 */
export function syncStatusOptions(): { value: string; label: string; facetIndex: number }[] {
	return [
		{ value: SYNC_IN_PROJECT, label: "In project", facetIndex: SYNC_IN_PROJECT_FACET_INDEX },
		...SYNC_STATUS_NAMES.map((n, code) => ({ value: n, label: SYNC_STATUS_LABELS[n], facetIndex: code })),
	];
}

export const syncStatusCode = (s: SyncStatus): number => SYNC_STATUS_NAMES.indexOf(s);

/** The status facet "In project": every row that exists locally, i.e. everything except `only-org`. */
export const SYNC_IN_PROJECT = "in-project";
export const isInProjectCode = (code: number): boolean => code !== SC_ONLY_ORG;
/** Where the facet count of "In project" sits in `Facets.status` (virtual facets come after the names). */
export const SYNC_IN_PROJECT_FACET_INDEX = SYNC_STATUS_NAMES.length;

/**
 * `status:` vocabulary of the Center: the aliases of the other two panels, with `local` / `new` meaning
 * only-local and `org` / `not-local` only-org (in the Deploy panel `local` means changed-locally; here the
 * unambiguous names are `changed-locally` / `modified`).
 */
export const SYNC_CENTER_VOCAB: StatusVocab = {
	names: SYNC_STATUS_NAMES,
	flags: false,
	aliases: {
		...sharedStatusAliases(),
		// Only local (Deploy panel: new / not-in-org).
		local: "only-local",
		new: "only-local",
		"only-local": "only-local",
		onlylocal: "only-local",
		"not-in-org": "only-local",
		notinorg: "only-local",
		// Only in org (Org Browser: not-in-project / not-local / missing).
		org: "only-org",
		"only-org": "only-org",
		onlyorg: "only-org",
		"not-local": "only-org",
		notlocal: "only-org",
		"not-in-project": "only-org",
		notinproject: "only-org",
		missing: "only-org",
		// Partial (Org Browser).
		partial: "partial",
		"partly-local": "partial",
		"partly-in-project": "partial",
		// In project: everything that exists locally (all but only-org).
		project: SYNC_IN_PROJECT,
		"in-project": SYNC_IN_PROJECT,
		inproject: SYNC_IN_PROJECT,
	},
	shorthands: {
		inorg: anyComparedShorthand,
		"in-org": anyComparedShorthand,
	},
	virtual: { [SYNC_IN_PROJECT]: isInProjectCode },
};

// ── Rows ───────────────────────────────────────────────────────────────────────

/** What a local index entry contributes (a `LocalEntry` fits). */
export interface SyncLocalEntry {
	type: string;
	name: string;
	/** The local index key (`compKey(type, name)` with the name as the file system has it). */
	key: string;
}

export interface SyncRow {
	/** Row key: `compKey(type, name)` with the name as the org lists it (percent-decoded local name). */
	key: string;
	type: string;
	/** Name as the org lists it. */
	name: string;
	/** The key of the local index entry; set when `local`. Local-side maps (change info, content results, entries) use it. */
	localKey?: string;
	/** In the local index. */
	local: boolean;
	/** In the org listing. */
	inOrg: boolean;
	status: SyncStatus;
	/** Index of `status` in `SYNC_STATUS_NAMES`. */
	code: number;
	/** Decided by dates only: the contents were not compared (rendered dashed). */
	provisional: boolean;
	/** For `unknown`: the org listing of the type is missing (`org`), or the local change info is not read yet (`local`). */
	why?: "org" | "local";
	/** The local change time (epoch ms; the same value the date-based status uses: dirty/untracked → file mtime, else last commit); 0/absent = none known. */
	localT?: number;
	/** The org listing entry (namespace, last modified by / date, …); absent for local-only rows. */
	comp?: Comp;
}

export interface SyncInputs {
	/** The local project was scanned. False: every row is `unknown`. */
	localKnown: boolean;
	local: Iterable<SyncLocalEntry>;
	/** `CustomObject:<Obj>` keys with children locally but no object file (`partialObjectKeys`). */
	partialKeys?: Iterable<string>;
	/** The org listing (all listed types). */
	org: Iterable<Comp>;
	/** Types whose org listing is available (cached or fresh). A local row of another type is `unknown`. */
	listedTypes: ReadonlySet<string>;
	/** Local change info, keyed by the local key. Undefined = not read yet. */
	localInfo?: LocalInfoMap;
	/** Content compare results, keyed by the local key. */
	contentInfo?: ContentInfoMap;
	/** Toolkit retrieve / deploy log: `Type:fullName` → epoch ms (either key form is looked up). */
	retrieved?: Readonly<Record<string, number>>;
}

function mk(partial: Omit<SyncRow, "code"> & { code?: number }): SyncRow {
	return { ...partial, code: syncStatusCode(partial.status) };
}

/** The union rows of the local index and the org listing. */
export function buildSyncRows(inp: SyncInputs): SyncRow[] {
	const rows: SyncRow[] = [];
	const byKey = new Map<string, SyncRow>();
	const partial = new Set(inp.partialKeys ?? []);

	// Local side first: its entries decide the merge keys.
	const localByKey = new Map<string, SyncLocalEntry>();
	for (const e of inp.local) {
		const key = orgLookupKey(e.type, e.name);
		if (!localByKey.has(key)) localByKey.set(key, e);
	}

	const seenOrg = new Set<string>();
	for (const c of inp.org) {
		const key = compKey(c.t, c.n);
		if (seenOrg.has(key)) continue;
		seenOrg.add(key);
		const le = localByKey.get(key);
		let row: SyncRow;
		if (!inp.localKnown) {
			row = mk({ key, type: c.t, name: c.n, local: false, inOrg: true, status: "unknown", provisional: true, why: "local", comp: c });
		} else if (!le) {
			const st: SyncStatus = partial.has(key) ? "partial" : "only-org";
			row = mk({ key, type: c.t, name: c.n, local: false, inOrg: true, status: st, provisional: false, comp: c });
		} else {
			row = compared(key, c, le, inp);
		}
		rows.push(row);
		byKey.set(key, row);
	}

	// Local-only: not in the org listing.
	for (const [key, le] of localByKey) {
		if (byKey.has(key)) continue;
		const known = inp.listedTypes.has(le.type);
		const row: SyncRow = known
			? mk({ key, type: le.type, name: orgNameOf(le), localKey: le.key, local: true, inOrg: false, status: "only-local", provisional: false })
			: mk({ key, type: le.type, name: orgNameOf(le), localKey: le.key, local: true, inOrg: false, status: "unknown", provisional: true, why: "org" });
		rows.push(row);
		byKey.set(key, row);
	}
	// The local change time of every row that exists locally (one source: `localInfo`, shared with the status).
	if (inp.localInfo) {
		for (const r of rows) {
			const t = r.localKey ? inp.localInfo[r.localKey]?.[0] : 0;
			if (t && t > 0) r.localT = t;
		}
	}
	return rows;
}

function orgNameOf(e: SyncLocalEntry): string {
	return orgLookupKey(e.type, e.name).slice(e.type.length + 1);
}

/** A component on both sides: `compareStatus` over the local info, the content result and the last sync. */
function compared(key: string, c: Comp, le: SyncLocalEntry, inp: SyncInputs): SyncRow {
	const base = { key, type: c.t, name: c.n, localKey: le.key, local: true, inOrg: true, comp: c };
	const li = inp.localInfo?.[le.key];
	const ci = inp.contentInfo?.[le.key];
	const content = contentFromCode(ci?.[0]);
	if (!li && content !== "same") return mk({ ...base, status: "unknown", provisional: true, why: "local" });
	const log = inp.retrieved;
	const logTime = log ? maxDefined(log[le.key], log[key]) : undefined;
	const r = compareStatus({
		orgLm: c.lm,
		syncedAt: effectiveSyncedAt(logTime, ci && ci[2] ? ci[2] : undefined),
		localT: li ? li[0] : 0,
		dirty: li ? li[1] === 1 : false,
		content,
	});
	return { ...base, status: r.status, code: COMPARE_CODES[r.status], provisional: r.provisional };
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

/** A diff makes sense: both sides have the component and it is not just unknown. */
export function isDiffable(row: Pick<SyncRow, "status">): boolean {
	return row.status === "changed-locally" || row.status === "changed-in-org" || row.status === "conflict" || row.status === "equal";
}

// ── Button rules ───────────────────────────────────────────────────────────────

/** The explicit per-row choice of a conflict: keep the local version (deploy it) or take the org's (retrieve it). */
export type ConflictChoice = "local" | "org";

export interface SkipCount {
	/** Human readable, lower case: "only in org", "changed in org", "equal", … */
	reason: string;
	count: number;
}

export interface Candidates {
	/** Row keys that take part in the action, in row order. */
	keys: string[];
	/** Selected rows that don't count, grouped by why. */
	skipped: SkipCount[];
	/** Selected rows whose run overwrites the other side: conflicts without a choice, plus changed-in-org (Deploy) / changed-locally (Retrieve). They take part (they are in `keys`); the run asks first. Never blocks. */
	unresolvedConflicts: number;
	/** Their keys (for the "show conflicts" link and the run-time confirmation). */
	unresolvedKeys: string[];
}

export interface CandidateOptions {
	selection: ReadonlySet<string>;
	conflictChoices: ReadonlyMap<string, ConflictChoice>;
	/** `Skip equal components`: selected equal rows don't count. */
	skipEqual: boolean;
}

type Verdict = { take: true } | { take: false; reason: string };

const TAKE: Verdict = { take: true };
const skip = (reason: string): Verdict => ({ take: false, reason });

function collect(rows: readonly SyncRow[], o: CandidateOptions, verdict: (r: SyncRow) => Verdict | "unresolved"): Candidates {
	// "unresolved" = a row whose run overwrites the other side (a conflict without a choice, changed-in-org on Deploy, changed-locally on Retrieve): it takes part (and is also reported in `unresolvedKeys`).
	const keys: string[] = [];
	const skipped = new Map<string, number>();
	const unresolvedKeys: string[] = [];
	for (const r of rows) {
		if (!o.selection.has(r.key)) continue;
		const v = verdict(r);
		if (v === "unresolved") {
			unresolvedKeys.push(r.key);
			keys.push(r.key);
		} else if (v.take) keys.push(r.key);
		else skipped.set(v.reason, (skipped.get(v.reason) ?? 0) + 1);
	}
	return {
		keys,
		skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
		unresolvedConflicts: unresolvedKeys.length,
		unresolvedKeys,
	};
}

/**
 * `Deploy (n)`: selected rows that exist locally (only-local, changed-locally, partial, unknown-but-local,
 * equal unless skipped, changed-in-org) and conflict rows not set to "Take org" (no choice = takes part; the run asks first).
 */
export function deployCandidates(rows: readonly SyncRow[], selection: ReadonlySet<string>, conflictChoices: ReadonlyMap<string, ConflictChoice>, skipEqual: boolean): Candidates {
	const o = { selection, conflictChoices, skipEqual };
	return collect(rows, o, (r) => {
		switch (r.status) {
			case "only-local":
			case "changed-locally":
			case "partial":
				return TAKE;
			case "equal":
				return skipEqual ? skip("equal") : TAKE;
			case "conflict": {
				const c = conflictChoices.get(r.key);
				return c === "local" ? TAKE : c === "org" ? skip("conflict set to Take org") : "unresolved";
			}
			case "unknown":
				return r.local ? TAKE : skip("not in the project");
			case "changed-in-org":
				return "unresolved"; // takes part; deploying overwrites the newer org version (the run asks first)
			case "only-org":
				return skip("only in org");
		}
	});
}

/**
 * `Retrieve (n)`: selected rows that exist in the org (only-org, changed-in-org, partial, unknown-but-listed,
 * equal unless skipped, changed-locally) and conflict rows not set to "Keep local" (no choice = takes part; the run asks first).
 */
export function retrieveCandidates(rows: readonly SyncRow[], selection: ReadonlySet<string>, conflictChoices: ReadonlyMap<string, ConflictChoice>, skipEqual: boolean): Candidates {
	const o = { selection, conflictChoices, skipEqual };
	return collect(rows, o, (r) => {
		switch (r.status) {
			case "only-org":
			case "changed-in-org":
			case "partial":
				return TAKE;
			case "equal":
				return skipEqual ? skip("equal") : TAKE;
			case "conflict": {
				const c = conflictChoices.get(r.key);
				return c === "org" ? TAKE : c === "local" ? skip("conflict set to Keep local") : "unresolved";
			}
			case "unknown":
				return r.inOrg ? TAKE : skip("not in the org");
			case "changed-locally":
				return "unresolved"; // takes part; retrieving overwrites the local changes (the run asks first)
			case "only-local":
				return skip("only local");
		}
	});
}

/**
 * `Retrieve project (n)`: every row that exists locally and in the org (the "In project" set that has an org copy),
 * independent of the selection. only-local rows have nothing to retrieve; equal rows are skipped when `skipEqual`.
 */
export function retrieveProjectKeys(rows: readonly SyncRow[], skipEqual: boolean): string[] {
	return rows.filter((r) => r.local && r.inOrg && r.status !== "only-local" && !(skipEqual && r.status === "equal")).map((r) => r.key);
}

/** `Delete from org (n)`: selected only-org rows; everything else selected is skipped (never deleted). */
export function deleteCandidates(rows: readonly SyncRow[], selection: ReadonlySet<string>, conflictChoices: ReadonlyMap<string, ConflictChoice> = new Map(), skipEqual = true): Candidates {
	const o = { selection, conflictChoices, skipEqual };
	return collect(rows, o, (r) => {
		if (r.status === "only-org") return TAKE;
		if (r.status === "partial") return skip("partly local");
		if (r.status === "only-local") return skip("only local");
		if (r.status === "unknown" && !r.local && r.inOrg) return skip("not compared");
		return skip("also in the project");
	});
}

/** "3 only in org skipped, 1 equal skipped" for a button tooltip; "" when nothing was skipped. */
export function skippedText(c: Pick<Candidates, "skipped">): string {
	return c.skipped.map((s) => `${s.count} ${s.reason} skipped`).join(", ");
}

/** "2 selected components have a newer version in the org — deploying overwrites them." (retrieve: "have local changes … your local files"), or "" when none. */
export function unresolvedText(c: Pick<Candidates, "unresolvedConflicts">, mode: "deploy" | "retrieve" = "deploy"): string {
	const n = c.unresolvedConflicts;
	if (n === 0) return "";
	const what = n === 1 ? "1 selected component has" : `${n} selected components have`;
	return mode === "deploy" ? `${what} a newer version in the org — deploying overwrites ${n === 1 ? "it" : "them"}.` : `${what} local changes — retrieving overwrites your local files.`;
}

/** `{ type, fullName }` as the retrieve engine and the destructive package want them (org naming), for row keys. */
export function componentRefs(rows: readonly SyncRow[], keys: readonly string[]): { type: string; fullName: string }[] {
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const out: { type: string; fullName: string }[] = [];
	for (const k of keys) {
		const r = byKey.get(k);
		if (r) out.push({ type: r.type, fullName: r.name });
	}
	return out;
}

/** The local index keys of row keys (what the Deploy panel's `deployPathsForComponents` takes). Rows without a local entry are dropped. */
export function localKeysOf(rows: readonly SyncRow[], keys: readonly string[]): string[] {
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const out: string[] = [];
	for (const k of keys) {
		const lk = byKey.get(k)?.localKey;
		if (lk) out.push(lk);
	}
	return out;
}

// ── Quick actions ──────────────────────────────────────────────────────────────

export type QuickAction = "changedLocally" | "changedInOrg" | "allChanges" | "onlyLocal";

const QUICK: Record<QuickAction, (s: SyncStatus) => boolean> = {
	changedLocally: (s) => s === "changed-locally",
	changedInOrg: (s) => s === "changed-in-org",
	allChanges: (s) => s === "changed-locally" || s === "changed-in-org" || s === "conflict",
	onlyLocal: (s) => s === "only-local",
};

/** Row keys a quick action selects. `visible` (the keys the filter shows) limits it; omitted = every row. */
export function quickActionKeys(rows: readonly SyncRow[], action: QuickAction, visible?: ReadonlySet<string>): string[] {
	const test = QUICK[action];
	return rows.filter((r) => test(r.status) && (!visible || visible.has(r.key))).map((r) => r.key);
}

/** The counts shown next to the quick actions. */
export function quickActionCounts(rows: readonly SyncRow[], visible?: ReadonlySet<string>): Record<QuickAction, number> {
	return {
		changedLocally: quickActionKeys(rows, "changedLocally", visible).length,
		changedInOrg: quickActionKeys(rows, "changedInOrg", visible).length,
		allChanges: quickActionKeys(rows, "allChanges", visible).length,
		onlyLocal: quickActionKeys(rows, "onlyLocal", visible).length,
	};
}

/** The right panel's action: it decides which section shows and which rows can take part. */
export type CenterMode = "deploy" | "retrieve" | "delete";

export const CENTER_MODES: readonly CenterMode[] = ["deploy", "retrieve", "delete"];

export function normalizeMode(v: unknown): CenterMode {
	return v === "retrieve" || v === "delete" ? v : "deploy";
}

/**
 * Can this row take part in `mode`? Deploy needs local files, Retrieve needs the component in the org, Delete only
 * takes rows that exist only in the org. (The button counts apply further rules: equal rows, conflicts set the other way.)
 */
export function takesPart(mode: CenterMode, row: Pick<SyncRow, "local" | "inOrg" | "status">): boolean {
	return mode === "deploy" ? row.local : mode === "retrieve" ? row.inOrg : row.status === "only-org";
}
