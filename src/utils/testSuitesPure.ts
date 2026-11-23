/**
 * Test suites (named lists of test classes) for "Run Specified Tests": the pure rules shared by the Deploy panel
 * and the Deploy & Retrieve Center. Storage is in testSuites.ts; the host messaging in providers/testSuitesHost.ts.
 */

export interface TestSuite {
	name: string;
	testClassNames: string[];
}

/** The suites of a stored file; anything malformed is dropped. */
export function parseSuites(raw: unknown): TestSuite[] {
	const list = (raw as { suites?: unknown } | null)?.suites;
	if (!Array.isArray(list)) return [];
	const out: TestSuite[] = [];
	for (const s of list) {
		if (!s || typeof s.name !== "string" || !s.name.trim()) continue;
		out.push({ name: s.name, testClassNames: cleanNames(s.testClassNames) });
	}
	return out;
}

/** Strings only, trimmed, no empties, no duplicates (order kept). */
export function cleanNames(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of v) {
		if (typeof x !== "string") continue;
		const t = x.trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

/** Add the suite, or replace the one of the same name. */
export function upsertSuite(suites: TestSuite[], suite: TestSuite): TestSuite[] {
	const out = suites.slice();
	const i = out.findIndex((s) => s.name === suite.name);
	if (i >= 0) out[i] = suite;
	else out.push(suite);
	return out;
}

export function removeSuite(suites: TestSuite[], name: string): TestSuite[] {
	return suites.filter((s) => s.name !== name);
}

/** The name a save goes under: the selected suite (overwrite), else null (ask for a name). */
export function saveTarget(selectedName: string | undefined | null): string | null {
	const n = (selectedName ?? "").trim();
	return n || null;
}

/** The test classes a suite selects, or null when the name is empty or unknown (nothing changes). */
export function suiteClassNames(suites: TestSuite[], name: string): string[] | null {
	if (!name) return null;
	return suites.find((s) => s.name === name)?.testClassNames ?? null;
}

/** The test names a Center action runs: the checked classes; a History entry's recorded tests win over them. */
export function resolveRunTests(recorded: string[] | undefined, checked: string[]): string[] {
	const rec = cleanNames(recorded ?? []);
	return rec.length > 0 ? rec : cleanNames(checked);
}
