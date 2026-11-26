/**
 * Deploy & Retrieve Metadata webview: the union of the local project and the org's metadata in a virtualized grid
 * with the filter sidebar, one selection, per-row Deploy / Retrieve / Diff and conflict choices, and the Deploy / Retrieve /
 * Delete sections plus the history. Bundled by esbuild to resources/webview/syncCenter.js; talks to
 * SyncCenterPanelProvider via postMessage.
 *
 * The rows come from `buildSyncRows` (src/utils/syncCenterPure.ts) over what the host feeds in: the org listing
 * (streamed in batches), the local index, the local change info and the compare results.
 * The button rules are `deployCandidates` / `retrieveCandidates` / `deleteCandidates`; nothing of them is repeated.
 */
import {
	DEFAULT_FILTER,
	Facets,
	FilterContext,
	FilterState,
	SearchIndex,
	SortKey,
	buildIndex,
	computeFacets,
	filterIndices,
	highlightRanges,
	highlightTerms,
	matchPairs,
	parsePastedPairs,
	relativeTime,
	sortIndices,
} from "../utils/orgBrowser/filter";
import { splitByVisibility } from "../utils/orgBrowser/selection";
import { Comp, ListFailure, TypeInfo } from "../utils/orgBrowser/types";
import { CompareProgress, ContentInfoMap, LocalInfoMap, compareStatusText, compareSummary, sourceBreakdown } from "../utils/compareStatusPure";
import { layerSummary } from "../utils/compareLayersPure";
import {
	ConflictChoice,
	SYNC_CENTER_VOCAB,
	SYNC_STATUS_LABELS,
	SyncRow,
	buildSyncRows,
	deleteCandidates,
	deployCandidates,
	isDiffable,
	retrieveCandidates,
	retrieveProjectKeys,
	CenterMode,
	normalizeMode,
	syncStatusOptions,
	takesPart,
	overwriteText,
} from "../utils/syncCenterPure";
import {
	browseFilter,
	buttonState,
	centerFilterKeptOnClear,
	choicesFromJson,
	choicesStoreKey,
	choicesToJson,
	historyRowKeys,
	historyViews,
	initialGroup,
	initialStatusFilter,
	choiceTitle,
	nextChoice,
	pruneConflictChoices,
	selectionBannerText,
	selectionSummary,
	selectionSummaryTitle,
	rowDeployLocalKeys,
	presetModified,
	deselectKeys,
	SelectionStore,
	sameSelection,
	storedSelection,
	withStoredSelection,
	rowKeyOf,
	rowRetrieveRef,
} from "../utils/syncCenterUiPure";
import {
	ColumnId,
	ColumnLayout,
	PaneWidths,
	GRID_MIN,
	SIDE_MIN,
	RIGHT_MIN,
	SPLITTER_W,
	SIDE_DEFAULT,
	RIGHT_DEFAULT,
	defaultPanes,
	fitPanes,
	normalizePanes,
	columnLabel,
	defaultLayout,
	gridTemplate,
	isFixedColumn,
	moveColumn,
	normalizeLayout,
	setColumnVisible,
	setColumnWidth,
	visibleColumns,
} from "../utils/syncCenterColumnsPure";
import { deleteTestHint } from "../utils/deployTestArgsPure";
import { HistoryEntry } from "../utils/historyPure";
import type { DeployDetails, DeployListItem } from "../utils/deployListPure";
import { failureLine, visibleFailures, type OpMessage } from "../utils/syncCenterOpPure";
import {
	OP_KIND_GLYPH,
	canCancelOp,
	componentErrorWhere,
	countsText,
	deployRowView,
	detailsAreEmpty,
	errorPercent,
	isActivePhase,
	opActions,
	opElapsedText,
	opJustFinished,
	opTitle,
	phaseLabel,
	progressPercent,
	testErrorName,
} from "../utils/syncCenterActivityUiPure";
import { WebPreset } from "../utils/presetsWebPure";
import { $, createFilterBar, esc, toggleIn, FilterBar } from "./shared/filterBar";
import { createSharedFilterSync } from "./shared/sharedFilter";
import { filterTestList, mountTestTree } from "./shared/testTree";
import { mountTestSuites } from "./shared/testSuites";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrgOpt {
	label: string;
	username: string;
}

interface Options {
	skipEqualDeploy: boolean;
	skipEqualRetrieve: boolean;
	confirmOverwrite: boolean;
	wholeObject: boolean;
	validateOnly: boolean;
	autoGit: boolean;
	testLevel: string;
	/** Test level of the Delete section (its own, not the Deploy section's). */
	delTestLevel: string;
}

interface UiState {
	filter: FilterState;
	sort: { key: SortKey; dir: 1 | -1 };
	group: boolean;
	collapsed: string[];
	/** The "In project" status default was applied once (a store from before it gets it on the next load). */
	statusDefault?: boolean;
	/** The "Group by type" default was applied once (a store from before it gets it on the next load). */
	groupDefault?: boolean;
	filtersCollapsed?: boolean;
	/** Superseded by the per-computer pane widths; still read once as the right panel's width. */
	rightWidth?: number;
	/** The action chosen at the top of the right panel. */
	mode?: CenterMode;
	opts: Options;
	/** Conflict choices per project and org (`choicesStoreKey`). */
	choices: Record<string, Record<string, ConflictChoice>>;
	/** The selection per project (component keys are org-independent): survives org switches, hide / restore and reloads. */
	selections?: SelectionStore;
}

interface Group {
	g: true;
	type: string;
	rows: number[];
	collapsed: boolean;
}

type Item = number | Group;

interface LoadState {
	mode: "cache" | "live" | "refresh" | "types";
	only?: string[];
	done: number;
	total: number;
	label: string;
}

interface LocalEntryMsg {
	type: string;
	name: string;
	key: string;
	/** Project-relative path of the component's main file. */
	path?: string;
}

// ── State ──────────────────────────────────────────────────────────────────────

const api = acquireVsCodeApi();
const post = (msg: unknown) => api.postMessage(msg);
// The shared project selector (panelProjectUi.ts) posts through this handle.
(window as unknown as { __asfxApi: unknown }).__asfxApi = api;

const ROW_H = 28;
const HEAD_H = 30;
const SIDE_MIN_W = 560;
/** Extra width of the checkbox column in the group-by-type view (room for the caret; rows are indented under it). */
const GROUP_INDENT = 28;
/** Pane widths (filter sidebar, right panel), stored per computer. */
let panes: PaneWidths = defaultPanes();
let panesSaveTimer: number | undefined;
const PROV_TIP = "Based on dates — contents not compared yet";

function defaultOpts(): Options {
	return { skipEqualDeploy: true, skipEqualRetrieve: true, confirmOverwrite: true, wholeObject: false, validateOnly: false, autoGit: false, testLevel: "RunRelevantTests", delTestLevel: "NoTestRun" };
}

function defaultUi(): UiState {
	return {
		filter: { ...DEFAULT_FILTER, status: initialStatusFilter(undefined, false) },
		sort: { key: "name", dir: 1 },
		group: true,
		collapsed: [],
		statusDefault: true,
		groupDefault: true,
		opts: defaultOpts(),
		choices: {},
		selections: {},
	};
}

let ui: UiState = defaultUi();
let orgs: OrgOpt[] = [];
let currentOrg: string | null = null;
/** The current org is production or could not be verified (the host's `production` flag). */
let orgIsProduction = false;
let hasProject = true;
let projectDir = "";
let childTypes = new Set<string>();
/** The org listing. */
let orgComps: Comp[] = [];
let types: TypeInfo[] = [];
let failures: ListFailure[] = [];
let listedAt = 0;
let loading: LoadState | null = null;
let pending: Comp[] | null = null;
let errorView: { state: string; message: string } | null = null;
let noOrg = false;
let local = { entries: [] as LocalEntryMsg[], partial: [] as string[], retrieved: {} as Record<string, number>, known: false };
let me = { ids: [] as string[], name: "" };
/** Column layout (order, visibility, widths); stored per computer by the host. */
let layout: ColumnLayout = defaultLayout();
/** The host is busy loading / scanning / listing (`{type:"busy", on, label}`). */
let hostBusy: { label: string } | null = null;
/** Project-relative file path by local index key (the "Local path" column). */
let localPaths = new Map<string, string>();
let localInfo: LocalInfoMap | undefined;
let contentInfo: ContentInfoMap = {};
let cmpProgress: CompareProgress | null = null;
/** The union rows, parallel to `idx.comps`. */
let syncRows: SyncRow[] = [];
let rowIndex = new Map<string, number>();
let localKeyToRow = new Map<string, string>();
let idx: SearchIndex = buildIndex([]);
let statusArr: Uint8Array = new Uint8Array(0);
/** Local change time per row index (see `SyncRow.localT`). */
let localTimes: Float64Array = new Float64Array(0);
let rowsDirty = true;
let selected = new Set<string>();
let choices = new Map<string, ConflictChoice>();
let results = new Map<string, { ok: boolean; error?: string }>();
let rows: number[] = [];
let items: Item[] = [];
let facets: Facets | null = null;
let terms: string[] = [];
let active = -1;
let anchor = -1;
let bar: FilterBar;
let first = -1;
let last = -1;
let busyOp: string | null = null;
/** A deploy / retrieve / delete was requested and its result has not come back (also covers the host's prompts). */
let opPending = false;
let history: HistoryEntry[] = [];
let historyOpen = false;
const historyExpanded = new Set<string>();
/** Activity tab: which segment is shown. */
let activitySeg: "deploys" | "history" = "deploys";
/** The last operation started from the Center (`{type:"op"}`), shown in the card until dismissed. */
let curOp: OpMessage | null = null;
/** The op card lists all its failures (not just the first few). */
let opFailuresExpanded = false;
/** The org's recent deploys (`{type:"deploys"}`); `null` = not loaded for this org yet. */
let deploys: DeployListItem[] | null = null;
let deploysError = "";
let deploysLoading = false;
/** When the shown list was fetched (a cached list: when it was cached); 0 = none. */
let deploysAt = 0;
let deployFailedOnly = false;
const deployExpanded = new Set<string>();
/** Details fetched per deploy id (kept until the org changes). */
const deployDetailsCache = new Map<string, { details: DeployDetails; error?: string }>();
const deployDetailsAsked = new Set<string>();
let presets: WebPreset[] = [];
/** The selection sent with a "Save preset", applied to the list when the host confirms the save. */
let pendingPresetKeys: { name: string; keys: string[] } | undefined;
const suites = mountTestSuites({ post, checked: checkedTests, onApplied: () => renderRight(), setStatus, scope: () => $("test-list") });
const delSuites = mountTestSuites({ post, checked: checkedDeleteTests, onApplied: () => renderRight(), setStatus, idPrefix: "del-", scope: () => $("del-test-list") });
let testClasses: { label: string; description: string }[] = [];
let statusText = "";
/** True while the status line shows a transient hint (not an operation result): the next selection change clears it. */
let statusIsHint = false;
/** The first listing of this org finished (a selection carried in by "open in the Center" survives the `reset` before it). */
let loadedOnce = false;

const sharedSync = createSharedFilterSync({
	filter: () => ui.filter,
	applied: () => {
		bar.syncSearchInput();
		recompute(true);
	},
	send: (s) => post({ command: "sharedFilter", query: s.query, types: s.types }),
});

// ── Persistence ────────────────────────────────────────────────────────────────

let saveTimer: number | undefined;
function saveUi(): void {
	if (saveTimer) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		api.setState(ui);
		post({ command: "uiState", state: ui });
	}, 400);
}

function mergeUi(saved: Partial<UiState> | null | undefined): void {
	if (!saved) return;
	const d = defaultUi();
	ui = {
		...d,
		...saved,
		filter: { ...d.filter, ...(saved.filter ?? {}), status: initialStatusFilter(saved.filter?.status, !!saved.statusDefault), onlySelected: false },
		statusDefault: true,
		group: initialGroup(saved.group, !!saved.groupDefault),
		groupDefault: true,
		sort: saved.sort ?? d.sort,
		opts: { ...d.opts, ...(saved.opts ?? {}) },
		choices: saved.choices && typeof saved.choices === "object" ? saved.choices : {},
		selections: saved.selections && typeof saved.selections === "object" ? saved.selections : {},
	};
}

/** Mirror the selection into the UI state (per project) and save it when it changed. */
function syncSelectionToUi(): void {
	if (!projectDir) return;
	if (sameSelection(selected, storedSelection(ui.selections, projectDir))) return;
	ui.selections = withStoredSelection(ui.selections ?? {}, projectDir, selected);
	saveUi();
}

function loadChoices(): void {
	choices = choicesFromJson(ui.choices[choicesStoreKey(projectDir, currentOrg)]);
}

function persistChoices(): void {
	const k = choicesStoreKey(projectDir, currentOrg);
	if (choices.size === 0) delete ui.choices[k];
	else ui.choices[k] = choicesToJson(choices);
	saveUi();
}

// ── Rows ───────────────────────────────────────────────────────────────────────

const keyAt = (i: number) => syncRows[i].key;

function baseType(t: string): string {
	return t.replace(/ \(.*\)$/, "");
}

/** Types whose org listing is available: while the first listing streams, only the ones that arrived. */
function listedTypes(): Set<string> {
	if (loading && !pending && loading.mode === "live") return new Set(orgComps.map((c) => c.t));
	const failed = new Set(failures.map((f) => baseType(f.type)));
	return new Set(types.map((t) => t.name).filter((n) => !failed.has(n)));
}

/** Everything is known: the listing finished and the project was read (a stale selection may be pruned). */
function settled(): boolean {
	return !loading && local.known && listedAt > 0;
}

