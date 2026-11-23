/**
 * Pure (no vscode) Salesforce project discovery and active-project selection.
 * The file system is injected so the rules can be unit tested.
 */
import * as path from "path";

export interface SfProject {
	/** Absolute fs path. */
	dir: string;
	kind: "sfdx" | "mdapi";
	/** Folder path relative to its workspace folder ("/" separated), or the folder name at a root. */
	name: string;
	/** Absolute path of the containing workspace folder. */
	workspaceFolder: string;
}

export interface DiscoveryFs {
	/** Names of the direct child DIRECTORIES of `dir` (empty when unreadable). */
	readdir(dir: string): string[];
	exists(p: string): boolean;
	/** MDAPI project test (src/package.xml with the Metadata namespace, no sfdx-project.json above). */
	isMdapiFolder(dir: string): boolean;
}

/** Projects are looked for at a workspace-folder root and this many levels below it. */
export const MAX_DISCOVERY_DEPTH = 2;

const SKIP_NAMES = new Set(["node_modules", "out", "dist", "build", "target", "vendor", "bin", "obj", "coverage", "tmp"]);

export function isSkippedFolderName(name: string): boolean {
	return name.startsWith(".") || SKIP_NAMES.has(name);
}

function isWin(): boolean {
	return process.platform === "win32";
}

function norm(p: string): string {
	const r = path.resolve(p).replace(/[\\/]+$/, "");
	return isWin() ? r.toLowerCase() : r;
}

/** True when `file` is `dir` or inside it. */
export function isSameOrInside(file: string, dir: string): boolean {
	const rel = path.relative(norm(dir), norm(file));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function samePath(a: string | undefined, b: string | undefined): boolean {
	return !!a && !!b && norm(a) === norm(b);
}

function nameOf(folder: string, dir: string): string {
	const rel = path.relative(folder, dir).split(path.sep).join("/");
	return rel || path.basename(folder) || folder;
}

/**
 * Discover SFDX and MDAPI projects in each workspace folder: the root and up to
 * MAX_DISCOVERY_DEPTH levels below it. Nothing is looked for inside a found project.
 * Sorted by workspace-folder order, then path.
 */
export function discoverProjects(workspaceFolders: string[], fsx: DiscoveryFs, maxDepth: number = MAX_DISCOVERY_DEPTH): SfProject[] {
	const seen = new Set<string>();
	const out: SfProject[] = [];

	for (const folder of workspaceFolders) {
		const found: SfProject[] = [];
		const walk = (dir: string, depth: number): void => {
			let kind: SfProject["kind"] | undefined;
			if (fsx.exists(path.join(dir, "sfdx-project.json"))) kind = "sfdx";
			else if (fsx.isMdapiFolder(dir)) kind = "mdapi";
			if (kind) {
				found.push({ dir, kind, name: nameOf(folder, dir), workspaceFolder: folder });
				return;
			}
			if (depth >= maxDepth) return;
			let children: string[];
			try {
				children = fsx.readdir(dir);
			} catch {
				return;
			}
			for (const child of [...children].sort()) {
				if (isSkippedFolderName(child)) continue;
				walk(path.join(dir, child), depth + 1);
			}
		};
		walk(folder, 0);
		found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
		for (const p of found) {
			const k = norm(p.dir);
			if (seen.has(k)) continue; // overlapping workspace folders
			seen.add(k);
			out.push(p);
		}
	}
	return out;
}

/** The deepest discovered project containing `file`. */
export function projectOfFileIn(projects: readonly SfProject[], file: string): SfProject | undefined {
	let best: SfProject | undefined;
	for (const p of projects) {
		if (isSameOrInside(file, p.dir) && (!best || p.dir.length > best.dir.length)) best = p;
	}
	return best;
}

/**
 * The active project: the one containing the active editor's file; otherwise the last active
 * project (persisted); otherwise the first discovered one.
 */
export function selectActiveProjectIn(
	projects: readonly SfProject[],
	activeFile: string | undefined,
	lastActiveDir: string | undefined
): SfProject | undefined {
	if (activeFile) {
		const hit = projectOfFileIn(projects, activeFile);
		if (hit) return hit;
	}
	if (lastActiveDir) {
		const hit = projects.find((p) => samePath(p.dir, lastActiveDir));
		if (hit) return hit;
	}
	return projects[0];
}

/** Do two project lists describe the same set (dir + kind, in order)? */
export function sameProjects(a: readonly SfProject[], b: readonly SfProject[]): boolean {
	return a.length === b.length && a.every((p, i) => p.dir === b[i].dir && p.kind === b[i].kind && p.name === b[i].name);
}

/**
 * Could a create/delete of this file change discovery? `relSegments` is the file's path
 * relative to its workspace folder, split into segments. `sfdx-project.json` must sit at
 * depth <= maxDepth, `package.xml` directly inside a `src` folder at depth <= maxDepth.
 */
export function isProjectMarkerPath(relSegments: readonly string[], maxDepth: number = MAX_DISCOVERY_DEPTH): boolean {
	const n = relSegments.length;
	if (n === 0) return false;
	if (relSegments.slice(0, -1).some((s) => isSkippedFolderName(s))) return false;
	const file = relSegments[n - 1];
	if (file === "sfdx-project.json") return n - 1 <= maxDepth;
	if (file === "package.xml") return n >= 2 && relSegments[n - 2] === "src" && n - 2 <= maxDepth;
	return false;
}
