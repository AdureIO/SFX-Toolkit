/**
 * Test-level arguments of `sf project deploy start`, validated: shared by the Deploy panel's command builder
 * and the delete-from-org runner. Pure (no `vscode`).
 */

/** Test levels accepted by `sf project deploy start -l`. Anything else is rejected (presets are repo files). */
export const VALID_TEST_LEVELS: ReadonlySet<string> = new Set(["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg", "RunRelevantTests"]);

/** Apex test name: `Class`, `ns.Class`, `Class.method` or `ns.Class.method` (identifiers only). */
const APEX_TEST_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,2}$/;

/**
 * Validated test names from an array or the legacy `-t A -t B` string (built by the panel from preset files).
 * Throws on anything that is not a plain Apex test name, so preset content can never inject shell syntax.
 */
export function normalizeTestNames(testFlags: string | readonly string[]): string[] {
	let names: string[];
	if (Array.isArray(testFlags)) {
		names = (testFlags as readonly string[]).map((t) => t.trim()).filter(Boolean);
	} else {
		const tokens = (testFlags as string).trim().split(/\s+/).filter(Boolean);
		names = [];
		for (const tok of tokens) {
			if (tok === "-t" || tok === "--tests") continue;
			names.push(tok);
		}
	}
	for (const n of names) {
		if (!APEX_TEST_NAME_RE.test(n)) throw new Error(`Invalid Apex test name: ${JSON.stringify(n)}`);
	}
	return names;
}

/** `-t A -t B` as one string (shell-string command lines). */
export function buildTestArgs(testFlags: string | readonly string[]): string {
	return normalizeTestNames(testFlags)
		.map((n) => `-t ${n}`)
		.join(" ");
}

/** `["--test-level", level, "--tests", name, …]` as an argv; throws on an invalid level or test name. */
export function testLevelArgs(testLevel: string, testNames: readonly string[] = []): string[] {
	if (!VALID_TEST_LEVELS.has(testLevel)) throw new Error(`Invalid test level: ${JSON.stringify(testLevel)}`);
	const args = ["--test-level", testLevel];
	// Names only mean something with RunSpecifiedTests; they are validated either way.
	const names = normalizeTestNames(testNames);
	if (testLevel === "RunSpecifiedTests") for (const n of names) args.push("--tests", n);
	return args;
}
