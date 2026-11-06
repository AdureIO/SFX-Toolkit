/**
 * Canonical org key — the one identity every host-side cache (AuthInfo,
 * OrgMetadataCache, DescribeStore, SoqlSchemaProvider) and the language-server
 * bridge (`orgForUri`) key their data by.
 *
 * Before this existed, `null` ("the default org") was cached as `__default__`
 * while a document's org resolved from `.sfdx/sfdx-config.json` to an alias or a
 * username — three different keys for the same org. Warm-ups hit one key, the
 * language server another, and push/pull invalidations a third, so describes went
 * stale and the warm-up was wasted.
 *
 * `canonicalOrgKey` maps every spelling to the org's username:
 *   - `null` / `""` / `"__default__"` → the default target org of the (primary or
 *     given) project, resolved to its username;
 *   - an alias → its username (org list cache, else `~/.sfdx/alias.json`);
 *   - a username → itself.
 * When no default org is configured at all it returns `DEFAULT_ORG_KEY`, which the
 * CLI resolves itself (`sf org display` without `--target-org`).
 *
 * Results are cached (sync, no CLI); `invalidateOrgKeyCache()` drops them when
 * the default org changes.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveDefaultTargetOrgUsernameSync } from "./defaultOrg";
import { getOrgByTarget } from "./orgListCache";

/** Key used when no default org can be resolved (the CLI picks its global default). */
export const DEFAULT_ORG_KEY = "__default__";

/** Re-check the alias file at most this often (it changes only on `sf alias set` / login). */
const ALIAS_RECHECK_MS = 5000;
/** Safety net: a resolved default is re-read after this long even without a change event. */
const DEFAULT_TTL_MS = 60_000;

let aliasFileOverride: string | undefined;
let aliasMap = new Map<string, string>();
let aliasCheckedAt = 0;
let aliasMtimeMs = -1;

/** Resolved default key per project dir ("" = primary project). */
const defaultCache = new Map<string, { key: string; at: number }>();

function aliasFilePath(): string {
	return aliasFileOverride ?? path.join(os.homedir(), ".sfdx", "alias.json");
}

/** Test hook: point the alias lookup at another file (undefined restores the default). */
export function setAliasFileForTests(file: string | undefined): void {
	aliasFileOverride = file;
	aliasCheckedAt = 0;
	aliasMtimeMs = -1;
	aliasMap = new Map();
	defaultCache.clear();
}

function readAliasMap(): Map<string, string> {
	const now = Date.now();
	if (now - aliasCheckedAt < ALIAS_RECHECK_MS) return aliasMap;
	aliasCheckedAt = now;
	const file = aliasFilePath();
	try {
		const st = fs.statSync(file);
		if (st.mtimeMs === aliasMtimeMs) return aliasMap;
		aliasMtimeMs = st.mtimeMs;
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		const orgs = json?.orgs && typeof json.orgs === "object" ? json.orgs : {};
		const next = new Map<string, string>();
		for (const [alias, username] of Object.entries(orgs)) {
			if (typeof username === "string" && username.trim()) {
				next.set(alias, username.trim());
				next.set(alias.toLowerCase(), username.trim());
			}
		}
		aliasMap = next;
	} catch {
		aliasMtimeMs = -1;
		aliasMap = new Map();
	}
	return aliasMap;
}

/** Username for an alias or username. Unknown aliases come back unchanged. */
function resolveTarget(target: string): string {
	const rec = getOrgByTarget(target);
	if (rec?.username) return rec.username;
	// A username always contains '@'; only aliases need the alias file.
	if (target.includes("@")) return target;
	const map = readAliasMap();
	return map.get(target) ?? map.get(target.toLowerCase()) ?? target;
}

function resolveDefaultKey(projectDir?: string): string {
	const cacheId = projectDir ?? "";
	const now = Date.now();
	const hit = defaultCache.get(cacheId);
	if (hit && now - hit.at < DEFAULT_TTL_MS) return hit.key;
	let key = DEFAULT_ORG_KEY;
	try {
		const raw = resolveDefaultTargetOrgUsernameSync(projectDir);
		if (raw) key = resolveTarget(raw);
	} catch {
		key = DEFAULT_ORG_KEY;
	}
	defaultCache.set(cacheId, { key, at: now });
	return key;
}

/**
 * Canonical cache key (the username) for an org given as alias, username or
 * `null`/default. `projectDir` selects whose default org `null` means (a nested
 * sfdx project); omitted = the primary project. Idempotent: passing a key
 * returned by this function returns it again.
 */
export function canonicalOrgKey(org: string | null | undefined, projectDir?: string): string {
	const v = typeof org === "string" ? org.trim() : "";
	if (!v || v === DEFAULT_ORG_KEY) return resolveDefaultKey(projectDir);
	return resolveTarget(v);
}

/** The `--target-org` value for a canonical key (`null` = let the CLI use its default). */
export function orgArgForKey(key: string): string | null {
	return key === DEFAULT_ORG_KEY || !key ? null : key;
}

/**
 * Forget resolved defaults — call when the default org changes (Set-as-Default,
 * `sf config set target-org`, an edited sfdx-config). `projectDir` limits it to one
 * nested project; omitted drops every project's resolution.
 */
export function invalidateOrgKeyCache(projectDir?: string): void {
	if (projectDir === undefined) {
		defaultCache.clear();
	} else {
		defaultCache.delete(projectDir);
		defaultCache.delete("");
	}
	aliasCheckedAt = 0;
}
