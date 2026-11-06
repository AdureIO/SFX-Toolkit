/**
 * Proactive schema-health checks (no UI): "no default org" is detected on activation and
 * on every default-org change — for the primary AND nested sfdx projects — instead of
 * waiting for a completion to fail; an expired scratch org is read from the org list.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { runCommandArgs } from "./commandRunner";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { canonicalOrgKey } from "./orgKey";
import { getOrgByTarget } from "./orgListCache";
import { findSfdxProjectDir, primaryProjectRoot } from "./projectUtils";
import { applyNoDefaultOrgResult, findProjectsWithoutDefaultOrg, reportSchemaFailure } from "./schemaHealth";

/** Nested projects seen so far (opened files, config events, discovery at activation). */
const extraProjects = new Set<string>();

/** Remember the sfdx project owning a file (so its default org is checked and shown). */
export function noteProjectOfFile(fsPath: string): string | null {
	const dir = findSfdxProjectDir(fsPath);
	if (dir) extraProjects.add(dir);
	return dir;
}

export function noteProjectDir(dir: string): void {
	extraProjects.add(dir);
}

export function forgetProjectsForTests(): void {
	extraProjects.clear();
}

/** Every sfdx project we know of: workspace folders with an sfdx-project.json plus nested ones seen. */
export function knownProjectDirs(): string[] {
	const dirs = new Set<string>();
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		if (fs.existsSync(path.join(f.uri.fsPath, "sfdx-project.json"))) dirs.add(f.uri.fsPath);
	}
	const primary = primaryProjectRoot();
	if (primary && fs.existsSync(path.join(primary, "sfdx-project.json"))) dirs.add(primary);
	for (const d of extraProjects) if (fs.existsSync(path.join(d, "sfdx-project.json"))) dirs.add(d);
	return [...dirs];
}

async function cliDefaultOrg(dir: string): Promise<string | null> {
	try {
		const out = await runCommandArgs("sf", ["config", "get", "target-org", "--json"], dir, undefined, false, 20_000);
		const parsed = JSON.parse(out);
		const value = parsed?.result?.[0]?.value ?? parsed?.result?.value;
		return typeof value === "string" && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Detect projects without a default org and publish the result to the health state.
 * Returns the project dirs lacking a default org.
 */
export async function checkNoDefaultOrg(dirs: string[] = knownProjectDirs()): Promise<string[]> {
	const missing = await findProjectsWithoutDefaultOrg(dirs, {
		resolveSync: (dir) => resolveDefaultTargetOrgUsernameSync(dir),
		resolveCli: cliDefaultOrg,
	});
	applyNoDefaultOrgResult(missing);
	return missing;
}

/** A default scratch org that `sf org list` reports as expired / deleted is an invalid connection. */
export function checkExpiredScratch(dirs: string[] = knownProjectDirs()): void {
	for (const dir of dirs) {
		const key = canonicalOrgKey(null, dir);
		const rec = getOrgByTarget(key);
		if (rec?.isScratch && rec.isExpired) {
			reportSchemaFailure(key, "authInvalid", new Error("ScratchOrgDeletedError: scratch org has expired"));
		}
	}
}
