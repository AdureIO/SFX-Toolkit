/**
 * Pre-deploy check and the org-listing key of a local component. Pure (no `vscode`, no DOM): runs in the webview,
 * the extension host and the tests. (The row statuses live in `compareStatusPure` and `syncCenterPure`.)
 */
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
