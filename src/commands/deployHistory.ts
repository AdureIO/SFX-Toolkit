import * as vscode from 'vscode';
import { Telemetry } from '../utils/telemetry';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeployHistoryEntry {
  id: string;
  timestamp: number;          // epoch ms
  status: 'Succeeded' | 'Failed' | 'Cancelled';
  dryRun: boolean;
  components: number;
  componentErrors: number;
  testsPassed: number;
  testsFailed: number;
  durationMs: number;
  targetOrg: string;
  sourcePaths: string[];      // relative paths passed to CLI
  presetName?: string | null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const HISTORY_KEY = 'adure-sfx-toolkit.deployHistory';
const MAX_ENTRIES = 50;

let _ctx: vscode.ExtensionContext | null = null;
/** Call once from activate() before any history operations. */
export function initDeployHistory(context: vscode.ExtensionContext): void {
  _ctx = context;
}

export function addDeployHistoryEntry(entry: Omit<DeployHistoryEntry, 'id'>): void {
  // Anonymous deploy outcome telemetry (categorical + numeric only; no org/paths).
  Telemetry.event(
    "deploy",
    { status: entry.status, dryRun: String(entry.dryRun) },
    {
      durationMs: entry.durationMs,
      components: entry.components,
      componentErrors: entry.componentErrors,
      testsPassed: entry.testsPassed,
      testsFailed: entry.testsFailed
    }
  );

  if (!_ctx) return;
  const existing: DeployHistoryEntry[] = _ctx.globalState.get(HISTORY_KEY, []);
  const newEntry: DeployHistoryEntry = {
    id: `${entry.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    ...entry
  };
  void _ctx.globalState.update(HISTORY_KEY, [newEntry, ...existing].slice(0, MAX_ENTRIES));
}

export function getDeployHistory(): DeployHistoryEntry[] {
  return _ctx?.globalState.get<DeployHistoryEntry[]>(HISTORY_KEY, []) ?? [];
}

function clearHistory(): void {
  if (!_ctx) return;
  void _ctx.globalState.update(HISTORY_KEY, []);
}

// ─── Re-deploy callback (set from extension.ts to avoid circular import) ──────

let _openDeployPanel: ((entry: DeployHistoryEntry) => void) | null = null;
export function setOpenDeployPanelCallback(cb: (entry: DeployHistoryEntry) => void): void {
  _openDeployPanel = cb;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class DeployHistoryProvider {
  public static async show(): Promise<void> {
    const entries = getDeployHistory();
    const panel = vscode.window.createWebviewPanel(
      'adure-sfx-toolkit.deployHistory',
      'Deployment History',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = DeployHistoryProvider.getHtml(entries);

    panel.webview.onDidReceiveMessage((msg: { command: string; entryId?: string }) => {
      if (msg.command === 'clearHistory') {
        clearHistory();
        panel.webview.html = DeployHistoryProvider.getHtml([]);
      }
      if (msg.command === 'redeploy' && msg.entryId) {
        const entry = getDeployHistory().find((e) => e.id === msg.entryId);
        if (entry && _openDeployPanel) {
          _openDeployPanel(entry);
        }
      }
    });
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private static relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  private static fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  private static escHtml(s: string): string {
    return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private static renderEntry(e: DeployHistoryEntry): string {
    const icon = e.status === 'Succeeded' ? '✅' : e.status === 'Cancelled' ? '🚫' : '❌';
    const label = e.dryRun
      ? (e.status === 'Succeeded' ? 'Validation passed' : e.status === 'Cancelled' ? 'Validation cancelled' : 'Validation failed')
      : (e.status === 'Succeeded' ? 'Deploy succeeded' : e.status === 'Cancelled' ? 'Deploy cancelled' : 'Deploy failed');

    const metaParts: string[] = [];
    if (e.components > 0) metaParts.push(`${e.components} component${e.components !== 1 ? 's' : ''}`);
    if (e.componentErrors > 0) metaParts.push(`<span class="err">${e.componentErrors} error${e.componentErrors !== 1 ? 's' : ''}</span>`);
    if (e.testsPassed > 0 || e.testsFailed > 0) {
      const tParts = [`${e.testsPassed} passed`];
      if (e.testsFailed > 0) tParts.push(`<span class="err">${e.testsFailed} failed</span>`);
      metaParts.push('Tests: ' + tParts.join(', '));
    }
    metaParts.push(DeployHistoryProvider.fmtDuration(e.durationMs));
    if (e.targetOrg) metaParts.push(`<span class="dim">${DeployHistoryProvider.escHtml(e.targetOrg)}</span>`);
    if (e.presetName) metaParts.push(`<span class="dim">preset: ${DeployHistoryProvider.escHtml(e.presetName)}</span>`);

    const pathsHtml = e.sourcePaths.length > 0
      ? `<span class="paths-toggle" data-count="${e.sourcePaths.length}">Show ${e.sourcePaths.length} path${e.sourcePaths.length !== 1 ? 's' : ''}</span>
         <div class="paths-list">${e.sourcePaths.map((p) => `<div>${DeployHistoryProvider.escHtml(p)}</div>`).join('')}</div>`
      : '';

    const redeployBtn = e.status !== 'Cancelled'
      ? `<button class="btn-redeploy" data-id="${DeployHistoryProvider.escHtml(e.id)}" title="Open Deploy panel with these paths pre-selected">Re-deploy</button>`
      : '';

    const absTime = new Date(e.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

    return `<div class="entry" data-id="${DeployHistoryProvider.escHtml(e.id)}">
      <div class="entry-header">
        <span class="entry-status">${icon}</span>
        <span class="entry-label">${label}</span>
        <span class="entry-time" title="${absTime}">${DeployHistoryProvider.relativeTime(e.timestamp)}</span>
        ${redeployBtn}
      </div>
      <div class="entry-meta">${metaParts.join(' · ')}</div>
      ${pathsHtml}
    </div>`;
  }

  private static getHtml(entries: DeployHistoryEntry[]): string {
    const body = entries.length === 0
      ? '<div class="empty">No deployments recorded yet.<br>Deployments run from the Deploy Metadata panel are saved here automatically.</div>'
      : entries.map((e) => DeployHistoryProvider.renderEntry(e)).join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-inactiveSelectionBackground); position: sticky; top: 0; z-index: 10; }
    .toolbar h2 { margin: 0; font-size: 14px; font-weight: 600; }
    .btn-clear { padding: 4px 10px; font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border); border-radius: 4px; }
    .btn-clear:hover { opacity: 0.8; }
    .empty { padding: 48px 24px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.7; }
    .entry { border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 16px; }
    .entry:hover { background: var(--vscode-list-hoverBackground); }
    .entry-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
    .entry-status { font-size: 15px; flex-shrink: 0; }
    .entry-label { font-weight: 600; flex: 1; min-width: 120px; }
    .entry-time { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .entry-meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .err { color: var(--vscode-errorForeground); }
    .dim { opacity: 0.7; }
    .btn-redeploy { padding: 3px 8px; font-size: 11px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border); border-radius: 3px; white-space: nowrap; flex-shrink: 0; }
    .btn-redeploy:hover { opacity: 0.85; }
    .paths-toggle { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; }
    .paths-toggle:hover { text-decoration: underline; }
    .paths-list { margin-top: 4px; padding: 6px 8px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); display: none; max-height: 200px; overflow-y: auto; }
    .paths-list div { padding: 1px 0; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h2>Deployment History <span style="font-weight:400;font-size:12px;color:var(--vscode-descriptionForeground);">(last ${entries.length} / ${MAX_ENTRIES})</span></h2>
    <button class="btn-clear" id="btn-clear">Clear all</button>
  </div>
  ${body}
  <script>
    var vscode = acquireVsCodeApi();
    var clearBtn = document.getElementById('btn-clear');
    if (clearBtn) clearBtn.onclick = function() {
      if (confirm('Clear all deployment history?')) vscode.postMessage({ command: 'clearHistory' });
    };
    document.querySelectorAll('.paths-toggle').forEach(function(btn) {
      btn.onclick = function() {
        var list = this.nextElementSibling;
        if (!list) return;
        var shown = list.style.display === 'block';
        list.style.display = shown ? 'none' : 'block';
        this.textContent = shown
          ? 'Show ' + this.dataset.count + ' path' + (this.dataset.count == 1 ? '' : 's')
          : 'Hide paths';
      };
    });
    document.querySelectorAll('.btn-redeploy').forEach(function(btn) {
      btn.onclick = function() { vscode.postMessage({ command: 'redeploy', entryId: this.dataset.id }); };
    });
  </script>
</body>
</html>`;
  }
}
