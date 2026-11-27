/**
 * Extension-host side of the layered content compare: the Tooling API source reader (layer 2) and the
 * source-tracking context (layer 3). Only ever talks to the org the compare service belongs to. Never writes
 * org content anywhere. The decisions themselves are pure (`toolingComparePure`, `sourceTrackingPure`).
 */
import * as fs from "fs";
import * as path from "path";
import { AuthInfo } from "./authInfo";
import { CancelToken } from "./contentCompare";
import { getToolingApiVersion } from "./constants";
import { canonicalOrgKey } from "./orgKey";
import { OrgSourceCandidate, ToolingTarget, buildToolingQueries, parseToolingRecords } from "./toolingComparePure";
import {
	SOURCE_MEMBER_PROBE,
	TrackingContext,
	isTrackingUnsupported,
	maxRevisionOf,
	parseMaxRevisionFile,
	parseSourceMembers,
	sourceMemberDeltaQuery,
} from "./sourceTrackingPure";

const MAX_PAGES = 200;
/** Parallel Tooling requests. */
const CONCURRENCY = 3;

const cancelled = () => Object.assign(new Error("Command cancelled."), { cancelled: true });

/** `/services/data/vXX.X/tooling/query?q=…` (follows `nextRecordsUrl`); every record of every page. */
async function toolingQueryAll(orgArg: string | null, soql: string, token: CancelToken, maxRecords = Infinity): Promise<{ records: unknown[]; truncated: boolean }> {
	const records: unknown[] = [];
	let next: string | undefined = `/services/data/${getToolingApiVersion()}/tooling/query?q=${encodeURIComponent(soql)}`;
	for (let page = 0; next && page < MAX_PAGES; page++) {
		if (token.isCancellationRequested) throw cancelled();
		const rel: string = next;
		const res = await AuthInfo.getEx(orgArg, (a) => `${a.instanceUrl.replace(/\/$/, "")}${rel}`, { totalTimeoutMs: 180_000 });
		const json = JSON.parse(res.body) as { records?: unknown[]; nextRecordsUrl?: string; done?: boolean };
		records.push(...(json.records ?? []));
		if (records.length >= maxRecords) return { records, truncated: json.done === false };
		next = json.done === false ? json.nextRecordsUrl : undefined;
	}
	return { records, truncated: next !== undefined };
}

/** Layer 2 for `orgArg`: `Type:DeveloperName` → candidates. A failing request fails the call (the layer's input flows on to the retrieve). */
export function makeToolingSource(orgArg: string | null): (targets: ToolingTarget[], token: CancelToken) => Promise<Map<string, OrgSourceCandidate[]>> {
	return async (targets, token) => {
		const queries = buildToolingQueries(targets);
		const out = new Map<string, OrgSourceCandidate[]>();
		let i = 0;
		const worker = async (): Promise<void> => {
			while (i < queries.length) {
				const q = queries[i++];
				const { records, truncated } = await toolingQueryAll(orgArg, q.soql, token);
				if (truncated) throw new Error(`Tooling query for ${q.type} returned too many pages`);
				for (const [k, v] of parseToolingRecords(q.type, records)) out.set(k, [...(out.get(k) ?? []), ...v]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));
		return out;
	};
}

// ── Source tracking ────────────────────────────────────────────────────────────

/** Does the org have source tracking? Cached per org; only a definite "no" (INVALID_TYPE) is remembered, a transient failure is retried. */
const trackingCapability = new Map<string, boolean>();
/** The delta is cut off beyond this many changed members (a stale local tracking file): nothing is decided from it. */
const MAX_DELTA = 20_000;

/** Test / reconnect hook. */
export function resetTrackingCapability(): void {
	trackingCapability.clear();
}

/**
 * Layer 3 for (`projectDir`, `orgArg`): the project's `.sf/orgs/<orgId>/maxRevision.json` plus the org's
 * SourceMember delta above its max revision. undefined when the project has no tracking file for the org, or
 * the org has no source tracking.
 */
export function makeTrackingContext(projectDir: string, orgArg: string | null, log: (line: string) => void): (token: CancelToken) => Promise<TrackingContext | undefined> {
	return async (token) => {
		const orgKey = canonicalOrgKey(orgArg);
		if (trackingCapability.get(orgKey) === false) return undefined;
		const auth = await AuthInfo.getAuthInfoForOrg(orgArg);
		if (!auth?.orgId) return undefined;
		let local;
		try {
			local = parseMaxRevisionFile(JSON.parse(await fs.promises.readFile(path.join(projectDir, ".sf", "orgs", auth.orgId, "maxRevision.json"), "utf8")));
		} catch {
			local = undefined;
		}
		if (!local) {
			log("Content compare: source tracking: the project has no sf tracking file for this org");
			return undefined;
		}
		if (trackingCapability.get(orgKey) === undefined) {
			try {
				const probe = await toolingQueryAll(orgArg, SOURCE_MEMBER_PROBE, token, 1);
				trackingCapability.set(orgKey, true);
				log(`Content compare: source tracking: org has SourceMember (max revision ${maxRevisionOf(probe.records) ?? "?"}, local file ${local.maxRevision})`);
			} catch (e: any) {
				if (token.isCancellationRequested) throw e;
				if (isTrackingUnsupported(e?.status, String(e?.message ?? e))) {
					trackingCapability.set(orgKey, false);
					log("Content compare: source tracking: the org has no source tracking (SourceMember is not available)");
				} else {
					log(`Content compare: source tracking: probe failed (${String(e?.message ?? e).slice(0, 200)}), not used this run`);
				}
				return undefined;
			}
		}
		const delta = await toolingQueryAll(orgArg, sourceMemberDeltaQuery(local.maxRevision), token, MAX_DELTA);
		return { local, changedInOrg: parseSourceMembers(delta.records), incomplete: delta.truncated || delta.records.length >= MAX_DELTA };
	};
}
