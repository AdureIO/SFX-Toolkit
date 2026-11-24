/**
 * Running a deploy / validation and reporting it, shared by the Deploy panel and the Deploy & Retrieve
 * Center: the `sf` run with live status (REST) and the CLI-streaming fallback, the cancellable progress
 * notification, then the toasts, the Operation panel and the Problems diagnostics. What surrounds it (which
 * components, the production confirm, the pre-deploy org check, the panel's own result message, the history
 * entries) stays with the caller.
 */
import * as vscode from "vscode";
import {
	DEPLOY_TIMEOUT_MS,
	buildDeployCommand,
	createDeployProgressHandler,
} from "../commands/deployMetadata";
import { cleanDeployOutput, parseCoverageData, parseDeployStats } from "../commands/devCommands";
import { runCommand } from "./commandRunner";
import {
	ApiDeployResult,
	clearDeployDiagnostics,
	componentFailuresOf,
	formatApiDeployResultForLog,
	setDeployDiagnosticsFromApiResult,
	setDeployDiagnosticsFromFailure,
	withSyntheticTestFailures,
} from "./deployDiagnostics";
import { runJsonDeploy } from "./deployEngine";
import {
	CoverageRow,
	DeployLiveStatus,
	DeployStats,
	coverageFromResult,
	formatElapsed,
	formatResultSummary,
	formatStatus,
	statsFromResult,
	toApiDeployResult,
} from "./deployStatusMap";
import { DeployLog, Logger } from "./outputChannel";
import { reportError, reportSuccess } from "./reportError";
import { OperationHandle, OperationPanelProvider } from "../providers/OperationPanelProvider";

/** The normalized result of one deploy / validation, whichever path ran it. */
export type DeployOutcome =
	| { kind: "cancelled" }
	| { kind: "success"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: ApiDeployResult; completedAt?: number; deployId?: string }
	| { kind: "failed"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: ApiDeployResult; errorText?: string; deployId?: string };

export interface DeployRunInput {
	/** Absolute files to deploy (never folders). */
	absPaths: string[];
	testLevel: string;
	/** Validated Apex test names (RunSpecifiedTests). */
	testFlags: string[];
	dryRun: boolean;
	/** The SFDX project directory (cwd of `sf`). */
	root: string;
	/** `--target-org` (alias or username); null = the CLI default. */
	targetOrg: string | null;
	/** Live numbers of the running deploy (the same snapshots the progress notification shows); the notification is unchanged. */
	onProgress?: (s: DeployLiveStatus) => void;
	/** Cancels the deploy like the notification's Cancel button (the server is told to stop; the outcome is `cancelled`). */
	cancelToken?: vscode.CancellationToken;
	/** Runs inside the progress notification: wrap it to track in-flight deploys. */
	track?: <T>(run: () => PromiseLike<T>) => Promise<T>;
}

export interface DeployRun {
	outcome: DeployOutcome;
	startedAt: number;
	durationMs: number;
	handle: OperationHandle;
}

/** Throws (with the reason) when the level or a test name is invalid: call before anything is shown as started. */
export function validateDeployInput(i: Pick<DeployRunInput, "absPaths" | "testLevel" | "testFlags" | "dryRun" | "root" | "targetOrg">): void {
	buildDeployCommand(i.absPaths, i.testLevel, i.testFlags, i.dryRun, i.root, i.targetOrg || undefined);
}

export function deployLabel(dryRun: boolean): string {
	return dryRun ? "Validation" : "Deploy";
}

/** Run the deploy under a cancellable progress notification. */
export async function runDeploy(i: DeployRunInput): Promise<DeployRun> {
	const { absPaths, testLevel, testFlags, dryRun, root, targetOrg } = i;
	const startedAt = Date.now();
	const liveStatus = vscode.workspace.getConfiguration("adure-sfx-toolkit").get<boolean>("deploy.liveStatus", true);
	const handle = OperationPanelProvider.beginOperation(deployLabel(dryRun), targetOrg || undefined);
	const track = i.track ?? (<T>(run: () => PromiseLike<T>) => Promise.resolve(run()));
	// One token for both Cancel buttons: the notification's and the caller's (the Center's right panel).
	const cts = new vscode.CancellationTokenSource();
	const callerSub = i.cancelToken?.onCancellationRequested(() => cts.cancel());
	if (i.cancelToken?.isCancellationRequested) cts.cancel();

	const outcome: DeployOutcome = await track(() =>
		vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: dryRun ? "Validating deployment…" : "Deploying", cancellable: true },
			async (progress, notificationToken): Promise<DeployOutcome> => {
				notificationToken.onCancellationRequested(() => cts.cancel());
				const token = cts.token;
				clearDeployDiagnostics();
				progress.report({ message: "Preparing…" });

				// CLI streaming fallback (original behavior), normalized to DeployOutcome.
				const runCliStreaming = async (): Promise<DeployOutcome> => {
					const cmd = buildDeployCommand(absPaths, testLevel, testFlags, dryRun, root, targetOrg || undefined);
					const progressHandler = createDeployProgressHandler((message) => progress.report({ message }), { onStatusFailed: () => progress.report({ message: "Status: Failed" }) });
					try {
						const result = await runCommand(cmd, root, progressHandler, false, token, DEPLOY_TIMEOUT_MS);
						DeployLog.line(`Deploy result (from CLI output):\n${cleanDeployOutput(result)}`);
						return { kind: "success", stats: parseDeployStats(result), coverage: parseCoverageData(result) };
					} catch (e: unknown) {
						const err = e as { cancelled?: boolean; message?: string };
						if (err.cancelled) return { kind: "cancelled" };
						const errorText = err.message ?? String(e);
						return { kind: "failed", stats: parseDeployStats(errorText), coverage: [], errorText };
					}
				};

				if (!liveStatus) return runCliStreaming();

				// Synchronous --json deploy (updates source tracking) + live REST status.
				const submitCmd = buildDeployCommand(absPaths, testLevel, testFlags, dryRun, root, targetOrg || undefined);
				try {
					const res = await runJsonDeploy({
						submitCommand: submitCmd,
						cwd: root,
						org: targetOrg,
						token,
						timeoutMs: DEPLOY_TIMEOUT_MS,
						onStatus: (s) => {
							progress.report({ message: formatStatus(s) });
							handle.updateLiveStatus(s);
							i.onProgress?.(s);
						},
					});
					if (res.kind === "cancelled") return { kind: "cancelled" };
					if (res.kind === "nothing") {
						return { kind: "success", stats: { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 }, coverage: [] };
					}
					if (res.kind === "failed") {
						const dr = res.result;
						return dr
							? { kind: "failed", stats: statsFromResult(dr), coverage: coverageFromResult(dr), apiResult: toApiDeployResult(dr), deployId: dr.id }
							: { kind: "failed", stats: { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 }, coverage: [], errorText: res.errorText };
					}
					const dr = res.result;
					// The org's own completion time (server clock), for the retrieve / deploy log when the org reports no newer lastModifiedDate.
					const completed = Date.parse(String((dr as { completedDate?: unknown }).completedDate ?? ""));
					return { kind: "success", stats: statsFromResult(dr), coverage: coverageFromResult(dr), apiResult: toApiDeployResult(dr), completedAt: Number.isNaN(completed) ? undefined : completed, deployId: dr.id };
				} catch (e: unknown) {
					// Unexpected engine error → fall back to the classic CLI streaming path.
					Logger.info(`Live deploy failed unexpectedly; falling back to CLI streaming: ${(e as { message?: string })?.message ?? String(e)}`);
					return runCliStreaming();
				}
			}
		)
	);
	callerSub?.dispose();
	cts.dispose();
	return { outcome, startedAt, durationMs: Date.now() - startedAt, handle };
}

