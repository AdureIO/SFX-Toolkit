/**
 * Schema health: classifies describe / object-list / auth failures into a small set of
 * user-facing states and keeps ONE persistent problem per org (not one per request):
 *
 *   noDefaultOrg  the project has no default org (nothing to describe against)
 *   authInvalid   expired / revoked / deleted / unknown credentials (incl. expired scratch org)
 *   unreachable   network error, timeout, 5xx, 429 — cached schema keeps working
 *   ok            not a problem (a 404 means "not an SObject")
 *
 * Pure (no vscode import); the UI (status bar item, quick pick, throttled warning) is
 * plugged in via `setSchemaHealthSink` from extension activation, so caches and tests
 * can report freely.
 */
import * as path from "path";

/**
 * Org key used when no default org is configured. MUST equal DEFAULT_ORG_KEY in orgKey.ts
 * (that module is not pure); a unit test pins the two together.
 */
export const NO_ORG_KEY = "__default__";

/** What went wrong, from the caller's point of view. */
export type SchemaFailureKind =
	/** 404 — the name is not an SObject. Expected; negative-cacheable. */
	| "notFound"
	/** Expired / revoked / invalid / deleted credentials — the user must log in again (or pick another org). */
	| "authInvalid"
	/** The project has no default org. */
	| "noDefaultOrg"
	/** The CLI gave no credentials and no reason (no default org for `__default__`, a broken auth for a named org). */
	| "noCredentials"
	/** Network error, timeout, 5xx, 429 — retry later, never negative-cache. */
	| "transient";

export type HealthState = "ok" | "noDefaultOrg" | "authInvalid" | "unreachable";

export interface HealthClass {
	state: HealthState;
	/** authInvalid because the scratch org expired / was deleted (offer another org, not a re-login). */
	scratchExpired?: boolean;
}

/**
 * Strings, and where each one was verified:
 *  - "No default environment found. Use -o or --target-org …" (errors.NoDefaultEnv) —
 *    @salesforce/sf-plugins-core messages.md; "no default (target) org" and "Requires a
 *    username but none was defined" — the host's own src/utils/errorInterpret.ts.
 *  - "No authorization information found for %s." / name NamedOrgNotFoundError —
 *    @salesforce/core messages/core.md + lib/org/authInfo.js (alias or username unknown to the CLI).
 *  - "Error authenticating with the refresh token due to: %s" (refreshTokenAuthError) —
 *    @salesforce/core messages/core.md.
 *  - "That scratch org has been deleted, so you can't connect to it anymore." /
 *    ScratchOrgDeletedError — @salesforce/core messages/scratchOrgErrorCodes.md.
 *  - INVALID_SESSION_ID, "expired access/refresh token", "Session expired or invalid",
 *    "refresh token is invalid" — errorInterpret.ts (what Salesforce / the CLI return).
 *  - "Salesforce session expired or revoked" — AuthInfo.withRetry (401 after a refresh).
 *  - "This org appears to have a problem with its OAuth configuration" — Salesforce's
 *    server text (not present in the local CLI install; matched on the stable phrase).
 *  - NoOrgFound, invalid_grant, Bad_OAuth_Token, ENOENT on ~/.sfdx/<user>.json — NOT found in
 *    the installed CLI sources; kept as defensive heuristics.
 */
const NO_DEFAULT_RE =
	/No default (?:environment|org|target[- ]?org|username)|NoDefaultEnv|no default (?:target )?org|Requires a username but none was defined/i;
const SCRATCH_RE =
	/ScratchOrgDeletedError|scratch org has been deleted|scratch org[^\n]{0,60}expired|expired[^\n]{0,20}scratch org/i;
const AUTH_RE = new RegExp(
	[
		"INVALID_SESSION_ID",
		"expired access\\/refresh token",
		"session expired or revoked",
		"Session expired or invalid",
		"refresh token is invalid",
		"RefreshTokenAuthError",
		"Error authenticating with the refresh token",
		"invalid_grant",
		"problem with its OAuth configuration",
		"Bad_OAuth_Token",
		"NamedOrgNotFound",
		"NoOrgFound",
		"No authorization information found",
		"ENOENT[^\\n]*[\\\\/]\\.sfdx[\\\\/][^\\n]*\\.json",
	].join("|"),
	"i"
);

