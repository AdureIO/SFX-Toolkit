/**
 * Deploy & Retrieve Center webview: the union of the local project and the org's metadata in a virtualized grid
 * with the filter sidebar, one selection, quick actions, per-row conflict choices, and the Deploy / Retrieve /
 * Delete sections plus the history. Bundled by esbuild to resources/webview/syncCenter.js; talks to
 * SyncCenterPanelProvider via postMessage.
 *
 * The rows come from `buildSyncRows` (src/utils/syncCenterPure.ts) over what the host feeds in: the org listing
 * (streamed in batches, like the Org Browser), the local index, the local change info and the compare results.
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
	relativeTime,
	sortIndices,
} from "../utils/orgBrowser/filter";
import { splitByVisibility } from "../utils/orgBrowser/selection";
import { Comp, ListFailure, TypeInfo } from "../utils/orgBrowser/types";
import { CompareProgress, ContentInfoMap, LocalInfoMap, progressText } from "../utils/compareStatusPure";
import {
	ConflictChoice,
	SYNC_CENTER_VOCAB,
	SYNC_STATUS_LABELS,
	SYNC_STATUS_NAMES,
	SyncRow,
	buildSyncRows,
	deleteCandidates,
	deployCandidates,
	isDiffable,
	quickActionCounts,
	quickActionKeys,
	QuickAction,
	retrieveCandidates,
} from "../utils/syncCenterPure";
import {
	buttonState,
	choicesFromJson,
	choicesStoreKey,
	choicesToJson,
	historyRowKeys,
	historyViews,
	pruneConflictChoices,
	rowDeployLocalKeys,
	rowKeyOf,
	rowRetrieveRef,
} from "../utils/syncCenterUiPure";
import { HistoryEntry } from "../utils/historyPure";
import { WebPreset } from "../utils/presetsWebPure";
import { $, REFRESH_ICON, createFilterBar, esc, toggleIn, FilterBar } from "./shared/filterBar";
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
}

interface UiState {
	filter: FilterState;
	sort: { key: SortKey; dir: 1 | -1 };
	group: boolean;
	collapsed: string[];
	widths: { type: number; ns: number; by: number; mod: number; status: number };
	filtersCollapsed?: boolean;
	rightWidth?: number;
	opts: Options;
	/** Conflict choices per project and org (`choicesStoreKey`). */
	choices: Record<string, Record<string, ConflictChoice>>;
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
}

// ── State ──────────────────────────────────────────────────────────────────────

const api = acquireVsCodeApi();
const post = (msg: unknown) => api.postMessage(msg);
// The shared project selector (panelProjectUi.ts) posts through this handle.
(window as unknown as { __asfxApi: unknown }).__asfxApi = api;

const ROW_H = 28;
const HEAD_H = 30;
const SIDE_MIN_W = 560;
const PROV_TIP = "Based on dates — contents not compared yet";

function defaultOpts(): Options {
	return { skipEqualDeploy: true, skipEqualRetrieve: true, confirmOverwrite: true, wholeObject: false, validateOnly: false, autoGit: false, testLevel: "RunRelevantTests" };
}

function defaultUi(): UiState {
	return {
		filter: { ...DEFAULT_FILTER },
		sort: { key: "name", dir: 1 },
		group: false,
		collapsed: [],
		widths: { type: 120, ns: 70, by: 120, mod: 90, status: 130 },
		opts: defaultOpts(),
		choices: {},
	};
}

