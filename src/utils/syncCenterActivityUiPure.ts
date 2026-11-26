/**
 * Deploy & Retrieve Metadata: what the right panel's operation card and the Activity → Deploys list show (pure, no
 * `vscode`, no DOM): phase and progress texts, elapsed / relative times, row summaries. The data comes from
 * `syncCenterOpPure` (`OpMessage`) and `deployListPure` (`DeployListItem`, `DeployDetails`).
 */
import type { DeployDetails, DeployListCounts, DeployListItem } from "./deployListPure";
import type { OpKind, OpMessage, OpPhase } from "./syncCenterOpPure";
import { relativeTime } from "./orgBrowser/filter";

const KIND_LABELS: Record<OpKind, string> = { deploy: "Deploy", validate: "Validate", retrieve: "Retrieve", delete: "Delete" };
export const OP_KIND_GLYPH: Record<OpKind, string> = { deploy: "↑", validate: "✓", retrieve: "↓", delete: "✕" };
const PHASE_LABELS: Record<OpPhase, string> = { queued: "Queued", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };

export function kindLabel(kind: string): string {
	return KIND_LABELS[kind as OpKind] ?? kind;
}

export function phaseLabel(phase: OpPhase): string {
	return PHASE_LABELS[phase] ?? phase;
}

export function isActivePhase(phase: OpPhase): boolean {
	return phase === "queued" || phase === "running";
}

/** The Cancel button: deploy, validate and delete only (a retrieve cannot be cancelled), while queued or running. */
export function canCancelOp(op: Pick<OpMessage, "kind" | "phase">): boolean {
	return isActivePhase(op.phase) && op.kind !== "retrieve";
}

/** `Deploy`, or `Deploy · Sprint 42 hotfix`. */
export function opTitle(op: Pick<OpMessage, "kind" | "label">): string {
	const l = op.label?.trim();
	return l ? `${kindLabel(op.kind)} · ${l}` : kindLabel(op.kind);
}

/** `42 s`, `3 m 05 s`, `1 h 02 m`. Whole seconds (the card ticks once a second). */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
	return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`;
}

/** The op's elapsed time: until `endedAt` when it has finished, else until `now`. */
export function opElapsedText(op: Pick<OpMessage, "startedAt" | "endedAt">, now: number): string {
	return formatDuration((op.endedAt ?? now) - op.startedAt);
}

/** Share done of the total, 0–100 (a total of 0 = 0). */
export function progressPercent(c: Pick<DeployListCounts, "done" | "total"> | undefined): number {
	if (!c || c.total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((c.done / c.total) * 100)));
}

/** Share of the bar that is errors, 0–100 (drawn red at the end of the done part). */
export function errorPercent(c: Pick<DeployListCounts, "total" | "errors"> | undefined): number {
	if (!c || c.total <= 0) return 0;
	return Math.max(0, Math.min(100, Math.round((c.errors / c.total) * 100)));
}

/** `3/10`, `3/10 · 2 errors`. */
export function countsText(c: DeployListCounts | undefined, errorWord = "error"): string {
	if (!c || (c.total <= 0 && c.errors <= 0)) return "";
	const n = c.errors;
	return `${c.done.toLocaleString("en-US")}/${c.total.toLocaleString("en-US")}${n > 0 ? ` · ${n} ${errorWord}${n === 1 ? "" : "s"}` : ""}`;
}

/** What the card shows for the Details / Open in Setup buttons of a finished op. */
export function opActions(op: Pick<OpMessage, "kind" | "phase" | "deployId">): { details: boolean; setup: boolean } {
	const finished = !isActivePhase(op.phase);
	return { details: finished && !!op.deployId, setup: !!op.deployId && op.kind !== "retrieve" };
}

/** Is a state change one after which the deploy list should be reloaded (an op has just finished)? */
export function opJustFinished(prev: Pick<OpMessage, "phase"> | undefined, next: Pick<OpMessage, "phase">): boolean {
	return isActivePhase(prev?.phase ?? "queued") && !isActivePhase(next.phase) && prev !== undefined;
}

// ── Deploys list ────────────────────────────────────────────────────────────────

export interface DeployRowView {
	id: string;
	deployId?: string;
	/** `ok`, `bad` or `run`. */
	state: "ok" | "bad" | "run";
	icon: string;
	statusText: string;
	title: string;
	kindLabel: string;
	createdBy: string;
	when: string;
	whenExact: string;
	duration: string;
	componentsText: string;
	testsText: string;
	sourceLabel: string;
	canSetup: boolean;
	canSelect: boolean;
	/** The org knows this deploy: its details can be fetched. */
	hasDetails: boolean;
}

const STATUS_TEXT: Record<string, string> = { Succeeded: "Succeeded", SucceededPartial: "Partially succeeded", Failed: "Failed", Canceled: "Canceled", Canceling: "Canceling", InProgress: "In progress", Pending: "Queued" };

export function deployStatusText(status: string): string {
	return STATUS_TEXT[status] ?? status;
}

export function deployRowView(i: DeployListItem, now: number): DeployRowView {
	const state = i.ok === true ? "ok" : i.ok === false ? "bad" : "run";
	const kind = kindLabel(i.kind);
	return {
		id: i.id,
		...(i.deployId ? { deployId: i.deployId } : {}),
		state,
		icon: state === "ok" ? "✓" : state === "bad" ? "✕" : "…",
		statusText: deployStatusText(i.status),
		title: i.label?.trim() || kind,
		kindLabel: kind,
		createdBy: i.createdBy ?? "",
		when: i.startedAt > 0 ? relativeTime(i.startedAt, now) : "",
		whenExact: i.startedAt > 0 ? new Date(i.startedAt).toLocaleString() : "",
		duration: i.durationMs !== undefined ? formatDuration(i.durationMs) : "",
		componentsText: countsText(i.components),
		testsText: countsText(i.tests, "failure"),
		sourceLabel: i.source,
		canSetup: !!i.deployId && i.kind !== "retrieve",
		canSelect: !!i.componentKeys && i.componentKeys.length > 0,
		hasDetails: !!i.deployId,
	};
}

/** `Class.method` (either part may be missing). */
export function testErrorName(t: DeployDetails["testErrors"][number]): string {
	return [t.className, t.methodName].filter(Boolean).join(".") || "Test";
}

/** `Type Name` and `line:col` of a component error. */
export function componentErrorWhere(e: DeployDetails["componentErrors"][number]): { who: string; loc: string } {
	const who = [e.type, e.name || e.fileName].filter(Boolean).join(" ");
	const loc = e.line ? `${e.line}${e.column ? `:${e.column}` : ""}` : "";
	return { who, loc };
}

export function detailsAreEmpty(d: DeployDetails): boolean {
	return d.componentErrors.length === 0 && d.testErrors.length === 0 && (d.codeCoverageWarnings?.length ?? 0) === 0;
}
