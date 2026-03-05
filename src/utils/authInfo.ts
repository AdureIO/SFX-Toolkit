import { runCommand } from "./commandRunner";
import { outputChannel } from "./outputChannel";
import { isSalesforceProject } from "./projectUtils";

/** Default: consider token expired after 55 minutes so we refresh before typical 2h OAuth expiry. */
const AUTH_VALID_MS = 55 * 60 * 1000;

interface OrgAuth {
	accessToken: string;
	instanceUrl: string;
	username: string;
	orgId: string;
	/** Timestamp (ms) after which this auth is considered expired and must be refreshed. */
	expiresAt: number;
}

export class AuthInfo {
	private static cachedAuth: OrgAuth | null = null;
	private static isFetching = false;

	/** Returns cached auth only if present and not expired. */
	private static getValidCache(): OrgAuth | null {
		const c = this.cachedAuth;
		return c && Date.now() < c.expiresAt ? c : null;
	}

	/** True if we have valid (non-expired) cached auth ready to use. */
	public static hasValidCache(): boolean {
		return this.getValidCache() !== null;
	}

	public static async getAuthInfo(): Promise<OrgAuth | null> {
		if (!isSalesforceProject()) {
			return null;
		}
		const valid = this.getValidCache();
		if (valid) return valid;

		if (this.isFetching) {
			await new Promise((r) => setTimeout(r, 1000));
			const afterWait = this.getValidCache();
			if (afterWait) return afterWait;
		}

		this.isFetching = true;
		try {
			outputChannel.appendLine("AuthInfo: Retrieving Org credentials for faster API access...");
			const result = await runCommand("sf org display --json");
			const parsed = JSON.parse(result);

			if (parsed.status === 0 && parsed.result) {
				const expiresAt = parseExpiration(parsed.result) ?? Date.now() + AUTH_VALID_MS;
				this.cachedAuth = {
					accessToken: parsed.result.accessToken,
					instanceUrl: parsed.result.instanceUrl,
					username: parsed.result.username,
					orgId: parsed.result.id,
					expiresAt,
				};
				outputChannel.appendLine(`AuthInfo: Connected to ${this.cachedAuth.instanceUrl} (cached until refresh)`);
				return this.cachedAuth;
			} else {
				outputChannel.appendLine(`AuthInfo Failed: ${parsed.message}`);
				return null;
			}
		} catch (e) {
			outputChannel.appendLine(`AuthInfo Error: ${e}`);
			return null;
		} finally {
			this.isFetching = false;
		}
	}

	public static clearCache(): void {
		this.cachedAuth = null;
	}
}

/** If the CLI returns an expiration, use it; otherwise return undefined for default. */
function parseExpiration(result: { accessTokenExpiration?: string }): number | undefined {
	const exp = result.accessTokenExpiration;
	if (!exp) return undefined;
	const t = new Date(exp).getTime();
	if (!Number.isNaN(t)) return t;
	return undefined;
}
