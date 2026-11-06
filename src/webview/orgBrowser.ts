/**
 * Org Browser webview: virtualized grid + filter sidebar over every metadata component of an org.
 * Bundled by esbuild to resources/webview/orgBrowser.js; talks to OrgBrowserPanelProvider via postMessage.
 */
import {
	DEFAULT_FILTER,
	FilterContext,
	FilterState,
	Facets,
	SearchIndex,
	SortKey,
	appendToIndex,
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
import { Comp, ListFailure, STATUS_CHANGED, STATUS_LOCAL, STATUS_PARTIAL, TypeInfo, compKey } from "../utils/orgBrowser/types";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrgOpt {
	label: string;
	username: string;
	isDefault: boolean;
}

interface UiState {
	filter: FilterState;
	sort: { key: SortKey; dir: 1 | -1 };
	group: boolean;
	collapsed: string[];
	widths: { type: number; ns: number; by: number; mod: number; status: number };
	statusOpen?: boolean;
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

// ── State ──────────────────────────────────────────────────────────────────────

const api = acquireVsCodeApi();
const post = (msg: unknown) => api.postMessage(msg);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (t: unknown) =>
	String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ROW_H = 28;
const HEAD_H = 30;

function defaultUi(): UiState {
	return {
		filter: { ...DEFAULT_FILTER },
		sort: { key: "name", dir: 1 },
		group: false,
		collapsed: [],
		widths: { type: 150, ns: 90, by: 150, mod: 120, status: 130 },
	};
}

let ui: UiState = defaultUi();
let orgs: OrgOpt[] = [];
let currentOrg: string | null = null;
let hasProject = true;
let projectName = "";
let idx: SearchIndex = buildIndex([]);
let types: TypeInfo[] = [];
let failures: ListFailure[] = [];
let listedAt = 0;
let loading: LoadState | null = null;
let pending: Comp[] | null = null;
let errorView: { state: string; message: string } | null = null;
let noOrg = false;
let local = { keys: new Set<string>(), partial: new Set<string>(), retrieved: {} as Record<string, number>, known: false };
let me = { ids: [] as string[], name: "" };
let statusArr: Uint8Array = new Uint8Array(0);
let statusDirty = true;
let selected = new Set<string>();
let results = new Map<string, { ok: boolean; error?: string }>();
let retrieving = false;
let rows: number[] = [];
let items: Item[] = [];
let facets: Facets | null = null;
let terms: string[] = [];
let active = -1;
let anchor = -1;
let typeFilterText = "";
let first = -1;
let last = -1;

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
	};
}

// ── Status ─────────────────────────────────────────────────────────────────────

function ensureStatus(): void {
	if (!statusDirty && statusArr.length === idx.comps.length) return;
	const n = idx.comps.length;
	const arr = new Uint8Array(n);
	if (local.known) {
		for (let i = 0; i < n; i++) {
			const c = idx.comps[i];
			const key = c.t + ":" + c.n;
			if (!local.keys.has(key)) {
				if (local.partial.has(key)) arr[i] = STATUS_PARTIAL;
				continue;
			}
			const rt = local.retrieved[key];
			arr[i] = rt !== undefined && c.lm > rt ? STATUS_CHANGED : STATUS_LOCAL;
		}
	}
	statusArr = arr;
	statusDirty = false;
}

const keyAt = (i: number) => compKey(idx.comps[i].t, idx.comps[i].n);

// ── Recompute ──────────────────────────────────────────────────────────────────

function ctx(): FilterContext {
	return { now: Date.now(), status: statusArr, selected, meIds: me.ids, meName: me.name };
}

let visibleKeysCache: Set<string> | null = null;

/** Keys of the rows the current filter shows (lazy; reset on every recompute). */
function visibleKeys(): Set<string> {
	if (!visibleKeysCache) visibleKeysCache = new Set(rows.map(keyAt));
	return visibleKeysCache;
}

/** Selected keys the current filter hides. */
function hiddenSelected(): string[] {
	return selected.size === 0 ? [] : splitByVisibility(selected, visibleKeys()).hidden;
}

