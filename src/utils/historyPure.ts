/**
 * Deploy & Retrieve Center history: the entry type, adding with a cap, (de)serializing, and turning a deploy /
 * retrieve result into the entry's error list. Pure (no `vscode`, no I/O).
 */
import type { ApiDeployResult } from "./deployDiagnostics";
import type { RawDeployResult } from "./deployStatusMap";

export type HistoryKind = "deploy" | "validate" | "retrieve" | "delete";
export type HistorySource = "center" | "deployPanel" | "orgBrowser" | "command";

export interface HistoryError {
	/** `Type:fullName` when the failure belongs to a component. */
	component?: string;
	message: string;
}

export interface HistoryEntry {
	id: string;
	kind: HistoryKind;
	/** Target org (username, alias or whatever the operation ran against). */
	org: string;
	/** Start time, epoch ms. */
	at: number;
	durationMs: number;
	/** `Type:fullName` keys (at most `MAX_COMPONENTS`; `componentCount` has the real number). */
	components: string[];
	/** Total components of the operation (≥ `components.length`). */
	componentCount: number;
	testLevel?: string;
	/** Deploy id (`0Af…`) of a deploy, validate or delete. */
	deployId?: string;
	ok: boolean;
	/** At most `MAX_ERRORS`. */
	errors?: HistoryError[];
	source: HistorySource;
}

/** What callers hand in: the id and the count are filled in. */
export type NewHistoryEntry = Omit<HistoryEntry, "id" | "componentCount"> & { id?: string; componentCount?: number };

/** Entries kept per project. */
export const MAX_ENTRIES = 200;
export const MAX_ERRORS = 50;
export const MAX_COMPONENTS = 1000;
const MAX_MESSAGE = 600;

const KINDS: readonly string[] = ["deploy", "validate", "retrieve", "delete"];
const SOURCES: readonly string[] = ["center", "deployPanel", "orgBrowser", "command"];

/** The stored form of an entry: errors, components and messages capped. */
export function normalizeEntry(e: NewHistoryEntry, newId: () => string): HistoryEntry {
	const errors = (e.errors ?? []).slice(0, MAX_ERRORS).map((x) => ({
		...(x.component ? { component: x.component } : {}),
		message: String(x.message ?? "").slice(0, MAX_MESSAGE),
	}));
	return {
		id: e.id || newId(),
		kind: e.kind,
		org: e.org,
		at: e.at,
		durationMs: Math.max(0, Math.round(e.durationMs)),
		components: e.components.slice(0, MAX_COMPONENTS),
		componentCount: Math.max(e.componentCount ?? 0, e.components.length),
		...(e.testLevel ? { testLevel: e.testLevel } : {}),
		...(e.deployId ? { deployId: e.deployId } : {}),
		ok: e.ok,
		...(errors.length > 0 ? { errors } : {}),
		source: e.source,
	};
}

/** New list with `entry` first (newest first), capped at `MAX_ENTRIES`. An entry with an existing id replaces it. */
export function addEntry(list: readonly HistoryEntry[], entry: HistoryEntry, max = MAX_ENTRIES): HistoryEntry[] {
	const rest = list.filter((x) => x.id !== entry.id);
	return [entry, ...rest].slice(0, max);
}

export interface HistoryFile {
	v: 1;
	entries: HistoryEntry[];
}

export function serializeHistory(list: readonly HistoryEntry[]): string {
	const file: HistoryFile = { v: 1, entries: [...list] };
	return JSON.stringify(file);
}

function validEntry(x: unknown): x is HistoryEntry {
	if (!x || typeof x !== "object") return false;
	const e = x as Record<string, unknown>;
	return (
		typeof e.id === "string" &&
		KINDS.includes(e.kind as string) &&
		typeof e.org === "string" &&
		typeof e.at === "number" &&
		typeof e.durationMs === "number" &&
		Array.isArray(e.components) &&
		typeof e.ok === "boolean" &&
		SOURCES.includes(e.source as string)
	);
}

/** Read a stored file; a missing, damaged or foreign file gives []. Invalid entries are dropped; the cap is re-applied. */
export function parseHistory(text: string | undefined): HistoryEntry[] {
	if (!text) return [];
	try {
		const raw = JSON.parse(text) as Partial<HistoryFile>;
		if (!raw || raw.v !== 1 || !Array.isArray(raw.entries)) return [];
		return raw.entries.filter(validEntry).map((e) => ({ ...e, componentCount: typeof e.componentCount === "number" ? e.componentCount : e.components.length })).slice(0, MAX_ENTRIES);
	} catch {
		return [];
	}
}

// ── Errors of a result ─────────────────────────────────────────────────────────

function asArray<T>(v: T | T[] | undefined): T[] {
	return Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
}

/**
 * The entry's errors of a deploy / validate / delete: the component failures and the failing Apex tests of the
 * API result; else the CLI's error text as one message. At most `MAX_ERRORS`.
 */
export function historyErrorsFromDeploy(api: ApiDeployResult | undefined, errorText?: string): HistoryError[] {
	const out: HistoryError[] = [];
	for (const f of asArray(api?.details?.componentFailures)) {
		out.push({ component: f.componentType && f.fullName ? `${f.componentType}:${f.fullName}` : f.fullName, message: f.problem || "Failed" });
	}
	for (const t of asArray(api?.details?.runTestResult?.failures)) {
		out.push({ component: t.name ? `ApexClass:${t.name}` : undefined, message: `${t.methodName ? t.methodName + ": " : ""}${t.message || "Test failed"}` });
	}
	for (const w of asArray(api?.details?.runTestResult?.codeCoverageWarnings)) {
		out.push({ component: w.name ? `ApexClass:${w.name}` : undefined, message: w.message || "Code coverage warning" });
	}
	if (out.length === 0) {
		const msg = api?.errorMessage || api?.stateDetail || errorText;
		if (msg) out.push({ message: msg.replace(/\s+/g, " ").trim() });
	}
	return out.slice(0, MAX_ERRORS);
}

/** The entry's errors of a retrieve: its failed components. */
export function historyErrorsFromRetrieve(failed: readonly { type: string; fullName: string; error: string }[]): HistoryError[] {
	return failed.slice(0, MAX_ERRORS).map((f) => ({ component: `${f.type}:${f.fullName}`, message: f.error }));
}

/** `Type:fullName` keys of the components a deploy result names (successes and failures), without duplicates. */
export function componentKeysFromDeploy(dr: RawDeployResult | undefined): string[] {
	const keys = new Set<string>();
	for (const c of [...asArray(dr?.details?.componentSuccesses), ...asArray(dr?.details?.componentFailures)]) {
		const type = (c as { componentType?: string }).componentType;
		if (type && c.fullName) keys.add(`${type}:${c.fullName}`);
	}
	return [...keys];
}
