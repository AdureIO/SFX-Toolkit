import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { setKnownTargetOrg, invalidateOrgListCache, refreshOrgListCache } from "./orgListCache";
import { AuthInfo } from "./authInfo";
import { OrgMetadataCache } from "./orgMetadataCache";
import { outputChannel } from "./outputChannel";

/**
 * Single source of truth for "the default (target) org changed" — whether via this
 * extension's Set-as-Default command or an external `sf config set target-org` /
 * edit of `.sfdx/sfdx-config.json`. Listeners (the workbenches) realign their org
 * selector so what's shown always matches what runs, avoiding accidental actions
 * against the wrong org.
 */
const emitter = new vscode.EventEmitter<string | null>();
export const onDidChangeDefaultOrg = emitter.event;

/** Last default username we observed; undefined until initialized. */
let lastKnown: string | null | undefined;

/** Drop caches keyed to the default org so the new default's data is fetched fresh. */
function invalidateDefaultCaches(): void {
	AuthInfo.invalidateOrg(null);
	OrgMetadataCache.invalidate(null); // also clears DescribeStore(default) + refreshes the language server
	invalidateOrgListCache();
}

/**
 * Announce a possible default-org change. No-op when it didn't actually change.
 * Pass the new username when known (Set-as-Default); otherwise it's re-resolved.
 */
export async function notifyDefaultOrgChanged(username?: string | null): Promise<void> {
	const next = username !== undefined ? (username || null) : (resolveDefaultTargetOrgUsernameSync() ?? null);
	if (next === lastKnown) return;
	lastKnown = next;
	if (next) setKnownTargetOrg(next);
	invalidateDefaultCaches();
	try { await refreshOrgListCache(); } catch { /* keep going with whatever we have */ }
	outputChannel.appendLine(`defaultOrg: default org changed → ${next ?? "(none)"}`);
	emitter.fire(next);
}

/** Watch the SF config files so an external default-org switch is picked up live. */
export function initDefaultOrgWatcher(context: vscode.ExtensionContext): void {
	lastKnown = resolveDefaultTargetOrgUsernameSync() ?? null;
	context.subscriptions.push(emitter);

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (timer) clearTimeout(timer);
		// Config writes can be multi-step; debounce so we read a settled file.
		timer = setTimeout(() => { void notifyDefaultOrgChanged(); }, 250);
	};

	for (const pattern of [".sfdx/sfdx-config.json", ".sf/config.json"]) {
		const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
		w.onDidCreate(schedule);
		w.onDidChange(schedule);
		w.onDidDelete(schedule);
		context.subscriptions.push(w);
	}
}
