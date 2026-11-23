/**
 * Deploy & Retrieve Center history (extension host): `globalStorage/history/<sha1(projectDir)[0:12]>.json`,
 * newest first, capped at 200 entries per project, written debounced and flushed on deactivate.
 *
 *   recordHistory(projectDir, entry)   add an entry (never throws)
 *   getHistory(projectDir)             the project's entries, newest first
 *   onDidChangeHistory                 fires with the project dir after an entry was added or the history cleared
 */
import * as path from "path";
import * as vscode from "vscode";
import { HistoryEntry, NewHistoryEntry } from "./historyPure";
import { HistoryStore } from "./historyStore";
import { Logger } from "./outputChannel";

let store: HistoryStore | undefined;
const emitter = new vscode.EventEmitter<string>();

/** Fires with the project dir whose history changed. */
export const onDidChangeHistory: vscode.Event<string> = emitter.event;

/** Call once on activation. */
export function initSyncHistory(context: vscode.ExtensionContext): void {
	store = new HistoryStore(path.join(context.globalStorageUri.fsPath, "history"), { onChange: (dir) => emitter.fire(dir) });
}

/** Write pending changes now (deactivate). */
export function flushSyncHistory(): void {
	store?.flush();
}

/** Add an entry (newest first; the id is generated). Does nothing before `initSyncHistory`. Never throws. */
export function recordHistory(projectDir: string, entry: NewHistoryEntry): HistoryEntry | undefined {
	if (!store) return undefined;
	try {
		return store.add(projectDir, entry);
	} catch (e) {
		Logger.info(`History: could not record an entry: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
		return undefined;
	}
}

/** The project's history, newest first. */
export function getHistory(projectDir: string): HistoryEntry[] {
	return store ? [...store.get(projectDir)] : [];
}

/** Forget a project's history. */
export function clearHistory(projectDir: string): void {
	store?.clear(projectDir);
}
