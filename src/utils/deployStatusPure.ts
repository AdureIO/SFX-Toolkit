/**
 * Deploy Metadata panel: status of a local component against the target org. Pure (no `vscode`, no DOM):
 * runs in the webview, the extension host and the tests.
 *
 * One status per row (a code, index into `DEPLOY_STATUS_NAMES`):
 *   new               exists locally, not in the org listing
 *   equal             same as the org
 *   changed-locally   changed here since the last sync
 *   changed-in-org    changed in the org since the last sync (its latest change is shown next to the badge)
 *   conflict          both
 *   unknown           the org listing of its type is missing (not listed yet, or the listing failed), or the local
 *                     change info is not read yet
 * The compare itself (dates, then contents) is `compareStatus` in compareStatusPure.
 */
import { StatusVocab } from "./orgBrowser/filter";
import {
	CODE_CHANGED_IN_ORG,
	CODE_CHANGED_LOCALLY,
	CODE_CONFLICT,
	CODE_EQUAL,
	COMPARE_CODES,
	ContentResult,
	anyComparedShorthand,
	compareStatus,
	sharedStatusAliases,
} from "./compareStatusPure";

export const DS_NEW = 0;
export const DS_EQUAL = CODE_EQUAL;
export const DS_CHANGED_LOCALLY = CODE_CHANGED_LOCALLY;
export const DS_CHANGED_IN_ORG = CODE_CHANGED_IN_ORG;
export const DS_CONFLICT = CODE_CONFLICT;
export const DS_UNKNOWN = 5;

/** Facet names; the row value is the index. */
export const DEPLOY_STATUS_NAMES = ["new", "equal", "changed-locally", "changed-in-org", "conflict", "unknown"] as const;

export const DEPLOY_STATUS_LABELS: Record<(typeof DEPLOY_STATUS_NAMES)[number], string> = {
	new: "New (not in org)",
	equal: "Equal",
	"changed-locally": "Changed locally",
	"changed-in-org": "Changed in org (latest)",
	conflict: "Conflict",
	unknown: "Not compared / unknown",
};

export const DEPLOY_VOCAB: StatusVocab = {
	names: DEPLOY_STATUS_NAMES,
	flags: false,
	aliases: {
		...sharedStatusAliases(),
		new: "new",
		"not-in-org": "new",
		notinorg: "new",
	},
	shorthands: {
		inorg: anyComparedShorthand,
		"in-org": anyComparedShorthand,
	},
};

/** What is known about one local component. */
export interface DeployStatusInput {
	/** The org listing of the component's type is available (cached or fresh). */
	orgKnown: boolean;
	/** The component is in that listing. */
	inOrg: boolean;
	/** lastModifiedDate in the org (epoch ms; 0 = unknown). */
	orgLm: number;
	/** Last sync: toolkit retrieve / deploy log or content-verified equal (epoch ms); undefined = never. */
	syncedAt?: number;
	/** Local change time + git dirty; undefined = not read yet. */
	local?: { localT: number; dirty: boolean };
	/** Content diff result. */
	content?: ContentResult;
}

export interface DeployStatus {
	code: number;
	provisional: boolean;
	/** For `unknown`: why. */
	why?: "org" | "local";
}

/** The status of a component. */
export function deployStatus(i: DeployStatusInput): DeployStatus {
	if (!i.orgKnown) return { code: DS_UNKNOWN, provisional: true, why: "org" };
	if (!i.inOrg) return { code: DS_NEW, provisional: false };
	if (!i.local && i.content !== "same") return { code: DS_UNKNOWN, provisional: true, why: "local" };
	const r = compareStatus({ orgLm: i.orgLm, syncedAt: i.syncedAt, localT: i.local?.localT ?? 0, dirty: i.local?.dirty ?? false, content: i.content });
	return { code: COMPARE_CODES[r.status], provisional: r.provisional };
}

