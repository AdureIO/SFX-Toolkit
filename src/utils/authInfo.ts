import { runCommandArgs } from "./commandRunner";
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
    orgId: parsed.id,
    expiresAt
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
      outputChannel.appendLine(
        `AuthInfo: sf org display failed${targetOrg ? ` (${targetOrg})` : ""}: ${parsed.message || "Unknown"}`
      );
      return null;
    }
    const auth = buildOrgAuth(parsed.result);
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
}
