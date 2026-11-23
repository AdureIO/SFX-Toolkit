import {
  getDefaultUsernameFromOrgCache,
  getKnownTargetOrgUsername,
  getOrgByTarget,
  getTargetOrgUsernameFromCli,
  setKnownTargetOrg
} from "./orgListCache";
import { primaryProjectRoot } from "./projectUtils";
import { readTargetOrgFromSfdxConfig } from "./sfdxConfig";

export interface DefaultOrgInfo {
  displayName: string;
  username: string;
}

function toDefaultOrgInfo(org: { alias?: string; username: string }): DefaultOrgInfo {
  const displayName = org.alias || org.username.split("@")[0] || org.username;
  return { displayName, username: org.username };
}

function infoFromUsername(username: string): DefaultOrgInfo {
  const org = getOrgByTarget(username);
  return org ? toDefaultOrgInfo(org) : toDefaultOrgInfo({ username, alias: undefined });
}

/**
 * Resolve default target-org username (sync) of a project (default: the active project).
 * 1. `.sf/config.json` / `.sfdx/sfdx-config.json`
 * 2. In-memory hint (set-as-default in this session), only if recorded for this project
 * 3. Cached org list default flag (may be stale; no CLI), only if the list was produced in this project
 */
export function resolveDefaultTargetOrgUsernameSync(workspaceRoot?: string): string | null {
  const root = workspaceRoot ?? primaryProjectRoot();
  return readTargetOrgFromSfdxConfig(root) ?? getKnownTargetOrgUsername(root) ?? getDefaultUsernameFromOrgCache(root);
}

/**
 * Resolve default target-org username with CLI fallback when sync sources are empty.
 */
export async function resolveDefaultTargetOrgUsername(workspaceRoot?: string): Promise<string | null> {
  const root = workspaceRoot ?? primaryProjectRoot();
  const sync = resolveDefaultTargetOrgUsernameSync(root);
  if (sync) {
    return sync;
  }
  const cli = await getTargetOrgUsernameFromCli(root);
  if (cli) {
    setKnownTargetOrg(cli, root);
  }
  return cli;
}

/** Default org for UI (sync). Uses sfdx-config + session hint + org cache only. */
export function getDefaultOrgSync(workspaceRoot?: string): DefaultOrgInfo | null {
  const username = resolveDefaultTargetOrgUsernameSync(workspaceRoot);
  return username ? infoFromUsername(username) : null;
}

/** Default org for UI with CLI fallback when config file / cache are unavailable. */
export async function getDefaultOrg(workspaceRoot?: string): Promise<DefaultOrgInfo | null> {
  const username = await resolveDefaultTargetOrgUsername(workspaceRoot);
  return username ? infoFromUsername(username) : null;
}
