import { runCommand } from "./commandRunner";

export type OrgOption = { label: string; username: string };

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
}

export function invalidateOrgListCache(): void {
  cached = null;
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
