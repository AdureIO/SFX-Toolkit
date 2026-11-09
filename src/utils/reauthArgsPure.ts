/** Pure helpers for re-authenticating an org (no vscode import, unit tested). */

export type ReauthRecord = { alias?: string; username: string; instanceUrl?: string; isSandbox?: boolean };

const SANDBOX_LOGIN_URL = "https://test.salesforce.com";

/** Final domain labels that are real TLDs / well-known suffixes in Salesforce usernames (not a sandbox name). */
const COMMON_TLDS = new Set([
	"com", "org", "net", "edu", "gov", "int", "mil", "info", "biz", "io", "cloud", "app", "dev", "tech", "online", "site", "xyz", "co"
]);

/**
 * Conservative sandbox heuristic for usernames like `user@company.com.partial`: a sandbox appends
 * `.<sandboxName>` to the production username, so the final domain label is neither a 2-letter
 * country code nor a well-known TLD. Only used when the org list gave no `isSandbox` flag.
 * Note `.dev` is treated as a TLD here (a real TLD), so only pass it as a sandbox via `isSandbox`.
 */
export function looksLikeSandboxUsername(username: string): boolean {
	const at = username.lastIndexOf("@");
	if (at < 0) return false;
	const labels = username.slice(at + 1).toLowerCase().split(".").filter(Boolean);
	if (labels.length < 3) return false;
	const last = labels[labels.length - 1];
	return last.length > 2 && !COMMON_TLDS.has(last);
}

/** Arguments for `sf` to re-run the web login for `rec` (null = bare login). */
export function buildReauthArgs(rec: ReauthRecord | null): string[] {
	const args = ["org", "login", "web"];
	if (!rec) return args;
	if (rec.alias) args.push("--alias", rec.alias);
	if (rec.instanceUrl) {
		args.push("--instance-url", rec.instanceUrl);
	} else if (rec.isSandbox === true || (rec.isSandbox === undefined && looksLikeSandboxUsername(rec.username))) {
		args.push("--instance-url", SANDBOX_LOGIN_URL);
	}
	return args;
}

/** Username from `sf org login web --json` output; null when it can't be read. */
export function parseLoginUsername(stdout: string): string | null {
	try {
		const start = stdout.indexOf("{");
		if (start < 0) return null;
		const u = JSON.parse(stdout.slice(start))?.result?.username;
		return typeof u === "string" && u.trim() ? u.trim() : null;
	} catch {
		return null;
	}
}
