/**
 * Deploy & Retrieve Metadata: the rules around the panel that the engine (`syncCenterPure`) does not cover:
 * partial-object expansion for a deploy, whole-object retrieves, conflict choices that follow their rows, the
 * button states and the history list. Pure (no `vscode`, no DOM): runs in the host, the webview and the tests.
 */
import { Candidates, ConflictChoice, SYNC_IN_PROJECT, SYNC_STATUS_NAMES, SyncRow } from "./syncCenterPure";
import { orgLookupKey } from "./deployStatusPure";
import { HistoryEntry, HistoryKind } from "./historyPure";
import { relativeTime } from "./orgBrowser/filter";
import { compKey } from "./orgBrowser/types";

/** A local index entry (a `LocalEntry` fits). */
export interface LocalRef {
	type: string;
	name: string;
	key: string;
}

/** `Type:fullName` → `{ type, fullName }` (split at the first colon). */
export function refOfKey(key: string): { type: string; fullName: string } {
	const c = key.indexOf(":");
	return c < 0 ? { type: key, fullName: "" } : { type: key.slice(0, c), fullName: key.slice(c + 1) };
}

/** The key a stored `Type:name` (local file naming, e.g. percent-encoded) has as a Center row. */
export function rowKeyOf(key: string): string {
	const r = refOfKey(key);
	return orgLookupKey(r.type, r.fullName);
}

// ── Status filter default ──────────────────────────────────────────────────────

/** The default of the status filter group: "In project" (everything that exists locally). */
export function defaultStatusFilter(): string[] {
	return [SYNC_IN_PROJECT];
}

/**
 * The status filter to start from. A stored value is sanitised to the known facets; a store from before the
 * default existed (`defaultApplied` false) with nothing selected gets the default once.
 */
export function initialStatusFilter(stored: unknown, defaultApplied: boolean): string[] {
	const known = new Set<string>([...SYNC_STATUS_NAMES, SYNC_IN_PROJECT]);
	const list = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string" && known.has(x)) : [];
	return list.length === 0 && !defaultApplied ? defaultStatusFilter() : [...new Set(list)];
}

/**
 * The "Group by type" toggle to start from. A store from before the default existed (`defaultApplied` false) gets
 * `true` once; after that the stored boolean is kept (a non-boolean falls back to `true`).
 */
export function initialGroup(stored: unknown, defaultApplied: boolean): boolean {
	if (!defaultApplied) return true;
	return typeof stored === "boolean" ? stored : true;
}

/**
 * The filter fields the Center keeps on "Clear all filters": the status group goes back to its default ("In
 * project") and the "only selected" toggle keeps its value (the caller passes whether it is in effect).
 */
export function centerFilterKeptOnClear(onlySelected: boolean): { status: string[]; onlySelected: boolean } {
	return { status: defaultStatusFilter(), onlySelected };
}

/**
 * The filter for browsing the org (Orgs view, org menu, the Org Browser command id): every status shows
 * (the default "In project" group would hide the org-only components), no "only selected", and the given
 * metadata types when there are any. Search text, namespace and the other facets stay as the user left them.
 */
export function browseFilter<F extends { status: string[]; onlySelected: boolean; types: string[] }>(filter: F, types: readonly string[]): F {
	return { ...filter, status: [], onlySelected: false, types: types.length > 0 ? [...types] : filter.types };
}

// ── Objects and their children ─────────────────────────────────────────────────

/** `Account` for `CustomField:Account.Foo__c` when `type` is a child type of CustomObject; else undefined. */
export function objectOfChild(type: string, name: string, childTypes: ReadonlySet<string>): string | undefined {
	if (!childTypes.has(type)) return undefined;
	const dot = name.indexOf(".");
	return dot > 0 ? name.slice(0, dot) : undefined;
}

/**
 * The local entries that belong to an object (its fields, record types …): what a `partial` row (object file
 * not in the project, children are) deploys. Keys of the local index.
 */
export function partialDeployLocalKeys(objectName: string, locals: Iterable<LocalRef>, childTypes: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const l of locals) if (objectOfChild(l.type, l.name, childTypes) === objectName) out.push(l.key);
	return out;
}

