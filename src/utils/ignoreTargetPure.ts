/**
 * Pure path resolution for "Add to .gitignore / .forceignore" (no `vscode`; file-system
 * access is injected so it is unit testable).
 *   .forceignore -> the file's project root (nearest sfdx-project.json), else the workspace folder
 *   .gitignore   -> the git repository root containing the file (walk up to `.git`), else the workspace folder
 * Entries are relative to the directory holding the ignore file, with forward slashes.
 */
import * as nodePath from "path";

export interface IgnoreEnv {
	exists(p: string): boolean;
	isDirectory(p: string): boolean;
	pathApi?: typeof nodePath.posix;
}

/** Nearest ancestor (including the file's own folder) containing `marker`, or undefined. */
export function findUpward(file: string, marker: string, env: IgnoreEnv): string | undefined {
	const api = env.pathApi ?? nodePath;
	let dir = api.dirname(file);
	for (let i = 0; i < 100; i++) {
		if (env.exists(api.join(dir, marker))) return dir;
		const parent = api.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** Directory that holds the `.gitignore` for `file`. */
export function gitignoreRoot(file: string, workspaceFolder: string | undefined, env: IgnoreEnv): string | undefined {
	return findUpward(file, ".git", env) ?? workspaceFolder;
}

/** Directory that holds the `.forceignore` for `file`. */
export function forceignoreRoot(file: string, projectDir: string | undefined, workspaceFolder: string | undefined): string | undefined {
	return projectDir ?? workspaceFolder;
}

/** Entry for `file` relative to `root` (forward slashes; trailing `/` for folders). */
export function ignoreEntry(file: string, root: string, env: IgnoreEnv): string {
	const api = env.pathApi ?? nodePath;
	let rel = api.relative(root, file).replace(/\\/g, "/");
	if (env.isDirectory(file) && !rel.endsWith("/")) rel += "/";
	return rel;
}
