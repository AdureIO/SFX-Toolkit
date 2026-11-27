/**
 * Deploy presets (shared by Deploy & Retrieve Metadata): the preset type, reading the
 * file format of every version (migration) and the list operations. Pure (no `vscode`, no I/O).
 */

export type DeployTypeKey = "RunAllTestsInOrg" | "RunRelevantTests" | "RunSpecifiedTests" | "ValidateOnly" | "NoTestRun";

export interface DeployPreset {
	name: string;
	/**
	 * The components of the preset (`Type:fullName`), exactly: each deploys its own files. Written by the Deploy
	 * panel and the Center; a preset without it (older versions) is mapped from `sourcePaths` through the local
	 * index when it is loaded (`presetComponents`).
	 */
	components?: string[];
	/**
	 * Old: paths to deploy (dirs or files). New presets still write the files of their components here
	 * (what older versions of the panel read); `components` is authoritative when present.
	 */
	sourcePaths: string[];
	/** @deprecated Use sourcePaths. Migrated on load when present. */
	classPaths?: string[];
	deployType: DeployTypeKey;
	/** Apex class names for RunSpecifiedTests (e.g. MyTestClass) */
	testClassNames: string[];
	/** Target org username (e.g. for sf -o). Optional. */
	targetOrg?: string;
}

/** The file of a project: `<projectDir>/.vscode/deploy-presets.json` (the storage every version has used). */
export const PRESETS_DIR = ".vscode";
export const PRESETS_FILE = "deploy-presets.json";

const DEPLOY_TYPES: readonly string[] = ["RunAllTestsInOrg", "RunRelevantTests", "RunSpecifiedTests", "ValidateOnly", "NoTestRun"];

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * One stored preset in today's shape: `classPaths` (the oldest format) becomes `sourcePaths`, a missing or
 * unknown `deployType` becomes RunRelevantTests, list fields become string lists. Other fields (e.g.
 * `validateOnly`) are kept. A preset without a name is dropped (undefined).
 */
export function migratePreset(raw: unknown): DeployPreset | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const p = raw as Record<string, unknown>;
	if (typeof p.name !== "string" || !p.name.trim()) return undefined;
	const { classPaths, ...rest } = p;
	const sourcePaths = Array.isArray(p.sourcePaths) ? strings(p.sourcePaths) : strings(classPaths);
	const out: DeployPreset = {
		...(rest as unknown as DeployPreset),
		name: p.name,
		sourcePaths,
		deployType: DEPLOY_TYPES.includes(p.deployType as string) ? (p.deployType as DeployTypeKey) : "RunRelevantTests",
		testClassNames: strings(p.testClassNames),
	};
	if (Array.isArray(p.components)) out.components = strings(p.components);
	else delete out.components;
	if (typeof p.targetOrg !== "string" || !p.targetOrg) delete out.targetOrg;
	return out;
}

/** The presets of a file's text; a missing, damaged or foreign file gives []. */
export function parsePresetsFile(text: string | undefined): DeployPreset[] {
	if (!text) return [];
	try {
		const json = JSON.parse(text) as { presets?: unknown };
		const raw = Array.isArray(json?.presets) ? json.presets : [];
		return raw.map(migratePreset).filter((p): p is DeployPreset => !!p);
	} catch {
		return [];
	}
}

export function serializePresets(presets: readonly DeployPreset[]): string {
	return JSON.stringify({ presets }, null, 2);
}

/** A preset to store: trimmed name, default test level, list fields present. Throws without a name. */
export function normalizeForSave(preset: Partial<DeployPreset> & { name?: string }): DeployPreset {
	const name = preset?.name?.trim();
	if (!name) throw new Error("Preset name is required.");
	const { classPaths: _drop, ...rest } = preset as DeployPreset;
	void _drop;
	return {
		...rest,
		name,
		sourcePaths: Array.isArray(preset.sourcePaths) ? preset.sourcePaths : [],
		...(Array.isArray(preset.components) ? { components: preset.components } : {}),
		deployType: preset.deployType || "RunRelevantTests",
		testClassNames: Array.isArray(preset.testClassNames) ? preset.testClassNames : [],
		targetOrg: preset.targetOrg || undefined,
	};
}

/** The list with `preset` added, or replacing the one of the same name (position kept). */
export function upsertPreset(list: readonly DeployPreset[], preset: DeployPreset): DeployPreset[] {
	const i = list.findIndex((p) => p.name === preset.name);
	if (i < 0) return [...list, preset];
	const next = [...list];
	next[i] = preset;
	return next;
}

export function removePreset(list: readonly DeployPreset[], name: string): DeployPreset[] {
	return list.filter((p) => p.name !== name);
}

/** Rename; throws when `from` does not exist or `to` is empty or already taken by another preset. */
export function renameInList(list: readonly DeployPreset[], from: string, to: string): DeployPreset[] {
	const name = to.trim();
	if (!name) throw new Error("Preset name is required.");
	if (!list.some((p) => p.name === from)) throw new Error(`Preset "${from}" does not exist.`);
	if (name !== from && list.some((p) => p.name === name)) throw new Error(`A preset named "${name}" already exists.`);
	return list.map((p) => (p.name === from ? { ...p, name } : p));
}
