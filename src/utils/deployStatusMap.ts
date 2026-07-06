/**
 * Pure mapping between the Metadata REST `deployRequest` payload and the shapes the
 * UI + diagnostics already consume. No VS Code / I/O dependencies, so it is unit-
 * testable in isolation. The live poller (deployEngine) does the HTTP; this file
 * only interprets the JSON.
 *
 * REST endpoint: GET /services/data/vXX.0/metadata/deployRequest/{id}?includeDetails=true
 * (see meta_rest_deploy_checkstatus).
 */
import type { ApiDeployResult, ApiComponentFailure } from "./deployDiagnostics";

/** Subset of the Metadata API deployResult we read. */
export interface RawDeployResult {
	id?: string;
	status?: string;
	stateDetail?: string;
	done?: boolean;
	numberComponentsDeployed?: number;
	numberComponentsTotal?: number;
	numberComponentErrors?: number;
	numberTestsCompleted?: number;
	numberTestsTotal?: number;
	numberTestErrors?: number;
	errorStatusCode?: string;
	errorMessage?: string;
	details?: {
		componentFailures?: ApiComponentFailure | ApiComponentFailure[];
		componentSuccesses?: DeployedComponent | DeployedComponent[];
		runTestResult?: {
			codeCoverage?: Array<{ name?: string; numLocations?: number; numLocationsNotCovered?: number }>;
		};
	};
}

/** A single deployed/retrieved component (Metadata API `componentType` + `fullName`). */
export interface DeployedComponent {
	componentType?: string;
	/** Retrieve results use `type` instead of `componentType`. */
	type?: string;
	fullName?: string;
	fileName?: string;
	created?: boolean;
	changed?: boolean;
	deleted?: boolean;
}

/**
 * From a set of deployed/retrieved components, return which SObjects had schema
 * changes and whether the change is structural (an object added/removed/renamed,
 * so the object *list* — not just one describe — must be refreshed).
 * Empty `objects` ⇒ nothing schema-related changed ⇒ no refresh needed.
 */
export function affectedSchemaObjects(components: DeployedComponent[]): { objects: string[]; structural: boolean } {
	const objects = new Set<string>();
	let structural = false;
	for (const c of components) {
		const type = c.componentType ?? c.type;
		const full = c.fullName ?? "";
		if (!type || !full) continue;
		if (type === "CustomField") {
			const obj = full.split(".")[0]; // "Account.Foo__c" → "Account"
			if (obj) objects.add(obj);
		} else if (type === "CustomObject") {
			objects.add(full);
			structural = true; // object may be new/removed → the object list can change
		}
	}
	return { objects: [...objects], structural };
}

/** Normalize componentSuccesses (API returns single object or array or nothing) to an array. */
export function componentSuccessList(dr: RawDeployResult): DeployedComponent[] {
	const raw = dr.details?.componentSuccesses;
	if (Array.isArray(raw)) return raw;
	if (raw && typeof raw === "object") return [raw];
	return [];
}

/**
 * Detect whether a source file path is schema metadata (an object or field), for
 * the single-file deploy/retrieve commands. Returns the object API name and whether
 * the change is structural (the `.object-meta.xml` itself), or null for non-schema
 * files (Apex, LWC, record types, layouts, …).
 */
export function schemaObjectFromPath(filePath: string): { object: string; structural: boolean } | null {
	const norm = filePath.replace(/\\/g, "/");
	const m = /\/objects\/([^/]+)\//.exec(norm);
	if (!m) return null;
	const object = m[1];
	if (/\/fields\/[^/]+\.field-meta\.xml$/i.test(norm)) return { object, structural: false };
	if (/\.object-meta\.xml$/i.test(norm)) return { object, structural: true };
	// Other object sub-metadata (recordTypes, listViews, validationRules…) don't
	// change the field list, so they don't affect the describe cache or stubs.
	return null;
}

/**
 * Parse `sf project retrieve start --json` output into the retrieved components.
 * Returns null if the JSON can't be read (caller should then refresh fully to be safe).
 */
