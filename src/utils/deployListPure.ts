/**
 * Recent deploys of an org for the Deploy & Retrieve Metadata's activity list (pure, no `vscode`, no I/O):
 *   - the Tooling API query on `DeployRequest` and the parse of its answer,
 *   - the details of one deploy (component failures, test failures) from a `deployResult`,
 *   - the merge of the org's deploys with this toolkit's own history, newest first.
 * The HTTP calls are in `providers/syncCenterActivityHost.ts`.
 */
import type { HistoryEntry, HistoryKind } from "./historyPure";
import type { RawDeployResult } from "./deployStatusMap";
import { testsDone } from "./syncCenterOpPure";

// ── Types of the webview contract ──────────────────────────────────────────────

export interface DeployListCounts {
	done: number;
	total: number;
	errors: number;
}

/** One row of the activity list (`{type:"deploys", items}`). */
export interface DeployListItem {
	/** The org's deploy id (`0Af…`) when there is one, else the local history id. */
	id: string;
	deployId?: string;
	kind: HistoryKind;
	/** The org's status (`Succeeded`, `Failed`, `InProgress` …); local-only entries: `Succeeded` / `Failed`. */
	status: string;
	/** true = succeeded, false = failed / partially succeeded / cancelled, null = still pending or running. */
	ok: boolean | null;
	/** What the Center calls the org (alias or username). */
	org: string;
	label?: string;
	createdBy?: string;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	components?: DeployListCounts;
	tests?: DeployListCounts;
	source: "org" | "local" | "both";
	componentKeys?: string[];
}

export interface DeployDetails {
	componentErrors: { type?: string; name?: string; fileName?: string; line?: number; column?: number; message: string }[];
	testErrors: { className?: string; methodName?: string; message: string; stackTrace?: string }[];
	codeCoverageWarnings?: string[];
}

// ── DeployRequest (Tooling API) ────────────────────────────────────────────────

/** Number of deploys listed. */
export const DEPLOY_LIST_LIMIT = 20;

/** Statuses `failedOnly` asks for: a deploy that did not succeed. */
export const FAILED_STATUSES = ["Failed", "SucceededPartial", "Canceled"] as const;

const BASE_FIELDS = [
	"Id",
	"Status",
	"StartDate",
	"CompletedDate",
	"CreatedDate",
	"CreatedBy.Name",
	"CheckOnly",
	"NumberComponentsDeployed",
	"NumberComponentsTotal",
	"NumberComponentErrors",
	"NumberTestsCompleted",
	"NumberTestsTotal",
	"NumberTestErrors",
];
/** Fields the first query adds; `basic` leaves them out (a version of the object without them still answers). */
const EXTRA_FIELDS = ["ErrorMessage", "StateDetail", "TestLevel", "ChangeSetName"];

/**
 * The SOQL for the Tooling API (`/tooling/query`). `StartDate` is null while a deploy waits in the queue: NULLS FIRST
 * keeps those on top instead of past the limit.
 */
export function deployRequestQuery(opts: { failedOnly?: boolean; level?: "full" | "basic"; limit?: number } = {}): string {
	const fields = opts.level === "basic" ? BASE_FIELDS : [...BASE_FIELDS, ...EXTRA_FIELDS];
	const where = opts.failedOnly ? ` WHERE Status IN (${FAILED_STATUSES.map((s) => `'${s}'`).join(", ")})` : "";
	return `SELECT ${fields.join(", ")} FROM DeployRequest${where} ORDER BY StartDate DESC NULLS FIRST LIMIT ${opts.limit ?? DEPLOY_LIST_LIMIT}`;
}

