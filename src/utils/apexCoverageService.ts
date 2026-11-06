import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "./commandRunner";
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { Telemetry, categorizeError } from "./telemetry";

/** Coverage rollup for a single Apex class or trigger. */
export interface CoverageRecord {
  name: string;
  covered: number;
  uncovered: number;
  total: number;
  percent: number; // 0-100
}

/** Salesforce production deploy threshold. */
export const COVERAGE_THRESHOLD = 75;

/**
 * Shared Apex coverage store. One place queries `ApexCodeCoverageAggregate`
 * (latest per-class coverage from the last test run); the Explorer badges and the
 * Coverage panel both read from it and refresh together via {@link onDidChange}.
 */
class CoverageService implements vscode.Disposable {
  private map = new Map<string, CoverageRecord>(); // lower-case name -> record
  private _loadedAt: number | null = null;
  private inflight: Promise<boolean> | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  get loadedAt(): number | null {
    return this._loadedAt;
  }

  get(name: string): CoverageRecord | undefined {
    return this.map.get(name.toLowerCase());
  }

  all(): CoverageRecord[] {
    return [...this.map.values()];
  }

  /** Weighted org coverage plus the count of classes under the threshold. */
  overall(): { percent: number; covered: number; total: number; below: number; classes: number } {
    let covered = 0;
    let total = 0;
    let below = 0;
    for (const r of this.map.values()) {
      covered += r.covered;
      total += r.total;
      if (r.percent < COVERAGE_THRESHOLD) below++;
    }
    return { percent: total ? Math.round((covered / total) * 100) : 0, covered, total, below, classes: this.map.size };
  }

  /**
   * Re-query coverage from the org. Returns true if any coverage was found. Throws on failure.
   * Concurrent callers (watcher, test run, panel) share one in-flight query.
   */
  refresh(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Tooling query over REST (follows nextRecordsUrl); null when REST/auth is unavailable. */
  private async queryRest(query: string): Promise<Record<string, unknown>[] | null> {
    try {
      const records: Record<string, unknown>[] = [];
      let next: string | undefined = `/services/data/${getToolingApiVersion()}/tooling/query?q=${encodeURIComponent(query)}`;
      for (let page = 0; next && page < 100; page++) {
        const rel: string = next;
        const { body } = await AuthInfo.get(null, (a) => `${a.instanceUrl.replace(/\/$/, "")}${rel}`);
        const json = JSON.parse(body) as { records?: Record<string, unknown>[]; nextRecordsUrl?: string; done?: boolean };
        records.push(...(json.records ?? []));
        next = json.done === false ? json.nextRecordsUrl : undefined;
      }
      return records;
    } catch {
      return null;
    }
  }

  private async doRefresh(): Promise<boolean> {
    const query = "SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate";
    // REST first (no process spawn); fall back to the CLI, which surfaces auth errors clearly.
    let records = await this.queryRest(query);
    if (!records) {
      let raw: string;
      try {
        raw = await runCommandArgs(
          "sf",
          ["data", "query", "--use-tooling-api", "-q", query, "--json"],
          undefined,
          undefined,
          false
        );
      } catch (error) {
        Telemetry.error("apexCoverageError", { reason: categorizeError(error) });
        throw error;
      }
      records = (JSON.parse(raw) as { result?: { records?: Record<string, unknown>[] } }).result?.records ?? [];
    }
    const next = new Map<string, CoverageRecord>();
    for (const r of records) {
      const name = (r["ApexClassOrTrigger"] as { Name?: string } | undefined)?.Name;
      if (!name) continue;
      const covered = Number(r["NumLinesCovered"] ?? 0);
      const uncovered = Number(r["NumLinesUncovered"] ?? 0);
      const total = covered + uncovered;
      if (total === 0) continue; // no measurable lines = no coverage data
      next.set(name.toLowerCase(), {
        name,
        covered,
        uncovered,
        total,
        percent: total ? Math.round((covered / total) * 100) : 0
      });
    }
    this.map = next;
    this._loadedAt = Date.now();
    this._onDidChange.fire();
    Telemetry.event("apexCoverage", { status: "loaded" }, { classes: next.size });
    return next.size > 0;
  }

  /** Empty the store and repaint (badges disappear, panel goes empty). */
  clear(): void {
    this.map.clear();
    this._loadedAt = null;
    this._onDidChange.fire();
  }

  dispose(): void {
    this.map.clear();
    this._loadedAt = null;
    this._onDidChange.dispose();
  }
}

export const apexCoverage = new CoverageService();

/**
 * Watch the directory where the Salesforce extensions (and CLI) write Apex test
 * results — `.sfdx/tools/testresults/` — so coverage refreshes automatically after a
 * test run started outside this extension. Debounced, since a single run writes several
 * files. Uses a per-folder RelativePattern so it isn't hidden by `files.watcherExclude`.
 */
let watcherTimer: ReturnType<typeof setTimeout> | undefined;
let suppressTimer: ReturnType<typeof setTimeout> | undefined;
let watcherSuppressed = false;

function scheduleWatcherRefresh(): void {
  if (watcherSuppressed) return; // don't re-query while we're deliberately clearing
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = setTimeout(() => {
    watcherTimer = undefined;
    void apexCoverage.refresh().catch(() => undefined);
  }, 1200);
}

export function registerCoverageWatchers(context: vscode.ExtensionContext): void {
  // One watcher per workspace folder, kept in sync when folders are added/removed.
  const watchers = new Map<string, vscode.Disposable>();
  const watch = (folder: vscode.WorkspaceFolder) => {
    const key = folder.uri.toString();
    if (watchers.has(key)) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".sfdx/tools/testresults/**")
    );
    watchers.set(
      key,
      vscode.Disposable.from(
        watcher,
        watcher.onDidCreate(scheduleWatcherRefresh),
        watcher.onDidChange(scheduleWatcherRefresh),
        watcher.onDidDelete(scheduleWatcherRefresh)
      )
    );
  };
  (vscode.workspace.workspaceFolders ?? []).forEach(watch);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) {
        watchers.get(f.uri.toString())?.dispose();
        watchers.delete(f.uri.toString());
      }
      e.added.forEach(watch);
    }),
    new vscode.Disposable(() => {
      watchers.forEach((w) => w.dispose());
      watchers.clear();
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = undefined;
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = undefined;
    }),
    apexCoverage
  );
}

/**
 * Delete the local Apex test results under `.sfdx/tools/testresults/` and blank the
 * coverage display. The result watcher is suppressed across the delete so it doesn't
 * immediately re-query the org and repopulate. Returns the number of entries removed.
 */
export async function clearApexTestResults(): Promise<number> {
  watcherSuppressed = true;
  if (watcherTimer) {
    clearTimeout(watcherTimer);
    watcherTimer = undefined;
  }
  let removed = 0;
  try {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const dir = path.join(folder.uri.fsPath, ".sfdx", "tools", "testresults");
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // nothing written yet for this folder
      }
      for (const entry of entries) {
        await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true });
        removed++;
      }
    }
    apexCoverage.clear();
  } finally {
    // Outlast the watcher debounce before re-enabling, so delete events don't refire.
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressTimer = undefined;
      watcherSuppressed = false;
    }, 2500);
  }
  Telemetry.event("apexCoverage", { status: "cleared" }, { entries: removed });
  return removed;
}