function recompute(resetScroll = false): void {
	visibleKeysCache = null;
	ensureStatus();
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
	download: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1.5v8.2L5.2 7 4.5 7.7 8 11.2l3.5-3.5-.7-.7L8 9.7V1.5zM2 12v2.5h12V12h-1v1.5H3V12z"/></svg>',
	globe: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm4.9 6.2h-2.2a10 10 0 00-1-4 5.5 5.5 0 013.2 4zM8 2.6c.6.6 1.3 2 1.5 4.6h-3C6.7 4.6 7.4 3.2 8 2.6zM2.6 8.8h2.2c.1 1.5.4 2.9 1 4a5.5 5.5 0 01-3.2-4zm2.2-1.6H2.6a5.5 5.5 0 013.2-4c-.6 1.1-.9 2.500-1 4zM8 13.400c-.6-.6-1.300-2-1.500-4.600h3c-.2 2.600-.9 4-1.500 4.600zm2.200-.6c.6-1.100.9-2.500 1-4h2.200a5.500 5.500 0 01-3.200 4z"/></svg>',
	diff: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 4h9.600l-2-2 .7-.7 3.200 3.200-3.200 3.200-.7-.7 2-2H2zm12 8H4.400l2 2-.7.700L2.500 11.500l3.200-3.200.7.700-2 2H14z"/></svg>',
	folder: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.500 3h5l1 1.500h7V13h-13zm1 1v8h11V5.500H7z"/></svg>',
	copy: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4 4V1.500h10V12h-2.500v2.500H1.500V4zm1 0h6.500v7H13V2.500H5zM2.500 5v8.500h8V5z"/></svg>',
	refresh: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M13.500 8A5.500 5.500 0 112.800 5.800l-1.200-.5L2 4.400l3.600 1.200-.4 3.600-.9-.2.3-1.600A4.500 4.500 0 1012.500 8z"/></svg>',
	chevron: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M6 4l4.500 4L6 12z"/></svg>',
};

function statusBadge(code: number, key: string): string {
	const res = results.get(key);
	let s = "";
	if (code === STATUS_CHANGED) s = '<span class="badge changed" title="Modified in the org after your last retrieve">Changed in org</span>';
	else if (code === STATUS_PARTIAL) s = '<span class="badge partial" title="Some parts (fields, record types …) are in the project, the object file itself is not. Retrieving adds it.">Partly in project</span>';
	else if (code === STATUS_LOCAL) s = '<span class="badge local">In project</span>';
	else s = '<span class="badge none">Not in project</span>';
	if (res) {
		s += res.ok
			? ' <span class="res ok" title="Retrieved">✓</span>'
			: ` <span class="res bad" title="${esc(res.error ?? "Failed")}">✗</span>`;
	}
	return s;
}

