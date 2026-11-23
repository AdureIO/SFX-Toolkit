import { AuthInfo } from "../authInfo";

/** The org user of the connection (`Id`, `Name`), for the "Modified by me" filter. Throws when the org cannot be asked. */
export async function resolveCurrentUser(orgArg: string | null, apiVersion: string): Promise<{ ids: string[]; name: string }> {
	const { body } = await AuthInfo.get(orgArg, (a) => {
		const soql = `SELECT Id, Name FROM User WHERE Username = '${a.username.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' LIMIT 1`;
		return `${a.instanceUrl}/services/data/v${apiVersion}/query?q=${encodeURIComponent(soql)}`;
	});
	const rec = JSON.parse(body)?.records?.[0];
	return { ids: rec?.Id ? [rec.Id] : [], name: rec?.Name ?? "" };
}