export function parseRetrievedComponents(stdout: string): DeployedComponent[] | null {
	try {
		const parsed = JSON.parse(stdout.trim());
		const files = parsed?.result?.files ?? parsed?.result?.inboundFiles;
		if (!Array.isArray(files)) return null;
		return files.map((f: { type?: string; fullName?: string }) => ({ type: f?.type, fullName: f?.fullName }));
	} catch {
		return null;
	}
}

/** Normalized snapshot for the progress UI. */
export interface DeployLiveStatus {
	status: string; // Pending | InProgress | Succeeded | Failed | Canceling | Canceled | SucceededPartial
	stateDetail?: string;
	componentsDeployed: number;
	componentsTotal: number;
	componentErrors: number;
	testsCompleted: number;
	testsTotal: number;
	testErrors: number;
	done: boolean;
	/** Milliseconds since the deploy started, filled in by the engine for the live timer. */
	elapsedMs?: number;
}

/**
 * Format a duration as `m:ss.d` (tenths) — or `h:mm:ss.d` past an hour. Tenths (not
 * hundredths/millis) so the running timer *counts* smoothly at the ~100 ms display
 * tick: one tenth per tick. Finer digits can't count at that refresh rate — they jump.
 */
export function formatElapsed(ms: number): string {
	const totalMs = Math.max(0, Math.floor(ms));
	const totalS = Math.floor(totalMs / 1000);
	const d = Math.floor((totalMs % 1000) / 100); // tenths
	const s = String(totalS % 60).padStart(2, "0");
	const m = Math.floor(totalS / 60) % 60;
	const h = Math.floor(totalS / 3600);
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}.${d}` : `${m}:${s}.${d}`;
}

export interface DeployStats {
	components: number;
	componentErrors: number;
	testsPassed: number;
	testsFailed: number;
}

export interface CoverageRow {
	name: string;
	covered: number;
	total: number;
	pct: number;
}

/** Terminal deploy states — polling stops here. */
const TERMINAL = new Set(["Succeeded", "Failed", "Canceled", "SucceededPartial"]);

export function isTerminalStatus(status: string | undefined): boolean {
	return !!status && TERMINAL.has(status);
}

/** The REST endpoint wraps the result under `deployResult`; some shapes expose it flat. */
export function extractDeployResult(json: unknown): RawDeployResult | null {
	if (!json || typeof json !== "object") return null;
	const obj = json as Record<string, unknown>;
	const dr = (obj.deployResult ?? obj) as RawDeployResult;
	return dr && typeof dr === "object" ? dr : null;
}

export function mapLiveStatus(dr: RawDeployResult): DeployLiveStatus {
	const status = dr.status ?? "Pending";
	return {
		status,
		stateDetail: dr.stateDetail,
		componentsDeployed: dr.numberComponentsDeployed ?? 0,
		componentsTotal: dr.numberComponentsTotal ?? 0,
		componentErrors: dr.numberComponentErrors ?? 0,
		testsCompleted: dr.numberTestsCompleted ?? 0,
		testsTotal: dr.numberTestsTotal ?? 0,
		testErrors: dr.numberTestErrors ?? 0,
		done: dr.done === true || isTerminalStatus(status),
	};
}

/** Feed straight into setDeployDiagnosticsFromApiResult — the failures map to Problems. */
export function toApiDeployResult(dr: RawDeployResult): ApiDeployResult {
	return {
		status: dr.status,
		numberComponentsDeployed: dr.numberComponentsDeployed,
		numberComponentsTotal: dr.numberComponentsTotal,
		numberComponentErrors: dr.numberComponentErrors,
		numberTestsCompleted: dr.numberTestsCompleted,
		numberTestsTotal: dr.numberTestsTotal,
		numberTestErrors: dr.numberTestErrors,
		stateDetail: dr.stateDetail,
		errorStatusCode: dr.errorStatusCode,
		errorMessage: dr.errorMessage,
		details: {
			componentFailures: dr.details?.componentFailures,
			componentSuccesses: dr.details?.componentSuccesses,
		},
	};
}

export function statsFromResult(dr: RawDeployResult): DeployStats {
	return {
		components: dr.numberComponentsDeployed ?? 0,
		componentErrors: dr.numberComponentErrors ?? 0,
		testsPassed: dr.numberTestsCompleted ?? 0,
		testsFailed: dr.numberTestErrors ?? 0,
	};
}

export function coverageFromResult(dr: RawDeployResult): CoverageRow[] {
	const cov = dr.details?.runTestResult?.codeCoverage ?? [];
	return cov.map((c) => {
		const total = c.numLocations ?? 0;
		const covered = Math.max(0, total - (c.numLocationsNotCovered ?? 0));
		const pct = total > 0 ? Math.round((covered / total) * 100) : 100;
		return { name: c.name ?? "", covered, total, pct };
	});
}

/** Short human message for the progress notification, mirroring the CLI's live table. */
export function formatStatus(s: DeployLiveStatus): string {
	const timer = s.elapsedMs !== undefined ? `⏱ ${formatElapsed(s.elapsedMs)}` : "";
	if (s.status === "Canceling") return ["Canceling…", timer].filter(Boolean).join(" · ");

	const inTests = s.testsTotal > 0 && (s.testsCompleted + s.testErrors) < s.testsTotal;
	let stage: string;
	if (s.status === "Pending") stage = "Pending";
	else if (inTests) stage = "Running tests";
	else if (s.status === "InProgress") stage = "Deploying";
	else stage = s.status;

	const parts = [stage];
	// The org's own status detail ("Processing Type: ApexClass", queue position, …).
	if (s.stateDetail) parts.push(s.stateDetail.replace(/\s+/g, " ").slice(0, 60));
	if (s.componentsTotal > 0) parts.push(`${s.componentsDeployed}/${s.componentsTotal} components`);
	if (s.testsTotal > 0) parts.push(`${s.testsCompleted + s.testErrors}/${s.testsTotal} tests`);
	if (s.componentErrors > 0) parts.push(`${s.componentErrors} error${s.componentErrors === 1 ? "" : "s"}`);
	if (timer) parts.push(timer);
	return parts.join(" · ");
}

/** Fields the result-summary reads (a subset shared by RawDeployResult / ApiDeployResult). */
export interface DeployResultNumbers {
	numberComponentsDeployed?: number;
	numberComponentsTotal?: number;
	numberComponentErrors?: number;
	numberTestsCompleted?: number;
	numberTestsTotal?: number;
	numberTestErrors?: number;
	errorStatusCode?: string;
	errorMessage?: string;
}

/**
 * One-line result summary for the completion notification, e.g.
 * `38/40 components (2 errors) · 18/20 tests (2 failed) — INVALID_FIELD: No such column`.
 */
export function formatResultSummary(r: DeployResultNumbers): string {
	const num = (v: number | undefined) => (v === undefined || v === null ? undefined : v);
	const parts: string[] = [];

	const dep = num(r.numberComponentsDeployed);
	const totC = num(r.numberComponentsTotal);
	if (dep !== undefined || totC !== undefined) {
		const errC = num(r.numberComponentErrors) ?? 0;
		parts.push(`${dep ?? 0}/${totC ?? dep ?? 0} components${errC > 0 ? ` (${errC} error${errC === 1 ? "" : "s"})` : ""}`);
	}

	const totT = num(r.numberTestsTotal);
	if (totT !== undefined && totT > 0) {
		const done = num(r.numberTestsCompleted) ?? 0;
		const errT = num(r.numberTestErrors) ?? 0;
		parts.push(`${done + errT}/${totT} tests${errT > 0 ? ` (${errT} failed)` : ""}`);
	}

	let summary = parts.join(" · ");
	if (r.errorMessage) {
		const em = `${r.errorStatusCode ? r.errorStatusCode + ": " : ""}${r.errorMessage}`.replace(/\s+/g, " ").slice(0, 200);
		summary = summary ? `${summary} — ${em}` : em;
	}
	return summary;
}
