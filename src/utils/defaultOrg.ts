import {
  getDefaultUsernameFromOrgCache,
  getKnownTargetOrgUsername,
  getOrgByTarget,
  getTargetOrgUsernameFromCli,
  setKnownTargetOrg
} from "./orgListCache";
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
 * Resolve default target-org username (sync).
 * 1. `.sfdx/sfdx-config.json`
 * 2. In-memory hint (set-as-default in this session)
 * 3. Cached org list default flag (may be stale; no CLI)
 */
export function resolveDefaultTargetOrgUsernameSync(workspaceRoot?: string): string | null {
  return readTargetOrgFromSfdxConfig(workspaceRoot) ?? getKnownTargetOrgUsername() ?? getDefaultUsernameFromOrgCache();
}

/**
 * Resolve default target-org username with CLI fallback when sync sources are empty.
 */
export async function resolveDefaultTargetOrgUsername(workspaceRoot?: string): Promise<string | null> {
  const sync = resolveDefaultTargetOrgUsernameSync(workspaceRoot);
  if (sync) {
    return sync;
  }
  const cli = await getTargetOrgUsernameFromCli();
  if (cli) {
    setKnownTargetOrg(cli);
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
