import { runCommand } from './commandRunner';

export interface DefaultOrgInfo {
	displayName: string;
	username: string;
}

export async function getDefaultOrg(): Promise<DefaultOrgInfo | null> {
	try {
		const output = await runCommand('sf org list --json', undefined, undefined, false);
		const json = JSON.parse(output);
		if (json.status !== 0 || !json.result) {
			return null;
		}
		const { nonScratchOrgs = [], scratchOrgs = [] } = json.result;
		const all: { alias?: string; username: string; isDefaultUsername?: boolean }[] = [
			...(nonScratchOrgs as any[]),
			...(scratchOrgs as any[])
		];
		const defaultOrg = all.find((o: any) => o.isDefaultUsername && o.username);
		if (!defaultOrg) {
			return null;
		}
		const displayName = defaultOrg.alias || defaultOrg.username.split('@')[0] || defaultOrg.username;
		return { displayName, username: defaultOrg.username };
	} catch {
		return null;
	}
}
