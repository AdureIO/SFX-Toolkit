/**
 * Pure helpers (no `vscode`, no I/O) for the retrieve overwrite-safety check: parsing
 * `git status --porcelain` output and matching dirty files against retrieve targets.
 */
import * as path from "path";

const IS_WINDOWS = process.platform === "win32";

/** Resolve C-style escapes inside a quoted porcelain path (`"a b\t\303\244"`). */
function unquoteGitPath(raw: string): string {
	if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
	const inner = raw.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (ch !== "\\") {
			for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
			continue;
		}
		const next = inner[++i];
		if (next === undefined) break;
		if (/[0-7]/.test(next)) {
			let oct = next;
			while (oct.length < 3 && /[0-7]/.test(inner[i + 1] ?? "")) oct += inner[++i];
			bytes.push(parseInt(oct, 8) & 0xff);
			continue;
		}
		const map: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
		bytes.push(map[next] ?? next.charCodeAt(0));
	}
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Paths (relative to the repo root, forward slashes) of every entry in
 * `git status --porcelain` output: modified, added, deleted, untracked, renamed (both
 * sides) and conflicted. Blank lines and the optional `## branch` header are ignored.
 */
export function parsePorcelain(output: string): string[] {
	const out: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (line.length < 4 || line.startsWith("##")) continue;
		const status = line.slice(0, 2);
		const rest = line.slice(3);
		const arrow = rest.indexOf(" -> ");
		if (arrow >= 0 && /[RC]/.test(status)) {
			out.push(unquoteGitPath(rest.slice(0, arrow)), unquoteGitPath(rest.slice(arrow + 4)));
		} else {
			out.push(unquoteGitPath(rest));
		}
	}
	return out;
}

/** Normalise for comparison: forward slashes, no trailing slash, case-folded on Windows. */
export function normalizeForMatch(p: string): string {
	let n = path.normalize(p).replace(/\\/g, "/");
	while (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
	return IS_WINDOWS ? n.toLowerCase() : n;
}

/** True when `child` is `parent` itself or lives under it (`parent` may be a file or a folder). */
export function isSameOrUnder(parent: string, child: string): boolean {
	const p = normalizeForMatch(parent);
	const c = normalizeForMatch(child);
	return c === p || c.startsWith(p + "/");
}

/**
 * The `dirty` files that a retrieve of `targets` (files and/or folders) would overwrite.
 * Order follows `dirty`; duplicates are removed.
 */
export function affectedFiles(targets: string[], dirty: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const d of dirty) {
		const key = normalizeForMatch(d);
		if (seen.has(key)) continue;
		if (targets.some((t) => isSameOrUnder(t, d))) {
			seen.add(key);
			result.push(d);
		}
	}
	return result;
}

const BUNDLE_DIRS = new Set(["lwc", "aura", "experiences", "waveTemplates", "lightningTypes"]);

/**
 * Group files by the metadata component they belong to, so `Foo.cls` and `Foo.cls-meta.xml` count
 * once. Bundles (lwc, aura …) group by their folder; object children (`objects/Account/fields/X.field-meta.xml`)
 * are named `Account.X`; everything else by the file name without `-meta.xml` and extension.
 * Order of first appearance; `files` is the number of input files in the group.
 */
export function groupByComponent(files: string[]): { name: string; files: number }[] {
	const groups = new Map<string, { name: string; files: number }>();
	for (const f of files) {
		const seg = f.split(/[\\/]/).filter(Boolean);
		let key: string;
		let name: string;
		const b = seg.findIndex((s, i) => BUNDLE_DIRS.has(s) && i < seg.length - 2);
		const o = seg.lastIndexOf("objects");
		const stem = (n: string) => n.replace(/-meta\.xml$/, "").replace(/\.[^.]+$/, "");
		if (b >= 0) {
			key = seg.slice(0, b + 2).join("/");
			name = seg[b + 1];
		} else if (o >= 0 && o < seg.length - 2) {
			const obj = seg[o + 1];
			const base = stem(seg[seg.length - 1]);
			const isObjectFile = seg.length === o + 3;
			key = isObjectFile ? seg.slice(0, o + 2).join("/") : [...seg.slice(0, -1), base].join("/");
			name = isObjectFile ? obj : `${obj}.${base}`;
		} else {
			const base = stem(seg[seg.length - 1] ?? f);
			key = [...seg.slice(0, -1), base].join("/");
			name = base;
		}
		const g = groups.get(key);
		if (g) g.files++;
		else groups.set(key, { name, files: 1 });
	}
	return [...groups.values()];
}

/** The confirmation text: file and component counts, first five component names, `…` when more. */
export function overwriteMessage(what: string, files: string[]): string {
	const comps = groupByComponent(files);
	const names = comps.slice(0, 5).map((c) => c.name);
	const fl = `${files.length} file${files.length === 1 ? "" : "s"}`;
	const cl = `${comps.length} component${comps.length === 1 ? "" : "s"}`;
	return `${what} will overwrite ${fl} in ${cl} with local changes: ${names.join(", ")}${comps.length > 5 ? "…" : ""}`;
}