let ui: UiState = defaultUi();
let orgs: OrgOpt[] = [];
let currentOrg: string | null = null;
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
let localInfo: LocalInfoMap | undefined;
let contentInfo: ContentInfoMap = {};
let cmpProgress: CompareProgress | null = null;
/** The union rows, parallel to `idx.comps`. */
let syncRows: SyncRow[] = [];
let rowIndex = new Map<string, number>();
let localKeyToRow = new Map<string, string>();
let idx: SearchIndex = buildIndex([]);
let statusArr: Uint8Array = new Uint8Array(0);
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
let presets: WebPreset[] = [];
const suites = mountTestSuites({ post, checked: checkedTests, onApplied: () => renderRight(), setStatus });
let testClasses: { label: string; description: string }[] = [];
let statusText = "";
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
		filter: { ...d.filter, ...(saved.filter ?? {}), onlySelected: false },
		widths: { ...d.widths, ...(saved.widths ?? {}) },
		sort: saved.sort ?? d.sort,
		opts: { ...d.opts, ...(saved.opts ?? {}) },
		choices: saved.choices && typeof saved.choices === "object" ? saved.choices : {},
	};
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
	rowIndex = new Map();
	localKeyToRow = new Map();
	for (let i = 0; i < syncRows.length; i++) {
		const r = syncRows[i];
		comps[i] = r.comp ?? { t: r.type, n: r.name, ns: "", ms: "", by: "", bi: "", lm: 0, cd: 0, id: "", f: "" };
		st[i] = r.code;
		rowIndex.set(r.key, i);
		if (r.localKey) localKeyToRow.set(r.localKey, r.key);
	}
	idx = buildIndex(comps);
	statusArr = st;
	// A conflict choice belongs to its row while it is a conflict; a vanished or resolved row drops it.
	if (settled() && choices.size > 0) {
		const kept = pruneConflictChoices(choices, syncRows);
		if (kept.size !== choices.size) {
			choices = kept;
			persistChoices();
		}
	}
	if (settled()) for (const k of [...selected]) if (!rowIndex.has(k)) selected.delete(k);
}

// ── Recompute ──────────────────────────────────────────────────────────────────

function ctx(): FilterContext {
	return { now: Date.now(), status: statusArr, vocab: SYNC_CENTER_VOCAB, selected, meIds: me.ids, meName: me.name };
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
	refresh: REFRESH_ICON,
};

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
	const need = selected.has(r.key) && !c;
	return (
		`<span class="choice${need ? " need" : ""}" title="${need ? "Choose which version wins before this row can be deployed or retrieved" : "Which version wins"}">` +
		`<button type="button" data-choice="local" class="${c === "local" ? "on" : ""}" aria-pressed="${c === "local"}">Keep local</button>` +
		`<button type="button" data-choice="org" class="${c === "org" ? "on" : ""}" aria-pressed="${c === "org"}">Take org</button></span>`
	);
}

function rowHtml(pos: number, i: number): string {
	const r = syncRows[i];
	const c = idx.comps[i];
	const sel = selected.has(r.key);
	const exact = c.lm ? new Date(c.lm).toLocaleString() : "";
	const failed = results.get(r.key);
	return (
		`<div class="row${sel ? " sel" : ""}${pos === active ? " active" : ""}${failed && !failed.ok ? " failed" : ""}" data-pos="${pos}" role="row" aria-selected="${sel}">` +
		`<span class="c cb"><input type="checkbox" class="rowcb" tabindex="-1" ${sel ? "checked" : ""} aria-label="Select ${esc(r.name)}"></span>` +
		`<span class="c nm" title="${esc(r.key)}">${hl(r.name)}</span>` +
		`<span class="c ty">${hl(r.type)}</span>` +
		`<span class="c ns">${esc(c.ns)}</span>` +
		`<span class="c by" title="${esc(c.by)}">${esc(c.by)}</span>` +
		`<span class="c md" title="${esc(exact)}">${esc(relativeTime(c.lm, Date.now()))}</span>` +
		`<span class="c st">${statusBadge(r)}</span>` +
		`<span class="c acts">` +
		(r.status === "conflict" ? choiceHtml(r) : "") +
		(isDiffable(r) ? `<button class="ibtn" data-act="diff" title="Compare with the org" aria-label="Compare with the org">${ICON.diff}</button>` : "") +
		`</span></div>`
	);
}

