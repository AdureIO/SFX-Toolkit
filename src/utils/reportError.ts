import * as vscode from "vscode";
import { Logger, DeployLog } from "./outputChannel";
import { interpretError, toRawError } from "./errorInterpret";
import type { ApiComponentFailure } from "./deployDiagnostics";
import { ErrorPanelProvider } from "../providers/ErrorPanelProvider";

/**
 * The single way this extension reports a failed CLI/command operation.
 *
 * Every failure goes to the output log (unchanged, full payload) AND to the interpreted
 * Error panel, which shows the exact Salesforce/CLI message plus a plain-language category and
 * fix when we recognise it. Callers pass what they were doing and whatever they caught.
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
}

/** Report a failure: always log it, and surface it in the interpreted Error panel. */
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

    // The notification leads to the interpreted panel, never to the log. The log still has the
    // full payload and the panel shows the original alongside the interpretation, so sending
    // someone to raw output was offering the worse of the two views.
    if (opts.openPanel === false) {
        vscode.window.showErrorMessage(`${opts.operation} failed.`, "Show details").then((pick) => {
            if (pick === "Show details") ErrorPanelProvider.show(report, opts.org, opts.retry);
        });
        return;
    }

    ErrorPanelProvider.show(report, opts.org, opts.retry);
    // The panel is already open; the action brings it back if it was dismissed or is behind
    // other tabs.
    vscode.window.showErrorMessage(`${opts.operation} failed.`, "Show details").then((pick) => {
        if (pick === "Show details") ErrorPanelProvider.show(report, opts.org, opts.retry);
    });
}
