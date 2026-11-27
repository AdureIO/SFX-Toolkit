/**
 * Pure auth-health helpers (no vscode import, unit tested): token lifetime, classification of a
 * CLI refresh outcome, the errors thrown to callers, and the background re-probe schedule.
 */

/**
 * True when the string looks like a real access token. Newer CLIs replace the token in
 * `sf org display --json` with a placeholder such as "[REDACTED ...]". Deliberately does
 * not require the 00D...!... shape (other token formats exist).
 */
export function isUsableAccessToken(t: string | undefined | null): boolean {
	if (typeof t !== "string" || t.length === 0) return false;
	if (/redacted/i.test(t)) return false;
	if (t.startsWith("[") || t.startsWith("*")) return false;
	if (/\s/.test(t)) return false;
	return true;
}

/**
 * A cached token is trusted for this long at most. Production orgs often have a 15-30 min session
 * timeout, so the old 55 min window regularly served a token Salesforce had already dropped.
 */
export const AUTH_VALID_MS = 10 * 60 * 1000;

/** Expiry of a freshly read token: the CLI's own expiration when sooner, never later than `now + maxMs`. */
export function computeExpiresAt(cliExpiration: number | undefined, now: number, maxMs: number = AUTH_VALID_MS): number {
	const cap = now + maxMs;
	if (cliExpiration === undefined || Number.isNaN(cliExpiration)) return cap;
	return Math.min(cliExpiration, cap);
}

/** Outcome of forcing the CLI to refresh an org's access token. */
export interface CliRefreshResult {
	/** The CLI command exited 0: the refresh-token flow worked (or was not needed). */
	ok: boolean;
	/** The CLI's reason when `ok` is false. */
	error?: string;
	/** The CLI reported a refresh-token / authorization problem (vs. a timeout or network error). */
	authError?: boolean;
}

/** Texts the CLI / @salesforce/core produce when the stored credentials are genuinely unusable. */
const GENUINE_AUTH_RE = new RegExp(
	[
		"RefreshTokenAuthError",
		"Error authenticating with the refresh token",
		"refresh token is invalid",
		"expired access\\/refresh token",
		"invalid_grant",
		"Bad_OAuth_Token",
		"INVALID_SESSION_ID",
		"No authorization information found",
		"NamedOrgNotFound",
		"NoOrgFound",
		"ScratchOrgDeletedError",
		"scratch org has been deleted",
		"problem with its OAuth configuration",
		"inactive user",
	].join("|"),
	"i"
);

/** True when CLI output says the credentials themselves are bad (not a timeout / network / lock problem). */
export function isGenuineAuthCliError(text: string | undefined): boolean {
	return !!text && GENUINE_AUTH_RE.test(text);
}

/** One readable line from a CLI failure (JSON `message` when present, else the first non-empty line). */
export function describeCliFailure(err: unknown): string {
	const e = err as { message?: string; stdout?: string; stderr?: string } | undefined;
	const raw = String(e?.stdout || e?.message || e?.stderr || err || "").trim();
	const start = raw.indexOf("{");
	if (start >= 0) {
		try {
			const j = JSON.parse(raw.slice(start));
			const m = [j?.name, j?.message].filter(Boolean).join(": ");
			if (m) return String(m).split(/\r?\n/)[0].trim();
		} catch {
			/* not JSON */
		}
	}
	return (raw.split(/\r?\n/).find((l) => l.trim()) ?? "unknown CLI error").trim();
}

/** Turn a rejected CLI refresh (or `undefined` for success) into a result. */
export function classifyRefreshOutcome(err: unknown | undefined): CliRefreshResult {
	if (err === undefined) return { ok: true };
	const e = err as { message?: string; stdout?: string; stderr?: string };
	const all = [e?.stdout, e?.message, e?.stderr].filter(Boolean).join("\n");
	return { ok: false, error: describeCliFailure(err), authError: isGenuineAuthCliError(all) };
}

export type AuthError = Error & { status?: number; authConfirmed?: boolean; authTransient?: boolean };

/**
 * The error a caller sees when the request still failed after the refresh dance.
 *  - CLI reported an auth error  -> confirmed: "session expired or revoked" (classified authInvalid, popup).
 *  - anything else               -> transient: classified `unreachable`, never a popup / "broken" status bar.
 */
export function buildSessionError(rr: CliRefreshResult, reauthHint: string): AuthError {
	if (!rr.ok && rr.authError) {
		const err: AuthError = new Error(
			`Salesforce session expired or revoked (CLI: ${rr.error}). Re-authenticate: ${reauthHint}`
		);
		err.status = 401;
		err.authConfirmed = true;
		return err;
	}
	const why = rr.ok ? "Salesforce rejected the session after a CLI refresh" : `CLI refresh failed: ${rr.error ?? "unknown error"}`;
	const err: AuthError = new Error(`Temporary connection problem (${why}). Try again in a moment.`);
	err.authTransient = true;
	return err;
}

