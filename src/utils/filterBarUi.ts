/**
 * Host side of the shared metadata filter bar (search box + facet groups), used by
 * Deploy & Retrieve Metadata. Plain strings, no `vscode` import. The behaviour lives in
 * `src/webview/shared/filterBar.ts`; the query grammar and the matching in `orgBrowser/filter.ts`.
 *
 *   <style>${FILTER_BAR_CSS}</style>                         (once, in <head>)
 *   :root { ${FILTER_BAR_VARS} }                             (the colour tokens the CSS reads)
 *   ${filterSearchMarkup(placeholder)}                       (the search box)
 *   <aside id="side">${filterGroupsMarkup({...})}</aside>    (the facet groups; the container's layout is the panel's)
 */

/** Colour tokens read by `FILTER_BAR_CSS` (declare them in the panel's `:root`). */
export const FILTER_BAR_VARS = `
  --ob-border: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  --ob-border-strong: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
  --ob-surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --ob-hover: var(--vscode-list-hoverBackground);
  --ob-accent: var(--vscode-focusBorder, #4c8bf5);
  --ob-ok: var(--vscode-testing-iconPassed, #3fb950);
  --ob-bad: var(--vscode-errorForeground, #f14c4c);
  --ob-warn: var(--vscode-editorWarning-foreground, #d29922);`;

export const FILTER_BAR_CSS = `
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 6px 4px; }
button.linkbtn { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 0 4px; font-size: 12px; }
button.linkbtn:hover { text-decoration: underline; }
.search input, #side input[type="text"], #side input[type="date"], #side select { height: 28px; padding: 0 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--ob-border)); border-radius: 4px; font: inherit; }
.search input:focus, #side input:focus, #side select:focus { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
.search { position: relative; flex: 1 1 320px; min-width: 220px; max-width: 760px; }
.search input { width: 100%; padding-right: 26px; }
.search .x { position: absolute; right: 2px; top: 2px; height: 24px; width: 24px; border: 0; background: transparent; opacity: .6; font-size: 16px; line-height: 1; cursor: pointer; color: inherit; }
.search .x:hover { opacity: 1; }
.fgroup { padding: 8px 0 10px; border-bottom: 1px solid var(--ob-border); }
.fgroup:last-of-type { border-bottom: 0; }
.fgroup h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; align-items: baseline; }
#typeSearch { width: 100%; margin-bottom: 4px; height: 26px; }
.typelist { max-height: 280px; overflow-y: auto; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.frow, .frow2 { display: flex; align-items: center; gap: 6px; padding: 2px 2px; border-radius: 3px; cursor: pointer; min-height: 22px; }
.frow:hover { background: var(--ob-hover); }
.frow.zero { opacity: .5; }
.frow .fl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.frow .only, .frow .tref { visibility: hidden; border: 0; background: transparent; font-size: 11px; color: var(--vscode-textLink-foreground); padding: 0 3px; cursor: pointer; }
.frow .tref { opacity: .8; }
.frow:hover .only, .frow:hover .tref { visibility: visible; }
.frow input, .frow2 input { margin: 0; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.chip { background: transparent; border: 1px solid var(--ob-border-strong); border-radius: 999px; padding: 1px 9px; font-size: 12px; cursor: pointer; color: inherit; font: inherit; font-size: 12px; }
.chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.custom { display: flex; gap: 4px; margin-top: 4px; }
.custom input { flex: 1; min-width: 0; }
#fWithin { width: 100%; margin-top: 4px; }
`;

export function filterSearchMarkup(placeholder: string): string {
	return `<div class="search">
      <input id="search" type="text" spellcheck="false" autocomplete="off" aria-label="Search metadata"
        placeholder="${placeholder}">
      <button id="clearSearch" class="x" title="Clear (Esc)" aria-label="Clear search">×</button>
    </div>`;
}

export interface FilterGroupsOptions {
	/** Title of the status group ("Local status", "Status"). */
	statusTitle: string;
	namespace?: boolean;
	/** Manageable state (the org's view; not meaningful for local rows). */
	state?: boolean;
	/** "Modified by me" + modified-within. */
	modified?: boolean;
	/** "Modified by me" checkbox inside the modified group (needs the current user); default true. */
	mine?: boolean;
}

/** The facet groups: status, metadata type (searchable, with counts), and the optional namespace / state / modified groups. */
export function filterGroupsMarkup(o: FilterGroupsOptions): string {
	const ns = o.namespace !== false;
	const state = o.state !== false;
	const modified = o.modified !== false;
	return `
      <div class="fgroup"><h4>${o.statusTitle}</h4><div id="fStatus"></div></div>
      <div class="fgroup">
        <h4>Metadata type <span id="typeCount" class="muted"></span></h4>
        <input id="typeSearch" type="text" placeholder="Find a type…" spellcheck="false" autocomplete="off">
        <div id="typeList" class="typelist"></div>
        <div class="hint">Alt-click a type for “only this”</div>
      </div>${ns ? `
      <div class="fgroup"><h4>Namespace</h4><div id="fNs"></div></div>` : ""}${state ? `
      <div class="fgroup"><h4>Manageable state</h4><div id="fState"></div></div>` : ""}${modified ? `
      <div class="fgroup">
        <h4>Modified</h4>
        ${o.mine !== false ? `<label class="frow2"><input type="checkbox" id="fMine"> Modified by me</label>` : ""}
        <select id="fWithin" aria-label="Modified within">
          <option value="any">Any time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option><option value="custom">Custom range…</option>
        </select>
        <div id="fCustom" class="custom" hidden><input type="date" id="fFrom" aria-label="From"><input type="date" id="fTo" aria-label="To"></div>
      </div>` : ""}
      <button id="clearFilters" class="linkbtn" hidden>Clear all filters</button>`;
}
