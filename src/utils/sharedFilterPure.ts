/**
 * Search text and type selection shared between the Org Browser and the Deploy Metadata panel, per
 * project (workspaceState key `asfx.metadataFilter.<projectDir>`). Pure (no `vscode`, no DOM).
 *
 * Status filters are NOT shared (each panel has its own vocabulary): neither the status facet nor
 * `status:` tokens typed into the query. `splitQuery` / `joinQuery` keep a panel's own `status:` tokens
 * out of what it shares, and in place when it receives the other panel's query.
 */
import { tokenize } from "./orgBrowser/filter";

export interface SharedFilter {
	/** Search text without `status:` tokens. */
	query: string;
	/** Selected metadata types (empty = all). */
	types: string[];
}

export function sharedFilterKey(projectDir: string): string {
	return `asfx.metadataFilter.${projectDir}`;
}

const isStatusToken = (t: string) => /^-?status:/i.test(t);

/** The query split into what is shared and the panel's own `status:` tokens (verbatim). */
export function splitQuery(query: string): { shared: string; status: string[] } {
	const shared: string[] = [];
	const status: string[] = [];
	for (const t of tokenize(query)) (isStatusToken(t) ? status : shared).push(t);
	return { shared: shared.join(" "), status };
}

/** The shared text followed by the panel's own `status:` tokens. */
export function joinQuery(shared: string, status: readonly string[]): string {
	return [shared.trim(), ...status].filter(Boolean).join(" ");
}

/** What a panel shares of its filter state. */
export function sharedPart(filter: { query: string; types: readonly string[] }): SharedFilter {
	return { query: splitQuery(filter.query).shared, types: [...filter.types] };
}

/** A stored / received value, or null when it is not a shared filter. */
export function sanitizeSharedFilter(raw: unknown): SharedFilter | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { query?: unknown; types?: unknown };
	if (typeof r.query !== "string" || !Array.isArray(r.types)) return null;
	return { query: r.query, types: [...new Set(r.types.filter((t): t is string => typeof t === "string" && t !== ""))] };
}

export function sameSharedFilter(a: SharedFilter | null | undefined, b: SharedFilter | null | undefined): boolean {
	if (!a || !b) return a === b;
	return a.query === b.query && a.types.length === b.types.length && a.types.every((t, i) => t === b.types[i]);
}

/**
 * A panel's filter after receiving `shared`: the shared query and types, its own `status:` tokens kept.
 * (Everything else of its filter — status facet, namespace, dates — is untouched by the caller.)
 */
export function applyShared(ownQuery: string, shared: SharedFilter): { query: string; types: string[] } {
	return { query: joinQuery(shared.query, splitQuery(ownQuery).status), types: [...shared.types] };
}