/**
 * The key a local component has in the org listing. Source file names percent-encode some characters
 * (`Account-Account%20Layout`); the org lists `Account-Account Layout`.
 */
export function orgLookupKey(type: string, name: string): string {
	let n = name;
	if (n.includes("%")) {
		try {
			n = decodeURIComponent(n);
		} catch {
			/* keep the raw name */
		}
	}
	return `${type}:${n}`;
}

// ── Pre-deploy check ───────────────────────────────────────────────────────────

export interface OrgCompInfo {
	/** lastModifiedDate, epoch ms. */
	lm: number;
	by: string;
}

export interface SelectedComponent {
	key: string;
	type: string;
	name: string;
}

export interface ChangedComponent {
	key: string;
	type: string;
	name: string;
	by: string;
	lm: number;
	syncedAt: number;
}

export interface PreDeployInput {
	selected: SelectedComponent[];
	/** A FRESH listing of the selected components' types: org key (see `orgLookupKey`) → info. */
	orgComps: ReadonlyMap<string, OrgCompInfo>;
	/** Types the fresh listing covered successfully. */
	listedTypes: ReadonlySet<string>;
	/** Types that could not be listed: type → reason. */
	failedTypes: ReadonlyMap<string, string>;
	/** Last sync of each component (toolkit retrieve / deploy, or a content-verified "same"): `Type:Name` → epoch ms. */
	syncedAt: Readonly<Record<string, number>>;
	/** Components whose contents were compared against this very org version and found equal: they never warn. */
	verifiedEqual?: ReadonlySet<string>;
}

export interface PreDeployDecision {
	/** Selected components modified in the org after their last retrieve / deploy. */
	changed: ChangedComponent[];
	/** Selected components that could not be checked (their type could not be listed). */
	unverified: { key: string; reason: string }[];
	/** The user has to decide before the deploy starts. Unverified components never block (the deploy still works). */
	needsConfirmation: boolean;
}

/** Which of the selected components changed in the org since the last sync (retrieve, deploy or verified-equal compare); verified-equal ones never warn. */
export function evaluatePreDeploy(i: PreDeployInput): PreDeployDecision {
	const changed: ChangedComponent[] = [];
	const unverified: { key: string; reason: string }[] = [];
	for (const c of i.selected) {
		if (i.failedTypes.has(c.type)) {
			unverified.push({ key: c.key, reason: i.failedTypes.get(c.type) ?? "listing failed" });
			continue;
		}
		if (!i.listedTypes.has(c.type)) {
			unverified.push({ key: c.key, reason: "type not listed" });
			continue;
		}
		if (i.verifiedEqual?.has(c.key)) continue;
		const org = i.orgComps.get(orgLookupKey(c.type, c.name));
		const synced = i.syncedAt[c.key];
		if (org && synced !== undefined && org.lm > synced) {
			changed.push({ key: c.key, type: c.type, name: c.name, by: org.by, lm: org.lm, syncedAt: synced });
		}
	}
	changed.sort((a, b) => b.lm - a.lm || a.key.localeCompare(b.key));
	return { changed, unverified, needsConfirmation: changed.length > 0 };
}

/** Title + detail of the "changed in the org" modal; at most `maxLines` components are listed. */
export function preDeployPrompt(
	changed: ChangedComponent[],
	dryRun: boolean,
	fmt: (ms: number) => string,
	maxLines = 10
): { message: string; detail: string } {
	const n = changed.length;
	const lines = changed.slice(0, maxLines).map((c) => `${c.key} — last modified by ${c.by || "unknown"}, ${c.lm ? fmt(c.lm) : "at an unknown time"}`);
	if (n > maxLines) lines.push(`… and ${n - maxLines} more`);
	return {
		message: `${n} component${n === 1 ? "" : "s"} changed in the org since your last retrieve or deploy`,
		detail: `${dryRun ? "Deploying this selection later would" : "Going on will"} overwrite ${n === 1 ? "that change" : "those changes"} in the org.\n\n${lines.join("\n")}`,
	};
}
