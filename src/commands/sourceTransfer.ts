/**
 * Right-click "Deploy to / Retrieve from Default Org" for files, folders and multi-selections
 * (Explorer, editor and editor-tab context menus, plus the palette for the active editor).
 * Each project in the selection is ONE CLI call, against that project's OWN default org
 * (a selection spanning projects with different default orgs deploys each group to its own org).
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { escapeShellArg } from "../utils/commandRunner";
import { Logger, DeployLog } from "../utils/outputChannel";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { runJsonDeploy } from "../utils/deployEngine";
import { DEPLOY_TIMEOUT_MS, getPackageDirectories } from "./deployMetadata";
import { addDeployHistoryEntry } from "./deployHistory";
import { formatStatus, schemaObjectFromPath, statsFromResult, toApiDeployResult } from "../utils/deployStatusMap";
import {
	clearDeployDiagnostics,
	componentFailuresOf,
	setDeployDiagnosticsFromApiResult,
	setDeployDiagnosticsFromFailure,
	withSyntheticTestFailures,
} from "../utils/deployDiagnostics";
import { reportError, reportSuccess } from "../utils/reportError";
import { OperationPanelProvider } from "../providers/OperationPanelProvider";
import { getDefaultOrg, getDefaultOrgSync } from "../utils/defaultOrg";
import { assignOrgs, orgLabelOf, spansMultipleOrgs, summarizeOrgs, type OrgAssignment } from "../utils/perProjectOrg";
import { confirmProductionOrgOperation } from "../utils/orgSafety";
import { Telemetry } from "../utils/telemetry";
import { findSfdxProjectDir } from "../utils/projectUtils";
import { confirmOverwrite, revertOpenEditors } from "../utils/retrieveSafety";
import { retrieveComponents } from "../utils/retrieveEngine";
import { isSameOrUnder } from "../utils/retrieveSafetyPure";
import { knownProjectDirs } from "../utils/schemaHealthMonitor";
import { buildUpdateSummary, resolvePackageDirPaths } from "../utils/updateProjectPure";
import { buildDeployStartArgs, planSelection, type SelectionGroup, type SelectionPlan } from "../utils/sourceSelection";

/** Menu arguments: `(clickedUri, allSelectedUris)`; the palette passes nothing. */
function selectionFromArgs(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
	const list = Array.isArray(uris) && uris.length > 0 ? uris : uri instanceof vscode.Uri ? [uri] : [];
	if (list.length > 0) return list.filter((u) => u.scheme === "file");
	const doc = vscode.window.activeTextEditor?.document;
	return doc && doc.uri.scheme === "file" ? [doc.uri] : [];
}

function buildPlan(uris: vscode.Uri[]): SelectionPlan {
	return planSelection(
		uris.map((u) => u.fsPath),
		{
			findProjectDir: findSfdxProjectDir,
			packageDirs: (projectDir) => getPackageDirectories(projectDir).map((d) => path.join(projectDir, d)),
			exists: (p) => fs.existsSync(p),
		}
	);
}

/** Resolve + plan, with the user-facing warnings. Returns undefined when there is nothing to do. */
function prepare(uri: vscode.Uri | undefined, uris: vscode.Uri[] | undefined): SelectionPlan | undefined {
	const selection = selectionFromArgs(uri, uris);
	if (selection.length === 0) {
		vscode.window.showErrorMessage("No file or folder selected.");
		return undefined;
	}
	const plan = buildPlan(selection);
	if (plan.skipped.length > 0) {
		vscode.window.showWarningMessage(`${plan.skipped.length} item(s) outside package directories were skipped.`);
	}
	if (plan.groups.length === 0) {
		if (plan.skipped.length === 0) vscode.window.showErrorMessage("Nothing to process in the selection.");
		return undefined;
	}
	return plan;
}

function allPaths(plan: SelectionPlan): string[] {
	return plan.groups.flatMap((g) => g.paths);
}

function invalidateSchema(org: string | null, paths: string[]): void {
	const objects = new Set<string>();
	let structural = false;
	for (const p of paths) {
		const s = schemaObjectFromPath(p);
		if (!s) continue;
		objects.add(s.object);
		if (s.structural) structural = true;
	}
	if (objects.size === 0) return;
	OrgMetadataCache.invalidateSObjects(org, [...objects], structural);
	if (structural) OrgMetadataCache.warmOrg(org);
}

