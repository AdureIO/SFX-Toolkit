/**
 * Pairing of a component's local and org files for the diff (Deploy & Retrieve Center). Pure (no `vscode`).
 */

export interface DiffSide {
	abs: string;
	/** `digestContent` of the file (normalized: line endings and trailing whitespace ignored). */
	digest: string;
}

export type PairState = "different" | "local-only" | "org-only" | "equal";

export interface DiffPair {
	/** Inner path inside the type folder (the pairing key). */
	inner: string;
	state: PairState;
	local?: string;
	org?: string;
}

const ORDER: Record<PairState, number> = { different: 0, "local-only": 1, "org-only": 2, equal: 3 };

/** Pair the files of both sides by inner path; the files that differ come first, equal ones last. */
export function planDiffPairs(local: ReadonlyMap<string, DiffSide>, org: ReadonlyMap<string, DiffSide>): DiffPair[] {
	const pairs: DiffPair[] = [];
	for (const [inner, l] of local) {
		const o = org.get(inner);
		if (!o) pairs.push({ inner, state: "local-only", local: l.abs });
		else pairs.push({ inner, state: o.digest === l.digest ? "equal" : "different", local: l.abs, org: o.abs });
	}
	for (const [inner, o] of org) if (!local.has(inner)) pairs.push({ inner, state: "org-only", org: o.abs });
	return pairs.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.inner.localeCompare(b.inner));
}

export const PAIR_STATE_LABELS: Record<PairState, string> = {
	different: "differs",
	"local-only": "only local",
	"org-only": "only in org",
	equal: "equal",
};

/** Title of the diff editor: `Name (org ↔ local)`, with the file for a multi-file component. */
export function diffTitle(name: string, inner: string | undefined): string {
	return inner ? `${name}: ${inner} (org ↔ local)` : `${name} (org ↔ local)`;
}
