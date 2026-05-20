import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** Parsed shape of workspace `.sfdx/sfdx-config.json`. */
type SfdxConfigJson = {
  "target-org"?: string;
  defaultusername?: string;
  defaultUsername?: string;
};

/**
 * Reads the default target org (username or alias) from `.sfdx/sfdx-config.json`.
 * Updated by `sf config set target-org` — fast and avoids a CLI round-trip.
 */
export function readTargetOrgFromSfdxConfig(workspaceRoot?: string): string | null {
  const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return null;
  }
  const configPath = path.join(root, ".sfdx", "sfdx-config.json");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const json = JSON.parse(raw) as SfdxConfigJson;
    const value = json["target-org"] ?? json.defaultusername ?? json.defaultUsername;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