function groupHtml(pos: number, g: Group): string {
	let n = 0;
	for (const i of g.rows) if (selected.has(keyAt(i))) n++;
	const all = n === g.rows.length && n > 0;
	return (
		`<div class="row grp${pos === active ? " active" : ""}" data-pos="${pos}" data-type="${esc(g.type)}" role="row">` +
		`<span class="c cb"><input type="checkbox" class="grpcb" tabindex="-1" ${all ? "checked" : ""} data-partial="${n > 0 && !all}" aria-label="Select all ${esc(g.type)}"></span>` +
		`<span class="c gname"><span class="chev${g.collapsed ? "" : " open"}">${ICON.chevron}</span><b>${hl(g.type)}</b><span class="gcount">${g.rows.length.toLocaleString()}</span>` +
		`<button class="gref" data-act="refreshType" title="Re-list ${esc(g.type)} only">${ICON.refresh}</button></span></div>`
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

function renderGridChrome(): void {
	$("spacer").style.height = items.length * ROW_H + "px";
	const total = idx.comps.length;
	$("countInfo").textContent = total ? (rows.length === total ? `${total.toLocaleString()} components` : `${rows.length.toLocaleString()} of ${total.toLocaleString()} components`) : "";
	const allSel = rows.length > 0 && rows.every((i) => selected.has(keyAt(i)));
	const selAll = $("selAll");
	selAll.textContent = allSel ? `Deselect filtered (${rows.length.toLocaleString()})` : `Select all filtered (${rows.length.toLocaleString()})`;
	selAll.toggleAttribute("disabled", rows.length === 0);
	($("groupToggle") as HTMLInputElement).checked = ui.group;
	const hc = $("headCb") as HTMLInputElement;
	hc.checked = allSel;
	hc.indeterminate = !allSel && rows.some((i) => selected.has(keyAt(i)));
	for (const th of document.querySelectorAll<HTMLElement>(".hcell[data-sort]")) {
		const k = th.dataset.sort;
		th.classList.toggle("sorted", k === ui.sort.key);
		th.dataset.dir = k === ui.sort.key ? (ui.sort.dir === 1 ? "asc" : "desc") : "";
	}
	const hidden = hiddenSelected().length;
	$("selHidden").hidden = hidden === 0;
	$("selHiddenText").textContent = `${hidden.toLocaleString()} selected hidden by filter —`;
}

// ── Rendering: top bar, listing state ──────────────────────────────────────────

function renderListed(): void {
	const el = $("listedInfo");
	const prog = $("progress");
	if (loading) {
		el.textContent = loading.total ? `Loaded ${loading.done.toLocaleString()}/${loading.total.toLocaleString()} types…` : "Listing metadata…";
		prog.hidden = false;
		($("progressBar").style as CSSStyleDeclaration).width = loading.total ? Math.round((loading.done / loading.total) * 100) + "%" : "8%";
		$("refreshBtn").setAttribute("disabled", "");
	} else {
		prog.hidden = true;
		el.textContent = listedAt ? `Listed ${relativeTime(listedAt, Date.now())}` : "";
		el.title = listedAt ? new Date(listedAt).toLocaleString() : "";
		$("refreshBtn").toggleAttribute("disabled", noOrg);
	}
	renderCompareInfo();
}

function renderCompareInfo(): void {
	const el = $("cmpInfo");
	el.textContent = progressText(cmpProgress);
	const failed = cmpProgress?.failed ?? 0;
	el.title = failed > 0 ? `${failed} component${failed === 1 ? "" : "s"} could not be compared (they keep the date-based status)` : "";
	$("cmpBtn").toggleAttribute("disabled", noOrg || !hasProject);
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
	for (const id of ["org", "org2"]) {
		const sel = $(id) as HTMLSelectElement;
		sel.innerHTML = orgs.map((o) => `<option value="${esc(o.username)}"${o.username === currentOrg ? " selected" : ""}>${esc(o.label)}</option>`).join("");
		if (currentOrg && !orgs.some((o) => o.username === currentOrg)) sel.insertAdjacentHTML("afterbegin", `<option value="${esc(currentOrg)}" selected>${esc(currentOrg)}</option>`);
		sel.disabled = orgs.length === 0;
	}
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
	return [...document.querySelectorAll<HTMLInputElement>(".test-class")].filter((c) => c.checked).map((c) => c.value);
}

function renderRight(): void {
	const blocked = blockedReason();
	const busy = opPending || busyOp !== null;
	const sel = selected.size;
	const dc = deployCandidates(syncRows, selected, choices, ui.opts.skipEqualDeploy);
	const rc = retrieveCandidates(syncRows, selected, choices, ui.opts.skipEqualRetrieve);
	const xc = deleteCandidates(syncRows, selected);

	const d = buttonState({ verb: ui.opts.validateOnly ? "Validate" : "Deploy", cands: dc, busy, blocked, conflictsBlock: true, selected: sel, hint: ui.opts.validateOnly ? "Validate the selection against the org" : "Deploy the selection to the org" });
	const r = buttonState({ verb: "Retrieve", cands: rc, busy, blocked, conflictsBlock: true, selected: sel, hint: "Retrieve the selection into the project" });
	const x = buttonState({ verb: "Delete from org", cands: xc, busy, blocked, conflictsBlock: false, selected: sel, hint: "Delete the selected components from the org" });
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

	// Unresolved conflicts keep Deploy and Retrieve off: say so where the buttons are, with the way to them.
	const unresolved = dc.unresolvedConflicts;
	for (const el of document.querySelectorAll<HTMLElement>(".conflict-note")) {
		el.hidden = unresolved === 0;
		if (unresolved > 0) {
			el.innerHTML = `${esc(unresolved === 1 ? "1 conflict needs a choice (Keep local / Take org)." : `${unresolved} conflicts need a choice (Keep local / Take org).`)} <button type="button" class="linkbtn" data-showconflicts="1">Show conflicts</button>`;
		}
	}

	const vis = visibleKeys();
	const counts = quickActionCounts(syncRows, vis);
	for (const b of document.querySelectorAll<HTMLButtonElement>("#quick button[data-q]")) {
		const q = b.dataset.q as QuickAction | "clear";
		const cnt = b.querySelector("b")!;
		if (q === "clear") {
			cnt.textContent = sel > 0 ? `${sel.toLocaleString()} selected` : "";
			b.disabled = sel === 0;
		} else {
			cnt.textContent = counts[q].toLocaleString();
			b.disabled = counts[q] === 0;
		}
	}
	$("specified-tests-wrap").classList.toggle("visible", currentTestLevel() === "RunSpecifiedTests");
	$("statusLine").textContent = statusText;
	$("statusLine").title = statusText;
	renderPresetOptions();
}

function renderPresetOptions(): void {
	const sel = $("presetSel") as HTMLSelectElement;
	const cur = sel.value;
	sel.innerHTML = '<option value="">— None —</option>' + presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
	sel.value = cur && Number(cur) < presets.length ? cur : "";
}

function setStatus(text: string): void {
	statusText = text;
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
	$("historyTab").textContent = history.length > 0 ? `History (${history.length})` : "History";
	$("historyPane").hidden = !historyOpen;
	if (!historyOpen) return;
	const views = historyViews(history, Date.now(), orgLabelOf);
	$("histCount").textContent = views.length ? `${views.length} entr${views.length === 1 ? "y" : "ies"}` : "";
	$("histList").innerHTML =
		views
			.map((v) => {
				const open = historyExpanded.has(v.id);
				const detail = open
					? `<div class="hist-detail">` +
						`<div class="muted">${esc(v.whenExact)}${v.testLevel ? ` · ${esc(v.testLevel)}` : ""} · ${esc(v.source)}</div>` +
						`<ul>${v.components.slice(0, 200).map((c) => `<li>${esc(c)}</li>`).join("")}${v.components.length > 200 ? `<li>+${v.components.length - 200} more</li>` : ""}</ul>` +
						(v.errors.length > 0 ? `<ul class="err">${v.errors.map((e) => `<li>${e.component ? `<b>${esc(e.component)}</b>: ` : ""}${esc(e.message)}</li>`).join("")}</ul>` : "") +
						`<div class="hist-actions" data-id="${esc(v.id)}"><button type="button" data-h="select">Select these components</button><button type="button" data-h="rerun">Re-run</button>` +
						(v.deployId && v.kind !== "retrieve" ? '<button type="button" data-h="setup">Open in Setup</button>' : "") +
						`</div></div>`
					: "";
				return (
					`<div class="hist-item" data-id="${esc(v.id)}"><div class="hist-line" data-h="toggle" title="${esc(v.whenExact)}">` +
					`<span class="hist-kind" title="${esc(v.kindLabel)}">${KIND_GLYPH[v.kind] ?? ""}</span><span class="hist-org">${esc(v.kindLabel)} · ${esc(v.org)}</span>` +
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
		case "select": {
			if (!entry) break;
			ensureRows();
			const r = historyRowKeys(entry, syncRows);
			selected = new Set(r.keys);
			setStatus(`Selected ${r.keys.length} component${r.keys.length === 1 ? "" : "s"} of this entry${r.missing > 0 ? ` (${r.missing} not in the list any more)` : ""}.`);
			afterSelectionChange();
			break;
		}
		case "rerun":
			post({ command: "historyRerun", id, testClassNames: checkedTests() });
			break;
		case "setup":
			post({ command: "historyOpenSetup", id });
			break;
	}
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
	const want = on ?? !selected.has(key);
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
	const allSel = rows.length > 0 && rows.every((i) => selected.has(keyAt(i)));
	for (const i of rows) toggleKey(keyAt(i), !allSel);
	afterSelectionChange();
}

function toggleGroup(g: Group): void {
	const all = g.rows.every((i) => selected.has(keyAt(i)));
	for (const i of g.rows) toggleKey(keyAt(i), !all);
	afterSelectionChange();
}

function quickSelect(q: QuickAction | "clear"): void {
	if (q === "clear") {
		selected = new Set();
		ui.filter.onlySelected = false;
		recompute();
		saveUi();
		return;
	}
	// The shown (filtered) rows only; added to what is selected.
	const keys = quickActionKeys(syncRows, q, visibleKeys());
	for (const k of keys) selected.add(k);
	setStatus(keys.length === 0 ? "Nothing to select." : `Selected ${keys.length.toLocaleString()} component${keys.length === 1 ? "" : "s"}.`);
	afterSelectionChange();
}

function setChoice(key: string, c: ConflictChoice): void {
	if (choices.get(key) === c) choices.delete(key);
	else choices.set(key, c);
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

function resultBar(id: string, cls: string, text: string): void {
	const b = $(id);
	b.className = "result-bar " + cls;
	b.textContent = text;
	b.style.display = text ? "block" : "none";
}

function doDeploy(): void {
	if (opPending || busyOp) return;
	const c = deployCandidates(syncRows, selected, choices, ui.opts.skipEqualDeploy);
	if (c.keys.length === 0 || c.unresolvedConflicts > 0) return;
	const level = currentTestLevel();
	const tests = level === "RunSpecifiedTests" ? checkedTests() : [];
	if (level === "RunSpecifiedTests" && tests.length === 0) {
		setStatus("Select at least one test class for Run Specified Tests.");
		return;
	}
	const locals = local.entries;
	const itemsOut: { key: string; local: string[] }[] = [];
	for (const k of c.keys) {
		const r = syncRows[rowIndex.get(k)!];
		const lk = rowDeployLocalKeys(r, locals, childTypes);
		if (lk.length > 0) itemsOut.push({ key: k, local: lk });
	}
	if (itemsOut.length === 0) {
		setStatus("None of the selected components has local files.");
		return;
	}
	opPending = true;
	setStatus("");
	renderRight();
	post({ command: "deploy", items: itemsOut, visible: visibleOf(itemsOut.map((i) => i.key)), testLevel: level, testClassNames: tests.length ? tests : undefined, dryRun: ui.opts.validateOnly });
}

function doRetrieve(): void {
	if (opPending || busyOp) return;
	const c = retrieveCandidates(syncRows, selected, choices, ui.opts.skipEqualRetrieve);
	if (c.keys.length === 0 || c.unresolvedConflicts > 0) return;
	const itemsOut = c.keys.map((k) => ({ key: k, refs: [rowRetrieveRef(syncRows[rowIndex.get(k)!], ui.opts.wholeObject, childTypes)] }));
	opPending = true;
	results = new Map();
	resultBar("retrieveResult", "running", "Retrieving…");
	renderRight();
	post({ command: "retrieve", items: itemsOut, visible: visibleOf(c.keys), confirm: ui.opts.confirmOverwrite });
}

function doDelete(): void {
	if (opPending || busyOp) return;
	const c = deleteCandidates(syncRows, selected);
	if (c.keys.length === 0) return;
	const level = currentTestLevel();
	const tests = level === "RunSpecifiedTests" ? checkedTests() : [];
	if (level === "RunSpecifiedTests" && tests.length === 0) {
		setStatus("Select at least one test class for Run Specified Tests (Deploy section).");
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
	const entries: [string, string, boolean][] = [
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
		statusOptions: SYNC_STATUS_NAMES.map((n) => ({ value: n, label: SYNC_STATUS_LABELS[n] })),
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
		preserveOnClear: () => ({ onlySelected: ui.filter.onlySelected && selected.size > 0 }),
	});

	const onOrgChange = (e: Event) => {
		const v = (e.target as HTMLSelectElement).value;
		currentOrg = v;
		resetData();
		loadChoices();
		renderOrgSelect();
		post({ command: "selectOrg", org: v });
	};
	$("org").addEventListener("change", onOrgChange);
	$("org2").addEventListener("change", onOrgChange);
	$("refreshBtn").addEventListener("click", () => post({ command: "refresh" }));
	// Compare contents: what needs it; with a filter active, the shown components again (forced).
	$("cmpBtn").addEventListener("click", () => {
		const filtered = rows.length < idx.comps.length;
		post(filtered ? { command: "compareContents", force: true, keys: rows.map(keyAt) } : { command: "compareContents", force: false });
		toast(filtered ? `Comparing the contents of ${rows.length.toLocaleString()} shown component${rows.length === 1 ? "" : "s"}…` : "Comparing contents…");
	});
	$("filtersToggle").addEventListener("click", () => {
		ui.filtersCollapsed = sideVisible();
		applyFiltersOpen();
		invalidateRows();
		saveUi();
	});
	$("selHiddenShow").addEventListener("click", () => {
		ui.filter = { ...DEFAULT_FILTER, onlySelected: true };
		bar.syncSearchInput();
		recompute(true);
		saveUi();
	});
	$("selHiddenClear").addEventListener("click", () => {
		for (const k of hiddenSelected()) selected.delete(k);
		afterSelectionChange();
	});
	$("selAll").addEventListener("click", toggleFiltered);
	($("headCb") as HTMLInputElement).addEventListener("click", toggleFiltered);
	($("groupToggle") as HTMLInputElement).addEventListener("change", (e) => {
		ui.group = (e.target as HTMLInputElement).checked;
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

	// Sort + resize
	for (const th of document.querySelectorAll<HTMLElement>(".hcell[data-sort]")) {
		th.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).classList.contains("grip")) return;
			const k = th.dataset.sort as SortKey;
			ui.sort = ui.sort.key === k ? { key: k, dir: (ui.sort.dir * -1) as 1 | -1 } : { key: k, dir: k === "modified" ? -1 : 1 };
			recompute();
			saveUi();
		});
	}
	for (const grip of document.querySelectorAll<HTMLElement>(".grip")) {
		grip.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const col = grip.dataset.col as keyof UiState["widths"];
			const startX = e.clientX;
			const startW = ui.widths[col];
			const move = (ev: MouseEvent) => {
				ui.widths[col] = Math.max(60, Math.min(500, startW + ev.clientX - startX));
				applyWidths();
			};
			const up = () => {
				window.removeEventListener("mousemove", move);
				window.removeEventListener("mouseup", up);
				saveUi();
			};
			window.addEventListener("mousemove", move);
			window.addEventListener("mouseup", up);
		});
	}
	$("panelSplit").addEventListener("mousedown", (e) => {
		const right = $("right");
		const sx = e.clientX;
		const sw = right.getBoundingClientRect().width;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		e.preventDefault();
		const move = (ev: MouseEvent) => {
			const max = Math.max(300, window.innerWidth - 420);
			ui.rightWidth = Math.min(max, Math.max(300, sw + (sx - ev.clientX)));
			right.style.width = ui.rightWidth + "px";
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			saveUi();
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	});

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
			setChoice(keyAt(it), ch.dataset.choice as ConflictChoice);
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

	document.addEventListener("keydown", (e) => {
		const tag = (e.target as HTMLElement).tagName;
		const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
		if (e.key === "/" && !typing) {
			e.preventDefault();
			search.focus();
			search.select();
		} else if (e.key === "Escape" && !$("menu").hidden) {
			hideMenu();
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
	// Quick actions
	$("quick").addEventListener("click", (e) => {
		const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-q]");
		if (b && !b.disabled) quickSelect(b.dataset.q as QuickAction | "clear");
	});
	// "Show conflicts": filter to the conflicts of the selection.
	$("right").addEventListener("click", (e) => {
		if (!(e.target as HTMLElement).closest("[data-showconflicts]")) return;
		ui.filter = { ...ui.filter, status: ["conflict"], onlySelected: selected.size > 0 };
		bar.syncSearchInput();
		recompute(true);
		saveUi();
	});

	// Options
	const bind = (id: string, key: Exclude<keyof Options, "testLevel">, after?: () => void) => {
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
	$("gitSelect").addEventListener("click", () => {
		setStatus("Reading Git status…");
		post({ command: "gitSelect" });
	});

	$("deployBtn").addEventListener("click", doDeploy);
	$("retrieveBtn").addEventListener("click", doRetrieve);
	$("deleteBtn").addEventListener("click", doDelete);

	// Presets
	($("presetSel") as HTMLSelectElement).addEventListener("change", (e) => {
		const p = presets[Number((e.target as HTMLSelectElement).value)];
		if (p) applyPreset(p);
	});
	$("presetSave").addEventListener("click", () => {
		ensureRows();
		const sel = ($("presetSel") as HTMLSelectElement).value;
		const current = sel !== "" ? presets[Number(sel)] : undefined;
		const level = currentTestLevel();
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
		renderHistory();
	});
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
	for (const cb of document.querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = names.has(cb.value);
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

function applyWidths(): void {
	const w = ui.widths;
	const cols = `34px minmax(140px,1fr) ${w.type}px ${w.ns}px ${w.by}px ${w.mod}px ${w.status}px 176px`;
	document.documentElement.style.setProperty("--cols", cols);
	document.documentElement.style.setProperty("--minw", 34 + 140 + w.type + w.ns + w.by + w.mod + w.status + 176 + "px");
	if (ui.rightWidth) $("right").style.width = ui.rightWidth + "px";
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
	selected = new Set();
	ui.filter.onlySelected = false;
	active = -1;
	loading = null;
	opPending = false;
	for (const id of ["deployResult", "retrieveResult", "deleteResult"]) resultBar(id, "", "");
	markRowsDirty();
	recompute(true);
}

// ── Results ────────────────────────────────────────────────────────────────────

function showDeployResult(id: string, verbOk: string, verbFail: string, m: Record<string, any>): void {
	opPending = false;
	const cov = $("coverage-panel");
	if (m.cancelled) {
		resultBar(id, "", "");
		if (id === "deployResult") {
			cov.style.display = "none";
			cov.innerHTML = "";
		}
		renderRight();
		return;
	}
	const success = !!m.success;
	const parts = [(success ? "✅ " : "❌ ") + (success ? verbOk : verbFail)];
	if (m.components > 0) parts.push(m.components + " component" + (m.components !== 1 ? "s" : ""));
	if (m.componentErrors > 0) parts.push(m.componentErrors + " error" + (m.componentErrors !== 1 ? "s" : ""));
	if (m.testsPassed > 0 || m.testsFailed > 0) parts.push("Tests: " + m.testsPassed + " passed" + (m.testsFailed > 0 ? ", " + m.testsFailed + " failed" : ""));
	if (m.durationMs) {
		const s = Math.round(m.durationMs / 1000);
		parts.push(s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s");
	}
	if (m.error) parts.push(String(m.error));
	resultBar(id, success ? "success" : "failure", parts.join(" · "));
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
			hasProject = m.hasProject;
			projectDir = m.projectDir ?? "";
			childTypes = new Set<string>(m.childTypes ?? []);
			noOrg = orgs.length === 0;
			testClasses = m.testClasses ?? [];
			mergeUi((m.ui as UiState | null) ?? (api.getState() as UiState | null));
			loadChoices();
			sharedSync.init(m.shared);
			bar.syncSearchInput();
			applyWidths();
			applyOptionsToControls();
			applyFiltersOpen();
			mountTestTree($("test-list"), testClasses, () => renderRight());
			renderOrgSelect();
			if (Array.isArray(m.selection) && m.selection.length > 0) selected = new Set<string>((m.selection as string[]).map(rowKeyOf));
			recompute();
			break;
		case "orgs":
			orgs = m.orgs ?? [];
			if (m.org !== undefined) currentOrg = m.org;
			noOrg = orgs.length === 0;
			renderOrgSelect();
			renderOverlay();
			renderRight();
			break;
		case "reset": {
			const keep = selected;
			currentOrg = m.org;
			renderOrgSelect();
			resetData();
			loadChoices();
			// A selection carried in by "open in the Center" survives the first org load.
			if (keep.size > 0 && !loadedOnce) selected = keep;
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
			renderCompareInfo();
			break;
		case "me":
			me = { ids: m.ids ?? [], name: m.name ?? "" };
			bar.renderFacets();
			if (ui.filter.mine) recompute();
			break;
		case "busy":
			busyOp = m.op ?? null;
			if (!busyOp) opPending = false;
			renderRight();
			break;
		case "deployStart":
			resultBar("deployResult", "running", m.dryRun ? "Validating…" : "Deploying…");
			$("coverage-panel").style.display = "none";
			break;
		case "deployResult":
			showDeployResult("deployResult", m.dryRun ? "Validation passed" : "Deploy succeeded", m.dryRun ? "Validation failed" : "Deploy failed", m);
			break;
		case "deleteStart":
			resultBar("deleteResult", "running", "Deleting…");
			break;
		case "deleteResult":
			showDeployResult("deleteResult", "Deleted from the org", "Delete failed", m);
			break;
		case "retrieveResult": {
			opPending = false;
			if (m.cancelled) resultBar("retrieveResult", "", "");
			else {
				results = new Map();
				let ok = 0;
				let bad = 0;
				for (const r of m.results as { key: string; ok: boolean; error?: string }[]) {
					results.set(r.key, { ok: r.ok, error: r.error });
					if (r.ok) ok++;
					else bad++;
				}
				resultBar("retrieveResult", bad > 0 ? "failure" : "success", bad > 0 ? `❌ Retrieved ${ok}, ${bad} failed` : `✅ Retrieved ${ok} component${ok === 1 ? "" : "s"}`);
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
		case "testSuites":
			suites.setSuites(Array.isArray(m.suites) ? m.suites : []);
			break;
		case "presets":
			presets = Array.isArray(m.presets) ? m.presets : [];
			renderPresetOptions();
			break;
		case "presetSaved":
			setStatus(`Preset “${m.name}” saved.`);
			break;
		case "applySelection":
			selectKeys(Array.isArray(m.keys) ? m.keys.map(String) : [], true);
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

setupEvents();
applyWidths();
post({ command: "ready" });
