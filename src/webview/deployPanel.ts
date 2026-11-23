/**
 * Deploy Metadata webview: the component list (grouped by metadata type, like the Org Browser) with the
 * shared filter bar and the status against the target org, plus the deployment options. Bundled by
 * esbuild to resources/webview/deployPanel.js; talks to DeployMetadataPanelProvider via postMessage.
 *
 * The selection is a set of component keys (`Type:fullName`), leaves only: a ticked component deploys
 * exactly its own files. Folder / type checkboxes are shortcuts that tick the VISIBLE rows below them.
 */
import {
	DEFAULT_FILTER,
	Facets,
	FilterContext,
	FilterState,
	SearchIndex,
	buildIndex,
	computeFacets,
	filterIndices,
	highlightRanges,
	highlightTerms,
	relativeTime,
	sortIndices,
} from "../utils/orgBrowser/filter";
import { splitByVisibility } from "../utils/orgBrowser/selection";
import { Comp } from "../utils/orgBrowser/types";
import {
	DEPLOY_STATUS_LABELS,
	DEPLOY_STATUS_NAMES,
	DEPLOY_VOCAB,
	DS_CHANGED_IN_ORG,
	DS_CHANGED_LOCALLY,
	DS_CONFLICT,
	DS_EQUAL,
	DS_NEW,
	DS_UNKNOWN,
	deployStatus,
} from "../utils/deployStatusPure";
import {
	CompareProgress,
	ContentInfoMap,
	LocalInfoMap,
	contentFromCode,
	effectiveSyncedAt,
	isComparedCode,
	progressText,
} from "../utils/compareStatusPure";
import { $, FilterBar, createFilterBar, esc, toggleIn } from "./shared/filterBar";
import { createSharedFilterSync } from "./shared/sharedFilter";
import { filterTestList, mountTestTree } from "./shared/testTree";
import { mountTestSuites, type TestSuite } from "./shared/testSuites";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrgOpt {
	label: string;
	username: string;
}

interface Preset {
	name: string;
	components: string[];
	deployType: string;
	testClassNames: string[];
	targetOrg?: string;
	validateOnly?: boolean;
	/** Paths of an old preset that matched no component. */
	unmatched?: number;
}

interface UiState {
	filter: FilterState;
	collapsed: string[];
	/** Sidebar: true = hidden, false = forced open, undefined = automatic (hidden when the panel is narrow). */
	filtersCollapsed?: boolean;
}

interface PanelState {
	components: string[];
	presetName?: string | null;
	deployType?: string;
	testClassNames?: string[];
	testSuiteName?: string | null;
	targetOrg?: string | null;
	filterOnlySelected?: boolean;
	autoGitSelect?: boolean;
	validateOnly?: boolean;
	ui?: Partial<UiState>;
}

interface Group {
	g: true;
	id: string;
	type: string;
	label: string;
	level: 0 | 1;
	rows: number[];
	collapsed: boolean;
}

interface RowItem {
	i: number;
	lvl: number;
}

type Item = RowItem | Group;

interface OrgStatusMsg {
	state: "none" | "checking" | "ok" | "error";
	error?: string;
	orgLabel: string;
	snapshot: { listed: Record<string, number>; failed: Record<string, string>; comps: Record<string, [number, string, string]>; asOf: number };
	synced: Record<string, number>;
	sentAt: number;
}

/** Types whose components live in folders: shown with a level per folder. */
const FOLDER_CONTENT = new Set(["Report", "Dashboard", "Document", "EmailTemplate"]);

// ── State ──────────────────────────────────────────────────────────────────────

const api = acquireVsCodeApi();
(window as unknown as { __asfxApi: unknown }).__asfxApi = api;
const LOAD_SEQ = Number((window as unknown as { __asfxLoadSeq?: number }).__asfxLoadSeq ?? 0);
/** Stamped with the webview load number: the host drops messages of a load a project switch replaced. */
function post(payload: Record<string, unknown>): void {
	try {
		api.postMessage({ ...payload, seq: LOAD_SEQ });
	} catch (e) {
		console.error("postMessage failed", e);
	}
}

const ROW_H = 28;

function defaultUi(): UiState {
	return { filter: { ...DEFAULT_FILTER }, collapsed: [] };
}

let ui: UiState = defaultUi();
let comps: Comp[] = [];
let idx: SearchIndex = buildIndex([]);
let hasProject = true;
let selected = new Set<string>();
let synced: Record<string, number> = {};
let modified = new Set<string>();
let org: OrgStatusMsg = { state: "none", orgLabel: "", snapshot: { listed: {}, failed: {}, comps: {}, asOf: 0 }, synced: {}, sentAt: 0 };
let statusArr: Uint8Array = new Uint8Array(0);
/** 1 = decided by dates only (contents not compared). */
let provArr: Uint8Array = new Uint8Array(0);
let statusDirty = true;
/** Local change times + git dirty per component (host: compareLocal); undefined = not read yet. */
let localInfo: LocalInfoMap | undefined;
/** Content compare results per component (host: compareContent). */
let contentInfo: ContentInfoMap = {};
let cmpProgress: CompareProgress | null = null;
let rows: number[] = [];
let items: Item[] = [];
let facets: Facets | null = null;
let terms: string[] = [];
let active = -1;
let anchor = -1;
let first = -1;
let last = -1;
let visibleKeysCache: Set<string> | null = null;
let bar: FilterBar;
/** Search text and type selection shared with the Org Browser (per project). */
const sharedSync = createSharedFilterSync({
	filter: () => ui.filter,
	applied: () => {
		bar.syncSearchInput();
		recompute(true);
	},
	send: (s) => post({ command: "sharedFilter", query: s.query, types: s.types }),
});

let testClassesData: { label: string; description: string }[] = [];
let presetsData: Preset[] = [];
let testSuitesData: TestSuite[] = [];
let suites: ReturnType<typeof mountTestSuites>;
let orgsData: OrgOpt[] = [];
let defaultOrgVal = "";
let initialPreset: Preset | null = null;
let loadedPresetName: string | null = null;
let dirty = false;
let pendingPresetIndex: number | null = null;
let lastOrgPosted: string | null = null;
let deploying = false;

