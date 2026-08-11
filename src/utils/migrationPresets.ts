/**
 * Where migration presets live, and what is on disk.
 *
 * Two scopes, because the two kinds of preset are genuinely different: one describes objects and
 * fields of *this* project and belongs beside its source, the other is a way of working the user
 * carries between projects. No `vscode` import, so the resolution and listing are unit-testable.
 */

import * as fs from "fs";
import * as path from "path";

export type PresetScope = "project" | "global";

export const PRESET_SUFFIX = ".migration.json";

export interface PresetDirs {
  /** Beside the project's source, so it can be committed and shared with the team. */
  project: string;
  /** The user's own, available in every project on this machine. */
  global: string;
}

/**
 * `globalStorageDir` is the extension's own global storage path, which VS Code manages and keeps
 * out of any project. It is passed in rather than derived so this module needs no `vscode` import
 * and stays testable.
 *
 * Project presets live under `config/`, not `.sfdx/`: the scaffold that `sf project generate`
 * produces gitignores `.sfdx`, so a preset there could not be committed — which is the whole
 * point of the project scope. `config/` is tracked by default.
 */
export function presetDirs(workspaceRoot: string, globalStorageDir: string): PresetDirs {
  return {
    project: path.join(workspaceRoot, "config", "asfx", "migrations"),
    global: path.join(globalStorageDir, "migrations")
  };
}

/**
 * Where presets used to be written. Still read, so an upgrade does not appear to lose them.
 */
export function legacyPresetDirs(workspaceRoot: string): string[] {
  return [
    path.join(workspaceRoot, ".sfdx", "asfx", "migrations"),
    path.join(workspaceRoot, ".sfdx", "asfx")
  ];
}

export interface PresetEntry {
  /** The preset's own name, from the file it was saved as. */
  name: string;
  scope: PresetScope;
  filePath: string;
  /** Epoch millis of the last write, for newest-first ordering. */
  modified: number;
}

/** A file name that survives a round trip through both operating systems' rules. */
export function presetFileName(name: string): string {
  const safe = (name ?? "").replace(/[^a-zA-Z0-9 _-]/g, "_").trim();
  // A name made only of separators sanitises to underscores, which is not a name — fall back
  // unless something identifiable survived.
  return `${/[a-zA-Z0-9]/.test(safe) ? safe : "migration"}${PRESET_SUFFIX}`;
}

export function presetPath(dir: string, name: string): string {
  return path.join(dir, presetFileName(name));
}

function readDir(dir: string, scope: PresetScope): PresetEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // not created yet — an empty scope, not an error
  }
  const out: PresetEntry[] = [];
  for (const file of names) {
    if (!file.endsWith(PRESET_SUFFIX)) continue;
    const filePath = path.join(dir, file);
    let modified = 0;
    try { modified = fs.statSync(filePath).mtimeMs; } catch { /* listed but unreadable */ }
    out.push({ name: file.slice(0, -PRESET_SUFFIX.length), scope, filePath, modified });
  }
  return out;
}

/**
 * Every preset available, newest first.
 *
 * Presets written to an older location are still listed as project presets, so an upgrade does not
 * appear to lose them. A project preset shadows a global one of the same name — the more specific
 * location wins, the same way it does for settings, and a name found twice is listed once.
 */
export function listPresets(dirs: PresetDirs, legacyDirs: string[] = []): PresetEntry[] {
  const seen = new Set<string>();
  const keep = (entries: PresetEntry[]): PresetEntry[] =>
    entries.filter((e) => {
      const key = e.name.toLowerCase();
      if (seen.has(key)) return false; // an earlier, more specific location already claimed it
      seen.add(key);
      return true;
    });
  // Current project location first, then the older ones, then global.
  const project = [
    ...keep(readDir(dirs.project, "project")),
    ...legacyDirs.flatMap((d) => keep(readDir(d, "project")))
  ];
  const global = keep(readDir(dirs.global, "global"));
  return [...project, ...global].sort((a, b) => b.modified - a.modified);
}
