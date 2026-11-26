/**
 * Markup and styles of the Deploy & Retrieve Metadata webview (src/webview/syncCenter.ts). The grid look is the
 * Org Browser's (`GRID_CSS`); the right-hand sections follow the Deploy panel. Theme colours only, through
 * VS Code variables.
 */
import { FILTER_BAR_VARS, filterGroupsMarkup, filterSearchMarkup } from "../utils/filterBarUi";
import { TEST_SUITE_CSS, testSuiteRowHtml } from "../utils/testSuitesHtml";
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

/** The Delete section's test levels: the Deploy section's labels where they exist; "Run Local Tests" instead of the relevant-tests level. */
function deleteLevels(o: SyncCenterHtmlOptions): { value: string; label: string }[] {
	const label = (v: string, d: string) => o.testLevels.find((t) => t.value === v)?.label ?? d;
	return [
		{ value: "NoTestRun", label: label("NoTestRun", "No Test Run") },
		{ value: "RunSpecifiedTests", label: label("RunSpecifiedTests", "Run Specified Tests") },
		{ value: "RunLocalTests", label: "Run Local Tests" },
		{ value: "RunAllTestsInOrg", label: label("RunAllTestsInOrg", "Run All Tests") },
	];
}

export function syncCenterHtml(o: SyncCenterHtmlOptions): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${o.csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Deploy &amp; Retrieve Metadata</title>
<style>
${GRID_CSS}
${PROJECT_SELECTOR_CSS}
.top .asfx-project { margin-left: 0; }
${CENTER_CSS}
${TEST_SUITE_CSS}
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
    <button id="cmpCancel" class="ghost" hidden title="Stop comparing contents">✕ Cancel</button>
    <button id="cmpBtn" class="primary" title="Compare the contents of the selected components with the org; without a selection, of the project components shown. Nothing is compared until you press this.">≈ Compare contents</button>
  </div>
  <div id="progress" class="progress" hidden role="progressbar" aria-label="Loading"><div id="progressBar"></div></div>
  <div id="banner"></div>
  <div class="body">
    <div class="left" id="left" data-side="auto">
      <div class="main">
        <aside id="side" aria-label="Filters">${filterGroupsMarkup({ statusTitle: "Status", state: false })}
        </aside>
        <section class="center">
          <div class="gridbar">
            <button id="filtersToggle" class="tbtn" title="Show/hide filters" aria-label="Show/hide filters" aria-expanded="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M1.5 2h13l-5 6v5.500l-3 1.500V8z"/></svg></button>
            <span id="countInfo" class="muted cnt"></span>
            <span class="spacer"></span>
            <button id="groupToggle" class="tbtn" title="Group by type" aria-label="Group by type" aria-pressed="false"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.300"><path d="M2 3.500h12M2 8h12M2 12.500h12"/><path d="M4.500 3.500v9" stroke-opacity=".0"/><rect x="2" y="2" width="5" height="3" fill="currentColor" stroke="none"/><rect x="2" y="7" width="5" height="3" fill="currentColor" stroke="none"/></svg></button>
            <button id="collapseAll" class="tbtn" title="Collapse all" aria-label="Collapse all" hidden><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.400" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/><path d="M4 2.500h8M4 13.500h8" stroke-opacity=".6"/></svg></button>
            <button id="colsBtn" class="tbtn" title="Columns: show, hide and reorder (also: right-click a column header)" aria-label="Columns" aria-haspopup="menu"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.300"><rect x="2" y="2.500" width="12" height="11" rx="1"/><path d="M6 2.500v11M10 2.500v11"/></svg></button>
          </div>
          <div id="selBanner" class="selbanner" role="status" hidden>
            <span id="selBannerText" class="sbt"></span>
            <button type="button" id="selBannerBack" class="linkbtn primary-link" title="Show all components again (Esc)">Back to all components</button>
            <button type="button" id="selBannerClear" class="linkbtn" title="Deselect everything and show all components">Clear selection</button>
            <button type="button" id="selBannerX" class="tbtn sm" title="Back to all components (Esc)" aria-label="Back to all components">×</button>
          </div>
          <div class="gridwrap">
            <div id="scroller" class="scroller" tabindex="0" role="grid" aria-label="Metadata components">
              <div class="inner">
                <div class="ghead" id="ghead" role="row">
                  <span class="hcell cb"><input type="checkbox" id="headCb" aria-label="Select all filtered rows" title="Select all filtered (0)"></span>
                  <span id="hcols" class="hcols"></span>
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
        <div id="opCard" class="opcard" role="status" aria-live="polite" hidden></div>

        <div class="modebar"><span class="choice mode" id="modeSeg" role="group" aria-label="Action"><button type="button" data-mode="deploy" class="on" aria-pressed="true" title="Deploy or validate components of the project to the org">Deploy</button><button type="button" data-mode="retrieve" aria-pressed="false" title="Retrieve components of the org into the project">Retrieve</button><button type="button" data-mode="delete" aria-pressed="false" title="Delete components that exist only in the org">Delete</button></span></div>

        <details class="sec" id="secPresets" open>
          <summary>Presets</summary>
          <div class="sec-body">
            <div class="field"><label class="field-label" for="presetSel">Preset</label>
              <div class="inline"><select id="presetSel"><option value="">— None —</option></select><button type="button" id="presetSave" class="ghost" title="Save the current selection and options as a preset (shared by every action)">Save preset</button></div>
            </div>
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
              ${testSuiteRowHtml()}
              <input type="text" id="test-search" placeholder="Search tests…" aria-label="Search test classes" />
              <div class="test-list" id="test-list"></div>
            </div>
            <div class="field"><label class="field-label" for="deployLabel">Deploy name (optional)</label>
              <input type="text" id="deployLabel" maxlength="120" placeholder="e.g. Sprint 42 hotfix" spellcheck="false" autocomplete="off" title="Shown in Local history. Local only: Salesforce has no deploy label.">
            </div>
            <label class="opt" title="Validate the deployment without saving changes to the org (check-only / dry run)"><input type="checkbox" id="validateOnly"><span>Validate only (dry run)<span class="sub">Check the deployment against the org without committing changes</span></span></label>
            <label class="opt" title="Skip selected components that are equal in the org and the project"><input type="checkbox" id="skipEqualDeploy" checked><span>Skip equal components</span></label>
            <label class="opt" title="Watch file saves and update the selection with the components Git reports as changed"><input type="checkbox" id="autoGit"><span>Auto-select Git changes<span class="sub">Watch file saves and add changed components to the selection</span></span></label>
            <button type="button" class="ghost" id="gitSelect" title="Select components changed in Git">⑂ Select changed (Git)</button>
            <div class="hint conflict-note" hidden></div>
            <button type="button" class="primary wide" id="deployBtn" disabled>Deploy (0)</button>
            <div class="selrow" data-selrow hidden><button type="button" class="linkbtn selsum" data-selsum></button><span class="selhid" data-selhid hidden> · <button type="button" class="linkbtn" data-hiddenshow title="Reset the filters and show only the selected components">show</button> · <button type="button" class="linkbtn" data-hiddenclear title="Deselect the selected components the current filter hides">clear hidden</button></span></div>
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
            <button type="button" class="ghost wide" id="retrieveProjectBtn" disabled title="Retrieve every component of the project that exists in the org">Retrieve project (0)</button>
            <div class="selrow" data-selrow hidden><button type="button" class="linkbtn selsum" data-selsum></button><span class="selhid" data-selhid hidden> · <button type="button" class="linkbtn" data-hiddenshow title="Reset the filters and show only the selected components">show</button> · <button type="button" class="linkbtn" data-hiddenclear title="Deselect the selected components the current filter hides">clear hidden</button></span></div>
            <div class="result-bar" id="retrieveResult"></div>
          </div>
        </details>

        <details class="sec danger" id="secDelete">
          <summary>Delete from org</summary>
          <div class="sec-body">
            <div class="hint">Deletes the selected components that exist only in the org (destructive deploy). Production orgs cannot use No Test Run and ask you to type the org alias.</div>
            <div class="field"><span class="field-label">Test level</span>
              <div class="radio-group" id="del-test-level">${deleteLevels(o).map((t) => `<label><input type="radio" name="delTestLevel" value="${t.value}"> ${t.label}</label>`).join("")}</div>
            </div>
            <div class="card" id="del-specified-tests-wrap">
              <div class="subtitle">Test classes</div>
              ${testSuiteRowHtml("", "del-")}
              <input type="text" id="del-test-search" placeholder="Search tests…" aria-label="Search test classes for the delete" />
              <div class="test-list" id="del-test-list"></div>
            </div>
            <div class="hint warn" id="delHint" hidden></div>
            <button type="button" class="danger-btn wide" id="deleteBtn" disabled>Delete from org (0)</button>
            <div class="selrow" data-selrow hidden><button type="button" class="linkbtn selsum" data-selsum></button><span class="selhid" data-selhid hidden> · <button type="button" class="linkbtn" data-hiddenshow title="Reset the filters and show only the selected components">show</button> · <button type="button" class="linkbtn" data-hiddenclear title="Deselect the selected components the current filter hides">clear hidden</button></span></div>
            <div class="result-bar" id="deleteResult"></div>
          </div>
        </details>
      </div>
      <div id="historyPane" class="history" hidden>
        <div class="hist-head">
          <span class="choice" role="group" aria-label="Deployment history view"><button type="button" id="segDeploys" class="on" aria-pressed="true" title="Recent deploys and validations of the org (merged with this project's history)">Deploys</button><button type="button" id="segHistory" aria-pressed="false" title="Deploys, validations, retrieves and deletes run by this extension on this machine">Local history</button></span>
          <span id="histCount" class="muted"></span><span class="spacer"></span><button type="button" id="histClose" class="linkbtn">Close</button>
        </div>
        <div id="depView" class="act-view">
          <div class="dep-bar">
            <button type="button" id="depRefresh" class="ghost sm" title="Reload the org's recent deploys">↻ Refresh</button>
            <button type="button" id="depFailed" class="ghost sm" aria-pressed="false" title="Only deploys that did not succeed">Failed only</button>
            <span id="depCount" class="muted"></span>
          </div>
          <div id="depNotice" class="dep-notice" hidden></div>
          <div id="depList" class="hist-list"></div>
        </div>
        <div id="histView" class="act-view" hidden>
          <div id="histList" class="hist-list"></div>
        </div>
      </div>
      <div class="rp-footer">
        <button type="button" class="tab" id="historyTab" aria-expanded="false" title="Recent deploys of the org, and the deploys, validations, retrieves and deletes of this project">Deployment history</button>
        <span id="statusLine" class="status-line" role="status"></span>
      </div>
    </div>
  </div>
</div>
<div id="menu" class="menu" role="menu" hidden></div>
<div id="colMenu" class="menu colmenu" role="menu" hidden></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
<script nonce="${o.nonce}">${o.selectorScript}</script>
</body>
</html>`;
}

const CENTER_CSS = `
:root {
  ${FILTER_BAR_VARS}
  --cols: 34px minmax(140px,1fr) 120px 70px 120px 90px 130px 250px;
  --minw: 964px;
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
.modebar { display: flex; }
.gridbar { flex-wrap: nowrap; gap: 6px; min-width: 0; }
.gridbar .cnt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.gridbar .spacer { flex: 1 1 0; min-width: 0; }
.tbtn { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
.tbtn:hover { background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 16%, transparent)); }
.tbtn[hidden] { display: none; }
.tbtn.on, .tbtn[aria-pressed="true"] { background: color-mix(in srgb, var(--ob-accent) 22%, transparent); }
.tbtn svg { display: block; }
.selbanner { display: flex; align-items: center; gap: 12px; flex-wrap: nowrap; padding: 3px 12px; font-size: 12px; flex-shrink: 0; color: var(--vscode-editorInfo-foreground, var(--vscode-foreground)); background: color-mix(in srgb, var(--vscode-editorInfo-foreground, var(--vscode-focusBorder)) 12%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorInfo-foreground, var(--vscode-focusBorder)) 35%, transparent); }
.selbanner[hidden] { display: none; }
.selbanner .sbt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selbanner .linkbtn { flex: 0 0 auto; white-space: nowrap; margin: 0; padding: 0; }
.selbanner .primary-link { font-weight: 600; }
.selbanner .tbtn { width: 20px; height: 20px; font-size: 16px; line-height: 1; }
.selrow { margin: 6px 0 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.selrow[hidden], .selhid[hidden] { display: none; }
.selrow .linkbtn { display: inline; margin: 0; padding: 0; }
.linkbtn.selsum { display: inline; margin: 0; padding: 0; font-size: 12px; text-align: left; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.linkbtn.selsum[hidden] { display: none; }
.choice.mode { width: 100%; }
.choice.mode button { flex: 1; height: 26px; font-size: 12px; font-weight: 600; }
.sec[hidden] { display: none; }
.row.dim { opacity: .42; }
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
.field input[type="text"] { width: 100%; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.4; }
.hint.conflict-note { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
.hint.conflict-note[hidden] { display: none; }
.hint.warn { color: var(--ob-warn); }
.hint.warn[hidden] { display: none; }
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
.hcols { display: contents; }
.hcell.dragging { opacity: .45; }
.hcell.drop-before::before, .hcell.drop-after::before { content: ""; position: absolute; top: 3px; bottom: 3px; width: 2px; background: var(--ob-accent); z-index: 2; }
.hcell.drop-before::before { left: 0; }
.hcell.drop-after::before { right: 0; }
.hcell[draggable="true"] { cursor: grab; }
/* The Actions cell is always visible (the shared grid CSS shows it on hover only). */
.row .c.acts, .row .acts { visibility: visible; align-items: center; justify-content: flex-start; gap: 2px; overflow: hidden; padding: 0 4px; }
.row .acts .ibtn { visibility: visible; flex-shrink: 0; color: var(--vscode-icon-foreground, var(--vscode-foreground)); opacity: .9; }
.row .acts .ibtn:hover { background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 16%, transparent)); opacity: 1; }
.row .acts .ibtn.deploy:hover { color: var(--ob-accent); }
.row .acts .ibtn.retrieve:hover { color: var(--ob-accent); }
.ibtn svg { display: block; }
.ibtn.ph { display: inline-block; width: 24px; height: 24px; flex-shrink: 0; }
.c.nm.ind { padding-left: 28px; }
.c.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
/* Refresh icon of a group row: readable at rest, hover background. */
.row.grp .gref { opacity: 1; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 4px; padding: 0; background: transparent; border: 0; cursor: pointer; opacity: 1; color: var(--vscode-icon-foreground, var(--vscode-foreground)); }
.row.grp:hover .gref, .row.grp .gref:hover { opacity: 1; }
.row.grp .gref:hover { background: var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 16%, transparent)); }
.gref svg { display: block; }
/* Loading: thin indeterminate bar under the top bar. */
.progress { position: relative; overflow: hidden; }
.progress.indet #progressBar { position: absolute; top: 0; bottom: 0; left: 0; width: 30%; transition: none; animation: asfx-indet 1.4s ease-in-out infinite; }
@keyframes asfx-indet { 0% { left: -30%; } 100% { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .progress.indet #progressBar { animation-duration: 3s; } }
.skel { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.skel i { display: block; height: 10px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); animation: asfx-pulse 1.4s ease-in-out infinite; }
@keyframes asfx-pulse { 50% { opacity: .45; } }
.colmenu { min-width: 220px; max-height: 70vh; overflow-y: auto; }
.colmenu label { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
.colmenu label:hover { background: var(--vscode-menu-selectionBackground, var(--ob-hover)); }
.colmenu label.fixed { opacity: .6; cursor: default; }
.colmenu hr { border: 0; border-top: 1px solid var(--ob-border); margin: 4px 0; }
.choice { display: inline-flex; border: 1px solid var(--ob-border-strong); border-radius: 999px; overflow: hidden; flex-shrink: 0; }
.choice button { width: auto; height: 20px; border-radius: 0; padding: 0 8px; font-size: 11px; opacity: .85; background: transparent; border: 0; }
.choice button:hover { background: var(--ob-hover); opacity: 1; }
.choice button.on { background: var(--asfx-accent); color: var(--vscode-button-foreground); opacity: 1; }
.ibtn.choicebtn.on { background: var(--asfx-accent); color: var(--vscode-button-foreground); opacity: 1; }
.ibtn.choicebtn .cl { font-size: 9px; font-weight: 700; margin-left: 1px; }
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
/* Operation card (top of the right panel) */
.opcard { border: 1px solid var(--ob-border); border-left: 3px solid var(--vscode-progressBar-background); border-radius: 6px; background: var(--asfx-card-bg); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; flex-shrink: 0; }
.opcard[hidden] { display: none; }
.opcard.done { border-left-color: var(--vscode-testing-iconPassed, var(--ob-ok)); }
.opcard.failed { border-left-color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); }
.opcard.cancelled { border-left-color: var(--vscode-disabledForeground, var(--ob-border-strong)); }
.op-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.op-kind { display: inline-flex; width: 16px; justify-content: center; font-weight: 700; flex-shrink: 0; }
.op-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-time { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
.op-x { background: transparent; border: 0; color: var(--vscode-icon-foreground, var(--vscode-foreground)); font-size: 15px; line-height: 1; padding: 0 4px; border-radius: 4px; cursor: pointer; }
.op-x:hover { background: var(--vscode-toolbar-hoverBackground, var(--ob-hover)); }
.op-badge { display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; height: 18px; border-radius: 999px; font-size: 10.5px; font-weight: 600; border: 1px solid var(--ob-border-strong); white-space: nowrap; }
.op-badge.running { color: var(--vscode-progressBar-background); border-color: currentColor; }
.op-badge.done { color: var(--vscode-testing-iconPassed, var(--ob-ok)); border-color: currentColor; }
.op-badge.failed { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); border-color: currentColor; }
.op-badge.cancelled, .op-badge.queued { color: var(--vscode-descriptionForeground); }
.op-spin { width: 9px; height: 9px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: asfx-spin .9s linear infinite; }
@keyframes asfx-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .op-spin { animation-duration: 3s; } }
.op-bar-label { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
.op-bar-label .bad { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); }
.op-track { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
.op-fill { background: var(--vscode-progressBar-background); transition: width .25s; }
.op-fill.err { background: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); }
.op-msg { color: var(--vscode-descriptionForeground); line-height: 1.4; overflow-wrap: anywhere; }
.opcard.failed .op-msg { color: var(--vscode-errorForeground, var(--ob-bad)); }
.op-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.op-actions button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, inherit); border: 1px solid var(--ob-border-strong); border-radius: 4px; padding: 2px 9px; font-size: 11.5px; }
.op-actions button:hover { background: var(--ob-hover); }
/* Activity: Deploys segment */
.history [hidden] { display: none !important; }
.act-view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.dep-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--ob-border); }
.dep-notice { padding: 6px 10px; font-size: 11.5px; color: var(--ob-warn); border-bottom: 1px solid var(--ob-border); line-height: 1.4; }
.dep-row { padding: 6px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.dep-row:hover { background: var(--ob-hover); }
.dep-l1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dep-l1 .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.dep-l2 { padding-left: 26px; color: var(--vscode-descriptionForeground); font-size: 11px; display: flex; flex-wrap: wrap; gap: 2px 10px; }
.dep-ic { display: inline-flex; width: 18px; justify-content: center; font-weight: 700; flex-shrink: 0; }
.dep-ic.ok { color: var(--vscode-testing-iconPassed, var(--ob-ok)); }
.dep-ic.bad { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); }
.dep-ic.run { color: var(--vscode-progressBar-background); }
.dep-chip { font-size: 10px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--ob-border-strong); color: var(--vscode-descriptionForeground); flex-shrink: 0; }
.dep-bad { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground, var(--ob-bad))); }
.dep-detail ul { margin: 0; padding-left: 16px; max-height: 180px; overflow-y: auto; }
.dep-detail li { margin: 2px 0; overflow-wrap: anywhere; }
.dep-detail .sub { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--vscode-descriptionForeground); }
.dep-detail pre { margin: 4px 0 0; padding: 4px 6px; max-height: 140px; overflow: auto; font-size: 11px; background: var(--vscode-textCodeBlock-background, transparent); border-radius: 4px; white-space: pre-wrap; }
.dep-detail summary { cursor: pointer; font-size: 11px; color: var(--vscode-descriptionForeground); }
@media (max-width: 900px) { .right { width: 300px; } }
`;
