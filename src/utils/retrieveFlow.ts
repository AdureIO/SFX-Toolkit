/**
 * The retrieve flow of the panels (Org Browser, Deploy & Retrieve Metadata): confirm what would be
 * overwritten, retrieve with a cancellable progress notification, refresh the open editors, record the
 * history entry and tell the user. Everything else (which components, what to refresh) is the caller's.
 */
import * as vscode from "vscode";
import { Logger } from "./outputChannel";
import { confirmOverwrite, revertOpenEditors } from "./retrieveSafety";
import { retrieveComponents, RetrieveResult } from "./retrieveEngine";
import { recordHistory } from "./syncHistory";
import { HistorySource, historyErrorsFromRetrieve } from "./historyPure";
import { compKey } from "./orgBrowser/types";

export interface RetrieveFlowOptions {
	projectDir: string;
	/** `--target-org` (alias or username); null = the CLI default. */
	org: string | null;
	/** What the progress title and the history call the org. */
	orgLabel: string;
	/** What is recorded as the history's org when `org` is null. */
	historyOrg: string;
	components: { type: string; fullName: string }[];
	/** Absolute paths the retrieve would overwrite (`overwriteTargets` of the local entries). */
	targets: string[];
	/** Ask before overwriting local changes (default true). */
	confirm?: boolean;
	source: HistorySource;
	/** History label (e.g. "Retrieve project"). */
	label?: string;
	/** Runs after the open editors were refreshed, also when the retrieve failed or was cancelled (rescan the project). */
	afterWrite?: () => Promise<void>;
	/** Components retrieved so far (the same numbers the progress notification shows); the notification is unchanged. */
	onProgress?: (done: number, total: number) => void;
	/** The retrieve is about to run (the overwrite confirmation, when asked, was accepted). */
	onStart?: () => void;
}

export interface RetrieveFlowResult {
	/** Not run, or cancelled, or the CLI could not be run: nothing to show. */
	cancelled: boolean;
	outcome?: RetrieveResult;
}

export async function runRetrieveFlow(o: RetrieveFlowOptions): Promise<RetrieveFlowResult> {
	const { components } = o;
	if (o.confirm !== false && !(await confirmOverwrite(o.targets, "Retrieve"))) return { cancelled: true };
	o.onStart?.();
	let outcome: RetrieveResult | undefined;
	let cancelled = false;
	const startedAt = Date.now();
	await vscode.window
		.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Retrieving ${components.length} component${components.length === 1 ? "" : "s"} from ${o.orgLabel}…`, cancellable: true },
			async (progress, token) => {
				let reported = 0;
				try {
					outcome = await retrieveComponents({
						org: o.org,
						components,
						projectDir: o.projectDir,
						token,
						onProgress: (done, total) => {
							progress.report({ message: `${done}/${total}`, increment: ((done - reported) / total) * 100 });
							reported = done;
							o.onProgress?.(done, total);
						},
					});
				} catch (e: any) {
					if (e?.cancelled) cancelled = true;
					else throw e;
				}
			}
		)
		.then(undefined, (e) => {
			Logger.error("Retrieve failed", e);
			vscode.window.showErrorMessage(`Retrieve failed: ${e?.message ?? e}`);
			cancelled = true;
		});
	await revertOpenEditors(o.targets);
	await o.afterWrite?.();
	if (cancelled || !outcome) {
		if (cancelled) vscode.window.setStatusBarMessage("Retrieve cancelled", 3000);
		return { cancelled: true };
	}
	recordHistory(o.projectDir, {
		kind: "retrieve",
		org: o.org ?? o.historyOrg,
		at: startedAt,
		durationMs: Date.now() - startedAt,
		components: components.map((c) => compKey(c.type, c.fullName)),
		ok: outcome.failed.length === 0,
		errors: outcome.failed.length > 0 ? historyErrorsFromRetrieve(outcome.failed) : undefined,
		source: o.source,
		...(o.label ? { label: o.label } : {}),
	});
	const ok = outcome.retrieved.length;
	const bad = outcome.failed.length;
	for (const f of outcome.failed) Logger.info(`Retrieve failed: ${f.type}:${f.fullName} — ${f.error}`);
	const text = bad > 0 ? `Retrieved ${ok}, ${bad} failed` : `Retrieved ${ok} component${ok === 1 ? "" : "s"}`;
	if (bad > 0) {
		void vscode.window.showWarningMessage(text, "Show Output").then((pick) => {
			if (pick) void vscode.commands.executeCommand("adure-sfx-toolkit.showOutput");
		});
	} else {
		void vscode.window.showInformationMessage(text);
	}
	return { cancelled: false, outcome };
}
