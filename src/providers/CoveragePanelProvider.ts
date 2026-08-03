import * as vscode from "vscode";
import { apexCoverage, clearApexTestResults, COVERAGE_THRESHOLD, CoverageRecord } from "../utils/apexCoverageService";
import { categorizeError, Telemetry } from "../utils/telemetry";

/**
 * Structured, refreshable Apex coverage dashboard: org-wide coverage, a worst-first
 * table of every class/trigger, search, a below-threshold filter, and click-to-open.
 * Shares data with the Explorer badges via the coverage service.
 */
export class CoveragePanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.coveragePanel";
  private static _panel: vscode.WebviewPanel | undefined;

  public static async show(): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CoveragePanelProvider._panel) {
      CoveragePanelProvider._panel.reveal(column);
      await this.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(CoveragePanelProvider.viewType, "Apex Coverage", column, {
      enableScripts: true
    });
    CoveragePanelProvider._panel = panel;
    panel.webview.html = this.getHtml();
    const listener = panel.webview.onDidReceiveMessage(async (msg: { command: string; name?: string }) => {
      if (msg.command === "refresh") await this.load(true);
      else if (msg.command === "open" && msg.name) await this.openApexFile(msg.name);
      else if (msg.command === "clear") await this.clear();
    });
    // Re-query when the panel is re-focused (e.g. after a test run elsewhere), throttled.
    const viewState = panel.onDidChangeViewState((e) => {
      const stale = Date.now() - (apexCoverage.loadedAt ?? 0) > 4000;
      if (e.webviewPanel.active && stale) void this.load();
    });
    panel.onDidDispose(() => {
      listener.dispose();
      viewState.dispose();
      CoveragePanelProvider._panel = undefined;
    });
    await this.load();
  }

  /** Refresh the shared store and repaint the panel if open. Used by the standalone refresh command too. */
  public static async refreshData(): Promise<void> {
    if (CoveragePanelProvider._panel) {
      await this.load(true);
    } else {
      try {
        await apexCoverage.refresh();
      } catch {
        /* silent for background refresh */
      }
    }
  }

  private static async load(userInitiated = false): Promise<void> {
    const panel = CoveragePanelProvider._panel;
    if (!panel) return;
    panel.webview.postMessage({ command: "loading" });
    try {
      const found = await apexCoverage.refresh();
      if (!found) {
        panel.webview.postMessage({
          command: "empty",
          message: "No Apex coverage found. Run your Apex tests first — coverage is only available after a test run."
        });
        return;
      }
      panel.webview.postMessage({
        command: "data",
        overall: apexCoverage.overall(),
        loadedAt: apexCoverage.loadedAt,
        threshold: COVERAGE_THRESHOLD,
        records: apexCoverage.all().map((r: CoverageRecord) => ({
          name: r.name,
          percent: r.percent,
          covered: r.covered,
          uncovered: r.uncovered,
          total: r.total
        }))
      });
    } catch (error) {
      panel.webview.postMessage({
        command: "empty",
        message:
          "Couldn't load Apex coverage. Make sure a default org is set and your tests have run. (" +
          categorizeError(error) +
          ")"
      });
    }
    if (userInitiated) Telemetry.event("apexCoverage", { status: "panel-refresh" });
  }

  /** Clear local test results + coverage, then blank the panel (no re-query). */
  private static async clear(): Promise<void> {
    const panel = CoveragePanelProvider._panel;
    const ok = await vscode.window.showWarningMessage(
      "Delete all local Apex test results (.sfdx/tools/testresults) and clear coverage?",
      { modal: true },
      "Clear"
    );
    if (ok !== "Clear") return;
    const removed = await clearApexTestResults();
    vscode.window.showInformationMessage(`Cleared Apex test results (${removed} item${removed === 1 ? "" : "s"}) and coverage.`);
    panel?.webview.postMessage({ command: "empty", message: "Coverage cleared. Run your Apex tests to regenerate it." });
  }

  private static async openApexFile(name: string): Promise<void> {
    let files = await vscode.workspace.findFiles(`**/${name}.cls`, undefined, 1);
    if (files.length === 0) files = await vscode.workspace.findFiles(`**/${name}.trigger`, undefined, 1);
    if (files.length > 0) {
      await vscode.window.showTextDocument(files[0]);
    } else {
      vscode.window.showInformationMessage(`Couldn't find a source file for ${name}.`);
    }
  }

  private static getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        * { box-sizing: border-box; }
        body { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
        h2 { margin: 0 0 12px 0; font-weight: 600; }
        .summary { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
        .card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; padding: 10px 14px; min-width: 120px; }
        .card .label { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.04em; }
        .card .val { font-size: 22px; font-weight: 600; margin-top: 2px; }
        .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
        input[type="search"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); padding: 5px 8px; font-size: 12px; border-radius: 4px; width: 260px; }
        input[type="search"]:focus { outline: 1px solid var(--vscode-focusBorder); }
        .chk { display: inline-flex; gap: 5px; align-items: center; color: var(--vscode-descriptionForeground); }
        button { padding: 5px 10px; font-size: 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
        button:hover { opacity: 0.9; }
        .spacer { flex: 1; }
        .loaded { color: var(--vscode-descriptionForeground); font-size: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 6px 12px; border-top: 1px solid var(--vscode-widget-border); }
        th { color: var(--vscode-descriptionForeground); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; user-select: none; }
        th.num, td.num { text-align: right; }
        tr.row { cursor: pointer; }
        tr.row:hover td { background: var(--vscode-list-hoverBackground); }
        .name { color: var(--vscode-textLink-foreground); }
        .bar { display: inline-block; width: 90px; height: 6px; border-radius: 3px; background: var(--vscode-widget-border); vertical-align: middle; margin-right: 8px; overflow: hidden; }
        .bar > span { display: block; height: 100%; }
        .pct { font-variant-numeric: tabular-nums; }
        .pass { color: var(--vscode-charts-green, #3fb950); }
        .fail { color: var(--vscode-charts-red, #f85149); }
        .status { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <h2>Apex Coverage</h2>
    <div class="summary" id="summary"></div>
    <div class="toolbar">
        <input id="search" type="search" placeholder="Filter classes…" autocomplete="off">
        <label class="chk"><input type="checkbox" id="belowOnly"> Below threshold only</label>
        <div class="spacer"></div>
        <span class="loaded" id="loaded"></span>
        <button id="refresh">Refresh</button>
        <button id="clear">Clear results</button>
    </div>
    <div id="content"><div class="status">Loading…</div></div>
    <script>
        const vscode = acquireVsCodeApi();
        const summaryEl = document.getElementById('summary');
        const contentEl = document.getElementById('content');
        const loadedEl = document.getElementById('loaded');
        const searchEl = document.getElementById('search');
        const belowOnly = document.getElementById('belowOnly');
        let records = [];
        let threshold = 75;
        let sortKey = 'percent';
        let sortDir = 1; // 1 = asc (worst first for percent)

        const esc = (t) => (t == null ? '' : String(t)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        const barColor = (p) => p >= threshold ? 'var(--vscode-charts-green, #3fb950)' : 'var(--vscode-charts-red, #f85149)';

        function renderSummary(o) {
            summaryEl.innerHTML =
                '<div class="card"><div class="label">Org coverage</div><div class="val ' + (o.percent >= threshold ? 'pass' : 'fail') + '">' + o.percent + '%</div></div>' +
                '<div class="card"><div class="label">Classes</div><div class="val">' + o.classes + '</div></div>' +
                '<div class="card"><div class="label">Below ' + threshold + '%</div><div class="val ' + (o.below ? 'fail' : 'pass') + '">' + o.below + '</div></div>' +
                '<div class="card"><div class="label">Lines covered</div><div class="val">' + o.covered.toLocaleString() + ' / ' + o.total.toLocaleString() + '</div></div>';
        }

        function renderTable() {
            const q = searchEl.value.trim().toLowerCase();
            let rows = records.filter(r => !q || r.name.toLowerCase().includes(q));
            if (belowOnly.checked) rows = rows.filter(r => r.percent < threshold);
            rows.sort((a,b) => {
                let d;
                if (sortKey === 'name') d = a.name.localeCompare(b.name);
                else d = (a[sortKey] - b[sortKey]);
                return d * sortDir;
            });
            if (!rows.length) { contentEl.innerHTML = '<div class="status">No matching classes.</div>'; return; }
            const arrow = (k) => sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
            contentEl.innerHTML =
                '<table><thead><tr>' +
                    '<th data-sort="name">Class / Trigger' + arrow('name') + '</th>' +
                    '<th data-sort="percent">Coverage' + arrow('percent') + '</th>' +
                    '<th class="num" data-sort="covered">Covered' + arrow('covered') + '</th>' +
                    '<th class="num" data-sort="uncovered">Uncovered' + arrow('uncovered') + '</th>' +
                '</tr></thead><tbody>' +
                rows.map(r =>
                    '<tr class="row" data-name="' + esc(r.name) + '">' +
                        '<td><span class="name">' + esc(r.name) + '</span></td>' +
                        '<td><span class="bar"><span style="width:' + r.percent + '%;background:' + barColor(r.percent) + '"></span></span>' +
                            '<span class="pct ' + (r.percent >= threshold ? 'pass' : 'fail') + '">' + r.percent + '%</span></td>' +
                        '<td class="num">' + r.covered + '</td>' +
                        '<td class="num">' + r.uncovered + '</td>' +
                    '</tr>'
                ).join('') +
                '</tbody></table>';
            contentEl.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
                const k = th.getAttribute('data-sort');
                if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'name') ? 1 : 1; }
                renderTable();
            }));
            contentEl.querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () => vscode.postMessage({ command: 'open', name: tr.getAttribute('data-name') })));
        }

        searchEl.addEventListener('input', renderTable);
        belowOnly.addEventListener('change', renderTable);
        document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
        document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ command: 'clear' }));

        window.addEventListener('message', e => {
            const m = e.data || {};
            if (m.command === 'loading') { contentEl.innerHTML = '<div class="status">Loading…</div>'; }
            else if (m.command === 'empty') { summaryEl.innerHTML = ''; loadedEl.textContent = ''; contentEl.innerHTML = '<div class="status">' + esc(m.message) + '</div>'; }
            else if (m.command === 'data') {
                records = m.records || [];
                threshold = m.threshold || 75;
                renderSummary(m.overall);
                loadedEl.textContent = m.loadedAt ? 'Loaded ' + new Date(m.loadedAt).toLocaleTimeString() : '';
                renderTable();
            }
        });
    </script>
</body>
</html>`;
  }
}
