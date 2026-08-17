import * as vscode from "vscode";
import { Logger, DeployLog } from "./outputChannel";
import { interpretError, toRawError } from "./errorInterpret";
import type { ApiComponentFailure, ApiDeployResult } from "./deployDiagnostics";
import { OperationPanelProvider, type OperationHandle } from "../providers/OperationPanelProvider";

/**
 * The single way this extension reports a failed CLI/command operation.
 *
 * Every failure goes to the output log (unchanged, full payload) AND to the interpreted
 * Operation panel, which shows the exact Salesforce/CLI message plus a plain-language category
 * and fix when we recognise it. Callers pass what they were doing and whatever they caught.
 */
export interface ReportErrorOptions {
    /** What was being attempted, e.g. "Push", "Create scratch org". Drives the panel title. */
    operation: string;
    /** Anything caught: an Error, a CLI `--json` payload, or plain text. */
    error: unknown;
    /** Org label shown in the panel header. */
    org?: string;
    /** Structured Metadata API component failures, when the operation has them. */
    failures?: ApiComponentFailure[];
    /** Top-level message when it's known separately from `error`. */
    topError?: string;
    /** Offer a "Retry" button that re-runs the operation. */
    retry?: () => void;
    /** Show the panel immediately (default). When false, only a toast + log; the user opts in. */
    openPanel?: boolean;
    /** An in-flight handle from OperationPanelProvider.beginOperation() — reuses that panel
     * instance (already open, possibly showing live status) instead of opening a fresh one. */
    handle?: OperationHandle;
    /** One extra action button alongside "Show details" on the failure toast (e.g. "Show diagnostics" → Problems view). */
    extraButton?: { label: string; onClick: () => void };
    /** Override the toast text (default: "${operation} failed."), e.g. to include duration/summary. */
    message?: string;
}

/** Report a failure: always log it, and surface it in the interpreted Operation panel. */
export function reportError(opts: ReportErrorOptions): void {
    const raw = opts.topError?.trim() || toRawError(opts.error);
    const report = interpretError({
        operation: opts.operation,
        failures: opts.failures,
        topError: opts.topError,
        raw
    });

    // Always write the full payload to the log — the panel never replaces the record.
    Logger.error(`${opts.operation} failed`, opts.error);
    DeployLog.line(`${opts.operation} failed:\n${raw}`);

    const finalize = () => {
        if (opts.handle) opts.handle.fail(report, opts.retry);
        else OperationPanelProvider.show(report, opts.org, opts.retry);
    };
    const revealExisting = () => {
        // finalize() already set the panel's pending state (via handle.fail() or
        // OperationPanelProvider.show()) without opening it — this is the explicit user action
        // ("Show details") that actually creates/reveals the tab.
        if (opts.handle) opts.handle.reveal();
        else OperationPanelProvider.revealCurrent();
    };

    const toastMessage = opts.message ?? `${opts.operation} failed.`;
    const buttons = opts.extraButton ? ["Show details", opts.extraButton.label] : ["Show details"];
    const handlePick = (pick: string | undefined) => {
        if (pick === "Show details") revealExisting();
        else if (pick && pick === opts.extraButton?.label) opts.extraButton.onClick();
    };

    // The notification leads to the interpreted panel, never to the log. The log still has the
    // full payload and the panel shows the original alongside the interpretation, so sending
    // someone to raw output was offering the worse of the two views.
    if (opts.openPanel === false) {
        finalize();
        vscode.window.showErrorMessage(toastMessage, ...buttons).then(handlePick);
        return;
    }

    finalize();
    // The panel is already open; the action brings it back if it was dismissed or is behind
    // other tabs.
    vscode.window.showErrorMessage(toastMessage, ...buttons).then(handlePick);
}

export interface ReportSuccessOptions {
    /** What completed, e.g. "Push", "Deploy". Drives the panel title. */
    operation: string;
    /** Org label shown in the panel header. */
    org?: string;
    /** Plain-text result summary shown in the panel and the completion toast. */
    summary?: string;
    /** Optional structured result, when the operation has one — counts plus
     * details.componentSuccesses for the panel's deployed-components table. */
    apiResult?: ApiDeployResult;
    /** An in-flight handle from OperationPanelProvider.beginOperation(). If omitted, a fresh
     * panel is opened directly into the succeeded state (for operations with no live phase). */
    handle?: OperationHandle;
    /** Override the toast text (default: "${operation} completed · ${summary}"). */
    message?: string;
}

/** Report a success: log it, finalize the Operation panel, and offer "Show details" on the toast. */
export function reportSuccess(opts: ReportSuccessOptions): void {
    DeployLog.line(`${opts.operation} succeeded${opts.summary ? `: ${opts.summary}` : ""}.`);

    const handle = opts.handle ?? OperationPanelProvider.beginOperation(opts.operation, opts.org);
    handle.succeed(opts.summary ?? "", opts.apiResult);

    const toastMessage = opts.message ?? `${opts.operation} completed${opts.summary ? ` · ${opts.summary}` : ""}.`;
    vscode.window.showInformationMessage(toastMessage, "Show details").then((pick) => {
        if (pick === "Show details") handle.reveal();
    });
}
