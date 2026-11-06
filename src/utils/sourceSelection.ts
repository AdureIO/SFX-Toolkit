/**
 * Pure selection handling for the right-click "Deploy to / Retrieve from Default Org" commands
 * (no `vscode`, no I/O: file-system access is injected so it is unit testable).
 *
 * A selection (files and/or folders, possibly spanning nested SFDX projects) is normalised,
 * deduplicated, restricted to package directories and grouped per project, so each project
 * is deployed / retrieved in ONE CLI call.
 */
import * as nodePath from "path";

export interface SelectionEnv {
	/** Nearest directory containing sfdx-project.json for a path, or null. */
	findProjectDir(p: string): string | null;
	/** Package directories of a project, as absolute paths. */
	packageDirs(projectDir: string): string[];
	/** True when the path exists on disk (used to map `X-meta.xml` onto its content file). */
	exists(p: string): boolean;
	/** Path flavour; defaults to the host's. Tests pass `path.win32` to exercise Windows paths. */
	pathApi?: typeof nodePath.posix;
}

export interface SelectionGroup {
	projectDir: string;
	/** Absolute paths to pass as `-d`. */
	paths: string[];
}

export interface SelectionPlan {
	groups: SelectionGroup[];
	/** Inputs dropped because they are outside every package directory (or in no project). */
	skipped: string[];
}

const BUNDLE_DIRS = new Set(["lwc", "aura"]);
const META_SUFFIX = "-meta.xml";

function key(api: typeof nodePath.posix, p: string): string {
	return api.sep === "\\" ? p.toLowerCase() : p;
}

function stripTrailingSep(api: typeof nodePath.posix, p: string): string {
	let out = p;
	while (out.length > 1 && (out.endsWith(api.sep) || out.endsWith("/")) && api.parse(out).root !== out) out = out.slice(0, -1);
	return out;
}

function isUnder(api: typeof nodePath.posix, child: string, parent: string): boolean {
	const c = key(api, child);
	const p = key(api, parent);
	return c === p || c.startsWith(p.endsWith(api.sep) ? p : p + api.sep);
}

/**
 * Selecting a file inside an LWC / Aura bundle deploys the whole bundle folder (a bundle is
 * only deployable as a unit). `.../lwc/<bundle>/**` (deeper than the bundle) -> `.../lwc/<bundle>`.
 */
export function mapBundleMember(api: typeof nodePath.posix, p: string): string {
	const parts = p.split(api.sep);
	for (let i = 1; i < parts.length - 2; i++) {
		if (BUNDLE_DIRS.has(parts[i]) && parts[i + 1]) return parts.slice(0, i + 2).join(api.sep);
	}
	return p;
}

/** Normalise, map, dedupe, drop nested/outside paths, group per project. */
export function planSelection(inputs: string[], env: SelectionEnv): SelectionPlan {
	const api = env.pathApi ?? nodePath;
	const skipped: string[] = [];
	const byProject = new Map<string, { projectDir: string; seen: Map<string, string> }>();
	const packageDirCache = new Map<string, string[]>();

	for (const raw of inputs) {
		if (!raw) continue;
		let p = stripTrailingSep(api, api.normalize(raw));
		const projectDir = env.findProjectDir(p);
		if (!projectDir) {
			skipped.push(raw);
			continue;
		}
		let dirs = packageDirCache.get(projectDir);
		if (!dirs) {
			dirs = env.packageDirs(projectDir).map((d) => stripTrailingSep(api, api.normalize(d)));
			packageDirCache.set(projectDir, dirs);
		}
		if (!dirs.some((d) => isUnder(api, p, d))) {
			skipped.push(raw);
			continue;
		}
		// `foo.cls-meta.xml` -> `foo.cls` when the content file exists (the CLI resolves the pair either way).
		if (p.endsWith(META_SUFFIX)) {
			const content = p.slice(0, -META_SUFFIX.length);
			if (content && env.exists(content)) p = content;
		}
		p = mapBundleMember(api, p);
		let group = byProject.get(key(api, projectDir));
		if (!group) {
			group = { projectDir, seen: new Map() };
			byProject.set(key(api, projectDir), group);
		}
		group.seen.set(key(api, p), p);
	}

	const groups: SelectionGroup[] = [];
	for (const g of byProject.values()) {
		const all = [...g.seen.values()];
		// Drop anything nested inside another selected path (a selected folder covers it).
		const kept = all.filter((p) => !all.some((q) => q !== p && isUnder(api, p, q)));
		kept.sort();
		if (kept.length) groups.push({ projectDir: g.projectDir, paths: kept });
	}
	groups.sort((a, b) => a.projectDir.localeCompare(b.projectDir));
	return { groups, skipped };
}

/**
 * Argument vector for ONE `sf project deploy start` covering every path (multiple `-d`).
 * `json` appends `--json`; leave it off when a caller (runJsonDeploy) adds it itself.
 */
export function buildDeployStartArgs(paths: string[], org: string | null, opts: { json?: boolean } = {}): string[] {
	const args = ["project", "deploy", "start"];
	for (const p of paths) args.push("-d", p);
	if (org) args.push("--target-org", org);
	if (opts.json) args.push("--json");
	return args;
}
