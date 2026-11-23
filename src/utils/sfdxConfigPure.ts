import * as fs from "fs";
import * as path from "path";

/** Parsed shape of `.sf/config.json` (CLI v2) and `.sfdx/sfdx-config.json` (legacy). */
type ConfigJson = {
  "target-org"?: string;
  defaultusername?: string;
  defaultUsername?: string;
};

function readTargetOrg(configPath: string): string | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    const json = JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigJson;
    const value = json["target-org"] ?? json.defaultusername ?? json.defaultUsername;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Default target org (username or alias) configured in a project dir: `.sf/config.json`
 * (CLI v2) first, else `.sfdx/sfdx-config.json`. A `.sf/config.json` without a target org
 * falls through to the legacy file.
 */
export function targetOrgFromProjectDir(root: string): string | null {
  return readTargetOrg(path.join(root, ".sf", "config.json")) ?? readTargetOrg(path.join(root, ".sfdx", "sfdx-config.json"));
}