function ensureRows(): void {
	if (!rowsDirty) return;
	rowsDirty = false;
	localPaths = new Map(local.entries.filter((e) => e.path).map((e) => [e.key, e.path as string]));
	syncRows = buildSyncRows({
		localKnown: local.known,
		local: local.entries,
		partialKeys: local.partial,
		org: orgComps,
		listedTypes: listedTypes(),
		localInfo,
		contentInfo,
		retrieved: local.retrieved,
	});
	const comps: Comp[] = new Array(syncRows.length);
	const st = new Uint8Array(syncRows.length);
	const lts = new Float64Array(syncRows.length);
	rowIndex = new Map();
	localKeyToRow = new Map();
	for (let i = 0; i < syncRows.length; i++) {
		const r = syncRows[i];
		comps[i] = r.comp ?? { t: r.type, n: r.name, ns: "", ms: "", by: "", bi: "", lm: 0, cd: 0, id: "", f: "" };
		st[i] = r.code;
		lts[i] = r.localT ?? 0;
		rowIndex.set(r.key, i);
		if (r.localKey) localKeyToRow.set(r.localKey, r.key);
	}
	idx = buildIndex(comps);
	statusArr = st;
	localTimes = lts;
	// A conflict choice belongs to its row while it is a conflict; a vanished or resolved row drops it.
	if (settled() && choices.size > 0) {
		const kept = pruneConflictChoices(choices, syncRows);
		if (kept.size !== choices.size) {
			choices = kept;
			persistChoices();
		}
	}
	// The selection is never pruned against the rows: a key in no row (other org, not listed yet) stays and counts as hidden.
}

// ── Recompute ──────────────────────────────────────────────────────────────────

function ctx(): FilterContext {
	return { now: Date.now(), status: statusArr, localTimes, vocab: SYNC_CENTER_VOCAB, selected, meIds: me.ids, meName: me.name };
}

let visibleKeysCache: Set<string> | null = null;

/** Keys of the rows the current filter shows (lazy; reset on every recompute). */
function visibleKeys(): Set<string> {
	if (!visibleKeysCache) visibleKeysCache = new Set(rows.map(keyAt));
	return visibleKeysCache;
}

function hiddenSelected(): string[] {
	return selected.size === 0 ? [] : splitByVisibility(selected, visibleKeys()).hidden;
}

function markRowsDirty(): void {
	rowsDirty = true;
}

function recompute(resetScroll = false): void {
	sharedSync.changed();
	syncSelectionToUi();
	visibleKeysCache = null;
	ensureRows();
	const c = ctx();
	terms = highlightTerms(ui.filter.query);
	rows = sortIndices(idx, filterIndices(idx, ui.filter, c), ui.sort.key, ui.sort.dir, statusArr);
	facets = computeFacets(idx, ui.filter, c);
	buildItems();
	if (resetScroll) $("scroller").scrollTop = 0;
	active = Math.min(active, items.length - 1);
	renderAll();
}

function buildItems(): void {
	if (!ui.group) {
		items = rows;
		return;
	}
	const byType = new Map<string, number[]>();
	for (const i of rows) {
		const t = idx.comps[i].t;
		const arr = byType.get(t);
		if (arr) arr.push(i);
		else byType.set(t, [i]);
	}
	const collapsed = new Set(ui.collapsed);
	const out: Item[] = [];
	for (const t of [...byType.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
		const g: Group = { g: true, type: t, rows: byType.get(t)!, collapsed: collapsed.has(t) };
		out.push(g);
		if (!g.collapsed) for (const i of g.rows) out.push(i);
	}
	items = out;
}

// ── Rendering: grid ────────────────────────────────────────────────────────────

function hl(text: string): string {
	const ranges = highlightRanges(text, terms);
	if (ranges.length === 0) return esc(text);
	let out = "";
	let at = 0;
	for (const [s, e] of ranges) {
		out += esc(text.slice(at, s)) + "<mark>" + esc(text.slice(s, e)) + "</mark>";
		at = e;
	}
	return out + esc(text.slice(at));
}

const ICON = {
	diff: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 4h9.600l-2-2 .7-.7 3.200 3.200-3.200 3.200-.7-.7 2-2H2zm12 8H4.400l2 2-.7.700L2.500 11.500l3.200-3.200.7.700-2 2H14z"/></svg>',
	chevron: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6 4l4.500 4L6 12z"/></svg>',
	// Same 14 px size as the other row icons.
	// 16 px, full-strength stroke (the group header button sets the colour).
	refresh: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.600-3.700"/><path d="M13 2.500v3h-3"/></svg>',
	swap: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.400" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13V3M2.500 5.500L5 3l2.500 2.500M11 3v10M8.500 10.500L11 13l2.500-2.500"/></svg>',
	deploy: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1.500l5 5-.7.700-3.800-3.800V14h-1V3.400L3.700 7.200 3 6.500z"/></svg>',
	retrieve: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 14.500l-5-5 .7-.7 3.800 3.800V2h1v10.600l3.800-3.800.7.700z"/></svg>',
};

/** Sort key of the columns that can be sorted. */
const SORT_OF: Partial<Record<ColumnId, SortKey>> = { name: "name", type: "type", ns: "ns", by: "by", mod: "modified", status: "status" };

const BADGE_TEXT: Record<string, string> = {
	"only-local": "Only local",
	"only-org": "Only in org",
	partial: "Partly local",
	equal: "Equal",
	"changed-locally": "Changed locally",
	"changed-in-org": "Changed in org",
	conflict: "Conflict",
	unknown: "Unknown",
};

const BADGE_TIP: Record<string, string> = {
	equal: "Same as the org's copy",
	"changed-locally": "Changed in the project since the last sync with the org",
	"changed-in-org": "Changed in the org since the last sync",
	conflict: "Changed in the project and in the org since the last sync",
};

function statusBadge(r: SyncRow): string {
	const res = results.get(r.key);
	let s: string;
	switch (r.status) {
		case "only-local":
			s = '<span class="badge only-local" title="In the project, not in the org">Only local</span>';
			break;
		case "only-org":
			s = '<span class="badge only-org" title="In the org, not in the project">Only in org</span>';
			break;
		case "partial":
			s = '<span class="badge partial" title="Some parts (fields, record types …) are in the project, the object file itself is not.">Partly local</span>';
			break;
		case "unknown":
			s = `<span class="badge unknown" title="${esc(r.why === "org" ? "The org listing of this type is not available" : local.known ? "Local changes not read yet" : "The project was not read yet")}">${esc(SYNC_STATUS_LABELS.unknown)}</span>`;
			break;
		default: {
			const cmp = r.localKey ? contentInfo[r.localKey] : undefined;
			const what = BADGE_TIP[r.status] ?? "";
			const tip = r.provisional ? `${what} (${PROV_TIP})` : `${what} (Contents compared ${cmp && cmp[1] ? new Date(cmp[1]).toLocaleString() : "just now"})`;
			s = `<span class="badge ${badgeClass(r.status)}${r.provisional ? " prov" : ""}" title="${esc(tip)}">${esc(BADGE_TEXT[r.status])}</span>`;
		}
	}
	if (res) s += res.ok ? ' <span class="res ok" title="Retrieved">✓</span>' : ` <span class="res bad" title="${esc(res.error ?? "Failed")}">✗</span>`;
	return s;
}

function badgeClass(status: string): string {
	return status === "equal" ? "equal" : status === "changed-locally" ? "changed-local" : status === "changed-in-org" ? "changed-org" : "conflict";
}

function choiceHtml(r: SyncRow): string {
	const c = choices.get(r.key);
	return `<button type="button" class="ibtn choicebtn${c ? " on" : ""}" data-choice="cycle" title="${esc(choiceTitle(c))}" aria-label="${esc(choiceTitle(c))}" aria-pressed="${c !== undefined}">${ICON.swap}${c ? `<span class="cl">${c === "local" ? "L" : "O"}</span>` : ""}</button>`;
}

function actsHtml(r: SyncRow): string {
	const conflict = r.status === "conflict";
	const canDeploy = r.local || r.status === "partial";
	const ph = '<span class="ibtn ph" aria-hidden="true"></span>';
	return (
		`<span class="c acts">` +
				(canDeploy
			? `<button class="ibtn deploy" data-act="deployRow" title="${conflict ? "Deploy this component and overwrite the org’s version (asks first)" : "Deploy this component to the org"}" aria-label="Deploy ${esc(r.name)}">${ICON.deploy}</button>`
			: ph) +
		(r.inOrg
			? `<button class="ibtn retrieve" data-act="retrieveRow" title="${conflict ? "Retrieve this component and overwrite the local version (asks first)" : "Retrieve this component from the org"}" aria-label="Retrieve ${esc(r.name)}">${ICON.retrieve}</button>`
			: ph) +
		(isDiffable(r) ? `<button class="ibtn" data-act="diff" title="Compare with the org" aria-label="Compare with the org">${ICON.diff}</button>` : ph) +
		(conflict ? choiceHtml(r) : "") +
		`</span>`
	);
}

function cellHtml(id: ColumnId, r: SyncRow, c: Comp): string {
	switch (id) {
		case "name":
			return `<span class="c nm${ui.group ? " ind" : ""}" title="${esc(r.key)}">${hl(r.name)}</span>`;
		case "type":
			return `<span class="c ty">${hl(r.type)}</span>`;
		case "ns":
			return `<span class="c ns">${esc(c.ns)}</span>`;
		case "by":
			return `<span class="c by" title="${esc(c.by)}">${esc(c.by)}</span>`;
		case "mod":
			return `<span class="c md" title="${esc(c.lm ? new Date(c.lm).toLocaleString() : "")}">${esc(relativeTime(c.lm, Date.now()))}</span>`;
		case "modLocal": {
			const t = r.localT ?? 0;
			return `<span class="c md" title="${esc(t ? new Date(t).toLocaleString() : "")}">${esc(t ? relativeTime(t, Date.now()) : "")}</span>`;
		}
		case "status":
			return `<span class="c st">${statusBadge(r)}</span>`;
		case "created":
			return `<span class="c md" title="${esc(c.cd ? new Date(c.cd).toLocaleString() : "")}">${c.cd ? esc(new Date(c.cd).toLocaleDateString()) : ""}</span>`;
		case "id":
			return `<span class="c mono ty" title="${esc(c.id)}">${esc(c.id)}</span>`;
		case "file":
			return `<span class="c ty" title="${esc(c.f)}">${esc(c.f)}</span>`;
		case "path": {
			const p = r.localKey ? (localPaths.get(r.localKey) ?? "") : "";
			return `<span class="c ty" title="${esc(p)}">${esc(p)}</span>`;
		}
		case "state":
			return `<span class="c ty">${esc(c.ms)}</span>`;
		case "actions":
			return actsHtml(r);
	}
}

const modeOf = (): CenterMode => normalizeMode(ui.mode);

function rowHtml(pos: number, i: number): string {
	const r = syncRows[i];
	const c = idx.comps[i];
	const sel = selected.has(r.key);
	const failed = results.get(r.key);
	let cells = "";
	for (const col of visibleColumns(layout)) cells += cellHtml(col.id, r, c);
	// Rows that cannot take part in the chosen action are dimmed (and cannot be ticked, unless they already are).
	const part = takesPart(modeOf(), r);
	return (
		`<div class="row${sel ? " sel" : ""}${pos === active ? " active" : ""}${failed && !failed.ok ? " failed" : ""}${part ? "" : " dim"}" data-pos="${pos}" role="row" aria-selected="${sel}">` +
		`<span class="c cb"><input type="checkbox" class="rowcb" tabindex="-1" ${sel ? "checked" : ""}${part || sel ? "" : " disabled"} aria-label="Select ${esc(r.name)}"></span>` +
		cells +
		`</div>`
	);
}

function groupHtml(pos: number, g: Group): string {
	let n = 0;
	for (const i of g.rows) if (selected.has(keyAt(i))) n++;
	const all = n === g.rows.length && n > 0;
	return (
		`<div class="row grp${pos === active ? " active" : ""}" data-pos="${pos}" data-type="${esc(g.type)}" role="row">` +
		`<span class="c cb"><input type="checkbox" class="grpcb" tabindex="-1" ${all ? "checked" : ""} data-partial="${n > 0 && !all}" aria-label="Select all ${esc(g.type)}"><span class="chev${g.collapsed ? "" : " open"}">${ICON.chevron}</span></span>` +
		`<span class="c gname"><b>${hl(g.type)}</b><span class="gcount">${g.rows.length.toLocaleString()}</span>` +
		`<button class="gref" data-act="refreshType" title="Re-list ${esc(g.type)} only" aria-label="Re-list ${esc(g.type)} only">${ICON.refresh}</button></span></div>`
	);
}

function renderRows(): void {
	const sc = $("scroller");
	const n = items.length;
	const view = Math.ceil(sc.clientHeight / ROW_H) + 12;
	const f = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 6);
	const l = Math.min(n, f + view);
	if (f === first && l === last && !renderRows.force) return;
	renderRows.force = false;
	first = f;
	last = l;
	let html = "";
	for (let p = f; p < l; p++) {
		const it = items[p];
		html += typeof it === "number" ? rowHtml(p, it) : groupHtml(p, it);
	}
	$("rowsEl").innerHTML = html;
	($("rowsEl").style as CSSStyleDeclaration).transform = `translateY(${f * ROW_H}px)`;
	for (const cb of $("rowsEl").querySelectorAll<HTMLInputElement>(".grpcb")) cb.indeterminate = cb.dataset.partial === "true";
}
renderRows.force = false;

function invalidateRows(): void {
	renderRows.force = true;
	renderRows();
}

/** The column headers of the visible columns, in layout order (the checkbox cell is static). */
function renderHeader(): void {
	$("hcols").innerHTML = visibleColumns(layout)
		.map((c) => {
			const sort = SORT_OF[c.id];
			const fixed = isFixedColumn(c.id);
			const sorted = sort && sort === ui.sort.key;
			return (
				`<span class="hcell${sorted ? " sorted" : ""}" data-col="${c.id}"${sort ? ` data-sort="${sort}"` : ""}${sorted ? ` data-dir="${ui.sort.dir === 1 ? "asc" : "desc"}"` : ""}${fixed ? "" : ' draggable="true"'} title="${fixed ? "" : "Drag to reorder · "}right-click for columns">` +
				`${esc(columnLabel(c.id))}<i class="grip" data-col="${c.id}" title="Drag to resize · double-click to reset"></i></span>`
			);
		})
		.join("");
}

