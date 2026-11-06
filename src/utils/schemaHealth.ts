/**
 * Schema fetch health: classifies describe / object-list failures and surfaces a
 * persistent problem (expired session, unreachable org) ONCE — not per request.
 *
 * Pure (no vscode import); the UI (status bar item + throttled warning) is plugged
 * in via `setSchemaHealthSink` from extension activation, so caches and tests can
 * report freely.
 */

/** What went wrong, from the caller's point of view. */
export type SchemaFailureKind =
	/** 404 — the name is not an SObject. Expected; negative-cacheable. */
	| "notFound"
	/** 401 after a token refresh — the user must log in again. */
	| "sessionExpired"
	/** No credentials at all (no default org, CLI failed / timed out). */
	| "noCredentials"
	/** Network error, timeout, 5xx, 429 — retry later, never negative-cache. */
	| "transient";

/** Classify an error thrown by AuthInfo / httpUtils. */
export function classifySchemaError(e: unknown): SchemaFailureKind {
	const err = e as { status?: number; message?: string } | undefined;
	const msg = String(err?.message ?? e ?? "");
	const status = typeof err?.status === "number" ? err.status : Number(msg.match(/HTTP (\d{3})\b/)?.[1]) || undefined;
	if (status === 404) return "notFound";
	if (/session expired or revoked/i.test(msg) || status === 401) return "sessionExpired";
	if (/Could not get org credentials/i.test(msg)) return "noCredentials";
	return "transient";
}

/** Brief back-off after a failure (ms): transient grows 2 s → 30 s; auth problems wait 60 s. */
export function backoffMs(kind: SchemaFailureKind, consecutiveFailures: number): number {
	if (kind === "sessionExpired" || kind === "noCredentials") return 60_000;
	const n = Math.max(1, consecutiveFailures);
	return Math.min(2000 * Math.pow(2, n - 1), 30_000);
}

/** User-facing text for a problem (one line). */
export function schemaProblemMessage(kind: SchemaFailureKind, orgLabel: string | null): string {
	const target = orgLabel && orgLabel !== "__default__" ? ` --target-org ${orgLabel}` : "";
	switch (kind) {
		case "sessionExpired":
			return `ASFX schema: session expired — run sf org login web${target}`;
		case "noCredentials":
			return `ASFX schema: no org credentials${orgLabel && orgLabel !== "__default__" ? ` for ${orgLabel}` : ""} — set a default org or run sf org login web`;
		default:
			return `ASFX schema: org${orgLabel && orgLabel !== "__default__" ? ` ${orgLabel}` : ""} unreachable — completion uses cached schema`;
	}
}

export interface SchemaHealthSink {
	/** A problem started (or persists) for an org. Called at most once per throttle window per org+kind. */
	onProblem(orgKey: string, kind: SchemaFailureKind, message: string): void;
	/** The org answered successfully again. */
	onRecovered(orgKey: string): void;
}

/** Don't re-announce the same org+kind within this window. */
export const PROBLEM_THROTTLE_MS = 10 * 60 * 1000;

let sink: SchemaHealthSink | undefined;
const lastAnnounced = new Map<string, number>();
const failing = new Set<string>();

export function setSchemaHealthSink(next: SchemaHealthSink | undefined): void {
	sink = next;
	lastAnnounced.clear();
	failing.clear();
}

/** Report a failure. `notFound` is not a problem and is ignored. */
export function reportSchemaFailure(orgKey: string, kind: SchemaFailureKind): void {
	if (kind === "notFound") return;
	failing.add(orgKey);
	const id = `${orgKey}|${kind}`;
	const now = Date.now();
	const last = lastAnnounced.get(id);
	if (last !== undefined && now - last < PROBLEM_THROTTLE_MS) return;
	lastAnnounced.set(id, now);
	try {
		sink?.onProblem(orgKey, kind, schemaProblemMessage(kind, orgKey));
	} catch {
		/* UI errors must not break cache ops */
	}
}

/** Report a success; clears the problem state for that org (once). */
export function reportSchemaSuccess(orgKey: string): void {
	if (!failing.delete(orgKey)) return;
	for (const k of [...lastAnnounced.keys()]) if (k.startsWith(`${orgKey}|`)) lastAnnounced.delete(k);
	try {
		sink?.onRecovered(orgKey);
	} catch {
		/* ignore */
	}
}
