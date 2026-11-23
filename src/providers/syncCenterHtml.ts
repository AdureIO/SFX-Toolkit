/**
 * Markup and styles of the Deploy & Retrieve Center webview (src/webview/syncCenter.ts). The grid look is the
 * Org Browser's (`GRID_CSS`); the right-hand sections follow the Deploy panel. Theme colours only, through
 * VS Code variables.
 */
import { FILTER_BAR_VARS, filterGroupsMarkup, filterSearchMarkup } from "../utils/filterBarUi";
import { GRID_CSS } from "../utils/orgBrowser/gridCss";
import { PROJECT_SELECTOR_CSS, projectSelectorMarkup } from "../utils/panelProjectUi";

export interface SyncCenterHtmlOptions {
	nonce: string;
	csp: string;
	scriptUri: string;
	testLevels: { value: string; label: string }[];
	/** `projectSelectorScript(...)` of the panel. */
	selectorScript: string;
}

export function syncCenterHtml(o: SyncCenterHtmlOptions): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${o.csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deploy &amp; Retrieve Center</title>
<style>
${GRID_CSS}
${PROJECT_SELECTOR_CSS}
.top .asfx-project { margin-left: 0; }
${CENTER_CSS}
</style>
</head>
<body>
<div id="app">
  <div class="top">
    ${projectSelectorMarkup()}
    <select id="org" aria-label="Org"></select>
    ${filterSearchMarkup("Search name or type…   type:ApexClass  status:conflict  status:local  by:smith  Acc*Handler   ( / )")}
    <span id="listedInfo" class="muted"></span>
    <button id="refreshBtn" class="ghost" title="Re-list every type from the org">↻ Refresh</button>
    <span id="cmpInfo" class="muted"></span>
    <button id="cmpBtn" class="ghost" title="Compare the contents of the components that are in the project with the org (the ones that need it; with a filter active: the shown ones again)">≈ Compare contents</button>
  </div>
  <div id="progress" class="progress" hidden><div id="progressBar"></div></div>
  <div id="banner"></div>
  <div class="body">
    <div class="left" id="left" data-side="auto">
      <div class="main">
        <aside id="side" aria-label="Filters">${filterGroupsMarkup({ statusTitle: "Status", state: false })}
        </aside>
        <section class="center">
          <div class="gridbar">
            <button id="filtersToggle" class="ghost sm" title="Show / hide the filter sidebar" aria-expanded="true">Filters</button>
            <span id="countInfo" class="muted"></span>
            <button id="selAll" class="linkbtn">Select all filtered (0)</button>
            <span id="selHidden" class="selhidden" hidden><span id="selHiddenText"></span> <button id="selHiddenShow" class="link" title="Reset the filters and show only the selected components">show</button> · <button id="selHiddenClear" class="link" title="Deselect the selected components the current filter hides">clear hidden</button></span>
            <span class="spacer"></span>
            <label class="inl"><input type="checkbox" id="groupToggle"> Group by type</label>
            <button id="collapseAll" class="linkbtn" title="Collapse / expand all groups">Collapse all</button>
          </div>
          <div class="gridwrap">
            <div id="scroller" class="scroller" tabindex="0" role="grid" aria-label="Metadata components">
              <div class="inner">
                <div class="ghead" role="row">
                  <span class="hcell cb"><input type="checkbox" id="headCb" aria-label="Select all filtered"></span>
                  <span class="hcell" data-sort="name">Name</span>
                  <span class="hcell" data-sort="type">Type<i class="grip" data-col="type"></i></span>
                  <span class="hcell" data-sort="ns">Namespace<i class="grip" data-col="ns"></i></span>
                  <span class="hcell" data-sort="by">Last modified by<i class="grip" data-col="by"></i></span>
                  <span class="hcell" data-sort="modified">Last modified<i class="grip" data-col="mod"></i></span>
                  <span class="hcell" data-sort="status">Status<i class="grip" data-col="status"></i></span>
                  <span class="hcell">Actions</span>
                </div>
                <div id="spacer" class="vspacer"><div id="rowsEl" class="rowsEl"></div></div>
              </div>
            </div>
            <div id="overlay" class="overlay" hidden></div>
          </div>
          <div id="failBox" class="failbox" hidden></div>
        </section>
      </div>
    </div>
    <div id="panelSplit" title="Drag to resize"><span></span></div>
    <div class="right" id="right">
      <div class="rp-body">
        <details class="sec" id="secSync" open>
          <summary>Sync</summary>
          <div class="sec-body">
            <div class="field"><label class="field-label" for="org2">Org</label><select id="org2"></select></div>
            <div class="field"><label class="field-label" for="presetSel">Preset</label>
              <div class="inline"><select id="presetSel"><option value="">— None —</option></select><button type="button" id="presetSave" class="ghost" title="Save the current selection and options as a preset (shared with the Deploy panel)">Save preset</button></div>
            </div>
            <div class="quick" id="quick">
              <button type="button" data-q="changedLocally"><span>Select changed locally</span><b></b></button>
              <button type="button" data-q="changedInOrg"><span>Select changed in org</span><b></b></button>
              <button type="button" data-q="allChanges"><span>Select all changes</span><b></b></button>
              <button type="button" data-q="onlyLocal"><span>Select only local</span><b></b></button>
              <button type="button" data-q="clear"><span>Clear</span><b id="selCount"></b></button>
            </div>
            <div class="hint">Quick actions add the shown (filtered) components to the selection.</div>
          </div>
        </details>

        <details class="sec" id="secDeploy" open>
          <summary>Deploy</summary>
          <div class="sec-body">
            <div class="field"><span class="field-label">Test level</span>
              <div class="radio-group" id="test-level">${o.testLevels.map((t) => `<label><input type="radio" name="testLevel" value="${t.value}"> ${t.label}</label>`).join("")}</div>
            </div>
            <div class="card" id="specified-tests-wrap">
              <div class="subtitle">Test classes</div>
              <input type="text" id="test-search" placeholder="Search tests…" aria-label="Search test classes" />
              <div class="test-list" id="test-list"></div>
            </div>
            <label class="opt" title="Validate the deployment without saving changes to the org (check-only / dry run)"><input type="checkbox" id="validateOnly"><span>Validate only (dry run)<span class="sub">Check the deployment against the org without committing changes</span></span></label>
            <label class="opt" title="Skip selected components that are equal in the org and the project"><input type="checkbox" id="skipEqualDeploy" checked><span>Skip equal components</span></label>
            <label class="opt" title="Watch file saves and update the selection with the components Git reports as changed"><input type="checkbox" id="autoGit"><span>Auto-select Git changes<span class="sub">Watch file saves and add changed components to the selection</span></span></label>
            <button type="button" class="ghost" id="gitSelect" title="Select components changed in Git">⑂ Select changed (Git)</button>
            <div class="hint conflict-note" hidden></div>
            <button type="button" class="primary wide" id="deployBtn" disabled>Deploy (0)</button>
            <div class="result-bar" id="deployResult"></div>
            <div id="coverage-panel" class="coverage-panel" style="display:none;"></div>
          </div>
        </details>

        <details class="sec" id="secRetrieve" open>
          <summary>Retrieve</summary>
          <div class="sec-body">
            <label class="opt" title="Ask before a retrieve overwrites local files that have unsaved or uncommitted changes"><input type="checkbox" id="confirmOverwrite" checked><span>Confirm before overwriting local changes</span></label>
            <label class="opt" title="Off: a selected field, record type … is retrieved on its own. On: its whole object is retrieved."><input type="checkbox" id="wholeObject"><span>Retrieve the whole object when a child is selected<span class="sub">Off: children only</span></span></label>
            <label class="opt" title="Skip selected components that are equal in the org and the project"><input type="checkbox" id="skipEqualRetrieve" checked><span>Skip equal components</span></label>
            <div class="hint conflict-note" hidden></div>
            <button type="button" class="primary wide" id="retrieveBtn" disabled>Retrieve (0)</button>
            <div class="result-bar" id="retrieveResult"></div>
          </div>
        </details>

        <details class="sec danger" id="secDelete">
          <summary>Delete from org</summary>
          <div class="sec-body">
            <div class="hint">Deletes the selected components that exist only in the org (destructive deploy). Uses the test level of the Deploy section. Production orgs ask you to type the org alias.</div>
            <button type="button" class="danger-btn wide" id="deleteBtn" disabled>Delete from org (0)</button>
            <div class="result-bar" id="deleteResult"></div>
          </div>
        </details>
      </div>
      <div id="historyPane" class="history" hidden>
        <div class="hist-head"><b>History</b><span id="histCount" class="muted"></span><span class="spacer"></span><button type="button" id="histClose" class="linkbtn">Close</button></div>
        <div id="histList" class="hist-list"></div>
      </div>
      <div class="rp-footer">
        <button type="button" class="tab" id="historyTab" aria-expanded="false" title="Deploys, validations, retrieves and deletes of this project">History</button>
        <span id="statusLine" class="status-line" role="status"></span>
      </div>
    </div>
  </div>
</div>
<div id="menu" class="menu" role="menu" hidden></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
<script nonce="${o.nonce}">${o.selectorScript}</script>
</body>
</html>`;
}

const CENTER_CSS = `
:root {
  ${FILTER_BAR_VARS}
  --cols: 34px minmax(140px,1fr) 120px 70px 120px 90px 130px 176px;
  --minw: 880px;
  --asfx-card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-inactiveSelectionBackground));
  --asfx-accent: var(--vscode-button-background);
  --ob-only-local: var(--vscode-charts-purple, #b180d7);
}
.body { flex: 1; display: flex; min-height: 0; }
.left { flex: 1; min-width: 360px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.left .main { flex: 1; display: flex; min-height: 0; }
.left[data-side="closed"] #side, .left[data-side="auto"][data-narrow] #side { display: none; }
.left[data-side="open"] #side, .left[data-side="auto"]:not([data-narrow]) #side { display: block; }
#panelSplit { flex: 0 0 7px; cursor: col-resize; display: flex; justify-content: center; align-items: stretch; }
#panelSplit span { width: 3px; border-radius: 2px; background: var(--ob-border); transition: background .12s; }
#panelSplit:hover span { background: var(--ob-accent); }
.right { width: 360px; min-width: 300px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-left: 1px solid var(--ob-border); background: var(--vscode-editor-background); }
.rp-body { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.rp-footer { flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-top: 1px solid var(--ob-border); background: var(--ob-surface); font-size: 12px; }
.status-line { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.tab { background: transparent; border: 1px solid var(--ob-border-strong); border-radius: 4px; padding: 2px 10px; }
.tab:hover { background: var(--ob-hover); }
.tab[aria-expanded="true"] { background: var(--asfx-accent); color: var(--vscode-button-foreground); border-color: transparent; }
button.ghost.sm { height: 24px; padding: 0 8px; font-size: 12px; }
button.ghost.sm.on { background: color-mix(in srgb, var(--ob-accent) 16%, transparent); }
.sec { border: 1px solid var(--ob-border); border-radius: 6px; background: var(--asfx-card-bg); }
.sec > summary { cursor: pointer; padding: 8px 12px; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; user-select: none; }
.sec[open] > summary { border-bottom: 1px solid var(--ob-border); }
.sec-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.sec.danger { border-color: color-mix(in srgb, var(--ob-bad) 55%, transparent); }
.sec.danger > summary { color: var(--ob-bad); }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); }
.field select { width: 100%; max-width: none; }
.inline { display: flex; gap: 6px; }
.inline select { flex: 1; min-width: 0; }
.radio-group { display: flex; flex-wrap: wrap; gap: 6px; }
.radio-group label { margin: 0; cursor: pointer; display: inline-flex; align-items: center; padding: 3px 10px; border-radius: 999px; font-size: 11px; border: 1px solid var(--ob-border-strong); background: var(--vscode-input-background); user-select: none; }
.radio-group label:hover { background: var(--ob-hover); border-color: var(--ob-accent); }
.radio-group label:has(input:checked) { background: var(--asfx-accent); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
.radio-group input[type="radio"] { display: none; }
.card { border: 1px solid var(--ob-border); border-radius: 6px; padding: 8px; display: none; flex-direction: column; gap: 6px; }
.card.visible { display: flex; }
.card .subtitle { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); }
.card input[type="text"] { width: 100%; }
.test-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--vscode-input-border, var(--ob-border)); border-radius: 4px; padding: 6px; background: var(--vscode-input-background); }
.test-list .tree-node { margin: 1px 0; }
.test-list .folder-row, .test-list .package-row, .test-list .file-node { display: flex; align-items: center; gap: 7px; padding: 2px 5px; border-radius: 4px; cursor: pointer; }
.test-list .folder-row:hover, .test-list .package-row:hover, .test-list .file-node:hover { background: var(--ob-hover); }
.test-list .row-label { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; cursor: pointer; }
.test-list .node-children, .test-list .package-children { margin-left: 18px; }
.test-list .btn-toggle { background: transparent; border: 0; opacity: .6; }
.opt { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; cursor: pointer; user-select: none; line-height: 1.4; }
.opt input { margin: 2px 0 0; flex-shrink: 0; accent-color: var(--asfx-accent); }
.opt .sub { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
button.wide { width: 100%; height: 30px; }
button.danger-btn { background: var(--ob-bad); color: var(--vscode-button-foreground, #fff); border: 1px solid transparent; border-radius: 4px; font-weight: 600; }
button.danger-btn:hover:not(:disabled) { filter: brightness(1.1); }
.quick { display: flex; flex-direction: column; gap: 4px; }
.quick button { display: flex; justify-content: space-between; align-items: center; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--ob-border-strong); border-radius: 4px; padding: 4px 10px; font-size: 12px; text-align: left; }
.quick button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--ob-hover)); }
.quick button b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
.hint.conflict-note { color: var(--ob-bad); }
.hint.conflict-note[hidden] { display: none; }
.result-bar { display: none; padding: 8px 10px; font-size: 12px; border-radius: 4px; border: 1px solid var(--ob-border); border-left: 3px solid transparent; line-height: 1.5; }
.result-bar.running { border-left-color: var(--vscode-progressBar-background); }
.result-bar.success { border-left-color: var(--ob-ok); background: color-mix(in srgb, var(--ob-ok) 12%, transparent); }
.result-bar.failure { border-left-color: var(--ob-bad); background: color-mix(in srgb, var(--ob-bad) 12%, transparent); }
.coverage-panel { border: 1px solid var(--ob-border); border-radius: 6px; overflow: hidden; }
.coverage-toggle { padding: 7px 10px; font-size: 12px; cursor: pointer; display: flex; gap: 6px; font-weight: 600; }
.coverage-toggle:hover { background: var(--ob-hover); }
.cov-chev { margin-left: auto; opacity: .55; font-size: 10px; }
.coverage-list { padding: 2px 8px 8px; }
.cov-row { display: flex; justify-content: space-between; padding: 2px 6px; font-size: 11.5px; }
.cov-name { font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.cov-pct { font-weight: 700; margin-left: 10px; font-variant-numeric: tabular-nums; }
.cov-green { color: var(--ob-ok); }
.cov-amber { color: var(--ob-warn); }
.cov-red { color: var(--ob-bad); }
.badge.only-local { color: var(--ob-only-local); border-color: color-mix(in srgb, var(--ob-only-local) 55%, transparent); }
.badge.only-org { color: var(--vscode-descriptionForeground); }
.acts { visibility: visible; align-items: center; gap: 4px; overflow: hidden; }
.acts .ibtn { visibility: hidden; }
.row:hover .acts .ibtn, .row.active .acts .ibtn, .row:focus-within .acts .ibtn { visibility: visible; }
.choice { display: inline-flex; border: 1px solid var(--ob-border-strong); border-radius: 999px; overflow: hidden; flex-shrink: 0; }
.choice button { width: auto; height: 20px; border-radius: 0; padding: 0 8px; font-size: 11px; opacity: .85; background: transparent; border: 0; }
.choice button:hover { background: var(--ob-hover); opacity: 1; }
.choice button.on { background: var(--asfx-accent); color: var(--vscode-button-foreground); opacity: 1; }
.choice.need { border-color: var(--ob-bad); }
.history { flex-shrink: 0; max-height: 46%; display: flex; flex-direction: column; border-top: 1px solid var(--ob-border); background: var(--ob-surface); }
.hist-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--ob-border); font-size: 12px; }
.hist-list { overflow-y: auto; flex: 1; min-height: 0; }
.hist-item { border-bottom: 1px solid var(--ob-border); font-size: 12px; }
.hist-line { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; }
.hist-line:hover { background: var(--ob-hover); }
.hist-kind { display: inline-flex; width: 18px; justify-content: center; font-weight: 700; }
.hist-org { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-meta { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.hist-ok { font-weight: 700; color: var(--ob-ok); }
.hist-bad { font-weight: 700; color: var(--ob-bad); }
.hist-detail { padding: 4px 10px 10px 36px; display: flex; flex-direction: column; gap: 6px; }
.hist-detail ul { margin: 0; padding-left: 16px; max-height: 140px; overflow-y: auto; }
.hist-detail .err { color: var(--ob-bad); }
.hist-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.hist-actions button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--ob-border-strong); border-radius: 4px; padding: 2px 9px; font-size: 11.5px; }
.hist-actions button:hover { background: var(--ob-hover); }
.selhidden { margin: 0; }
@media (max-width: 900px) { .right { width: 300px; } }
`;
