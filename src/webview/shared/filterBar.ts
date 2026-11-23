/**
 * Shared metadata filter bar for webviews (Org Browser, Deploy Metadata): the search box, the facet
 * groups (status, metadata type with counts, namespace, manageable state, modified) and their events.
 * The markup and CSS come from `src/utils/filterBarUi.ts`; the query grammar and matching from
 * `src/utils/orgBrowser/filter.ts`. A panel supplies its own status vocabulary through `statusOptions`
 * (and `FilterContext.vocab` for the matching), plus the callbacks below. One bar per webview: the
 * elements are found by their fixed ids.
 */
import { DEFAULT_FILTER, Facets, FilterState } from "../../utils/orgBrowser/filter";

export const REFRESH_ICON =
	'<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M13.500 8A5.500 5.500 0 112.800 5.800l-1.200-.5L2 4.400l3.600 1.200-.4 3.600-.9-.2.3-1.600A4.500 4.500 0 1012.500 8z"/></svg>';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const esc = (t: unknown) =>
	String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function toggleIn<T>(arr: T[], v: T): T[] {
	return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export interface StatusOption {
	/** Facet name (a name of the panel's status vocabulary). */
	value: string;
	label: string;
}

export interface FilterBarConfig {
	/** The panel's live filter. The bar mutates it in place; read it afresh every time. */
	filter(): FilterState;
	/** Facet counts of the last recompute (null until there are some). */
	facets(): Facets | null;
	/** Number of rows (a big list debounces the typing). */
	rowCount(): number;
	/** The status facet rows, in display order; the count of option i is `facets.status[i]`. */
	statusOptions: StatusOption[];
	/** Current user, for "Modified by me" (the checkbox is disabled until resolved). */
	me?(): { ids: string[]; name: string };
	/** A filter value changed: recompute (scrolled to the top) and persist. */
	onChange(): void;
	/** The refresh button of a type row. Omit to hide it. */
	onRefreshType?(type: string): void;
	/** Arrow-down in the search box: move to the list. */
	onSearchArrowDown?(): void;
	/** Paste into the search box; call `preventDefault` to take it over. */
	onSearchPaste?(e: ClipboardEvent, input: HTMLInputElement): void;
	/** Filter fields kept when "Clear all filters" is used (e.g. the "only selected" toggle). */
	preserveOnClear?(): Partial<FilterState>;
}

export interface FilterBar {
	/** Re-render the facet groups from `facets()`. */
	renderFacets(): void;
	/** Set the query text (the input follows); debounced for big lists unless `immediate`. */
	setQuery(q: string, immediate?: boolean): void;
	/** Show the filter's query in the search box (after the filter was replaced from outside). */
	syncSearchInput(): void;
	focusSearch(): void;
	clearAll(): void;
}

function facetRow(kind: string, value: string, label: string, count: number, checked: boolean, extra = ""): string {
	return (
		`<label class="frow${count === 0 && !checked ? " zero" : ""}" data-kind="${kind}" data-value="${esc(value)}">` +
		`<input type="checkbox" ${checked ? "checked" : ""}><span class="fl">${esc(label)}</span>${extra}<span class="fc">${count.toLocaleString()}</span></label>`
	);
}

export function createFilterBar(cfg: FilterBarConfig): FilterBar {
	let typeFilterText = "";
	let queryTimer: number | undefined;
	const search = $("search") as HTMLInputElement;
	const side = document.getElementById("side");

	function setQuery(q: string, immediate = false): void {
		cfg.filter().query = q;
		if (search.value !== q) search.value = q;
		if (immediate || cfg.rowCount() < 8000) {
			cfg.onChange();
		} else {
			window.clearTimeout(queryTimer);
			queryTimer = window.setTimeout(() => cfg.onChange(), 90);
		}
	}

	function clearAll(): void {
		const f = cfg.filter();
		Object.assign(f, { ...DEFAULT_FILTER, types: [], namespaces: [], states: [], status: [], from: undefined, to: undefined }, cfg.preserveOnClear?.() ?? {});
		search.value = "";
		cfg.onChange();
	}

	function renderFacets(): void {
		const facets = cfg.facets();
		if (!facets) return;
		const f = cfg.filter();

		// Status
		$("fStatus").innerHTML = cfg.statusOptions.map((o, i) => facetRow("status", o.value, o.label, facets.status[i] ?? 0, f.status.includes(o.value))).join("");

		// Types
		const names = new Set<string>(facets.types.keys());
		for (const t of f.types) names.add(t);
		const q = typeFilterText.trim().toLowerCase();
		const list = [...names].filter((t) => !q || t.toLowerCase().includes(q));
		list.sort((a, b) => (facets.types.get(b) ?? 0) - (facets.types.get(a) ?? 0) || a.localeCompare(b));
		$("typeList").innerHTML =
			list
				.map((t) =>
					facetRow(
						"type",
						t,
						t,
						facets.types.get(t) ?? 0,
						f.types.includes(t),
						`<button class="only" data-only="${esc(t)}" title="Show only ${esc(t)}">only</button>` +
							(cfg.onRefreshType ? `<button class="tref" data-tref="${esc(t)}" title="Re-list ${esc(t)} only">${REFRESH_ICON}</button>` : "")
					)
				)
				.join("") || '<div class="muted pad">No matching types</div>';
		$("typeCount").textContent = f.types.length ? `${f.types.length} selected` : "all";

		// Namespaces
		const fNs = document.getElementById("fNs");
		if (fNs) {
			const nsNames = [...facets.namespaces.keys()].filter((n) => n !== "").sort((a, b) => (facets.namespaces.get(b) ?? 0) - (facets.namespaces.get(a) ?? 0) || a.localeCompare(b));
			const unmanagedCount = facets.namespaces.get("") ?? 0;
			fNs.innerHTML =
				`<div class="chips"><button class="chip${f.nsMode === "all" ? " on" : ""}" data-ns="all">All</button>` +
				`<button class="chip${f.nsMode === "unmanaged" ? " on" : ""}" data-ns="unmanaged">Unmanaged only <span class="fc">${unmanagedCount.toLocaleString()}</span></button></div>` +
				nsNames.map((n) => facetRow("ns", n, n, facets.namespaces.get(n) ?? 0, f.nsMode === "specific" && f.namespaces.includes(n))).join("");
		}

		// Manageable state
		const fState = document.getElementById("fState");
		if (fState) {
			const stNames = [...facets.states.keys()].sort((a, b) => (facets.states.get(b) ?? 0) - (facets.states.get(a) ?? 0));
			fState.innerHTML = stNames.map((s) => facetRow("state", s, s || "(unknown)", facets.states.get(s) ?? 0, f.states.includes(s))).join("");
		}

		// Modified
		const fMine = document.getElementById("fMine") as HTMLInputElement | null;
		if (fMine) {
			const me = cfg.me?.() ?? { ids: [], name: "" };
			fMine.checked = f.mine;
			fMine.disabled = me.ids.length === 0 && !me.name;
			(fMine.parentElement as HTMLElement).title = me.ids.length === 0 && !me.name ? "Current user not resolved yet" : "";
			($("fWithin") as HTMLSelectElement).value = f.within;
			$("fCustom").hidden = f.within !== "custom";
			($("fFrom") as HTMLInputElement).value = f.from ? new Date(f.from).toISOString().slice(0, 10) : "";
			($("fTo") as HTMLInputElement).value = f.to ? new Date(f.to).toISOString().slice(0, 10) : "";
		}

		const activeCount =
			(f.types.length ? 1 : 0) + (f.nsMode !== "all" ? 1 : 0) + (f.states.length ? 1 : 0) + (f.status.length ? 1 : 0) + (f.mine ? 1 : 0) + (f.within !== "any" ? 1 : 0);
		$("clearFilters").hidden = activeCount === 0 && !f.query;
	}

	// ── Events ───────────────────────────────────────────────────────────────────
	search.addEventListener("input", () => setQuery(search.value));
	search.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && search.value) {
			setQuery("", true);
			e.stopPropagation();
		} else if (e.key === "ArrowDown" && cfg.onSearchArrowDown) {
			e.preventDefault();
			cfg.onSearchArrowDown();
		}
	});
	if (cfg.onSearchPaste) search.addEventListener("paste", (e) => cfg.onSearchPaste!(e, search));
	$("clearSearch").addEventListener("click", () => {
		setQuery("", true);
		search.focus();
	});
	$("clearFilters").addEventListener("click", clearAll);
	($("typeSearch") as HTMLInputElement).addEventListener("input", (e) => {
		typeFilterText = (e.target as HTMLInputElement).value;
		renderFacets();
	});

	// Facet groups (delegated)
	side?.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		const f = cfg.filter();
		const only = t.closest<HTMLElement>("[data-only]");
		if (only) {
			e.preventDefault();
			f.types = [only.dataset.only!];
			cfg.onChange();
			return;
		}
		const tref = t.closest<HTMLElement>("[data-tref]");
		if (tref) {
			e.preventDefault();
			cfg.onRefreshType?.(tref.dataset.tref!);
			return;
		}
		const ns = t.closest<HTMLElement>("[data-ns]");
		if (ns) {
			f.nsMode = ns.dataset.ns === "unmanaged" ? "unmanaged" : "all";
			f.namespaces = [];
			cfg.onChange();
			return;
		}
		const row = t.closest<HTMLElement>(".frow");
		if (row && t.tagName !== "INPUT") {
			// The label forwards the click to its checkbox; handle alt-click ("only this") here.
			if ((e as MouseEvent).altKey && row.dataset.kind === "type") {
				e.preventDefault();
				f.types = [row.dataset.value!];
				cfg.onChange();
			}
		}
	});
	side?.addEventListener("change", (e) => {
		const t = e.target as HTMLInputElement;
		const f = cfg.filter();
		const row = t.closest<HTMLElement>(".frow");
		if (row) {
			const v = row.dataset.value!;
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
					f.status = toggleIn(f.status, v);
					break;
			}
			cfg.onChange();
			return;
		}
		if (t.id === "fMine") {
			f.mine = t.checked;
		} else if (t.id === "fWithin") {
			f.within = (t as unknown as HTMLSelectElement).value as FilterState["within"];
		} else if (t.id === "fFrom" || t.id === "fTo") {
			const v = t.value;
			const ms = v ? Date.parse(v + (t.id === "fTo" ? "T23:59:59" : "T00:00:00")) : undefined;
			if (t.id === "fFrom") f.from = ms;
			else f.to = ms;
		} else return;
		cfg.onChange();
	});

	return {
		renderFacets,
		setQuery,
		syncSearchInput: () => {
			search.value = cfg.filter().query;
		},
		focusSearch: () => {
			search.focus();
			search.select();
		},
		clearAll,
	};
}