function renderGridChrome(): void {
	$("spacer").style.height = items.length * ROW_H + "px";
	const total = idx.comps.length;
	$("countInfo").textContent = total ? (rows.length === total ? `${total.toLocaleString()} components` : `${rows.length.toLocaleString()} of ${total.toLocaleString()}`) : "";
	if (ui.filter.onlySelected) $("countInfo").textContent = "Selection";
	const mode = modeOf();
	const part = rows.filter((i) => takesPart(mode, syncRows[i]));
	const allSel = part.length > 0 && part.every((i) => selected.has(keyAt(i)));
	const gt = $("groupToggle");
	gt.setAttribute("aria-pressed", String(ui.group));
	gt.classList.toggle("on", ui.group);
	$("collapseAll").hidden = !ui.group;
	const allCollapsed = ui.group && ui.collapsed.length > 0 && ui.collapsed.length >= new Set(rows.map((i) => idx.comps[i].t)).size;
	$("collapseAll").title = allCollapsed ? "Expand all" : "Collapse all";
	$("collapseAll").setAttribute("aria-label", allCollapsed ? "Expand all" : "Collapse all");
	const hc = $("headCb") as HTMLInputElement;
	const selTitle = `${allSel ? "Deselect" : "Select"} all filtered (${part.length.toLocaleString()})` + (part.length < rows.length ? ` · ${(rows.length - part.length).toLocaleString()} shown row(s) cannot take part in ${mode === "deploy" ? "a deploy" : mode === "retrieve" ? "a retrieve" : "a delete"}` : "");
	hc.title = selTitle;
	hc.setAttribute("aria-label", selTitle);
	hc.checked = allSel;
	hc.indeterminate = !allSel && part.some((i) => selected.has(keyAt(i)));
	for (const th of document.querySelectorAll<HTMLElement>(".hcell[data-sort]")) {
		const k = th.dataset.sort;
		th.classList.toggle("sorted", k === ui.sort.key);
		th.dataset.dir = k === ui.sort.key ? (ui.sort.dir === 1 ? "asc" : "desc") : "";
	}
	renderCompareInfo(); // the button's count follows the selection and the filter
}

// ── Rendering: top bar, listing state ──────────────────────────────────────────

function renderListed(): void {
	const el = $("listedInfo");
	const prog = $("progress");
	const bar = $("progressBar");
	const cmpRunning = cmpProgress?.state === "running";
	const busyNow = !!loading || !!hostBusy || cmpRunning;
	if (loading) {
		el.textContent = loading.total ? `Loaded ${loading.done.toLocaleString()}/${loading.total.toLocaleString()} types…` : "Listing metadata…";
	} else if (hostBusy) {
		el.textContent = hostBusy.label || "Loading…";
	} else {
		el.textContent = listedAt ? `Listed ${relativeTime(listedAt, Date.now())}` : "";
		el.title = listedAt ? new Date(listedAt).toLocaleString() : "";
	}
	// A thin bar under the top bar: filled while the listing reports progress, otherwise indeterminate.
	const determinate = !!loading && loading.total > 0;
	prog.hidden = !busyNow;
	prog.classList.toggle("indet", busyNow && !determinate);
	bar.style.width = determinate ? Math.round((loading!.done / loading!.total) * 100) + "%" : "";
	prog.setAttribute("aria-busy", String(busyNow));
	$("refreshBtn").toggleAttribute("disabled", noOrg || !!loading || !!hostBusy);
	renderCompareInfo();
}

function renderCompareInfo(): void {
	const el = $("cmpInfo");
	if (noOrg || !hasProject || !listedAt) {
		el.textContent = "";
		el.title = "";
	} else {
		ensureRows();
		const proj = syncRows.filter((r) => r.local && r.inOrg && r.localKey).map((r) => r.localKey!);
		const sum = compareSummary(contentInfo, proj);
		el.textContent = compareStatusText(cmpProgress, sum.lastAt, (t) => relativeTime(t, Date.now()));
		const failed = cmpProgress?.failed ?? 0;
		const tip = [`${sum.verified.toLocaleString("en-US")} of ${proj.length.toLocaleString("en-US")} project components verified by content compare`];
		if (sum.lastAt > 0) tip.push(`Last compared ${new Date(sum.lastAt).toLocaleString()}`);
		const by = layerSummary(sourceBreakdown(contentInfo, proj));
		if (by) tip.push(`Decided by: ${by}`);
		if (failed > 0) tip.push(`${failed} component${failed === 1 ? "" : "s"} could not be compared (they keep the date-based status)`);
		el.title = tip.join("\n");
	}
	const running = cmpProgress?.state === "running";
	const n = compareKeys().keys.length;
	$("cmpBtn").textContent = `≈ Compare contents${n > 0 ? ` (${n.toLocaleString()})` : ""}`;
	$("cmpBtn").toggleAttribute("disabled", noOrg || !hasProject || !listedAt || n === 0);
	$("cmpCancel").hidden = !running;
}

/** What "Compare contents" works on: the selected rows that are in the project, else the project rows the filter shows. */
function compareKeys(): { keys: string[]; force: boolean } {
	ensureRows();
	const isLocal = (k: string) => {
		const i = rowIndex.get(k);
		return i !== undefined && syncRows[i].local;
	};
	if (selected.size > 0) return { keys: [...selected].filter(isLocal), force: true };
	return { keys: rows.map(keyAt).filter(isLocal), force: rows.length < idx.comps.length };
}

function renderOverlay(): void {
	const ov = $("overlay");
	const banner = $("banner");
	let overlayHtml = "";
	if (noOrg) {
		overlayHtml = '<div class="card"><h3>No authorized org</h3><p>Authorize an org to compare the project with it.</p><button class="primary" data-ov="connectOrg">Authorize an org</button></div>';
	} else if (errorView && idx.comps.length === 0) {
		const btns =
			errorView.state === "authInvalid"
				? '<button class="primary" data-ov="reauth">Re-authenticate</button><button data-ov="chooseOrg">Choose another org</button>'
				: errorView.state === "noDefaultOrg"
					? '<button class="primary" data-ov="chooseOrg">Choose an org</button>'
					: '<button class="primary" data-ov="retry">Retry</button>';
		overlayHtml = `<div class="card err"><h3>${errorView.state === "authInvalid" ? "Org connection is not valid" : "Couldn’t list metadata"}</h3><p>${esc(errorView.message)}</p><div class="btns">${btns}</div></div>`;
	} else if (loading && idx.comps.length === 0) {
		overlayHtml = `<div class="card"><h3>Listing metadata…</h3><p>${loading.total ? `Loaded ${loading.done.toLocaleString()}/${loading.total.toLocaleString()} types…` : "Reading the org’s metadata types…"}</p></div>`;
	} else if (idx.comps.length === 0 && !errorView && !loadedOnce && !listedAt) {
		overlayHtml = `<div class="card"><h3>Loading…</h3><p>${esc(hostBusy?.label || "Reading the project and the org’s metadata…")}</p><div class="skel" aria-hidden="true"><i style="width:92%"></i><i style="width:78%"></i><i style="width:85%"></i></div></div>`;
	} else if (idx.comps.length === 0 && !loading && listedAt && local.known) {
		overlayHtml = '<div class="card"><h3>Nothing to show</h3><p>Neither the org nor the project has components.</p></div>';
	}
	ov.innerHTML = overlayHtml;
	ov.hidden = overlayHtml === "";
	const msgs: string[] = [];
	if (errorView && idx.comps.length > 0) {
		const btn = errorView.state === "authInvalid" ? '<button data-ov="reauth">Re-authenticate</button>' : '<button data-ov="retry">Retry</button>';
		msgs.push(`<div class="bn err">${esc(errorView.message)} ${btn}</div>`);
	}
	if (!hasProject) msgs.push('<div class="bn info">No SFDX project is open — you can browse the org, but deploy and retrieve are disabled. Open a folder with sfdx-project.json.</div>');
	banner.innerHTML = msgs.join("");

	const fb = $("failBox");
	if (failures.length > 0) {
		fb.hidden = false;
		fb.innerHTML =
			`<details><summary>Couldn’t list (${failures.length})</summary><ul>` +
			failures
				.map((f) => `<li><b>${esc(f.type)}</b> — ${esc(f.error)} <button class="linkbtn" data-ov="retryType" data-type="${esc(baseType(f.type))}">Retry</button></li>`)
				.join("") +
			"</ul></details>";
	} else {
		fb.hidden = true;
		fb.innerHTML = "";
	}
}

function renderOrgSelect(): void {
	const sel = $("org") as HTMLSelectElement;
	sel.innerHTML = orgs.map((o) => `<option value="${esc(o.username)}"${o.username === currentOrg ? " selected" : ""}>${esc(o.label)}</option>`).join("");
	if (currentOrg && !orgs.some((o) => o.username === currentOrg)) sel.insertAdjacentHTML("afterbegin", `<option value="${esc(currentOrg)}" selected>${esc(currentOrg)}</option>`);
	sel.disabled = orgs.length === 0;
}

// ── Rendering: right panel ─────────────────────────────────────────────────────

function blockedReason(): string | undefined {
	if (!hasProject) return "Open an SFDX project (a folder with sfdx-project.json) first.";
	if (noOrg || !currentOrg) return "Choose an org first.";
	if (errorView) return "The org could not be listed.";
	if (!local.known) return "The project is being read…";
	return undefined;
}

function currentTestLevel(): string {
	return document.querySelector<HTMLInputElement>('input[name="testLevel"]:checked')?.value || ui.opts.testLevel;
}

function checkedTests(): string[] {
	return [...$("test-list").querySelectorAll<HTMLInputElement>(".test-class")].filter((c) => c.checked).map((c) => c.value);
}

function checkedDeleteTests(): string[] {
	return [...$("del-test-list").querySelectorAll<HTMLInputElement>(".test-class")].filter((c) => c.checked).map((c) => c.value);
}

function currentDeleteLevel(): string {
	return document.querySelector<HTMLInputElement>('input[name="delTestLevel"]:checked')?.value || ui.opts.delTestLevel;
}

/** Show only the chosen action's section (the others are hidden, not collapsed); Presets stay. */
function applyMode(): void {
	const mode = modeOf();
	$("secDeploy").hidden = mode !== "deploy";
	$("secRetrieve").hidden = mode !== "retrieve";
	$("secDelete").hidden = mode !== "delete";
	for (const b of document.querySelectorAll<HTMLButtonElement>("#modeSeg button")) {
		const on = b.dataset.mode === mode;
		b.classList.toggle("on", on);
		b.setAttribute("aria-pressed", String(on));
	}
	$("secDelete").setAttribute("open", "");
}

function renderRight(): void {
	applyMode();
	const blocked = blockedReason();
	const busy = opPending || busyOp !== null;
	const sel = selected.size;
	const dc = deployCandidates(syncRows, selected, choices, ui.opts.skipEqualDeploy);
	const rc = retrieveCandidates(syncRows, selected, choices, ui.opts.skipEqualRetrieve);
	const xc = deleteCandidates(syncRows, selected);

	const d = buttonState({ verb: ui.opts.validateOnly ? "Validate" : "Deploy", cands: dc, busy, blocked, selected: sel, hint: ui.opts.validateOnly ? "Validate the selection against the org" : "Deploy the selection to the org" });
	const r = buttonState({ verb: "Retrieve", cands: rc, busy, blocked, selected: sel, hint: "Retrieve the selection into the project" });
	const x = buttonState({ verb: "Delete from org", cands: xc, busy, blocked, selected: sel, hint: "Delete the selected components from the org" });
	const projKeys = retrieveProjectKeys(syncRows);
	const pb = $("retrieveProjectBtn") as HTMLButtonElement;
	pb.textContent = `Retrieve project (${projKeys.length.toLocaleString("en-US")})`;
	pb.disabled = busy || !!blocked || projKeys.length === 0;
	pb.title = blocked ? blocked : busy ? "An operation is running" : projKeys.length === 0 ? (local.known && orgComps.length === 0 ? "Waiting for the org listing" : "Nothing in the project to retrieve") : `All components of this project that exist in the org (${projKeys.length.toLocaleString("en-US")}), regardless of filters and Skip equal`;
	const mode = modeOf();
	const taking = mode === "retrieve" ? rc.keys.length : mode === "delete" ? xc.keys.length : dc.keys.length;
	const cands = mode === "retrieve" ? rc : mode === "delete" ? xc : dc;
	const hiddenN = hiddenSelected().length;
	const sumText = selectionSummary(mode === "delete" ? "delete" : mode, sel, taking, ui.filter.onlySelected, hiddenN);
	for (const row of document.querySelectorAll<HTMLElement>("[data-selrow]")) {
		row.hidden = sumText === "";
		const el = row.querySelector<HTMLButtonElement>("[data-selsum]")!;
		el.textContent = sumText;
		el.title = selectionSummaryTitle(cands.skipped, ui.filter.onlySelected);
		row.querySelector<HTMLElement>("[data-selhid]")!.hidden = hiddenN === 0;
	}
	$("selBanner").hidden = !ui.filter.onlySelected;
	$("selBannerText").textContent = selectionBannerText(mode === "delete" ? "delete" : mode, sel, taking, hiddenN);
	for (const [id, st] of [
		["deployBtn", d],
		["retrieveBtn", r],
		["deleteBtn", x],
	] as const) {
		const b = $(id) as HTMLButtonElement;
		b.textContent = st.label;
		b.disabled = st.disabled;
		b.title = st.title;
	}

	// Conflicts without a choice take part; say so where the buttons are, with the way to them (the run asks first).
	const note = overwriteText(modeOf() === "retrieve" ? rc : dc, modeOf() === "retrieve" ? "retrieve" : "deploy");
	for (const el of document.querySelectorAll<HTMLElement>(".conflict-note")) {
		el.hidden = note === "";
		if (note !== "") el.innerHTML = `${esc(note)} <button type="button" class="linkbtn" data-showconflicts="1">Show conflicts</button>`;
	}

	$("specified-tests-wrap").classList.toggle("visible", currentTestLevel() === "RunSpecifiedTests");
	const delLevel = currentDeleteLevel();
	$("del-specified-tests-wrap").classList.toggle("visible", delLevel === "RunSpecifiedTests");
	const delHint = deleteTestHint(delLevel, xc.keys.map((k) => syncRows[rowIndex.get(k) ?? -1]?.type ?? ""));
	$("delHint").hidden = delHint === "";
	$("delHint").textContent = delHint;
	$("statusLine").textContent = statusText;
	$("statusLine").title = statusText;
	renderPresetOptions();
}