/** Back-off between background re-probes of an org whose connection was confirmed bad: 1, 2, 5, then every 10 min. */
const AUTH_REPROBE_DELAYS_MS = [60_000, 120_000, 300_000, 600_000];

export function nextReprobeDelayMs(attempt: number): number {
	return AUTH_REPROBE_DELAYS_MS[Math.min(Math.max(0, attempt), AUTH_REPROBE_DELAYS_MS.length - 1)];
}

/** Decides which broken orgs are due for another probe. Never gives up: the last delay repeats until login / recovery. */
export class AuthReprobeScheduler {
	private st = new Map<string, { attempt: number; nextAt: number }>();
	constructor(private now: () => number = () => Date.now()) {}

	/** `keys` = orgs currently in a confirmed auth problem. Returns those due now. */
	due(keys: string[]): string[] {
		const t = this.now();
		const wanted = new Set(keys);
		for (const k of [...this.st.keys()]) if (!wanted.has(k)) this.st.delete(k);
		const out: string[] = [];
		for (const k of keys) {
			const e = this.st.get(k);
			if (!e) {
				this.st.set(k, { attempt: 0, nextAt: t + nextReprobeDelayMs(0) });
			} else if (t >= e.nextAt) {
				e.attempt++;
				e.nextAt = t + nextReprobeDelayMs(e.attempt);
				out.push(k);
			}
		}
		return out;
	}
}

/**
 * Every spelling under which a failure for this org may have been recorded (health problems are
 * keyed by whatever the reporter had: canonical username, alias, or the raw target).
 */
export function healthKeyCandidates(...spellings: (string | null | undefined)[]): string[] {
	const out: string[] = [];
	for (const s of spellings) {
		if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
	}
	return out;
}

// ─── Session recovery (re-read before refresh) ──────────────────────────────────

export interface RecoverDeps<A extends { accessToken: string }, T> {
	/**
	 * The CLI's current auth, other than `failedToken` when it has one: the cached entry if it already
	 * differs, an in-flight read if there is one, else drop the cache and re-read `sf org display`.
	 */
	reread(failedToken: string): Promise<A | null>;
	/** Drop the cached entry so the next read goes to `sf org display`. */
	invalidate(): void;
	/** Read auth (cache, else `sf org display`). */
	read(): Promise<A | null>;
	execute(a: A): Promise<T>;
	isSessionErr(e: unknown): boolean;
	/** Force the CLI refresh-token flow. `failedToken` lets the caller skip a refresh already done for it. */
	refresh(failedToken: string | undefined): Promise<CliRefreshResult>;
	noCreds(): Error;
	sessionError(rr: CliRefreshResult): Error;
	/** The retry worked with a token other than the failed one. */
	onRecovered(a: A, via: "reread" | "refresh"): void;
}

/**
 * A request failed with a session error using `failed`. Order matters:
 *  1. re-read the CLI's current token (an `sf org open`, deploy or another tool may have refreshed it
 *     already) and retry when it differs from the failed one;
 *  2. only then force a CLI refresh, re-read and retry;
 *  3. a token that was already rejected is never sent again.
 */
export async function recoverSession<A extends { accessToken: string }, T>(
	failed: A,
	d: RecoverDeps<A, T>
): Promise<{ result: T; auth: A }> {
	const tried = new Set<string>([failed.accessToken]);
	const attempt = async (a: A): Promise<{ result: T; auth: A } | null> => {
		tried.add(a.accessToken);
		try {
			return { result: await d.execute(a), auth: a };
		} catch (e) {
			d.invalidate();
			if (!d.isSessionErr(e)) throw e;
			return null;
		}
	};

	// 1. Re-read before refreshing.
	const cur = await d.reread(failed.accessToken);
	if (cur && !tried.has(cur.accessToken)) {
		const r = await attempt(cur);
		if (r) {
			d.onRecovered(cur, "reread");
			return r;
		}
	}

	// 2. Force the CLI refresh (skipped inside `refresh` when this token was already refreshed away from).
	const rr = await d.refresh(cur?.accessToken ?? failed.accessToken);
	if (!rr.ok) {
		d.invalidate();
		throw d.sessionError(rr);
	}
	let next = await d.read();
	if (!next) throw d.noCreds();
	if (tried.has(next.accessToken)) {
		// The refresh did not change the token: force one more, never resend a rejected token.
		const rr2 = await d.refresh(undefined);
		if (!rr2.ok) throw d.sessionError(rr2);
		next = await d.read();
		if (!next) throw d.noCreds();
		if (tried.has(next.accessToken)) throw d.sessionError({ ok: true });
	}
	const r = await attempt(next);
	if (r) {
		d.onRecovered(next, "refresh");
		return r;
	}
	throw d.sessionError({ ok: true });
}

