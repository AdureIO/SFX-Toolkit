/**
 * REST helpers for the Apex Workbench log browser: list debug logs and fetch a
 * log body for any org via AuthInfo (so the workbench's org switcher can show
 * logs from environments other than the default).
 */
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion, getQuickTraceDuration, getQuickTraceDebugLevel } from "./constants";
import { outputChannel } from "./outputChannel";

const base = (a: { instanceUrl: string }) => a.instanceUrl.replace(/\/$/, "");

export interface ApexLogRow {
	id: string;
	startTime: string;
	operation: string;
	status: string;
	length: number;
	user: string;
}

/** Most recent debug logs for an org (newest first). `org` null = default org. */
export async function listApexLogs(org: string | null, limit = 50): Promise<ApexLogRow[]> {
	const version = getToolingApiVersion();
	const q =
		"SELECT Id, Operation, Status, LogLength, StartTime, LogUser.Name " +
		`FROM ApexLog ORDER BY StartTime DESC LIMIT ${Math.max(1, Math.min(200, limit))}`;
	try {
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/tooling/query/?q=${encodeURIComponent(q)}`
		);
		const records: any[] = JSON.parse(body).records ?? [];
		return records.map((r) => ({
			id: r.Id,
			startTime: r.StartTime ?? "",
			operation: r.Operation ?? "",
			status: r.Status ?? "",
			length: typeof r.LogLength === "number" ? r.LogLength : 0,
			user: r.LogUser?.Name ?? "",
		}));
	} catch (e: any) {
		outputChannel.appendLine(`apexLogApi: listApexLogs failed: ${e?.message ?? e}`);
		return [];
	}
}

export interface TraceSummary {
	count: number;
	nearestExpiry: string | null;
}

/** Active debug TraceFlags for an org (count + nearest expiry). */
export async function listActiveTraceFlags(org: string | null): Promise<TraceSummary> {
	const version = getToolingApiVersion();
	const q =
		"SELECT Id, ExpirationDate FROM TraceFlag WHERE ExpirationDate > " +
		new Date().toISOString().replace(/\.\d{3}Z$/, "Z") +
		" ORDER BY ExpirationDate ASC";
	try {
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/tooling/query/?q=${encodeURIComponent(q)}`
		);
		const records: any[] = JSON.parse(body).records ?? [];
		return { count: records.length, nearestExpiry: records[0]?.ExpirationDate ?? null };
	} catch (e: any) {
		outputChannel.appendLine(`apexLogApi: listActiveTraceFlags failed: ${e?.message ?? e}`);
		return { count: 0, nearestExpiry: null };
	}
}

async function toolingQueryIds(org: string | null, soql: string): Promise<string[]> {
	const version = getToolingApiVersion();
	try {
		const { body } = await AuthInfo.get(org, (a) =>
			`${base(a)}/services/data/${version}/tooling/query/?q=${encodeURIComponent(soql)}`
		);
		return (JSON.parse(body).records ?? []).map((r: any) => r.Id);
	} catch {
		return [];
	}
}

/** Delete all debug logs for an org (in small parallel batches). Returns count deleted. */
export async function deleteAllApexLogs(org: string | null): Promise<number> {
	const version = getToolingApiVersion();
	let deleted = 0;
	// Loop in case there are more than one page worth.
	for (let guard = 0; guard < 50; guard++) {
		const ids = await toolingQueryIds(org, "SELECT Id FROM ApexLog LIMIT 200");
		if (!ids.length) break;
		for (let i = 0; i < ids.length; i += 5) {
			const slice = ids.slice(i, i + 5);
			const res = await Promise.allSettled(
				slice.map((id) => AuthInfo.delete(org, (a) => `${base(a)}/services/data/${version}/tooling/sobjects/ApexLog/${id}`))
			);
			deleted += res.filter((r) => r.status === "fulfilled").length;
		}
		if (ids.length < 200) break;
	}
	return deleted;
}

/** Current user's Id for an org (via the OAuth userinfo endpoint). */
async function currentUserId(org: string | null): Promise<string | null> {
	try {
		const { body } = await AuthInfo.get(org, (a) => `${base(a)}/services/oauth2/userinfo`);
		return (JSON.parse(body).user_id as string) || null;
	} catch {
		return null;
	}
}

/**
 * Create a USER_DEBUG TraceFlag for the current user on `org`, scoped to that org.
 * Replaces any existing trace flags for the user. `durationMinutes` defaults to
 * the configured quick-trace duration. Returns true on success.
 */
export async function createUserTrace(org: string | null, durationMinutes?: number): Promise<boolean> {
	const version = getToolingApiVersion();
	const userId = await currentUserId(org);
	if (!userId) {
		outputChannel.appendLine("apexLogApi: createUserTrace — could not resolve current user id");
		return false;
	}

	// DebugLevel: configured one, else any available.
	const debugLevelId =
		(await toolingQueryIds(org, `SELECT Id FROM DebugLevel WHERE DeveloperName = '${getQuickTraceDebugLevel().replace(/'/g, "")}'`))[0] ??
		(await toolingQueryIds(org, "SELECT Id FROM DebugLevel LIMIT 1"))[0];
	if (!debugLevelId) {
		outputChannel.appendLine("apexLogApi: createUserTrace — no DebugLevel found");
		return false;
	}

	// Remove the user's existing trace flags to avoid overlap errors.
	const existing = await toolingQueryIds(org, `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}'`);
	await Promise.allSettled(
		existing.map((id) => AuthInfo.delete(org, (a) => `${base(a)}/services/data/${version}/tooling/sobjects/TraceFlag/${id}`))
	);

	const now = Date.now();
	const minutes = typeof durationMinutes === "number" && durationMinutes > 0 ? durationMinutes : getQuickTraceDuration();
	try {
		await AuthInfo.post(
			org,
			(a) => `${base(a)}/services/data/${version}/tooling/sobjects/TraceFlag`,
			{
				DebugLevelId: debugLevelId,
				LogType: "USER_DEBUG",
				TracedEntityId: userId,
				StartDate: new Date(now).toISOString(),
				ExpirationDate: new Date(now + minutes * 60000).toISOString(),
			}
		);
		return true;
	} catch (e: any) {
		outputChannel.appendLine(`apexLogApi: createUserTrace failed: ${e?.message ?? e}`);
		return false;
	}
}

/**
 * The entry-point code unit of a debug log (what was actually run) from the first
 * CODE_UNIT_STARTED line — e.g. "MyClass.myMethod", "execute_anonymous_apex",
 * "MyTrigger on Account trigger event BeforeInsert". Null if not present.
 */
export function extractCodeUnit(logBody: string): string | null {
	const line = /^.*\|CODE_UNIT_STARTED\|.*$/m.exec(logBody)?.[0];
	if (!line) return null;
	const parts = line.split("|");
	const name = (parts[parts.length - 1] || "").trim();
	return name || null;
}

/** Raw debug-log body for a log id on an org. */
export async function fetchApexLogBody(org: string | null, logId: string): Promise<string> {
	const version = getToolingApiVersion();
	try {
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/tooling/sobjects/ApexLog/${logId}/Body`
		);
		return body;
	} catch (e: any) {
		outputChannel.appendLine(`apexLogApi: fetchApexLogBody failed: ${e?.message ?? e}`);
		return "";
	}
}
