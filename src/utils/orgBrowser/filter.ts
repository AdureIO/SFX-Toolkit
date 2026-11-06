/**
 * Org Browser search and filtering. Pure (no `vscode`, no DOM): runs in the webview and in tests.
 *
 * Query language (tokens are ANDed; quote with "..." to keep spaces):
 *   foo bar              both substrings must appear in the name or the type (case-insensitive)
 *   Acc*Handler  *Test   `*` / `?` wildcards; a wildcard token must match the WHOLE name (or type)
 *   -foo                 a leading `-` excludes
 *   type:ApexClass       type equals (wildcards allowed); several type: tokens are ORed
 *   ns:abc  ns:none      namespace prefix equals; `ns:none` / `ns:` = unmanaged; ORed
 *   by:smith  by:"Jo Do" last-modified-by name contains; ORed
 *   status:not-local|local|changed   local status; ORed
 *   ApexClass:Foo        `Type:Name` (type equals, name contains / wildcard)
 */
import { Comp, STATUS_CHANGED, STATUS_LOCAL, STATUS_NAMES, STATUS_NOT_LOCAL, StatusName, compKey } from "./types";

// ── Search index ───────────────────────────────────────────────────────────────

/** Lower-cased columns, parallel to `comps`, so a keystroke does no per-row allocation. */
export interface SearchIndex {
	comps: Comp[];
	ln: string[];
	lt: string[];
	lby: string[];
	lns: string[];
}

export function buildIndex(comps: Comp[]): SearchIndex {
	const idx: SearchIndex = { comps: [], ln: [], lt: [], lby: [], lns: [] };
	appendToIndex(idx, comps);
	return idx;
}

/** Append rows (streaming batches). Returns the same index. */
export function appendToIndex(idx: SearchIndex, comps: Comp[]): SearchIndex {
	for (const c of comps) {
		idx.comps.push(c);
		idx.ln.push(c.n.toLowerCase());
		idx.lt.push(c.t.toLowerCase());
		idx.lby.push(c.by.toLowerCase());
		idx.lns.push(c.ns.toLowerCase());
	}
	return idx;
}

// ── Filter state ───────────────────────────────────────────────────────────────

export type ModifiedWithin = "any" | "24h" | "7d" | "30d" | "custom";
export type NamespaceMode = "all" | "unmanaged" | "specific";

export interface FilterState {
	query: string;
	/** Selected metadata types (empty = all). */
	types: string[];
	nsMode: NamespaceMode;
	/** Used when nsMode = "specific" ("" stands for unmanaged). */
	namespaces: string[];
	/** manageableState values (empty = all). */
	states: string[];
	/** Local status values (empty = all). */
	status: StatusName[];
	/** Only rows last modified by the current user. */
	mine: boolean;
	within: ModifiedWithin;
	/** Epoch ms bounds for `within = "custom"` (inclusive). */
	from?: number;
	to?: number;
	/** Show only selected rows. */
	onlySelected: boolean;
}

export const DEFAULT_FILTER: FilterState = {
	query: "",
	types: [],
	nsMode: "all",
	namespaces: [],
	states: [],
	status: [],
	mine: false,
	within: "any",
	onlySelected: false,
};

export interface FilterContext {
	now: number;
	/** Local status per row index (0 not-local, 1 local, 2 changed); null = unknown (all not-local). */
	status: ArrayLike<number> | null;
	/** Selected row keys (`Type:fullName`). */
	selected?: ReadonlySet<string>;
	/** Current user: ids (lastModifiedById) and/or display name. */
	meIds?: string[];
	meName?: string;
}

const HOUR = 3600_000;
const WINDOW_MS: Record<string, number> = { "24h": 24 * HOUR, "7d": 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };

// ── Query parsing ──────────────────────────────────────────────────────────────

/** A text pattern: substring, or an anchored glob when it contains `*` / `?`. */
export interface Pattern {
	lower: string;
	glob: boolean;
	re?: RegExp;
}

function escapeRe(s: string): string {
	return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function makePattern(raw: string): Pattern {
	const lower = raw.toLowerCase();
	if (!/[*?]/.test(lower)) return { lower, glob: false };
	const re = new RegExp("^" + lower.split("").map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escapeRe(ch))).join("") + "$", "s");
	return { lower, glob: true, re };
}

/** Substring (or anchored glob) test against an already-lowercased string. */
function patternTest(p: Pattern, lowered: string): boolean {
	return p.glob ? p.re!.test(lowered) : lowered.includes(p.lower);
}

/** Equality (or glob) test, for type / namespace operators. */
function patternEquals(p: Pattern, lowered: string): boolean {
	return p.glob ? p.re!.test(lowered) : lowered === p.lower;
}