function statusOf(e: unknown, msg: string): number | undefined {
	const err = e as { status?: number } | undefined;
	return typeof err?.status === "number" ? err.status : Number(msg.match(/HTTP (\d{3})\b/)?.[1]) || undefined;
}

function classifyCore(e: unknown): { kind: SchemaFailureKind; scratchExpired: boolean } {
	const msg = String((e as { message?: string } | undefined)?.message ?? e ?? "");
	const status = statusOf(e, msg);
	if (status === 404) return { kind: "notFound", scratchExpired: false };
	if (NO_DEFAULT_RE.test(msg)) return { kind: "noDefaultOrg", scratchExpired: false };
	if (SCRATCH_RE.test(msg)) return { kind: "authInvalid", scratchExpired: true };
	if (AUTH_RE.test(msg) || status === 401) return { kind: "authInvalid", scratchExpired: false };
	if (/Could not get org credentials/i.test(msg)) return { kind: "noCredentials", scratchExpired: false };
	return { kind: "transient", scratchExpired: false };
}

/** Classify an error thrown by AuthInfo / httpUtils / the CLI. */
export function classifySchemaError(e: unknown): SchemaFailureKind {
	return classifyCore(e).kind;
}

/** The user-facing state for a failure kind (`noCredentials` depends on whether a named org was involved). */
export function healthStateOfKind(kind: SchemaFailureKind, orgKey: string = NO_ORG_KEY): HealthState {
	switch (kind) {
		case "notFound":
			return "ok";
		case "noDefaultOrg":
			return "noDefaultOrg";
		case "authInvalid":
			return "authInvalid";
		case "noCredentials":
			return orgKey === NO_ORG_KEY ? "noDefaultOrg" : "authInvalid";
		default:
			return "unreachable";
	}
}

/** Classify any error (or text) straight into a health state. `undefined`/`null` = ok. */
export function classifyHealth(e: unknown, orgKey: string = NO_ORG_KEY): HealthClass {
	if (e === undefined || e === null) return { state: "ok" };
	const c = classifyCore(e);
	const state = healthStateOfKind(c.kind, orgKey);
	return c.scratchExpired ? { state, scratchExpired: true } : { state };
}

/** Kinds that need the user (a login / a default org) — they probe rarely and back off for long. */
export function isAuthKind(kind: SchemaFailureKind | undefined): boolean {
	return kind === "authInvalid" || kind === "noCredentials" || kind === "noDefaultOrg";
}

/** Brief back-off after a failure (ms): transient grows 2 s → 30 s; auth problems wait 60 s. */
export function backoffMs(kind: SchemaFailureKind, consecutiveFailures: number): number {
	if (isAuthKind(kind)) return 60_000;
	const n = Math.max(1, consecutiveFailures);
	return Math.min(2000 * Math.pow(2, n - 1), 30_000);
}

/** The alias / username to show, or null for the default-org placeholder. */
function realLabel(orgLabel: string | null): string | null {
	return orgLabel && orgLabel !== NO_ORG_KEY ? orgLabel : null;
}

/** User-facing text for a problem (one line). */
export function schemaProblemMessage(kind: SchemaFailureKind, orgLabel: string | null, scratchExpired = false): string {
	const label = realLabel(orgLabel);
	const state = healthStateOfKind(kind, orgLabel ?? NO_ORG_KEY);
	switch (state) {
		case "noDefaultOrg":
			return "ASFX: no default org — set one to enable schema completion and validation";
		case "authInvalid":
			if (scratchExpired) return `ASFX: scratch org${label ? ` ${label}` : ""} has expired or was deleted — choose another org`;
			return `ASFX: org connection invalid${label ? ` (${label})` : ""} — run sf org login web${label ? ` --alias ${label}` : ""}`;
		default:
			return `ASFX: org${label ? ` ${label}` : ""} unreachable — using cached schema`;
	}
}

export interface SchemaProblem {
	orgKey: string;
	kind: SchemaFailureKind;
	state: Exclude<HealthState, "ok">;
	scratchExpired: boolean;
	message: string;
	at: number;
}

export interface SchemaHealthSink {
	/** A problem started (or persists) for an org. Called at most once per throttle window per org+state. */
	onProblem(orgKey: string, kind: SchemaFailureKind, message: string): void;
	/** The org answered successfully again (or the problem was cleared). */
	onRecovered(orgKey: string): void;
	/** Any change of the problem set (new, changed state, cleared). The UI re-renders from `getSchemaProblem`. */
	onChange?(): void;
}

