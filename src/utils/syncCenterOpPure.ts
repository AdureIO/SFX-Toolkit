/**
 * Live operation state of the Deploy & Retrieve Metadata's right panel (pure, no `vscode`): the `op` message the
 * webview renders and how the engine's live deploy status and a finished outcome map onto it. The host wiring is `providers/syncCenterActivityHost.ts`.
 */
import type { DeployLiveStatus } from "./deployStatusMap";
import { historyErrorsFromDeploy, historyErrorsFromRetrieve, type HistoryError } from "./historyPure";
import type { ApiDeployResult } from "./deployDiagnostics";

export type OpKind = "deploy" | "validate" | "retrieve" | "delete";
export type OpPhase = "queued" | "running" | "done" | "failed" | "cancelled";

export interface OpCounts {
	done: number;
	total: number;
	errors: number;
}

/** One failure of an operation as the card lists it: "Type Name — message". Without a component only the message is set. */
export interface OpFailure {
	type?: string;
	name?: string;
	message: string;
}

/** The card's failure list from history-style errors (`Type:fullName` component + message). */
export function failuresFromErrors(errors: readonly HistoryError[]): OpFailure[] {
	return errors.map((e) => {
		const c = e.component ?? "";
		const i = c.indexOf(":");
		const message = e.message.replace(/\s+/g, " ").trim() || "Failed";
		return i > 0 ? { type: c.slice(0, i), name: c.slice(i + 1), message } : { ...(c ? { name: c } : {}), message };
	});
}

/** The failures of a retrieve: its failed components. */
export function failuresOfRetrieve(failed: readonly { type: string; fullName: string; error: string }[]): OpFailure[] {
	return failuresFromErrors(historyErrorsFromRetrieve(failed));
}

/** The failures of a deploy / validate / delete: the component failures and failing tests, else the CLI's error text. */
export function failuresOfDeploy(api: ApiDeployResult | undefined, errorText?: string): OpFailure[] {
	return failuresFromErrors(historyErrorsFromDeploy(api, errorText));
}

/** The summary line of a finished retrieve. Counts components (a whole object returns each of its fields … as one), not files. */
export function retrieveSummary(requested: number, retrieved: number, failed: number): string {
	const n = (c: number) => `${c} component${c === 1 ? "" : "s"}`;
	const from = retrieved !== requested ? ` (${requested} requested; an object returns its fields, record types … too)` : "";
	return failed > 0 ? `Retrieved ${n(retrieved)}${from}, ${failed} failed` : `Retrieved ${n(retrieved)}${from}`;
}

/** Host → webview: one operation started from the Center (sent again on every change). */
export interface OpMessage {
	type: "op";
	id: string;
	kind: OpKind;
	phase: OpPhase;
	label?: string;
	/** The org's deploy id (`0Af…`) once known (deploy, validate, delete). */
	deployId?: string;
	components?: OpCounts;
	tests?: OpCounts;
	message?: string;
	/** Why it failed, per component (a failed or partly failed op). At most 50. */
	failures?: OpFailure[];
	startedAt: number;
	endedAt?: number;
}

export function newOp(kind: OpKind, id: string, label: string | undefined, now: number, phase: OpPhase = "queued"): OpMessage {
	return { type: "op", id, kind, phase, ...(label ? { label } : {}), startedAt: now };
}

/** Tests processed so far: the engine's own convention (`formatStatus`): completed + failed, never more than the total. */
export function testsDone(completed: number, errors: number, total: number): number {
	return Math.min(total, completed + errors);
}

/** What a live status snapshot says about a running operation. The final phase comes from the outcome, never from here. */
export function progressOfLive(s: DeployLiveStatus): Pick<OpMessage, "phase" | "components" | "tests" | "message"> {
	const inTests = s.testsTotal > 0 && s.testsCompleted + s.testErrors < s.testsTotal;
	const detail = s.stateDetail ? s.stateDetail.replace(/\s+/g, " ").trim().slice(0, 120) : "";
	let phase: OpPhase = "running";
	let message: string | undefined;
	if (s.status === "Pending") {
		phase = "queued";
		message = detail || "Waiting in the org's deploy queue";
	} else if (s.status === "Canceling") {
		message = "Canceling…";
	} else if (inTests) {
		message = detail || "Running tests";
	} else if (s.status === "InProgress") {
		message = detail || "Deploying components";
	} else if (detail) {
		message = detail;
	}
	return {
		phase,
		...(s.componentsTotal > 0 || s.componentErrors > 0 ? { components: { done: s.componentsDeployed, total: s.componentsTotal, errors: s.componentErrors } } : {}),
		...(s.testsTotal > 0 ? { tests: { done: testsDone(s.testsCompleted, s.testErrors, s.testsTotal), total: s.testsTotal, errors: s.testErrors } } : {}),
		...(message ? { message } : {}),
	};
}

