import * as vscode from "vscode";
import * as path from "path";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { apexCoverage } from "../utils/apexCoverageService";
import { Telemetry } from "../utils/telemetry";

interface LineCoverage {
  covered: number[];
  uncovered: number[];
  /** Aggregate covered/uncovered counts the lines were fetched against (invalidation key). */
  sig: string;
}

const STATE_KEY = "asfx.apexCoverage.showLines";
/** LRU bound for per-class line data. */
const MAX_CACHED_CLASSES = 200;
/** After a failed lookup, don't retry the same class for this long. */
const FAILURE_BACKOFF_MS = 60_000;

function coverageSig(name: string): string {
  const r = apexCoverage.get(name);
  return r ? `${r.covered}/${r.uncovered}` : "";
}

/**
 * Optional in-editor line highlighting for Apex coverage. Off by default; toggled on/off
 * and the choice is remembered. While ON it stays live — reapplies whenever the coverage
 * store refreshes (test run, watcher, manual refresh) and when you switch files. Per-line
 * data is fetched lazily per open class (a tiny filtered query), not for the whole org.
 */
export class CoverageLineDecorator {
  private enabled: boolean;
  private readonly lineCache = new Map<string, LineCoverage>(); // lower-case name -> lines (LRU order)
  private readonly inflight = new Map<string, Promise<LineCoverage | undefined>>();
  private readonly failedAt = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  private readonly covered = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(63,185,80,0.08)",
    overviewRulerColor: "rgba(63,185,80,0.85)",
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });

  private readonly uncovered = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: "rgba(248,81,73,0.10)",
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: "rgba(248,81,73,0.9)",
    overviewRulerColor: "rgba(248,81,73,0.9)",
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });

  constructor(private readonly context: vscode.ExtensionContext) {
    this.enabled = context.globalState.get<boolean>(STATE_KEY, false);
    // Coverage refreshed → drop only classes whose aggregate changed, then repaint.
    this.subscriptions.push(
      apexCoverage.onDidChange(() => {
        for (const [key, lines] of this.lineCache) {
          if (coverageSig(key) !== lines.sig) this.lineCache.delete(key);
        }
        this.failedAt.clear();
        if (this.enabled) void this.applyAll();
      })
    );
    // Switching / opening files → paint the newly visible editors.
    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        if (this.enabled) void this.applyAll();
      })
    );
    if (this.enabled) void this.applyAll();
  }

  /** Command entry point — flip and persist the on/off state. */
  async toggle(): Promise<void> {
    this.enabled = !this.enabled;
    await this.context.globalState.update(STATE_KEY, this.enabled);
    if (this.enabled) {
      await this.applyAll();
      vscode.window.setStatusBarMessage("Apex coverage line highlights: on", 2000);
    } else {
      this.clearAll();
      vscode.window.setStatusBarMessage("Apex coverage line highlights: off", 2000);
    }
    Telemetry.event("apexCoverage", { status: "lines", enabled: this.enabled ? "1" : "0" });
  }

  private async applyAll(): Promise<void> {
    await Promise.all(vscode.window.visibleTextEditors.map((editor) => this.apply(editor)));
  }

  private async apply(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const ext = path.extname(doc.fileName).toLowerCase();
    if (ext !== ".cls" && ext !== ".trigger") return;
    const name = path.basename(doc.fileName).replace(/\.(cls|trigger)$/i, "");
    // Only annotate classes we actually have coverage for.
    if (!/^\w+$/.test(name) || !apexCoverage.get(name)) {
      this.clear(editor);
      return;
    }
    const lines = await this.getLines(name);
    if (this.disposed || !this.enabled) return;
    if (!lines) {
      this.clear(editor);
      return;
    }
    const max = doc.lineCount;
    const toRange = (ln: number) => new vscode.Range(ln - 1, 0, ln - 1, 0);
    const valid = (ln: number) => Number.isInteger(ln) && ln >= 1 && ln <= max;
    editor.setDecorations(this.covered, lines.covered.filter(valid).map(toRange));
    editor.setDecorations(this.uncovered, lines.uncovered.filter(valid).map(toRange));
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.covered, []);
    editor.setDecorations(this.uncovered, []);
  }

  private clearAll(): void {
    vscode.window.visibleTextEditors.forEach((editor) => this.clear(editor));
  }

  /**
   * Per-line coverage for one class over REST (no CLI spawn). Cached (LRU) until that
   * class's aggregate changes, including "no record" results; concurrent requests for
   * the same class share one fetch; failures back off for a minute.
   */
  private getLines(name: string): Promise<LineCoverage | undefined> {
    const key = name.toLowerCase();
    const sig = coverageSig(name);
    const cached = this.lineCache.get(key);
    if (cached && cached.sig === sig) {
      this.lineCache.delete(key); // bump LRU position
      this.lineCache.set(key, cached);
      return Promise.resolve(cached);
    }
    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS) return Promise.resolve(undefined);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.fetchLines(name, sig).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchLines(name: string, sig: string): Promise<LineCoverage | undefined> {
    const key = name.toLowerCase();
    try {
      // `name` is validated as \w+ by the caller, so it is safe inside the SOQL literal.
      const query = `SELECT Coverage FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name = '${name}'`;
      const { body } = await AuthInfo.get(
        null,
        (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${getToolingApiVersion()}/tooling/query?q=${encodeURIComponent(query)}`
      );
      const record = (JSON.parse(body) as { records?: Record<string, unknown>[] }).records?.[0];
      const cov = record?.["Coverage"] as { coveredLines?: number[]; uncoveredLines?: number[] } | undefined;
      const lines: LineCoverage = {
        covered: Array.isArray(cov?.coveredLines) ? (cov!.coveredLines as number[]) : [],
        uncovered: Array.isArray(cov?.uncoveredLines) ? (cov!.uncoveredLines as number[]) : [],
        sig
      };
      if (this.disposed) return lines;
      this.failedAt.delete(key);
      this.lineCache.set(key, lines);
      while (this.lineCache.size > MAX_CACHED_CLASSES) {
        this.lineCache.delete(this.lineCache.keys().next().value as string);
      }
      return lines;
    } catch {
      if (!this.disposed) this.failedAt.set(key, Date.now());
      return undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearAll();
    this.covered.dispose();
    this.uncovered.dispose();
    this.subscriptions.forEach((d) => d.dispose());
    this.subscriptions.length = 0;
    this.lineCache.clear();
    this.inflight.clear();
    this.failedAt.clear();
  }
}