function renderPresetOptions(): void {
	const sel = $("presetSel") as HTMLSelectElement;
	const cur = sel.value;
	sel.innerHTML = '<option value="">— None —</option>' + presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
	sel.value = cur && Number(cur) < presets.length ? cur : "";
	updatePresetModified();
}

/** The keys a preset selects in the current list (what `applyPreset` selects: components not in the list are skipped). */
function presetSelectedKeys(p: WebPreset): string[] {
	return p.components.map(rowKeyOf).filter((k) => rowIndex.has(k));
}

/** Shows the "modified" marker when a loaded preset no longer matches the selection. Never a pop-up. */
function updatePresetModified(): void {
	const mark = $("presetModified");
	const v = ($("presetSel") as HTMLSelectElement).value;
	const p = v !== "" ? presets[Number(v)] : undefined;
	const show = !!p && presetModified(presetSelectedKeys(p), [...selected].filter((k) => rowIndex.has(k)));
	mark.hidden = !show;
	mark.title = p ? `Selection differs from preset ${p.name}. Save preset to update it.` : "";
}

function setStatus(text: string, hint = false): void {
	statusText = text;
	statusIsHint = hint && text !== "";
	$("statusLine").textContent = text;
	$("statusLine").title = text;
}

function renderAll(): void {
	bar.renderFacets();
	renderGridChrome();
	renderOverlay();
	renderListed();
	renderRight();
	invalidateRows();
}

// ── History ────────────────────────────────────────────────────────────────────

const KIND_GLYPH: Record<string, string> = { deploy: "↑", validate: "✓", retrieve: "↓", delete: "✕" };

function orgLabelOf(org: string): string {
	return orgs.find((o) => o.username === org)?.label.replace(/ \((project )?default\)$/, "") ?? org;
}

function renderHistory(): void {
	$("historyTab").setAttribute("aria-expanded", String(historyOpen));
	$("historyPane").hidden = !historyOpen;
	if (!historyOpen) return;
	for (const [id, seg] of [["segDeploys", "deploys"], ["segHistory", "history"]] as const) {
		$(id).classList.toggle("on", activitySeg === seg);
		$(id).setAttribute("aria-pressed", String(activitySeg === seg));
	}
	$("depView").hidden = activitySeg !== "deploys";
	$("histView").hidden = activitySeg !== "history";
	if (activitySeg === "deploys") {
		renderDeploys();
		return;
	}
	const views = historyViews(history, Date.now(), orgLabelOf);
	$("histCount").textContent = views.length ? `${views.length} entr${views.length === 1 ? "y" : "ies"}` : "";
	$("histList").innerHTML =
		views
			.map((v) => {
				const open = historyExpanded.has(v.id);
				const detail = open
					? `<div class="hist-detail">` +
						`<div class="muted">${esc(v.whenExact)}${v.testLevel ? ` · ${esc(v.testLevel)}` : ""} · ${esc(v.source)}</div>` +
							(v.label ? `<div><b>${esc(v.label)}</b></div>` : "") +
						`<ul>${v.components.slice(0, 200).map((c) => `<li>${esc(c)}</li>`).join("")}${v.components.length > 200 ? `<li>+${v.components.length - 200} more</li>` : ""}</ul>` +
						(v.errors.length > 0 ? `<ul class="err">${v.errors.map((e) => `<li>${e.component ? `<b>${esc(e.component)}</b>: ` : ""}${esc(e.message)}</li>`).join("")}</ul>` : "") +
						`<div class="hist-actions" data-id="${esc(v.id)}"><button type="button" data-h="select">Select these components</button><button type="button" data-h="rerun">Re-run</button>` +
						(v.deployId && v.kind !== "retrieve" ? '<button type="button" data-h="setup">Open in Setup</button>' : "") +
						`</div></div>`
					: "";
				return (
					`<div class="hist-item" data-id="${esc(v.id)}"><div class="hist-line" data-h="toggle" title="${esc(v.whenExact)}">` +
					`<span class="hist-kind" title="${esc(v.kindLabel)}">${KIND_GLYPH[v.kind] ?? ""}</span><span class="hist-org" title="${esc(v.label ?? "")}">${esc(v.kindLabel)} · ${esc(v.org)}${v.label ? ` · <b>${esc(v.label)}</b>` : ""}</span>` +
					`<span class="hist-meta">${esc(v.when)} · ${esc(v.countText)}</span><span class="${v.ok ? "hist-ok" : "hist-bad"}">${esc(v.statusText)}</span></div>${detail}</div>`
				);
			})
			.join("") || '<div class="muted pad" style="padding:10px">Nothing yet. Deploys, validations, retrieves and deletes of this project show up here.</div>';
}

function onHistoryClick(e: Event): void {
	const t = e.target as HTMLElement;
	const el = t.closest<HTMLElement>("[data-h]");
	if (!el) return;
	const id = el.closest<HTMLElement>("[data-id]")?.dataset.id ?? "";
	const entry = history.find((h) => h.id === id);
	switch (el.dataset.h) {
		case "toggle":
			if (historyExpanded.has(id)) historyExpanded.delete(id);
			else historyExpanded.add(id);
			renderHistory();
			break;
		case "select":
			if (entry) selectComponentsOf(entry.components);
			break;
		case "rerun":
			post({ command: "historyRerun", id, testClassNames: checkedTests() });
			break;
		case "setup":
			post({ command: "historyOpenSetup", id });
			break;
	}
}

/** "Select these components" of a history entry / deploy row: replaces the selection with those that are still rows. */
function selectComponentsOf(components: readonly string[]): void {
	ensureRows();
	const r = historyRowKeys({ components: [...components] }, syncRows);
	selected = new Set(r.keys);
	setStatus(`Selected ${r.keys.length} component${r.keys.length === 1 ? "" : "s"} of this entry${r.missing > 0 ? ` (${r.missing} not in the list any more)` : ""}.`);
	afterSelectionChange();
}

// ── Operation card ─────────────────────────────────────────────────────────────

function barHtml(label: string, c: { done: number; total: number; errors: number } | undefined, errWord: string): string {
	if (!c || (c.total <= 0 && c.errors <= 0)) return "";
	const txt = countsText({ ...c }, errWord);
	const [counts, errs] = txt.split(" · ");
	return (
		`<div><div class="op-bar-label"><span>${esc(label)}</span><span>${esc(counts)}${errs ? ` · <span class="bad">${esc(errs)}</span>` : ""}</span></div>` +
		`<div class="op-track" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${c.done}"><span class="op-fill" style="width:${progressPercent(c)}%"></span><span class="op-fill err" style="width:${errorPercent(c)}%"></span></div></div>`
	);
}

function renderOpCard(): void {
	const el = $("opCard");
	const op = curOp;
	el.hidden = !op;
	if (!op) {
		el.innerHTML = "";
		return;
	}
	const active = isActivePhase(op.phase);
	const acts = opActions(op);
	el.className = `opcard ${op.phase}`;
	el.innerHTML =
		`<div class="op-head"><span class="op-kind" aria-hidden="true">${OP_KIND_GLYPH[op.kind] ?? ""}</span><b class="op-title" title="${esc(opTitle(op))}">${esc(opTitle(op))}</b>` +
		`<span class="op-badge ${op.phase}">${op.phase === "running" ? '<span class="op-spin" aria-hidden="true"></span>' : ""}${esc(phaseLabel(op.phase))}</span>` +
		`<span class="op-time" id="opElapsed" title="Elapsed time">${esc(opElapsedText(op, Date.now()))}</span>` +
		(active ? "" : '<button type="button" class="op-x" data-op="dismiss" title="Dismiss" aria-label="Dismiss">×</button>') +
		`</div>` +
		barHtml("Components", op.components, "error") +
		barHtml("Tests", op.tests, "failure") +
		(op.message ? `<div class="op-msg">${esc(op.message)}</div>` : "") +
		opFailuresHtml(op) +
		(canCancelOp(op) || acts.details || acts.setup
			? `<div class="op-actions">${canCancelOp(op) ? '<button type="button" data-op="cancel">Cancel</button>' : ""}${acts.details ? '<button type="button" data-op="details">Details</button>' : ""}${acts.setup ? '<button type="button" data-op="setup">Open in Setup</button>' : ""}</div>`
			: "");
}

function opFailuresHtml(op: OpMessage): string {
	const { shown, more } = visibleFailures(op.failures, opFailuresExpanded);
	if (shown.length === 0) return "";
	const total = op.failures?.length ?? shown.length;
	return (
		`<ul class="op-fails">${shown.map((f) => `<li title="${esc(failureLine(f))}">${f.type || f.name ? `<b>${esc([f.type, f.name].filter(Boolean).join(" "))}</b> — ` : ""}${esc(f.message)}</li>`).join("")}</ul>` +
		(more > 0 ? `<button type="button" class="op-more" data-op="failures">Show all (${total})</button>` : opFailuresExpanded && total > 5 ? '<button type="button" class="op-more" data-op="failures">Show fewer</button>' : "")
	);
}

function onOpCardClick(e: Event): void {
	const el = (e.target as HTMLElement).closest<HTMLElement>("[data-op]");
	const op = curOp;
	if (!el || !op) return;
	switch (el.dataset.op) {
		case "dismiss":
			curOp = null;
			renderOpCard();
			break;
		case "failures":
			opFailuresExpanded = !opFailuresExpanded;
			renderOpCard();
			break;
		case "cancel":
			post({ command: "cancelOp", id: op.id });
			break;
		case "setup":
			if (op.deployId) post({ command: "openDeployInSetup", deployId: op.deployId });
			break;
		case "details":
			if (op.deployId) showDeployDetails(op.deployId);
			break;
	}
}

function onOpMessage(m: OpMessage): void {
	const prev = curOp?.id === m.id ? curOp : undefined;
	if (!prev) opFailuresExpanded = false;
	curOp = m;
	renderOpCard();
	// The host refreshes the deploy list in the background when an operation finishes (`deploys` follows).
	void opJustFinished(prev, m);
}

// ── Activity: recent deploys ───────────────────────────────────────────────────

function loadDeploys(): void {
	deploysLoading = true;
	// The host always lists everything (the cache holds that list); "Failed only" filters here.
	post({ command: "listDeploys", failedOnly: false });
	renderDeploys();
}

/** The Deploys segment is shown: nothing yet = fetch; something = the host refreshes it if it is older than a minute. */
function openedDeploys(): void {
	if (deploys === null && !deploysLoading) loadDeploys();
	else post({ command: "deploysTabOpened" });
}

/** Open the Activity tab on the Deploys segment, expand the deploy and fetch its details. */
function showDeployDetails(deployId: string): void {
	historyOpen = true;
	activitySeg = "deploys";
	deployExpanded.add(deployId);
	requestDeployDetails(deployId);
	if (deploys === null && !deploysLoading) loadDeploys();
	else renderHistory();
}

function requestDeployDetails(deployId: string): void {
	if (deployDetailsCache.has(deployId) || deployDetailsAsked.has(deployId)) return;
	deployDetailsAsked.add(deployId);
	post({ command: "deployDetails", id: deployId });
}