const keyAt = (i: number) => idx.comps[i].t + ":" + idx.comps[i].n;

// ── Persistence ────────────────────────────────────────────────────────────────

let saveStateTimer: number | undefined;

function checkedValues(selector: string): string[] {
	return Array.from(document.querySelectorAll<HTMLInputElement>(selector))
		.filter((c) => c.checked)
		.map((c) => c.value);
}

function currentTestLevel(): string {
	return document.querySelector<HTMLInputElement>('input[name="testLevel"]:checked')?.value || "RunRelevantTests";
}

function currentOrg(): string {
	return ($("org-select") as HTMLSelectElement | null)?.value ?? "";
}

function getCurrentPresetState(): { components: string[]; deployType: string; testClassNames: string[]; targetOrg: string | undefined } {
	const deployType = currentTestLevel();
	return {
		components: [...selected],
		deployType,
		testClassNames: deployType === "RunSpecifiedTests" ? checkedValues(".test-class") : [],
		targetOrg: currentOrg() || undefined,
	};
}

function saveState(): void {
	try {
		const s = getCurrentPresetState();
		const state: PanelState = {
			components: s.components,
			presetName: loadedPresetName || null,
			deployType: s.deployType,
			testClassNames: s.testClassNames,
			targetOrg: s.targetOrg || null,
			filterOnlySelected: ui.filter.onlySelected,
			autoGitSelect: ($("auto-git-select") as HTMLInputElement).checked,
			validateOnly: ($("validate-only-check") as HTMLInputElement).checked,
			testSuiteName: suites.selected() || null,
			ui: { filter: { ...ui.filter, onlySelected: false }, collapsed: ui.collapsed, filtersCollapsed: ui.filtersCollapsed },
		};
		api.setState(state);
		post({ command: "persistPanelState", state });
	} catch (e) {
		console.error("saveState failed", e);
	}
}

function scheduleSaveState(): void {
	window.clearTimeout(saveStateTimer);
	saveStateTimer = window.setTimeout(saveState, 400);
}

function setDirty(): void {
	dirty = true;
	scheduleSaveState();
}

/** A panel left open for a while: its org status is refreshed when it is shown again. */
const STALE_MS = 5 * 60_000;

document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		window.clearTimeout(saveStateTimer);
		saveState();
	} else if (org.state === "ok" && Date.now() - org.sentAt > STALE_MS) {
		post({ command: "refreshOrgStatus" });
	}
});

// ── Status ─────────────────────────────────────────────────────────────────────

function ensureStatus(): void {
	if (!statusDirty && statusArr.length === idx.comps.length) return;
	const n = idx.comps.length;
	const arr = new Uint8Array(n);
	const prov = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const c = idx.comps[i];
		const key = c.t + ":" + c.n;
		const o = org.snapshot.comps[key];
		const li = localInfo?.[key];
		const ci = contentInfo[key];
		const r = deployStatus({
			orgKnown: org.snapshot.listed[c.t] !== undefined,
			inOrg: !!o,
			orgLm: o ? o[0] : 0,
			syncedAt: effectiveSyncedAt(synced[key], ci && ci[2] ? ci[2] : undefined),
			local: li ? { localT: li[0], dirty: li[1] === 1 } : undefined,
			content: contentFromCode(ci?.[0]),
		});
		arr[i] = r.code;
		prov[i] = r.provisional ? 1 : 0;
	}
	statusArr = arr;
	provArr = prov;
	statusDirty = false;
}

/** Copy the org's modifier / time / namespace onto the rows (the filter's `by:` / `ns:` read them). */
function applyOrgInfo(): void {
	for (const c of comps) {
		const o = org.snapshot.comps[c.t + ":" + c.n];
		c.lm = o ? o[0] : 0;
		c.by = o ? o[1] : "";
		c.ns = o ? o[2] : "";
	}
	idx = buildIndex(comps);
	statusDirty = true;
}

// ── Recompute ──────────────────────────────────────────────────────────────────

function ctx(): FilterContext {
	return { now: Date.now(), status: statusArr, selected, vocab: DEPLOY_VOCAB };
}

function visibleKeys(): Set<string> {
	if (!visibleKeysCache) visibleKeysCache = new Set(rows.map(keyAt));
	return visibleKeysCache;
}

function hiddenSelected(): string[] {
	return selected.size === 0 ? [] : splitByVisibility(selected, visibleKeys()).hidden;
}

function recompute(resetScroll = false): void {
	sharedSync.changed();
	visibleKeysCache = null;
	ensureStatus();
	const c = ctx();
	terms = highlightTerms(ui.filter.query);
	rows = sortIndices(idx, filterIndices(idx, ui.filter, c), "name", 1, statusArr);
	facets = computeFacets(idx, ui.filter, c);
	buildItems();
	if (resetScroll) $("scroller").scrollTop = 0;
	active = Math.min(active, items.length - 1);
	renderAll();
}

function buildItems(): void {
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
		const trows = byType.get(t)!;
		out.push({ g: true, id: t, type: t, label: t, level: 0, rows: trows, collapsed: collapsed.has(t) });
		if (collapsed.has(t)) continue;
		if (!FOLDER_CONTENT.has(t)) {
			for (const i of trows) out.push({ i, lvl: 1 });
			continue;
		}
		const direct: number[] = [];
		const folders = new Map<string, number[]>();
		for (const i of trows) {
			const n = idx.comps[i].n;
			const slash = n.lastIndexOf("/");
			if (slash < 0) direct.push(i);
			else {
				const f = n.slice(0, slash);
				const arr = folders.get(f);
				if (arr) arr.push(i);
				else folders.set(f, [i]);
			}
		}
		for (const i of direct) out.push({ i, lvl: 1 });
		for (const f of [...folders.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
			const id = `${t}/${f}`;
			const g: Group = { g: true, id, type: t, label: f, level: 1, rows: folders.get(f)!, collapsed: collapsed.has(id) };
			out.push(g);
			if (!g.collapsed) for (const i of g.rows) out.push({ i, lvl: 2 });
		}
	}
	items = out;
}

