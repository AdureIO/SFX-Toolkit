/**
 * Pure (no vscode) rules of the per-project Apex snippets: where they live, how the pre-multi-project
 * location is migrated, the project filter, and where a new snippet goes.
 */
import * as path from "path";
import { isSameOrInside, samePath } from "./projectDiscoveryPure";

/** Folder (relative to a project dir) that holds one `.apex` file per snippet. */
export const SNIPPETS_REL_DIR = path.join(".vscode", "apex-snippets");

/** Snippets folder of a project: `<projectDir>/.vscode/apex-snippets`. */
export function snippetsDirOf(projectDir: string): string {
	return path.join(projectDir, SNIPPETS_REL_DIR);
}

/**
 * The project the pre-multi-project snippets of `workspaceFolder` (`<folder>/.vscode/apex-snippets`)
 * belong to: the project whose dir IS the workspace folder, else the first project inside it.
 * `projectDirs` are in discovery order (workspace-folder order, then path).
 */
export function legacyOwnerDir(workspaceFolder: string, projectDirs: readonly string[]): string | undefined {
	const exact = projectDirs.find((d) => samePath(d, workspaceFolder));
	if (exact) return exact;
	return projectDirs.find((d) => isSameOrInside(d, workspaceFolder));
}

export interface LegacyMigrationInput {
	/** The workspace folder holding the old `.vscode/apex-snippets`. */
	workspaceFolder: string;
	projectDirs: readonly string[];
	/** The project being loaded. */
	projectDir: string;
	/** `<workspaceFolder>/.vscode/apex-snippets` exists. */
	legacyDirExists: boolean;
	/** `<projectDir>/.vscode/apex-snippets` exists. */
	projectDirHasSnippetsDir: boolean;
}

/**
 * Directory to copy the old workspace-folder snippets from into `projectDir`'s own folder, or undefined.
 * Only the owning project gets them, only when it has no snippets folder of its own yet, and never when
 * the project IS the workspace folder (the location is the same). The old files are left in place.
 */
export function legacyMigrationSource(input: LegacyMigrationInput): string | undefined {
	const { workspaceFolder, projectDirs, projectDir, legacyDirExists, projectDirHasSnippetsDir } = input;
	if (!legacyDirExists || projectDirHasSnippetsDir) return undefined;
	if (samePath(projectDir, workspaceFolder)) return undefined;
	const owner = legacyOwnerDir(workspaceFolder, projectDirs);
	if (!owner || !samePath(owner, projectDir)) return undefined;
	return snippetsDirOf(workspaceFolder);
}

/** "all" or the dir of one project. */
export type SnippetFilter = "all" | string;

export const ALL_PROJECTS: SnippetFilter = "all";

/** The stored filter, or "all" when it is unset or names a project that no longer exists. */
export function effectiveFilter(stored: string | undefined, projectDirs: readonly string[]): SnippetFilter {
	if (!stored || stored === ALL_PROJECTS) return ALL_PROJECTS;
	const hit = projectDirs.find((d) => samePath(d, stored));
	return hit ?? ALL_PROJECTS;
}

export function filterSnippets<T extends { projectDir?: string }>(snippets: readonly T[], filter: SnippetFilter): T[] {
	if (filter === ALL_PROJECTS) return [...snippets];
	return snippets.filter((s) => samePath(s.projectDir, filter));
}

/** The project name badge is shown only when there is more than one project. */
export function showProjectBadge(projectCount: number): boolean {
	return projectCount > 1;
}

export type AddTarget = { kind: "dir"; dir: string } | { kind: "ask" } | { kind: "none" };

/**
 * Where a new snippet goes: the project the view is filtered to; with the filter on "all", the only
 * project, or - with several - the user is asked (the active project is offered first).
 */
export function addSnippetTarget(filter: SnippetFilter, projectDirs: readonly string[]): AddTarget {
	if (projectDirs.length === 0) return { kind: "none" };
	if (filter !== ALL_PROJECTS) {
		const hit = projectDirs.find((d) => samePath(d, filter));
		if (hit) return { kind: "dir", dir: hit };
	}
	if (projectDirs.length === 1) return { kind: "dir", dir: projectDirs[0] };
	return { kind: "ask" };
}

/** `dirs` reordered so `activeDir` is first (stable otherwise). */
export function activeFirst(dirs: readonly string[], activeDir: string | undefined): string[] {
	const out = [...dirs];
	const i = out.findIndex((d) => samePath(d, activeDir));
	if (i > 0) out.unshift(...out.splice(i, 1));
	return out;
}
