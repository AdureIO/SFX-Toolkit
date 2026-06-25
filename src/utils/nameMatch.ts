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
