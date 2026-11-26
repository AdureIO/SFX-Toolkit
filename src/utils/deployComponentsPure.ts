/**
 * Deploy & Retrieve Metadata: components ↔ files. Pure (no `vscode`, no DOM, no `fs`).
 *
 * The selection is a set of component keys (`Type:fullName`) — LEAVES only. A ticked component deploys
 * exactly its own source files (`-d <file>`), never its folder, whatever else sits next to it and
 * whatever the filter hides: the earlier "deploying with a filter pushes the whole directory" bug cannot
 * come back because no folder path ever enters the deploy arguments.
 */

/** A local component with its files (the Org Browser's `LocalEntry`, narrowed to what is needed here). */
export interface ComponentFiles {
	/** `Type:fullName` */
	key: string;
	/** Absolute file paths. */
	files: string[];
}

/** A component with project-relative, forward-slash file paths (for matching paths to components). */
export interface RelComponent {
	key: string;
	files: string[];
}

const norm = (p: string): string =>
	p
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.split("/")
		.filter(Boolean)
		.join("/");

/** Absolute files to deploy for the selected component keys, de-duplicated and sorted; keys unknown to the index are returned in `missing`. */
export function deployPathsForComponents(
	keys: Iterable<string>,
	entries: ReadonlyMap<string, { files: string[] }>
): { paths: string[]; missing: string[] } {
	const paths = new Set<string>();
	const missing: string[] = [];
	const seen = new Set<string>();
	for (const k of keys) {
		if (seen.has(k)) continue;
		seen.add(k);
		const e = entries.get(k);
		if (!e || e.files.length === 0) {
			missing.push(k);
			continue;
		}
		for (const f of e.files) paths.add(f);
	}
	return { paths: [...paths].sort(), missing };
}

/**
 * The components a list of project-relative paths (files or folders) belongs to: a path matches a
 * component when it IS one of its files, or is a folder containing at least one. Paths that match
 * nothing are returned in `unmatched`. Order = first match.
 */
export function pathsToComponents(paths: Iterable<string>, comps: readonly RelComponent[]): { keys: string[]; unmatched: string[] } {
	const byFile = new Map<string, string[]>();
	for (const c of comps) {
		for (const f of c.files) {
			const n = norm(f);
			const list = byFile.get(n);
			if (list) list.push(c.key);
			else byFile.set(n, [c.key]);
		}
	}
	const keys = new Set<string>();
	const unmatched: string[] = [];
	let folderIndex: [string, string[]][] | undefined;
	for (const raw of paths) {
		const p = norm(raw);
		if (!p) continue;
		const exact = byFile.get(p);
		if (exact) {
			for (const k of exact) keys.add(k);
			continue;
		}
		folderIndex ??= [...byFile.entries()];
		const prefix = p + "/";
		let hit = false;
		for (const [f, ks] of folderIndex) {
			if (f.startsWith(prefix)) {
				hit = true;
				for (const k of ks) keys.add(k);
			}
		}
		if (!hit) unmatched.push(raw);
	}
	return { keys: [...keys], unmatched };
}

/** The slice of a stored preset needed to migrate it. */
export interface PresetLike {
	/** New: component keys. */
	components?: string[];
	/** Old: files and folders, relative to the project. */
	sourcePaths?: string[];
}

/**
 * Component keys of a preset. A preset that stores `components` is used as is; an old one that stored
 * paths is mapped to components through the local index (paths that match nothing are counted in
 * `unmatched`; an empty list selects nothing).
 */
export function presetComponents(p: PresetLike, comps: readonly RelComponent[]): { keys: string[]; unmatched: string[]; migrated: boolean } {
	if (Array.isArray(p.components)) {
		return { keys: [...new Set(p.components.filter((k) => typeof k === "string" && k.includes(":")))], unmatched: [], migrated: false };
	}
	const paths = Array.isArray(p.sourcePaths) ? p.sourcePaths.filter((x) => typeof x === "string") : [];
	const r = pathsToComponents(paths, comps);
	return { keys: r.keys, unmatched: r.unmatched, migrated: true };
}

/** Project-relative, forward-slash files of the given components (the legacy `sourcePaths` written next to `components`). */
export function relativeFilesOf(keys: Iterable<string>, entries: ReadonlyMap<string, { files: string[] }>, projectDir: string): string[] {
	const root = projectDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
	const out = new Set<string>();
	for (const k of keys) {
		for (const f of entries.get(k)?.files ?? []) {
			const n = f.replace(/\\/g, "/");
			out.add(n.startsWith(root) ? n.slice(root.length) : n);
		}
	}
	return [...out].sort();
}

/** Metadata type of a `Type:fullName` key. */
export function typeOfComponentKey(key: string): string {
	const c = key.indexOf(":");
	return c < 0 ? key : key.slice(0, c);
}

/** fullName of a `Type:fullName` key. */
export function nameOfComponentKey(key: string): string {
	const c = key.indexOf(":");
	return c < 0 ? "" : key.slice(c + 1);
}

/** Types whose components live in folders (`Folder/Name`). */
export const FOLDER_CONTENT_TYPES: readonly string[] = ["Report", "Dashboard", "Document", "EmailTemplate"];

/**
 * For a live check of just these components: the folders to list per folder type, so the org is asked
 * for those folders only instead of every folder it has. A folder type is left out (= list it whole)
 * when one of its selected components has no folder in its name.
 */
export function folderRestriction(keys: Iterable<string>): Record<string, string[]> {
	const byType = new Map<string, { folders: Set<string>; whole: boolean }>();
	for (const k of keys) {
		const type = typeOfComponentKey(k);
		if (!FOLDER_CONTENT_TYPES.includes(type)) continue;
		const name = nameOfComponentKey(k);
		const slash = name.lastIndexOf("/");
		const e = byType.get(type) ?? { folders: new Set<string>(), whole: false };
		if (slash <= 0) e.whole = true;
		else e.folders.add(name.slice(0, slash));
		byType.set(type, e);
	}
	const out: Record<string, string[]> = {};
	for (const [type, e] of byType) if (!e.whole && e.folders.size > 0) out[type] = [...e.folders].sort();
	return out;
}