/** The op with a live snapshot applied (never moves a finished op back to running). */
export function applyLive(op: OpMessage, s: DeployLiveStatus): OpMessage {
	if (isFinished(op.phase)) return op;
	const p = progressOfLive(s);
	const next: OpMessage = { ...op, phase: p.phase };
	if (p.components) next.components = p.components;
	if (p.tests) next.tests = p.tests;
	if (p.message) next.message = p.message;
	else delete next.message;
	return next;
}

/** A retrieve's progress (`done` of `total` components). */
export function applyRetrieveProgress(op: OpMessage, done: number, total: number): OpMessage {
	if (isFinished(op.phase)) return op;
	return { ...op, phase: "running", components: { done, total, errors: 0 }, message: `Retrieving ${done}/${total}` };
}

export function isFinished(p: OpPhase): boolean {
	return p === "done" || p === "failed" || p === "cancelled";
}

/** Same on the wire apart from the timestamps: the engine ticks every 100 ms, the webview needs a message only on a change. */
export function sameOpState(a: OpMessage | undefined, b: OpMessage): boolean {
	if (!a) return false;
	const c = (x?: OpCounts) => (x ? `${x.done}/${x.total}/${x.errors}` : "");
	return a.phase === b.phase && a.message === b.message && a.deployId === b.deployId && a.label === b.label && c(a.components) === c(b.components) && c(a.tests) === c(b.tests);
}

/** What a finished deploy / validate / delete looks like (structural subset of `DeployOutcome` / `DeleteOutcome`). */
export interface OutcomeLike {
	kind: "cancelled" | "success" | "failed";
	stats?: { components: number; componentErrors: number; testsPassed: number; testsFailed: number };
	deployId?: string;
	errorText?: string;
	apiResult?: ApiDeployResult;
}

const oneLine = (t: string, max = 300) => t.replace(/\s+/g, " ").trim().slice(0, max);

/** The op settled by a finished deploy / validate / delete. A success that a validate/deploy reports with errors stays "done". */
export function settleOp(op: OpMessage, outcome: OutcomeLike, now: number): OpMessage {
	const next: OpMessage = { ...op, endedAt: now };
	if (outcome.deployId) next.deployId = outcome.deployId;
	const st = outcome.stats;
	if (st && !next.components && st.components + st.componentErrors > 0) next.components = { done: st.components, total: st.components + st.componentErrors, errors: st.componentErrors };
	if (st && !next.tests && st.testsPassed + st.testsFailed > 0) next.tests = { done: st.testsPassed + st.testsFailed, total: st.testsPassed + st.testsFailed, errors: st.testsFailed };
	if (outcome.kind !== "cancelled") {
		const f = failuresOfDeploy(outcome.apiResult, outcome.errorText);
		if (f.length > 0 && (outcome.kind === "failed" || (st?.componentErrors ?? 0) + (st?.testsFailed ?? 0) > 0)) next.failures = f;
	}
	if (outcome.kind === "cancelled") {
		next.phase = "cancelled";
		next.message = "Cancelled";
	} else if (outcome.kind === "success") {
		next.phase = "done";
		delete next.message;
		// The last live snapshot may stop short of the end: a finished deploy has processed everything.
		if (next.components && next.components.total > 0) next.components = { ...next.components, done: next.components.total - next.components.errors };
		if (next.tests) next.tests = { ...next.tests, done: next.tests.total };
	} else {
		next.phase = "failed";
		const why = outcome.apiResult?.errorMessage || outcome.apiResult?.stateDetail || outcome.errorText;
		const errs = next.components?.errors ?? st?.componentErrors ?? 0;
		const terrs = next.tests?.errors ?? st?.testsFailed ?? 0;
		next.message = why ? oneLine(why) : errs + terrs > 0 ? [errs ? `${errs} component error${errs === 1 ? "" : "s"}` : "", terrs ? `${terrs} test failure${terrs === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ") : "Failed";
	}
	return next;
}

/** The op settled by something that is not a deploy outcome (a retrieve, an error thrown before the run, a cancelled confirmation). */
export function settleSimple(op: OpMessage, phase: "done" | "failed" | "cancelled", message: string | undefined, now: number, failures?: OpFailure[]): OpMessage {
	const next: OpMessage = { ...op, phase, endedAt: now };
	if (failures && failures.length > 0) next.failures = failures;
	if (message) next.message = oneLine(message);
	else delete next.message;
	return next;
}

/** How many failures the card shows before "Show all". */
export const OP_FAILURES_SHOWN = 5;

/** The failures the card lists: the first few, or all when expanded; `more` = how many are hidden. */
export function visibleFailures(failures: readonly OpFailure[] | undefined, expanded: boolean): { shown: OpFailure[]; more: number } {
	const all = failures ?? [];
	return expanded || all.length <= OP_FAILURES_SHOWN ? { shown: [...all], more: 0 } : { shown: all.slice(0, OP_FAILURES_SHOWN), more: all.length - OP_FAILURES_SHOWN };
}

/** `Type Name — message` (a failure without a component: the message alone). */
export function failureLine(f: OpFailure): string {
	const who = [f.type, f.name].filter(Boolean).join(" ");
	return who ? `${who} — ${f.message}` : f.message;
}
