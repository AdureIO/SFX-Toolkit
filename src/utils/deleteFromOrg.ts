/**
 * Delete components from an org with a destructive-changes deploy (Deploy & Retrieve Metadata, "Delete from org").
 *
 * The UI calls, in this order:
 *   1. `checkOrgForDestructive(org, projectDir)` (orgSafety): is a typed confirmation needed?
 *   2. its modal (components listing via `deleteListing`, org alias and username, typed alias when needed)
 *   3. `deleteFromOrg(...)`
 * then shows the outcome like a deploy and refreshes the listing of `types`.
 */
import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { runCommandArgs } from "./commandRunner";
import { getToolingApiVersion } from "./constants";
import { DEPLOY_TIMEOUT_MS } from "../commands/deployMetadata";
import { startLiveDiscovery } from "./deployEngine";
import { DeployLiveStatus } from "./deployStatusMap";
import { runDestructiveDeploy } from "./destructiveRun";
import { DeleteOutcome, DestructiveComponent } from "./destructivePure";
import { Logger } from "./outputChannel";
import { recordHistory } from "./syncHistory";
import { historyErrorsFromDeploy } from "./historyPure";

export interface DeleteFromOrgOptions {
	projectDir: string;
	/** `--target-org` (alias or username): the org the panel is showing, never the CLI default. */
	org: string;
	/** Components in org naming (`SyncRow.type` / `SyncRow.name`; see `componentRefs`). */
	components: readonly DestructiveComponent[];
	testLevel: string;
	specifiedTests?: readonly string[];
	token?: vscode.CancellationToken;
	/** Live numbers of the running delete (components, errors), polled over REST like a deploy's; absent = no polling. */
	onStatus?: (s: DeployLiveStatus) => void;
}

export interface DeleteFromOrgResult {
	outcome: DeleteOutcome;
	/** Distinct types of the components: re-list these afterwards. */
	types: string[];
	durationMs: number;
}

/** `sourceApiVersion` of the project (`62.0`), else the toolkit's API version. */
export function projectApiVersion(projectDir: string): string {
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8"));
		if (typeof cfg?.sourceApiVersion === "string" && /^\d+(\.\d+)?$/.test(cfg.sourceApiVersion)) return cfg.sourceApiVersion;
	} catch {
		/* no readable config */
	}
	return getToolingApiVersion().replace(/^v/, "");
}

/**
 * Run the destructive deploy. Throws only for invalid input (test level, test names, nothing to delete);
 * a failure of the org or the CLI comes back as `outcome.kind === "failed"`. Recorded in the history (kind
 * `delete`, source `center`) unless cancelled.
 */
export async function deleteFromOrg(o: DeleteFromOrgOptions): Promise<DeleteFromOrgResult> {
	const startedAt = Date.now();
	const res = await runDestructiveDeploy({
		projectDir: o.projectDir,
		org: o.org,
		components: o.components,
		testLevel: o.testLevel,
		specifiedTests: o.specifiedTests,
		apiVersion: projectApiVersion(o.projectDir),
		exec: async (args, cwd) => {
			const live = o.onStatus && o.token ? startLiveDiscovery({ cwd, org: o.org, token: o.token, onStatus: o.onStatus, timeoutMs: DEPLOY_TIMEOUT_MS }) : undefined;
			try {
				return await runCommandArgs("sf", args, cwd, live?.onOutput, false, DEPLOY_TIMEOUT_MS, o.token);
			} finally {
				await live?.finish();
			}
		},
	});
	const out = res.outcome;
	if (out.kind !== "cancelled") {
		Logger.info(`Delete from org ${o.org}: ${o.components.length} component(s), ${out.kind} in ${res.durationMs} ms`);
		recordHistory(o.projectDir, {
			kind: "delete",
			org: o.org,
			at: startedAt,
			durationMs: res.durationMs,
			components: o.components.map((c) => `${c.type}:${c.fullName}`),
			testLevel: o.testLevel,
			tests: o.testLevel === "RunSpecifiedTests" ? [...(o.specifiedTests ?? [])] : undefined,
			deployId: out.deployId,
			ok: out.kind === "success",
			errors: out.kind === "failed" ? historyErrorsFromDeploy(out.apiResult, out.errorText) : undefined,
			source: "center",
		});
	}
	return res;
}
