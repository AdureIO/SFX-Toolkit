/**
 * Pure auth-health helpers (no vscode import, unit tested): token lifetime, classification of a
 * CLI refresh outcome, the errors thrown to callers, and the background re-probe schedule.
 */

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
			`Salesforce session expired or revoked (CLI: ${rr.error}). Re-authenticate your org: ${reauthHint}`
		);
		err.status = 401;
		err.authConfirmed = true;
		return err;
	}
	const why = rr.ok
		? "Salesforce rejected the session although the CLI refresh succeeded"
		: `the CLI could not refresh the session (${rr.error ?? "unknown error"})`;
	const err: AuthError = new Error(`Temporary connection problem: ${why}. Try again in a moment.`);
	err.authTransient = true;
	return err;
}

/** Back-off between background re-probes of an org whose connection was confirmed bad: 1, 2, 5, then every 10 min. */
export const AUTH_REPROBE_DELAYS_MS = [60_000, 120_000, 300_000, 600_000];

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