/** A deploy as the org reports it. */
export interface OrgDeployRow {
	id: string;
	status: string;
	checkOnly: boolean;
	createdBy?: string;
	startedAt: number;
	completedAt?: number;
	components: DeployListCounts;
	tests: DeployListCounts;
	testLevel?: string;
	changeSetName?: string;
	errorMessage?: string;
	stateDetail?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const ms = (v: unknown): number | undefined => {
	const s = str(v);
	if (!s) return undefined;
	const t = Date.parse(s);
	return Number.isNaN(t) ? undefined : t;
};

/** The deploys of a Tooling API query answer (`{ records: [...] }`). Rows without an id are dropped; never throws. */
export function parseDeployRequests(json: unknown): OrgDeployRow[] {
	const records = (json as { records?: unknown } | null | undefined)?.records;
	if (!Array.isArray(records)) return [];
	const out: OrgDeployRow[] = [];
	for (const r of records as Record<string, unknown>[]) {
		const id = str(r?.Id);
		if (!id) continue;
		const completed = ms(r.CompletedDate);
		const total = num(r.NumberTestsTotal);
		const tErr = num(r.NumberTestErrors);
		const createdBy = str((r.CreatedBy as { Name?: unknown } | null | undefined)?.Name);
		out.push({
			id,
			status: str(r.Status) ?? "Unknown",
			checkOnly: r.CheckOnly === true || r.CheckOnly === "true",
			...(createdBy ? { createdBy } : {}),
			startedAt: ms(r.StartDate) ?? ms(r.CreatedDate) ?? 0,
			...(completed !== undefined ? { completedAt: completed } : {}),
			components: { done: num(r.NumberComponentsDeployed), total: num(r.NumberComponentsTotal), errors: num(r.NumberComponentErrors) },
			tests: { done: testsDone(num(r.NumberTestsCompleted), tErr, total), total, errors: tErr },
			...(str(r.TestLevel) ? { testLevel: str(r.TestLevel) } : {}),
			...(str(r.ChangeSetName) ? { changeSetName: str(r.ChangeSetName) } : {}),
			...(str(r.ErrorMessage) ? { errorMessage: str(r.ErrorMessage) } : {}),
			...(str(r.StateDetail) ? { stateDetail: str(r.StateDetail) } : {}),
		});
	}
	return out;
}

/**
 * A deploy as the Metadata REST `deployRequest/<id>` (or `sf project deploy report --json`) describes it. The
 * fallback when `DeployRequest` cannot be queried: the ids the project's history knows are asked one by one.
 */
export function orgRowOfDeployResult(dr: RawDeployResult | null | undefined): OrgDeployRow | undefined {
	const r = dr as (RawDeployResult & Record<string, unknown>) | null | undefined;
	const id = str(r?.id);
	if (!r || !id) return undefined;
	const started = ms(r.startDate) ?? ms(r.createdDate) ?? 0;
	const completed = ms(r.completedDate);
	const total = num(r.numberTestsTotal);
	const tErr = num(r.numberTestErrors);
	const by = str(r.createdByName);
	return {
		id,
		status: str(r.status) ?? "Unknown",
		checkOnly: r.checkOnly === true,
		...(by ? { createdBy: by } : {}),
		startedAt: started,
		...(completed !== undefined ? { completedAt: completed } : {}),
		components: { done: num(r.numberComponentsDeployed), total: num(r.numberComponentsTotal), errors: num(r.numberComponentErrors) },
		tests: { done: testsDone(num(r.numberTestsCompleted), tErr, total), total, errors: tErr },
		...(str(r.errorMessage) ? { errorMessage: str(r.errorMessage) } : {}),
		...(str(r.stateDetail) ? { stateDetail: str(r.stateDetail) } : {}),
	};
}

/** The Tooling API's reason when the object / a field is not available (so the caller can fall back), else undefined. */
export function isUnsupportedQueryError(message: string): "object" | "field" | undefined {
	if (/INVALID_TYPE|sObject type 'DeployRequest' is not supported|not supported|NOT_FOUND.*DeployRequest/i.test(message) && /DeployRequest/i.test(message)) return "object";
	if (/INVALID_FIELD|No such column/i.test(message)) return "field";
	return undefined;
}

/** `true` succeeded, `false` did not (failed, partly succeeded, cancelled), `null` not finished. */
export function okOfStatus(status: string): boolean | null {
	if (status === "Succeeded") return true;
	if ((FAILED_STATUSES as readonly string[]).includes(status)) return false;
	return null;
}

// ── Details of one deploy ──────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined | null): T[] {
	return Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
}

const oneLine = (t: string | undefined, fallback: string): string => (t ? t.replace(/\r/g, "").trim() : "") || fallback;

/**
 * The failures of a `deployResult` (REST `…/metadata/deployRequest/<id>?includeDetails=true`, or the CLI's
 * `deploy report --json` result). A failed deploy that lists nothing but a top-level `errorMessage` gets that as
 * its one component error.
 */
export function parseDeployDetails(dr: RawDeployResult | null | undefined): DeployDetails {
	const details = dr?.details;
	const componentErrors: DeployDetails["componentErrors"] = asArray(details?.componentFailures).map((f) => {
		const x = f as { problemType?: string } & typeof f;
		const type = str(f.componentType);
		const name = str(f.fullName);
		const fileName = str(f.fileName);
		const line = typeof f.lineNumber === "number" && f.lineNumber > 0 ? f.lineNumber : undefined;
		const column = typeof f.columnNumber === "number" && f.columnNumber > 0 ? f.columnNumber : undefined;
		const prefix = x.problemType && x.problemType !== "Error" ? `${x.problemType}: ` : "";
		return {
			...(type ? { type } : {}),
			...(name ? { name } : {}),
			...(fileName ? { fileName } : {}),
			...(line ? { line } : {}),
			...(column ? { column } : {}),
			message: prefix + oneLine(f.problem, "Failed"),
		};
	});
	const testErrors: DeployDetails["testErrors"] = asArray(details?.runTestResult?.failures).map((t) => {
		const className = str(t.name);
		const methodName = str(t.methodName);
		const stackTrace = str(t.stackTrace);
		return { ...(className ? { className } : {}), ...(methodName ? { methodName } : {}), message: oneLine(t.message, "Test failed"), ...(stackTrace ? { stackTrace } : {}) };
	});
	const warnings = asArray(details?.runTestResult?.codeCoverageWarnings)
		.map((w) => `${w.name ? w.name + ": " : ""}${oneLine(w.message, "Code coverage warning")}`)
		.filter(Boolean);
	if (componentErrors.length === 0 && testErrors.length === 0 && warnings.length === 0) {
		const top = str(dr?.errorMessage) ?? (dr?.status === "Failed" ? str(dr?.stateDetail) : undefined);
		if (top) componentErrors.push({ message: oneLine(top, "Failed") });
	}
	return { componentErrors, testErrors, ...(warnings.length > 0 ? { codeCoverageWarnings: warnings } : {}) };
}

