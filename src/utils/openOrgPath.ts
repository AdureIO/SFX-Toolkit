import { runCommandArgs } from "./commandRunner";

/** `sf org open --path <path> [--target-org <org>]`: open a page of the org in the browser. Rejects when the CLI fails. */
export async function openOrgPath(orgArg: string | null, path: string, cwd?: string): Promise<void> {
	const args = ["org", "open", "--path", path];
	if (orgArg) args.push("--target-org", orgArg);
	await runCommandArgs("sf", args, cwd, undefined, false);
}
