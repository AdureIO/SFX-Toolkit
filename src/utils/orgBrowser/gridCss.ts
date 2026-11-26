/**
 * Shared look of the grid panels (Org Browser, Deploy & Retrieve Metadata): layout, grid, badges, menu, toast.
 * Colours come from VS Code theme variables only. A panel appends its own rules after `GRID_CSS`.
 */
import { FILTER_BAR_CSS, FILTER_BAR_VARS } from "../filterBarUi";

export const GRID_CSS = `
${FILTER_BAR_CSS}
*,*::before,*::after { box-sizing: border-box; }
:root {
  ${FILTER_BAR_VARS}
  --cols: 34px minmax(180px,1fr) 150px 90px 150px 120px 130px 132px;
  --minw: 986px;
}
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
#app { height: 100vh; display: flex; flex-direction: column; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 1px solid var(--ob-accent); outline-offset: 1px; }
.spacer { flex: 1; min-width: 8px; }
.top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--ob-border); flex-wrap: wrap; flex-shrink: 0; }
select, input[type="text"], input[type="date"] { height: 28px; padding: 0 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--ob-border)); border-radius: 4px; font: inherit; }
select { max-width: 240px; }
select:focus, input:focus { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; border-radius: 4px; height: 28px; padding: 0 14px; font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.ghost { background: transparent; border: 1px solid var(--ob-border); border-radius: 4px; height: 28px; padding: 0 10px; }
button.ghost:hover:not(:disabled) { background: var(--ob-hover); }
.selhidden { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 6px; white-space: nowrap; }
.selhidden .link { background: transparent; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; font: inherit; }
.selchip { display: inline-flex; align-items: center; border: 1px solid var(--ob-border-strong); border-radius: 999px; overflow: hidden; }
.selchip button { background: transparent; border: 0; padding: 3px 9px; }
.selchip button:hover { background: var(--ob-hover); }
.selchip.on { border-color: var(--ob-accent); background: color-mix(in srgb, var(--ob-accent) 16%, transparent); }
.progress { height: 2px; background: var(--ob-border); flex-shrink: 0; }
#progressBar { height: 100%; width: 0; background: var(--ob-accent); transition: width .2s; }
.bn { padding: 6px 12px; font-size: 12px; border-bottom: 1px solid var(--ob-border); }
.bn.err { background: color-mix(in srgb, var(--ob-bad) 14%, transparent); }
.bn.info { background: color-mix(in srgb, var(--ob-accent) 10%, transparent); }
.bn button { margin-left: 8px; }
.main { flex: 1; display: flex; min-height: 0; }
#side { width: 248px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--ob-border); background: var(--ob-surface); padding: 6px 10px 12px; }
.center { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.gridbar { display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-bottom: 1px solid var(--ob-border); font-size: 12px; flex-shrink: 0; }
.inl { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.gridwrap { position: relative; flex: 1; min-height: 0; }
.scroller { position: absolute; inset: 0; overflow: auto; outline: none; }
.inner { min-width: var(--minw); }
.ghead { position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: var(--cols); height: 30px; align-items: center; background: var(--vscode-editor-background); border-bottom: 1px solid var(--ob-border-strong); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
.hcell { position: relative; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: 100%; display: flex; align-items: center; user-select: none; }
.hcell[data-sort] { cursor: pointer; }
.hcell[data-sort]:hover { color: var(--vscode-foreground); }
.hcell.sorted { color: var(--vscode-foreground); }
.hcell.sorted[data-dir="asc"]::after { content: " \\25B2"; font-size: 9px; margin-left: 4px; }
.hcell.sorted[data-dir="desc"]::after { content: " \\25BC"; font-size: 9px; margin-left: 4px; }
.hcell.cb { justify-content: center; padding: 0; }
.grip { position: absolute; right: 0; top: 4px; bottom: 4px; width: 7px; cursor: col-resize; border-right: 1px solid var(--ob-border); }
.grip:hover { border-right: 2px solid var(--ob-accent); }
.vspacer { position: relative; }
.rowsEl { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.row { display: grid; grid-template-columns: var(--cols); height: 28px; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.row:hover { background: var(--ob-hover); }
.row.sel { background: color-mix(in srgb, var(--ob-accent) 14%, transparent); }
.row.active { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
.row.failed { box-shadow: inset 3px 0 0 var(--ob-bad); }
.c { padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c.cb { display: flex; justify-content: center; padding: 0; }
.c.nm { font-weight: 500; }
.c.ty, .c.ns, .c.by, .c.md { color: var(--vscode-descriptionForeground); }
mark { background: color-mix(in srgb, var(--ob-warn) 45%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--ob-border); }
.badge.none { color: var(--vscode-descriptionForeground); }
.badge.equal { color: var(--ob-ok); border-color: color-mix(in srgb, var(--ob-ok) 50%, transparent); }
.badge.partial { color: var(--ob-accent); border-color: color-mix(in srgb, var(--ob-accent) 50%, transparent); }
.badge.changed-org { color: var(--ob-warn); border-color: color-mix(in srgb, var(--ob-warn) 55%, transparent); background: color-mix(in srgb, var(--ob-warn) 12%, transparent); }
.badge.changed-local { color: var(--vscode-charts-blue, #3794ff); border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 55%, transparent); }
.badge.conflict { color: var(--ob-bad); border-color: color-mix(in srgb, var(--ob-bad) 60%, transparent); background: color-mix(in srgb, var(--ob-bad) 12%, transparent); }
.badge.unknown { color: var(--vscode-descriptionForeground); border-style: dashed; }
.badge.prov { border-style: dashed; opacity: .75; }
.res { font-weight: 700; cursor: help; }
.res.ok { color: var(--ob-ok); }
.res.bad { color: var(--ob-bad); }
.acts { display: flex; gap: 1px; padding: 0 4px; visibility: hidden; }
.row:hover .acts, .row.active .acts, .row:focus-within .acts { visibility: visible; }
.acts button { background: transparent; border: 0; border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; opacity: .8; }
.acts button:hover { background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent); opacity: 1; }
.row.grp { background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); cursor: pointer; font-weight: 600; }
.row.grp .gname { grid-column: 2 / -1; display: flex; align-items: center; gap: 8px; }
.chev { display: inline-flex; transition: transform .12s; opacity: .8; }
.chev.open { transform: rotate(90deg); }
.gcount { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 12px; }
.gref { background: transparent; border: 0; opacity: 0; width: 22px; height: 22px; border-radius: 4px; }
.row.grp:hover .gref { opacity: .8; }
.overlay { position: absolute; inset: 30px 0 0 0; display: flex; align-items: center; justify-content: center; z-index: 4; pointer-events: none; }
.overlay .card { pointer-events: auto; max-width: 440px; text-align: center; padding: 22px 26px; border: 1px solid var(--ob-border); border-radius: 10px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 8px 28px -10px rgba(0,0,0,.5); }
.overlay h3 { margin: 0 0 8px; }
.overlay p { margin: 0 0 14px; color: var(--vscode-descriptionForeground); }
.overlay .btns { display: flex; gap: 8px; justify-content: center; }
.overlay button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; height: 28px; padding: 0 14px; }
.overlay button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.failbox { border-top: 1px solid var(--ob-border); padding: 4px 12px; font-size: 12px; max-height: 180px; overflow: auto; flex-shrink: 0; }
.failbox summary { cursor: pointer; color: var(--ob-warn); }
.failbox ul { margin: 6px 0; padding-left: 18px; }
.menu { position: fixed; z-index: 20; min-width: 190px; padding: 4px; border: 1px solid var(--ob-border-strong); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 6px 22px rgba(0,0,0,.4); }
.menu[hidden] { display: none; }
.menu button { display: block; width: 100%; text-align: left; background: transparent; border: 0; padding: 5px 10px; border-radius: 4px; }
.menu button:hover, .menu button:focus { background: var(--vscode-menu-selectionBackground, var(--ob-hover)); color: var(--vscode-menu-selectionForeground, inherit); outline: none; }
.toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 8px 14px; border-radius: 6px; background: var(--vscode-editorWidget-background); border: 1px solid var(--ob-border-strong); box-shadow: 0 6px 22px rgba(0,0,0,.4); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .15s, transform .15s; z-index: 30; }
.toast.show { opacity: 1; transform: none; }
.toast.warn { border-color: var(--ob-warn); }
.toast.error { border-color: var(--ob-bad); }
@media (max-width: 760px) { #side { display: none; } }
@media (forced-colors: active) { .badge, .chip, .selchip { border-color: CanvasText; } }
`;