// ── Merge with the local history ───────────────────────────────────────────────

/** A short name of an operation from its component keys: `Foo`, `Foo, Bar`, `Foo, Bar +3`. */
export function labelOfComponents(keys: readonly string[], count?: number): string | undefined {
	if (keys.length === 0) return undefined;
	const names = keys.map((k) => (k.includes(":") ? k.slice(k.indexOf(":") + 1) : k));
	const total = Math.max(count ?? 0, keys.length);
	const shown = names.slice(0, 2).join(", ");
	return total > 2 ? `${shown} +${total - 2}` : shown;
}

export interface MergeOptions {
	/** What to show as the `org` of every item. */
	orgLabel: string;
	/** Does a history entry's `org` (alias, username …) name the org the list is for? */
	sameOrg: (entryOrg: string) => boolean;
	failedOnly?: boolean;
	/** Most items returned (default 50). */
	limit?: number;
}

function entryLabel(e: HistoryEntry): string | undefined {
	return str((e as { label?: unknown }).label) ?? labelOfComponents(e.components, e.componentCount);
}

/** Components with an error in the history entry (errors that name no component count as none). */
function erroredComponents(e: HistoryEntry): number {
	return new Set((e.errors ?? []).map((x) => x.component).filter((c): c is string => !!c)).size;
}

function localOnlyItem(e: HistoryEntry, orgLabel: string): DeployListItem {
	const total = Math.max(e.componentCount, e.components.length);
	const errors = e.ok ? 0 : Math.min(total, erroredComponents(e));
	const label = entryLabel(e);
	return {
		id: e.id,
		...(e.deployId ? { deployId: e.deployId } : {}),
		kind: e.kind,
		status: e.ok ? "Succeeded" : "Failed",
		ok: e.ok,
		org: orgLabel,
		...(label ? { label } : {}),
		startedAt: e.at,
		completedAt: e.at + e.durationMs,
		durationMs: e.durationMs,
		components: { done: total - errors, total, errors },
		source: "local",
		componentKeys: e.components,
	};
}

/**
 * The org's recent deploys merged with the project's history for that org, newest first.
 *   - A history entry with the deploy id of an org deploy enriches it: label, kind (a delete is a deploy to the
 *     org), source `both` and the component keys.
 *   - Every other history entry of this org is a `local` item: retrieves (the org has no record of them), deletes
 *     and deploys the org list did not return.
 * `org` undefined = the org could not be asked: history only.
 */
export function mergeDeployLists(org: readonly OrgDeployRow[] | undefined, history: readonly HistoryEntry[], opts: MergeOptions): DeployListItem[] {
	const here = history.filter((h) => opts.sameOrg(h.org));
	const byDeployId = new Map<string, HistoryEntry>();
	for (const h of here) if (h.deployId && !byDeployId.has(h.deployId)) byDeployId.set(h.deployId, h);

	const items: DeployListItem[] = [];
	const seen = new Set<string>();
	for (const r of org ?? []) {
		seen.add(r.id);
		const h = byDeployId.get(r.id);
		const label = (h && entryLabel(h)) ?? r.changeSetName;
		const durationMs = r.completedAt !== undefined && r.startedAt > 0 ? Math.max(0, r.completedAt - r.startedAt) : undefined;
		items.push({
			id: r.id,
			deployId: r.id,
			kind: h?.kind ?? (r.checkOnly ? "validate" : "deploy"),
			status: r.status,
			ok: okOfStatus(r.status),
			org: opts.orgLabel,
			...(label ? { label } : {}),
			...(r.createdBy ? { createdBy: r.createdBy } : {}),
			startedAt: r.startedAt,
			...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
			...(durationMs !== undefined ? { durationMs } : {}),
			components: r.components,
			...(r.tests.total > 0 ? { tests: r.tests } : {}),
			source: h ? "both" : "org",
			...(h ? { componentKeys: h.components } : {}),
		});
	}
	for (const h of here) {
		if (h.deployId && seen.has(h.deployId)) continue;
		items.push(localOnlyItem(h, opts.orgLabel));
	}
	items.sort((a, b) => b.startedAt - a.startedAt);
	const filtered = opts.failedOnly ? items.filter((i) => i.ok === false) : items;
	return filtered.slice(0, opts.limit ?? 50);
}