// ── Rendering ──────────────────────────────────────────────────────────────────

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
	file: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M3 1.500h6.500L13 5v9.500H3zm1 1v11h8V5.500H9V2.500zm6 .700V4.500h1.300z"/></svg>',
	folder: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.500 3h5l1 1.500h7V13h-13zm1 1v8h11V5.500H7z"/></svg>',
	chevron: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6 4l4.500 4L6 12z"/></svg>',
};

const PROV_TIP = "Based on dates — contents not compared yet";

function statusBadge(v: number, prov: boolean, key: string): string {
	const cmp = contentInfo[key];
	const tip = (what: string) => esc(prov ? `${what} (${PROV_TIP})` : `${what} (Contents compared ${cmp && cmp[1] ? new Date(cmp[1]).toLocaleString() : "just now"})`);
	const cls = prov ? " prov" : "";
	switch (v) {
		case DS_UNKNOWN: {
			const type = key.slice(0, key.indexOf(":"));
			const orgReason = org.snapshot.listed[type] === undefined;
			const why = orgReason
				? (org.snapshot.failed[type] ?? (org.state === "none" ? "No target org" : org.state === "checking" ? "Still checking the org…" : "This type has not been listed in the org"))
				: "Local changes not read yet";
			return `<span class="badge unknown" title="${esc("Not compared: " + why)}">Unknown</span>`;
		}
		case DS_NEW:
			return '<span class="badge new" title="Not in the org yet">New</span>';
		case DS_EQUAL:
			return `<span class="badge equal${cls}" title="${tip("Same as the org")}">Equal</span>`;
		case DS_CHANGED_LOCALLY:
			return `<span class="badge changed-local${cls}" title="${tip("Changed here since the last sync with the org")}">Changed locally</span>`;
		case DS_CHANGED_IN_ORG:
			return `<span class="badge changed-org${cls}" title="${tip("Changed in the org since the last sync (latest change shown on the right)")}">Changed in org</span>`;
		case DS_CONFLICT:
			return `<span class="badge conflict${cls}" title="${tip("Changed here and in the org since the last sync")}">Conflict</span>`;
	}
	return "";
}

function rowHtml(pos: number, it: RowItem): string {
	const c = idx.comps[it.i];
	const key = c.t + ":" + c.n;
	const sel = selected.has(key);
	const v = statusArr[it.i] ?? 0;
	const exact = c.lm ? new Date(c.lm).toLocaleString() : "";
	const by = c.by ? `${esc(c.by)} · ` : "";
	const label = (it.lvl > 1 ? c.n.slice(c.n.lastIndexOf("/") + 1) : c.n) || c.n;
	return (
		`<div class="drow${sel ? " sel" : ""}${pos === active ? " active" : ""}${v === DS_CONFLICT ? " conflict" : ""}" data-pos="${pos}" role="row" aria-selected="${sel}" style="padding-left:${6 + it.lvl * 16}px">` +
		`<span class="c cb"><input type="checkbox" class="rowcb" tabindex="-1" ${sel ? "checked" : ""} aria-label="Select ${esc(c.n)}"></span>` +
		`<span class="c nm" title="${esc(key)}">${hl(label)}</span>` +
		`<span class="c st">${statusBadge(v, provArr[it.i] === 1, key)}</span>` +
		`<span class="c md" title="${esc(exact)}">${c.lm ? by + esc(relativeTime(c.lm, Date.now())) : ""}</span>` +
		`<span class="c acts">` +
		(isComparedCode(v) ? `<button data-act="compare" title="Compare with the org" aria-label="Compare with the org">${ICON.diff}</button>` : "") +
		`<button data-act="openFile" title="Open the file" aria-label="Open the file">${ICON.file}</button>` +
		`<button data-act="reveal" title="Reveal in Explorer" aria-label="Reveal in Explorer">${ICON.folder}</button>` +
		`</span></div>`
	);
}

function groupHtml(pos: number, g: Group): string {
	let n = 0;
	for (const i of g.rows) if (selected.has(keyAt(i))) n++;
	const all = n === g.rows.length && n > 0;
	return (
		`<div class="drow grp${pos === active ? " active" : ""}" data-pos="${pos}" role="row" style="padding-left:${6 + g.level * 16}px">` +
		`<span class="c cb"><input type="checkbox" class="grpcb" tabindex="-1" ${all ? "checked" : ""} data-partial="${n > 0 && !all}" aria-label="Select all ${esc(g.label)}"></span>` +
		`<span class="c gname"><span class="chev${g.collapsed ? "" : " open"}">${ICON.chevron}</span><b>${hl(g.label)}</b>` +
		`<span class="gcount">${g.rows.length.toLocaleString()}${n > 0 ? ` · ${n.toLocaleString()} selected` : ""}</span></span></div>`
	);
}

function renderRows(force = false): void {
	const sc = $("scroller");
	const n = items.length;
	const view = Math.ceil(sc.clientHeight / ROW_H) + 12;
	const f = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 6);
	const l = Math.min(n, f + view);
	if (f === first && l === last && !force) return;
	first = f;
	last = l;
	let html = "";
	for (let p = f; p < l; p++) {
		const it = items[p];
		html += "g" in it ? groupHtml(p, it) : rowHtml(p, it);
	}
	$("rowsEl").innerHTML = html;
	($("rowsEl").style as CSSStyleDeclaration).transform = `translateY(${f * ROW_H}px)`;
	for (const cb of $("rowsEl").querySelectorAll<HTMLInputElement>(".grpcb")) cb.indeterminate = cb.dataset.partial === "true";
}

function invalidateRows(): void {
	renderRows(true);
}

function renderGridChrome(): void {
	$("spacer").style.height = items.length * ROW_H + "px";
	const total = idx.comps.length;
	$("countInfo").textContent = total
		? rows.length === total
			? `${total.toLocaleString()} components`
			: `${rows.length.toLocaleString()} of ${total.toLocaleString()} components`
		: "";
	const allSel = rows.length > 0 && rows.every((i) => selected.has(keyAt(i)));
	const btn = $("btn-select-deselect-all");
	btn.title = allSel ? "Deselect all filtered" : "Select all filtered";
	btn.setAttribute("aria-label", btn.title);
	($("btn-select-deselect-all").firstElementChild as HTMLElement).textContent = allSel ? "☐" : "☑";
	($("filter-only-selected") as HTMLInputElement).checked = ui.filter.onlySelected;
	const anyType = items.some((it) => "g" in it);
	$("collapseAll").hidden = !anyType;
}

