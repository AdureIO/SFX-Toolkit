import * as vscode from "vscode";
import * as path from "path";
import { apexCoverage } from "../utils/apexCoverageService";

const BADGE_STATE_KEY = "asfx.apexCoverage.showBadge";

/**
 * Badges `.cls`/`.trigger` files in the File Explorer with their Apex coverage %,
 * shown only for files that actually have coverage data. The numeric badge can be
 * toggled off (persisted) for a cleaner tree — the coverage always stays on hover.
 * The badge is a plain number (Explorer badges are ~2 chars, so "%" won't fit); no
 * filename tint, since VS Code's decoration color applies to the whole label.
 * Refreshes whenever the coverage store reloads.
 */
export class ApexCoverageDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private showBadge: boolean;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.showBadge = context.globalState.get<boolean>(BADGE_STATE_KEY, true);
    // Fire `undefined` to invalidate ALL decorations — firing a specific URI list is
    // treated as "these changed" and VS Code can skip repainting already-rendered badges.
    apexCoverage.onDidChange(() => this._onDidChange.fire(undefined));
  }

  /** Show/hide the numeric badge (hover coverage is unaffected). Persisted. */
  async toggleBadge(): Promise<void> {
    this.showBadge = !this.showBadge;
    await this.context.globalState.update(BADGE_STATE_KEY, this.showBadge);
    this._onDidChange.fire(undefined);
    vscode.window.setStatusBarMessage(`Explorer coverage %: ${this.showBadge ? "shown" : "hidden (hover only)"}`, 2000);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext !== ".cls" && ext !== ".trigger") return undefined;
    const name = path.basename(uri.fsPath).replace(/\.(cls|trigger)$/i, "");
    const rec = apexCoverage.get(name);
    if (!rec || rec.total === 0) return undefined;

    const pct = rec.percent;
    const tooltip = `Apex test coverage: ${pct}% — ${rec.covered}/${rec.total} lines covered`;
    if (!this.showBadge) return new vscode.FileDecoration(undefined, tooltip);
    // Explorer badges allow at most 2 characters — 100% shows a check.
    const badge = (pct === 100 ? "✓" : String(pct)).slice(0, 2);
    return new vscode.FileDecoration(badge, tooltip);
  }
}
