/**
 * Pure helpers of the content diff (local files against the org's copy): normalizing and hashing file
 * contents, grouping retrieved files by component, comparing the file sets of a component and the compare
 * index (what was compared when, and when a component has to be compared again). No `vscode`.
 */
import * as crypto from "crypto";
import * as path from "path";
import { ContentResult } from "./compareStatusPure";
import { LocalEntry, TypeTable, mapSourceFile, typeFolderInnerPath } from "./orgBrowser/localIndex";
import { orgLookupKey } from "./deployStatusPure";

/** Types whose single-component retrieve is not the full local file (a Profile comes back reduced to what was retrieved with it): never compared. */
export const NOT_COMPARABLE_TYPES: ReadonlySet<string> = new Set(["Profile"]);

/** CRLF → LF, trailing whitespace per line stripped, trailing newlines trimmed. */
export function normalizeText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/[ \t\f\v]+$/gm, "").replace(/\n+$/, "");
}

/** Binary content (a NUL byte in the first 8 KB) is compared byte for byte. */
export function isBinary(buf: Buffer): boolean {
	const n = Math.min(buf.length, 8192);
	for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
	return false;
}

const sha1 = (data: string | Buffer): string => crypto.createHash("sha1").update(data).digest("hex");

/** Digest of one file's content after normalization. */
export function digestContent(buf: Buffer): string {
	return isBinary(buf) ? "b:" + sha1(buf) : "t:" + sha1(normalizeText(buf.toString("utf8")));
}

/** One hash over all files of a component (`inner path → digest`), independent of the order. */
export function hashDigests(files: ReadonlyMap<string, string>): string {
	const h = crypto.createHash("sha1");
	for (const k of [...files.keys()].sort()) h.update(k).update("\0").update(files.get(k) ?? "").update("\n");
	return h.digest("hex");
}

/**
 * Compare the files of one component. A file on one side only means different: on the org side too, because
 * the org files handed in are the component's OWN files (other components' files, e.g. the other fields of a
 * decomposed object, were dropped by `groupByComponent`).
 */
export function compareDigests(local: ReadonlyMap<string, string>, org: ReadonlyMap<string, string>): ContentResult {
	if (local.size !== org.size) return "different";
	for (const [k, d] of local) if (org.get(k) !== d) return "different";
	return "same";
}

/** Org-listing style key (`Type:Name` with the name percent-decoded): what retrieved and local files are matched on. */
export function lookupKeyOf(type: string, name: string): string {
	return orgLookupKey(type, name);
}

/** The file name part of the key sent to `sf` (`Layout:Account-Account Layout` → `Account-Account Layout`). */
export function requestNameOf(type: string, name: string): string {
	return orgLookupKey(type, name).slice(type.length + 1);
}

/**
 * Map files (paths relative to a package dir / retrieve output dir, forward slashes) to their components:
 * lookup key → (inner path in the type folder → the item). A file that belongs to no component is dropped.
 */
export function groupByComponent<T extends { rel: string }>(files: readonly T[], table: TypeTable): Map<string, Map<string, T>> {
	const out = new Map<string, Map<string, T>>();
	for (const f of files) {
		const m = mapSourceFile(f.rel, table);
		if (!m) continue;
		const inner = typeFolderInnerPath(f.rel, table);
		if (inner === null) continue;
		const key = lookupKeyOf(m.type, m.name);
		let g = out.get(key);
		if (!g) out.set(key, (g = new Map()));
		g.set(inner, f);
	}
	return out;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** A component's local files as `inner path` + absolute path (`pkgDirs` absolute). Files outside every package dir are skipped. */
export function innerFilesOfEntry(entry: LocalEntry, pkgDirs: readonly string[], table: TypeTable): { inner: string; abs: string }[] {
	const out: { inner: string; abs: string }[] = [];
	for (const abs of entry.files) {
		const pkg = pkgDirs.find((d) => abs === d || abs.startsWith(d + path.sep));
		if (!pkg) continue;
		const inner = typeFolderInnerPath(toPosix(path.relative(pkg, abs)), table);
		if (inner !== null) out.push({ inner, abs });
	}
	return out;
}

// ── Index ──────────────────────────────────────────────────────────────────────

export interface IndexEntry {
	/** The org's lastModifiedDate when compared. */
	orgLm: number;
	/** Hash of the normalized local files when compared. */
	localHash: string;
	result: ContentResult;
	/** When the compare ran (epoch ms). */
	comparedAt: number;
	/** The last time the result was "same" (epoch ms): the baseline of a later "different". */
	sameAt?: number;
}

export interface CompareIndexFile {
	v: 1;
	entries: Record<string, IndexEntry>;
}

/** A component needs a (re)compare when it never was, or its org time or local hash changed since. */
export function needsCompare(entry: IndexEntry | undefined, orgLm: number, localHash: string): boolean {
	return !entry || entry.orgLm !== orgLm || entry.localHash !== localHash;
}

/** The last time both sides were verified equal (`comparedAt` of a "same", else the `sameAt` kept from before). */
export function verifiedSyncAt(entry: IndexEntry | undefined): number | undefined {
	if (!entry) return undefined;
	return entry.result === "same" ? entry.comparedAt : entry.sameAt;
}

/** The index entry after a new compare: carries the last "same" time over a "different". */
export function nextEntry(prev: IndexEntry | undefined, orgLm: number, localHash: string, result: ContentResult, at: number): IndexEntry {
	const carried = verifiedSyncAt(prev);
	return { orgLm, localHash, result, comparedAt: at, sameAt: result === "same" ? at : carried };
}

/** Wire form for the webviews: `[1 same | 2 different, comparedAt, verified-sync time (0 = never)]`. */
export function toWire(entry: IndexEntry): [number, number, number] {
	return [entry.result === "same" ? 1 : 2, entry.comparedAt, verifiedSyncAt(entry) ?? 0];
}

/** Split into groups of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
