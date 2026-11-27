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

// ── Test level of a delete from the org ────────────────────────────────────────

/** The levels the Delete section offers (the Deploy section's "relevant tests" is a toolkit level, not for a delete). */
export const DELETE_TEST_LEVELS: readonly string[] = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];

/** Deleting these runs Apex tests in the org. */
const APEX_TYPES: ReadonlySet<string> = new Set(["ApexClass", "ApexTrigger"]);

export interface DeleteTestCheck {
	/** Set: the delete must not start; the text says why. */
	error?: string;
	/** Shown, not blocking. */
	hint?: string;
}

/**
 * The test options of a delete from the org. Production (an org that could not be verified counts as production)
 * cannot delete with `NoTestRun`; `RunSpecifiedTests` needs at least one test. On a non-production org, deleting
 * an Apex class or trigger with `NoTestRun` is allowed, with a hint. `types` are the metadata types being deleted.
 */
export function checkDeleteTestOptions(level: string, testNames: readonly string[], types: Iterable<string>, production: boolean): DeleteTestCheck {
	if (!VALID_TEST_LEVELS.has(level)) return { error: `Invalid test level: ${level}` };
	if (level === "RunSpecifiedTests" && testNames.filter((t) => t.trim() !== "").length === 0) return { error: "Select at least one test class for Run Specified Tests." };
	if (level === "NoTestRun") {
		if (production) return { error: "Production orgs cannot deploy without running tests, and a delete is a deploy. Choose Run Local Tests, Run All Tests or Run Specified Tests." };
		for (const t of types) if (APEX_TYPES.has(t)) return { hint: deleteNoTestsHint() };
	}
	return {};
}

export function deleteNoTestsHint(): string {
	return "No tests run. That is allowed here because this is not a production org, but deleting Apex classes or triggers without tests is rejected on production.";
}

/** The webview's hint under the Delete section's test level (it cannot tell production): Apex among the types and `NoTestRun`. */
export function deleteTestHint(level: string, types: Iterable<string>): string {
	if (level !== "NoTestRun") return "";
	for (const t of types) if (APEX_TYPES.has(t)) return "Deleting Apex classes or triggers without tests only works on non-production orgs. Production orgs refuse No Test Run.";
	return "";
}
