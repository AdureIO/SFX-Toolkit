import * as vscode from "vscode";

export type DeployTypeKey =
  | "RunAllTestsInOrg"
  | "RunRelevantTests"
  | "RunSpecifiedTests"
  | "ValidateOnly"
  | "NoTestRun";

export interface DeployPreset {
  name: string;
  /**
   * The components to deploy (`Type:fullName`), exactly: each deploys its own files. Written by the Deploy
   * panel; a preset without it (older versions) is mapped from `sourcePaths` through the local index on load.
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

interface PresetsFile {
  presets: DeployPreset[];
}

function getPresetsUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot, ".vscode", "deploy-presets.json");
}

export async function loadPresets(workspaceRoot: vscode.Uri): Promise<DeployPreset[]> {
  const uri = getPresetsUri(workspaceRoot);
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    const json = JSON.parse(new TextDecoder().decode(data)) as PresetsFile & {
      presets?: Array<DeployPreset & { classPaths?: string[] }>;
    };
    const raw = Array.isArray(json.presets) ? json.presets : [];
    return raw.map((p) => {
      const sourcePaths = Array.isArray(p.sourcePaths)
        ? p.sourcePaths
        : Array.isArray((p as any).classPaths)
          ? (p as any).classPaths
          : [];
      return { ...p, sourcePaths };
    });
  } catch {
    return [];
  }
}

export async function savePresets(workspaceRoot: vscode.Uri, presets: DeployPreset[]): Promise<void> {
  const uri = getPresetsUri(workspaceRoot);
  const dir = vscode.Uri.joinPath(workspaceRoot, ".vscode");
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch (e) {
    throw new Error(`Cannot create .vscode directory: ${e instanceof Error ? e.message : String(e)}`);
  }
  const content = JSON.stringify({ presets }, null, 2);
  const bytes = new TextEncoder().encode(content);
  try {
    await vscode.workspace.fs.writeFile(uri, bytes);
  } catch (e) {
    throw new Error(`Cannot write presets file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function addPreset(workspaceRoot: vscode.Uri, preset: DeployPreset): Promise<void> {
  if (!preset?.name?.trim()) {
    throw new Error("Preset name is required.");
  }
  const normalized: DeployPreset = {
    name: preset.name.trim(),
    sourcePaths: Array.isArray(preset.sourcePaths) ? preset.sourcePaths : [],
    ...(Array.isArray(preset.components) ? { components: preset.components } : {}),
    deployType: preset.deployType || "RunRelevantTests",
    testClassNames: Array.isArray(preset.testClassNames) ? preset.testClassNames : [],
    targetOrg: preset.targetOrg || undefined
  };
  const presets = await loadPresets(workspaceRoot);
  const existing = presets.findIndex((p) => p.name === normalized.name);
  if (existing >= 0) presets[existing] = normalized;
  else presets.push(normalized);
  await savePresets(workspaceRoot, presets);
}

export async function deletePreset(workspaceRoot: vscode.Uri, presetName: string): Promise<void> {
  const presets = await loadPresets(workspaceRoot);
  const filtered = presets.filter((p) => p.name !== presetName);
  await savePresets(workspaceRoot, filtered);
}
