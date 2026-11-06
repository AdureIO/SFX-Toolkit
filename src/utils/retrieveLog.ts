/**
 * When was each component last retrieved from an org? Backs the Org Browser's
 * "changed in org since last retrieve" status. Stored in the workspace state as one map
 * `canonicalOrgKey(org) + "|" + type + ":" + fullName` → ISO time. No `vscode` import (the
 * Memento is injected), so it is unit-testable.
 */

/** The slice of `vscode.Memento` used here. */
export interface LogStore {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): PromiseLike<void> | void;
}

const STORE_KEY = "adure-sfx-toolkit.retrieveLog";
/** Oldest entries are dropped beyond this many (a full-org retrieve is ~50k components). */
const MAX_ENTRIES = 100_000;

let store: LogStore | undefined;
let entries: Record<string, string> = {};
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
}

/** Test hook: drop all state. */
export function resetRetrieveLogForTests(): void {
	store = undefined;
	entries = {};
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
}

/** Record that `components` were just retrieved from `org` (time defaults to now). */
export function recordRetrieved(org: string | null, components: { type: string; fullName: string }[], at: Date = new Date()): void {
	if (components.length === 0) return;
	const iso = at.toISOString();
	const prefix = `${orgKeyOf(org)}|`;
	for (const c of components) entries[`${prefix}${c.type}:${c.fullName}`] = iso;
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
