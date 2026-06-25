import { runCommandArgs } from "./commandRunner";
import { httpsGet, httpsDelete, httpsPost, httpsGetRange } from "./httpUtils";
import { Logger, outputChannel } from "./outputChannel";
import { isSalesforceProject } from "./projectUtils";

/** Default: consider token expired after 55 minutes so we refresh before typical 2h OAuth expiry. */
const AUTH_VALID_MS = 55 * 60 * 1000;

const CACHE_KEY_DEFAULT = "__default__";

export interface OrgAuth {
	accessToken: string;
	instanceUrl: string;
	username: string;
	orgId: string;
	/** Optional alias used to fetch this org (for logging). */
	alias?: string;
	/** Timestamp (ms) after which this auth is considered expired and must be refreshed. */
	expiresAt: number;
}

/** If the CLI returns an expiration, use it; otherwise return undefined for default. */
function parseExpiration(result: { accessTokenExpiration?: string }): number | undefined {
	const exp = result.accessTokenExpiration;
	if (!exp) return undefined;
	const t = new Date(exp).getTime();
	if (!Number.isNaN(t)) return t;
	return undefined;
}

function buildOrgAuth(parsed: any): OrgAuth {
	const expiresAt = parseExpiration(parsed) ?? Date.now() + AUTH_VALID_MS;
	return {
		accessToken: parsed.accessToken,
		instanceUrl: parsed.instanceUrl,
		username: parsed.username,
		orgId: parsed.id ?? parsed.orgId ?? "",
		expiresAt,
	};
}

/**
 * Centralized org auth cache. All commands that need an access token or instance URL
 * should use getAuthInfoForOrg(). Auth is cached per org; expired entries are refetched.
 * Call clearCache() after login/set-default so the next access gets fresh credentials.
 */
export class AuthInfo {
	private static cache = new Map<string, OrgAuth>();
	private static fetchLocks = new Map<string, Promise<OrgAuth | null>>();

	private static cacheKey(targetOrg: string | null): string {
		return targetOrg === null || targetOrg === "" ? CACHE_KEY_DEFAULT : targetOrg;
	}

