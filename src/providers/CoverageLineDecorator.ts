import * as vscode from "vscode";
import * as path from "path";
import { runCommandArgs } from "../utils/commandRunner";
import { apexCoverage } from "../utils/apexCoverageService";
import { Telemetry } from "../utils/telemetry";

interface LineCoverage {
  covered: number[];
  uncovered: number[];
}

const STATE_KEY = "asfx.apexCoverage.showLines";

/**
 * Optional in-editor line highlighting for Apex coverage. Off by default; toggled on/off
 * and the choice is remembered. While ON it stays live — reapplies whenever the coverage
 * store refreshes (test run, watcher, manual refresh) and when you switch files. Per-line
 * data is fetched lazily per open class (a tiny filtered query), not for the whole org.
 */
export class CoverageLineDecorator {
  private enabled: boolean;
  private readonly lineCache = new Map<string, LineCoverage>(); // lower-case name -> lines
  private readonly subscriptions: vscode.Disposable[] = [];

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
    // Coverage refreshed → drop cached lines and repaint (keeps highlights current).
    this.subscriptions.push(
      apexCoverage.onDidChange(() => {
        this.lineCache.clear();
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
    for (const editor of vscode.window.visibleTextEditors) await this.apply(editor);
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

  /** Fetch per-line coverage for one class (cached until the store refreshes). */
  private async getLines(name: string): Promise<LineCoverage | undefined> {
    const cached = this.lineCache.get(name.toLowerCase());
    if (cached) return cached;
    try {
      const query = `SELECT Coverage FROM ApexCodeCoverageAggregate WHERE ApexClassOrTrigger.Name = '${name}'`;
      const raw = await runCommandArgs(
        "sf",
        ["data", "query", "--use-tooling-api", "-q", query, "--json"],
        undefined,
        undefined,
        false
      );
      const record = (JSON.parse(raw) as { result?: { records?: Record<string, unknown>[] } }).result?.records?.[0];
      const cov = record?.["Coverage"] as { coveredLines?: number[]; uncoveredLines?: number[] } | undefined;
      const lines: LineCoverage = {
        covered: Array.isArray(cov?.coveredLines) ? (cov!.coveredLines as number[]) : [],
        uncovered: Array.isArray(cov?.uncoveredLines) ? (cov!.uncoveredLines as number[]) : []
      };
      this.lineCache.set(name.toLowerCase(), lines);
      return lines;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.clearAll();
    this.covered.dispose();
    this.uncovered.dispose();
    this.subscriptions.forEach((d) => d.dispose());
  }
}
