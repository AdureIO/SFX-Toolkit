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
import { Telemetry } from "../utils/telemetry";

const VALIDATE_TIMEOUT_MS = 5 * 60 * 1000;
/** Quiet period after a save before the on-save validation starts (coalesces save bursts). */
const ON_SAVE_DEBOUNCE_MS = 1500;
/** Generated / tooling folders (e.g. `.sfdx/tools/sobjects/**.cls` schema stubs) are never deployable. */
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;

/** Apex source that can be compiled by a check-only deploy (anonymous .apex cannot). */
export function isDeployableApex(uri: vscode.Uri): boolean {
	return /\.(cls|trigger)$/i.test(uri.fsPath) && !GENERATED_PATH.test(uri.fsPath);
}

/**
 * One in-flight validation per file: a newer request cancels the older `sf` process
 * instead of piling up concurrent dry-run deploys.
 */
const inFlight = new Map<string, vscode.CancellationTokenSource>();

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

	// Supersede any validation of this file that is still running.
	inFlight.get(filePath)?.cancel();
	const cts = new vscode.CancellationTokenSource();
	inFlight.set(filePath, cts);

	const title = `Validating ${document.uri.path.split("/").pop()} against ${org.displayName}…`;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title, cancellable: true },
		async (_progress, progressToken) => {
			const cancelSub = progressToken.onCancellationRequested(() => cts.cancel());
			const token = cts.token;
			const command = `sf project deploy start --dry-run -d ${escapeShellArg(filePath)}`;
			try {
				await runCommand(command, projectDir, undefined, false, token, VALIDATE_TIMEOUT_MS);
				if (token.isCancellationRequested) return; // superseded
				// Success — clear any prior validation diagnostics for a clean slate.
				clearDeployDiagnostics();
					Telemetry.event("validateApex", { status: "passed", trigger: silent ? "onSave" : "command" });
				if (!silent) vscode.window.showInformationMessage("Apex validation passed — no compile errors.");
			} catch (e: any) {
				if (e?.cancelled || token.isCancellationRequested) {
					Logger.info("Apex validation cancelled.");
					return;
				}
				Telemetry.event("validateApex", { status: "failed", trigger: silent ? "onSave" : "command" });
				const raw = e?.message || e?.stderr || "Unknown error";
				await setDeployDiagnosticsFromFailure(projectDir ?? "", raw, org.username ?? null);
				if (!silent) {
					vscode.window
						.showErrorMessage("Apex validation failed — see Problems.", "View Log")
						.then((sel) => {
							if (sel === "View Log") outputChannel.show();
						});
				}
			} finally {
				cancelSub.dispose();
				if (inFlight.get(filePath) === cts) inFlight.delete(filePath);
				cts.dispose();
			}
		}
	);
}

/**
 * Register the on-save trigger. Fires a check-only validation when
 * `apex.validateOnSave` is enabled and a deployable Apex file is saved.
 */
export function registerValidateOnSave(context: vscode.ExtensionContext): void {
	// Per-file debounce: rapid saves (format-on-save, save-all) start one validation.
	const timers = new Map<string, NodeJS.Timeout>();
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.uri.scheme !== "file" || !isDeployableApex(doc.uri)) return;
			const enabled = vscode.workspace
				.getConfiguration("adure-sfx-toolkit")
				.get<boolean>("apex.validateOnSave", false);
			if (!enabled || !isSalesforceProject()) return;
			const key = doc.uri.fsPath;
			const prev = timers.get(key);
			if (prev) clearTimeout(prev);
			timers.set(
				key,
				setTimeout(() => {
					timers.delete(key);
					void validateApexFile(doc, true);
				}, ON_SAVE_DEBOUNCE_MS)
			);
		}),
		{
			// Window close / project switch: drop pending runs and stop running `sf` processes.
			dispose: () => {
				for (const t of timers.values()) clearTimeout(t);
				timers.clear();
				for (const cts of inFlight.values()) cts.cancel();
				inFlight.clear();
			},
		}
	);
}
