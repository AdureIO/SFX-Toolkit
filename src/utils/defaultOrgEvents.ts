import * as path from "path";
import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { setKnownTargetOrg, invalidateOrgListCache, refreshOrgListCache } from "./orgListCache";
import { OrgMetadataCache } from "./orgMetadataCache";
import { outputChannel } from "./outputChannel";
import { isWorkspaceUsable, primaryProjectRoot } from "./projectUtils";
import { invalidateOrgKeyCache } from "./orgKey";

/**
 * Single source of truth for "the default (target) org changed" — whether via this
 * extension's Set-as-Default command or an external `sf config set target-org` /
 * edit of `.sfdx/sfdx-config.json`. Listeners (the workbenches) realign their org
 * selector so what's shown always matches what runs, avoiding accidental actions
 * against the wrong org.
 */
const emitter = new vscode.EventEmitter<string | null>();
export const onDidChangeDefaultOrg = emitter.event;

/**
 * A nested / secondary sfdx project's default org changed (its own
 * `.sfdx/sfdx-config.json`). Fired with the project directory; the language client
 * refreshes just the documents of that project.
 */
const projectEmitter = new vscode.EventEmitter<string>();
export const onDidChangeProjectDefaultOrg = projectEmitter.event;

/** Last default username we observed; undefined until initialized. */
let lastKnown: string | null | undefined;

/** Drop what is keyed to "the default org" so the new default is resolved fresh. */
function invalidateDefaultCaches(): void {
	// Caches are keyed by username (canonicalOrgKey), so the previous default's data
	// stays valid for that org; only the null → username resolution must be redone.
	invalidateOrgKeyCache();
	invalidateOrgListCache();
	// Full change event: the language server drops per-document org contexts and the
	// stubs are regenerated for the new default.
	OrgMetadataCache.notifyDefaultOrgChanged();
}

/**
 * Announce a possible default-org change. No-op when it didn't actually change.
 * Pass the new username when known (Set-as-Default); otherwise it's re-resolved.
 */
export async function notifyDefaultOrgChanged(username?: string | null): Promise<void> {
	invalidateOrgKeyCache();
	const next = username !== undefined ? (username || null) : (resolveDefaultTargetOrgUsernameSync() ?? null);
	if (next === lastKnown) return;
	lastKnown = next;
	if (next) setKnownTargetOrg(next);
	invalidateDefaultCaches();
	try { await refreshOrgListCache(); } catch { /* keep going with whatever we have */ }
	// The org list (alias → username) may only now be known: re-resolve once more.
	invalidateOrgKeyCache();
	outputChannel.appendLine(`defaultOrg: default org changed → ${next ?? "(none)"}`);
	emitter.fire(next);
}

/** Live watchers on every project's SF config files, plus their debounce timers. */
let watchers: vscode.Disposable[] = [];
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function disposeWatchers(): void {
	for (const t of debounceTimers.values()) clearTimeout(t);
	debounceTimers.clear();
	for (const w of watchers) {
		try { w.dispose(); } catch { /* ignore */ }
	}
	watchers = [];
}

/** Project directory owning a `.sfdx/sfdx-config.json` or `.sf/config.json`. */
export function projectDirOfConfig(configPath: string): string {
	return path.dirname(path.dirname(configPath));
}

function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
	return process.platform === "win32" || process.platform === "darwin"
		? norm(a).toLowerCase() === norm(b).toLowerCase()
		: norm(a) === norm(b);
}

function onConfigChanged(uri: vscode.Uri): void {
	if (uri.scheme !== "file") return;
	if (/[\\/]node_modules[\\/]/.test(uri.fsPath)) return;
	const projectDir = projectDirOfConfig(uri.fsPath);
	const existing = debounceTimers.get(projectDir);
	if (existing) clearTimeout(existing);
	// Config writes can be multi-step; debounce so we read a settled file.
	debounceTimers.set(
		projectDir,
		setTimeout(() => {
			debounceTimers.delete(projectDir);
			invalidateOrgKeyCache(projectDir);
			if (samePath(projectDir, primaryProjectRoot())) {
				void notifyDefaultOrgChanged();
			} else {
				outputChannel.appendLine(`defaultOrg: project default org changed in ${projectDir}`);
				projectEmitter.fire(projectDir);
			}
		}, 250)
	);
}

/**
 * (Re)create config-file watchers for every workspace folder, covering nested
 * sfdx projects too (their `.sfdx/sfdx-config.json` at any depth), so each project's org context
 * follows its own config.
 */
function createWatchers(): void {
	disposeWatchers();
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		for (const pattern of ["**/.sfdx/sfdx-config.json", "**/.sf/config.json"]) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
			watchers.push(w, w.onDidCreate(onConfigChanged), w.onDidChange(onConfigChanged), w.onDidDelete(onConfigChanged));
		}
	}
}

/** Watch the SF config files so an external default-org switch is picked up live. */
export function initDefaultOrgWatcher(context: vscode.ExtensionContext): void {
	lastKnown = resolveDefaultTargetOrgUsernameSync() ?? null;
	context.subscriptions.push(emitter, projectEmitter, new vscode.Disposable(disposeWatchers));
	createWatchers();
}

/**
 * Re-root after a workspace-folder change (project switch in the same window):
 * watch the new folders' config files and re-resolve the default org, notifying
 * listeners when it differs from the previous project's.
 */
export function resetDefaultOrgWatcher(): void {
	createWatchers();
	invalidateOrgKeyCache();
	// Outside an SFDX project there is no default org to resolve (and no CLI to spawn).
	if (isWorkspaceUsable()) void notifyDefaultOrgChanged();
	else lastKnown = undefined;
}