/** Every group paired with ITS project's default org (CLI fallback when config / cache are empty). */
async function resolveGroupOrgs(plan: SelectionPlan): Promise<OrgAssignment<SelectionGroup>[]> {
	const resolved = new Map<string, { username: string; displayName: string } | null>();
	for (const g of plan.groups) {
		resolved.set(g.projectDir, getDefaultOrgSync(g.projectDir) ?? (await getDefaultOrg(g.projectDir)));
	}
	return assignOrgs(plan.groups, (dir) => resolved.get(dir) ?? null);
}

/** One modal listing which project goes to which org, when the selection spans several orgs. */
async function confirmMultiOrg(assignments: OrgAssignment<SelectionGroup>[], verb: string): Promise<boolean> {
	if (!spansMultipleOrgs(assignments)) return true;
	const lines = assignments.map((a) => `${path.basename(a.group.projectDir)}: ${orgLabelOf(a.org)}`);
	const choice = await vscode.window.showWarningMessage(
		`The selection spans projects with different default orgs.`,
		{ modal: true, detail: `Each project is ${verb} its own default org:\n${lines.join("\n")}` },
		"Continue"
	);
	return choice === "Continue";
}

function showProblems(): void {
	void vscode.commands.executeCommand("workbench.actions.view.problems");
}

export async function deployToDefaultOrg(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
	const plan = prepare(uri, uris);
	if (!plan) return;
	const paths = allPaths(plan);

	// Save only the dirty editors that are part of the selection.
	const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled && paths.some((p) => isSameOrUnder(p, d.uri.fsPath)));
	for (const d of dirty) await d.save();

	const assignments = await resolveGroupOrgs(plan);
	const orgLabel = summarizeOrgs(assignments);
	// Production warning once per distinct org, checked against the project that deploys to it.
	const checked = new Set<string | null>();
	for (const a of assignments) {
		if (checked.has(a.org.username)) continue;
		checked.add(a.org.username);
		if (!(await confirmProductionOrgOperation("deploy metadata to", a.org.username, a.group.projectDir))) return;
	}
	if (!(await confirmMultiOrg(assignments, "deployed to"))) return;

	const operationHandle = OperationPanelProvider.beginOperation("Deploy", orgLabel);
	const startTime = Date.now();
	const title = `Deploying ${paths.length} item(s) to ${orgLabel}…`;

	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
		clearDeployDiagnostics();
		let deployed = 0;
		for (const { group, org } of assignments) {
			const targetUser = org.username;
			const groupOrgLabel = orgLabelOf(org);
			progress.report({ message: `${path.basename(group.projectDir)} → ${groupOrgLabel}` });
			const submit = ["sf", ...buildDeployStartArgs(group.paths, targetUser).map(escapeShellArg)].join(" ");
			Logger.info(`Right-click deploy in ${group.projectDir}: ${submit}`);
			const relPaths = group.paths.map((p) => path.relative(group.projectDir, p) || ".");
			const record = (status: "Succeeded" | "Failed" | "Cancelled", stats = { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 }) =>
				addDeployHistoryEntry({
					timestamp: startTime,
					status,
					dryRun: false,
					...stats,
					durationMs: Date.now() - startTime,
					targetOrg: targetUser ?? "",
					sourcePaths: relPaths,
					presetName: null,
					deployType: "RunRelevantTests",
				});
			try {
				const res = await runJsonDeploy({
					submitCommand: submit,
					cwd: group.projectDir,
					org: targetUser,
					token,
					timeoutMs: DEPLOY_TIMEOUT_MS,
					onStatus: (s) => {
						progress.report({ message: formatStatus(s) });
						operationHandle.updateLiveStatus(s);
					},
				});
				if (res.kind === "cancelled") {
					Logger.info("Deploy cancelled by user.");
					Telemetry.event("deployFile", { status: "cancelled" });
					record("Cancelled");
					operationHandle.dispose();
					return;
				}
				if (res.kind === "failed") {
					Telemetry.event("deployFile", { status: "failed" });
					const dr = res.result;
					const api = dr ? toApiDeployResult(dr) : undefined;
					if (api) setDeployDiagnosticsFromApiResult(group.projectDir, withSyntheticTestFailures(api));
					else await setDeployDiagnosticsFromFailure(group.projectDir, res.errorText, targetUser);
					record("Failed", dr ? statsFromResult(dr) : undefined);
					const failures = api ? componentFailuresOf(withSyntheticTestFailures(api)) : [];
					reportError({
						operation: "Deploy",
						error: res.errorText || (api ? JSON.stringify(api, null, 2) : "Deploy failed."),
						org: groupOrgLabel,
						reauthOrg: targetUser ?? undefined,
						failures,
						topError: api?.errorMessage ?? api?.stateDetail,
						handle: operationHandle,
						extraButton: { label: "Show Problems", onClick: showProblems },
					});
					return;
				}
				if (res.kind === "success") {
					deployed += res.result.numberComponentsDeployed ?? 0;
					record("Succeeded", statsFromResult(res.result));
				}
			} catch (e: any) {
				if (e?.cancelled) {
					record("Cancelled");
					operationHandle.dispose();
					return;
				}
				Telemetry.event("deployFile", { status: "failed" });
				record("Failed");
				reportError({ operation: "Deploy", error: e, org: groupOrgLabel, reauthOrg: targetUser ?? undefined, handle: operationHandle });
				return;
			}
		}
		for (const { group, org } of assignments) invalidateSchema(org.username, group.paths);
		Telemetry.event("deployFile", { status: "succeeded" });
		reportSuccess({
			operation: "Deploy",
			org: orgLabel,
			summary: deployed > 0 ? `Deployed ${deployed} components to ${orgLabel}.` : `Nothing to deploy to ${orgLabel} (no changes).`,
			handle: operationHandle,
		});
	});
}