/** Don't re-announce the same org+state within this window. */
export const PROBLEM_THROTTLE_MS = 10 * 60 * 1000;

let sink: SchemaHealthSink | undefined;
const lastAnnounced = new Map<string, number>();
const problems = new Map<string, SchemaProblem>();
const notified = new Set<string>();

export function setSchemaHealthSink(next: SchemaHealthSink | undefined): void {
	sink = next;
	lastAnnounced.clear();
	problems.clear();
	notified.clear();
}

function fireChange(): void {
	try {
		sink?.onChange?.();
	} catch {
		/* UI errors must not break cache ops */
	}
}

/** The current problem for a canonical org key, if any. */
export function getSchemaProblem(orgKey: string): SchemaProblem | undefined {
	return problems.get(orgKey);
}

/** The health state of an org key (`ok` when nothing is wrong). */
export function getHealthState(orgKey: string): HealthState {
	return problems.get(orgKey)?.state ?? "ok";
}

export function allSchemaProblems(): SchemaProblem[] {
	return [...problems.values()];
}

/**
 * Report a failure. `notFound` is not a problem and is ignored. `err` (optional) refines the
 * state (an expired scratch org needs another org, not a re-login).
 */
export function reportSchemaFailure(orgKey: string, kind: SchemaFailureKind, err?: unknown): void {
	if (kind === "notFound") return;
	const state = healthStateOfKind(kind, orgKey);
	if (state === "ok") return;
	const scratchExpired = err !== undefined ? classifyCore(err).scratchExpired : false;
	const message = schemaProblemMessage(kind, orgKey, scratchExpired);
	const prev = problems.get(orgKey);
	const changed = !prev || prev.state !== state || prev.scratchExpired !== scratchExpired;
	problems.set(orgKey, { orgKey, kind, state: state as Exclude<HealthState, "ok">, scratchExpired, message, at: Date.now() });
	if (changed) fireChange();
	const id = `${orgKey}|${state}`;
	const now = Date.now();
	const last = lastAnnounced.get(id);
	if (last !== undefined && now - last < PROBLEM_THROTTLE_MS) return;
	lastAnnounced.set(id, now);
	try {
		sink?.onProblem(orgKey, kind, message);
	} catch {
		/* UI errors must not break cache ops */
	}
}

/** Report a success; clears the problem state for that org (once). */
export function reportSchemaSuccess(orgKey: string): void {
	if (!problems.delete(orgKey)) return;
	for (const k of [...lastAnnounced.keys()]) if (k.startsWith(`${orgKey}|`)) lastAnnounced.delete(k);
	try {
		sink?.onRecovered(orgKey);
	} catch {
		/* ignore */
	}
	fireChange();
}

/** The default org of some project changed: what was recorded for "no default org" is stale. */
export function onDefaultOrgChangedHealth(): void {
	reportSchemaSuccess(NO_ORG_KEY);
}

/**
 * A login completed: connection problems are re-evaluated by the next request. With `orgKeys`
 * (every spelling of the re-authenticated org: key, username, alias) only those problems are
 * cleared, so another org's genuine problem stays visible; without, every auth problem is.
 */
export function onLoginCompletedHealth(orgKeys?: (string | null | undefined)[]): void {
	const wanted = orgKeys?.filter((k): k is string => !!k).map((k) => k.toLowerCase());
	for (const p of [...problems.values()]) {
		if (p.state !== "authInvalid") continue;
		if (wanted && !wanted.includes(p.orgKey.toLowerCase())) continue;
		reportSchemaSuccess(p.orgKey);
	}
}

/**
 * Popup throttle: true exactly once per org + state per session (the status bar item is the
 * persistent signal; a popup is only the first nudge). Offline is status bar only.
 */
export function shouldNotify(orgKey: string, state: HealthState): boolean {
	if (state === "ok" || state === "unreachable") return false;
	const id = `${orgKey}|${state}`;
	if (notified.has(id)) return false;
	notified.add(id);
	return true;
}

// ─── No default org (proactive) ─────────────────────────────────────────────────

export interface NoDefaultDeps {
	/** Sync resolution (sfdx-config, session hint, org-list default). null = none. */
	resolveSync(projectDir: string): string | null;
	/** `sf config get target-org` in that project (also covers the global default). null = none. */
	resolveCli(projectDir: string): Promise<string | null>;
}

