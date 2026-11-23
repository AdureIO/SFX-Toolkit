/**
 * The check right before a deploy / validation, shared by the Deploy panel and the Deploy & Retrieve Center:
 * ask the org NOW (never the cache) whether any selected component changed since this toolkit last retrieved
 * or deployed it. Lists live only the metadata types of the selected components (folder types: only their
 * folders), then decides with `evaluatePreDeploy`. An org that cannot be asked (expired session, offline)
 * does not block: the result has no decision and the deploy goes on.
 */
import * as vscode from "vscode";
import { CompareTarget, ContentCompareService } from "./contentCompare";
import { effectiveSyncedAt } from "./compareStatusPure";
import { folderRestriction, nameOfComponentKey, typeOfComponentKey } from "./deployComponentsPure";
import { DeployOrgStatus } from "./deployOrgStatus";
import { OrgCompInfo, PreDeployDecision, evaluatePreDeploy, orgLookupKey } from "./deployStatusPure";
import { DEFAULT_ORG_KEY } from "./orgKey";
import { ListCancelled } from "./orgBrowser/metadataLister";
import { getRetrieveTimes } from "./retrieveLog";

/** Result of the live check right before a deploy / validation. */
export interface PreDeployCheck {
	/** Null when the org could not be asked (the deploy still goes ahead). */
	decision: PreDeployDecision | null;
	/** Why the org could not be asked. */
	error?: string;
	/** Metadata types listed live, and the SOAP calls that took (for the log). */
	types: string[];
	soapCalls: number;
	ms: number;
}

export interface PreDeployCheckDeps {
	/** The org listing state the check refreshes (already pointed at the org with `load`). */
	status: DeployOrgStatus;
	orgKey: string;
	orgArg: string | null;
	/** The shared content-compare service of (project, org), when there is one. */
	service?: ContentCompareService;
	/** Compare targets of local component keys. */
	compareTargets(keys: string[]): CompareTarget[];
	/** SOAP calls sent so far (the check reports its own cost). */
	soapCalls(): number;
	/** A background refresh would race with this one over the same state. */
	cancelBackground(): void;
}

/** `keys`: local index keys (`Type:name`) of the components about to be deployed. */
export async function checkOrgBeforeDeploy(deps: PreDeployCheckDeps, keys: string[]): Promise<PreDeployCheck> {
	const types = [...new Set(keys.map(typeOfComponentKey))];
	const t0 = Date.now();
	const calls0 = deps.soapCalls();
	const done = (decision: PreDeployDecision | null, error?: string): PreDeployCheck => ({ decision, error, types, soapCalls: deps.soapCalls() - calls0, ms: Date.now() - t0 });
	if (!deps.orgKey || deps.orgKey === DEFAULT_ORG_KEY) return done(null, "no target org");
	deps.cancelBackground();
	const selected = keys.map((key) => ({ key, type: typeOfComponentKey(key), name: nameOfComponentKey(key) }));
	try {
		const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Checking the org for changes…" }, () =>
			deps.status.refresh(types, { onlyFolders: folderRestriction(keys) })
		);
		const orgComps = new Map<string, OrgCompInfo>();
		for (const c of selected) {
			const info = deps.status.get(c.type, c.name);
			if (info) orgComps.set(orgLookupKey(c.type, c.name), info);
		}
		// Last sync = retrieve / deploy log or the last content-verified "same"; verified-equal components never warn.
		const log = getRetrieveTimes(deps.orgArg);
		const syncedAt: Record<string, number> = {};
		for (const c of selected) {
			const t = effectiveSyncedAt(log[c.key], deps.service?.verifiedSyncAt(c.key));
			if (t !== undefined) syncedAt[c.key] = t;
		}
		const verifiedEqual = deps.service ? await deps.service.verifiedEqualNow(deps.compareTargets(selected.map((c) => c.key))) : undefined;
		const decision = evaluatePreDeploy({
			selected,
			orgComps,
			listedTypes: new Set(outcome.listed),
			failedTypes: outcome.failed,
			syncedAt,
			verifiedEqual,
		});
		return done(decision);
	} catch (e: unknown) {
		if (e instanceof ListCancelled) return done(null, "cancelled");
		return done(null, String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 240));
	}
}