export async function retrieveFromDefaultOrg(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
	const plan = prepare(uri, uris);
	if (!plan) return;
	const paths = allPaths(plan);

	const assignments = await resolveGroupOrgs(plan);
	const orgLabel = summarizeOrgs(assignments);

	if (!(await confirmMultiOrg(assignments, "retrieved from"))) return;
	if (!(await confirmOverwrite(paths, "Retrieve"))) return;

	const operationHandle = OperationPanelProvider.beginOperation("Retrieve", orgLabel);
	const title = `Retrieving ${paths.length} item(s) from ${orgLabel}…`;

	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
		try {
			let retrieved = 0;
			const failed: { fullName: string; error: string }[] = [];
			for (const { group, org } of assignments) {
				const res = await retrieveComponents({ org: org.username, sourcePaths: group.paths, projectDir: group.projectDir, token });
				retrieved += res.retrieved.length;
				failed.push(...res.failed);
			}
			await revertOpenEditors(paths);
			Telemetry.event("retrieveFile", { status: failed.length ? "partial" : "succeeded" });
			if (failed.length === 0) {
				reportSuccess({ operation: "Retrieve", org: orgLabel, summary: `Retrieved ${retrieved} components from ${orgLabel}.`, handle: operationHandle });
				return;
			}
			operationHandle.dispose();
			const lines = failed.map((f) => `${f.fullName}: ${f.error}`);
			DeployLog.line(`Retrieve had ${failed.length} failure(s):\n${lines.join("\n")}`);
			const listed = failed.slice(0, 3).map((f) => path.basename(f.fullName)).join(", ") + (failed.length > 3 ? ", …" : "");
			const pick = await vscode.window.showWarningMessage(
				`Retrieved ${retrieved} components from ${orgLabel}; ${failed.length} failed: ${listed}`,
				"Show details"
			);
			if (pick === "Show details") DeployLog.show();
		} catch (e: any) {
			if (e?.cancelled) {
				Logger.info("Retrieve cancelled by user.");
				Telemetry.event("retrieveFile", { status: "cancelled" });
				await revertOpenEditors(paths);
				operationHandle.dispose();
				return;
			}
			Telemetry.event("retrieveFile", { status: "failed" });
			reportError({ operation: "Retrieve", error: e, org: orgLabel, handle: operationHandle });
		}
	});
}

