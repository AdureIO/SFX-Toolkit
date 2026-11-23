import { primaryProjectRoot } from "./projectUtils";
import { targetOrgFromProjectDir } from "./sfdxConfigPure";

/**
 * Reads the default target org (username or alias) from the project's `.sf/config.json`
 * or `.sfdx/sfdx-config.json`. Updated by `sf config set target-org` — fast and avoids a
 * CLI round-trip. `workspaceRoot` defaults to the active project.
 */
export function readTargetOrgFromSfdxConfig(workspaceRoot?: string): string | null {
  const root = workspaceRoot ?? primaryProjectRoot();
  if (!root) {
    return null;
  }
  return targetOrgFromProjectDir(root);
}
