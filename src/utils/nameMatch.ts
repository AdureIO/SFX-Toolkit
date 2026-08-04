/**
 * Namespace-optional name matching: a typed prefix matches a candidate if it
 * occurs at the start OR right after a namespace boundary (`__`). Lets users type
 * `Foo` to match `acme__Foo__c` without the namespace prefix. Pure + testable.
 */
export function matchesNamespaceOptional(candidate: string, prefixLower: string): boolean {
	if (!prefixLower) return true;
	if (!candidate) return false;
	const c = candidate.toLowerCase();
	if (c.startsWith(prefixLower)) return true;
	for (let idx = c.indexOf("__"); idx >= 0; idx = c.indexOf("__", idx + 2)) {
		if (c.startsWith(prefixLower, idx + 2)) return true;
	}
	return false;
}

/**
 * Fuzzy match score for a candidate against a typed query (both matched case-
 * insensitively). Higher = better; -1 means no match. Tiers, strongest first:
 *   - namespace-optional prefix (start or right after `__`)         → 1000+
 *   - case-insensitive substring (e.g. `OrgDi` in `IsvaOrgDim__c`)  → 500.. (earlier = higher)
 *   - subsequence in order (e.g. `Dim`, `Odm`)                       → 100
 * Lets completion keep substring/subsequence hits (which Monaco then highlights
 * and ranks) instead of dropping everything that isn't a prefix.
 */
export function fuzzyScore(candidate: string, queryLower: string): number {
	if (!queryLower) return 0;
	if (!candidate) return -1;
	if (matchesNamespaceOptional(candidate, queryLower)) return 1000;
	const c = candidate.toLowerCase();
	const sub = c.indexOf(queryLower);
	if (sub >= 0) return 500 - Math.min(sub, 400);
	let qi = 0;
	for (let i = 0; i < c.length && qi < queryLower.length; i++) {
		if (c[i] === queryLower[qi]) qi++;
	}
	return qi === queryLower.length ? 100 : -1;
}