function detailsHtml(v: ReturnType<typeof deployRowView>): string {
	if (!v.hasDetails) return '<div class="muted">No deploy id in the org for this entry: no details to fetch.</div>';
	const c = deployDetailsCache.get(v.deployId ?? "");
	if (!c) return '<div class="muted">Loading details…</div>';
	const d = c.details;
	let h = c.error ? `<div class="hint warn">${esc(c.error)}</div>` : "";
	if (d.componentErrors.length > 0) {
		h +=
			`<div class="sub">Component errors (${d.componentErrors.length})</div><ul class="err">` +
			d.componentErrors
				.map((e) => {
					const w = componentErrorWhere(e);
					return `<li>${w.who ? `<b>${esc(w.who)}</b>` : ""}${w.loc ? ` <span class="muted">${esc(w.loc)}</span>` : ""}${w.who || w.loc ? ": " : ""}${esc(e.message)}</li>`;
				})
				.join("") +
			"</ul>";
	}
	if (d.testErrors.length > 0) {
		h +=
			`<div class="sub">Test failures (${d.testErrors.length})</div><ul class="err">` +
			d.testErrors.map((t) => `<li><b>${esc(testErrorName(t))}</b>: ${esc(t.message)}${t.stackTrace ? `<details><summary>Stack trace</summary><pre>${esc(t.stackTrace)}</pre></details>` : ""}</li>`).join("") +
			"</ul>";
	}
	if (d.codeCoverageWarnings && d.codeCoverageWarnings.length > 0) {
		h += `<div class="sub">Coverage warnings (${d.codeCoverageWarnings.length})</div><ul>${d.codeCoverageWarnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
	}
	if (!c.error && detailsAreEmpty(d)) h += '<div class="muted">No errors reported.</div>';
	return h;
}

function renderDeploys(): void {
	$("depFailed").classList.toggle("on", deployFailedOnly);
	$("depFailed").setAttribute("aria-pressed", String(deployFailedOnly));
	($("depRefresh") as HTMLButtonElement).disabled = deploysLoading;
	const notice = $("depNotice");
	notice.hidden = !deploysError;
	notice.textContent = deploysError;
	const list = $("depList");
	const shown = deploys ? (deployFailedOnly ? deploys.filter((d) => d.ok === false) : deploys) : null;
	$("histCount").textContent = shown ? `${shown.length} deploy${shown.length === 1 ? "" : "s"}` : "";
	// "updated 2 min ago" plus a small spinner while a refresh runs; cached data stays on screen meanwhile.
	$("depCount").innerHTML = `${deploysLoading ? '<span class="op-spin" aria-hidden="true"></span> ' : ""}${deploysAt ? `updated ${esc(relativeTime(deploysAt, Date.now()))}` : deploysLoading ? "Loading…" : ""}`;
	if (shown === null) {
		list.innerHTML = `<div class="muted" style="padding:10px">${deploysLoading ? "Loading recent deploys…" : "Not loaded yet."}</div>`;
		return;
	}
	const now = Date.now();
	list.innerHTML =
		shown
			.map((i) => {
				const v = deployRowView(i, now);
				const open = deployExpanded.has(i.id);
				const meta: { t: string; bad?: boolean }[] = [{ t: v.kindLabel }, { t: v.createdBy }, { t: v.duration }, { t: v.componentsText && `${v.componentsText} components`, bad: (i.components?.errors ?? 0) > 0 }, { t: v.testsText && `${v.testsText} tests`, bad: (i.tests?.errors ?? 0) > 0 }];
				const l2 = meta.filter((x) => x.t).map((x) => `<span${x.bad ? ' class="dep-bad"' : ""}>${esc(x.t)}</span>`).join("");
				const detail = open
					? `<div class="hist-detail dep-detail">` +
						`<div class="muted">${esc(v.whenExact)} · ${esc(v.statusText)}${i.deployId ? ` · ${esc(i.deployId)}` : ""}</div>` +
						detailsHtml(v) +
						`<div class="hist-actions" data-id="${esc(i.id)}">${v.canSelect ? '<button type="button" data-d="select">Select components</button>' : ""}${v.canSetup ? '<button type="button" data-d="setup">Open in Setup</button>' : ""}</div></div>`
					: "";
				return (
					`<div class="hist-item" data-id="${esc(i.id)}"><div class="dep-row" data-d="toggle" title="${esc(v.whenExact)}">` +
					`<div class="dep-l1"><span class="dep-ic ${v.state}" title="${esc(v.statusText)}">${v.icon}</span><span class="t" title="${esc(v.title)}">${esc(v.title)}</span>` +
					`<span class="muted">${esc(v.when)}</span><span class="dep-chip" title="Where this entry comes from">${esc(v.sourceLabel)}</span></div>` +
					`<div class="dep-l2">${l2}</div></div>${detail}</div>`
				);
			})
			.join("") ||
		`<div class="muted" style="padding:10px">${deployFailedOnly ? "No failed deploys." : "No deploys yet."} Deploys and validations of this org show up here.</div>`;
}

function onDeployListClick(e: Event): void {
	const el = (e.target as HTMLElement).closest<HTMLElement>("[data-d]");
	if (!el) return;
	const id = el.closest<HTMLElement>("[data-id]")?.dataset.id ?? "";
	const item = deploys?.find((d) => d.id === id);
	if (!item) return;
	switch (el.dataset.d) {
		case "toggle":
			if (deployExpanded.has(id)) deployExpanded.delete(id);
			else {
				deployExpanded.add(id);
				if (item.deployId) requestDeployDetails(item.deployId);
			}
			renderDeploys();
			break;
		case "select":
			if (item.componentKeys) selectComponentsOf(item.componentKeys);
			break;
		case "setup":
			if (item.deployId) post({ command: "openDeployInSetup", deployId: item.deployId });
			break;
	}
}

/** The org changed: what was listed for the other one is dropped. */
function resetActivity(): void {
	deploys = null;
	deploysError = "";
	deploysLoading = false;
	deploysAt = 0;
	deployExpanded.clear();
	deployDetailsCache.clear();
	deployDetailsAsked.clear();
	// The host sends the new org's cached list with its `reset`, then refreshes it in the background.
}

// ── Selection ──────────────────────────────────────────────────────────────────

function afterSelectionChange(): void {
	if (ui.filter.onlySelected) {
		if (selected.size === 0) ui.filter.onlySelected = false;
		recompute();
	} else {
		renderGridChrome();
		renderRight();
		invalidateRows();
	}
}

function toggleKey(key: string, on?: boolean): void {
	if (statusIsHint) setStatus("");
	const want = on ?? !selected.has(key);
	// A row that cannot take part in the chosen action cannot be ticked (it can always be unticked).
	if (want) {
		const i = rowIndex.get(key);
		if (i !== undefined && !takesPart(modeOf(), syncRows[i])) return;
	}
	if (want) selected.add(key);
	else selected.delete(key);
}

function selectRange(a: number, b: number, on: boolean): void {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	for (let p = lo; p <= hi; p++) {
		const it = items[p];
		if (typeof it === "number") toggleKey(keyAt(it), on);
	}
}

function toggleFiltered(): void {
	const mode = modeOf();
	const part = rows.filter((i) => takesPart(mode, syncRows[i]));
	const allSel = part.length > 0 && part.every((i) => selected.has(keyAt(i)));
	for (const i of part) toggleKey(keyAt(i), !allSel);
	afterSelectionChange();
}

function toggleGroup(g: Group): void {
	const mode = modeOf();
	const part = g.rows.filter((i) => takesPart(mode, syncRows[i]));
	const all = part.length > 0 && part.every((i) => selected.has(keyAt(i)));
	for (const i of part) toggleKey(keyAt(i), !all);
	afterSelectionChange();
}

function cycleChoice(key: string): void {
	const c = nextChoice(choices.get(key));
	if (c) choices.set(key, c);
	else choices.delete(key);
	// Choosing a side means the row takes part.
	if (choices.has(key)) selected.add(key);
	persistChoices();
	afterSelectionChange();
}

// ── Actions ────────────────────────────────────────────────────────────────────

function toast(text: string, kind: "info" | "warn" | "error" = "info"): void {
	const el = $("toast");
	el.textContent = text;
	el.className = "toast show " + kind;
	window.clearTimeout((toast as unknown as { t?: number }).t);
	(toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove("show"), 5000);
}

function visibleOf(keys: string[]): string[] {
	return splitByVisibility(keys, visibleKeys()).visible;
}

/** Deploy `keys` (row keys) with the Deploy section's options. `conflictKeys`: conflict rows without a choice among `keys`; the host asks first. `withVisible`: the hidden-selection check of the main button. */
function startDeploy(keys: string[], conflictKeys: string[], withVisible: boolean): void {
	if (opPending || busyOp) {
		toast("An operation is running.", "warn");
		return;
	}
	const level = currentTestLevel();
	const tests = level === "RunSpecifiedTests" ? checkedTests() : [];
	if (level === "RunSpecifiedTests" && tests.length === 0) {
		setStatus("Select at least one test class for Run Specified Tests.", true);
		return;
	}
	const locals = local.entries;
	const itemsOut: { key: string; local: string[] }[] = [];
	for (const k of keys) {
		const r = syncRows[rowIndex.get(k)!];
		const lk = rowDeployLocalKeys(r, locals, childTypes);
		if (lk.length > 0) itemsOut.push({ key: k, local: lk });
	}
	if (itemsOut.length === 0) {
		setStatus("None of the selected components has local files.", true);
		return;
	}
	opPending = true;
	setStatus("");
	renderRight();
	const label = ($("deployLabel") as HTMLInputElement).value.trim();
	post({
		command: "deploy",
		items: itemsOut,
		...(withVisible ? { visible: visibleOf(itemsOut.map((i) => i.key)) } : {}),
		testLevel: level,
		testClassNames: tests.length ? tests : undefined,
		dryRun: ui.opts.validateOnly,
		label: label || undefined,
		presetName: loadedPresetName(),
		conflicts: conflictKeys.length ? conflictKeys : undefined,
	});
}

/** The name of the preset chosen in the Presets section (it goes into the deployment history). */
function loadedPresetName(): string | undefined {
	const v = ($("presetSel") as HTMLSelectElement).value;
	return v !== "" ? presets[Number(v)]?.name : undefined;
}

/** Retrieve `keys` (row keys) with the Retrieve section's options (see `startDeploy` for the flags). */
function startRetrieve(keys: string[], conflictKeys: string[], withVisible: boolean): void {
	if (opPending || busyOp) {
		toast("An operation is running.", "warn");
		return;
	}
	const itemsOut = keys.map((k) => ({ key: k, refs: [rowRetrieveRef(syncRows[rowIndex.get(k)!], ui.opts.wholeObject, childTypes)] }));
	opPending = true;
	results = new Map();
	renderRight();
	post({ command: "retrieve", items: itemsOut, ...(withVisible ? { visible: visibleOf(keys) } : {}), confirm: ui.opts.confirmOverwrite, conflicts: conflictKeys.length ? conflictKeys : undefined });
}

function doDeploy(): void {
	const c = deployCandidates(syncRows, selected, choices, ui.opts.skipEqualDeploy);
	if (c.keys.length === 0) return;
	startDeploy(c.keys, c.overwriteKeys, true);
}

function doRetrieve(): void {
	const c = retrieveCandidates(syncRows, selected, choices, ui.opts.skipEqualRetrieve);
	if (c.keys.length === 0) return;
	startRetrieve(c.keys, c.overwriteKeys, true);
}

function doRetrieveProject(): void {
	if (opPending || busyOp) return;
	const keys = retrieveProjectKeys(syncRows);
	if (keys.length === 0) return;
	const changed = keys.filter((k) => {
		const s = syncRows[rowIndex.get(k)!].status;
		return s === "changed-locally" || s === "conflict";
	});
	const itemsOut = keys.map((k) => ({ key: k, refs: [rowRetrieveRef(syncRows[rowIndex.get(k)!], ui.opts.wholeObject, childTypes)] }));
	opPending = true;
	results = new Map();
	renderRight();
	post({ command: "retrieve", items: itemsOut, confirm: ui.opts.confirmOverwrite, project: { changed } });
}

function doDelete(): void {
	if (opPending || busyOp) return;
	const c = deleteCandidates(syncRows, selected);
	if (c.keys.length === 0) return;
	const level = currentDeleteLevel();
	const tests = level === "RunSpecifiedTests" ? checkedDeleteTests() : [];
	if (level === "RunSpecifiedTests" && tests.length === 0) {
		setStatus("Select at least one test class for Run Specified Tests (Delete section).", true);
		return;
	}
	const refs = c.keys.map((k) => {
		const r = syncRows[rowIndex.get(k)!];
		return { type: r.type, fullName: r.name };
	});
	opPending = true;
	renderRight();
	post({ command: "delete", items: refs, testLevel: level, testClassNames: tests.length ? tests : undefined });
}

function rowAction(act: string, i: number): void {
	const r = syncRows[i];
	switch (act) {
		case "diff":
			post({ command: "diff", key: r.key, status: r.status });
			break;
		case "deployRow":
			startDeploy([r.key], r.status === "conflict" || r.status === "changed-in-org" ? [r.key] : [], false);
			break;
		case "retrieveRow":
			startRetrieve([r.key], r.status === "conflict" || r.status === "changed-locally" ? [r.key] : [], false);
			break;
		case "retrieveSel":
			doRetrieve();
			break;
		case "open":
			post({ command: "openFile", key: r.key });
			break;
		case "reveal":
			post({ command: "reveal", key: r.key });
			break;
		case "setup":
			post({ command: "setup", t: r.type, n: r.name });
			break;
		case "copy":
			post({ command: "copy", text: r.key });
			toast(`Copied ${r.key}`);
			break;
		case "copyName":
			post({ command: "copy", text: r.name });
			toast(`Copied ${r.name}`);
			break;
	}
}

// ── Context menu ───────────────────────────────────────────────────────────────

let menuRow = -1;

function showMenu(i: number, x: number, y: number): void {
	menuRow = i;
	const r = syncRows[i];
	const multi = selected.has(r.key) && selected.size > 1;
	const entries: [string, string, boolean][] = [
		[multi ? "retrieveSel" : "retrieveRow", multi ? `Retrieve selected (${selected.size})` : "Retrieve", r.inOrg && hasProject],
		["diff", "Compare with the org", isDiffable(r)],
		["open", "Open local file", r.local],
		["reveal", "Reveal in Explorer", r.local],
		["setup", "Open in Setup", r.inOrg],
		["copy", "Copy Type:Name", true],
		["copyName", "Copy name", true],
	];
	const m = $("menu");
	m.innerHTML = entries
		.filter(([, , show]) => show)
		.map(([a, l]) => `<button role="menuitem" data-mact="${a}">${esc(l)}</button>`)
		.join("");
	m.hidden = false;
	const rect = m.getBoundingClientRect();
	m.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
	m.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
	(m.querySelector("button") as HTMLElement | null)?.focus();
}

// ── Column menu ────────────────────────────────────────────────────────────────

let colSaveTimer: number | undefined;
/** Post the layout to the host (stored per computer), debounced. */
function saveColumns(): void {
	if (colSaveTimer) window.clearTimeout(colSaveTimer);
	colSaveTimer = window.setTimeout(() => post({ command: "columns", layout }), 300);
}

/** The layout changed (visibility, order, reset): redraw headers and rows, store. */
function layoutChanged(): void {
	renderHeader();
	applyWidths();
	invalidateRows();
	saveColumns();
}

function renderColMenu(): void {
	$("colMenu").innerHTML =
		layout.cols
			.map((c) => {
				const fixed = isFixedColumn(c.id);
				return `<label class="${fixed ? "fixed" : ""}"${fixed ? ' title="Always shown"' : ""}><input type="checkbox" data-col="${c.id}" ${c.visible ? "checked" : ""} ${fixed ? "disabled" : ""}> ${esc(columnLabel(c.id))}</label>`;
			})
			.join("") + '<hr><button role="menuitem" data-colreset="1">Reset columns</button>';
}

function showColMenu(x: number, y: number): void {
	hideMenu();
	renderColMenu();
	const m = $("colMenu");
	m.hidden = false;
	const rect = m.getBoundingClientRect();
	m.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + "px";
	m.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + "px";
}

function hideColMenu(): void {
	$("colMenu").hidden = true;
}

function hideMenu(): void {
	$("menu").hidden = true;
	menuRow = -1;
}

// ── Events ─────────────────────────────────────────────────────────────────────

function sideVisible(): boolean {
	return getComputedStyle($("side")).display !== "none";
}

function applyFiltersOpen(): void {
	const left = $("left");
	left.dataset.side = ui.filtersCollapsed === undefined ? "auto" : ui.filtersCollapsed ? "closed" : "open";
	left.toggleAttribute("data-narrow", left.clientWidth < SIDE_MIN_W);
	const b = $("filtersToggle");
	const vis = sideVisible();
	b.setAttribute("aria-expanded", String(vis));
	b.classList.toggle("on", vis);
}

function setupEvents(): void {
	const search = $("search") as HTMLInputElement;
	bar = createFilterBar({
		filter: () => ui.filter,
		facets: () => facets,
		rowCount: () => idx.comps.length,
		statusOptions: syncStatusOptions(),
		me: () => me,
		onChange: () => {
			recompute(true);
			saveUi();
		},
		onRefreshType: (t) => post({ command: "refreshTypes", types: [t] }),
		onSearchArrowDown: () => {
			$("scroller").focus();
			if (active < 0 && items.length) setActive(0);
		},
		// Pasting a list of `Type:Name` lines selects those components (and shows only them).
		onSearchPaste: (e) => {
			const text = e.clipboardData?.getData("text") ?? "";
			if (!/\r?\n/.test(text.trim())) return;
			const known = new Set(types.map((t) => t.name));
			for (const c of idx.comps) known.add(c.t);
			const pairs = parsePastedPairs(text, known);
			if (!pairs) return;
			e.preventDefault();
			const { indices, missing } = matchPairs(idx, pairs);
			for (const i of indices) selected.add(keyAt(i));
			// The status filter would hide pasted rows that are not in its group: clear it.
			ui.filter = { ...ui.filter, query: "", status: [], onlySelected: selected.size > 0 };
			search.value = "";
			recompute(true);
			saveUi();
			toast(
				`Selected ${indices.length} of ${pairs.length} pasted component${pairs.length === 1 ? "" : "s"}` + (missing.length ? ` (${missing.length} not found)` : ""),
				missing.length ? "warn" : "info"
			);
		},
		preserveOnClear: () => centerFilterKeptOnClear(ui.filter.onlySelected && selected.size > 0),
	});

	const onOrgChange = (e: Event) => {
		const v = (e.target as HTMLSelectElement).value;
		currentOrg = v;
		resetData();
		resetActivity();
		loadChoices();
		renderOrgSelect();
		post({ command: "selectOrg", org: v });
	};
	$("org").addEventListener("change", onOrgChange);
	$("refreshBtn").addEventListener("click", () => post({ command: "refresh" }));
	// Compare contents: only on demand. The selected components, else the project components the filter shows.
	$("cmpBtn").addEventListener("click", () => {
		const { keys, force } = compareKeys();
		if (keys.length === 0) return;
		post({ command: "compareContents", force, keys });
		toast(`Comparing the contents of ${keys.length.toLocaleString()} component${keys.length === 1 ? "" : "s"}…`);
	});
	$("cmpCancel").addEventListener("click", () => post({ command: "cancelCompare" }));
	$("filtersToggle").addEventListener("click", () => {
		ui.filtersCollapsed = sideVisible();
		applyFiltersOpen();
		invalidateRows();
		saveUi();
	});
	document.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		if (t.closest("[data-hiddenshow]")) {
			ui.filter = { ...DEFAULT_FILTER, onlySelected: true };
			bar.syncSearchInput();
			recompute(true);
			saveUi();
		} else if (t.closest("[data-hiddenclear]")) {
			for (const k of hiddenSelected()) selected.delete(k);
			afterSelectionChange();
		}
	});
	($("headCb") as HTMLInputElement).addEventListener("click", toggleFiltered);
	$("groupToggle").addEventListener("click", () => {
		ui.group = !ui.group;
		applyWidths();
		active = -1;
		recompute(true);
		saveUi();
	});
	$("collapseAll").addEventListener("click", () => {
		if (!ui.group) return;
		const all = new Set(rows.map((i) => idx.comps[i].t));
		ui.collapsed = ui.collapsed.length >= all.size ? [] : [...all];
		recompute();
		saveUi();
	});

	// Column headers (delegated): sort, resize, reorder by drag and drop, column menu.
	const ghead = $("ghead");
	let dragCol: ColumnId | null = null;
	const clearDrop = () => {
		for (const el of ghead.querySelectorAll(".drop-before, .drop-after, .dragging")) el.classList.remove("drop-before", "drop-after", "dragging");
	};
	ghead.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		if (t.classList.contains("grip")) return;
		const th = t.closest<HTMLElement>(".hcell[data-sort]");
		if (!th) return;
		const k = th.dataset.sort as SortKey;
		ui.sort = ui.sort.key === k ? { key: k, dir: (ui.sort.dir * -1) as 1 | -1 } : { key: k, dir: k === "modified" ? -1 : 1 };
		renderHeader();
		recompute();
		saveUi();
	});
	ghead.addEventListener("mousedown", (e) => {
		const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
		if (!grip) return;
		e.preventDefault();
		e.stopPropagation();
		const id = grip.dataset.col as ColumnId;
		const startX = e.clientX;
		// The rendered width (the flexing Name column is wider than its stored minimum when there is room).
		const startW = grip.parentElement?.getBoundingClientRect().width ?? layout.cols.find((c) => c.id === id)?.width ?? 100;
		grip.classList.add("drag");
		document.body.style.cursor = "col-resize";
		const move = (ev: MouseEvent) => {
			layout = setColumnWidth(layout, id, startW + ev.clientX - startX);
			applyWidths();
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			grip.classList.remove("drag");
			document.body.style.cursor = "";
			invalidateRows();
			saveColumns();
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	});
	ghead.addEventListener("dblclick", (e) => {
		const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
		if (!grip) return;
		const id = grip.dataset.col as ColumnId;
		layout = setColumnWidth(layout, id, defaultLayout().cols.find((c) => c.id === id)?.width ?? 100);
		applyWidths();
		saveColumns();
	});
	ghead.addEventListener("dragstart", (e) => {
		const th = (e.target as HTMLElement).closest<HTMLElement>(".hcell[data-col]");
		if (!th || !e.dataTransfer) return;
		dragCol = th.dataset.col as ColumnId;
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", dragCol);
		th.classList.add("dragging");
	});
	ghead.addEventListener("dragover", (e) => {
		const th = (e.target as HTMLElement).closest<HTMLElement>(".hcell[data-col]");
		if (!dragCol || !th || th.dataset.col === dragCol) return;
		e.preventDefault();
		const r = th.getBoundingClientRect();
		const after = e.clientX > r.left + r.width / 2 || isFixedColumn(th.dataset.col as ColumnId);
		for (const el of ghead.querySelectorAll(".drop-before, .drop-after")) el.classList.remove("drop-before", "drop-after");
		th.classList.add(after ? "drop-after" : "drop-before");
	});
	ghead.addEventListener("drop", (e) => {
		const th = (e.target as HTMLElement).closest<HTMLElement>(".hcell[data-col]");
		const id = dragCol;
		dragCol = null;
		if (!th || !id || th.dataset.col === id) {
			clearDrop();
			return;
		}
		e.preventDefault();
		const r = th.getBoundingClientRect();
		layout = moveColumn(layout, id, th.dataset.col as ColumnId, e.clientX > r.left + r.width / 2);
		clearDrop();
		layoutChanged();
	});
	ghead.addEventListener("dragend", () => {
		dragCol = null;
		clearDrop();
	});
	ghead.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		showColMenu(e.clientX, e.clientY);
	});
	$("colsBtn").addEventListener("click", (e) => {
		e.stopPropagation();
		if (!$("colMenu").hidden) {
			hideColMenu();
			return;
		}
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		showColMenu(r.left, r.bottom + 2);
	});
	$("colMenu").addEventListener("change", (e) => {
		const cb = e.target as HTMLInputElement;
		const id = cb.dataset.col as ColumnId | undefined;
		if (!id) return;
		layout = setColumnVisible(layout, id, cb.checked);
		layoutChanged();
	});
	$("colMenu").addEventListener("click", (e) => {
		if (!(e.target as HTMLElement).closest("[data-colreset]")) return;
		layout = defaultLayout();
		layoutChanged();
		renderColMenu();
	});
	setupSplitters();

	// Grid (delegated)
	const rowsEl = $("rowsEl");
	rowsEl.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		const rowEl = t.closest<HTMLElement>(".row");
		if (!rowEl) return;
		const pos = Number(rowEl.dataset.pos);
		const it = items[pos];
		if (it === undefined) return;
		if (typeof it !== "number") {
			if (t.closest(".gref")) {
				post({ command: "refreshTypes", types: [it.type] });
				return;
			}
			if (t.classList.contains("grpcb")) {
				toggleGroup(it);
				return;
			}
			setActive(pos, false);
			ui.collapsed = toggleIn(ui.collapsed, it.type);
			recompute();
			saveUi();
			return;
		}
		const ch = t.closest<HTMLElement>("[data-choice]");
		if (ch) {
			cycleChoice(keyAt(it));
			return;
		}
		const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
		if (act) {
			rowAction(act, it);
			return;
		}
		const e2 = e as MouseEvent;
		if (t.classList.contains("rowcb") || e2.shiftKey || e2.ctrlKey || e2.metaKey) {
			const on = t.classList.contains("rowcb") ? (t as HTMLInputElement).checked : !selected.has(keyAt(it));
			if (e2.shiftKey && anchor >= 0) selectRange(anchor, pos, on);
			else toggleKey(keyAt(it), on);
			anchor = pos;
			active = pos;
			afterSelectionChange();
			return;
		}
		setActive(pos, false);
		anchor = pos;
	});
	rowsEl.addEventListener("dblclick", (e) => {
		const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".row");
		if (!rowEl) return;
		const it = items[Number(rowEl.dataset.pos)];
		if (typeof it === "number" && syncRows[it].local) rowAction("open", it);
	});
	rowsEl.addEventListener("contextmenu", (e) => {
		const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".row");
		if (!rowEl) return;
		const it = items[Number(rowEl.dataset.pos)];
		if (typeof it !== "number") return;
		e.preventDefault();
		setActive(Number(rowEl.dataset.pos), false);
		showMenu(it, e.clientX, e.clientY);
	});
	$("menu").addEventListener("click", (e) => {
		const a = (e.target as HTMLElement).closest<HTMLElement>("[data-mact]")?.dataset.mact;
		const row = menuRow;
		hideMenu();
		if (a && row >= 0) rowAction(a, row);
	});
	$("menu").addEventListener("keydown", (e) => {
		const btns = [...$("menu").querySelectorAll<HTMLElement>("button")];
		const at = btns.indexOf(document.activeElement as HTMLElement);
		if (e.key === "ArrowDown") btns[(at + 1) % btns.length]?.focus();
		else if (e.key === "ArrowUp") btns[(at - 1 + btns.length) % btns.length]?.focus();
		else if (e.key === "Escape") {
			hideMenu();
			$("scroller").focus();
		} else return;
		e.preventDefault();
	});
	document.addEventListener("mousedown", (e) => {
		if (!$("menu").hidden && !(e.target as HTMLElement).closest("#menu")) hideMenu();
		if (!$("colMenu").hidden && !(e.target as HTMLElement).closest("#colMenu, #colsBtn")) hideColMenu();
	});

	$("overlay").addEventListener("click", overlayClick);
	$("banner").addEventListener("click", overlayClick);
	$("failBox").addEventListener("click", overlayClick);

	const sc = $("scroller");
	let raf = 0;
	sc.addEventListener("scroll", () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			renderRows();
		});
	});
	window.addEventListener("resize", () => {
		renderRows.force = true;
		renderRows();
	});
	sc.addEventListener("keydown", onGridKey);

	const leaveSelectionView = (clear: boolean) => {
		if (clear) selected.clear();
		ui.filter = { ...ui.filter, onlySelected: false };
		bar.syncSearchInput();
		recompute(true);
		saveUi();
	};
	$("selBannerBack").addEventListener("click", () => leaveSelectionView(false));
	$("selBannerX").addEventListener("click", () => leaveSelectionView(false));
	$("selBannerClear").addEventListener("click", () => leaveSelectionView(true));

	document.addEventListener("keydown", (e) => {
		const tag = (e.target as HTMLElement).tagName;
		const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
		if (e.key === "/" && !typing) {
			e.preventDefault();
			search.focus();
			search.select();
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && modeOf() === "retrieve") {
			// Ctrl/Cmd+Enter retrieves the selection (Retrieve action only; Deploy and Delete stay on their buttons).
			e.preventDefault();
			doRetrieve();
		} else if (e.key === "Escape" && !$("menu").hidden) {
			hideMenu();
		} else if (e.key === "Escape" && !$("colMenu").hidden) {
			hideColMenu();
		} else if (e.key === "Escape" && ui.filter.onlySelected && !typing && ((e.target as HTMLElement).closest("#scroller, #right") || e.target === document.body)) {
			leaveSelectionView(false);
		}
	});

	applyFiltersOpen();
	let lastNarrow = $("left").hasAttribute("data-narrow");
	new ResizeObserver(() => {
		const narrow = $("left").clientWidth < SIDE_MIN_W;
		if (narrow === lastNarrow) return;
		lastNarrow = narrow;
		applyFiltersOpen();
		invalidateRows();
	}).observe($("left"));

	setupRightPanel();
}

function setupRightPanel(): void {
	// "Show in grid" / "Show all": the "only selected" filter.
	document.addEventListener("click", (e) => {
		if (!(e.target as HTMLElement).closest("[data-selsum]")) return;
		ui.filter = { ...ui.filter, onlySelected: !ui.filter.onlySelected && selected.size > 0 };
		bar.syncSearchInput();
		recompute(true);
		saveUi();
	});

	// "Show conflicts": filter to the conflicts of the selection.
	$("right").addEventListener("click", (e) => {
		if (!(e.target as HTMLElement).closest("[data-showconflicts]")) return;
		ui.filter = { ...ui.filter, status: modeOf() === "retrieve" ? ["conflict", "changed-locally"] : ["conflict", "changed-in-org"], onlySelected: selected.size > 0 };
		bar.syncSearchInput();
		recompute(true);
		saveUi();
	});

	// Options
	const bind = (id: string, key: Exclude<keyof Options, "testLevel" | "delTestLevel">, after?: () => void) => {
		const el = $(id) as HTMLInputElement;
		el.addEventListener("change", () => {
			ui.opts[key] = el.checked;
			after?.();
			renderRight();
			saveUi();
		});
	};
	bind("skipEqualDeploy", "skipEqualDeploy");
	bind("skipEqualRetrieve", "skipEqualRetrieve");
	bind("confirmOverwrite", "confirmOverwrite");
	bind("wholeObject", "wholeObject");
	bind("validateOnly", "validateOnly");
	bind("autoGit", "autoGit", () => post({ command: "autoGit", on: ui.opts.autoGit }));
	for (const r of document.querySelectorAll<HTMLInputElement>('input[name="testLevel"]')) {
		r.addEventListener("change", () => {
			ui.opts.testLevel = r.value;
			renderRight();
			saveUi();
		});
	}
	($("test-search") as HTMLInputElement).addEventListener("input", () => filterTestList($("test-list"), ($("test-search") as HTMLInputElement).value));
	for (const r of document.querySelectorAll<HTMLInputElement>('input[name="delTestLevel"]')) {
		r.addEventListener("change", () => {
			ui.opts.delTestLevel = r.value;
			renderRight();
			saveUi();
		});
	}
	($("del-test-search") as HTMLInputElement).addEventListener("input", () => filterTestList($("del-test-list"), ($("del-test-search") as HTMLInputElement).value));
	$("gitSelect").addEventListener("click", () => {
		setStatus("Reading Git status…");
		post({ command: "gitSelect" });
	});

	$("modeSeg").addEventListener("click", (e) => {
		const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-mode]");
		if (!b) return;
		ui.mode = normalizeMode(b.dataset.mode);
		renderRight();
		renderGridChrome();
		invalidateRows();
		saveUi();
	});
	$("deployBtn").addEventListener("click", doDeploy);
	$("retrieveBtn").addEventListener("click", doRetrieve);
	$("retrieveProjectBtn").addEventListener("click", doRetrieveProject);
	$("deleteBtn").addEventListener("click", doDelete);

	// Presets
	($("presetSel") as HTMLSelectElement).addEventListener("change", (e) => {
		const p = presets[Number((e.target as HTMLSelectElement).value)];
		if (p) applyPreset(p);
		updatePresetModified();
	});
	$("presetSave").addEventListener("click", () => {
		ensureRows();
		const sel = ($("presetSel") as HTMLSelectElement).value;
		const current = sel !== "" ? presets[Number(sel)] : undefined;
		const level = currentTestLevel();
		pendingPresetKeys = { name: current?.name ?? "", keys: [...selected] };
		post({
			command: "savePreset",
			presetName: current?.name ?? "",
			components: [...selected].map((k) => syncRows[rowIndex.get(k) ?? -1]?.localKey ?? k),
			deployType: level,
			testClassNames: level === "RunSpecifiedTests" ? checkedTests() : [],
			targetOrg: currentOrg || undefined,
			validateOnly: ui.opts.validateOnly,
		});
	});

	// History
	$("historyTab").addEventListener("click", () => {
		historyOpen = !historyOpen;
		// Only renders what is there; the host refreshes in the background when it is older than a minute.
		renderHistory();
		if (historyOpen && activitySeg === "deploys") openedDeploys();
	});
	$("segDeploys").addEventListener("click", () => {
		activitySeg = "deploys";
		renderHistory();
		openedDeploys();
	});
	$("segHistory").addEventListener("click", () => {
		activitySeg = "history";
		renderHistory();
	});
	$("depRefresh").addEventListener("click", loadDeploys);
	$("depFailed").addEventListener("click", () => {
		deployFailedOnly = !deployFailedOnly;
		renderDeploys();
	});
	$("depList").addEventListener("click", onDeployListClick);
	$("opCard").addEventListener("click", onOpCardClick);
	$("histClose").addEventListener("click", () => {
		historyOpen = false;
		renderHistory();
	});
	$("histList").addEventListener("click", onHistoryClick);
}

function applyPreset(p: WebPreset): void {
	ensureRows();
	const keys = p.components.map(rowKeyOf);
	const found = keys.filter((k) => rowIndex.has(k));
	selected = new Set(found);
	const legacyValidate = p.deployType === ("ValidateOnly" as string);
	ui.opts.validateOnly = legacyValidate || !!p.validateOnly;
	($("validateOnly") as HTMLInputElement).checked = ui.opts.validateOnly;
	ui.opts.testLevel = legacyValidate ? "NoTestRun" : p.deployType;
	const radio = document.querySelector<HTMLInputElement>(`input[name="testLevel"][value="${ui.opts.testLevel}"]`);
	if (radio) radio.checked = true;
	const names = new Set(p.testClassNames);
	for (const cb of $("test-list").querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = names.has(cb.value);
	setStatus(`Preset “${p.name}”: ${found.length} of ${keys.length} component${keys.length === 1 ? "" : "s"} selected${keys.length > found.length ? ` (${keys.length - found.length} not in the list)` : ""}.`);
	afterSelectionChange();
	saveUi();
}

function overlayClick(e: Event): void {
	const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ov]");
	if (!b) return;
	switch (b.dataset.ov) {
		case "connectOrg":
			post({ command: "connectOrg" });
			break;
		case "reauth":
			post({ command: "reauth" });
			break;
		case "chooseOrg":
			post({ command: "chooseOrg" });
			break;
		case "retry":
			errorView = null;
			post({ command: "refresh" });
			break;
		case "retryType":
			post({ command: "refreshTypes", types: [b.dataset.type] });
			break;
	}
}

function setActive(pos: number, scroll = true): void {
	if (items.length === 0) return;
	active = Math.max(0, Math.min(items.length - 1, pos));
	if (scroll) {
		const sc = $("scroller");
		const top = active * ROW_H;
		if (top < sc.scrollTop) sc.scrollTop = top;
		else if (top + ROW_H > sc.scrollTop + sc.clientHeight - HEAD_H) sc.scrollTop = top + ROW_H - sc.clientHeight + HEAD_H;
	}
	invalidateRows();
}

function onGridKey(e: KeyboardEvent): void {
	if (e.ctrlKey || e.metaKey) return;
	const page = Math.max(1, Math.floor($("scroller").clientHeight / ROW_H) - 2);
	switch (e.key) {
		case "ArrowDown":
			setActive(active < 0 ? 0 : active + 1);
			break;
		case "ArrowUp":
			setActive(active < 0 ? 0 : active - 1);
			break;
		case "PageDown":
			setActive(active + page);
			break;
		case "PageUp":
			setActive(active - page);
			break;
		case "Home":
			setActive(0);
			break;
		case "End":
			setActive(items.length - 1);
			break;
		case " ": {
			const it = items[active];
			if (it === undefined) return;
			if (typeof it === "number") {
				toggleKey(keyAt(it));
				anchor = active;
				afterSelectionChange();
			} else toggleGroup(it);
			break;
		}
		case "Enter": {
			const it = items[active];
			if (it === undefined) return;
			if (typeof it !== "number") {
				ui.collapsed = toggleIn(ui.collapsed, it.type);
				recompute();
				saveUi();
				break;
			}
			const rowEl = $("rowsEl").querySelector<HTMLElement>(`.row[data-pos="${active}"]`);
			const r = rowEl?.getBoundingClientRect();
			showMenu(it, (r?.left ?? 200) + 60, (r?.bottom ?? 200) - 4);
			break;
		}
		default:
			return;
	}
	e.preventDefault();
}

/** The body's width and whether the sidebar shows (what the pane widths must fit into). */
function paneRoom(): { total: number; sideShown: boolean } {
	return { total: document.querySelector<HTMLElement>(".body")?.clientWidth ?? window.innerWidth, sideShown: sideVisible() && !$("left").hasAttribute("data-narrow") };
}

/** Set the pane widths (CSS variables), fitted so the grid keeps its minimum. */
function applyPanes(): void {
	const { total, sideShown } = paneRoom();
	const f = fitPanes(panes, total, sideShown);
	document.documentElement.style.setProperty("--side-w", f.side + "px");
	document.documentElement.style.setProperty("--right-w", f.right + "px");
}

function savePanes(): void {
	if (panesSaveTimer) window.clearTimeout(panesSaveTimer);
	panesSaveTimer = window.setTimeout(() => post({ command: "panes", panes }), 300);
}

/** Draggable splitters: sidebar | grid and grid | right panel. Double-click resets the pane to its default width. */
function setupSplitters(): void {
	const wire = (id: string, key: keyof PaneWidths, sign: 1 | -1, def: number) => {
		const el = $(id);
		el.addEventListener("dblclick", () => {
			panes = { ...panes, [key]: def };
			applyPanes();
			savePanes();
		});
		el.addEventListener("mousedown", (e) => {
			e.preventDefault();
			const startX = e.clientX;
			const startW = $(key === "side" ? "side" : "right").getBoundingClientRect().width;
			el.classList.add("drag");
			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			const move = (ev: MouseEvent) => {
				// The right panel grows when dragged left, the sidebar when dragged right; the other pane keeps its width.
				const { total, sideShown } = paneRoom();
				const other = key === "side" ? panes.right : sideShown ? panes.side : 0;
				const max = total - GRID_MIN - SPLITTER_W * (sideShown ? 2 : 1) - other;
				const next = normalizePanes({ ...panes, [key]: startW + sign * (ev.clientX - startX) });
				panes = { ...next, [key]: Math.max(key === "side" ? SIDE_MIN : RIGHT_MIN, Math.min(next[key], max)) };
				applyPanes();
			};
			const up = () => {
				window.removeEventListener("mousemove", move);
				window.removeEventListener("mouseup", up);
				el.classList.remove("drag");
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				panes = normalizePanes(panes);
				savePanes();
			};
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
		});
	};
	wire("sideSplit", "side", 1, SIDE_DEFAULT);
	wire("panelSplit", "right", -1, RIGHT_DEFAULT);
	window.addEventListener("resize", applyPanes);
}

function applyWidths(): void {
	const g = gridTemplate(layout, ui.group ? GROUP_INDENT : 0);
	$("scroller").querySelector(".inner")?.classList.toggle("grouped", ui.group);
	document.documentElement.style.setProperty("--cols", g.cols);
	document.documentElement.style.setProperty("--minw", g.minWidth + "px");
	applyPanes();
}

/**
 * On a production (or unverifiable) org the Delete section starts on Run Local Tests instead of No Test Run, which
 * the host refuses there. Only a switch away from NoTestRun: it is never switched back automatically.
 */
function preselectProductionDelTest(): void {
	if (!orgIsProduction || ui.opts.delTestLevel !== "NoTestRun") return;
	ui.opts.delTestLevel = "RunLocalTests";
	const radio = document.querySelector<HTMLInputElement>('input[name="delTestLevel"][value="RunLocalTests"]');
	if (radio) radio.checked = true;
	saveUi();
}

/** Reflect the saved options in the right panel's controls. */
function applyOptionsToControls(): void {
	const o = ui.opts;
	($("skipEqualDeploy") as HTMLInputElement).checked = o.skipEqualDeploy;
	($("skipEqualRetrieve") as HTMLInputElement).checked = o.skipEqualRetrieve;
	($("confirmOverwrite") as HTMLInputElement).checked = o.confirmOverwrite;
	($("wholeObject") as HTMLInputElement).checked = o.wholeObject;
	($("validateOnly") as HTMLInputElement).checked = o.validateOnly;
	($("autoGit") as HTMLInputElement).checked = o.autoGit;
	const radio = document.querySelector<HTMLInputElement>(`input[name="testLevel"][value="${o.testLevel}"]`) ?? document.querySelector<HTMLInputElement>('input[name="testLevel"][value="RunRelevantTests"]');
	if (radio) radio.checked = true;
	const delRadio = document.querySelector<HTMLInputElement>(`input[name="delTestLevel"][value="${o.delTestLevel}"]`) ?? document.querySelector<HTMLInputElement>('input[name="delTestLevel"][value="RunLocalTests"]');
	if (delRadio) delRadio.checked = true;
}

function resetData(): void {
	orgComps = [];
	types = [];
	failures = [];
	listedAt = 0;
	pending = null;
	errorView = null;
	local = { entries: [], partial: [], retrieved: {}, known: false };
	localInfo = undefined;
	contentInfo = {};
	cmpProgress = null;
	me = { ids: [], name: "" };
	results = new Map();
	// `selected` stays: component keys are org-independent. Only per-org data (rows, results, conflict choices, deploy details) is dropped.
	if (selected.size === 0) ui.filter.onlySelected = false;
	active = -1;
	loading = null;
	opPending = false;
	markRowsDirty();
	recompute(true);
}

// ── Results ────────────────────────────────────────────────────────────────────

/** Deploy/validate/delete finished. The outcome and its failures are in the operation card; only the coverage panel is rendered here. */
function showDeployResult(id: string, m: Record<string, any>): void {
	opPending = false;
	const cov = $("coverage-panel");
	if (m.cancelled) {
		if (id === "deployResult") {
			cov.style.display = "none";
			cov.innerHTML = "";
		}
		renderRight();
		return;
	}
	const success = !!m.success;
	if (id === "deployResult") {
		const list: { name: string; pct: number }[] = success && Array.isArray(m.coverage) ? m.coverage : [];
		if (list.length === 0) {
			cov.style.display = "none";
			cov.innerHTML = "";
		} else {
			const avg = Math.round(list.reduce((acc, e) => acc + e.pct, 0) / list.length);
			const cls = (p: number) => (p < 75 ? "cov-red" : p < 85 ? "cov-amber" : "cov-green");
			cov.innerHTML =
				`<div class="coverage-toggle" id="cov-toggle">📊 Coverage — <span class="cov-avg ${cls(avg)}">${avg}%</span> avg <span class="cov-chev">▾</span></div><div class="coverage-list" id="cov-list">` +
				list.map((e) => `<div class="cov-row"><span class="cov-name">${esc(e.name)}</span><span class="cov-pct ${cls(e.pct)}">${e.pct}%</span></div>`).join("") +
				"</div>";
			$("cov-toggle").onclick = () => {
				const l = $("cov-list");
				l.style.display = l.style.display === "none" ? "" : "none";
			};
			cov.style.display = "block";
		}
	}
	renderRight();
}

// ── Host messages ──────────────────────────────────────────────────────────────

let batchTimer: number | undefined;
function scheduleStreamRender(): void {
	if (batchTimer) return;
	batchTimer = window.setTimeout(() => {
		batchTimer = undefined;
		markRowsDirty();
		recompute();
	}, 300);
}

let infoTimer: number | undefined;
/** Compare results arrive in bursts: rebuild the rows once the burst is over. */
function scheduleRowsRefresh(): void {
	markRowsDirty();
	if (infoTimer) return;
	infoTimer = window.setTimeout(() => {
		infoTimer = undefined;
		recompute();
	}, 150);
}

function selectKeys(keys: string[], replace: boolean): void {
	const norm = keys.map(rowKeyOf);
	if (replace) selected = new Set(norm);
	else for (const k of norm) selected.add(k);
	afterSelectionChange();
}

window.addEventListener("message", (ev) => {
	const m = ev.data as { type: string; [k: string]: any };
	switch (m.type) {
		case "init":
			orgs = m.orgs ?? [];
			currentOrg = m.org;
			orgIsProduction = !!m.production;
			hasProject = m.hasProject;
			syncSelectionToUi(); // the old project's selection is stored before it is replaced
			const prevDir = projectDir;
			projectDir = m.projectDir ?? "";
			childTypes = new Set<string>(m.childTypes ?? []);
			noOrg = orgs.length === 0;
			testClasses = m.testClasses ?? [];
			const memSelections = ui.selections ?? {};
			mergeUi((m.ui as UiState | null) ?? (api.getState() as UiState | null));
			ui.selections = { ...(ui.selections ?? {}), ...memSelections }; // what this session already stored wins over a stale saved state
			layout = normalizeLayout(m.columns);
			panes = m.panes ? normalizePanes(m.panes) : ui.rightWidth ? normalizePanes({ side: SIDE_DEFAULT, right: ui.rightWidth }) : defaultPanes();
			renderHeader();
			loadChoices();
			sharedSync.init(m.shared);
			// Opened to browse the org (Orgs view, org menu, Org Browser command): every status, optionally some types.
			if (m.browse) {
				ui.filter = browseFilter(ui.filter, Array.isArray(m.browse.types) ? m.browse.types.map(String) : []);
				saveUi();
			}
			bar.syncSearchInput();
			applyWidths();
			applyOptionsToControls();
			preselectProductionDelTest();
			applyFiltersOpen();
			mountTestTree($("test-list"), testClasses, () => renderRight());
			mountTestTree($("del-test-list"), testClasses, () => renderRight());
			renderOrgSelect();
			if (Array.isArray(m.selection) && m.selection.length > 0) selected = new Set<string>((m.selection as string[]).map(rowKeyOf));
			else if (projectDir !== prevDir || selected.size === 0) {
				// Another project (its own stored selection) or a fresh / reloaded panel; the same project keeps what is selected.
				selected = new Set(storedSelection(ui.selections, projectDir));
				if (projectDir !== prevDir) ui.filter.onlySelected = false;
			}
			recompute();
			// "Auto-select Git changes" was on when the panel closed: the host watches again (it selects with the first change times).
			if (ui.opts.autoGit) post({ command: "autoGit", on: true, restore: true });
			break;
		case "testClasses": {
			// The scan finished after the first render: fill both lists, keeping what was already ticked.
			testClasses = m.testClasses ?? [];
			const ticked = new Map<string, Set<string>>();
			for (const id of ["test-list", "del-test-list"]) ticked.set(id, new Set([...$(id).querySelectorAll<HTMLInputElement>(".test-class:checked")].map((c) => c.value)));
			mountTestTree($("test-list"), testClasses, () => renderRight());
			mountTestTree($("del-test-list"), testClasses, () => renderRight());
			for (const [id, on] of ticked) for (const cb of $(id).querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = on.has(cb.value);
			renderRight();
			break;
		}
		case "orgs":
			orgs = m.orgs ?? [];
			if (m.org !== undefined) currentOrg = m.org;
			orgIsProduction = !!m.production;
			preselectProductionDelTest();
			noOrg = orgs.length === 0;
			renderOrgSelect();
			renderOverlay();
			renderRight();
			break;
		case "reset": {
			currentOrg = m.org;
			orgIsProduction = false; // the new org's flag follows in its "orgs" message
			renderOrgSelect();
			resetData();
			resetActivity();
			loadChoices();
			break;
		}
		case "loadStart":
			loading = { mode: m.mode, only: m.only, done: 0, total: 0, label: "" };
			errorView = null;
			// Re-listing over existing rows: buffer the new rows and swap them in at the end (no flicker, old rows stay usable).
			pending = (m.mode === "refresh" || m.mode === "types") && orgComps.length > 0 ? [] : null;
			renderListed();
			renderOverlay();
			break;
		case "types":
			types = m.types;
			break;
		case "batch": {
			if (!loading) break;
			loading.done = m.done;
			loading.total = m.total;
			loading.label = m.label;
			const comps = m.comps as Comp[];
			if (comps.length) {
				if (pending) pending.push(...comps);
				else orgComps.push(...comps);
			}
			renderListed();
			if (!pending && comps.length) scheduleStreamRender();
			break;
		}
		case "loadEnd": {
			if (pending) {
				if (loading?.only) {
					const drop = new Set<string>(m.dropTypes ?? loading.only);
					orgComps = orgComps.filter((c) => !drop.has(c.t)).concat(pending);
				} else {
					orgComps = pending;
				}
				pending = null;
			}
			loading = null;
			failures = m.failures ?? [];
			if (m.listedAt) listedAt = m.listedAt;
			if (Array.isArray(m.types) && m.types.length > 0) types = m.types;
			results = new Map();
			loadedOnce = true;
			if (batchTimer) {
				window.clearTimeout(batchTimer);
				batchTimer = undefined;
			}
			markRowsDirty();
			recompute();
			break;
		}
		case "loadError":
			loading = null;
			pending = null;
			errorView = { state: m.state, message: m.message };
			markRowsDirty();
			recompute();
			break;
		case "local":
			local = { entries: m.entries ?? [], partial: m.partial ?? [], retrieved: m.retrieved ?? {}, known: true };
			hasProject = m.hasProject;
			markRowsDirty();
			recompute();
			break;
		case "compareLocal":
			localInfo = (m.local ?? {}) as LocalInfoMap;
			scheduleRowsRefresh();
			break;
		case "compareContent":
			contentInfo = m.full ? ((m.content ?? {}) as ContentInfoMap) : { ...contentInfo, ...((m.content ?? {}) as ContentInfoMap) };
			scheduleRowsRefresh();
			break;
		case "compareProgress":
			cmpProgress = (m.progress ?? null) as CompareProgress | null;
			renderListed();
			break;
		case "me":
			me = { ids: m.ids ?? [], name: m.name ?? "" };
			bar.renderFacets();
			if (ui.filter.mine) recompute();
			break;
		case "busy":
			// `{on, label?}`: the host is loading / scanning / listing (the progress bar). `{op}`: a deploy / retrieve / delete runs.
			if (typeof m.on === "boolean") {
				hostBusy = m.on ? { label: String(m.label ?? "") } : null;
				renderListed();
				renderOverlay();
				break;
			}
			busyOp = m.op ?? null;
			if (!busyOp) opPending = false;
			renderRight();
			break;
		case "deployStart":
			$("coverage-panel").style.display = "none";
			break;
		case "deployResult":
			showDeployResult("deployResult", m);
			break;
		case "deleteResult":
			// Only what the org really deleted leaves the selection; everything else stays selected.
			if (Array.isArray(m.deletedKeys) && m.deletedKeys.length > 0) {
				selected = deselectKeys(selected, m.deletedKeys.map(String));
				if (selected.size === 0) ui.filter.onlySelected = false;
				recompute();
			}
			showDeployResult("deleteResult", m);
			break;
		case "retrieveResult": {
			opPending = false;
			if (!m.cancelled) {
				results = new Map();
				for (const r of m.results as { key: string; ok: boolean; error?: string }[]) results.set(r.key, { ok: r.ok, error: r.error });
			}
			renderRight();
			invalidateRows();
			break;
		}
		case "status":
			setStatus(String(m.text ?? ""));
			break;
		case "toast":
			toast(m.text, m.kind);
			break;
		case "history":
			history = Array.isArray(m.entries) ? m.entries : [];
			renderHistory();
			break;
		case "op":
			onOpMessage(m as unknown as OpMessage);
			break;
		case "deploys":
			deploys = Array.isArray(m.items) ? (m.items as DeployListItem[]) : [];
			deploysError = typeof m.error === "string" ? m.error : "";
			deploysAt = typeof m.at === "number" ? m.at : Date.now();
			// The spinner follows `deploysRefreshing`; a cached list shows at once either way.
			deploysLoading = false;
			if (historyOpen) renderHistory();
			break;
		case "deploysRefreshing":
			deploysLoading = m.on === true;
			if (m.on === false && typeof m.error === "string") deploysError = m.error;
			if (historyOpen) renderHistory();
			break;
		case "deployDetails":
			deployDetailsAsked.delete(String(m.id));
			deployDetailsCache.set(String(m.id), { details: (m.details ?? { componentErrors: [], testErrors: [] }) as DeployDetails, ...(m.error ? { error: String(m.error) } : {}) });
			if (historyOpen && activitySeg === "deploys") renderHistory();
			break;
		case "testSuites":
			suites.setSuites(Array.isArray(m.suites) ? m.suites : []);
			delSuites.setSuites(Array.isArray(m.suites) ? m.suites : []);
			break;
		case "presets":
			presets = Array.isArray(m.presets) ? m.presets : [];
			renderPresetOptions();
			break;
		case "presetSaved": {
			// The saved preset now holds the selection, so the "modified" marker clears until the selection changes again.
			const saved = presets.find((p) => p.name === m.name);
			const pending = pendingPresetKeys;
			if (saved && pending && pending.name === m.name) saved.components = pending.keys;
			pendingPresetKeys = undefined;
			setStatus(`Preset “${m.name}” saved.`);
			renderPresetOptions();
			break;
		}
		case "applySelection":
			selectKeys(Array.isArray(m.keys) ? m.keys.map(String) : [], true);
			// Opened with a selection (right-click, history): adjust the filter so the selection is visible.
			if (m.reveal && hiddenSelected().length > 0) {
				ui.filter = { ...DEFAULT_FILTER, status: initialStatusFilter(undefined, false) };
				recompute(true);
				if (hiddenSelected().length > 0) {
					ui.filter = { ...DEFAULT_FILTER };
					recompute(true);
				}
				bar.syncSearchInput();
				saveUi();
			}
			break;
		case "applyBrowse":
			ui.filter = browseFilter(ui.filter, Array.isArray(m.types) ? m.types.map(String) : []);
			bar.syncSearchInput();
			recompute(true);
			saveUi();
			break;
		case "applyPreset":
			if (m.preset) applyPreset(m.preset as WebPreset);
			break;
		case "modifiedKeys": {
			if (m.error) {
				if (m.select) setStatus("Git: " + m.error);
				break;
			}
			ensureRows();
			let added = 0;
			let found = 0;
			for (const lk of m.keys as string[]) {
				const rk = localKeyToRow.get(lk);
				if (!rk) continue;
				found++;
				if (!selected.has(rk)) {
					selected.add(rk);
					added++;
				}
			}
			if (m.select) {
				setStatus(
					!m.total
						? "No changed files in Git."
						: found === 0
							? `Git: ${m.total} changed file(s). None belong to a component of this project.`
							: `Git: ${m.total} changed file(s) → ${found} component${found === 1 ? "" : "s"} (${added} newly selected).`
				);
				if (added > 0) afterSelectionChange();
			}
			break;
		}
		case "sharedFilter":
			sharedSync.receive({ query: String(m.query ?? ""), types: Array.isArray(m.types) ? m.types.map(String) : [] });
			break;
	}
});

// Keep "Listed 2 h ago", the relative modified times and the history times fresh.
window.setInterval(() => {
	renderListed();
	invalidateRows();
	if (historyOpen) renderHistory();
}, 60_000);
// The operation card's elapsed time ticks once a second while the op runs.
window.setInterval(() => {
	if (!curOp || !isActivePhase(curOp.phase)) return;
	const t = document.getElementById("opElapsed");
	if (t) t.textContent = opElapsedText(curOp, Date.now());
}, 1000);

setupEvents();
renderHeader();
applyWidths();
post({ command: "ready" });
