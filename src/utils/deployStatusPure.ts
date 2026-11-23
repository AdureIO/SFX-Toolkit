/**
 * Deploy Metadata panel: status of a local component against the target org. Pure (no `vscode`, no DOM):
 * runs in the webview, the extension host and the tests.
 *
 * A row carries a bitmask of these statuses (several can hold at once):
 *   new               exists locally, not in the org listing
 *   in-org            exists in the org
 *   changed-in-org    the org's lastModifiedDate is newer than the last retrieve / deploy of it from this toolkit
 *   modified-locally  git reports its files as changed
 *   unknown           the org listing of its type is missing (not listed yet, or the listing failed)
 * `changed-in-org` + `modified-locally` is a conflict (`status:conflict`).
 */
import { StatusVocab } from "./orgBrowser/filter";

export const DS_NEW = 1;
export const DS_IN_ORG = 2;
export const DS_CHANGED_IN_ORG = 4;
export const DS_MODIFIED_LOCALLY = 8;
export const DS_UNKNOWN = 16;
export const DS_CONFLICT = DS_CHANGED_IN_ORG | DS_MODIFIED_LOCALLY;

/** Facet names; bit i of the row value = names[i]. */
export const DEPLOY_STATUS_NAMES = ["new", "in-org", "changed-in-org", "modified-locally", "unknown"] as const;

export const DEPLOY_STATUS_LABELS: Record<(typeof DEPLOY_STATUS_NAMES)[number], string> = {
	new: "New (not in org)",
	"in-org": "In org",
	"changed-in-org": "Changed in org",
	"modified-locally": "Modified locally",
	unknown: "Unknown",
};

export const DEPLOY_VOCAB: StatusVocab = {
	names: DEPLOY_STATUS_NAMES,
	flags: true,
	aliases: {
		new: "new",
		"not-in-org": "new",
		notinorg: "new",
		"in-org": "in-org",
		inorg: "in-org",
		"changed-in-org": "changed-in-org",
		changed: "changed-in-org",
		"org-changed": "changed-in-org",
		"modified-locally": "modified-locally",
		modified: "modified-locally",
		local: "modified-locally",
		dirty: "modified-locally",
		unknown: "unknown",
	},
	shorthands: {
		conflict: (v) => (v & DS_CONFLICT) === DS_CONFLICT,
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
	/** Last retrieve / deploy of it from this toolkit for this org (epoch ms); undefined = never. */
	syncedAt?: number;
	/** Git reports one of its files as changed. */
	modifiedLocally: boolean;
}

/** The status bitmask of a component. */
export function deployStatusFlags(i: DeployStatusInput): number {
	let v = 0;
	if (!i.orgKnown) v |= DS_UNKNOWN;
	else if (!i.inOrg) v |= DS_NEW;
	else {
		v |= DS_IN_ORG;
		// Without a retrieve / deploy record there is nothing to compare with: not "changed" (as in the Org Browser).
		if (i.syncedAt !== undefined && i.orgLm > i.syncedAt) v |= DS_CHANGED_IN_ORG;
	}
	if (i.modifiedLocally) v |= DS_MODIFIED_LOCALLY;
	return v;
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
	/** Last retrieve / deploy of each component from this toolkit: `Type:Name` → epoch ms. */
	syncedAt: Readonly<Record<string, number>>;
}

export interface PreDeployDecision {
	/** Selected components modified in the org after their last retrieve / deploy. */
	changed: ChangedComponent[];
	/** Selected components that could not be checked (their type could not be listed). */
	unverified: { key: string; reason: string }[];
	/** The user has to decide before the deploy starts. Unverified components never block (the deploy still works). */
	needsConfirmation: boolean;
}

/** Which of the selected components changed in the org since this toolkit last retrieved or deployed them. */
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
