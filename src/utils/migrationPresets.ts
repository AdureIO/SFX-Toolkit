/**
 * Where migration presets live, and what is on disk.
 *
 * Two scopes, because the two kinds of preset are genuinely different: one describes objects and
 * fields of *this* project and belongs beside its source, the other is a way of working the user
 * carries between projects. No `vscode` import, so the resolution and listing are unit-testable.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type PresetScope = "project" | "global";

export const PRESET_SUFFIX = ".migration.json";

export interface PresetDirs {
  /** Beside the project's source, so it can be committed and shared with the team. */
  project: string;
  /** The user's own, available in every project on this machine. */
  global: string;
}

export function presetDirs(workspaceRoot: string): PresetDirs {
  return {
    project: path.join(workspaceRoot, ".sfdx", "asfx", "migrations"),
    global: path.join(os.homedir(), ".adure-sfx", "migrations")
  };
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
 * Presets saved before there were scopes sit directly in `.sfdx/asfx`; they are listed as project
 * presets so an upgrade does not appear to lose them. A project preset shadows a global one of the
 * same name — the more specific location wins, the same way it does for settings.
 */
export function listPresets(dirs: PresetDirs, legacyDir?: string): PresetEntry[] {
  const project = [...readDir(dirs.project, "project"), ...(legacyDir ? readDir(legacyDir, "project") : [])];
  const seen = new Set(project.map((p) => p.name.toLowerCase()));
  const global = readDir(dirs.global, "global").filter((p) => !seen.has(p.name.toLowerCase()));
  return [...project, ...global].sort((a, b) => b.modified - a.modified);
}
