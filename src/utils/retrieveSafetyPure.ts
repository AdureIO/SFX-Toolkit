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

/** The confirmation text: first five base names, `…` when more. */
export function overwriteMessage(what: string, files: string[]): string {
	const names = files.slice(0, 5).map((f) => path.basename(f));
	return `${what} will overwrite ${files.length} file(s) with local changes: ${names.join(", ")}${files.length > 5 ? "…" : ""}`;
}
