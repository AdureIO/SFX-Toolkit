/**
 * Lightweight SOQL field validation against a known object's schema. Flags field
 * references in the top-level SELECT and WHERE clauses whose root isn't a field
 * or relationship of the FROM object. Conservative by design — anything it can't
 * confidently resolve (functions, subqueries, TYPEOF, aliases, deep relationship
 * paths) is skipped, so it won't false-positive on valid queries.
 *
 * Pure (no I/O): the caller passes the field/relationship name sets (which it
 * already has cached), so validation never triggers a fetch.
 */
export interface SoqlMarker {
	line: number; // 0-based
	startCol: number; // 0-based
	endCol: number;
	message: string;
}

const CLAUSE_KEYWORDS = /^(group|order|limit|offset|for|with|update|using)$/i;
// Right-hand SOQL date/value literals and keywords that may appear before/around
// operators but are not fields.
const VALUE_WORDS = new Set([
	"null", "true", "false", "today", "yesterday", "tomorrow", "this_week", "last_week", "next_week",
	"this_month", "last_month", "next_month", "this_year", "last_year", "next_year", "this_quarter",
	"last_quarter", "next_quarter", "last_n_days", "next_n_days", "last_n_months", "next_n_months",
	"and", "or", "not", "in", "like", "includes", "excludes",
]);

function posAt(text: string, offset: number): { line: number; col: number } {
	let line = 0, last = 0;
	for (let i = 0; i < offset; i++) {
		if (text[i] === "\n") { line++; last = i + 1; }
	}
	return { line, col: offset - last };
}

/** Top-level (paren-depth 0) keyword offsets, string-literal aware. */
function topLevelKeywords(text: string): { word: string; start: number; end: number }[] {
	const out: { word: string; start: number; end: number }[] = [];
	let depth = 0, inStr = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) { if (c === "\\") i++; else if (c === "'") inStr = false; continue; }
		if (c === "'") { inStr = true; continue; }
		if (c === "(") { depth++; continue; }
		if (c === ")") { depth = Math.max(0, depth - 1); continue; }
		if (depth === 0 && /[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
			out.push({ word: text.slice(i, j), start: i, end: j });
			i = j - 1;
		}
	}
	return out;
}

/** The main (top-level) FROM object of a SOQL query, or null. */
export function topLevelFromObject(text: string): string | null {
	const kws = topLevelKeywords(text);
	const selIdx = kws.findIndex((k) => /^select$/i.test(k.word));
	if (selIdx < 0) return null;
	const from = kws.find((k, i) => i > selIdx && /^from$/i.test(k.word));
	if (!from) return null;
	const m = /^\s*([A-Za-z_]\w*)/.exec(text.slice(from.end));
	return m ? m[1] : null;
}

/** Validate field roots in the top-level SELECT and WHERE clauses. */
export function validateSoqlFields(text: string, fields: Set<string>, rels: Set<string>): SoqlMarker[] {
	const markers: SoqlMarker[] = [];
	const kws = topLevelKeywords(text);
	const selIdx = kws.findIndex((k) => /^select$/i.test(k.word));
	if (selIdx < 0) return markers;
	const fromIdx = kws.findIndex((k, i) => i > selIdx && /^from$/i.test(k.word));
	if (fromIdx < 0) return markers;

	const isField = (root: string) => fields.has(root.toLowerCase());
	const isRel = (root: string) => rels.has(root.toLowerCase());
	const known = (root: string, dotted: boolean) =>
		root.toLowerCase() === "id" || (dotted ? isRel(root) || isField(root) : isField(root) || isRel(root));

	// ── SELECT clause: between SELECT and FROM ──────────────────────────────────
	const selStart = kws[selIdx].end;
	const selEnd = kws[fromIdx].start;
	markRoots(text, selStart, selEnd, markers, known, /* select */ true);

	// ── WHERE clause: between WHERE and the next top-level clause keyword ────────
	const whereIdx = kws.findIndex((k, i) => i > fromIdx && /^where$/i.test(k.word));
	if (whereIdx >= 0) {
		const wStart = kws[whereIdx].end;
		const next = kws.find((k, i) => i > whereIdx && CLAUSE_KEYWORDS.test(k.word));
		const wEnd = next ? next.start : text.length;
		markRoots(text, wStart, wEnd, markers, known, /* select */ false);
	}
	return markers;
}

/**
 * Scan [start,end) at paren-depth 0 and flag identifier roots that aren't known.
 * In SELECT mode every comma-separated item's root is a field; in WHERE mode only
 * identifiers immediately followed by a comparison operator are treated as fields.
 */
function markRoots(
	text: string, start: number, end: number, markers: SoqlMarker[],
	known: (root: string, dotted: boolean) => boolean, select: boolean
): void {
	let depth = 0, inStr = false;
	for (let i = start; i < end; i++) {
		const c = text[i];
		if (inStr) { if (c === "\\") i++; else if (c === "'") inStr = false; continue; }
		if (c === "'") { inStr = true; continue; }
		if (c === "(") { depth++; continue; }
		if (c === ")") { depth = Math.max(0, depth - 1); continue; }
		if (depth !== 0) continue;
		if (!/[A-Za-z_]/.test(c)) continue;

		// Read the identifier (may be dotted: Account.Owner.Name).
		let j = i + 1;
		while (j < end && /[A-Za-z0-9_.]/.test(text[j])) j++;
		const token = text.slice(i, j);
		const rootEnd = i + (token.indexOf(".") === -1 ? token.length : token.indexOf("."));
		const root = text.slice(i, rootEnd);
		const dotted = token.includes(".");

		// Skip function calls (identifier directly followed by '(').
		let k = j; while (k < end && /\s/.test(text[k])) k++;
		const isCall = text[k] === "(";

		// Skip TYPEOF blocks and value/keyword words.
		const low = root.toLowerCase();
		const skip = isCall || VALUE_WORDS.has(low) || low === "typeof" || low === "end" || low === "when" || low === "then" || low === "else";

		let treatAsField = false;
		if (!skip) {
			if (select) {
				treatAsField = true; // every non-function SELECT item root is a field/rel
			} else {
				// WHERE: only if this identifier is the left side of a comparison.
				treatAsField = /^(=|!=|<>|<=|>=|<|>|like|in|includes|excludes)/i.test(text.slice(k).trimStart()) ||
					/^(=|!=|<>|<=|>=|<|>)/.test(text.slice(k));
			}
		}

		if (treatAsField && !known(root, dotted)) {
			const p = posAt(text, i);
			markers.push({ line: p.line, startCol: p.col, endCol: p.col + root.length, message: `Unknown field '${root}' on the queried object.` });
		}
		i = j - 1;
	}
}
