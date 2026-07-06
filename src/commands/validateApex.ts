/**
 * Tier 3 — authoritative Apex validation via a check-only (dry-run) deploy.
 *
 * Runs `sf project deploy start --dry-run -d <file>`, which compiles the file
 * against the org WITHOUT saving, and surfaces any compiler errors in the Problems
 * view (reusing the deploy-diagnostics parser). This catches everything the offline
 * Tier 1 pass cannot — type errors, method resolution, references to other classes —
 * at the cost of an org round-trip, so it is opt-in (manual command, or on-save when
 * `adure-sfx-toolkit.apex.validateOnSave` is enabled).
 */
import * as vscode from "vscode";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import { findSfdxProjectDir, isSalesforceProject } from "../utils/projectUtils";
import { clearDeployDiagnostics, setDeployDiagnosticsFromFailure } from "../utils/deployDiagnostics";
import { getDefaultOrg, getDefaultOrgSync } from "../utils/defaultOrg";
import { Logger, outputChannel } from "../utils/outputChannel";

const VALIDATE_TIMEOUT_MS = 5 * 60 * 1000;

/** Apex source that can be compiled by a check-only deploy (anonymous .apex cannot). */
export function isDeployableApex(uri: vscode.Uri): boolean {
	return /\.(cls|trigger)$/i.test(uri.fsPath);
}

/**
 * Validate a single Apex file against the default org (check-only). `silent` skips
 * user-facing info/error toasts (used by the on-save trigger); diagnostics still post.
 */
export async function validateApexFile(doc?: vscode.TextDocument, silent = false): Promise<void> {
	const document = doc ?? vscode.window.activeTextEditor?.document;
	if (!document) {
		if (!silent) vscode.window.showErrorMessage("Validate Apex: no active file.");
		return;
	}
	if (!isDeployableApex(document.uri)) {
		if (!silent) vscode.window.showErrorMessage("Validate Apex: open a .cls or .trigger file.");
		return;
	}
	if (!isSalesforceProject()) return;

	const filePath = document.uri.fsPath;
	const projectDir = findSfdxProjectDir(filePath) ?? undefined;

	const org = getDefaultOrgSync() ?? (await getDefaultOrg());
	if (!org) {
		if (!silent) vscode.window.showErrorMessage("Validate Apex: no default org set.");
		return;
	}

	if (!silent) await document.save();

	const title = `Validating ${document.uri.path.split("/").pop()} against ${org.displayName}…`;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title, cancellable: true },
		async (_progress, token) => {
			const command = `sf project deploy start --dry-run -d ${escapeShellArg(filePath)}`;
			try {
				await runCommand(command, projectDir, undefined, false, token, VALIDATE_TIMEOUT_MS);
				// Success — clear any prior validation diagnostics for a clean slate.
				clearDeployDiagnostics();
				if (!silent) vscode.window.showInformationMessage("Apex validation passed — no compile errors.");
			} catch (e: any) {
				if (e?.cancelled) {
					Logger.info("Apex validation cancelled.");
					return;
				}
				const raw = e?.message || e?.stderr || "Unknown error";
				await setDeployDiagnosticsFromFailure(projectDir ?? "", raw, org.username ?? null);
				if (!silent) {
					vscode.window
						.showErrorMessage("Apex validation failed — see Problems.", "View Log")
						.then((sel) => {
							if (sel === "View Log") outputChannel.show();
						});
				}
			}
		}
	);
}

/**
 * Register the on-save trigger. Fires a check-only validation when
 * `apex.validateOnSave` is enabled and a deployable Apex file is saved.
 */
export function registerValidateOnSave(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			const enabled = vscode.workspace
				.getConfiguration("adure-sfx-toolkit")
				.get<boolean>("apex.validateOnSave", false);
			if (!enabled || !isSalesforceProject() || !isDeployableApex(doc.uri)) return;
			void validateApexFile(doc, true);
		})
	);
}