interface Clause<T> {
	neg: boolean;
	value: T;
}

export interface ParsedQuery {
	/** Plain words: match name or type. */
	terms: Clause<Pattern>[];
	types: Clause<Pattern>[];
	/** Lower-cased namespace prefixes ("" = unmanaged). */
	ns: Clause<string>[];
	by: Clause<Pattern>[];
	status: Clause<number>[];
	/** `Type:Name` tokens. */
	typeNames: Clause<{ type: Pattern; name: Pattern }>[];
}

const OPERATORS = new Set(["type", "ns", "by", "status"]);

const STATUS_ALIASES: Record<string, number> = {
	"not-local": STATUS_NOT_LOCAL,
	notlocal: STATUS_NOT_LOCAL,
	missing: STATUS_NOT_LOCAL,
	local: STATUS_LOCAL,
	"in-project": STATUS_LOCAL,
	inproject: STATUS_LOCAL,
	changed: STATUS_CHANGED,
};

function stripQuotes(s: string): string {
	return s.replace(/"/g, "");
}

/** Split on whitespace, keeping "quoted phrases" (also inside `by:"A B"`) together. */
export function tokenize(q: string): string[] {
	return q.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

export function parseQuery(q: string): ParsedQuery {
	const parsed: ParsedQuery = { terms: [], types: [], ns: [], by: [], status: [], typeNames: [] };
	for (let tok of tokenize(q)) {
		let neg = false;
		if (tok.length > 1 && tok[0] === "-") {
			neg = true;
			tok = tok.slice(1);
		}
		const colon = tok.indexOf(":");
		const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : "";
		const rest = colon > 0 ? stripQuotes(tok.slice(colon + 1)) : "";
		if (key && OPERATORS.has(key)) {
			switch (key) {
				case "type":
					if (rest) parsed.types.push({ neg, value: makePattern(rest) });
					break;
				case "ns":
					parsed.ns.push({ neg, value: /^(none|-)?$/i.test(rest) ? "" : rest.toLowerCase() });
					break;
				case "by":
					if (rest) parsed.by.push({ neg, value: makePattern(rest) });
					break;
				case "status": {
					const code = STATUS_ALIASES[rest.toLowerCase()];
					if (code !== undefined) parsed.status.push({ neg, value: code });
					break;
				}
			}
			continue;
		}
		const typeName = colon > 0 ? /^([A-Za-z][A-Za-z0-9_]*):(.+)$/.exec(stripQuotes(tok)) : null;
		if (typeName) {
			parsed.typeNames.push({ neg, value: { type: makePattern(typeName[1]), name: makePattern(typeName[2]) } });
			continue;
		}
		const text = stripQuotes(tok);
		if (text) parsed.terms.push({ neg, value: makePattern(text) });
	}
	return parsed;
}

export function isEmptyQuery(p: ParsedQuery): boolean {
	return !p.terms.length && !p.types.length && !p.ns.length && !p.by.length && !p.status.length && !p.typeNames.length;
}

type RowTest = (i: number) => boolean;

/** Compile a parsed query into one predicate over row indexes (null = matches everything). */
function compileQuery(p: ParsedQuery, idx: SearchIndex, status: ArrayLike<number> | null): RowTest | null {
	const tests: RowTest[] = [];
	for (const t of p.terms) {
		const pat = t.value;
		tests.push(t.neg ? (i) => !(patternTest(pat, idx.ln[i]) || patternTest(pat, idx.lt[i])) : (i) => patternTest(pat, idx.ln[i]) || patternTest(pat, idx.lt[i]));
	}
	for (const t of p.typeNames) {
		const { type, name } = t.value;
		const f: RowTest = (i) => patternEquals(type, idx.lt[i]) && patternTest(name, idx.ln[i]);
		tests.push(t.neg ? (i) => !f(i) : f);
	}
	const orGroup = <T>(clauses: Clause<T>[], match: (v: T, i: number) => boolean) => {
		const pos = clauses.filter((c) => !c.neg).map((c) => c.value);
		const neg = clauses.filter((c) => c.neg).map((c) => c.value);
		if (pos.length) tests.push((i) => pos.some((v) => match(v, i)));
		for (const v of neg) tests.push((i) => !match(v, i));
	};
	orGroup(p.types, (v, i) => patternEquals(v, idx.lt[i]));
	orGroup(p.ns, (v, i) => idx.lns[i] === v);
	orGroup(p.by, (v, i) => patternTest(v, idx.lby[i]));
	orGroup(p.status, (v, i) => (status ? status[i] : STATUS_NOT_LOCAL) === v);
	if (tests.length === 0) return null;
	if (tests.length === 1) return tests[0];
	return (i) => {
		for (let k = 0; k < tests.length; k++) if (!tests[k](i)) return false;
		return true;
	};
}

// ── Row predicates ─────────────────────────────────────────────────────────────

interface Predicates {
	/** Everything except the four facet filters (query, mine, date, only-selected). */
	base: RowTest;
	type: RowTest;
	ns: RowTest;
	ms: RowTest;
	status: RowTest;
}

const always: RowTest = () => true;

function buildPredicates(idx: SearchIndex, state: FilterState, ctx: FilterContext): Predicates {
	const comps = idx.comps;
	const parsed = parseQuery(state.query);
	const q = compileQuery(parsed, idx, ctx.status);
	const baseTests: RowTest[] = [];
	if (q) baseTests.push(q);

	if (state.mine) {
		const ids = new Set(ctx.meIds ?? []);
		const name = (ctx.meName ?? "").toLowerCase();
		baseTests.push((i) => (ids.size > 0 && ids.has(comps[i].bi)) || (!!name && idx.lby[i] === name));
	}
	if (state.within !== "any") {
		let lo = 0;
		let hi = Infinity;
		if (state.within === "custom") {
			lo = state.from ?? 0;
			hi = state.to ?? Infinity;
		} else {
			lo = ctx.now - (WINDOW_MS[state.within] ?? 0);
		}
		baseTests.push((i) => {
			const lm = comps[i].lm;
			return lm > 0 && lm >= lo && lm <= hi;
		});
	}
	if (state.onlySelected) {
		const sel = ctx.selected ?? new Set<string>();
		baseTests.push((i) => sel.has(compKey(comps[i].t, comps[i].n)));
	}
	const base: RowTest =
		baseTests.length === 0
			? always
			: baseTests.length === 1
				? baseTests[0]
				: (i) => {
						for (let k = 0; k < baseTests.length; k++) if (!baseTests[k](i)) return false;
						return true;
					};

	let type = always;
	if (state.types.length > 0) {
		const set = new Set(state.types);
		type = (i) => set.has(comps[i].t);
	}
	let ns = always;
	if (state.nsMode === "unmanaged") ns = (i) => comps[i].ns === "";
	else if (state.nsMode === "specific") {
		const set = new Set(state.namespaces.map((n) => n.toLowerCase()));
		ns = (i) => set.has(idx.lns[i]);
	}
	let ms = always;
	if (state.states.length > 0) {
		const set = new Set(state.states);
		ms = (i) => set.has(comps[i].ms);
	}
	let status = always;
	if (state.status.length > 0) {
		const set = new Set(state.status.map((s) => STATUS_NAMES.indexOf(s)));
		status = (i) => set.has(ctx.status ? ctx.status[i] : STATUS_NOT_LOCAL);
	}
	return { base, type, ns, ms, status };
}

/** Indexes (into `idx.comps`) of the rows that pass every filter, in original order. */
export function filterIndices(idx: SearchIndex, state: FilterState, ctx: FilterContext): number[] {
	const p = buildPredicates(idx, state, ctx);
	const out: number[] = [];
	const n = idx.comps.length;
	for (let i = 0; i < n; i++) if (p.base(i) && p.type(i) && p.ns(i) && p.ms(i) && p.status(i)) out.push(i);
	return out;
}

export interface Facets {
	/** Rows per type given every OTHER filter (so the list shows what selecting a type would add). */
	types: Map<string, number>;
	/** Rows per namespace ("" = unmanaged). */
	namespaces: Map<string, number>;
	states: Map<string, number>;
	/** Rows per local status code: [not-local, local, changed]. */
	status: [number, number, number];
}

/** Facet counts in a single pass; each facet ignores its own filter only. */
export function computeFacets(idx: SearchIndex, state: FilterState, ctx: FilterContext): Facets {
	const p = buildPredicates(idx, state, ctx);
	const types = new Map<string, number>();
	const namespaces = new Map<string, number>();
	const states = new Map<string, number>();
	const status: [number, number, number] = [0, 0, 0];
	const n = idx.comps.length;
	for (let i = 0; i < n; i++) {
		if (!p.base(i)) continue;
		const pt = p.type(i);
		const pn = p.ns(i);
		const pm = p.ms(i);
		const ps = p.status(i);
		const c = idx.comps[i];
		if (pn && pm && ps) types.set(c.t, (types.get(c.t) ?? 0) + 1);
		if (pt && pm && ps) namespaces.set(c.ns, (namespaces.get(c.ns) ?? 0) + 1);
		if (pt && pn && ps) states.set(c.ms, (states.get(c.ms) ?? 0) + 1);
		if (pt && pn && pm) status[ctx.status ? (ctx.status[i] as 0 | 1 | 2) : 0]++;
	}
	return { types, namespaces, states, status };
}

// ── Sorting ────────────────────────────────────────────────────────────────────

export type SortKey = "name" | "type" | "ns" | "by" | "modified" | "status";

/** Sort row indexes in place by a column (stable; ties fall back to name). */
export function sortIndices(idx: SearchIndex, rows: number[], key: SortKey, dir: 1 | -1, status: ArrayLike<number> | null): number[] {
	const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	let primary: (a: number, b: number) => number;
	switch (key) {
		case "type":
			primary = (a, b) => cmpStr(idx.lt[a], idx.lt[b]);
			break;
		case "ns":
			primary = (a, b) => cmpStr(idx.lns[a], idx.lns[b]);
			break;
		case "by":
			primary = (a, b) => cmpStr(idx.lby[a], idx.lby[b]);
			break;
		case "modified":
			primary = (a, b) => idx.comps[a].lm - idx.comps[b].lm;
			break;
		case "status":
			primary = (a, b) => (status ? status[a] - status[b] : 0);
			break;
		default:
			primary = (a, b) => cmpStr(idx.ln[a], idx.ln[b]);
	}
	return rows.sort((a, b) => dir * primary(a, b) || cmpStr(idx.ln[a], idx.ln[b]) || a - b);
}

// ── Pasted `Type:Name` lists ───────────────────────────────────────────────────

export interface Pair {
	type: string;
	name: string;
}

/**
 * Parse pasted text where EVERY non-empty line is `Type:Name` (package.xml-like lists, copied rows).
 * Returns null when any line does not fit, or `knownTypes` is given and a type is unknown.
 */
export function parsePastedPairs(text: string, knownTypes?: ReadonlySet<string>): Pair[] | null {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	if (lines.length === 0) return null;
	const known = knownTypes ? new Set([...knownTypes].map((t) => t.toLowerCase())) : null;
	const out: Pair[] = [];
	for (const line of lines) {
		const m = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/.exec(line);
		if (!m) return null;
		if (known && !known.has(m[1].toLowerCase())) return null;
		out.push({ type: m[1], name: m[2].trim() });
	}
	return out;
}

/** Exact (case-insensitive) lookup of pasted pairs. */
export function matchPairs(idx: SearchIndex, pairs: Pair[]): { indices: number[]; missing: Pair[] } {
	const want = new Map<string, Pair>();
	for (const p of pairs) want.set(`${p.type.toLowerCase()}:${p.name.toLowerCase()}`, p);
	const found = new Set<string>();
	const indices: number[] = [];
	for (let i = 0; i < idx.comps.length; i++) {
		const key = `${idx.lt[i]}:${idx.ln[i]}`;
		if (want.has(key)) {
			indices.push(i);
			found.add(key);
		}
	}
	const missing = [...want.entries()].filter(([k]) => !found.has(k)).map(([, v]) => v);
	return { indices, missing };
}

// ── Highlighting ───────────────────────────────────────────────────────────────

/** Literal fragments of the positive terms of a query, for match highlighting. */
export function highlightTerms(query: string): string[] {
	const p = parseQuery(query);
	const out: string[] = [];
	const add = (pat: Pattern) => {
		if (!pat.glob) {
			if (pat.lower) out.push(pat.lower);
		} else {
			for (const frag of pat.lower.split(/[*?]+/)) if (frag) out.push(frag);
		}
	};
	for (const t of p.terms) if (!t.neg) add(t.value);
	for (const t of p.typeNames) if (!t.neg) add(t.value.name);
	return out;
}

/** Merged `[start, end)` ranges of `terms` inside `text` (case-insensitive). */
export function highlightRanges(text: string, terms: string[]): [number, number][] {
	if (terms.length === 0 || !text) return [];
	const lower = text.toLowerCase();
	const ranges: [number, number][] = [];
	for (const t of terms) {
		let from = 0;
		for (;;) {
			const at = lower.indexOf(t, from);
			if (at < 0) break;
			ranges.push([at, at + t.length]);
			from = at + t.length;
		}
	}
	if (ranges.length === 0) return [];
	ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: [number, number][] = [ranges[0]];
	for (const r of ranges.slice(1)) {
		const last = merged[merged.length - 1];
		if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push(r);
	}
	return merged;
}

// ── Display helpers ────────────────────────────────────────────────────────────

/** "5 min ago", "3 h ago", "12 d ago", or a locale date for old ones; "" for 0. */
export function relativeTime(ms: number, now: number): string {
	if (!ms) return "";
	const diff = Math.max(0, now - ms);
	const min = Math.floor(diff / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.floor(min / 60);
	if (h < 48) return `${h} h ago`;
	const d = Math.floor(h / 24);
	if (d < 60) return `${d} d ago`;
	return new Date(ms).toISOString().slice(0, 10);
}