/** The local index keys one row deploys: its own entry, or for a `partial` object row the entries of its local children. */
export function rowDeployLocalKeys(row: SyncRow, locals: readonly LocalRef[], childTypes: ReadonlySet<string>): string[] {
	if (row.status === "partial" && row.type === "CustomObject") return partialDeployLocalKeys(row.name, locals, childTypes);
	return row.localKey ? [row.localKey] : [];
}

/**
 * Local index keys a history entry's components stand for (re-running a deploy): the entry's own local key, and for an
 * object that is not a local entry its local children. Components that are not in the project are counted in `missing`.
 */
export function historyDeployLocalKeys(components: readonly string[], locals: readonly LocalRef[], childTypes: ReadonlySet<string>): { keys: string[]; missing: number } {
	const byOrgKey = new Map(locals.map((l) => [orgLookupKey(l.type, l.name), l.key]));
	const out = new Set<string>();
	let missing = 0;
	for (const c of components) {
		const rk = rowKeyOf(c);
		const own = byOrgKey.get(rk);
		if (own) {
			out.add(own);
			continue;
		}
		const r = refOfKey(rk);
		const kids = r.type === "CustomObject" ? partialDeployLocalKeys(r.fullName, locals, childTypes) : [];
		if (kids.length === 0) missing++;
		for (const k of kids) out.add(k);
	}
	return { keys: [...out], missing };
}

/** What a retrieve of one row asks the org for: the row itself, or with `wholeObject` a child's object. */
export function rowRetrieveRef(row: Pick<SyncRow, "type" | "name">, wholeObject: boolean, childTypes: ReadonlySet<string>): { type: string; fullName: string } {
	const obj = wholeObject ? objectOfChild(row.type, row.name, childTypes) : undefined;
	return obj ? { type: "CustomObject", fullName: obj } : { type: row.type, fullName: row.name };
}

/**
 * Local index keys a retrieve of `refs` overwrites (for the overwrite confirm): the local entry of each ref, and for an
 * object its children too (retrieving the object writes all its fields).
 */
export function overwriteLocalKeys(refs: readonly { type: string; fullName: string }[], locals: readonly LocalRef[], childTypes: ReadonlySet<string>): string[] {
	const byOrgKey = new Map(locals.map((l) => [orgLookupKey(l.type, l.name), l.key]));
	const out = new Set<string>();
	for (const r of refs) {
		const own = byOrgKey.get(compKey(r.type, r.fullName));
		if (own) out.add(own);
		if (r.type === "CustomObject") for (const lk of partialDeployLocalKeys(r.fullName, locals, childTypes)) out.add(lk);
	}
	return [...out];
}

// ── Conflict choices ───────────────────────────────────────────────────────────

/** The choices whose row still exists and is still a conflict (a row that was resolved or left drops its choice). */
export function pruneConflictChoices(choices: ReadonlyMap<string, ConflictChoice>, rows: readonly SyncRow[]): Map<string, ConflictChoice> {
	const conflicts = new Set<string>();
	for (const r of rows) if (r.status === "conflict") conflicts.add(r.key);
	return new Map([...choices].filter(([k]) => conflicts.has(k)));
}

/** The override toggle cycles unset → keep local → take org → unset. */
export function nextChoice(c: ConflictChoice | undefined): ConflictChoice | undefined {
	return c === undefined ? "local" : c === "local" ? "org" : undefined;
}

/** Tooltip of the override toggle for its current state. */
export function choiceTitle(c: ConflictChoice | undefined): string {
	return c === "local" ? "Keep local: deploy wins (Retrieve skips this row). Click for Take org." : c === "org" ? "Take org: retrieve wins (Deploy skips this row). Click to clear." : "No override: the row takes part in Deploy and Retrieve (asks first). Click for Keep local.";
}

/** Storage key of the choices: they belong to one project and one org. */
export function choicesStoreKey(projectDir: string, org: string | null): string {
	return `${projectDir}|${org ?? ""}`;
}

export function choicesToJson(choices: ReadonlyMap<string, ConflictChoice>): Record<string, ConflictChoice> {
	return Object.fromEntries(choices);
}

/** Read stored choices; anything that is not "local" / "org" is dropped. */
export function choicesFromJson(raw: unknown): Map<string, ConflictChoice> {
	const out = new Map<string, ConflictChoice>();
	if (!raw || typeof raw !== "object") return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === "local" || v === "org") out.set(k, v);
	return out;
}

// ── Buttons ────────────────────────────────────────────────────────────────────

