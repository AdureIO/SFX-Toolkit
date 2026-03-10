import * as vscode from "vscode";
import * as path from "path";

export type DeployTypeKey = "RunAllTestsInOrg" | "RunSpecifiedTests" | "ValidateOnly" | "NoTestRun";

export interface DeployPreset {
	name: string;
	/** Paths to deploy: dirs (e.g. force-app/main/default) or files. Empty = entire project. */
	sourcePaths: string[];
	/** @deprecated Use sourcePaths. Migrated on load when present. */
	classPaths?: string[];
	deployType: DeployTypeKey;
	/** Apex class names for RunSpecifiedTests (e.g. MyTestClass) */
	testClassNames: string[];
}

interface PresetsFile {
	presets: DeployPreset[];
}

const PRESETS_FILE = ".vscode/deploy-presets.json";

function getPresetsUri(workspaceRoot: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(workspaceRoot, PRESETS_FILE);
}

export async function loadPresets(workspaceRoot: vscode.Uri): Promise<DeployPreset[]> {
	const uri = getPresetsUri(workspaceRoot);
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		const json = JSON.parse(new TextDecoder().decode(data)) as PresetsFile & { presets?: Array<DeployPreset & { classPaths?: string[] }> };
		const raw = Array.isArray(json.presets) ? json.presets : [];
		return raw.map((p) => {
			const sourcePaths = Array.isArray(p.sourcePaths) ? p.sourcePaths : (Array.isArray((p as any).classPaths) ? (p as any).classPaths : []);
			return { ...p, sourcePaths };
		});
	} catch {
		return [];
	}
}

export async function savePresets(
	workspaceRoot: vscode.Uri,
	presets: DeployPreset[]
): Promise<void> {
	const uri = getPresetsUri(workspaceRoot);
	const dir = vscode.Uri.joinPath(workspaceRoot, ".vscode");
	await vscode.workspace.fs.createDirectory(dir);
	const content = JSON.stringify({ presets }, null, 2);
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}

export async function addPreset(
	workspaceRoot: vscode.Uri,
	preset: DeployPreset
): Promise<void> {
	const presets = await loadPresets(workspaceRoot);
	const existing = presets.findIndex((p) => p.name === preset.name);
	if (existing >= 0) presets[existing] = preset;
	else presets.push(preset);
	await savePresets(workspaceRoot, presets);
}

export async function deletePreset(
	workspaceRoot: vscode.Uri,
	presetName: string
): Promise<void> {
	const presets = await loadPresets(workspaceRoot);
	const filtered = presets.filter((p) => p.name !== presetName);
	await savePresets(workspaceRoot, filtered);
}