/** Project dirs that definitely have no default org (sync sources AND the CLI agree). */
export async function findProjectsWithoutDefaultOrg(dirs: string[], deps: NoDefaultDeps): Promise<string[]> {
	const out: string[] = [];
	for (const dir of dirs) {
		if (deps.resolveSync(dir)) continue;
		let cli: string | null = null;
		try {
			cli = await deps.resolveCli(dir);
		} catch {
			cli = null;
		}
		if (!cli) out.push(dir);
	}
	return out;
}

/**
 * Apply a detection pass: the shared "no default org" problem is set when any project lacks a
 * default and cleared when none does. (Projects with a default resolve to their own org key.)
 */
export function applyNoDefaultOrgResult(missing: string[]): void {
	if (missing.length) reportSchemaFailure(NO_ORG_KEY, "noDefaultOrg");
	else if (problems.get(NO_ORG_KEY)?.state === "noDefaultOrg") reportSchemaSuccess(NO_ORG_KEY);
}

// ─── Active project ─────────────────────────────────────────────────────────────

function samePathOrInside(file: string, dir: string): boolean {
	const rel = path.relative(dir, file);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The project the status bar describes: the deepest known project containing the active
 * editor's file; the primary project when there is none (or no active editor).
 */
export function selectActiveProject(activeFile: string | undefined, projectDirs: string[], primary: string | undefined): string | undefined {
	if (activeFile) {
		let best: string | undefined;
		for (const dir of projectDirs) {
			if (samePathOrInside(activeFile, dir) && (!best || dir.length > best.length)) best = dir;
		}
		if (best) return best;
	}
	return primary;
}

// ─── Quick pick actions ─────────────────────────────────────────────────────────

export type HealthActionId = "setDefaultOrg" | "createScratch" | "dismiss" | "reauth" | "chooseOrg" | "showDetails";

/** The one-click fixes offered when the status bar item is clicked (labels are what the quick pick shows). */
export function healthActions(display: HealthDisplay, hasCreateScratch = true): { id: HealthActionId; label: string }[] {
	const out: { id: HealthActionId; label: string }[] = [];
	switch (display.state) {
		case "noDefaultOrg":
			out.push({ id: "setDefaultOrg", label: "Set default org…" });
			if (hasCreateScratch) out.push({ id: "createScratch", label: "Create scratch org…" });
			out.push({ id: "dismiss", label: "Dismiss" });
			break;
		case "authInvalid":
			if (display.canReauth) out.push({ id: "reauth", label: "Re-authenticate (sf org login web)" });
			out.push({ id: "chooseOrg", label: "Choose another default org…" });
			if (display.scratchExpired && hasCreateScratch) out.push({ id: "createScratch", label: "Create scratch org…" });
			out.push({ id: "showDetails", label: "Show details" });
			break;
		default:
			out.push({ id: "showDetails", label: "Show details" });
	}
	return out;
}

// ─── Status bar content ─────────────────────────────────────────────────────────

export interface HealthDisplay {
	text: string;
	tooltip: string;
	state: Exclude<HealthState, "ok">;
	/** Offer "re-authenticate" (false for an expired scratch org). */
	canReauth: boolean;
	scratchExpired: boolean;
}

/** Status bar text + tooltip for a problem; `label` = alias (or username) of the org. */
export function describeHealth(problem: SchemaProblem | undefined, label: string | null): HealthDisplay | undefined {
	if (!problem) return undefined;
	const l = realLabel(label);
	switch (problem.state) {
		case "noDefaultOrg":
			return {
				text: "$(warning) ASFX: no default org",
				tooltip: "Schema completion, validation and org features need a default org for this project.",
				state: "noDefaultOrg",
				canReauth: false,
				scratchExpired: false,
			};
		case "authInvalid":
			return {
				text: `$(error) ASFX: org connection invalid (${l ?? "default org"})`,
				tooltip: problem.scratchExpired
					? `The scratch org${l ? ` ${l}` : ""} has expired or was deleted. Choose another org.`
					: `The connection to${l ? ` ${l}` : " the default org"} is expired, revoked or invalid. Re-authenticate to restore schema features.`,
				state: "authInvalid",
				canReauth: !problem.scratchExpired,
				scratchExpired: problem.scratchExpired,
			};
		default:
			return {
				text: "$(cloud-offline) ASFX: org unreachable — using cached schema",
				tooltip: problem.message,
				state: "unreachable",
				canReauth: false,
				scratchExpired: false,
			};
	}
}