function rowHtml(pos: number, i: number): string {
	const c = idx.comps[i];
	const key = c.t + ":" + c.n;
	const sel = selected.has(key);
	const st = statusArr[i] ?? 0;
	const isLocal = st === STATUS_LOCAL || st === STATUS_CHANGED;
	const exact = c.lm ? new Date(c.lm).toLocaleString() : "";
	const failed = results.get(key);
	return (
		`<div class="row${sel ? " sel" : ""}${pos === active ? " active" : ""}${failed && !failed.ok ? " failed" : ""}" data-pos="${pos}" role="row" aria-selected="${sel}">` +
		`<span class="c cb"><input type="checkbox" class="rowcb" tabindex="-1" ${sel ? "checked" : ""} aria-label="Select ${esc(c.n)}"></span>` +
		`<span class="c nm" title="${esc(c.t + ":" + c.n)}">${hl(c.n)}</span>` +
		`<span class="c ty">${hl(c.t)}</span>` +
		`<span class="c ns">${esc(c.ns)}</span>` +
		`<span class="c by" title="${esc(c.by)}">${esc(c.by)}</span>` +
		`<span class="c md" title="${esc(exact)}">${esc(relativeTime(c.lm, Date.now()))}</span>` +
		`<span class="c st">${statusBadge(st, key)}</span>` +
		`<span class="c acts">` +
		`<button data-act="retrieve" title="Retrieve" aria-label="Retrieve">${ICON.download}</button>` +
		`<button data-act="setup" title="Open in Setup" aria-label="Open in Setup">${ICON.globe}</button>` +
		(isLocal ? `<button data-act="compare" title="Compare with local" aria-label="Compare with local">${ICON.diff}</button>` : "") +
		(isLocal ? `<button data-act="reveal" title="Reveal in Explorer" aria-label="Reveal in Explorer">${ICON.folder}</button>` : "") +
		`<button data-act="copy" title="Copy Type:Name" aria-label="Copy name">${ICON.copy}</button>` +
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
	$("countInfo").textContent = total
		? rows.length === total
			? `${total.toLocaleString()} components`
			: `${rows.length.toLocaleString()} of ${total.toLocaleString()} components`
		: "";
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
}

function renderTop(): void {
	const sel = selected.size;
	const chip = $("selChip");
	chip.hidden = sel === 0;
	chip.classList.toggle("on", ui.filter.onlySelected);
	$("selChipText").textContent = `Selected (${sel.toLocaleString()})`;
	const btn = $("retrieveBtn") as HTMLButtonElement;
	const hidden = hiddenSelected().length;
	const hb = $("selHidden");
	hb.hidden = hidden === 0;
	$("selHiddenText").textContent = `${hidden.toLocaleString()} hidden by filter —`;
	btn.textContent = retrieving ? "Retrieving…" : hidden > 0 ? `Retrieve ${sel.toLocaleString()} (${hidden.toLocaleString()} hidden)` : `Retrieve (${sel.toLocaleString()})`;
	btn.disabled = sel === 0 || !hasProject || retrieving || !!errorView || noOrg;
	btn.title = !hasProject
		? "Open an SFDX project (a folder with sfdx-project.json) to retrieve."
		: sel === 0
			? "Select components to retrieve"
			: hidden > 0
				? `${hidden.toLocaleString()} of the ${sel.toLocaleString()} selected components are hidden by the current filter. You will be asked whether to retrieve them too (Ctrl/Cmd+Enter).`
				: "Retrieve the selected components into the project (Ctrl/Cmd+Enter)";
	renderListed();
}

function renderListed(): void {
	const el = $("listedInfo");
	const prog = $("progress");
	if (loading) {
		el.textContent = loading.total
			? `Loaded ${loading.done.toLocaleString()}/${loading.total.toLocaleString()} types…`
			: "Listing metadata…";
		prog.hidden = false;
		($("progressBar").style as CSSStyleDeclaration).width = loading.total ? Math.round((loading.done / loading.total) * 100) + "%" : "8%";
		$("refreshBtn").setAttribute("disabled", "");
	} else {
		prog.hidden = true;
		el.textContent = listedAt ? `Listed ${relativeTime(listedAt, Date.now())}` : "";
		el.title = listedAt ? new Date(listedAt).toLocaleString() : "";
		$("refreshBtn").toggleAttribute("disabled", noOrg);
	}
}

function facetRow(kind: string, value: string, label: string, count: number, checked: boolean, extra = ""): string {
	return (
		`<label class="frow${count === 0 && !checked ? " zero" : ""}" data-kind="${kind}" data-value="${esc(value)}">` +
		`<input type="checkbox" ${checked ? "checked" : ""}><span class="fl">${esc(label)}</span>${extra}<span class="fc">${count.toLocaleString()}</span></label>`
	);
}

function renderFacets(): void {
	if (!facets) return;
	const f = ui.filter;
	// Local status
	$("fStatus").innerHTML = (
		[
			["not-local", "Not in project", facets.status[0]],
			["local", "In project", facets.status[1]],
			["changed", "Changed in org", facets.status[2]],
			["partial", "Partly in project", facets.status[3]],
		] as [string, string, number][]
	)
		.map(([v, l, c]) => facetRow("status", v, l, c, f.status.includes(v as never)))
		.join("");

	// Types
	const names = new Set<string>(facets.types.keys());
	for (const t of f.types) names.add(t);
	const q = typeFilterText.trim().toLowerCase();
	const list = [...names].filter((t) => !q || t.toLowerCase().includes(q));
	list.sort((a, b) => (facets!.types.get(b) ?? 0) - (facets!.types.get(a) ?? 0) || a.localeCompare(b));
	$("typeList").innerHTML =
		list
			.map((t) =>
				facetRow(
					"type",
					t,
					t,
					facets!.types.get(t) ?? 0,
					f.types.includes(t),
					`<button class="only" data-only="${esc(t)}" title="Show only ${esc(t)}">only</button><button class="tref" data-tref="${esc(t)}" title="Re-list ${esc(t)} only">${ICON.refresh}</button>`
				)
			)
			.join("") || '<div class="muted pad">No matching types</div>';
	$("typeCount").textContent = f.types.length ? `${f.types.length} selected` : "all";

	// Namespaces
	const nsNames = [...facets.namespaces.keys()].filter((n) => n !== "").sort((a, b) => (facets!.namespaces.get(b) ?? 0) - (facets!.namespaces.get(a) ?? 0) || a.localeCompare(b));
	const unmanagedCount = facets.namespaces.get("") ?? 0;
	$("fNs").innerHTML =
		`<div class="chips"><button class="chip${f.nsMode === "all" ? " on" : ""}" data-ns="all">All</button>` +
		`<button class="chip${f.nsMode === "unmanaged" ? " on" : ""}" data-ns="unmanaged">Unmanaged only <span class="fc">${unmanagedCount.toLocaleString()}</span></button></div>` +
		nsNames.map((n) => facetRow("ns", n, n, facets!.namespaces.get(n) ?? 0, f.nsMode === "specific" && f.namespaces.includes(n))).join("");

	// Manageable state
	const stNames = [...facets.states.keys()].sort((a, b) => (facets!.states.get(b) ?? 0) - (facets!.states.get(a) ?? 0));
	$("fState").innerHTML = stNames.map((s) => facetRow("state", s, s || "(unknown)", facets!.states.get(s) ?? 0, f.states.includes(s))).join("");

	($("fMine") as HTMLInputElement).checked = f.mine;
	($("fMine") as HTMLInputElement).disabled = me.ids.length === 0 && !me.name;
	($("fMine").parentElement as HTMLElement).title = me.ids.length === 0 && !me.name ? "Current user not resolved yet" : "";
	($("fWithin") as HTMLSelectElement).value = f.within;
	$("fCustom").hidden = f.within !== "custom";
	($("fFrom") as HTMLInputElement).value = f.from ? new Date(f.from).toISOString().slice(0, 10) : "";
	($("fTo") as HTMLInputElement).value = f.to ? new Date(f.to).toISOString().slice(0, 10) : "";

	const activeCount =
		(f.types.length ? 1 : 0) + (f.nsMode !== "all" ? 1 : 0) + (f.states.length ? 1 : 0) + (f.status.length ? 1 : 0) + (f.mine ? 1 : 0) + (f.within !== "any" ? 1 : 0);
	$("clearFilters").hidden = activeCount === 0 && !f.query;
}

function renderOverlay(): void {
	const ov = $("overlay");
	const banner = $("banner");
	banner.innerHTML = "";
	let overlayHtml = "";
	if (noOrg) {
		overlayHtml =
			'<div class="card"><h3>No authorized org</h3><p>Authorize an org to browse its metadata.</p><button class="primary" data-ov="connectOrg">Authorize an org</button></div>';
	} else if (errorView && idx.comps.length === 0) {
		const btns =
			errorView.state === "authInvalid"
				? '<button class="primary" data-ov="reauth">Re-authenticate</button><button data-ov="chooseOrg">Choose another org</button>'
				: errorView.state === "noDefaultOrg"
					? '<button class="primary" data-ov="chooseOrg">Choose an org</button>'
					: '<button class="primary" data-ov="retry">Retry</button>';
		overlayHtml = `<div class="card err"><h3>${errorView.state === "authInvalid" ? "Org connection is not valid" : "Couldn’t list metadata"}</h3><p>${esc(errorView.message)}</p><div class="btns">${btns}</div></div>`;
	} else if (loading && idx.comps.length === 0) {
		overlayHtml = `<div class="card"><h3>Listing metadata…</h3><p>${
			loading.total ? `Loaded ${loading.done.toLocaleString()}/${loading.total.toLocaleString()} types…` : "Reading the org’s metadata types…"
		}</p></div>`;
	} else if (idx.comps.length === 0 && !loading && listedAt) {
		overlayHtml = '<div class="card"><h3>Nothing listed</h3><p>The org returned no components.</p></div>';
	}
	ov.innerHTML = overlayHtml;
	ov.hidden = overlayHtml === "";
	const msgs: string[] = [];
	if (errorView && idx.comps.length > 0) {
		const btn = errorView.state === "authInvalid" ? '<button data-ov="reauth">Re-authenticate</button>' : '<button data-ov="retry">Retry</button>';
		msgs.push(`<div class="bn err">${esc(errorView.message)} ${btn}</div>`);
	}
	if (!hasProject) {
		msgs.push('<div class="bn info">No SFDX project is open — you can browse, but retrieve is disabled. Open a folder with sfdx-project.json to retrieve.</div>');
	}
	banner.innerHTML = msgs.join("");

	const fb = $("failBox");
	if (failures.length > 0) {
		fb.hidden = false;
		fb.innerHTML =
			`<details><summary>Couldn’t list (${failures.length})</summary><ul>` +
			failures
				.map((f) => {
					const t = f.type.replace(/ \(.*\)$/, "");
					return `<li><b>${esc(f.type)}</b> — ${esc(f.error)} <button class="linkbtn" data-ov="retryType" data-type="${esc(t)}">Retry</button></li>`;
				})
				.join("") +
			"</ul></details>";
	} else {
		fb.hidden = true;
		fb.innerHTML = "";
	}
}

function renderOrgSelect(): void {
	const sel = $("org") as HTMLSelectElement;
	sel.innerHTML = orgs
		.map((o) => `<option value="${esc(o.username)}"${o.username === currentOrg ? " selected" : ""}>${esc(o.label)}${o.isDefault ? " (default)" : ""}</option>`)
		.join("");
	if (currentOrg && !orgs.some((o) => o.username === currentOrg)) {
		sel.insertAdjacentHTML("afterbegin", `<option value="${esc(currentOrg)}" selected>${esc(currentOrg)}</option>`);
	}
	sel.disabled = orgs.length === 0;
}

function renderAll(): void {
	renderTop();
	renderFacets();
	renderGridChrome();
	renderOverlay();
	invalidateRows();
}

// ── Selection ──────────────────────────────────────────────────────────────────

function afterSelectionChange(): void {
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

// ── Actions ────────────────────────────────────────────────────────────────────

function toast(text: string, kind: "info" | "warn" | "error" = "info"): void {
	const el = $("toast");
	el.textContent = text;
	el.className = "toast show " + kind;
	window.clearTimeout((toast as unknown as { t?: number }).t);
	(toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove("show"), 5000);
}

function pairOf(i: number): { t: string; n: string } {
	return { t: idx.comps[i].t, n: idx.comps[i].n };
}

function retrieveKeys(keys: string[], visible?: string[]): void {
	if (!hasProject) {
		toast("Open an SFDX project to retrieve.", "warn");
		return;
	}
	if (retrieving || keys.length === 0) return;
	const itemsOut = keys.map((k) => {
		const c = k.indexOf(":");
		return { t: k.slice(0, c), n: k.slice(c + 1) };
	});
	retrieving = true;
	results = new Map();
	renderTop();
	post({ command: "retrieve", items: itemsOut, ...(visible ? { visible } : {}) });
}

function retrieveSelection(): void {
	retrieveKeys([...selected], splitByVisibility(selected, visibleKeys()).visible);
}

function rowAction(act: string, i: number): void {
	const p = pairOf(i);
	switch (act) {
		case "retrieve":
			retrieveKeys([compKey(p.t, p.n)]);
			break;
		case "retrieveSel":
			retrieveSelection();
			break;
		case "setup":
			post({ command: "setup", ...p });
			break;
		case "compare":
			post({ command: "compare", ...p });
			break;
		case "reveal":
			post({ command: "reveal", ...p });
			break;
		case "open":
			post({ command: "openFile", ...p });
			break;
		case "copy":
			post({ command: "copy", text: compKey(p.t, p.n) });
			toast(`Copied ${compKey(p.t, p.n)}`);
			break;
		case "copyName":
			post({ command: "copy", text: p.n });
			toast(`Copied ${p.n}`);
			break;
	}
}

// ── Context menu ───────────────────────────────────────────────────────────────

let menuRow = -1;

function showMenu(i: number, x: number, y: number): void {
	menuRow = i;
	const key = keyAt(i);
	const isLocal = [STATUS_LOCAL, STATUS_CHANGED].includes(statusArr[i] ?? 0);
	const multi = selected.has(key) && selected.size > 1;
	const entries: [string, string, boolean][] = [
		[multi ? "retrieveSel" : "retrieve", multi ? `Retrieve selected (${selected.size})` : "Retrieve", hasProject],
		["setup", "Open in Setup", true],
		["compare", "Compare with local", isLocal],
		["open", "Open local file", isLocal],
		["reveal", "Reveal in Explorer", isLocal],
		["copy", "Copy Type:Name", true],
		["copyName", "Copy name", true],
	];
	const m = $("menu");
	m.innerHTML = entries
		.filter(([, , show]) => show)
		.map(([a, l]) => `<button role="menuitem" data-mact="${a}">${esc(l)}</button>`)
		.join("");
	m.hidden = false;
	const r = m.getBoundingClientRect();
	m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + "px";
	m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
	(m.querySelector("button") as HTMLElement | null)?.focus();
}

function hideMenu(): void {
	$("menu").hidden = true;
	menuRow = -1;
}

// ── Events ─────────────────────────────────────────────────────────────────────

function setQuery(q: string, immediate = false): void {
	ui.filter.query = q;
	const run = () => {
		recompute(true);
		saveUi();
	};
	if (immediate || idx.comps.length < 8000) run();
	else {
		window.clearTimeout((setQuery as unknown as { t?: number }).t);
		(setQuery as unknown as { t?: number }).t = window.setTimeout(run, 90);
	}
}

function clearFilters(): void {
	const sel = ui.filter.onlySelected;
	ui.filter = { ...DEFAULT_FILTER, onlySelected: sel && selected.size > 0 };
	($("search") as HTMLInputElement).value = "";
	recompute(true);
	saveUi();
}

function toggleIn<T>(arr: T[], v: T): T[] {
	return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function setupEvents(): void {
	const search = $("search") as HTMLInputElement;
	search.addEventListener("input", () => setQuery(search.value));
	search.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && search.value) {
			search.value = "";
			setQuery("", true);
			e.stopPropagation();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			$("scroller").focus();
			if (active < 0 && items.length) setActive(0);
		}
	});
	search.addEventListener("paste", (e) => {
		const text = e.clipboardData?.getData("text") ?? "";
		if (!/\r?\n/.test(text.trim())) return;
		const known = new Set(types.map((t) => t.name));
		for (const c of idx.comps) known.add(c.t);
		const pairs = parsePastedPairs(text, known);
		if (!pairs) return;
		e.preventDefault();
		const { indices, missing } = matchPairs(idx, pairs);
		for (const i of indices) selected.add(keyAt(i));
		ui.filter = { ...ui.filter, query: "", onlySelected: selected.size > 0 };
		search.value = "";
		recompute(true);
		toast(
			`Selected ${indices.length} of ${pairs.length} pasted component${pairs.length === 1 ? "" : "s"}` + (missing.length ? ` (${missing.length} not found)` : ""),
			missing.length ? "warn" : "info"
		);
	});
	$("clearSearch").addEventListener("click", () => {
		search.value = "";
		setQuery("", true);
		search.focus();
	});

	($("org") as HTMLSelectElement).addEventListener("change", (e) => {
		const v = (e.target as HTMLSelectElement).value;
		currentOrg = v;
		resetData();
		post({ command: "selectOrg", org: v });
	});
	$("refreshBtn").addEventListener("click", () => post({ command: "refresh" }));
	$("retrieveBtn").addEventListener("click", retrieveSelection);
	$("selChipText").addEventListener("click", () => {
		ui.filter.onlySelected = !ui.filter.onlySelected;
		recompute(true);
		saveUi();
	});
	$("selChipClear").addEventListener("click", () => {
		selected = new Set();
		ui.filter.onlySelected = false;
		recompute();
		saveUi();
	});
	$("selHiddenShow").addEventListener("click", () => {
		ui.filter = { ...DEFAULT_FILTER, onlySelected: true };
		($("search") as HTMLInputElement).value = "";
		recompute(true);
		saveUi();
	});
	$("selHiddenClear").addEventListener("click", () => {
		for (const k of hiddenSelected()) selected.delete(k);
		afterSelectionChange();
		saveUi();
	});
	$("selAll").addEventListener("click", toggleFiltered);
	($("headCb") as HTMLInputElement).addEventListener("click", toggleFiltered);
	($("groupToggle") as HTMLInputElement).addEventListener("change", (e) => {
		ui.group = (e.target as HTMLInputElement).checked;
		active = -1;
		recompute(true);
		saveUi();
	});
	$("clearFilters").addEventListener("click", clearFilters);
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

	// Sidebar (delegated)
	$("side").addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		const only = t.closest<HTMLElement>("[data-only]");
		if (only) {
			e.preventDefault();
			ui.filter.types = [only.dataset.only!];
			recompute(true);
			saveUi();
			return;
		}
		const tref = t.closest<HTMLElement>("[data-tref]");
		if (tref) {
			e.preventDefault();
			post({ command: "refreshTypes", types: [tref.dataset.tref] });
			return;
		}
		const ns = t.closest<HTMLElement>("[data-ns]");
		if (ns) {
			ui.filter.nsMode = ns.dataset.ns === "unmanaged" ? "unmanaged" : "all";
			ui.filter.namespaces = [];
			recompute(true);
			saveUi();
			return;
		}
		const row = t.closest<HTMLElement>(".frow");
		if (row && t.tagName !== "INPUT") {
			// The label forwards the click to its checkbox; handle alt-click ("only this") here.
			if ((e as MouseEvent).altKey && row.dataset.kind === "type") {
				e.preventDefault();
				ui.filter.types = [row.dataset.value!];
				recompute(true);
				saveUi();
			}
		}
	});
	$("side").addEventListener("change", (e) => {
		const t = e.target as HTMLInputElement;
		const row = t.closest<HTMLElement>(".frow");
		if (row) {
			const v = row.dataset.value!;
			const f = ui.filter;
			switch (row.dataset.kind) {
				case "type":
					f.types = toggleIn(f.types, v);
					break;
				case "ns":
					f.namespaces = toggleIn(f.nsMode === "specific" ? f.namespaces : [], v);
					f.nsMode = f.namespaces.length ? "specific" : "all";
					break;
				case "state":
					f.states = toggleIn(f.states, v);
					break;
				case "status":
					f.status = toggleIn(f.status, v as never);
					break;
			}
			recompute(true);
			saveUi();
			return;
		}
		if (t.id === "fMine") {
			ui.filter.mine = t.checked;
		} else if (t.id === "fWithin") {
			ui.filter.within = (t as unknown as HTMLSelectElement).value as FilterState["within"];
		} else if (t.id === "fFrom" || t.id === "fTo") {
			const v = (t as HTMLInputElement).value;
			const ms = v ? Date.parse(v + (t.id === "fTo" ? "T23:59:59" : "T00:00:00")) : undefined;
			if (t.id === "fFrom") ui.filter.from = ms;
			else ui.filter.to = ms;
		} else return;
		recompute(true);
		saveUi();
	});
	($("typeSearch") as HTMLInputElement).addEventListener("input", (e) => {
		typeFilterText = (e.target as HTMLInputElement).value;
		renderFacets();
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
		if (typeof it === "number" && [STATUS_LOCAL, STATUS_CHANGED].includes(statusArr[it] ?? 0)) rowAction("open", it);
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
		} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			retrieveSelection();
		} else if (e.key === "Escape" && !$("menu").hidden) {
			hideMenu();
		}
	});
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
	const cols = `34px minmax(180px,1fr) ${w.type}px ${w.ns}px ${w.by}px ${w.mod}px ${w.status}px 132px`;
	document.documentElement.style.setProperty("--cols", cols);
	document.documentElement.style.setProperty("--minw", 34 + 180 + w.type + w.ns + w.by + w.mod + w.status + 132 + "px");
}

