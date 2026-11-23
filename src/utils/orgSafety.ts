import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { getWarnOnProductionOrg } from "./constants";
import { destructiveConfirmText } from "./destructivePure";
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

export interface DestructiveOrgCheck {
  /** Alias, else username (what the modal shows). */
  display: string;
  username: string;
  alias?: string;
  production: boolean;
  /** The org was found in the org list. false = it could not be verified: treated as production. */
  known: boolean;
  /** The UI must make the user type `confirmText` before a delete runs (production, Dev Hub, or an org that could not be verified). */
  needsTypedConfirmation: boolean;
  /** What to type: the org alias, else its username. */
  confirmText: string;
}

/**
 * Production safety of a destructive operation (delete from org). Call before running it: when
 * `needsTypedConfirmation` is true the UI asks the user to type `confirmText` (see `confirmationMatches`).
 * Unlike `confirmProductionOrgOperation` this ignores the "warn on production" setting and fails closed: an org
 * that cannot be found in the org list needs the typed confirmation too.
 */
export async function checkOrgForDestructive(targetOrg: string | null | undefined, projectDir?: string): Promise<DestructiveOrgCheck> {
  let org = await resolveOrgForTarget(targetOrg, projectDir);
  if (!org) {
    try {
      await refreshOrgListCache();
    } catch {
      /* fall through: fail closed below */
    }
    org = await resolveOrgForTarget(targetOrg, projectDir);
  }
  if (!org) {
    const name = targetOrg?.trim() || resolveDefaultTargetOrgUsernameSync(projectDir) || "";
    return { display: name, username: name, production: false, known: false, needsTypedConfirmation: true, confirmText: name };
  }
  const production = isProductionOrg(org);
  return {
    display: orgDisplayName(org),
    username: org.username,
    alias: org.alias,
    production,
    known: true,
    needsTypedConfirmation: production,
    confirmText: destructiveConfirmText(org),
  };
}