export interface ButtonState {
	label: string;
	disabled: boolean;
	title: string;
}

export interface ButtonInput {
	verb: string;
	cands: Candidates;
	/** An operation is running. */
	busy: boolean;
	/** Why nothing can run at all (no project, no org, org not loaded …). */
	blocked?: string;
	selected: number;
	/** What a click does, for the tooltip of an enabled button. */
	hint: string;
}

/** `Deploy (n)`, enabled or not, with the tooltip that says why (skipped rows). Conflicts never disable it. */
export function buttonState(i: ButtonInput): ButtonState {
	const n = i.cands.keys.length;
	const label = `${i.verb} (${n.toLocaleString("en-US")})`;
	const skipped = i.cands.skipped.map((s) => `${s.count} ${s.reason} skipped`).join(", ");
	if (i.blocked) return { label, disabled: true, title: i.blocked };
	if (i.busy) return { label, disabled: true, title: "An operation is running" };
	if (n === 0) return { label, disabled: true, title: i.selected === 0 ? "Select components first" : skipped || "None of the selected components applies" };
	return { label, disabled: false, title: [i.hint, skipped].filter(Boolean).join(" · ") };
}

// ── Selection overview ─────────────────────────────────────────────────────────

/** "5 selected (2 hidden) · 3 to deploy · 2 skipped" (the hidden part when the filter hides selected rows). Form: "2 selected · 0 to deploy · 2 skipped" (+ " — show all" while the only-selected filter is on); "" = hide the link. */
export function selectionSummary(verb: string, selected: number, taking: number, filterOn = false, hidden = 0): string {
	if (selected === 0 && !filterOn) return "";
	const n = (v: number) => v.toLocaleString("en-US");
	return `${n(selected)} selected${hidden > 0 ? ` (${n(hidden)} hidden)` : ""} · ${n(taking)} to ${verb} · ${n(selected - taking)} skipped${filterOn ? " — show all" : ""}`;
}

/** The banner text while only the selection is shown: "Showing your selection: 5 selected (2 hidden) · 3 to deploy · 2 skipped". */
export function selectionBannerText(verb: string, selected: number, taking: number, hidden = 0): string {
	return `Showing your selection: ${selectionSummary(verb, Math.max(selected, 0), taking, false, hidden) || "0 selected"}`;
}

/** Tooltip of the summary link: why rows are skipped ("1 equal (Skip equal components is on)"), else what a click does. */
export function selectionSummaryTitle(skipped: readonly { reason: string; count: number }[], filterOn: boolean): string {
	const why = skipped.map((s) => `${s.count} ${s.reason}${s.reason === "equal" ? " (Skip equal components is on)" : ""}`).join(", ");
	const click = filterOn ? "Click to show all components" : "Click to show only the selected components";
	return why ? `${why}. ${click}` : click;
}

// ── Run-time conflict confirmation ─────────────────────────────────────────────

export interface ConflictPrompt {
	message: string;
	detail: string;
	/** The one action button of the modal. */
	action: string;
}

/** The modal before a deploy / retrieve that includes conflict rows: up to 10 names, then "+n more". */
export function conflictPrompt(mode: "deploy" | "retrieve", keys: readonly string[]): ConflictPrompt {
	const n = keys.length;
	const names = keys.slice(0, 10).join("\n") + (n > 10 ? `\n+${n - 10} more` : "");
	const deploy = mode === "deploy";
	if (n === 1) {
		return {
			message: deploy ? "Overwrite the org’s version with your local version?" : "Overwrite your local version with the org’s version?",
			detail: `${keys[0]} ${deploy ? "has a newer version in the org. Deploying replaces it with the local one." : "has local changes. Retrieving replaces the local files with the org’s version."}`,
			action: deploy ? "Overwrite org" : "Overwrite local",
		};
	}
	return {
		message: deploy ? `${n} components have a newer version in the org. Overwrite them?` : `${n} components have local changes. Overwrite them?`,
		detail: `${deploy ? "Deploying replaces the org’s versions with your local ones" : "Retrieving replaces your local files with the org’s versions"}:\n${names}`,
		action: deploy ? "Overwrite org" : "Overwrite local",
	};
}

