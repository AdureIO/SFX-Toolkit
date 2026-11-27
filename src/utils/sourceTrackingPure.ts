/**
 * Layer 3 of the layered content compare, pure part: the org's source tracking (`SourceMember`) against the
 * project's own `sf` tracking file. No `vscode`, no I/O.
 *
 * Org: `SELECT MemberType, MemberName, RevisionCounter, IsNameObsolete FROM SourceMember`. It exists only in
 * orgs with source tracking (scratch orgs, sandboxes with it enabled); elsewhere the query fails, which is the
 * capability test (`isTrackingUnsupported`).
 * Local: `<project>/.sf/orgs/<orgId>/maxRevision.json` (written by `sf project deploy/retrieve`):
 *   { "serverMaxRevisionCounter": 123, "sourceMembers": { "ApexClass###Foo": { "serverRevisionCounter": 12,
 *     "lastRetrievedFromServer": 12, "memberType": "ApexClass", "isNameObsolete": false } } }
 * (older CLI versions joined type and name with `__` instead of `###`).
 *
 * What it decides: a member is in sync with this project when the CLI's own file says its last known org
 * revision was retrieved (`lastRetrievedFromServer` >= `serverRevisionCounter`) AND the org did not record a
 * newer revision since (not in the delta above `serverMaxRevisionCounter`) AND the toolkit's sync record has
 * the same local contents hash as now. A changed member only says "changed in org", not that the contents
 * differ (a redeploy of identical contents bumps the revision too), so it is never decided `different`.
 */
import { SyncEntry } from "./syncRecordPure";
import { lookupKeyOf } from "./contentComparePure";

export interface TrackedMember {
	rev: number;
	obsolete: boolean;
}

/** Revision state the `sf` CLI keeps for one org of the project. */
export interface LocalTracking {
	/** `serverMaxRevisionCounter`: the highest org revision the CLI has seen. */
	maxRevision: number;
	/** `Type:Name` (lookup key form) → what the CLI knows of the member. */
	members: Map<string, { rev: number; retrieved: number | null; obsolete: boolean }>;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Split a tracking-file key (`Type###Name`, or the older `Type__Name`) into type and name. */
export function splitMemberKey(key: string): { type: string; name: string } | undefined {
	let i = key.indexOf("###");
	let w = 3;
	if (i < 0) {
		i = key.indexOf("__");
		w = 2;
	}
	if (i <= 0 || i + w >= key.length) return undefined;
	return { type: key.slice(0, i), name: key.slice(i + w) };
}

/** Parse `maxRevision.json`; undefined when it is not the format above. */
export function parseMaxRevisionFile(json: unknown): LocalTracking | undefined {
	const o = json && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
	const max = num(o?.serverMaxRevisionCounter);
	const sm = o?.sourceMembers;
	if (max === undefined || !sm || typeof sm !== "object") return undefined;
	const members = new Map<string, { rev: number; retrieved: number | null; obsolete: boolean }>();
	for (const [k, v] of Object.entries(sm as Record<string, unknown>)) {
		const m = v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
		const rev = num(m?.serverRevisionCounter);
		if (!m || rev === undefined) continue;
		const type = typeof m.memberType === "string" ? m.memberType : splitMemberKey(k)?.type;
		const sp = splitMemberKey(k);
		if (!type || !sp) continue;
		members.set(lookupKeyOf(type, sp.name), { rev, retrieved: num(m.lastRetrievedFromServer) ?? null, obsolete: m.isNameObsolete === true });
	}
	return { maxRevision: max, members };
}

/** Parse SourceMember records into `Type:Name` → revision (lookup key form). */
export function parseSourceMembers(records: readonly unknown[]): Map<string, TrackedMember> {
	const out = new Map<string, TrackedMember>();
	for (const r of records) {
		const o = r && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
		const type = typeof o?.MemberType === "string" ? o.MemberType : undefined;
		const name = typeof o?.MemberName === "string" ? o.MemberName : undefined;
		const rev = num(o?.RevisionCounter);
		if (!type || !name || rev === undefined) continue;
		const key = lookupKeyOf(type, name);
		const prev = out.get(key);
		if (!prev || rev > prev.rev) out.set(key, { rev, obsolete: o?.IsNameObsolete === true });
	}
	return out;
}

/** The highest RevisionCounter of a (descending, LIMIT 1) probe result; undefined when empty / unreadable. */
export function maxRevisionOf(records: readonly unknown[]): number | undefined {
	let max: number | undefined;
	for (const r of records) {
		const rev = num((r as Record<string, unknown> | undefined)?.RevisionCounter);
		if (rev !== undefined && (max === undefined || rev > max)) max = rev;
	}
	return max;
}

/** Does this failure of the SourceMember query mean the org has no source tracking (as opposed to a transient failure)? */
export function isTrackingUnsupported(status: number | undefined, message: string): boolean {
	if (status !== undefined && status !== 400 && status !== 404) return false;
	return /INVALID_TYPE|not supported|sObject type 'SourceMember'|NOT_FOUND/i.test(message);
}

/** The delta query: members the org changed after the highest revision the CLI has seen. */
export const sourceMemberDeltaQuery = (afterRevision: number): string =>
	`SELECT MemberType, MemberName, RevisionCounter, IsNameObsolete FROM SourceMember WHERE RevisionCounter > ${Math.max(0, Math.floor(afterRevision))}`;

/** The capability probe: the same fields, newest revision first, one row. */
export const SOURCE_MEMBER_PROBE = "SELECT MemberType, MemberName, RevisionCounter, IsNameObsolete FROM SourceMember ORDER BY RevisionCounter DESC LIMIT 1";

/** What the tracking layer knows for one run. */
export interface TrackingContext {
	local: LocalTracking;
	/** Members the org changed since the CLI's `serverMaxRevisionCounter` (`Type:Name`). */
	changedInOrg: ReadonlyMap<string, TrackedMember>;
	/** The delta was cut off (too many rows): nothing can be decided. */
	incomplete?: boolean;
}

/** Layer 3: `same` for a member in sync per the CLI's file, unchanged in the org, with unchanged local contents; else undecided. */
export function decideTracking(lookup: string, ctx: TrackingContext | undefined, syncRecord: SyncEntry | undefined, localHash: string): "same" | undefined {
	if (!ctx || ctx.incomplete) return undefined;
	if (!syncRecord || syncRecord.hash !== localHash) return undefined;
	const m = ctx.local.members.get(lookup);
	if (!m || m.obsolete || m.retrieved === null || m.retrieved < m.rev) return undefined;
	if (ctx.changedInOrg.has(lookup)) return undefined;
	return "same";
}

/** How many of `lookups` the org changed since the CLI last looked (the "changed in org" signal; logged). */
export function countChangedInOrg(lookups: Iterable<string>, ctx: TrackingContext | undefined): number {
	if (!ctx) return 0;
	let n = 0;
	for (const l of lookups) if (ctx.changedInOrg.has(l)) n++;
	return n;
}
