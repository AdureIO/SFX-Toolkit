/**
 * Lets a webview editor pin its IntelliSense (completion/hover schema) to a
 * specific org, independent of the document's project default org. The ASFX
 * Workbench sets this for its hidden Apex/SOQL buffers when you switch org in
 * the panel, so completion reflects the chosen environment.
 *
 * Keyed by the buffer file's fsPath. Value is the target org username, or null
 * for the default org. Absence means "no override — resolve normally".
 */
const overrides = new Map<string, string | null>();

export function setBufferOrgOverride(fsPath: string, org: string | null): void {
	overrides.set(fsPath, org);
}

export function clearBufferOrgOverride(fsPath: string): void {
	overrides.delete(fsPath);
}

/** `{ has }` distinguishes "no override" from "override = default org (null)". */
export function getBufferOrgOverride(fsPath: string): { has: boolean; org: string | null } {
	return overrides.has(fsPath) ? { has: true, org: overrides.get(fsPath) ?? null } : { has: false, org: null };
}