/** The modal of "Retrieve project": count, project and org, plus the locally changed components (up to 10, then "+n more"). */
export function retrieveProjectPrompt(count: number, project: string, org: string, changed: readonly string[]): { message: string; detail: string } {
	const list = changed.length === 0 ? "" : `\n\nChanged locally (${changed.length}):\n${changed.slice(0, 10).join("\n")}${changed.length > 10 ? `\n+${changed.length - 10} more` : ""}`;
	return { message: `Retrieve ${count.toLocaleString("en-US")} component${count === 1 ? "" : "s"} of project ${project} from ${org}? Local files will be overwritten.`, detail: `Your local versions are replaced by the org's.${list}` };
}

// ── History ────────────────────────────────────────────────────────────────────

export interface HistoryItemView {
	id: string;
	kind: HistoryKind;
	/** "Deploy", "Validate", "Retrieve", "Delete". */
	kindLabel: string;
	/** Alias / username shown. */
	org: string;
	when: string;
	whenExact: string;
	countText: string;
	ok: boolean;
	statusText: string;
	/** A deploy id exists: "Open in Setup" is offered. */
	deployId?: string;
	testLevel?: string;
	/** The optional "Deploy name" the user gave (local only). */
	label?: string;
	components: string[];
	errors: { component?: string; message: string }[];
	source: string;
}

const KIND_LABELS: Record<HistoryKind, string> = { deploy: "Deploy", validate: "Validate", retrieve: "Retrieve", delete: "Delete" };

/** The history list as the webview renders it. `orgLabel` turns the stored org (username) into what the user knows it by. */
export function historyViews(entries: readonly HistoryEntry[], now: number, orgLabel: (org: string) => string = (o) => o): HistoryItemView[] {
	return entries.map((e) => {
		const n = Math.max(e.componentCount, e.components.length);
		return {
			id: e.id,
			kind: e.kind,
			kindLabel: KIND_LABELS[e.kind] ?? e.kind,
			org: orgLabel(e.org),
			when: relativeTime(e.at, now),
			whenExact: new Date(e.at).toLocaleString(),
			countText: `${n.toLocaleString("en-US")} component${n === 1 ? "" : "s"}`,
			ok: e.ok,
			statusText: e.ok ? "ok" : "failed",
			deployId: e.deployId,
			testLevel: e.testLevel,
			...(e.label ? { label: e.label } : {}),
			components: e.components,
			errors: e.errors ?? [],
			source: e.source,
		};
	});
}

/** Setup page of a deployment (Setup → Deployment Status → details). */
export function deploymentSetupPath(deployId: string): string {
	return `/lightning/setup/DeployStatus/page?address=%2Fchangemgmt%2FmonitorDeploymentsDetails.apexp%3FasyncId%3D${encodeURIComponent(deployId)}`;
}

/** The row keys of a history entry that exist as rows, and how many do not (anymore). */
export function historyRowKeys(entry: Pick<HistoryEntry, "components">, rows: readonly SyncRow[]): { keys: string[]; missing: number } {
	const have = new Set(rows.map((r) => r.key));
	const keys: string[] = [];
	let missing = 0;
	for (const c of entry.components) {
		const k = rowKeyOf(c);
		if (have.has(k)) keys.push(k);
		else missing++;
	}
	return { keys: [...new Set(keys)], missing };
}

/**
 * Delete from org: only components that are not in the local project may go. `localKeys` are the row keys of the
 * local index (`orgLookupKey` of every entry, plus the `CustomObject:<Obj>` keys of partly local objects). A ref
 * is matched the way `buildSyncRows` matches an org component: `compKey(type, fullName)`.
 */
export function onlyOrgRefs<T extends { type: string; fullName: string }>(refs: readonly T[], localKeys: ReadonlySet<string>): { keep: T[]; dropped: T[] } {
	const keep: T[] = [];
	const dropped: T[] = [];
	for (const r of refs) (localKeys.has(compKey(r.type, r.fullName)) ? dropped : keep).push(r);
	return { keep, dropped };
}

// ── Presets ────────────────────────────────────────────────────────────────────

/**
 * Whether the selection differs from the loaded preset: order-independent set equality of the component keys. A preset
 * is "modified" as soon as one key is added to or removed from the selection.
 */
export function presetModified(presetKeys: readonly string[], selectedKeys: Iterable<string>): boolean {
	const preset = new Set(presetKeys);
	const selection = new Set(selectedKeys);
	if (preset.size !== selection.size) return true;
	for (const k of selection) if (!preset.has(k)) return true;
	return false;
}
