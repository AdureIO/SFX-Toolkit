import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { getWarnOnProductionOrg } from "./constants";
import { getOrgByTarget, getTargetOrgUsernameFromCli, refreshOrgListCache, setKnownTargetOrg, type OrgRecord } from "./orgListCache";

/** Warn for any non-scratch, non-sandbox org (production, Developer Edition, and Dev Hub). */
export function isProductionOrg(org: OrgRecord): boolean {
  return !org.isScratch && !org.isSandbox;
}

function orgDisplayName(org: OrgRecord): string {
  return org.alias || org.username;
}

function lookupOrgRecord(targetOrg: string): OrgRecord | null {
  return getOrgByTarget(targetOrg);
}

/**
 * Resolve org for production warning (sync).
 * Explicit target: org list cache by username/alias.
 * Default: sfdx-config → session hint → cached isDefault, of `projectDir` (default: the active project).
 */
export function resolveOrgForTargetSync(targetOrg?: string | null, projectDir?: string): OrgRecord | null {
  const key = targetOrg?.trim();
  if (key) {
    return lookupOrgRecord(key);
  }
  const username = resolveDefaultTargetOrgUsernameSync(projectDir);
  return username ? lookupOrgRecord(username) : null;
}

/**
 * Same as sync, with CLI fallback for default target when config file is missing.
 */
export async function resolveOrgForTarget(targetOrg?: string | null, projectDir?: string): Promise<OrgRecord | null> {
  const sync = resolveOrgForTargetSync(targetOrg, projectDir);
  if (sync || targetOrg?.trim()) {
    return sync;
  }
  const cli = await getTargetOrgUsernameFromCli(projectDir);
  if (!cli) {
    return null;
  }
  setKnownTargetOrg(cli, projectDir);
  return lookupOrgRecord(cli);
}

/**
 * Modal confirmation before deploy / execute against a production org.
 */
export async function confirmProductionOrgOperation(action: string, targetOrg?: string | null, projectDir?: string): Promise<boolean> {
  if (!getWarnOnProductionOrg()) {
    return true;
  }
  let org = await resolveOrgForTarget(targetOrg, projectDir);
  if (!org) {
    // The org list cache may have been emptied (refresh, default-org change) — reload
    // it once and look again before deciding.
    try {
      await refreshOrgListCache();
    } catch {
      /* fall through to the fail-closed prompt below */
    }
    org = await resolveOrgForTarget(targetOrg, projectDir);
  }
  if (!org) {
    // Fail closed: we cannot prove this is not a production org, so ask.
    const name = targetOrg?.trim() || resolveDefaultTargetOrgUsernameSync(projectDir);
    const label = name ? `"${name}"` : "the default org";
    const unknownChoice = await vscode.window.showWarningMessage(
      `Could not verify whether ${label} is a production org. You are about to ${action} it.`,
      { modal: true },
      "Continue"
    );
    return unknownChoice === "Continue";
  }
  if (!isProductionOrg(org)) {
    return true;
  }
  const name = orgDisplayName(org);
  const orgKind = org.isDevHub ? "Dev Hub" : "production";
  const choice = await vscode.window.showWarningMessage(
    `You are about to ${action} the ${orgKind} org "${name}" (${org.username}).`,
    { modal: true },
    "Continue"
  );
  return choice === "Continue";
}
