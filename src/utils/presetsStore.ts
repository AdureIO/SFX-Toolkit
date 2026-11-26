/**
 * Deploy presets of a project, shared by Deploy & Retrieve Metadata.
 *
 * Storage is the file every version has used (`<project>/.vscode/deploy-presets.json`, so presets stay in git
 * and existing users keep theirs); older formats are migrated when read (`migratePreset`), the file is
 * rewritten in today's shape on the next save. Writes of one project are serialized. No `vscode`.
 *
 *   listPresets(projectDir)                    all presets, in file order
 *   savePreset(projectDir, preset)             add, or replace the one of the same name
 *   deletePreset(projectDir, name)             true when it existed
 *   renamePreset(projectDir, from, to)         throws when missing or the new name is taken
 *   onDidChangePresets(listener)               fires with the project dir after any of the three changed the file
 *
 * A preset's `components` are `Type:fullName` keys (a preset of an older version has only `sourcePaths`: map
 * it with `presetComponents` from deployComponentsPure).
 */
import * as fs from "fs";
import * as path from "path";
import {
	DeployPreset,
	PRESETS_DIR,
	PRESETS_FILE,
	normalizeForSave,
	parsePresetsFile,
	removePreset,
	renameInList,
	serializePresets,
	upsertPreset,
} from "./presetsPure";

export type { DeployPreset, DeployTypeKey } from "./presetsPure";

export function presetsFileOf(projectDir: string): string {
	return path.join(projectDir, PRESETS_DIR, PRESETS_FILE);
}

type Listener = (projectDir: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to preset changes made through this store. */
export function onDidChangePresets(listener: Listener): { dispose(): void } {
	listeners.add(listener);
	return { dispose: () => void listeners.delete(listener) };
}

function fire(projectDir: string): void {
	for (const l of [...listeners]) {
		try {
			l(projectDir);
		} catch {
			/* a listener never breaks a save */
		}
	}
}

export async function listPresets(projectDir: string): Promise<DeployPreset[]> {
	try {
		return parsePresetsFile(await fs.promises.readFile(presetsFileOf(projectDir), "utf8"));
	} catch {
		return [];
	}
}

async function write(projectDir: string, presets: DeployPreset[]): Promise<void> {
	try {
		await fs.promises.mkdir(path.join(projectDir, PRESETS_DIR), { recursive: true });
	} catch (e) {
		throw new Error(`Cannot create .vscode directory: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		await fs.promises.writeFile(presetsFileOf(projectDir), serializePresets(presets), "utf8");
	} catch (e) {
		throw new Error(`Cannot write presets file: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Per project: the tail of the chain of read-modify-write operations (two quick saves never overwrite each other). */
const chains = new Map<string, Promise<unknown>>();

function modify<T>(projectDir: string, fn: (list: DeployPreset[]) => { next: DeployPreset[]; result: T } | { result: T; next?: undefined }): Promise<T> {
	const prev = chains.get(projectDir) ?? Promise.resolve();
	const run = prev
		.catch(() => undefined)
		.then(async () => {
			const out = fn(await listPresets(projectDir));
			if (out.next) {
				await write(projectDir, out.next);
				fire(projectDir);
			}
			return out.result;
		});
	chains.set(projectDir, run);
	return run;
}

/** Add a preset, or replace the one of the same name. Returns what was stored. */
export async function savePreset(projectDir: string, preset: Partial<DeployPreset> & { name: string }): Promise<DeployPreset> {
	const normalized = normalizeForSave(preset);
	return await modify(projectDir, (list) => ({ next: upsertPreset(list, normalized), result: normalized }));
}

/** Delete a preset by name. Resolves false when there was none. */
export function deletePreset(projectDir: string, name: string): Promise<boolean> {
	return modify(projectDir, (list) => {
		const next = removePreset(list, name);
		return next.length === list.length ? { result: false } : { next, result: true };
	});
}

/** Rename a preset. Rejects when `from` does not exist or `to` is empty or taken. */
export function renamePreset(projectDir: string, from: string, to: string): Promise<DeployPreset> {
	return modify(projectDir, (list) => {
		const next = renameInList(list, from, to);
		return { next, result: next.find((p) => p.name === to.trim())! };
	});
}
