import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { getWarnOnProductionOrg } from "./constants";
import { getOrgByTarget, getTargetOrgUsernameFromCli, setKnownTargetOrg, type OrgRecord } from "./orgListCache";

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
 * Default: sfdx-config → session hint → cached isDefault.
 */
export function resolveOrgForTargetSync(targetOrg?: string | null): OrgRecord | null {
  const key = targetOrg?.trim();
  if (key) {
    return lookupOrgRecord(key);
  }
  const username = resolveDefaultTargetOrgUsernameSync();
  return username ? lookupOrgRecord(username) : null;
}

/**
 * Same as sync, with CLI fallback for default target when config file is missing.
 */
export async function resolveOrgForTarget(targetOrg?: string | null): Promise<OrgRecord | null> {
  const sync = resolveOrgForTargetSync(targetOrg);
  if (sync || targetOrg?.trim()) {
    return sync;
  }
  const cli = await getTargetOrgUsernameFromCli();
  if (!cli) {
    return null;
  }
  setKnownTargetOrg(cli);
  return lookupOrgRecord(cli);
}

/**
 * Modal confirmation before deploy / execute against a production org.
 */
export async function confirmProductionOrgOperation(action: string, targetOrg?: string | null): Promise<boolean> {
  if (!getWarnOnProductionOrg()) {
    return true;
  }
  const org = await resolveOrgForTarget(targetOrg);
  if (!org || !isProductionOrg(org)) {
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
