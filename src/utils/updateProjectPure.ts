/** Pure helpers for "Update Project from Org" (no vscode). */
import * as path from "path";

/** Absolute, existing, de-duplicated package directory paths of one project. */
export function resolvePackageDirPaths(projectDir: string, dirs: string[], exists: (p: string) => boolean): string[] {
	const out: string[] = [];
	for (const d of dirs) {
		const abs = path.resolve(projectDir, d);
		if (exists(abs) && !out.includes(abs)) out.push(abs);
	}
	return out;
}

/** A failure the CLI reports for a component the org no longer has. */
export function isNotFoundFailure(error: string): boolean {
	return /not\s*found|no (?:source|component|metadata)|does not exist|no longer exist/i.test(error);
}

export interface UpdateSummary {
	text: string;
	/** True when something other than "gone from the org" failed. */
	hasRealFailures: boolean;
}

export function buildUpdateSummary(orgLabel: string, retrieved: number, failed: { error: string }[]): UpdateSummary {
	const missing = failed.filter((f) => isNotFoundFailure(f.error)).length;
	const other = failed.length - missing;
	const parts: string[] = [];
	if (missing > 0) parts.push(`${missing} component${missing === 1 ? "" : "s"} no longer exist${missing === 1 ? "s" : ""} in the org`);
	if (other > 0) parts.push(`${other} failed`);
	if (parts.length === 0) return { text: `Updated ${retrieved} components from ${orgLabel}.`, hasRealFailures: false };
	return { text: `Updated ${retrieved} components from ${orgLabel}; ${parts.join("; ")}.`, hasRealFailures: other > 0 || missing > 0 };
}
