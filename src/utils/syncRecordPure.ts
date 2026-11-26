/**
 * The sync record of a component: what the org's lastModifiedDate and the local contents were right after the
 * toolkit last deployed it to / retrieved it from an org. Layer 1 of the layered content compare: when both are
 * still the same, nothing changed on either side since, so the component is equal without any org call.
 * Pure (no `vscode`, no fs).
 */
import { hashDigests } from "./contentComparePure";

/** An org time this much (ms) later than the operation's completion cannot belong to it (another change): the record is dropped. */
export const SYNC_SKEW_MS = 5_000;

export type SyncKind = "deploy" | "retrieve";

export interface SyncEntry {
	/** When the operation completed (epoch ms, local clock). */
	at: number;
	/** Hash of the component's normalized local files right after the operation (`hashDigests`). */
	hash: string;
	/** Hash over its `-meta.xml` files only (undefined = the component has none). The Tooling layer vouches for the meta files with it. */
	meta?: string;
	/** The org's lastModifiedDate after the operation (epoch ms); undefined = pending (filled at the next listing). */
	lm?: number;
	kind: SyncKind;
}

export const isMetaInner = (inner: string): boolean => inner.endsWith("-meta.xml");

/** Split a component's `inner path → digest` map into its body files and its `-meta.xml` files. */
export function splitMetaDigests(files: ReadonlyMap<string, string>): { body: Map<string, string>; meta: Map<string, string> } {
	const body = new Map<string, string>();
	const meta = new Map<string, string>();
	for (const [k, d] of files) (isMetaInner(k) ? meta : body).set(k, d);
	return { body, meta };
}

/** Hash over the `-meta.xml` files of a component; undefined when it has none. */
export function metaHashOf(files: ReadonlyMap<string, string>): string | undefined {
	const { meta } = splitMetaDigests(files);
	return meta.size > 0 ? hashDigests(meta) : undefined;
}

/**
 * Layer 1: `same` when the org's lastModifiedDate and the local contents are exactly what they were after the
 * last operation. Anything else (no record, pending, one side changed) is undecided: the date-based status
 * already tells which side changed, the content layers tell whether the contents differ.
 */
export function decideSync(entry: SyncEntry | undefined, orgLm: number, localHash: string): "same" | undefined {
	if (!entry || entry.lm === undefined) return undefined;
	return entry.lm === orgLm && entry.hash === localHash ? "same" : undefined;
}

/**
 * Fill a pending record from a listing. Kept pending when the component was not listed; dropped (null) when
 * the listed time is later than the operation's completion (somebody changed the org after our operation: the
 * recorded local contents are not what that time belongs to). An already-filled record is returned unchanged.
 */
export function resolvePending(entry: SyncEntry, listedLm: number | undefined): SyncEntry | null {
	if (entry.lm !== undefined) return entry;
	if (listedLm === undefined) return entry;
	if (listedLm > entry.at + SYNC_SKEW_MS) return null;
	return { ...entry, lm: listedLm };
}