function typeSummary(): string {
	const by = new Map<string, number>();
	for (const k of selected) {
		const t = k.slice(0, k.indexOf(":"));
		by.set(t, (by.get(t) ?? 0) + 1);
	}
	return [...by.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([t, n]) => `${n} ${t}`)
		.join(", ");
}

function setStatus(text: string): void {
	$("deploy-status").textContent = text;
}

function updateSelectionStatus(): void {
	const total = selected.size;
	const badge = $("sel-count-badge");
	badge.textContent = total > 0 ? String(total) : "";
	badge.style.display = total > 0 ? "inline" : "none";
	if (total === 0) {
		setStatus("Ready. No components selected.");
		return;
	}
	const parts = [typeSummary()];
	if (currentTestLevel() === "RunSpecifiedTests") {
		const n = document.querySelectorAll(".test-class:checked").length;
		parts.push(n === 1 ? "1 test to run" : `${n} tests to run`);
	}
	setStatus(`Ready. ${total.toLocaleString()} component${total === 1 ? "" : "s"}: ${parts.join(", ")}.`);
}

function renderTop(): void {
	const hidden = hiddenSelected().length;
	const hb = $("selHidden");
	hb.hidden = hidden === 0;
	$("selHiddenText").textContent = `${hidden.toLocaleString()} selected component${hidden === 1 ? " is" : "s are"} hidden by the filter —`;
	updateSelectionStatus();
	renderOrgInfo();
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderOrgInfo(): void {
	const el = $("orgInfo");
	const btn = $("orgRefresh") as HTMLButtonElement;
	const failed = Object.keys(org.snapshot.failed).length;
	const asOf = org.snapshot.asOf;
	let text = "";
	let title = "";
	switch (org.state) {
		case "none":
			text = "No target org — status unknown";
			title = org.error || "";
			break;
		case "checking":
			text = asOf ? `Checking org… (cached ${clock(asOf)})` : "Checking org…";
			break;
		case "ok":
			text = `Org status as of ${clock(asOf || org.sentAt)}`;
			if (failed > 0) {
				text += ` · ${failed} type${failed === 1 ? "" : "s"} unknown`;
				title = Object.entries(org.snapshot.failed)
					.map(([t, e]) => `${t}: ${e}`)
					.join("\n");
			}
			break;
		case "error":
			text = asOf ? `Org status as of ${clock(asOf)} — refresh failed` : "Org status unknown";
			title = org.error || "";
			break;
	}
	el.textContent = text;
	el.title = title;
	renderCompareInfo();
	el.classList.toggle("err", org.state === "error");
	el.classList.toggle("busy", org.state === "checking");
	btn.disabled = org.state === "checking" || org.state === "none";
	const banner = $("banner");
	banner.hidden = org.state !== "error";
	banner.textContent = org.state === "error" ? `Couldn’t read the org (${org.error || "unknown error"}). Status shows “unknown” where it was never listed; deploying still works.` : "";
	const nof = $("noRows");
	nof.hidden = idx.comps.length > 0;
	nof.textContent = hasProject ? "No metadata components found in the package directories (sfdx-project.json)." : "No SFDX project in this folder — open one with sfdx-project.json to deploy.";
}

function renderCompareInfo(): void {
	const el = $("cmpInfo");
	const t = progressText(cmpProgress);
	const failed = cmpProgress?.failed ?? 0;
	el.textContent = t ? ` · ${t}` : "";
	el.title = failed > 0 ? `${failed} component${failed === 1 ? "" : "s"} could not be compared (they keep the date-based status)` : "";
	el.classList.toggle("busy", cmpProgress?.state === "running");
	($("cmpBtn") as HTMLButtonElement).disabled = org.state === "none";
}

function renderAll(): void {
	renderTop();
	bar.renderFacets();
	renderGridChrome();
	invalidateRows();
}

// ── Selection ──────────────────────────────────────────────────────────────────

function afterSelectionChange(): void {
	setDirty();
	if (ui.filter.onlySelected) {
		if (selected.size === 0) ui.filter.onlySelected = false;
		recompute();
	} else {
		renderTop();
		renderGridChrome();
		invalidateRows();
	}
}

function toggleKey(key: string, on?: boolean): void {
	const want = on ?? !selected.has(key);
	if (want) selected.add(key);
	else selected.delete(key);
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

function selectRange(a: number, b: number, on: boolean): void {
	for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
		const it = items[p];
		if (it && !("g" in it)) toggleKey(keyAt(it.i), on);
	}
}

// ── Grid events ────────────────────────────────────────────────────────────────

function setActive(pos: number, scroll = true): void {
	if (items.length === 0) return;
	active = Math.max(0, Math.min(items.length - 1, pos));
	if (scroll) {
		const sc = $("scroller");
		const top = active * ROW_H;
		if (top < sc.scrollTop) sc.scrollTop = top;
		else if (top + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + ROW_H - sc.clientHeight;
	}
	invalidateRows();
}

function toggleCollapsed(id: string): void {
	ui.collapsed = toggleIn(ui.collapsed, id);
	recompute();
	scheduleSaveState();
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
			if (!it) return;
			if ("g" in it) toggleGroup(it);
			else {
				toggleKey(keyAt(it.i));
				anchor = active;
				afterSelectionChange();
			}
			break;
		}
		case "Enter": {
			const it = items[active];
			if (!it || !("g" in it)) return;
			toggleCollapsed(it.id);
			break;
		}
		default:
			return;
	}
	e.preventDefault();
}

function rowAction(act: string, key: string): void {
	post({ command: act, key });
}

