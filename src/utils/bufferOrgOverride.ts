/**
 * Lets a webview editor pin its IntelliSense (completion/hover schema) to a
 * specific org, independent of the document's project default org. The ASFX
 * Workbench sets this for its Apex/SOQL buffers when you switch org in the
 * panel, so completion reflects the chosen environment.
 *
 * Keyed by the buffer file's fsPath (the virtual `asfx-buffer:` documents use the
 * same path, so `Uri.parse(uri).fsPath` resolves either). Value is the target org
 * username, or null for the default org. Absence means "no override — resolve
 * normally" (which, for a buffer, is the default org too).
 */
const overrides = new Map<string, string | null>();

/**
 * Set the override. Returns true when the EFFECTIVE org changed (no override and
 * an explicit null both mean "default org"), so callers only refresh the language
 * server's schema when something actually changed.
 */
export function setBufferOrgOverride(fsPath: string, org: string | null): boolean {
	const prev = overrides.has(fsPath) ? overrides.get(fsPath) ?? null : null;
	overrides.set(fsPath, org);
	return prev !== org;
}

export function clearBufferOrgOverride(fsPath: string): void {
	overrides.delete(fsPath);
}

/** `{ has }` distinguishes "no override" from "override = default org (null)". */
export function getBufferOrgOverride(fsPath: string): { has: boolean; org: string | null } {
	return overrides.has(fsPath) ? { has: true, org: overrides.get(fsPath) ?? null } : { has: false, org: null };
}
