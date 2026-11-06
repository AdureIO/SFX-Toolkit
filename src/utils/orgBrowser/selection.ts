/**
 * Pure helpers (no `vscode`, no DOM) for selections that outlive the current filter: splitting a
 * selection into visible / hidden keys and summarising the hidden ones per metadata type.
 * Keys are `Type:fullName` (see `compKey`).
 */

/** Selected keys split by whether the current filter shows them. Order is preserved. */
export function splitByVisibility(selected: Iterable<string>, visible: ReadonlySet<string>): { visible: string[]; hidden: string[] } {
	const out = { visible: [] as string[], hidden: [] as string[] };
	for (const k of selected) (visible.has(k) ? out.visible : out.hidden).push(k);
	return out;
}

/** Metadata type of a `Type:fullName` key. */
export function typeOfKey(key: string): string {
	const c = key.indexOf(":");
	return c < 0 ? key : key.slice(0, c);
}

/** Component count per type, most components first, then by type name. */
export function summarizeByType(keys: Iterable<string>): { type: string; count: number }[] {
	const m = new Map<string, number>();
	for (const k of keys) {
		const t = typeOfKey(k);
		m.set(t, (m.get(t) ?? 0) + 1);
	}
	return [...m.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/**
 * Per-type lines for a modal, at most `maxLines` (default 5): `98 ApexClass`; when there are more
 * types than lines the last line folds the rest into `N more (M types)`.
 */
export function hiddenTypeLines(hidden: Iterable<string>, maxLines = 5): string[] {
	const summary = summarizeByType(hidden);
	if (summary.length <= maxLines) return summary.map((s) => `${s.count} ${s.type}`);
	const shown = summary.slice(0, maxLines - 1);
	const rest = summary.slice(maxLines - 1);
	const restCount = rest.reduce((n, s) => n + s.count, 0);
	return [...shown.map((s) => `${s.count} ${s.type}`), `${restCount} in ${rest.length} other types`];
}

/** Title + detail of the "hidden selection" modal. */
export function hiddenSelectionPrompt(total: number, hiddenKeys: string[]): { message: string; detail: string } {
	const n = hiddenKeys.length;
	return {
		message: `Retrieve ${total} component${total === 1 ? "" : "s"}?`,
		detail: `${n} of them ${n === 1 ? "is" : "are"} hidden by the current filter:\n${hiddenTypeLines(hiddenKeys).join("\n")}`,
	};
}