function setupGridEvents(): void {
	const rowsEl = $("rowsEl");
	rowsEl.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		const rowEl = t.closest<HTMLElement>(".drow");
		if (!rowEl) return;
		const pos = Number(rowEl.dataset.pos);
		const it = items[pos];
		if (it === undefined) return;
		if ("g" in it) {
			if (t.classList.contains("grpcb")) {
				toggleGroup(it);
				return;
			}
			setActive(pos, false);
			toggleCollapsed(it.id);
			return;
		}
		const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
		if (act) {
			rowAction(act, keyAt(it.i));
			return;
		}
		const e2 = e as MouseEvent;
		const on = t.classList.contains("rowcb") ? (t as HTMLInputElement).checked : !selected.has(keyAt(it.i));
		if (e2.shiftKey && anchor >= 0) selectRange(anchor, pos, on);
		else toggleKey(keyAt(it.i), on);
		anchor = pos;
		active = pos;
		afterSelectionChange();
	});
	rowsEl.addEventListener("dblclick", (e) => {
		const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".drow");
		const it = rowEl ? items[Number(rowEl.dataset.pos)] : undefined;
		if (it && !("g" in it)) rowAction("openFile", keyAt(it.i));
	});
	const sc = $("scroller");
	let raf = 0;
	sc.addEventListener("scroll", () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			renderRows();
		});
	});
	window.addEventListener("resize", () => renderRows(true));
	sc.addEventListener("keydown", onGridKey);
}

// ── Filter bar + toolbar ───────────────────────────────────────────────────────

const SIDE_MIN_PANEL_W = 560;

function sideVisible(): boolean {
	return getComputedStyle($("side")).display !== "none";
}

function applyFiltersOpen(): void {
	const left = document.querySelector(".panel-left") as HTMLElement;
	left.dataset.side = ui.filtersCollapsed === undefined ? "auto" : ui.filtersCollapsed ? "closed" : "open";
	left.toggleAttribute("data-narrow", left.clientWidth < SIDE_MIN_PANEL_W);
	const b = $("filtersToggle");
	const vis = sideVisible();
	b.setAttribute("aria-expanded", String(vis));
	b.classList.toggle("on", vis);
}

function setupToolbar(): void {
	bar = createFilterBar({
		filter: () => ui.filter,
		facets: () => facets,
		rowCount: () => idx.comps.length,
		statusOptions: DEPLOY_STATUS_NAMES.map((n) => ({ value: n, label: DEPLOY_STATUS_LABELS[n] })),
		onChange: () => {
			recompute(true);
			scheduleSaveState();
		},
		onRefreshType: (t) => post({ command: "refreshOrgStatus", types: [t] }),
		onSearchArrowDown: () => {
			$("scroller").focus();
			if (active < 0 && items.length) setActive(0);
		},
		preserveOnClear: () => ({ onlySelected: ui.filter.onlySelected && selected.size > 0 }),
	});
	$("filtersToggle").addEventListener("click", () => {
		ui.filtersCollapsed = sideVisible();
		applyFiltersOpen();
		renderRows(true);
		scheduleSaveState();
	});
	$("btn-select-deselect-all").addEventListener("click", toggleFiltered);
	($("filter-only-selected") as HTMLInputElement).addEventListener("change", (e) => {
		ui.filter.onlySelected = (e.target as HTMLInputElement).checked && selected.size > 0;
		recompute(true);
		scheduleSaveState();
	});
	$("selHiddenShow").addEventListener("click", () => {
		ui.filter = { ...DEFAULT_FILTER, status: [], onlySelected: true };
		bar.syncSearchInput();
		recompute(true);
		scheduleSaveState();
	});
	$("selHiddenClear").addEventListener("click", () => {
		for (const k of hiddenSelected()) selected.delete(k);
		afterSelectionChange();
	});
	$("collapseAll").addEventListener("click", () => {
		const all = new Set(rows.map((i) => idx.comps[i].t));
		ui.collapsed = ui.collapsed.length >= all.size ? [] : [...all];
		recompute();
		scheduleSaveState();
	});
	$("orgRefresh").addEventListener("click", () => post({ command: "refreshOrgStatus" }));
	// Compare contents: what needs it; with a filter active, the shown components again (forced).
	$("cmpBtn").addEventListener("click", () => {
		const filtered = rows.length < idx.comps.length;
		post(filtered ? { command: "compareContents", force: true, keys: rows.map(keyAt) } : { command: "compareContents", force: false });
		setStatus(filtered ? `Comparing the contents of ${rows.length.toLocaleString()} shown component${rows.length === 1 ? "" : "s"}…` : "Comparing contents…");
	});
	document.addEventListener("keydown", (e) => {
		const tag = (e.target as HTMLElement).tagName;
		if (e.key === "/" && tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") {
			e.preventDefault();
			bar.focusSearch();
		}
	});
	applyFiltersOpen();
	let lastNarrow = (document.querySelector(".panel-left") as HTMLElement).hasAttribute("data-narrow");
	new ResizeObserver(() => {
		const left = document.querySelector(".panel-left") as HTMLElement;
		const narrow = left.clientWidth < SIDE_MIN_PANEL_W;
		if (narrow === lastNarrow) return;
		lastNarrow = narrow;
		applyFiltersOpen();
		renderRows(true);
	}).observe(document.querySelector(".panel-left") as HTMLElement);
}

// ── Right panel: options, presets, test classes, suites ────────────────────────

function setOrgOptions(): void {
	const sel = $("org-select") as HTMLSelectElement;
	if (orgsData.length === 0) {
		sel.innerHTML = '<option value="">No orgs found</option>';
		return;
	}
	sel.innerHTML = orgsData.map((o) => `<option value="${esc(o.username)}">${esc(o.label)}</option>`).join("");
	sel.value = defaultOrgVal || orgsData[0].username;
}

/** Tell the host which org the panel targets (it lists / loads the status for it). */
function postOrgIfChanged(): void {
	const o = currentOrg();
	if (o === lastOrgPosted) return;
	lastOrgPosted = o;
	post({ command: "orgChanged", org: o || null });
}

function renderPresetOptions(): void {
	const sel = $("preset-select") as HTMLSelectElement;
	sel.innerHTML = '<option value="">— None —</option>' + presetsData.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
	const at = loadedPresetName ? presetsData.findIndex((p) => p.name === loadedPresetName) : -1;
	sel.value = at >= 0 ? String(at) : "";
}