function resetData(): void {
	idx = buildIndex([]);
	types = [];
	failures = [];
	listedAt = 0;
	pending = null;
	errorView = null;
	local = { keys: new Set(), partial: new Set(), retrieved: {}, known: false };
	me = { ids: [], name: "" };
	statusDirty = true;
	results = new Map();
	selected = new Set();
	ui.filter.onlySelected = false;
	active = -1;
	loading = null;
	recompute(true);
}

// ── Host messages ──────────────────────────────────────────────────────────────

let batchTimer: number | undefined;
function scheduleStreamRender(): void {
	if (batchTimer) return;
	batchTimer = window.setTimeout(() => {
		batchTimer = undefined;
		statusDirty = true;
		recompute();
	}, 300);
}

window.addEventListener("message", (ev) => {
	const m = ev.data as { type: string; [k: string]: any };
	switch (m.type) {
		case "init":
			orgs = m.orgs;
			currentOrg = m.org;
			hasProject = m.hasProject;
			projectName = m.projectName ?? "";
			noOrg = orgs.length === 0;
			mergeUi((m.ui as UiState | null) ?? (api.getState() as UiState | null));
			($("search") as HTMLInputElement).value = ui.filter.query;
			applyWidths();
			renderOrgSelect();
			recompute();
			break;
		case "orgs":
			orgs = m.orgs;
			if (m.org !== undefined) currentOrg = m.org;
			noOrg = orgs.length === 0;
			renderOrgSelect();
			renderOverlay();
			break;
		case "reset":
			currentOrg = m.org;
			renderOrgSelect();
			resetData();
			break;
		case "loadStart":
			loading = { mode: m.mode, only: m.only, done: 0, total: 0, label: "" };
			errorView = null;
			// Re-listing over existing rows: buffer the new rows and swap them in at the end (no flicker, old rows stay usable).
			pending = (m.mode === "refresh" || m.mode === "types") && idx.comps.length > 0 ? [] : null;
			renderTop();
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
				else {
					appendToIndex(idx, comps);
					statusDirty = true;
				}
			}
			renderListed();
			if (!pending && comps.length) scheduleStreamRender();
			if (idx.comps.length === 0) renderOverlay();
			break;
		}
		case "loadEnd": {
			if (pending) {
				if (loading?.only) {
					const drop = new Set<string>(m.dropTypes ?? loading.only);
					const kept = idx.comps.filter((c) => !drop.has(c.t));
					idx = buildIndex(kept.concat(pending));
				} else {
					idx = buildIndex(pending);
				}
				pending = null;
			}
			loading = null;
			failures = m.failures ?? [];
			if (m.listedAt) listedAt = m.listedAt;
			if (Array.isArray(m.types) && m.types.length > 0) types = m.types;
			results = new Map();
			statusDirty = true;
			if (batchTimer) {
				window.clearTimeout(batchTimer);
				batchTimer = undefined;
			}
			// Drop selected rows that no longer exist.
			const have = new Set<string>();
			for (const c of idx.comps) have.add(c.t + ":" + c.n);
			for (const k of [...selected]) if (!have.has(k)) selected.delete(k);
			recompute();
			break;
		}
		case "loadError":
			loading = null;
			pending = null;
			errorView = { state: m.state, message: m.message };
			recompute();
			break;
		case "local":
			local = { keys: new Set<string>(m.keys), partial: new Set<string>(m.partial ?? []), retrieved: m.retrieved ?? {}, known: true };
			hasProject = m.hasProject;
			statusDirty = true;
			recompute();
			break;
		case "me":
			me = { ids: m.ids ?? [], name: m.name ?? "" };
			renderFacets();
			if (ui.filter.mine) recompute();
			break;
		case "retrieveResult": {
			retrieving = false;
			if (!m.cancelled) {
				results = new Map();
				for (const r of m.results as { key: string; ok: boolean; error?: string }[]) results.set(r.key, { ok: r.ok, error: r.error });
			}
			renderTop();
			invalidateRows();
			break;
		}
		case "toast":
			toast(m.text, m.kind);
			break;
	}
});

// Keep "Listed 2 h ago" and the relative modified times fresh.
window.setInterval(() => {
	renderListed();
	invalidateRows();
}, 60_000);

void projectName;
setupEvents();
applyWidths();
post({ command: "ready" });