	/** Returns cached auth only if present and not expired. */
	private static getValidFromCache(key: string): OrgAuth | null {
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() >= entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}
		return entry;
	}

	/** True if we have valid (non-expired) cached auth for the default org. */
	public static hasValidCache(): boolean {
		return this.getValidFromCache(CACHE_KEY_DEFAULT) !== null;
	}

	/**
	 * Fetch org credentials from the CLI (one place for all auth retrieval).
	 */
	private static async fetchOrgAuth(targetOrg: string | null): Promise<OrgAuth | null> {
		const args = ["org", "display", "--json"];
		if (targetOrg) args.push("--target-org", targetOrg);
		const result = await runCommandArgs("sf", args);
		const parsed = JSON.parse(result);
		if (parsed.status !== 0 || !parsed.result) {
			outputChannel.appendLine(`AuthInfo: sf org display failed${targetOrg ? ` (${targetOrg})` : ""}: ${parsed.message || "Unknown"}`);
			return null;
		}
		const auth = buildOrgAuth(parsed.result);
		// Recent Salesforce CLI versions hide the access token from `sf org display`.
		// We set SF_TEMP_SHOW_SECRETS=true to restore it; if it's still missing the
		// token is genuinely unavailable — surface a precise, actionable error.
		if (!auth.accessToken) {
			outputChannel.appendLine(
				`AuthInfo: 'sf org display' returned no access token${targetOrg ? ` (${targetOrg})` : ""}. ` +
				`Update the Salesforce CLI, or set SF_TEMP_SHOW_SECRETS=true, then re-authenticate: sf org login web`
			);
			return null;
		}
		if (targetOrg) auth.alias = targetOrg;
		return auth;
	}

	/**
	 * Get auth for the default org (cached). Same as getAuthInfoForOrg(null).
	 */
	public static async getAuthInfo(): Promise<OrgAuth | null> {
		return this.getAuthInfoForOrg(null);
	}

	/**
	 * Get auth for an org: default when targetOrg is null/empty, otherwise that org by alias.
	 * Uses a single per-org cache; expired or missing entries are fetched and cached.
	 * Concurrent calls for the same org share one fetch.
	 */
	public static async getAuthInfoForOrg(targetOrg: string | null): Promise<OrgAuth | null> {
		if (!isSalesforceProject()) return null;

		const key = this.cacheKey(targetOrg);
		Logger.info(`Deploy: getAuthInfoForOrg(org=${targetOrg ?? "default"})`);

		const valid = this.getValidFromCache(key);
		if (valid) {
			Logger.info(`Deploy: auth from cache (${valid.username})`);
			return valid;
		}

		const existing = this.fetchLocks.get(key);
		if (existing) {
			Logger.info(`Deploy: auth fetch already in progress, awaiting`);
			return existing;
		}

		const doFetch = async (): Promise<OrgAuth | null> => {
			try {
				Logger.info(`Deploy: sending auth request (sf org display${targetOrg ? ` -o ${targetOrg}` : ""})`);
				const auth = await this.fetchOrgAuth(targetOrg);
				if (auth) {
					this.cache.set(key, auth);
					Logger.info(`Deploy: auth answer received, cached (${auth.username})`);
					outputChannel.appendLine(`AuthInfo: Cached ${auth.instanceUrl} (${auth.username})`);
				} else {
					Logger.info(`Deploy: auth answer failed (sf org display returned error)`);
				}
				return auth;
			} finally {
				this.fetchLocks.delete(key);
			}
		};

		const promise = doFetch();
		this.fetchLocks.set(key, promise);
		return promise;
	}

	/**
	 * Start fetching and caching org auth in the background so deploy can use it without delay.
	 * Call when the deploy panel is shown or when the user selects an org. No-op if already cached or already fetching.
	 */
	public static warmAuthForOrg(targetOrg: string | null): void {
		if (!isSalesforceProject()) return;
		const key = this.cacheKey(targetOrg);
		if (this.getValidFromCache(key)) return;
		if (this.fetchLocks.has(key)) return;
		void this.getAuthInfoForOrg(targetOrg);
	}

	/** Clear all cached auth. Call after login, set default org, or when tokens may have changed. */
	public static clearCache(): void {
		this.cache.clear();
		this.fetchLocks.clear();
	}

	/** Invalidate one org in the cache so the next getAuthInfoForOrg refetches. */
	public static invalidateOrg(targetOrg: string | null): void {
		const key = this.cacheKey(targetOrg);
		this.cache.delete(key);
	}

	/**
	 * Force the SF CLI to refresh the OAuth access token by running an authenticated
	 * CLI command. Unlike `sf org display`, commands like `sf org display user` make
	 * an actual authenticated API call through @salesforce/core. When that call returns
	 * 401, the CLI automatically uses the stored refresh token to obtain a new access
	 * token and writes it back to the SFDX auth store — regardless of the stored
	 * accessTokenExpiration timestamp. After this returns, `sf org display` will serve
	 * the newly-written token.
	 */
	private static async forceCliAuthRefresh(org: string | null): Promise<void> {
		const key = this.cacheKey(org);
		// Clear both cache and any in-flight dedup fetch so getAuthInfoForOrg always
		// starts a fresh sf org display call after the CLI refresh completes.
		this.cache.delete(key);
		this.fetchLocks.delete(key);
		const args = ["org", "display", "user", "--json"];
		if (org) args.push("--target-org", org);
		try {
			await runCommandArgs("sf", args);
		} catch {
			// Ignore — if the CLI refresh fails the subsequent getAuthInfoForOrg will
			// also fail, which is handled by the caller.
		}
		// Evict whatever was written to cache during the CLI call so getAuthInfoForOrg
		// re-reads the auth file with the token the CLI just refreshed.
		this.cache.delete(key);
		this.fetchLocks.delete(key);
	}

	/**
	 * Shared retry core for all authenticated HTTP calls. On 401, forces the CLI to
	 * refresh the token via its refresh-token flow, then re-fetches auth and retries
	 * the request once. If the retry also 401s, evicts the bad token and throws a
	 * user-friendly message. Callers pass an `execute` function that receives the
	 * current OrgAuth and performs the actual HTTP request.
	 */
	private static async withRetry<T>(
		org: string | null,
		execute: (auth: OrgAuth) => Promise<T>
	): Promise<{ result: T; auth: OrgAuth }> {
		const NO_CREDS = "Could not get org credentials. Set a default org or select one and try again.";
		let auth = await this.getAuthInfoForOrg(org);
		if (!auth) throw new Error(NO_CREDS);
		try {
			const result = await execute(auth);
			return { result, auth };
		} catch (e: any) {
			if (!(/HTTP 401/i.test(String(e?.message ?? "")))) throw e;

			// 401: run a CLI command that makes a real authenticated API call so that
			// @salesforce/core triggers its refresh-token flow and updates the auth store,
			// then re-fetch the now-fresh token and retry.
			await this.forceCliAuthRefresh(org);
			auth = await this.getAuthInfoForOrg(org);
			if (!auth) throw new Error(NO_CREDS);

			try {
				const result = await execute(auth);
				return { result, auth };
			} catch (retryErr: any) {
				// Retry also failed — evict the bad token so the next call does not serve
				// it from cache for the next 55 minutes.
				this.invalidateOrg(org);
				if (/HTTP 401/i.test(String(retryErr?.message ?? ""))) {
					throw new Error(
						"Salesforce session expired or revoked. Re-authenticate your org: sf org login web" +
							(org ? ` --target-org ${org}` : "")
					);
				}
				throw retryErr;
			}
		}
	}

	/**
	 * Authenticated GET. On 401, forces CLI token refresh and retries once.
	 * Use this for all Salesforce REST/Tooling API GET calls.
	 */
	public static async get(
		org: string | null,
		buildUrl: (auth: OrgAuth) => string
	): Promise<{ body: string; auth: OrgAuth }> {
		const { result: body, auth } = await this.withRetry(org, (a) =>
			httpsGet(buildUrl(a), a.accessToken)
		);
		return { body, auth };
	}

	/** Authenticated ranged GET (first `maxBytes`). On 401, refreshes and retries once. */
	public static async getRange(
		org: string | null,
		buildUrl: (auth: OrgAuth) => string,
		maxBytes: number
	): Promise<string> {
		const { result } = await this.withRetry(org, (a) => httpsGetRange(buildUrl(a), a.accessToken, maxBytes));
		return result;
	}

	/**
	 * Authenticated POST with a JSON body. On 401, forces CLI token refresh and
	 * retries once. Returns the response text.
	 */
	public static async post(
		org: string | null,
		buildUrl: (auth: OrgAuth) => string,
		body: unknown,
		contentType = "application/json"
	): Promise<string> {
		const payload = typeof body === "string" ? body : JSON.stringify(body);
		const { result } = await this.withRetry(org, (a) =>
			httpsPost(buildUrl(a), payload, { Authorization: `Bearer ${a.accessToken}`, "Content-Type": contentType })
		);
		return result;
	}

	/**
	 * Authenticated DELETE. On 401, forces CLI token refresh and retries once.
	 * Use this for all Salesforce REST/Tooling API DELETE calls.
	 */
	public static async delete(
		org: string | null,
		buildUrl: (auth: OrgAuth) => string
	): Promise<void> {
		await this.withRetry(org, (a) => httpsDelete(buildUrl(a), a.accessToken));
	}
}