// ─── CLI commands that may rewrite the stored token ─────────────────────────────

/**
 * `sf` topics (first word) the toolkit runs that authenticate against the org and so may rewrite the
 * stored token: deploy/retrieve/convert (project), Apex runs and tests (apex), queries and imports (data),
 * package installs and versions (package), org API usage (limits).
 */
const TOKEN_REFRESHING_TOPICS = new Set(["project", "apex", "data", "package", "limits"]);

/**
 * Does this `sf` invocation possibly refresh the org's stored token? Returns the org it targeted
 * (`--target-org` / `-o` / `-u` / `--targetusername`), `null` when it used the default org.
 * `org open` / `org resume` count; `org display` (our own auth read) and the rest of `org` do not.
 */
export function cliRefreshesToken(argvOrCommand: string[] | string): { match: boolean; org: string | null } {
	const parts = (Array.isArray(argvOrCommand) ? argvOrCommand : argvOrCommand.trim().split(/\s+/)).map((p) => p.replace(/^['"]|['"]$/g, ""));
	let i = 0;
	if (/^(?:.*[\\/])?(sf|sfdx)(\.cmd)?$/i.test(parts[0] ?? "")) i = 1;
	else return { match: false, org: null };
	const topic = parts[i];
	const sub = parts[i + 1];
	const match = topic === "org" ? sub === "open" || sub === "resume" : TOKEN_REFRESHING_TOPICS.has(topic ?? "");
	if (!match) return { match: false, org: null };
	let org: string | null = null;
	for (let j = i; j < parts.length; j++) {
		const p = parts[j];
		if (/^(--target-org|-o|-u|--targetusername)$/.test(p) && parts[j + 1]) org = parts[j + 1];
		else {
			const m = /^(?:--target-org|--targetusername)=(.+)$/.exec(p);
			if (m) org = m[1];
		}
	}
	return { match: true, org };
}

// ─── Sliding session expiry ─────────────────────────────────────────────────────

export const MIN_SESSION_MS = 5 * 60 * 1000;
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;

/** Session timeout to use: clamped to [5 min, 12 h]; unknown / invalid falls back to the 10-min default. */
export function clampSessionTimeoutMs(ms: number | undefined): number {
	if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return AUTH_VALID_MS;
	return Math.min(MAX_SESSION_MS, Math.max(MIN_SESSION_MS, ms));
}

/**
 * New expiry of a cached token after a successful request. A Salesforce session lives until its timeout
 * passes WITHOUT activity, so each use slides it forward to `now + timeout - margin` (margin = 10 % or 2 min,
 * whichever is smaller). Only ever extends; an explicit CLI `accessTokenExpiration` (`cliCap`) caps it.
 */
export function slidingExpiry(opts: { now: number; current: number; sessionTimeoutMs?: number; cliCap?: number }): number {
	const timeout = clampSessionTimeoutMs(opts.sessionTimeoutMs);
	const margin = Math.min(timeout * 0.1, 2 * 60 * 1000);
	let next = Math.max(opts.current, opts.now + timeout - margin);
	if (opts.cliCap !== undefined && !Number.isNaN(opts.cliCap)) next = Math.min(next, opts.cliCap);
	return next;
}

/** `NumSecondsValid` of the first AuthSession record in a SOQL response body -> clamped ms; undefined when absent. */
export function parseSessionTimeout(body: string): number | undefined {
	try {
		const n = Number(JSON.parse(body)?.records?.[0]?.NumSecondsValid);
		return Number.isFinite(n) && n > 0 ? clampSessionTimeoutMs(n * 1000) : undefined;
	} catch {
		return undefined;
	}
}

/** OAuth userinfo endpoint (path only): the one place that knows it; `parseUserId` reads its answer. */
export const USERINFO_PATH = "/services/oauth2/userinfo";

const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/** The validated `user_id` of a userinfo response body; undefined when absent, malformed or not an Id. */
export function parseUserId(body: string): string | undefined {
	try {
		const id = JSON.parse(body)?.user_id;
		return typeof id === "string" && SF_ID_RE.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

/** SOQL for the org's OAuth session timeout of a user; undefined when the id does not look like a user Id. */
export function sessionTimeoutQuery(userId: string | undefined): string | undefined {
	if (!userId || !SF_ID_RE.test(userId)) return undefined;
	return `SELECT NumSecondsValid FROM AuthSession WHERE UsersId = '${userId}' AND SessionType = 'Oauth2' ORDER BY LastModifiedDate DESC LIMIT 1`;
}
