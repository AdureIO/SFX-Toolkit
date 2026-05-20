import { runCommand } from "./commandRunner";
import { readTargetOrgFromSfdxConfig } from "./sfdxConfig";

export type OrgOption = { label: string; username: string };

/** Org metadata from `sf org list` for safety checks (production vs sandbox). */
export type OrgRecord = {
  username: string;
  alias?: string;
  isSandbox: boolean;
  isDevHub: boolean;
  isScratch: boolean;
  isDefault: boolean;
};

let cachedRecords: OrgRecord[] = [];

/** Session hint after set-as-default (until sfdx-config.json is read on next resolve). */
let knownTargetOrgUsername: string | null = null;

export function getKnownTargetOrgUsername(): string | null {
  return knownTargetOrgUsername;
}

export function setKnownTargetOrg(username: string | null): void {
  knownTargetOrgUsername = username?.trim() || null;
}

/** Username marked default in cached `sf org list` (may be stale — lowest-priority sync fallback). */
export function getDefaultUsernameFromOrgCache(): string | null {
  return cachedRecords.find((o) => o.isDefault)?.username ?? null;
}

function syncKnownTargetFromSfdxConfig(): void {
  const fromFile = readTargetOrgFromSfdxConfig();
  if (fromFile) {
    knownTargetOrgUsername = fromFile;
  }
}

export function getOrgByTarget(targetOrg?: string | null): OrgRecord | null {
  const key = targetOrg?.trim();
  if (!key) {
    return cachedRecords.find((o) => o.isDefault) ?? null;
  }
  const lower = key.toLowerCase();
  return (
    cachedRecords.find((o) => o.username.toLowerCase() === lower || (o.alias && o.alias.toLowerCase() === lower)) ??
    null
  );
}

/** Current default target org from Salesforce CLI (not the cached isDefault flag). */
export async function getTargetOrgUsernameFromCli(): Promise<string | null> {
  try {
    const result = await runCommand("sf config get target-org --json", undefined, undefined, true);
    const parsed = JSON.parse(result);
    const value = parsed.result?.value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function recordsFromSfListResult(result: {
  nonScratchOrgs?: {
    alias?: string;
    username: string;
    isDefaultUsername?: boolean;
    isSandbox?: boolean;
    isDevHub?: boolean;
  }[];
  scratchOrgs?: { alias?: string; username: string; isDefaultUsername?: boolean; isSandbox?: boolean }[];
}): OrgRecord[] {
  const records: OrgRecord[] = [];
  for (const o of result.scratchOrgs ?? []) {
    if (!o.username) continue;
    records.push({
      username: o.username,
      alias: o.alias,
      isSandbox: !!o.isSandbox,
      isDevHub: false,
      isScratch: true,
      isDefault: !!o.isDefaultUsername
    });
  }
  for (const o of result.nonScratchOrgs ?? []) {
    if (!o.username) continue;
    records.push({
      username: o.username,
      alias: o.alias,
      isSandbox: !!o.isSandbox,
      isDevHub: !!o.isDevHub,
      isScratch: false,
      isDefault: !!o.isDefaultUsername
    });
  }
  return records;
}

/** Parse `sf org list --json` result into picker options (default org first). */
export function orgOptionsFromSfListResult(result: {
  nonScratchOrgs?: { alias?: string; username: string; isDefaultUsername?: boolean }[];
  scratchOrgs?: { alias?: string; username: string; isDefaultUsername?: boolean }[];
}): OrgOption[] {
  const nonScratchOrgs = result.nonScratchOrgs ?? [];
  const scratchOrgs = result.scratchOrgs ?? [];
  const all = [...nonScratchOrgs, ...scratchOrgs];
  const defaultUsername = all.find((o) => o.isDefaultUsername)?.username;
  const options: OrgOption[] = all
    .filter((o) => o.username)
    .map((o) => ({
      label: (o.alias || o.username) + (o.username === defaultUsername ? " (default)" : ""),
      username: o.username
    }));
  options.sort((a, b) => (b.username === defaultUsername ? 1 : 0) - (a.username === defaultUsername ? 1 : 0));
  return options;
}

let cached: OrgOption[] | null = null;
let inflight: Promise<OrgOption[]> | null = null;

/** Cached org list for instant quick picks; null until first load. */
export function getCachedOrgList(): OrgOption[] | null {
  return cached;
}

export function setOrgListCache(orgs: OrgOption[]): void {
  cached = orgs;
}

/** Update cache from `sf org list` result object (OrgTreeProvider). */
export function setOrgListCacheFromSfResult(
  result:
    | {
        nonScratchOrgs?: { alias?: string; username: string; isDefaultUsername?: boolean }[];
        scratchOrgs?: { alias?: string; username: string; isDefaultUsername?: boolean }[];
        _error?: string;
      }
    | null
    | undefined
): void {
  if (!result || result._error) {
    return;
  }
  cached = orgOptionsFromSfListResult(result);
  cachedRecords = recordsFromSfListResult(result);
  syncKnownTargetFromSfdxConfig();
}

export function invalidateOrgListCache(): void {
  cached = null;
  cachedRecords = [];
}

async function fetchOrgList(): Promise<OrgOption[]> {
  const result = await runCommand("sf org list --json", undefined, undefined, true);
  const parsed = JSON.parse(result);
  if (parsed.status !== 0 || !parsed.result) {
    cached = [];
    return [];
  }
  const orgs = orgOptionsFromSfListResult(parsed.result);
  cached = orgs;
  cachedRecords = recordsFromSfListResult(parsed.result);
  syncKnownTargetFromSfdxConfig();
  return orgs;
}

/** Load org list from CLI (deduped). Updates cache. */
export async function refreshOrgListCache(): Promise<OrgOption[]> {
  if (inflight) {
    return inflight;
  }
  inflight = fetchOrgList().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Prefetch org list in the background (no-op if a fetch is already running). */
export function warmOrgListCache(): void {
  if (inflight) {
    return;
  }
  void refreshOrgListCache().catch(() => {
    /* non-fatal */
  });
}

/** For pickers: return cache immediately when available, otherwise await first fetch. */
export async function getOrgListForPicker(): Promise<OrgOption[]> {
  if (cached) {
    warmOrgListCache();
    return cached;
  }
  return refreshOrgListCache();
}
