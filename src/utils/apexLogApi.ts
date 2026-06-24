/**
 * REST helpers for the Apex Workbench log browser: list debug logs and fetch a
 * log body for any org via AuthInfo (so the workbench's org switcher can show
 * logs from environments other than the default).
 */
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";

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