function applyPreset(p: Preset): void {
	loadedPresetName = p.name;
	dirty = false;
	const have = new Set(idx.comps.map((c) => c.t + ":" + c.n));
	const keys = (p.components ?? []).filter((k) => have.has(k));
	selected = new Set(keys);
	let deployType = p.deployType || "RunRelevantTests";
	let validate = !!p.validateOnly;
	if (deployType === "ValidateOnly") {
		validate = true;
		deployType = "NoTestRun";
	}
	const radio = document.querySelector<HTMLInputElement>(`input[name="testLevel"][value="${deployType}"]`);
	if (radio) {
		radio.checked = true;
		$("specified-tests-wrap").classList.toggle("visible", deployType === "RunSpecifiedTests");
	}
	($("validate-only-check") as HTMLInputElement).checked = validate;
	for (const cb of document.querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = (p.testClassNames ?? []).includes(cb.value);
	const orgSel = $("org-select") as HTMLSelectElement;
	if (p.targetOrg && Array.from(orgSel.options).some((o) => o.value === p.targetOrg)) orgSel.value = p.targetOrg;
	postOrgIfChanged();
	renderPresetOptions();
	if (ui.filter.onlySelected && selected.size === 0) ui.filter.onlySelected = false;
	recompute();
	const missing = (p.components ?? []).length - keys.length;
	const parts = [`Preset “${p.name}”: ${keys.length} component${keys.length === 1 ? "" : "s"} selected`];
	if (missing > 0) parts.push(`${missing} no longer in the project`);
	if (p.unmatched) parts.push(`${p.unmatched} old path${p.unmatched === 1 ? "" : "s"} matched no component`);
	setStatus(parts.join(", ") + ".");
	saveState();
}

function setupPresets(): void {
	const sel = $("preset-select") as HTMLSelectElement;
	sel.onchange = () => {
		const idxStr = sel.value;
		const newIndex = idxStr === "" ? null : parseInt(idxStr, 10);
		if (dirty && loadedPresetName) {
			pendingPresetIndex = newIndex;
			$("preset-modal-message").textContent = `Preset '${loadedPresetName}' was modified. Save changes?`;
			$("preset-modal-overlay").style.display = "flex";
			const cur = presetsData.findIndex((p) => p.name === loadedPresetName);
			sel.value = cur >= 0 ? String(cur) : "";
			return;
		}
		loadedPresetName = null;
		dirty = false;
		if (idxStr === "") return;
		const p = presetsData[newIndex!];
		if (p) applyPreset(p);
	};
}

function finishPresetSwitch(): void {
	const sel = $("preset-select") as HTMLSelectElement;
	const i = pendingPresetIndex;
	pendingPresetIndex = null;
	$("preset-modal-overlay").style.display = "none";
	if (i === null || i === undefined) {
		loadedPresetName = null;
		sel.value = "";
		return;
	}
	const p = presetsData[i];
	sel.value = String(i);
	if (p) applyPreset(p);
	else loadedPresetName = null;
}

function savePresetMsg(name: string): void {
	const s = getCurrentPresetState();
	post({ command: "savePreset", presetName: name, components: s.components, deployType: s.deployType, testClassNames: s.testClassNames, targetOrg: s.targetOrg });
	setStatus("Saving preset…");
}

function setupPresetModals(): void {
	$("btn-save-preset").onclick = () => {
		if (loadedPresetName) {
			savePresetMsg(loadedPresetName);
		} else {
			const input = $("new-preset-name-input") as HTMLInputElement;
			input.value = "";
			$("new-preset-modal-overlay").style.display = "flex";
			input.focus();
		}
	};
	$("new-preset-modal-save").onclick = () => {
		const name = ($("new-preset-name-input") as HTMLInputElement).value.trim();
		if (!name) return;
		$("new-preset-modal-overlay").style.display = "none";
		savePresetMsg(name);
	};
	$("new-preset-modal-cancel").onclick = () => {
		$("new-preset-modal-overlay").style.display = "none";
	};
	$("preset-modal-save").onclick = () => {
		savePresetMsg(loadedPresetName || "");
		finishPresetSwitch();
	};
	$("preset-modal-dont").onclick = () => {
		dirty = false;
		finishPresetSwitch();
	};
	$("preset-modal-cancel").onclick = () => {
		pendingPresetIndex = null;
		$("preset-modal-overlay").style.display = "none";
	};
}

// Test classes -----------------------------------------------------------------

function renderTestList(): void {
	mountTestTree($("test-list"), testClassesData, () => {
		setDirty();
		updateSelectionStatus();
	});
}

// Suites -----------------------------------------------------------------------

function setupSuites(): void {
	suites = mountTestSuites({
		post,
		checked: () => checkedValues(".test-class"),
		onApplied: () => {
			setDirty();
			updateSelectionStatus();
		},
		setStatus,
	});
}

// ── Deploy ─────────────────────────────────────────────────────────────────────

function setupDeploy(): void {
	($("test-search") as HTMLInputElement).oninput = () => filterTestList($("test-list"), ($("test-search") as HTMLInputElement).value);
	for (const r of document.querySelectorAll<HTMLInputElement>('input[name="testLevel"]')) {
		r.onchange = () => {
			setDirty();
			$("specified-tests-wrap").classList.toggle("visible", r.value === "RunSpecifiedTests");
			updateSelectionStatus();
		};
	}
	($("org-select") as HTMLSelectElement).onchange = () => {
		setDirty();
		postOrgIfChanged();
	};
	($("validate-only-check") as HTMLInputElement).onchange = scheduleSaveState;
	$("deploy-btn").onclick = () => {
		if (deploying) return;
		if (selected.size === 0) {
			setStatus("Select at least one component.");
			return;
		}
		const testLevel = currentTestLevel();
		const testClassNames = testLevel === "RunSpecifiedTests" ? checkedValues(".test-class") : [];
		if (testLevel === "RunSpecifiedTests" && testClassNames.length === 0) {
			setStatus("Select at least one test class for Run Specified Tests.");
			return;
		}
		setStatus("");
		post({
			command: "deploy",
			components: [...selected],
			visible: splitByVisibility(selected, visibleKeys()).visible,
			testLevel,
			testClassNames: testClassNames.length ? testClassNames : undefined,
			dryRun: ($("validate-only-check") as HTMLInputElement).checked,
			targetOrg: currentOrg() || undefined,
			presetName: loadedPresetName || undefined,
		});
	};
	$("openCenterBtn").onclick = () => post({ command: "openCenter", components: [...selected], targetOrg: currentOrg() || undefined });
	$("btn-git-select").onclick = () => {
		post({ command: "getChangedFiles" });
		setStatus("Reading Git status…");
	};
	($("auto-git-select") as HTMLInputElement).onchange = (e) => {
		if ((e.target as HTMLInputElement).checked) {
			setStatus("Reading Git status…");
			post({ command: "getChangedFiles" });
		}
		scheduleSaveState();
	};
	$("panelSplit").addEventListener("mousedown", (e) => {
		const right = document.querySelector<HTMLElement>(".panel-right")!;
		const sx = e.clientX;
		const sw = right.getBoundingClientRect().width;
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		e.preventDefault();
		const move = (ev: MouseEvent) => {
			const max = Math.max(300, window.innerWidth - 360);
			right.style.width = Math.min(max, Math.max(300, sw + (sx - ev.clientX))) + "px";
		};
		const up = () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
	});
}

function showResult(m: Record<string, any>): void {
	const bar_ = $("deploy-result-bar");
	const cov = $("coverage-panel");
	deploying = false;
	if (m.cancelled) {
		bar_.style.display = "none";
		cov.style.display = "none";
		cov.innerHTML = "";
		return;
	}
	const success = !!m.success;
	bar_.className = "deploy-result-bar " + (success ? "success" : "failure");
	const verb = m.dryRun ? (success ? "Validation passed" : "Validation failed") : success ? "Deploy succeeded" : "Deploy failed";
	const parts = [(success ? "✅ " : "❌ ") + verb];
	if (m.components > 0) parts.push(m.components + " component" + (m.components !== 1 ? "s" : ""));
	if (m.componentErrors > 0) parts.push(m.componentErrors + " error" + (m.componentErrors !== 1 ? "s" : ""));
	if (m.testsPassed > 0 || m.testsFailed > 0) parts.push("Tests: " + m.testsPassed + " passed" + (m.testsFailed > 0 ? ", " + m.testsFailed + " failed" : ""));
	if (m.durationMs) {
		const s = Math.round(m.durationMs / 1000);
		parts.push(s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s");
	}
	if (m.error) parts.push(String(m.error));
	bar_.textContent = parts.join(" · ");
	bar_.style.display = "block";
	const list: { name: string; pct: number }[] = success && Array.isArray(m.coverage) ? m.coverage : [];
	if (list.length === 0) {
		cov.style.display = "none";
		cov.innerHTML = "";
		return;
	}
	const avg = Math.round(list.reduce((acc, e) => acc + e.pct, 0) / list.length);
	const cls = (p: number) => (p < 75 ? "cov-red" : p < 85 ? "cov-amber" : "cov-green");
	cov.innerHTML =
		`<div class="coverage-toggle" id="cov-toggle">📊 Coverage — <span class="cov-avg ${cls(avg)}">${avg}%</span> avg <span class="cov-chev">▾</span></div><div class="coverage-list" id="cov-list">` +
		list.map((e) => `<div class="cov-row"><span class="cov-name">${esc(e.name)}</span><span class="cov-pct ${cls(e.pct)}">${e.pct}%</span></div>`).join("") +
		"</div>";
	$("cov-toggle").onclick = function () {
		const l = $("cov-list");
		const hidden = l.style.display === "none";
		l.style.display = hidden ? "" : "none";
		const ch = (this as HTMLElement).querySelector(".cov-chev");
		if (ch) ch.textContent = hidden ? "▾" : "▸";
	};
	cov.style.display = "block";
}

// ── State restore ──────────────────────────────────────────────────────────────

function mergeUi(saved: Partial<UiState> | undefined): void {
	const d = defaultUi();
	ui = {
		filter: { ...d.filter, ...(saved?.filter ?? {}), onlySelected: false },
		collapsed: saved?.collapsed ?? d.collapsed,
		filtersCollapsed: typeof saved?.filtersCollapsed === "boolean" ? saved.filtersCollapsed : undefined,
	};
}

function pruneSelection(): number {
	const have = new Set(idx.comps.map((c) => c.t + ":" + c.n));
	let dropped = 0;
	for (const k of [...selected]) {
		if (!have.has(k)) {
			selected.delete(k);
			dropped++;
		}
	}
	return dropped;
}

function restoreState(state: PanelState): void {
	loadedPresetName = state.presetName || null;
	selected = new Set(state.components ?? []);
	let deployType = state.deployType || "RunRelevantTests";
	let legacyValidate = false;
	// Legacy: "ValidateOnly" used to be a test level — it is the dry-run option now.
	if (deployType === "ValidateOnly") {
		legacyValidate = true;
		deployType = "NoTestRun";
	}
	const radio = document.querySelector<HTMLInputElement>(`input[name="testLevel"][value="${deployType}"]`);
	if (radio) {
		radio.checked = true;
		$("specified-tests-wrap").classList.toggle("visible", deployType === "RunSpecifiedTests");
	}
	for (const cb of document.querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = Array.isArray(state.testClassNames) && state.testClassNames.includes(cb.value);
	const orgSel = $("org-select") as HTMLSelectElement;
	if (state.targetOrg && Array.from(orgSel.options).some((o) => o.value === state.targetOrg)) orgSel.value = state.targetOrg;
	const at = loadedPresetName ? presetsData.findIndex((p) => p.name === loadedPresetName) : -1;
	($("preset-select") as HTMLSelectElement).value = at >= 0 ? String(at) : "";
	($("auto-git-select") as HTMLInputElement).checked = !!state.autoGitSelect;
	($("validate-only-check") as HTMLInputElement).checked = legacyValidate || !!state.validateOnly;
	if (state.testSuiteName) suites.select(state.testSuiteName);
}

// ── Host messages ──────────────────────────────────────────────────────────────

function onInit(m: Record<string, any>): void {
	comps = Array.isArray(m.comps) ? m.comps : [];
	hasProject = m.hasProject !== false;
	testClassesData = Array.isArray(m.testClasses) ? m.testClasses : [];
	presetsData = Array.isArray(m.presets) ? m.presets : [];
	testSuitesData = Array.isArray(m.testSuites) ? m.testSuites : [];
	initialPreset = m.initialPreset || null;
	orgsData = Array.isArray(m.orgs) ? m.orgs : [];
	defaultOrgVal = m.defaultOrg !== undefined && m.defaultOrg !== null && m.defaultOrg !== "" ? String(m.defaultOrg) : "";
	try {
		const saved: PanelState | null =
			m.savedState && Array.isArray(m.savedState.components) ? m.savedState : ((api.getState() as PanelState | null) ?? null);
		mergeUi(saved?.ui);
		sharedSync.init(m.sharedFilter);
		const radio = document.querySelector<HTMLInputElement>('input[name="testLevel"][value="RunRelevantTests"]');
		if (radio) radio.checked = true;
		setOrgOptions();
		renderTestList();
		suites.setSuites(testSuitesData);
		renderPresetOptions();
		idx = buildIndex(comps);
		statusDirty = true;
		if (saved && Array.isArray(saved.components)) restoreState(saved);
		const dropped = pruneSelection();
		applyFiltersOpen();
		bar.syncSearchInput();
		recompute(true);
		postOrgIfChanged();
		if (initialPreset) applyPreset(initialPreset);
		else if (dropped > 0) setStatus(`${dropped} previously selected component${dropped === 1 ? " is" : "s are"} no longer in the project.`);
	} catch (e) {
		setStatus("Error: " + ((e as Error)?.message ?? String(e)));
	}
}

window.addEventListener("message", (ev) => {
	const m = ev.data as Record<string, any> | null;
	if (!m || !m.command) return;
	switch (m.command) {
		case "init":
			onInit(m);
			break;
		case "projectSwitchPending":
			$("switch-note").style.display = "block";
			break;
		case "deployStart": {
			deploying = true;
			const b = $("deploy-result-bar");
			b.className = "deploy-result-bar running";
			b.textContent = m.dryRun ? "Validating…" : "Deploying…";
			b.style.display = "block";
			break;
		}
		case "deployResult":
			showResult(m);
			break;
		case "defaultOrgChanged":
			orgsData = Array.isArray(m.orgs) ? m.orgs : orgsData;
			defaultOrgVal = m.defaultOrg !== undefined && m.defaultOrg !== null && m.defaultOrg !== "" ? String(m.defaultOrg) : "";
			setOrgOptions();
			postOrgIfChanged();
			break;
		case "applyPresetFromHost":
			if (m.preset) applyPreset(m.preset as Preset);
			break;
		case "testSuitesUpdated":
			testSuitesData = m.suites || [];
			suites.setSuites(testSuitesData);
			break;
		case "localRows": {
			comps = Array.isArray(m.comps) ? m.comps : [];
			hasProject = m.hasProject !== false;
			applyOrgInfo();
			pruneSelection();
			recompute();
			break;
		}
		case "orgStatus": {
			org = m as unknown as OrgStatusMsg;
			synced = org.synced ?? {};
			applyOrgInfo();
			recompute();
			break;
		}
		case "compareLocal":
			localInfo = (m.local ?? {}) as LocalInfoMap;
			statusDirty = true;
			recompute();
			break;
		case "compareContent":
			contentInfo = m.full ? ((m.content ?? {}) as ContentInfoMap) : { ...contentInfo, ...((m.content ?? {}) as ContentInfoMap) };
			statusDirty = true;
			recompute();
			break;
		case "compareProgress":
			cmpProgress = (m.progress ?? null) as CompareProgress | null;
			renderCompareInfo();
			break;
		case "modifiedKeys": {
			if (m.error) {
				// Only an explicit "select changed" is worth a message; the background status stays quiet outside a repository.
				if (m.select) setStatus("Git: " + m.error);
				break;
			}
			const have = new Set(idx.comps.map((c) => c.t + ":" + c.n));
			modified = new Set<string>((m.keys as string[]).filter((k) => have.has(k)));
			statusDirty = true;
			if (m.select) {
				let added = 0;
				for (const k of modified) {
					if (!selected.has(k)) {
						selected.add(k);
						added++;
					}
				}
				setDirty();
				setStatus(
					!m.total
						? "No changed files in Git."
						: modified.size === 0
							? `Git: ${m.total} changed file(s). None belong to a component of this project.`
							: `Git: ${m.total} changed file(s) → ${modified.size} component${modified.size === 1 ? "" : "s"} (${added} newly selected).`
				);
			}
			recompute();
			break;
		}
		case "presetsChanged":
			// Presets changed elsewhere (another panel saved one): refresh the list, keep the loaded one.
			if (Array.isArray(m.presets)) presetsData = m.presets;
			renderPresetOptions();
			break;
		case "presetSaved":
			dirty = false;
			if (m.name) loadedPresetName = m.name;
			if (Array.isArray(m.presets)) presetsData = m.presets;
			renderPresetOptions();
			if (m.error) setStatus("Preset save failed: " + m.error);
			else if (m.name) setStatus(m.isNew ? `Preset '${m.name}' saved.` : `Preset '${m.name}' updated.`);
			break;
		case "status":
			setStatus(String(m.text ?? ""));
			break;
		case "sharedFilter":
			sharedSync.receive({ query: String(m.query ?? ""), types: Array.isArray(m.types) ? m.types.map(String) : [] });
			break;
	}
});

// ── Boot ───────────────────────────────────────────────────────────────────────

function boot(): void {
	setupToolbar();
	setupGridEvents();
	setupPresets();
	setupPresetModals();
	setupSuites();
	setupDeploy();
	setStatus("Loading…");
	// A webview state written by an older version holds file paths: let the host map them to components.
	const old = api.getState() as { components?: unknown; sourcePaths?: unknown } | null;
	const legacyState = old && !Array.isArray(old.components) && Array.isArray(old.sourcePaths) ? old : undefined;
	post({ command: "panelReady", legacyState });
}

boot();