export interface DeployReportInput {
	run: DeployRun;
	dryRun: boolean;
	root: string;
	targetOrg: string | null;
	/** What the operation is called in the toasts ("Delete"); default Deploy / Validation. */
	label?: string;
}

/** The toast, the Operation panel and (failure) the Problems diagnostics of a finished deploy. */
export function reportDeployOutcome(i: DeployReportInput): void {
	const { run, dryRun, root, targetOrg } = i;
	const { outcome, durationMs, handle } = run;
	const label = i.label ?? deployLabel(dryRun);
	if (outcome.kind === "cancelled") {
		void vscode.window.showInformationMessage(`${label} cancelled.`);
		handle.dispose();
		return;
	}
	if (outcome.kind === "success") {
		const { apiResult } = outcome;
		if (apiResult) DeployLog.line(formatApiDeployResultForLog(apiResult, `${label} succeeded (${formatElapsed(durationMs)}):`));
		const okSummary = apiResult ? formatResultSummary(apiResult) : "";
		reportSuccess({
			operation: label,
			org: targetOrg || undefined,
			summary: `${formatElapsed(durationMs)}${okSummary ? ` · ${okSummary}` : ""}`,
			apiResult,
			handle,
			message: `${label} completed in ${formatElapsed(durationMs)}${okSummary ? ` · ${okSummary}` : ""}.`,
		});
		return;
	}
	// Not auto-opening the Output log here — everything is still written to it (DeployLog.line calls), but
	// "Show details" on the toast should open the Operation panel, not steal focus to a different view.
	const { apiResult, errorText } = outcome;
	const failSummary = apiResult ? formatResultSummary(apiResult) : "";
	void vscode.window
		.withProgress({ location: vscode.ProgressLocation.Notification, title: "Parsing failure details…", cancellable: false }, async (p) => {
			p.report({ message: "Setting diagnostics…" });
			if (apiResult) {
				// Structured failures straight from the Metadata API → Problems. Fold in code coverage warnings and Apex
				// test failures — the API returns those in separate fields (details.runTestResult), not componentFailures,
				// so a deploy that fails ONLY on org-wide coverage would otherwise show nothing here at all.
				setDeployDiagnosticsFromApiResult(root, withSyntheticTestFailures(apiResult));
			} else {
				await setDeployDiagnosticsFromFailure(root, errorText ?? "", targetOrg);
			}
		})
		.then(() => {
			const failures = apiResult ? componentFailuresOf(withSyntheticTestFailures(apiResult)) : [];
			// "Show original error output" must be the actual unmodified payload, not a reformatted table and not the
			// synthetic failures merged in above.
			const raw = errorText || (apiResult ? JSON.stringify(apiResult, null, 2) : `${label} failed.`);
			// Salesforce sometimes reports Status: Failed with clean component/test counts and no errorMessage /
			// stateDetail at all — without a fallback the pretty card has nothing to show.
			const topError =
				apiResult?.errorMessage ??
				apiResult?.stateDetail ??
				(apiResult && failures.length === 0
					? `${label} failed, but the org reported no error message, component failures, or test failures. See the original output below.`
					: undefined);
			reportError({
				operation: label,
				error: raw,
				failures,
				topError,
				org: targetOrg || undefined,
				reauthOrg: targetOrg || undefined,
				handle,
				message: `${label} failed after ${formatElapsed(durationMs)}${failSummary ? ` · ${failSummary}` : ""}.`,
				extraButton: {
					label: "Show diagnostics",
					onClick: () => void vscode.commands.executeCommand("workbench.actions.view.problems"),
				},
			});
		});
}
