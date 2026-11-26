/**
 * When was each component last retrieved from, or deployed to, an org by this toolkit? Backs the Org
 * Browser's and the Deploy panel's "changed in org since last retrieve / deploy" status (a deploy is
 * recorded here too, so our own deploy never shows up as a change). Stored in the workspace state as one map
 * `canonicalOrgKey(org) + "|" + type + ":" + fullName` → ISO time. No `vscode` import (the
 * Memento is injected), so it is unit-testable.
 */

import { SyncEntry, SyncKind, resolvePending } from "./syncRecordPure";
import { orgLookupKey } from "./deployStatusPure";

/** The slice of `vscode.Memento` used here. */
export interface LogStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): PromiseLike<void> | void;
}

const STORE_KEY = "adure-sfx-toolkit.retrieveLog";
/** The sync records (org lastModifiedDate + local contents hash after a deploy / retrieve) live beside the times: same store, same org keys, same flush. */
const SYNC_KEY = "adure-sfx-toolkit.syncRecord";
/** Oldest entries are dropped beyond this many (a full-org retrieve is ~50k components). */
const MAX_ENTRIES = 100_000;

let store: LogStore | undefined;
let entries: Record<string, string> = {};
/** `canonicalOrgKey(org) + "|" + orgLookupKey(type, fullName)` → sync record. */
let syncEntries: Record<string, SyncEntry> = {};
let orgKeyOf: (org: string | null) => string = defaultOrgKeyOf;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function defaultOrgKeyOf(org: string | null): string {
	// Lazy: orgKey pulls in vscode-bound modules, which pure unit tests must not load.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	return (require("./orgKey") as typeof import("./orgKey")).canonicalOrgKey(org);
}

/** Wire the log to the workspace state (call once on activation). `keyOf` overrides the org key (tests). */
export function initRetrieveLog(memento: LogStore, keyOf?: (org: string | null) => string): void {
	store = memento;
	orgKeyOf = keyOf ?? defaultOrgKeyOf;
	entries = { ...memento.get<Record<string, string>>(STORE_KEY, {}) };
	syncEntries = { ...memento.get<Record<string, SyncEntry>>(SYNC_KEY, {}) };
}

/** Test hook: drop all state. */
export function resetRetrieveLogForTests(): void {
	store = undefined;
	entries = {};
	syncEntries = {};
	orgKeyOf = defaultOrgKeyOf;
	if (flushTimer) clearTimeout(flushTimer);
	flushTimer = undefined;
}

/** `canonicalOrgKey(org) + "|" + type + ":" + fullName` */
export function retrieveLogKey(org: string | null, type: string, fullName: string): string {
	return `${orgKeyOf(org)}|${type}:${fullName}`;
}

function scheduleFlush(): void {
	if (!store || flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = undefined;
		flushRetrieveLog();
	}, 500);
	(flushTimer as { unref?: () => void }).unref?.();
}

/** Persist now (also called on deactivate). */
export function flushRetrieveLog(): void {
	if (!store) return;
	const keys = Object.keys(entries);
	if (keys.length > MAX_ENTRIES) {
		keys.sort((a, b) => (entries[a] < entries[b] ? -1 : 1));
		for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
	}
	void store.update(STORE_KEY, entries);
	const sk = Object.keys(syncEntries);
	if (sk.length > MAX_ENTRIES) {
		sk.sort((a, b) => syncEntries[a].at - syncEntries[b].at);
		for (const k of sk.slice(0, sk.length - MAX_ENTRIES)) delete syncEntries[k];
	}
	void store.update(SYNC_KEY, syncEntries);
}

/** Record that `components` were just retrieved from `org` (time defaults to now). */
export function recordRetrieved(org: string | null, components: { type: string; fullName: string }[], at: Date = new Date()): void {
	if (components.length === 0) return;
	const iso = at.toISOString();
	const prefix = `${orgKeyOf(org)}|`;
	for (const c of components) entries[`${prefix}${c.type}:${c.fullName}`] = iso;
	scheduleFlush();
}

/**
 * Record that `components` were just deployed to `org`. `at` should be the org's lastModifiedDate of the
 * component after the deploy (the status compares against exactly that); with no better value, the
 * deploy's completion time.
 */
export function recordDeployed(org: string | null, components: { type: string; fullName: string; at?: Date }[], fallback: Date = new Date()): void {
	if (components.length === 0) return;
	const prefix = `${orgKeyOf(org)}|`;
	for (const c of components) entries[`${prefix}${c.type}:${c.fullName}`] = (c.at ?? fallback).toISOString();
	scheduleFlush();
}

/** ISO time of the last retrieve of this component from this org, or undefined. */
export function getLastRetrieve(org: string | null, type: string, fullName: string): string | undefined {
	return entries[retrieveLogKey(org, type, fullName)];
}

/** All recorded retrieves for one org as `"Type:fullName"` → epoch ms. */
export function getRetrieveTimes(org: string | null): Record<string, number> {
	const prefix = `${orgKeyOf(org)}|`;
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(entries)) {
		if (!k.startsWith(prefix)) continue;
		const t = Date.parse(v);
		if (!Number.isNaN(t)) out[k.slice(prefix.length)] = t;
	}
	return out;
}

// ── Sync records ───────────────────────────────────────────────────────────────

/** One component after a deploy / retrieve: its local contents hash (and meta hash), the org's lastModifiedDate when known. */
export interface SyncItem {
	type: string;
	fullName: string;
	hash: string;
	meta?: string;
	/** The org's lastModifiedDate (epoch ms) after the operation; omitted = pending until the next listing. */
	lm?: number;
}

/** Record the sync state of `items` after a successful deploy / retrieve against `org`. */
export function recordSync(org: string | null, items: readonly SyncItem[], kind: SyncKind, at: Date = new Date()): void {
	if (items.length === 0) return;
	const prefix = `${orgKeyOf(org)}|`;
	for (const i of items) {
		const e: SyncEntry = { at: at.getTime(), hash: i.hash, kind, ...(i.meta !== undefined ? { meta: i.meta } : {}), ...(i.lm !== undefined ? { lm: i.lm } : {}) };
		syncEntries[`${prefix}${orgLookupKey(i.type, i.fullName)}`] = e;
	}
	scheduleFlush();
}

/** The sync record of a component (`lookup` = `orgLookupKey(type, name)`) in `org`, or undefined. */
export function getSyncEntry(org: string | null, lookup: string): SyncEntry | undefined {
	return syncEntries[`${orgKeyOf(org)}|${lookup}`];
}

/**
 * Fill the pending records of `org` from a listing (`lookup` → lastModifiedDate, epoch ms); see `resolvePending`.
 * Returns how many records were filled or dropped.
 */
export function resolveSyncPending(org: string | null, lmByLookup: ReadonlyMap<string, number>): number {
	const prefix = `${orgKeyOf(org)}|`;
	let changed = 0;
	for (const k of Object.keys(syncEntries)) {
		if (!k.startsWith(prefix)) continue;
		const e = syncEntries[k];
		if (e.lm !== undefined) continue;
		const next = resolvePending(e, lmByLookup.get(k.slice(prefix.length)));
		if (next === e) continue;
		if (next) syncEntries[k] = next;
		else delete syncEntries[k];
		changed++;
	}
	if (changed > 0) scheduleFlush();
	return changed;
}