export async function updateProjectFromOrg(): Promise<void> {
	let projects = knownProjectDirs();
	if (projects.length === 0) {
		vscode.window.showErrorMessage("No SFDX project found in the workspace.");
		return;
	}
	if (projects.length > 1) {
		const picked = await vscode.window.showQuickPick(
			projects.map((p) => ({ label: path.basename(p), description: p, picked: true, dir: p })),
			{ canPickMany: true, placeHolder: "Projects to update from the org" }
		);
		if (!picked || picked.length === 0) return;
		projects = picked.map((p) => p.dir);
	}
	const candidates = projects
		.map((projectDir) => ({
			projectDir,
			paths: resolvePackageDirPaths(projectDir, getPackageDirectories(projectDir), (p) => fs.existsSync(p)),
		}))
		.filter((g) => g.paths.length > 0);
	if (candidates.length === 0) {
		vscode.window.showErrorMessage("No package directories found to update.");
		return;
	}
	// Each project updates from its OWN default org; projects without one are skipped.
	const all = await resolveGroupOrgs({ groups: candidates, skipped: [] });
	const noOrg = all.filter((a) => !a.org.username);
	const assignments = all.filter((a) => a.org.username);
	if (assignments.length === 0) {
		vscode.window.showErrorMessage("No default org set. Set a default org (ASFXT: Set as Default Org) and try again.");
		return;
	}
	if (noOrg.length > 0) {
		vscode.window.showWarningMessage(`Skipped (no default org): ${noOrg.map((a) => path.basename(a.group.projectDir)).join(", ")}`);
	}
	const groups = assignments.map((a) => a.group);
	const orgLabel = summarizeOrgs(assignments);
	const paths = groups.flatMap((g) => g.paths);
	const dirList = paths.map((p) => path.basename(p)).join(", ");

	const confirm = await vscode.window.showWarningMessage(
		spansMultipleOrgs(assignments) ? `Update projects from their own default orgs (${orgLabel})?` : `Update project from ${orgLabel}?`,
		{
			modal: true,
			detail:
				(spansMultipleOrgs(assignments)
					? assignments.map((a) => `${path.basename(a.group.projectDir)}: ${orgLabelOf(a.org)}`).join("\n") + "\n\n"
					: "") + `Every component in ${dirList} is retrieved and overwrites the local version. Components that only exist in the org are not added.`,
		},
		"Update"
	);
	if (confirm !== "Update") return;
	if (!(await confirmOverwrite(paths, "Update from org"))) return;

	const operationHandle = OperationPanelProvider.beginOperation("Retrieve", orgLabel);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Updating project from ${orgLabel}…`, cancellable: true },
		async (progress, token) => {
			try {
				let retrieved = 0;
				const failed: { fullName: string; error: string }[] = [];
				for (const { group, org } of assignments) {
					let last = 0;
					const res = await retrieveComponents({
						org: org.username,
						sourcePaths: group.paths,
						projectDir: group.projectDir,
						token,
						onProgress: (done, total) => {
							if (total > 0) progress.report({ increment: ((done - last) / total) * (100 / groups.length) });
							last = done;
						},
					});
					retrieved += res.retrieved.length;
					failed.push(...res.failed);
				}
				await revertOpenEditors(paths);
				Telemetry.event("updateProjectFromOrg", { status: failed.length ? "partial" : "succeeded" });
				const summary = buildUpdateSummary(orgLabel, retrieved, failed);
				if (failed.length === 0) {
					reportSuccess({ operation: "Retrieve", org: orgLabel, summary: summary.text, handle: operationHandle });
					return;
				}
				operationHandle.dispose();
				DeployLog.line(`Update from org had ${failed.length} failure(s):\n${failed.map((f) => `${f.fullName}: ${f.error}`).join("\n")}`);
				const pick = await vscode.window.showWarningMessage(summary.text, "Show details");
				if (pick === "Show details") DeployLog.show();
			} catch (e: any) {
				if (e?.cancelled) {
					Logger.info("Update from org cancelled by user.");
					Telemetry.event("updateProjectFromOrg", { status: "cancelled" });
					await revertOpenEditors(paths);
					operationHandle.dispose();
					return;
				}
				Telemetry.event("updateProjectFromOrg", { status: "failed" });
				reportError({ operation: "Retrieve", error: e, org: orgLabel, handle: operationHandle });
			}
		}
	);
}
