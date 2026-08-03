import * as vscode from "vscode";
import {
  getMetadataTreeByPackage,
  getTestClassItems,
  resolveSourcePaths,
  filterPathsToPackageDirs,
  buildDeployCommand,
  createDeployProgressHandler,
  getPackageDirectories,
  DEPLOY_TIMEOUT_MS,
  DEPLOY_TYPE_RUN_ALL,
  DEPLOY_TYPE_RUN_RELEVANT,
  DEPLOY_TYPE_SPECIFIED,
  DEPLOY_TYPE_NO_TESTS,
  type DeployTreePackageNode
} from "../commands/deployMetadata";
import { confirmProductionOrgOperation } from "../utils/orgSafety";
import { loadPresets, addPreset, type DeployPreset, type DeployTypeKey } from "../utils/deployPresets";
import { getAnonymousApexOrgList } from "../commands/executeAnonymous";
import { runCommand } from "../utils/commandRunner";
import { Logger, DeployLog } from "../utils/outputChannel";
import { cleanDeployOutput, parseDeployStats, parseCoverageData } from "../commands/devCommands";
import { addDeployHistoryEntry } from "../commands/deployHistory";
import { clearDeployDiagnostics, setDeployDiagnosticsFromFailure, setDeployDiagnosticsFromApiResult, formatApiDeployResultForLog } from "../utils/deployDiagnostics";
import { runJsonDeploy } from "../utils/deployEngine";
import { statsFromResult, coverageFromResult, toApiDeployResult, formatStatus, formatElapsed, formatResultSummary, type DeployStats, type CoverageRow } from "../utils/deployStatusMap";
import { AuthInfo } from "../utils/authInfo";
import { upsertTestSuite, deleteTestSuite as deleteTestSuiteEntry, loadTestSuites, type TestSuite } from "../utils/testSuites";

/** Panel state we persist in the extension so it survives webview HTML replacement (tab switch/revive). */
export interface DeployPanelState {
  sourcePaths: string[];
  presetName?: string | null;
  deployType?: string;
  testClassNames?: string[];
  testSuiteName?: string | null;
  targetOrg?: string | null;
  treeSearch?: string;
  filterOnlySelected?: boolean;
  autoGitSelect?: boolean;
  validateOnly?: boolean;
}

export class DeployMetadataPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.deployMetadataPanel";

  /** Panel state per workspace so selection survives when webview content is recreated on tab switch. */
  private static panelStateByWorkspace: Record<string, DeployPanelState> = {};

  /** Cached init data for the current workspace so tab restore (revive) is instant instead of re-running tree/org list. */
  private static initCache: {
    workspaceRoot: string;
    tree: DeployTreePackageNode[];
    testClasses: { label: string; description: string }[];
    presets: DeployPreset[];
    orgs: { label: string; username: string }[];
    defaultOrg: string;
    testSuites: TestSuite[];
  } | null = null;

  /** Per-panel message listener disposable; disposed when panel closes or before re-attach on revive to avoid leaks. */
  private static messageListenerByPanel = new WeakMap<vscode.WebviewPanel, vscode.Disposable>();
  /** Panels for which we already registered onDidDispose (one-time cleanup per panel). */
  private static panelsWithDisposeRegistered = new WeakSet<vscode.WebviewPanel>();

  public static async show(initialPreset?: DeployPreset): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showErrorMessage("No workspace open.");
      return;
    }
    const workspaceRoot = folder.uri.fsPath;
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    const panel = vscode.window.createWebviewPanel(DeployMetadataPanelProvider.viewType, "Deploy Metadata", column, {
      enableScripts: true,
      retainContextWhenHidden: true  // keeps DOM alive on tab switch — no revive/re-render on switching back
    });

    // Render HTML immediately — panel is visible with "Loading…" while data loads in parallel.
    try {
      panel.webview.html = this.getHtml();
    } catch (e) {
      vscode.window.showErrorMessage(
        "Deploy Metadata panel failed to load: " + (e instanceof Error ? e.message : String(e))
      );
      panel.webview.html = `<html><body><p style="color: red;">Failed to load panel. Check Output &gt; Adure SFX Toolkit.</p></body></html>`;
      return;
    }

    // Load all data in parallel. The message handler awaits this before sending 'init'.
    const dataPromise = Promise.allSettled([
      Promise.resolve().then(() => getMetadataTreeByPackage(workspaceRoot)),
      Promise.resolve().then(() => getTestClassItems(workspaceRoot)),
      loadPresets(folder.uri),
      getAnonymousApexOrgList(),
      Promise.resolve().then(() => loadTestSuites(workspaceRoot))
    ]).then(([treeR, testR, presetsR, orgsR, suitesR]) => {
      const tree = treeR.status === "fulfilled" ? treeR.value : ([] as DeployTreePackageNode[]);
      const testClasses = testR.status === "fulfilled" ? testR.value : ([] as { label: string; description: string }[]);
      const presets = presetsR.status === "fulfilled" ? presetsR.value : ([] as DeployPreset[]);
      const orgs = orgsR.status === "fulfilled" ? orgsR.value : ([] as { label: string; username: string }[]);
      const defaultOrg = orgs.length > 0 ? orgs[0].username : "";
      const testSuites = suitesR.status === "fulfilled" ? suitesR.value : ([] as TestSuite[]);
      return { tree, testClasses, presets, orgs, defaultOrg, testSuites };
    });

    this.attachMessageHandler(panel, initialPreset ?? null, dataPromise, folder, workspaceRoot);
  }

  /** Call when panel is restored (e.g. after switching back to the tab). Uses cached data so restore is instant. */
  public static async revive(panel: vscode.WebviewPanel): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      panel.webview.html = `<html><body><p>No workspace open. Close this tab and run "ASFXT: Deploy Metadata" with a folder open.</p></body></html>`;
      return;
    }
    const workspaceRoot = folder.uri.fsPath;

    // Render HTML immediately — visible at once regardless of cache hit/miss.
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.getHtml();

    const cache = DeployMetadataPanelProvider.initCache;
    const dataPromise = (cache && cache.workspaceRoot === workspaceRoot)
      ? Promise.resolve({ tree: cache.tree, testClasses: cache.testClasses, presets: cache.presets, orgs: cache.orgs, defaultOrg: cache.defaultOrg, testSuites: cache.testSuites ?? [] })
      : Promise.allSettled([
          Promise.resolve().then(() => getMetadataTreeByPackage(workspaceRoot)),
          Promise.resolve().then(() => getTestClassItems(workspaceRoot)),
          loadPresets(folder.uri),
          getAnonymousApexOrgList(),
          Promise.resolve().then(() => loadTestSuites(workspaceRoot))
        ]).then(([treeR, testR, presetsR, orgsR, suitesR]) => {
          const tree = treeR.status === "fulfilled" ? treeR.value : ([] as DeployTreePackageNode[]);
          const testClasses = testR.status === "fulfilled" ? testR.value : ([] as { label: string; description: string }[]);
          const presets = presetsR.status === "fulfilled" ? presetsR.value : ([] as DeployPreset[]);
          const orgs = orgsR.status === "fulfilled" ? orgsR.value : ([] as { label: string; username: string }[]);
          const defaultOrg = orgs.length > 0 ? orgs[0].username : "";
          const testSuites = suitesR.status === "fulfilled" ? suitesR.value : ([] as TestSuite[]);
          return { tree, testClasses, presets, orgs, defaultOrg, testSuites };
        });

    this.attachMessageHandler(panel, null, dataPromise, folder, workspaceRoot);
  }

  private static attachMessageHandler(
    panel: vscode.WebviewPanel,
    initialPreset: DeployPreset | null,
    dataPromise: Promise<{
      tree: DeployTreePackageNode[];
      testClasses: { label: string; description: string }[];
      presets: DeployPreset[];
      orgs: { label: string; username: string }[];
      defaultOrg: string;
      testSuites: TestSuite[];
    }>,
    folder: vscode.WorkspaceFolder,
    workspaceRoot: string
  ): void {
    // Dispose previous listener when re-attaching (e.g. on revive) to avoid leaking listeners and large closures.
    const existing = DeployMetadataPanelProvider.messageListenerByPanel.get(panel);
    if (existing) {
      existing.dispose();
      DeployMetadataPanelProvider.messageListenerByPanel.delete(panel);
    }

    // ── FileSystemWatcher for auto-git ──────────────────────────────────────
    // Created/destroyed based on the autoGitSelect panel-state flag. Fires with
    // 600ms debounce so rapid saves during a batch write don't spam git status.
    let fileWatcher: vscode.FileSystemWatcher | null = null;
    let watcherDebounce: ReturnType<typeof setTimeout> | null = null;

    const updateFileWatcher = (enabled: boolean): void => {
      if (fileWatcher) { fileWatcher.dispose(); fileWatcher = null; }
      if (watcherDebounce) { clearTimeout(watcherDebounce); watcherDebounce = null; }
      if (!enabled) return;

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, "**/*"),
        false, false, false
      );
      const onChange = () => {
        if (watcherDebounce) clearTimeout(watcherDebounce);
        watcherDebounce = setTimeout(async () => {
          try {
            const paths = await DeployMetadataPanelProvider.runGitStatusSfdxPaths(workspaceRoot);
            panel.webview.postMessage({ command: "setChangedPaths", paths });
          } catch (e) {
            panel.webview.postMessage({ command: "setChangedPaths", paths: [], error: String(e) });
          }
        }, 600);
      };
      watcher.onDidCreate(onChange);
      watcher.onDidChange(onChange);
      watcher.onDidDelete(onChange);
      fileWatcher = watcher;
    };
    // ── end FileSystemWatcher ────────────────────────────────────────────────

    const listenerDisposable = panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        sourcePaths?: string[];
        testLevel?: string;
        testClassNames?: string[];
        dryRun?: boolean;
        targetOrg?: string;
        presetName?: string;
        deployType?: DeployTypeKey;
        state?: DeployPanelState;
        suiteName?: string;
      }) => {
        if (msg.command === "persistPanelState" && msg.state !== null && msg.state !== undefined) {
          DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] = msg.state;
          updateFileWatcher(msg.state.autoGitSelect ?? false);
          return;
        }
        if (msg.command === "panelReady") {
          const { tree, testClasses, presets, orgs, defaultOrg, testSuites } = await dataPromise;
          DeployMetadataPanelProvider.initCache = { workspaceRoot, tree, testClasses, presets, orgs, defaultOrg, testSuites };
          const savedState = DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] ?? null;
          AuthInfo.warmAuthForOrg((savedState?.targetOrg ?? defaultOrg) || null);
          updateFileWatcher(savedState?.autoGitSelect ?? false);
          panel.webview.postMessage({ command: "init", tree, testClasses, presets, initialPreset, orgs, defaultOrg, savedState, testSuites });
          return;
        }
        if (msg.command === "savePreset") {
          const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri ?? folder.uri;
          const deployType = (msg.deployType || "NoTestRun") as DeployTypeKey;
          const sourcePaths = Array.isArray(msg.sourcePaths) ? msg.sourcePaths : [];
          const testClassNames = Array.isArray(msg.testClassNames) ? msg.testClassNames : [];
          const targetOrg = msg.targetOrg || undefined;
          try {
            const name = (msg.presetName || "").trim();
            if (!name) {
              const newName = await vscode.window.showInputBox({
                title: "Save as preset",
                prompt: "Enter a name for this preset",
                validateInput: (v) => (!v || !v.trim() ? "Name is required" : null)
              });
              if (!newName?.trim()) {
                panel.webview.postMessage({
                  command: "presetSaved",
                  error: "Cancelled",
                  presets: await loadPresets(workspaceUri)
                });
                return;
              }
              await addPreset(workspaceUri, {
                name: newName.trim(),
                sourcePaths,
                deployType,
                testClassNames,
                targetOrg
              });
              const updated = await loadPresets(workspaceUri);
              panel.webview.postMessage({
                command: "presetSaved",
                name: newName.trim(),
                isNew: true,
                presets: updated
              });
              vscode.window.showInformationMessage(`Preset "${newName.trim()}" saved.`);
            } else {
              await addPreset(workspaceUri, {
                name,
                sourcePaths,
                deployType,
                testClassNames,
                targetOrg
              });
              const updated = await loadPresets(workspaceUri);
              panel.webview.postMessage({ command: "presetSaved", name, isNew: false, presets: updated });
              vscode.window.showInformationMessage(`Preset "${name}" updated.`);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage("Failed to save preset: " + errMsg);
            try {
              panel.webview.postMessage({
                command: "presetSaved",
                error: errMsg,
                presets: await loadPresets(workspaceUri)
              });
            } catch {
              // ignore
            }
          }
          return;
        }
        if (msg.command === "getChangedFiles") {
          try {
            const paths = await DeployMetadataPanelProvider.runGitStatusSfdxPaths(workspaceRoot);
            panel.webview.postMessage({ command: "setChangedPaths", paths });
          } catch (e) {
            panel.webview.postMessage({ command: "setChangedPaths", paths: [], error: String(e) });
          }
          return;
        }
        if (msg.command === "saveTestSuite") {
          const testClassNames = Array.isArray(msg.testClassNames) ? msg.testClassNames : [];
          let suiteName = (msg.suiteName ?? "").trim();
          if (!suiteName) {
            const input = await vscode.window.showInputBox({
              title: "Save test suite",
              prompt: "Suite name",
              validateInput: (v) => (!v?.trim() ? "Name is required" : null)
            });
            if (!input?.trim()) return;
            suiteName = input.trim();
          }
          const suites = upsertTestSuite(workspaceRoot, { name: suiteName, testClassNames });
          panel.webview.postMessage({ command: "testSuitesUpdated", suites });
          return;
        }
        if (msg.command === "deleteTestSuite") {
          const name = (msg.suiteName ?? "").trim();
          if (!name) return;
          const suites = deleteTestSuiteEntry(workspaceRoot, name);
          panel.webview.postMessage({ command: "testSuitesUpdated", suites });
          return;
        }
        if (msg.command !== "deploy" || !msg.sourcePaths || !msg.testLevel) return;
        const dryRun = msg.dryRun === true;
        const prodAction = dryRun ? "validate a deployment against" : "deploy metadata to";
        if (!(await confirmProductionOrgOperation(prodAction, msg.targetOrg || undefined))) {
          return;
        }
        const testLevel = msg.testLevel;
        let testFlags = "";
        if (
          msg.testLevel === "RunSpecifiedTests" &&
          Array.isArray(msg.testClassNames) &&
          msg.testClassNames.length > 0
        ) {
          testFlags = msg.testClassNames.map((t) => `-t ${t}`).join(" ");
        }
        const resolved = resolveSourcePaths(msg.sourcePaths, workspaceRoot);
        const absPaths = filterPathsToPackageDirs(workspaceRoot, resolved);
        const targetOrg = msg.targetOrg || null;

        // Normalized result the post-processing consumes, whichever deploy path ran.
        // `apiResult` (REST) feeds Problems directly; `errorText` (CLI fallback) is
        // parsed for diagnostics the legacy way.
        type FinalOutcome =
          | { kind: "cancelled" }
          | { kind: "success"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: import("../utils/deployDiagnostics").ApiDeployResult }
          | { kind: "failed"; stats: DeployStats; coverage: CoverageRow[]; apiResult?: import("../utils/deployDiagnostics").ApiDeployResult; errorText?: string };

        const deployStartTime = Date.now();
        panel.webview.postMessage({ command: "deployStart", dryRun });

        const liveStatus = vscode.workspace
          .getConfiguration("adure-sfx-toolkit")
          .get<boolean>("deploy.liveStatus", true);

        const outcome: FinalOutcome = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: dryRun ? "Validating deployment…" : "Deploying",
            cancellable: true
          },
          async (progress, token): Promise<FinalOutcome> => {
            clearDeployDiagnostics();
            progress.report({ message: "Preparing…" });

            // ── CLI streaming fallback (original behavior), normalized to FinalOutcome ──
            const runCliStreaming = async (): Promise<FinalOutcome> => {
              const cmd = buildDeployCommand(absPaths, testLevel, testFlags, dryRun, workspaceRoot, msg.targetOrg || undefined);
              const progressHandler = createDeployProgressHandler(
                (message) => progress.report({ message }),
                { onStatusFailed: () => progress.report({ message: "Status: Failed" }) }
              );
              try {
                const result = await runCommand(cmd, workspaceRoot, progressHandler, false, token, DEPLOY_TIMEOUT_MS);
                DeployLog.line(`Deploy result (from CLI output):\n${cleanDeployOutput(result)}`);
                return { kind: "success", stats: parseDeployStats(result), coverage: parseCoverageData(result) };
              } catch (e: unknown) {
                const err = e as { cancelled?: boolean; message?: string };
                if (err.cancelled) return { kind: "cancelled" };
                const errorText = err.message ?? String(e);
                return { kind: "failed", stats: parseDeployStats(errorText), coverage: [], errorText };
              }
            };

            if (!liveStatus) return runCliStreaming();

            // ── Synchronous --json deploy (updates source tracking) + live REST status ──
            const submitCmd = buildDeployCommand(absPaths, testLevel, testFlags, dryRun, workspaceRoot, msg.targetOrg || undefined);
            try {
              const res = await runJsonDeploy({
                submitCommand: submitCmd,
                cwd: workspaceRoot,
                org: targetOrg,
                token,
                timeoutMs: DEPLOY_TIMEOUT_MS,
                onStatus: (s) => {
                  progress.report({ message: formatStatus(s) });
                  panel.webview.postMessage({ command: "deployProgress", status: s });
                }
              });
              if (res.kind === "cancelled") return { kind: "cancelled" };
              if (res.kind === "nothing") {
                return { kind: "success", stats: { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 }, coverage: [] };
              }
              if (res.kind === "failed") {
                const dr = res.result;
                return dr
                  ? { kind: "failed", stats: statsFromResult(dr), coverage: coverageFromResult(dr), apiResult: toApiDeployResult(dr) }
                  : { kind: "failed", stats: { components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0 }, coverage: [], errorText: res.errorText };
              }
              const dr = res.result;
              return { kind: "success", stats: statsFromResult(dr), coverage: coverageFromResult(dr), apiResult: toApiDeployResult(dr) };
            } catch (e: unknown) {
              // Unexpected engine error → fall back to the classic CLI streaming path.
              Logger.info(`Live deploy failed unexpectedly; falling back to CLI streaming: ${(e as { message?: string })?.message ?? String(e)}`);
              return runCliStreaming();
            }
          }
        );

        const durationMs = Date.now() - deployStartTime;

        if (outcome.kind === "cancelled") {
          panel.webview.postMessage({ command: "deployResult", success: false, cancelled: true, dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs, targetOrg: msg.targetOrg ?? "" });
          addDeployHistoryEntry({ timestamp: deployStartTime, status: "Cancelled", dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: msg.sourcePaths ?? [], presetName: msg.presetName ?? null });
          vscode.window.showInformationMessage(dryRun ? "Validation cancelled." : "Deploy cancelled.");
          return;
        }

        if (outcome.kind === "success") {
          const { stats, coverage, apiResult } = outcome;
          // Result summary (status, deployed components, tests) → deploy log.
          if (apiResult) {
            DeployLog.line(formatApiDeployResultForLog(apiResult, `${dryRun ? "Validation" : "Deploy"} succeeded (${formatElapsed(durationMs)}):`));
          }
          panel.webview.postMessage({ command: "deployResult", success: true, cancelled: false, dryRun, ...stats, coverage, durationMs, targetOrg: msg.targetOrg ?? "" });
          addDeployHistoryEntry({ timestamp: deployStartTime, status: "Succeeded", dryRun, ...stats, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: msg.sourcePaths ?? [], presetName: msg.presetName ?? null });
          const okSummary = apiResult ? formatResultSummary(apiResult) : "";
          vscode.window.showInformationMessage(
            `${dryRun ? "Validation" : "Deploy"} completed in ${formatElapsed(durationMs)}${okSummary ? ` · ${okSummary}` : ""}.`
          );
          return;
        }

        // outcome.kind === "failed"
        DeployLog.show();
        const { stats, coverage, apiResult, errorText } = outcome;
        panel.webview.postMessage({ command: "deployResult", success: false, cancelled: false, dryRun, ...stats, coverage, durationMs, targetOrg: msg.targetOrg ?? "" });
        addDeployHistoryEntry({ timestamp: deployStartTime, status: "Failed", dryRun, ...stats, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: msg.sourcePaths ?? [], presetName: msg.presetName ?? null });
        const failSummary = apiResult ? formatResultSummary(apiResult) : "";
        vscode.window.showErrorMessage(
          `Deploy failed after ${formatElapsed(durationMs)}${failSummary ? ` · ${failSummary}` : ""}. See the deploy log.`,
          "View Log"
        ).then((choice) => {
          if (choice === "View Log") DeployLog.show();
        });
        void vscode.window
          .withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Parsing failure details…", cancellable: false },
            async (p) => {
              p.report({ message: "Setting diagnostics…" });
              if (apiResult) {
                // Structured failures straight from the Metadata API → Problems.
                setDeployDiagnosticsFromApiResult(workspaceRoot, apiResult);
              } else {
                await setDeployDiagnosticsFromFailure(workspaceRoot, errorText ?? "", targetOrg);
              }
            }
          )
          .then(() => {
            vscode.window
              .showInformationMessage("Failure details are in the Problems view.", "Show diagnostics")
              .then((choice) => {
                if (choice === "Show diagnostics") {
                  void vscode.commands.executeCommand("workbench.actions.view.problems");
                }
              });
          });
      },
      null,
      []
    );
    DeployMetadataPanelProvider.messageListenerByPanel.set(panel, listenerDisposable);
    if (!DeployMetadataPanelProvider.panelsWithDisposeRegistered.has(panel)) {
      DeployMetadataPanelProvider.panelsWithDisposeRegistered.add(panel);
      panel.onDidDispose(() => {
        updateFileWatcher(false); // dispose watcher + debounce timer
        const d = DeployMetadataPanelProvider.messageListenerByPanel.get(panel);
        if (d) {
          d.dispose();
          DeployMetadataPanelProvider.messageListenerByPanel.delete(panel);
        }
        DeployMetadataPanelProvider.initCache = null;
      });
    }
  }

  /** Run `git status --porcelain` and return paths filtered to SFDX package dirs. */
  public static async runGitStatusSfdxPaths(workspaceRoot: string): Promise<string[]> {
    const out = await runCommand("git status --porcelain", workspaceRoot, undefined, false, undefined, 10000);
    const paths: string[] = [];
    const n = (s: string) => {
      let t = s.replace(/\\/g, "/").replace(/^\.\//, "").trim();
      if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1).replace(/\\"/g, '"');
      return t.split("/").filter(Boolean).join("/");
    };
    for (const line of (out || "").split(/\r?\n/)) {
      if (line.length < 4) continue;
      const rest = line.substring(3).trim();
      if (rest.includes(" -> ")) {
        const [a, b] = rest.split(" -> ").map((x) => x.trim());
        const pa = n(a);
        const pb = n(b);
        if (pa) paths.push(pa);
        if (pb) paths.push(pb);
      } else {
        const p = n(rest);
        if (p) paths.push(p);
      }
    }
    const seen = new Set<string>();
    const unique = paths.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
    const packageDirs = getPackageDirectories(workspaceRoot);
    return packageDirs.length > 0
      ? unique.filter((p) => packageDirs.some((dir) => {
          const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
          return p === d || p.startsWith(d + "/");
        }))
      : unique;
  }

  private static getHtml(): string {
    const testLevels = [
      { value: "NoTestRun", label: DEPLOY_TYPE_NO_TESTS },
      { value: "RunAllTestsInOrg", label: DEPLOY_TYPE_RUN_ALL },
      { value: "RunRelevantTests", label: DEPLOY_TYPE_RUN_RELEVANT },
      { value: "RunSpecifiedTests", label: DEPLOY_TYPE_SPECIFIED }
    ];

    return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }

		/* ── Design tokens ───────────────────────────────────────────────────────── */
		:root {
			--asfx-gap: 14px;
			--asfx-radius: 6px;
			--asfx-radius-sm: 4px;
			--asfx-border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.28)));
			--asfx-border-strong: var(--vscode-contrastBorder, var(--vscode-widget-border, rgba(128,128,128,0.45)));
			--asfx-card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-inactiveSelectionBackground));
			--asfx-elevate: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.18);
			--asfx-accent: var(--vscode-button-background);
			--asfx-ok: #3fb950;
			--asfx-warn: var(--vscode-editorWarning-foreground, #d29922);
			--asfx-err: var(--vscode-errorForeground, #f85149);
		}

		/* ── Scrollbars ──────────────────────────────────────────────────────────── */
		::-webkit-scrollbar { width: 8px; height: 8px; }
		::-webkit-scrollbar-track { background: transparent; }
		::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
		::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); background-clip: padding-box; }

		/* ── Layout shell ────────────────────────────────────────────────────────── */
		body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); height: 100vh; display: flex; overflow: hidden; min-width: 720px; }
		.panel-left { flex: 1; min-width: 360px; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--asfx-border); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
		.panel-right { width: 340px; min-width: 300px; flex-shrink: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--vscode-editor-background); }
		#panelSplit { flex: 0 0 7px; cursor: col-resize; display: flex; justify-content: center; align-items: stretch; background: transparent; }
		#panelSplit span { width: 3px; border-radius: 2px; background: var(--asfx-border); transition: background 0.12s; }
		#panelSplit:hover span { background: var(--asfx-accent); }
		.panel-left .section { flex: 1; display: flex; flex-direction: column; min-height: 0; }
		/* Right panel becomes a header / scroll-body / sticky-footer column */
		.panel-right .section { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

		/* ── Section headers ─────────────────────────────────────────────────────── */
		.section-title { display: flex; align-items: center; gap: 8px; padding: 11px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--vscode-foreground); background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-inactiveSelectionBackground)); border-bottom: 1px solid var(--asfx-border); flex-shrink: 0; user-select: none; }
		.section-title .st-icon { font-size: 14px; line-height: 1; }
		.section-title .st-spacer { flex: 1; }

		/* ── Tree toolbar ────────────────────────────────────────────────────────── */
		.tree-search-row { padding: 9px 12px; border-bottom: 1px solid var(--asfx-border); display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
		.btn-tree-toolbar { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; font-size: 11px; cursor: pointer; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); border: 1px solid transparent; border-radius: var(--asfx-radius-sm); flex-shrink: 0; opacity: 0.75; transition: opacity 0.12s, background 0.12s, border-color 0.12s; }
		.btn-tree-toolbar:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--asfx-border); }
		.btn-select-deselect-all { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; font-size: 15px; line-height: 1; cursor: pointer; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); border: 1px solid transparent; border-radius: var(--asfx-radius-sm); flex-shrink: 0; opacity: 0.75; transition: opacity 0.12s, background 0.12s, border-color 0.12s; }
		.btn-select-deselect-all:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--asfx-border); }
		.btn-select-deselect-all .btn-select-deselect-icon { display: inline-block; }
		.tree-search-input { flex: 1; min-width: 80px; padding: 6px 10px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); outline: none; font-family: inherit; transition: border-color 0.12s; }
		.tree-search-input::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
		.tree-search-input:focus { border-color: var(--vscode-focusBorder); }
		.tree-filter-only-selected { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; flex-shrink: 0; cursor: pointer; user-select: none; }
		.tree-filter-only-selected input { margin: 0; cursor: pointer; accent-color: var(--asfx-accent); }
		#sel-count-badge { display: none; font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; padding: 1px 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 9px; line-height: 1.5; }

		/* ── Metadata tree ───────────────────────────────────────────────────────── */
		.panel-left .tree-wrap { flex: 1; overflow-y: auto; padding: 8px 10px 12px; min-height: 0; }
		.tree-wrap { padding: 6px 8px; }
		.tree-wrap > p { padding: 16px; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; text-align: center; }
		.tree-node { margin: 1px 0; }
		.tree-node .node-children { margin-left: 18px; border-left: 1px solid var(--vscode-tree-inactiveIndentGuidesStroke, rgba(128,128,128,0.18)); padding-left: 8px; }
		.tree-node .package-children { margin-left: 8px; padding-left: 8px; }
		.tree-node .package-row, .tree-node .folder-row { display: flex; align-items: center; gap: 2px; border-radius: var(--asfx-radius-sm); }
		.tree-node .folder-row .row-label, .tree-node .package-row .row-label { flex: 1; cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: var(--asfx-radius-sm); min-width: 0; }
		.tree-node .folder-row .row-label:hover, .tree-node .package-row .row-label:hover { background: var(--vscode-list-hoverBackground); }
		.folder-icon { display: inline-block; width: 1.1em; font-size: 14px; flex-shrink: 0; }
		.tree-node .package-row .folder-icon { color: var(--vscode-textLink-foreground); }
		.tree-node .package-row { background: var(--asfx-card-bg); border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius-sm); margin: 7px 0 3px; padding: 2px 4px; font-weight: 600; }
		.tree-node .package-row .label-text { font-weight: 600; }
		.tree-node label.file-node { cursor: pointer; display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: var(--asfx-radius-sm); min-width: 0; }
		.tree-node label.file-node:hover { background: var(--vscode-list-hoverBackground); }
		.label-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.file-icon { display: inline-block; width: 1.1em; font-size: 13px; flex-shrink: 0; color: var(--vscode-icon-foreground); }
		.tree-node input[type="checkbox"] { flex-shrink: 0; width: 14px; height: 14px; accent-color: var(--asfx-accent); cursor: pointer; }
		.btn-toggle { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; font-size: 10px; cursor: pointer; background: transparent; color: var(--vscode-descriptionForeground); border: none; border-radius: var(--asfx-radius-sm); flex-shrink: 0; opacity: 0; margin-left: auto; transition: opacity 0.12s; }
		.tree-node .package-row:hover .btn-toggle, .tree-node .folder-row:hover .btn-toggle { opacity: 0.75; }
		.btn-toggle:hover { opacity: 1 !important; background: var(--vscode-list-hoverBackground); }

		/* ── Right column structure ──────────────────────────────────────────────── */
		.rp-body { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px; display: flex; flex-direction: column; gap: var(--asfx-gap); min-height: 0; }
		.rp-footer { flex-shrink: 0; border-top: 1px solid var(--asfx-border); background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }

		/* ── Cards ───────────────────────────────────────────────────────────────── */
		.card { background: var(--asfx-card-bg); border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); padding: 14px; display: flex; flex-direction: column; gap: 12px; flex-shrink: 0; }
		.card-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px; }

		/* ── Form fields ─────────────────────────────────────────────────────────── */
		.field-row { display: flex; flex-direction: column; gap: 5px; }
		.field-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--vscode-descriptionForeground); }
		.field-row select { width: 100%; padding: 7px 9px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); font-size: 12.5px; outline: none; font-family: inherit; cursor: pointer; transition: border-color 0.12s; }
		.field-row select:focus { border-color: var(--vscode-focusBorder); }

		/* ── Test-level segmented pills ──────────────────────────────────────────── */
		.radio-group { display: flex; flex-wrap: wrap; gap: 6px; }
		.radio-group label { margin: 0; cursor: pointer; display: inline-flex; align-items: center; padding: 4px 11px; border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid var(--asfx-border-strong); background: var(--vscode-input-background); color: var(--vscode-foreground); user-select: none; transition: background 0.12s, border-color 0.12s, color 0.12s; }
		.radio-group label:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
		.radio-group label:has(input:checked) { background: var(--asfx-accent); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; box-shadow: var(--asfx-elevate); }
		.radio-group input[type="radio"] { display: none; }

		/* ── Test classes block ──────────────────────────────────────────────────── */
		.test-classes-block { display: none; max-height: 340px; overflow: hidden; flex-direction: column; gap: 0; }
		.test-classes-block.visible { display: flex; }
		.test-classes-block .subtitle { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
		.suite-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; flex-shrink: 0; }
		.suite-select { flex: 1; min-width: 0; }
		.test-search-row { padding: 0 0 8px 0; flex-shrink: 0; }
		.test-search-row .tree-search-input { width: 100%; }
		.test-list { flex: 1; overflow-y: auto; border: 1px solid var(--vscode-input-border, var(--asfx-border)); border-radius: var(--asfx-radius-sm); padding: 6px; background: var(--vscode-input-background); min-height: 120px; }
		.test-list .tree-node { margin: 1px 0; }
		.test-list .folder-row, .test-list .file-node { display: flex; align-items: center; gap: 7px; padding: 3px 5px; border-radius: var(--asfx-radius-sm); cursor: pointer; }
		.test-list .folder-row:hover, .test-list .file-node:hover { background: var(--vscode-list-hoverBackground); }
		.test-list .row-label { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; cursor: pointer; }
		.test-list .folder-icon, .test-list .file-icon { flex-shrink: 0; font-size: 13px; }
		.test-list .node-children { margin-left: 18px; }
		.test-list input[type="checkbox"] { flex-shrink: 0; width: 14px; height: 14px; accent-color: var(--asfx-accent); cursor: pointer; }
		.test-list .btn-toggle { opacity: 0.6; }
		.test-list .folder-row:hover .btn-toggle, .test-list .package-row:hover .btn-toggle { opacity: 0.9; }

		/* ── Deployment options ──────────────────────────────────────────────────── */
		.git-section { gap: 10px; }
		.opt-toggle, .auto-git-label { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--vscode-foreground); cursor: pointer; user-select: none; line-height: 1.4; }
		.opt-toggle input, .auto-git-label input { margin: 1px 0 0; cursor: pointer; accent-color: var(--asfx-accent); flex-shrink: 0; width: 14px; height: 14px; }
		.opt-toggle .opt-sub, .auto-git-label .opt-sub { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
		.btn-git-select { display: inline-flex; align-items: center; justify-content: center; gap: 6px; align-self: flex-start; padding: 5px 11px; font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--asfx-border-strong); border-radius: var(--asfx-radius-sm); font-family: inherit; transition: background 0.12s, border-color 0.12s; }
		.btn-git-select:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
		.btn-git-select::before { content: '⑂'; font-size: 13px; opacity: 0.9; }
		.opt-divider { height: 1px; background: var(--asfx-border); margin: 2px 0; border: 0; }

		/* ── Footer: status + actions ────────────────────────────────────────────── */
		.deploy-status { padding: 9px 14px; font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.45; flex-shrink: 0; }
		.actions-row { padding: 0 14px 14px; display: flex; gap: 8px; align-items: stretch; flex-shrink: 0; }
		.btn-save-preset { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--asfx-border-strong); border-radius: var(--asfx-radius-sm); white-space: nowrap; font-family: inherit; transition: background 0.12s, border-color 0.12s; }
		.btn-save-preset:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
		.deploy-btn { flex: 1; padding: 7px 14px; font-size: 12.5px; font-weight: 600; background: var(--asfx-accent); color: var(--vscode-button-foreground); border: 1px solid transparent; border-radius: var(--asfx-radius-sm); cursor: pointer; font-family: inherit; transition: filter 0.12s; }
		.deploy-btn:hover { filter: brightness(1.1); }
		.deploy-btn:active { filter: brightness(0.95); }

		/* ── Result / coverage / status (in scroll body) ─────────────────────────── */
		.deploy-result-bar { display: none; padding: 11px 13px; font-size: 12px; font-weight: 500; border-left: 3px solid transparent; border-radius: var(--asfx-radius-sm); line-height: 1.5; flex-shrink: 0; background: var(--asfx-card-bg); border: 1px solid var(--asfx-border); }
		.deploy-result-bar.running { border-left: 3px solid var(--vscode-progressBar-background); background: color-mix(in srgb, var(--vscode-progressBar-background) 12%, var(--asfx-card-bg)); }
		.deploy-result-bar.success { border-left: 3px solid var(--asfx-ok); background: color-mix(in srgb, var(--asfx-ok) 12%, var(--asfx-card-bg)); }
		.deploy-result-bar.failure { border-left: 3px solid var(--asfx-err); background: color-mix(in srgb, var(--asfx-err) 12%, var(--asfx-card-bg)); }

		/* ── Coverage panel ──────────────────────────────────────────────────────── */
		.coverage-panel { flex-shrink: 0; border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); overflow: hidden; background: var(--asfx-card-bg); }
		.coverage-toggle { padding: 10px 13px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 7px; user-select: none; color: var(--vscode-foreground); font-weight: 600; }
		.coverage-toggle:hover { background: var(--vscode-list-hoverBackground); }
		.cov-avg { font-weight: 700; font-variant-numeric: tabular-nums; }
		.cov-chev { margin-left: auto; opacity: 0.55; font-size: 10px; }
		.coverage-list { padding: 2px 10px 10px; }
		.cov-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 7px; border-radius: var(--asfx-radius-sm); font-size: 11.5px; margin: 1px 0; }
		.cov-row:hover { background: var(--vscode-list-hoverBackground); }
		.cov-name { font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; opacity: 0.88; }
		.cov-pct { font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 10px; flex-shrink: 0; }
		.cov-green { color: var(--asfx-ok); }
		.cov-amber { color: var(--asfx-warn); }
		.cov-red { color: var(--asfx-err); }

		/* ── Test suite buttons ──────────────────────────────────────────────────── */
		.btn-suite { display: inline-flex; align-items: center; justify-content: center; padding: 6px 11px; font-size: 11.5px; cursor: pointer; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); border: 1px solid var(--asfx-border-strong); border-radius: var(--asfx-radius-sm); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-family: inherit; white-space: nowrap; flex-shrink: 0; transition: background 0.12s, border-color 0.12s; }
		.btn-suite:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
		.btn-suite-delete { color: var(--asfx-err); }

		/* ── Modals ──────────────────────────────────────────────────────────────── */
		.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(1px); }
		.modal-box { background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--asfx-border); border-radius: var(--asfx-radius); padding: 20px 22px; min-width: 300px; max-width: 380px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); }
		.modal-box p { margin: 0 0 16px 0; font-size: 13px; line-height: 1.55; }
		.modal-buttons { display: flex; gap: 8px; justify-content: flex-end; }
		.modal-btn { padding: 7px 15px; cursor: pointer; border-radius: var(--asfx-radius-sm); border: 1px solid var(--asfx-border-strong); font-size: 12px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-family: inherit; transition: background 0.12s; }
		.modal-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
		.modal-save { background: var(--asfx-accent); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
		.modal-save:hover { filter: brightness(1.12); background: var(--asfx-accent); }
	</style>
</head>
<body>
	<div class="panel-left">
		<div class="section">
			<div class="section-title"><span class="st-icon" aria-hidden="true">📦</span><span>Metadata to deploy</span></div>
			<div class="tree-search-row">
				<button type="button" class="btn-tree-toolbar" id="btn-expand-all" title="Expand all" aria-label="Expand all">▼</button>
				<button type="button" class="btn-tree-toolbar" id="btn-collapse-all" title="Collapse all" aria-label="Collapse all">▶</button>
				<button type="button" class="btn-select-deselect-all" id="btn-select-deselect-all" title="Select all" aria-label="Select all"><span class="btn-select-deselect-icon" aria-hidden="true">☑</span></button>
				<input type="text" id="tree-search" class="tree-search-input" placeholder="Search metadata…" aria-label="Search metadata files" />
				<label class="tree-filter-only-selected"><input type="checkbox" id="filter-only-selected" aria-label="Only show selected" /> Selected <span id="sel-count-badge"></span></label>
			</div>
			<div class="tree-wrap" id="tree-wrap"></div>
		</div>
	</div>
	<div id="panelSplit" title="Drag to resize"><span></span></div>
	<div class="panel-right">
		<div class="section">
			<div class="section-title"><span class="st-icon" aria-hidden="true">⚡</span><span>Deployment</span></div>
			<div class="rp-body">
				<div class="card">
					<div class="field-row">
						<label class="field-label" for="org-select">Target org</label>
						<select id="org-select"></select>
					</div>
					<div class="field-row">
						<label class="field-label" for="preset-select">Preset</label>
						<select id="preset-select"><option value="">— None —</option></select>
					</div>
					<div class="field-row">
						<span class="field-label">Test level</span>
						<div class="radio-group" id="test-level">
							${testLevels.map((t) => `<label><input type="radio" name="testLevel" value="${t.value}"> ${t.label}</label>`).join("")}
						</div>
					</div>
				</div>
				<div class="card test-classes-block" id="specified-tests-wrap">
					<div class="subtitle"><span aria-hidden="true">🧪</span> Test classes</div>
					<div class="suite-row">
						<select id="suite-select" class="tree-search-input suite-select" aria-label="Test suite"></select>
						<button type="button" id="btn-save-suite" class="btn-suite" title="Save selected tests as a named suite">Save suite</button>
						<button type="button" id="btn-delete-suite" class="btn-suite btn-suite-delete" title="Delete this suite" style="display:none;">🗑</button>
					</div>
					<div class="test-search-row"><input type="text" id="test-search" class="tree-search-input" placeholder="Search tests…" aria-label="Search test classes" /></div>
					<div class="test-list" id="test-list"></div>
				</div>
				<div class="card git-section">
					<div class="card-title">Options</div>
					<label class="auto-git-label" title="Validate the deployment without saving changes to the org (check-only / dry run)">
						<input type="checkbox" id="validate-only-check" aria-label="Validate only (dry run)">
						<span>Validate only (dry run)<span class="opt-sub">Check the deployment against the org without committing changes</span></span>
					</label>
					<hr class="opt-divider">
					<label class="auto-git-label" title="Auto-watch file saves and update Git selection">
						<input type="checkbox" id="auto-git-select" aria-label="Auto select changed files in Git">
						<span>Auto-select Git changes<span class="opt-sub">Watch file saves and update the selection automatically</span></span>
					</label>
					<button type="button" class="btn-git-select" id="btn-git-select" title="Select files changed in Git">Select changed (Git)</button>
				</div>
				<div class="deploy-result-bar" id="deploy-result-bar"></div>
				<div id="coverage-panel" class="coverage-panel" style="display:none;"></div>
			</div>
			<div class="rp-footer">
				<div class="deploy-status" id="deploy-status"></div>
				<div class="actions-row">
					<button type="button" class="btn-save-preset" id="btn-save-preset" title="Save current options as preset">💾 Save preset</button>
					<button class="deploy-btn" id="deploy-btn">⚡ Deploy</button>
				</div>
			</div>
		</div>
	</div>
	<div id="preset-modal-overlay" class="modal-overlay" style="display:none;">
		<div class="modal-box">
			<p id="preset-modal-message"></p>
			<div class="modal-buttons">
				<button type="button" class="modal-btn modal-save" id="preset-modal-save">Save</button>
				<button type="button" class="modal-btn modal-dont-save" id="preset-modal-dont">Don't save</button>
				<button type="button" class="modal-btn modal-cancel" id="preset-modal-cancel">Cancel</button>
			</div>
		</div>
	</div>
	<div id="new-preset-modal-overlay" class="modal-overlay" style="display:none;">
		<div class="modal-box">
			<p>Enter name for new preset:</p>
			<input type="text" id="new-preset-name-input" class="tree-search-input" placeholder="Preset name" style="margin: 8px 0 16px 0; width: 100%;" />
			<div class="modal-buttons">
				<button type="button" class="modal-btn modal-save" id="new-preset-modal-save">Save</button>
				<button type="button" class="modal-btn modal-cancel" id="new-preset-modal-cancel">Cancel</button>
			</div>
		</div>
	</div>
	<script>
		var treeData = [], testClassesData = [], presetsData = [], initialPreset = null, orgsData = [], defaultOrgVal = '';
		var testSuitesData = [];
		var lastRenderedTreeData = null;
		var extraPaths = [], loadedPresetName = null, dirty = false, pendingPresetIndex = null;
		// Persistent selection snapshot — survives filter/re-render cycles.
		// Contains normalized leaf file paths that are currently selected.
		// Single source of truth; DOM is restored from this on every re-render.
		var _selSS = new Set();
		var vsCodeApi = null;
		try { if (typeof acquireVsCodeApi !== 'undefined') vsCodeApi = acquireVsCodeApi(); } catch (e) { console.error('acquireVsCodeApi failed', e); }
		function postToHost(payload) { try { if (vsCodeApi) vsCodeApi.postMessage(payload); } catch (err) { console.error('postMessage failed', err); } }
		// ── panel-right (sidebar) horizontal resizer ─────────────────────────────
		(function(){
			var sp = document.getElementById('panelSplit');
			var right = document.querySelector('.panel-right');
			if (!sp || !right) return;
			var drag = false, sx = 0, sw = 0;
			sp.addEventListener('mousedown', function(e){ drag = true; sx = e.clientX; sw = right.getBoundingClientRect().width; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
			window.addEventListener('mousemove', function(e){ if (!drag) return; var max = Math.max(300, window.innerWidth - 360); right.style.width = Math.min(max, Math.max(300, sw + (sx - e.clientX))) + 'px'; });
			window.addEventListener('mouseup', function(){ drag = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
		})();
		var saveStateTimer = null;
		function saveState() {
			try {
				var s = getCurrentPresetState();
				var searchEl = safeGet('tree-search');
				var filterEl = safeGet('filter-only-selected');
				var autoGitEl = safeGet('auto-git-select');
				var validateEl = safeGet('validate-only-check');
				var suiteEl = safeGet('suite-select');
				var state = {
					sourcePaths: s.sourcePaths,
					presetName: loadedPresetName || null,
					deployType: s.deployType,
					testClassNames: s.testClassNames || [],
					targetOrg: s.targetOrg || null,
					treeSearch: (searchEl && searchEl.value) ? searchEl.value : '',
					filterOnlySelected: !!(filterEl && filterEl.checked),
					autoGitSelect: !!(autoGitEl && autoGitEl.checked),
					validateOnly: !!(validateEl && validateEl.checked),
					testSuiteName: (suiteEl && suiteEl.value) ? suiteEl.value : null
				};
				if (vsCodeApi && typeof vsCodeApi.setState === 'function') vsCodeApi.setState(state);
				postToHost({ command: 'persistPanelState', state: state });
			} catch (e) { console.error('saveState failed', e); }
		}
		function scheduleSaveState() {
			clearTimeout(saveStateTimer);
			saveStateTimer = setTimeout(saveState, 400);
		}
		// Persist selection when user leaves the tab so it's not lost on revive
		document.addEventListener('visibilitychange', function() {
			if (document.hidden) {
				clearTimeout(saveStateTimer);
				saveStateTimer = null;
				saveState();
			}
		});
		function restoreState(state) {
			if (!state || !Array.isArray(state.sourcePaths)) return;
			loadedPresetName = state.presetName || null;
			extraPaths = [];
			document.querySelectorAll('.path-check').forEach(function(cb) { cb.checked = false; });
			var pathSet = new Set((state.sourcePaths || []).map(norm));
			pathSet.forEach(function(p) {
				document.querySelectorAll('.path-check').forEach(function(cb) {
					var nodePath = norm(cb.getAttribute('data-path'));
					if (nodePath !== p) return;
					cb.checked = true;
					if (cb.classList.contains('folder-check')) {
						var folderNode = cb.closest('.folder-node, .package-node');
						if (folderNode) checkFolderAndDescendants(folderNode);
					}
				});
			});
			pathSet.forEach(function(p) {
				var found = false;
				document.querySelectorAll('.path-check').forEach(function(cb) { if (norm(cb.getAttribute('data-path')) === p) found = true; });
				if (!found) extraPaths.push(p);
			});
			var deployType = state.deployType || 'NoTestRun';
			var legacyValidate = false;
			// Legacy: "ValidateOnly" used to be a test level — migrate it to the dry-run option.
			if (deployType === 'ValidateOnly') { legacyValidate = true; deployType = 'NoTestRun'; }
			var radio = document.querySelector('input[name="testLevel"][value="' + deployType + '"]');
			if (radio) { radio.checked = true; var w = safeGet('specified-tests-wrap'); if (w) w.classList.toggle('visible', deployType === 'RunSpecifiedTests'); }
			document.querySelectorAll('.test-class').forEach(function(cb) { cb.checked = Array.isArray(state.testClassNames) && state.testClassNames.indexOf(cb.value) !== -1; });
			var orgSel = safeGet('org-select');
			if (orgSel && state.targetOrg) { var found = Array.from(orgSel.options).find(function(o){ return o.value === state.targetOrg; }); if (found) orgSel.value = state.targetOrg; }
			var presetSel = safeGet('preset-select');
			if (presetSel && loadedPresetName) {
				var idx = (presetsData || []).findIndex(function(p){ return p.name === loadedPresetName; });
				if (idx >= 0) presetSel.value = String(idx); else presetSel.value = '';
			}
			document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
			updateSelectAllButtonState();
			var searchEl = safeGet('tree-search');
			if (searchEl && state.hasOwnProperty('treeSearch')) searchEl.value = state.treeSearch || '';
			var filterEl = safeGet('filter-only-selected');
			if (filterEl && state.hasOwnProperty('filterOnlySelected')) filterEl.checked = !!state.filterOnlySelected;
			var autoGitEl = safeGet('auto-git-select');
			if (autoGitEl && state.hasOwnProperty('autoGitSelect')) {
				autoGitEl.checked = !!state.autoGitSelect;
				// FileSystemWatcher is managed host-side; no timer needed here.
			}
			var validateEl = safeGet('validate-only-check');
			if (validateEl) validateEl.checked = legacyValidate || !!state.validateOnly;
			var suiteEl = safeGet('suite-select');
			if (suiteEl && state.testSuiteName) {
				suiteEl.value = state.testSuiteName;
				var delBtn = safeGet('btn-delete-suite');
				if (delBtn) delBtn.style.display = suiteEl.value ? '' : 'none';
			}
			// Rebuild persistent snapshot from restored leaf checkboxes + extra paths
			_selSS = new Set();
			document.querySelectorAll('.path-check:not(.folder-check):checked').forEach(function(cb) {
				var p = norm(cb.getAttribute('data-path') || '');
				if (p) _selSS.add(p);
			});
			extraPaths.forEach(function(p) { var np = norm(p); if (np) _selSS.add(np); });
			filterTree();
			updateSelectionStatus();
		}

		function safeGet(id) { return document.getElementById(id); }
		function norm(p) {
			if (!p) return '';
			var s = p.trim().replace(/\\\\/g, '/').replace(/^\\.\\//, '');
			return s.split('/').filter(Boolean).join('/');
		}
		function setDirty() { dirty = true; scheduleSaveState(); }

		function pathToMetadataType(path) {
			if (!path) return 'Other';
			var p = path.toLowerCase();
			var last = p.split('/').pop() || '';
			if (last.endsWith('.cls') || p.includes('.cls-meta.xml')) return 'Apex Class';
			if (last.endsWith('.trigger') || p.includes('.trigger-meta.xml')) return 'Apex Trigger';
			if (p.includes('.object-meta.xml') || p.includes('/objects/')) return 'Custom Object';
			if (p.includes('.layout-meta.xml') || p.includes('/layouts/')) return 'Layout';
			if (last.endsWith('.page') || p.includes('.page-meta.xml')) return 'Apex Page';
			if (p.includes('/aura/') || (p.includes('.component-meta.xml') && p.includes('aura'))) return 'Aura Component';
			if (p.includes('.app-meta.xml')) return 'Aura App';
			if (p.includes('/lwc/')) return 'LWC';
			if (p.includes('.flow-meta.xml') || p.includes('.flowdefinition-meta.xml')) return 'Flow';
			if (p.includes('.permissionset-meta.xml')) return 'Permission Set';
			if (p.includes('.profile-meta.xml')) return 'Profile';
			if (p.includes('.custommetadata-meta.xml')) return 'Custom Metadata';
			if (p.includes('.tab-meta.xml')) return 'Tab';
			if (p.includes('.flexipage-meta.xml')) return 'Flexi Page';
			if (p.includes('.labels-meta.xml')) return 'Custom Labels';
			if (p.includes('.workflow-meta.xml')) return 'Workflow';
			if (p.includes('.report-meta.xml')) return 'Report';
			if (p.includes('.dashboard-meta.xml')) return 'Dashboard';
			if (p.includes('.field-meta.xml')) return 'Custom Field';
			if (p.includes('.customapplication-meta.xml')) return 'Custom App';
			if (p.includes('.connectedapp-meta.xml')) return 'Connected App';
			if (p.includes('.namedcredential-meta.xml')) return 'Named Credential';
			if (p.includes('.duplicaterule-meta.xml')) return 'Duplicate Rule';
			if (p.includes('.matchingrule-meta.xml')) return 'Matching Rule';
			if (p.includes('.reporttype-meta.xml')) return 'Report Type';
			if (last === 'classes' || p.endsWith('/classes')) return 'Apex Class';
			if (last === 'triggers' || p.endsWith('/triggers')) return 'Apex Trigger';
			if (last === 'objects' || p.endsWith('/objects')) return 'Custom Object';
			if (last === 'layouts' || p.endsWith('/layouts')) return 'Layout';
			if (last === 'flows' || p.endsWith('/flows')) return 'Flow';
			if (last === 'aura' || p.endsWith('/aura')) return 'Aura';
			if (last === 'lwc' || p.endsWith('/lwc')) return 'LWC';
			return 'Other';
		}

		function updateSelectionStatus() {
			var statusEl = safeGet('deploy-status');
			if (!statusEl) return;
			// Count: use _selSS (leaf paths, includes items hidden by filter) + extra paths not already in snapshot
			var totalCount = _selSS.size + extraPaths.filter(function(p) { return !_selSS.has(norm(p)); }).length;
			var badge = safeGet('sel-count-badge');
			if (badge) { badge.textContent = totalCount > 0 ? String(totalCount) : ''; badge.style.display = totalCount > 0 ? 'inline' : 'none'; }
			var paths = [];
			document.querySelectorAll('.path-check:checked').forEach(function(cb) { paths.push(cb.getAttribute('data-path')); });
			if (totalCount === 0) { statusEl.textContent = 'Ready. No metadata selected.'; return; }
			var byType = {};
			document.querySelectorAll('.path-check:checked').forEach(function(cb) {
				if (cb.classList.contains('folder-check')) return;
				var p = cb.getAttribute('data-path');
				if (!p) return;
				var t = pathToMetadataType(p);
				byType[t] = (byType[t] || 0) + 1;
			});
			var plural = { 'Apex Class': 'Apex classes', 'Apex Trigger': 'Apex triggers', 'Custom Object': 'Custom objects', 'Layout': 'Layouts', 'Apex Page': 'Apex pages', 'Aura Component': 'Aura components', 'Aura App': 'Aura apps', 'Flow': 'Flows', 'Permission Set': 'Permission sets', 'Profile': 'Profiles', 'Custom Metadata': 'Custom metadata', 'Tab': 'Tabs', 'Flexi Page': 'Flexi pages', 'Custom Labels': 'Custom labels', 'Report': 'Reports', 'Dashboard': 'Dashboards', 'Custom Field': 'Custom fields', 'Custom App': 'Custom apps', 'Connected App': 'Connected apps', 'Named Credential': 'Named credentials', 'Duplicate Rule': 'Duplicate rules', 'Matching Rule': 'Matching rules', 'Report Type': 'Report types', 'Workflow': 'Workflows', 'LWC': 'LWC', 'Other': 'Other' };
			var parts = [];
			var order = ['Apex Class', 'Apex Trigger', 'Custom Object', 'Layout', 'Apex Page', 'LWC', 'Aura Component', 'Aura App', 'Flow', 'Permission Set', 'Profile', 'Custom Metadata', 'Tab', 'Flexi Page', 'Custom Labels', 'Report', 'Dashboard', 'Custom Field', 'Custom App', 'Connected App', 'Named Credential', 'Duplicate Rule', 'Matching Rule', 'Report Type', 'Workflow', 'Other'];
			order.forEach(function(t) {
				if (!byType[t]) return;
				var label = (byType[t] === 1 ? t : (plural[t] || t + 's'));
				parts.push(byType[t] + ' ' + label);
			});
			Object.keys(byType).forEach(function(t) { if (order.indexOf(t) === -1) parts.push(byType[t] + ' ' + (byType[t] === 1 ? t : (plural[t] || t + 's'))); });
			var testLevel = (document.querySelector('input[name="testLevel"]:checked') || {}).value;
			if (testLevel === 'RunSpecifiedTests') {
				var testCount = document.querySelectorAll('.test-class:checked').length;
				parts.push(testCount === 1 ? '1 test to run' : testCount + ' tests to run');
			}
			statusEl.textContent = 'Ready. ' + (parts.length ? parts.join(', ') + '.' : 'No metadata selected.');
		}

		function getSelectedPathSet() {
			var set = new Set();
			document.querySelectorAll('.path-check:checked').forEach(function(cb) {
				var p = (cb.getAttribute('data-path') || '').replace(/\\\\/g, '/').trim();
				if (p) set.add(p);
			});
			return set;
		}
		function getAllPathsFromTreeData(data) {
			var paths = [];
			function walk(nodes) {
				if (!nodes || !nodes.length) return;
				nodes.forEach(function(n) {
					if (n.path) paths.push(n.path);
					if (n.children && n.children.length) walk(n.children);
				});
			}
			(data || []).forEach(function(pkg) {
				if (pkg.path) paths.push(pkg.path);
				if (pkg.children && pkg.children.length) walk(pkg.children);
			});
			return paths;
		}
		function getLeafPathsFromTreeData(data) {
			var paths = [];
			function walk(nodes) {
				if (!nodes || !nodes.length) return;
				nodes.forEach(function(n) {
					if (!n.children || n.children.length === 0) { if (n.path) paths.push(n.path); return; }
					walk(n.children);
				});
			}
			(data || []).forEach(function(pkg) {
				if (!pkg.children || pkg.children.length === 0) { if (pkg.path) paths.push(pkg.path); return; }
				walk(pkg.children);
			});
			return paths;
		}
		function expandToFilePathsForDeploy(minimalPaths) {
			if (!minimalPaths || !minimalPaths.length) return [];
			var leaves = getLeafPathsFromTreeData(treeData || []);
			var leafSet = new Set(leaves.map(norm));
			var out = new Set();
			minimalPaths.forEach(function(p) {
				var q = norm(p);
				if (leafSet.has(q)) { out.add(q); return; }
				var under = leaves.filter(function(leaf) { var l = norm(leaf); return l === q || l.indexOf(q + '/') === 0; });
				if (under.length) under.forEach(function(leaf) { out.add(norm(leaf)); });
				else out.add(q);
			});
			return Array.from(out);
		}
		function matchGitPathsToTreePaths(gitPaths, treePaths) {
			var pathSet = new Set((gitPaths || []).map(norm));
			var matched = new Set();
			var exact = 0, byBasename = 0;
			var normTree = function(p) { return (p || '').replace(/\\\\/g, '/').trim(); };
			(treePaths || []).forEach(function(tp) {
				var p = normTree(tp);
				if (pathSet.has(p)) { matched.add(p); pathSet.delete(p); exact++; }
			});
			pathSet.forEach(function(gitPath) {
				var base = (gitPath.split('/').pop() || '').trim();
				if (!base) return;
				var found = (treePaths || []).find(function(tp) {
					var nodePath = normTree(tp);
					return !matched.has(nodePath) && nodePath.split('/').pop() === base;
				});
				if (found) { var p = normTree(found); matched.add(p); pathSet.delete(gitPath); byBasename++; }
			});
			return { matched: matched, matchedExact: exact, matchedByBasename: byBasename };
		}
		function filterTreeDataToVisible(nodes, search, onlySelected, selectedSet) {
			if (!nodes || !nodes.length) return [];
			return nodes.map(function(node) {
				if (!node.children || node.children.length === 0) {
					var pathNorm = (node.path || '').replace(/\\\\/g, '/').toLowerCase();
					var matchSearch = !search || pathNorm.indexOf(search) !== -1;
					var pathOrig = (node.path || '').replace(/\\\\/g, '/').trim();
					var matchSelected = !onlySelected || selectedSet.has(pathOrig);
					if (!matchSearch || !matchSelected) return null;
					return { label: node.label, path: node.path };
				}
				var filteredChildren = filterTreeDataToVisible(node.children, search, onlySelected, selectedSet);
				if (filteredChildren.length === 0) return null;
				return { label: node.label, path: node.path, children: filteredChildren };
			}).filter(Boolean);
		}
		/** Inline folders with 0 or 1 child into their parent (filter may leave such folders); then collapse single-child chains. */
		function mergeFewChildFoldersIntoParent(nodes) {
			if (!nodes || !nodes.length) return nodes;
			return nodes.map(function(node) {
				if (!node.children || node.children.length === 0) return node;
				var children = mergeFewChildFoldersIntoParent(node.children);
				var newChildren = [];
				children.forEach(function(c) {
					if (!c.children) { newChildren.push(c); return; }
					if (c.children.length === 0) return;
					if (c.children.length === 1) {
						newChildren.push(c.children[0]);
					} else {
						newChildren.push(c);
					}
				});
				return { label: node.label, path: node.path, children: newChildren };
			});
		}
		function collapseSingleChildInTree(nodes) {
			if (!nodes || !nodes.length) return nodes;
			return nodes.map(function(node) {
				if (!node.children || node.children.length === 0) return node;
				if (node.children.length !== 1) {
					return { label: node.label, path: node.path, children: collapseSingleChildInTree(node.children) };
				}
				var only = node.children[0];
				if (!only.children || only.children.length === 0) return { label: node.label, path: node.path, children: node.children };
				var collapsed = collapseSingleChildInTree([only])[0];
				return {
					label: node.label + '/' + collapsed.label,
					path: collapsed.path,
					children: collapsed.children || []
				};
			});
		}
		function filterTree() {
			var searchEl = safeGet('tree-search'), wrap = safeGet('tree-wrap');
			var onlySelected = (safeGet('filter-only-selected') && safeGet('filter-only-selected').checked) || false;
			if (!wrap) return;
			var search = (searchEl && searchEl.value) ? searchEl.value.trim().toLowerCase() : '';
			// Sync currently-visible leaf checkboxes into the persistent snapshot before any re-render.
			// This captures explicit unchecks on visible items while preserving selections on hidden items.
			document.querySelectorAll('#tree-wrap .path-check:not(.folder-check)').forEach(function(cb) {
				var p = norm(cb.getAttribute('data-path') || '');
				if (p) { if (cb.checked) _selSS.add(p); else _selSS.delete(p); }
			});
			if (!search && !onlySelected) {
				if (lastRenderedTreeData !== treeData) {
					renderTreeWithData(treeData, _selSS, false);
				} else {
					// Just un-hide everything; re-apply snapshot to nodes that were hidden.
					wrap.querySelectorAll('.package-node, .folder-node, .file-node').forEach(function(n) { n.style.display = ''; });
					wrap.querySelectorAll('.path-check:not(.folder-check)').forEach(function(cb) {
						var p = norm(cb.getAttribute('data-path') || '');
						if (p && _selSS.has(p)) cb.checked = true;
					});
					document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
					updateSelectAllButtonState();
					updateSelectionStatus();
				}
				return;
			}
			var filtered = (treeData || []).map(function(pkg) {
				var visibleChildren = filterTreeDataToVisible(pkg.children || [], search, onlySelected, _selSS);
				if (visibleChildren.length === 0) return null;
				visibleChildren = mergeFewChildFoldersIntoParent(visibleChildren);
				visibleChildren = collapseSingleChildInTree(visibleChildren);
				if (visibleChildren.length === 1 && visibleChildren[0].children) {
					var only = visibleChildren[0];
					return { label: pkg.label + '/' + only.label, path: only.path, children: only.children || [] };
				}
				return { label: pkg.label, path: pkg.path, children: visibleChildren };
			}).filter(Boolean);
			renderTreeWithData(filtered, _selSS, true);
		}

		function getMinimalSourcePaths() {
			var items = [];
			var domPaths = new Set();
			// Read visible selections from DOM (folders + leaves currently rendered)
			document.querySelectorAll('.path-check:checked').forEach(function(cb) {
				var p = cb.getAttribute('data-path');
				if (!p) return;
				var isFolder = cb.classList.contains('folder-check');
				var np = norm(p);
				domPaths.add(np);
				items.push({ path: np, isFolder: isFolder });
			});
			// Add leaf paths selected but currently hidden by the active filter
			_selSS.forEach(function(p) {
				if (!domPaths.has(p)) items.push({ path: p, isFolder: false });
			});
			// Extra paths: git/preset paths not matched to any tree node (not in _selSS)
			extraPaths.forEach(function(p) {
				var np = norm(p);
				if (!domPaths.has(np) && !_selSS.has(np)) items.push({ path: np, isFolder: false });
			});
			var onlyShowSelected = !!(safeGet('filter-only-selected') && safeGet('filter-only-selected').checked);
			if (onlyShowSelected) {
				return items.filter(function(x) { return !x.isFolder; }).map(function(x) { return x.path; });
			}
			var folderPaths = items.filter(function(x) { return x.isFolder; }).map(function(x) { return x.path; });
			var filePaths = items.filter(function(x) { return !x.isFolder; }).map(function(x) { return x.path; });
			var result = folderPaths.slice();
			filePaths.forEach(function(fp) {
				var underFolder = folderPaths.some(function(f) { return fp !== f && fp.indexOf(f + '/') === 0; });
				if (!underFolder) result.push(fp);
			});
			return result;
		}

		function getCurrentPresetState() {
			var sourcePaths = getMinimalSourcePaths();
			var deployType = (document.querySelector('input[name="testLevel"]:checked') || {}).value || 'NoTestRun';
			var testClassNames = deployType === 'RunSpecifiedTests' ? (function(){ var n=[]; document.querySelectorAll('.test-class:checked').forEach(function(c){ n.push(c.value); }); return n; })() : [];
			var sel = safeGet('org-select');
			return { sourcePaths: sourcePaths, deployType: deployType, testClassNames: testClassNames, targetOrg: sel && sel.value ? sel.value : undefined };
		}

		function applyChangedPaths(paths) {
			var allTreePaths = getAllPathsFromTreeData(treeData);
			var matchResult = matchGitPathsToTreePaths(paths, allTreePaths);
			var matchedTreePaths = matchResult.matched;
			// Merge matched paths into the persistent snapshot first
			matchedTreePaths.forEach(function(p) { _selSS.add(p); });
			var newSelectedSet = new Set(_selSS);
			var onlyShowSelected = !!(safeGet('filter-only-selected') && safeGet('filter-only-selected').checked);
			var searchEl = safeGet('tree-search');
			var search = (searchEl && searchEl.value) ? searchEl.value.trim().toLowerCase() : '';
			extraPaths = [];
			if (onlyShowSelected && matchedTreePaths.size > 0) {
				var filtered = (treeData || []).map(function(pkg) {
					var visibleChildren = filterTreeDataToVisible(pkg.children || [], search, true, newSelectedSet);
					if (visibleChildren.length === 0) return null;
					visibleChildren = mergeFewChildFoldersIntoParent(visibleChildren);
					visibleChildren = collapseSingleChildInTree(visibleChildren);
					if (visibleChildren.length === 1 && visibleChildren[0].children) {
						var only = visibleChildren[0];
						return { label: pkg.label + '/' + only.label, path: only.path, children: only.children || [] };
					}
					return { label: pkg.label, path: pkg.path, children: visibleChildren };
				}).filter(Boolean);
				lastRenderedTreeData = filtered;
				renderTreeWithData(filtered, newSelectedSet, true);
			} else {
				document.querySelectorAll('.path-check').forEach(function(cb) {
					var p = norm(cb.getAttribute('data-path'));
					if (newSelectedSet.has(p)) cb.checked = true;
				});
				document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
				updateSelectAllButtonState();
				updateSelectionStatus();
				filterTree();
			}
			var pathSet = new Set((paths || []).map(norm));
			matchedTreePaths.forEach(function(p) { pathSet.delete(p); });
			pathSet.forEach(function(gitPath) { extraPaths.push(gitPath); });
			return { total: (paths && paths.length) || 0, matchedExact: matchResult.matchedExact, matchedByBasename: matchResult.matchedByBasename, unmatched: extraPaths.length };
		}

		window.addEventListener('message', function(event) {
			var data = event.data;
			if (!data || !data.command) return;
			var statusEl = safeGet('deploy-status');
			if (data.command === 'deployStart') {
				var bar = safeGet('deploy-result-bar');
				if (bar) { bar.className = 'deploy-result-bar running'; bar.textContent = data.dryRun ? 'Validating…' : 'Deploying…'; bar.style.display = 'block'; }
				return;
			}
			if (data.command === 'testSuitesUpdated') {
				testSuitesData = data.suites || [];
				renderSuiteSelect();
				return;
			}
			if (data.command === 'deployResult') {
				var bar = safeGet('deploy-result-bar');
				if (!bar) return;
				var covPanel = safeGet('coverage-panel');
				if (data.cancelled) {
					bar.style.display = 'none';
					if (covPanel) { covPanel.style.display = 'none'; covPanel.innerHTML = ''; }
					return;
				}
				var success = !!data.success;
				bar.className = 'deploy-result-bar ' + (success ? 'success' : 'failure');
				var icon = success ? '✅' : '❌';
				var verb = data.dryRun ? (success ? 'Validation passed' : 'Validation failed') : (success ? 'Deploy succeeded' : 'Deploy failed');
				var parts = [icon + ' ' + verb];
				if (data.components > 0) parts.push(data.components + ' component' + (data.components !== 1 ? 's' : ''));
				if (data.componentErrors > 0) parts.push(data.componentErrors + ' error' + (data.componentErrors !== 1 ? 's' : ''));
				if (data.testsPassed > 0 || data.testsFailed > 0) {
					var tf = data.testsFailed > 0 ? (', ' + data.testsFailed + ' failed') : '';
					parts.push('Tests: ' + data.testsPassed + ' passed' + tf);
				}
				if (data.durationMs) { var s = Math.round(data.durationMs / 1000); parts.push(s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'); }
				bar.textContent = parts.join(' · ');
				bar.style.display = 'block';
				// ── Coverage table ───────────────────────────────────────────────────────
				if (covPanel) {
					var cov = (data.coverage && Array.isArray(data.coverage) && success) ? data.coverage : [];
					if (cov.length > 0) {
						var avg = Math.round(cov.reduce(function(acc, e) { return acc + e.pct; }, 0) / cov.length);
						var avgCls = avg < 75 ? 'cov-red' : avg < 85 ? 'cov-amber' : 'cov-green';
						covPanel.innerHTML = '<div class="coverage-toggle" id="cov-toggle">📊 Coverage — <span class="cov-avg ' + avgCls + '">' + avg + '%</span> avg <span class="cov-chev">▾</span></div><div class="coverage-list" id="cov-list">' +
							cov.map(function(e) { var c = e.pct < 75 ? 'cov-red' : e.pct < 85 ? 'cov-amber' : 'cov-green'; return '<div class="cov-row"><span class="cov-name">' + escapeHtml(e.name) + '</span><span class="cov-pct ' + c + '">' + e.pct + '%</span></div>'; }).join('') +
							'</div>';
						var togEl = document.getElementById('cov-toggle');
						if (togEl) togEl.onclick = function() { var l = document.getElementById('cov-list'); if (!l) return; var h = l.style.display === 'none'; l.style.display = h ? '' : 'none'; var ch = this.querySelector('.cov-chev'); if (ch) ch.textContent = h ? '▾' : '▸'; };
						covPanel.style.display = 'block';
					} else {
						covPanel.style.display = 'none';
						covPanel.innerHTML = '';
					}
				}
				return;
			}
			if (data.command === 'setChangedPaths') {
				if (data.error) { if (statusEl) statusEl.textContent = 'Git: ' + data.error; return; }
				var paths = data.paths || [];
				var stats = applyChangedPaths(paths);
				setDirty();
				saveState();
				if (!stats.total) {
					if (statusEl) statusEl.textContent = 'No changed files in Git.';
				} else {
					var m = stats.matchedExact + stats.matchedByBasename;
					if (m === 0) {
						if (statusEl) statusEl.textContent = 'Git: ' + stats.total + ' changed file(s). None matched the metadata tree (paths may be outside package dirs).';
					} else {
						var detail = [stats.matchedExact ? stats.matchedExact + ' exact' : '', stats.matchedByBasename ? stats.matchedByBasename + ' by name' : ''].filter(Boolean).join(', ');
						if (statusEl) statusEl.textContent = 'Git: ' + stats.total + ' changed. Selected ' + m + ' in tree' + (detail ? ' (' + detail + ').' : '.');
					}
				}
				return;
			}
			if (data.command === 'presetSaved') {
				dirty = false;
				if (data.name) loadedPresetName = data.name;
				if (data.presets && Array.isArray(data.presets)) { presetsData.length = 0; presetsData.push.apply(presetsData, data.presets); refreshPresetDropdown(); }
				if (data.error) {
					if (statusEl) statusEl.textContent = 'Preset save failed: ' + data.error;
				} else if (data.name) {
					if (statusEl) statusEl.textContent = data.isNew ? "Preset '" + data.name + "' saved." : "Preset '" + data.name + "' updated.";
				}
			}
		});

		function escapeHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
		function escapeAttr(s) { return (s || '').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

		function checkFolderAndDescendants(folderNode) {
			var folderCheck = folderNode.querySelector('.path-check.folder-check');
			if (folderCheck) folderCheck.checked = true;
			folderNode.querySelectorAll('.path-check').forEach(function(c) { c.checked = true; });
		}
		function applyPreset(preset) {
			if (!preset) return;
			loadedPresetName = preset.name;
			dirty = false;
			var pathSet = new Set(Array.isArray(preset.sourcePaths) ? preset.sourcePaths.map(norm) : []);
			extraPaths = [];
			var filterEl = safeGet('filter-only-selected');
			var searchEl = safeGet('tree-search');
			var savedOnlyShowSelected = !!(filterEl && filterEl.checked);
			var savedSearch = (searchEl && searchEl.value) ? searchEl.value : '';
			if (savedOnlyShowSelected || savedSearch) {
				if (filterEl) filterEl.checked = false;
				if (searchEl) searchEl.value = '';
				filterTree();
			}
			document.querySelectorAll('.path-check').forEach(function(cb) {
				cb.checked = false;
			});
			pathSet.forEach(function(p) {
				document.querySelectorAll('.path-check').forEach(function(cb) {
					var nodePath = norm(cb.getAttribute('data-path'));
					if (nodePath !== p) return;
					cb.checked = true;
					if (cb.classList.contains('folder-check')) {
						var folderNode = cb.closest('.folder-node, .package-node');
						if (folderNode) checkFolderAndDescendants(folderNode);
					}
				});
			});
			pathSet.forEach(function(p) {
				var found = false;
				document.querySelectorAll('.path-check').forEach(function(cb) {
					if (norm(cb.getAttribute('data-path')) === p) found = true;
				});
				if (!found) extraPaths.push(p);
			});
			var deployType = preset.deployType || 'NoTestRun';
			var presetValidate = false;
			if (deployType === 'ValidateOnly') { presetValidate = true; deployType = 'NoTestRun'; }
			var radio = document.querySelector('input[name="testLevel"][value="' + deployType + '"]');
			if (radio) { radio.checked = true; var w = safeGet('specified-tests-wrap'); if (w) w.classList.toggle('visible', deployType === 'RunSpecifiedTests'); }
			var presetValidateEl = safeGet('validate-only-check');
			if (presetValidateEl) presetValidateEl.checked = presetValidate;
			document.querySelectorAll('.test-class').forEach(function(cb) { cb.checked = Array.isArray(preset.testClassNames) && preset.testClassNames.indexOf(cb.value) !== -1; });
			var orgSel = safeGet('org-select');
			if (orgSel && preset.targetOrg) { var found = Array.from(orgSel.options).find(function(o){ return o.value === preset.targetOrg; }); if (found) orgSel.value = preset.targetOrg; }
			document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
			updateSelectAllButtonState();
			updateSelectionStatus();
			// Rebuild persistent snapshot from current leaf checkboxes + extra paths
			_selSS = new Set();
			document.querySelectorAll('.path-check:not(.folder-check):checked').forEach(function(cb) {
				var p = norm(cb.getAttribute('data-path') || '');
				if (p) _selSS.add(p);
			});
			extraPaths.forEach(function(p) { var np = norm(p); if (np) _selSS.add(np); });
			if (savedOnlyShowSelected || savedSearch) {
				if (filterEl) filterEl.checked = savedOnlyShowSelected;
				if (searchEl) searchEl.value = savedSearch;
				filterTree();
			}
			saveState();
		}

		function renderOrgSelect() {
			var sel = safeGet('org-select');
			if (!sel) return;
			if (!orgsData || orgsData.length === 0) { sel.innerHTML = '<option value="">No orgs found</option>'; return; }
			sel.innerHTML = orgsData.map(function(o) { return '<option value="' + escapeAttr(o.username) + '">' + escapeHtml(o.label) + '</option>'; }).join('');
			sel.value = defaultOrgVal || (orgsData[0] && orgsData[0].username) || '';
		}

		function refreshPresetDropdown() {
			var sel = safeGet('preset-select');
			if (!sel) return;
			var curVal = sel.value;
			sel.innerHTML = '<option value="">— None —</option>' + (presetsData || []).map(function(p, i) { return '<option value="' + i + '">' + escapeHtml(p.name) + '</option>'; }).join('');
			if (loadedPresetName) { var idx = (presetsData || []).findIndex(function(p){ return p.name === loadedPresetName; }); if (idx !== -1) sel.value = String(idx); } else sel.value = curVal || '';
		}

		function renderPresetSelect() {
			var sel = safeGet('preset-select');
			if (!sel) return;
			sel.innerHTML = '<option value="">— None —</option>' + (presetsData || []).map(function(p, i) { return '<option value="' + i + '">' + escapeHtml(p.name) + '</option>'; }).join('');
			sel.onchange = function() {
				var idx = this.value;
				var newIndex = idx === '' ? null : parseInt(idx, 10);
				if (dirty && loadedPresetName) {
					pendingPresetIndex = newIndex;
					var msg = safeGet('preset-modal-message');
					if (msg) msg.textContent = "Preset '" + loadedPresetName + "' was modified. Save changes?";
					var overlay = safeGet('preset-modal-overlay');
					if (overlay) overlay.style.display = 'flex';
					var curIdx = (presetsData || []).findIndex(function(p){ return p.name === loadedPresetName; });
					sel.value = curIdx >= 0 ? String(curIdx) : '';
					return;
				}
				loadedPresetName = null;
				dirty = false;
				if (idx === '') { extraPaths = []; return; }
				var p = presetsData[newIndex];
				if (p) applyPreset(p);
			};
			if (initialPreset) {
				var idx = (presetsData || []).findIndex(function(p){ return p.name === initialPreset.name; });
				if (idx !== -1) { sel.value = String(idx); applyPreset(presetsData[idx]); } else { applyPreset(initialPreset); }
			}
		}

		function finishPresetSwitch() {
			var sel = safeGet('preset-select');
			var idx = pendingPresetIndex;
			pendingPresetIndex = null;
			var overlay = safeGet('preset-modal-overlay');
			if (overlay) overlay.style.display = 'none';
			if (idx === null || idx === undefined) { loadedPresetName = null; extraPaths = []; if (sel) sel.value = ''; return; }
			var p = (presetsData || [])[idx];
			if (sel) sel.value = String(idx);
			if (p) applyPreset(p); else loadedPresetName = null;
		}

		function countNodes(n) {
			if (!n.children || n.children.length === 0) return 1;
			return 1 + n.children.reduce(function(s, c) { return s + countNodes(c); }, 0);
		}

		function renderNode(node) {
			var isFolder = Array.isArray(node.children);
			if (isFolder) {
				if (!node.children || node.children.length === 0) return '';
				var count = countNodes(node);
				var out = '<div class="tree-node folder-node">';
				out += '<div class="folder-row"><label class="row-label"><input type="checkbox" class="path-check folder-check" data-path="' + escapeAttr(node.path) + '"><span class="folder-icon" aria-hidden="true">📁</span><span class="label-text">' + escapeHtml(node.label) + ' (' + count + ')</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>';
				out += '<div class="node-children">';
				(node.children || []).forEach(function(c) { out += renderNode(c); });
				out += '</div></div>';
				return out;
			}
			return '<label class="tree-node file-node"><input type="checkbox" class="path-check" data-path="' + escapeAttr(node.path) + '"><span class="file-icon" aria-hidden="true">📄</span><span class="label-text">' + escapeHtml(node.label) + '</span></label>';
		}

		function updateFolderCheckboxState(folderNode) {
			var folderCheck = folderNode.querySelector('.path-check.folder-check');
			if (!folderCheck) return;
			var childrenContainer = folderNode.querySelector('.package-children, .node-children');
			var all = childrenContainer ? childrenContainer.querySelectorAll('.path-check') : [];
			var checked = childrenContainer ? childrenContainer.querySelectorAll('.path-check:checked') : [];
			var n = all.length;
			var c = checked.length;
			folderCheck.indeterminate = false;
			if (n === 0) {
				folderCheck.checked = false;
			} else if (c === 0) {
				folderCheck.checked = false;
			} else if (c === n) {
				folderCheck.checked = true;
			} else {
				folderCheck.checked = false;
				folderCheck.indeterminate = true;
			}
		}

		function updateAncestorCheckboxes(startFrom) {
			var el = startFrom;
			while (el) {
				var folder = el.closest('.folder-node, .package-node');
				if (!folder) break;
				updateFolderCheckboxState(folder);
				el = folder.parentElement;
			}
			updateSelectAllButtonState();
		}

		function updateSelectAllButtonState() {
			var btn = safeGet('btn-select-deselect-all');
			var iconSpan = btn && btn.querySelector('.btn-select-deselect-icon');
			if (!btn || !iconSpan) return;
			var wrap = safeGet('tree-wrap');
			if (!wrap) return;
			var all = wrap.querySelectorAll('.path-check');
			var checked = wrap.querySelectorAll('.path-check:checked');
			var allSelected = all.length > 0 && checked.length === all.length;
			if (allSelected) {
				iconSpan.textContent = '☐';
				btn.title = 'Deselect all';
				btn.setAttribute('aria-label', 'Deselect all');
			} else {
				iconSpan.textContent = '☑';
				btn.title = 'Select all';
				btn.setAttribute('aria-label', 'Select all');
			}
		}

		function buildTreeHtml(data) {
			if (!data || !data.length) return '<p>No metadata files found.</p>';
			var html = '';
			data.forEach(function(pkg) {
				var children = pkg.children || [];
				if (children.length === 0) return;
				var hasChildren = true;
				var pkgCount = 1 + children.reduce(function(s, c) { return s + countNodes(c); }, 0);
				html += '<div class="tree-node package-node">';
				html += '<div class="package-row"><label class="row-label"><input type="checkbox" class="path-check folder-check" data-path="' + escapeAttr(pkg.path) + '"><span class="folder-icon" aria-hidden="true">📂</span><span class="label-text">' + escapeHtml(pkg.label) + (hasChildren ? ' (' + pkgCount + ')' : '') + '</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>';
				html += '<div class="package-children">';
				children.forEach(function(c) { html += renderNode(c); });
				html += '</div></div>';
			});
			return html || '<p>No metadata files found in package directories.</p>';
		}
		function restoreCheckboxesFromSet(checkedSet) {
			if (!checkedSet || !checkedSet.size) return;
			var norm = function(p) { return (p || '').replace(/\\\\/g, '/').trim(); };
			document.querySelectorAll('.path-check').forEach(function(cb) {
				var p = norm(cb.getAttribute('data-path'));
				cb.checked = checkedSet.has(p);
			});
		}
		function attachTreeContentHandlers(wrap) {
			if (!wrap) return;
			wrap.querySelectorAll('.btn-toggle').forEach(function(btn) {
				btn.onclick = function() {
					var row = this.closest('.package-row, .folder-row');
					var node = row && row.closest('.tree-node');
					var children = node && (node.querySelector('.package-children') || node.querySelector('.node-children'));
					if (!children) return;
					var isHidden = children.style.display === 'none';
					children.style.display = isHidden ? 'block' : 'none';
					this.textContent = isHidden ? '▼' : '▶';
				};
			});
			wrap.querySelectorAll('.package-row .row-label, .folder-row .row-label').forEach(function(lbl) {
				lbl.onclick = function(e) {
					if (e.target && e.target.type === 'checkbox') return;
					e.preventDefault();
					e.stopPropagation();
					var row = this.closest('.package-row, .folder-row');
					var btn = row && row.querySelector('.btn-toggle');
					if (btn) btn.click();
				};
			});
			wrap.querySelectorAll('.path-check.folder-check').forEach(function(cb) {
				cb.onchange = function() {
					setDirty();
					var folderNode = this.closest('.folder-node, .package-node');
					if (!folderNode) return;
					var check = this.checked;
					// Cascade: check/uncheck all items below this folder (files and subfolders)
					folderNode.querySelectorAll('.path-check').forEach(function(c) { c.checked = check; c.indeterminate = false; });
					// Sync all leaf paths in this folder into the persistent snapshot
					folderNode.querySelectorAll('.path-check:not(.folder-check)').forEach(function(c) {
						var p = norm(c.getAttribute('data-path') || '');
						if (p) { if (check) _selSS.add(p); else _selSS.delete(p); }
					});
					updateAncestorCheckboxes(folderNode.parentElement);
					updateSelectAllButtonState();
					updateSelectionStatus();
				};
			});
			// Only attach to file checkboxes so we don't overwrite the folder-check handler above
			wrap.querySelectorAll('.path-check:not(.folder-check)').forEach(function(cb) {
				cb.onchange = function() {
					var p = norm(this.getAttribute('data-path') || '');
					if (p) { if (this.checked) _selSS.add(p); else _selSS.delete(p); }
					setDirty();
					var node = this.closest('.tree-node');
					if (!node) return;
					updateAncestorCheckboxes(node.parentElement);
					updateSelectAllButtonState();
					updateSelectionStatus();
				};
			});
			document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
			updateSelectAllButtonState();
			updateSelectionStatus();
		}
		function renderTreeWithData(data, checkedSet, isFiltered) {
			var wrap = safeGet('tree-wrap');
			if (!wrap) return;
			lastRenderedTreeData = data;
			if (!data || data.length === 0) {
				wrap.innerHTML = isFiltered ? '<p>No matching metadata.</p>' : '<p>No package directories found. Add packageDirectories in sfdx-project.json.</p>';
				return;
			}
			wrap.innerHTML = buildTreeHtml(data);
			if (checkedSet && checkedSet.size > 0) restoreCheckboxesFromSet(checkedSet);
			attachTreeContentHandlers(wrap);
		}
		function renderTree() {
			var wrap = safeGet('tree-wrap');
			if (!wrap) return;
			if (!treeData || treeData.length === 0) { wrap.innerHTML = '<p>No package directories found. Add packageDirectories in sfdx-project.json.</p>'; return; }
			lastRenderedTreeData = treeData;
			renderTreeWithData(treeData, null);
			var searchEl = safeGet('tree-search');
			if (searchEl) searchEl.oninput = function() { filterTree(); scheduleSaveState(); };
			var filterOnlySel = safeGet('filter-only-selected');
			if (filterOnlySel) filterOnlySel.onchange = function() { filterTree(); scheduleSaveState(); };
			var btnExpandAll = safeGet('btn-expand-all');
			if (btnExpandAll) btnExpandAll.onclick = function() {
				wrap.querySelectorAll('.package-children, .node-children').forEach(function(el) { el.style.display = 'block'; });
				wrap.querySelectorAll('.btn-toggle').forEach(function(btn) { btn.textContent = '▼'; });
			};
			var btnCollapseAll = safeGet('btn-collapse-all');
			if (btnCollapseAll) btnCollapseAll.onclick = function() {
				wrap.querySelectorAll('.package-children, .node-children').forEach(function(el) { el.style.display = 'none'; });
				wrap.querySelectorAll('.btn-toggle').forEach(function(btn) { btn.textContent = '▶'; });
			};
			var btnSelectDeselectAll = safeGet('btn-select-deselect-all');
			if (btnSelectDeselectAll) btnSelectDeselectAll.onclick = function() {
				setDirty();
				var wrap = safeGet('tree-wrap');
				if (!wrap) return;
				var all = wrap.querySelectorAll('.path-check');
				var checked = wrap.querySelectorAll('.path-check:checked');
				var allSelected = all.length > 0 && checked.length === all.length;
				var newState = !allSelected;
				wrap.querySelectorAll('.path-check').forEach(function(cb) { cb.checked = newState; cb.indeterminate = false; });
				// Sync visible leaf paths into the persistent snapshot
				wrap.querySelectorAll('.path-check:not(.folder-check)').forEach(function(cb) {
					var p = norm(cb.getAttribute('data-path') || '');
					if (p) { if (newState) _selSS.add(p); else _selSS.delete(p); }
				});
				document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
				updateSelectAllButtonState();
				updateSelectionStatus();
				scheduleSaveState();
				filterTree();
			};
			updateSelectAllButtonState();
		}

		/** Build test tree as object (key-based), then convert to same array shape as metadata tree and apply same collapse logic. */
		function buildTestTreeAsArray(items) {
			var root = { children: {} };
			items.forEach(function(t) {
				var path = (t.description || t.label || '').replace(/\\\\/g, '/').split('/').filter(Boolean);
				var curr = root;
				for (var i = 0; i < path.length; i++) {
					var seg = path[i];
					var isLeaf = i === path.length - 1;
					if (isLeaf) {
						curr.children[seg] = { label: t.label, path: path.join('/'), leaf: true };
					} else {
						if (!curr.children[seg] || curr.children[seg].leaf) curr.children[seg] = { children: {} };
						curr = curr.children[seg];
					}
				}
			});
			var arr = convertTestObjectToArray(root);
			arr = mergeFewChildFoldersIntoParent(arr);
			arr = collapseSingleChildInTree(arr);
			return arr;
		}
		function convertTestObjectToArray(objRoot) {
			var out = [];
			Object.keys(objRoot.children || {}).sort().forEach(function(k) {
				var node = convertTestChildToNode(objRoot.children[k], k, '');
				if (node) out.push(node);
			});
			return out;
		}
		function convertTestChildToNode(objNode, segment, pathSoFar) {
			var path = pathSoFar ? pathSoFar + '/' + segment : segment;
			if (objNode.leaf) return { label: objNode.label, path: objNode.path };
			var children = [];
			Object.keys(objNode.children || {}).sort().forEach(function(k) {
				var n = convertTestChildToNode(objNode.children[k], k, path);
				if (n) children.push(n);
			});
			return { label: segment, path: path, children: children };
		}
		/** Same structure as metadata tree HTML but with test-class / test-folder-check and data-search-text for filter. */
		function buildTestTreeHtml(data) {
			if (!data || !data.length) return '<p>No test classes found.</p>';
			var html = '';
			data.forEach(function(pkg) {
				var children = pkg.children || [];
				if (children.length === 0) return;
				var pkgCount = 1 + children.reduce(function(s, c) { return s + countNodes(c); }, 0);
				html += '<div class="tree-node package-node" data-search-text="' + escapeAttr((pkg.path || pkg.label || '').toLowerCase()) + '">';
				html += '<div class="package-row"><label class="row-label"><input type="checkbox" class="test-folder-check" aria-label="Select all in folder"><span class="folder-icon" aria-hidden="true">📂</span><span class="label-text">' + escapeHtml(pkg.label) + ' (' + pkgCount + ')</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>';
				html += '<div class="package-children">';
				children.forEach(function(c) { html += renderNodeForTest(c); });
				html += '</div></div>';
			});
			return html || '<p>No test classes found.</p>';
		}
		function renderNodeForTest(node) {
			if (!node.children || node.children.length === 0) {
				var searchText = (node.path || '').toLowerCase();
				return '<label class="tree-node file-node" data-search-text="' + escapeAttr(searchText) + '"><input type="checkbox" class="test-class" value="' + escapeAttr(node.label) + '"><span class="file-icon" aria-hidden="true">📄</span><span class="label-text">' + escapeHtml(node.label) + '</span></label>';
			}
			var count = 1 + (node.children || []).reduce(function(s, c) { return s + countNodes(c); }, 0);
			var out = '<div class="tree-node folder-node" data-search-text="' + escapeAttr((node.path || node.label || '').toLowerCase()) + '">';
			out += '<div class="folder-row"><label class="row-label"><input type="checkbox" class="test-folder-check" aria-label="Select all in folder"><span class="folder-icon" aria-hidden="true">📁</span><span class="label-text">' + escapeHtml(node.label) + ' (' + count + ')</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>';
			out += '<div class="node-children">';
			(node.children || []).forEach(function(c) { out += renderNodeForTest(c); });
			out += '</div></div>';
			return out;
		}
		function filterTestList() {
			var list = safeGet('test-list');
			var searchEl = safeGet('test-search');
			if (!list || !searchEl) return;
			var search = (searchEl.value || '').trim().toLowerCase();
			var nodes = list.querySelectorAll('.tree-node');
			if (!search) {
				nodes.forEach(function(n) { n.style.display = ''; });
				return;
			}
			nodes.forEach(function(n) { n.style.display = 'none'; });
			function showAncestors(el) {
				while (el) {
					el.style.display = '';
					el = el.parentElement && el.classList.contains('tree-node') ? el.parentElement.closest('.tree-node') : null;
				}
			}
			function showDescendants(el) {
				el.style.display = '';
				el.querySelectorAll('.tree-node').forEach(function(n) { n.style.display = ''; });
			}
			list.querySelectorAll('.tree-node.file-node[data-search-text]').forEach(function(n) {
				var text = (n.getAttribute('data-search-text') || '');
				if (text.indexOf(search) !== -1) showAncestors(n);
			});
			list.querySelectorAll('.tree-node.folder-node[data-search-text]').forEach(function(n) {
				var text = (n.getAttribute('data-search-text') || '');
				if (text.indexOf(search) !== -1) { showAncestors(n); showDescendants(n); }
			});
		}
		function renderTestList() {
			var list = safeGet('test-list');
			if (!list) return;
			if (!testClassesData.length) { list.innerHTML = '<p>No test classes found.</p>'; return; }
			var data = buildTestTreeAsArray(testClassesData);
			list.innerHTML = buildTestTreeHtml(data);
			list.querySelectorAll('.btn-toggle').forEach(function(btn) {
				btn.onclick = function() {
					var row = this.closest('.package-row, .folder-row');
					var node = row && row.closest('.tree-node');
					var children = node && (node.querySelector('.package-children') || node.querySelector('.node-children'));
					if (!children) return;
					var isHidden = children.style.display === 'none';
					children.style.display = isHidden ? 'block' : 'none';
					this.textContent = isHidden ? '▼' : '▶';
				};
			});
			list.querySelectorAll('.package-row .row-label, .folder-row .row-label').forEach(function(lbl) {
				lbl.onclick = function(e) {
					if (e.target && e.target.type === 'checkbox') return;
					e.preventDefault();
					e.stopPropagation();
					var row = this.closest('.package-row, .folder-row');
					var btn = row && row.querySelector('.btn-toggle');
					if (btn) btn.click();
				};
			});
			list.querySelectorAll('.test-folder-check').forEach(function(cb) {
				cb.onchange = function() {
					setDirty();
					var folderNode = this.closest('.folder-node, .package-node');
					if (!folderNode) return;
					var check = this.checked;
					folderNode.querySelectorAll('.test-class').forEach(function(c) { c.checked = check; });
				};
			});
			list.querySelectorAll('.test-class').forEach(function(cb) {
				cb.onchange = setDirty;
			});
		}

		document.querySelectorAll('input[name="testLevel"]').forEach(function(r) {
			r.onchange = function() {
				setDirty();
				var w = safeGet('specified-tests-wrap');
				if (w) w.classList.toggle('visible', this.value === 'RunSpecifiedTests');
			};
		});
		var testSearchEl = safeGet('test-search');
		if (testSearchEl) testSearchEl.oninput = filterTestList;
		var orgSel = safeGet('org-select');
		if (orgSel) orgSel.onchange = setDirty;

		var deployBtn = safeGet('deploy-btn');
		if (deployBtn) deployBtn.onclick = function() {
			var minimalPaths = getMinimalSourcePaths();
			var st = safeGet('deploy-status');
			if (minimalPaths.length === 0) { if (st) st.textContent = 'Select at least one metadata path.'; return; }
			var sourcePaths = expandToFilePathsForDeploy(minimalPaths);
			var testLevel = (document.querySelector('input[name="testLevel"]:checked') || {}).value || 'NoTestRun';
			var testClassNames = [];
			if (testLevel === 'RunSpecifiedTests') {
				document.querySelectorAll('.test-class:checked').forEach(function(cb) { testClassNames.push(cb.value); });
				if (testClassNames.length === 0) { if (st) st.textContent = 'Select at least one test class for Run Specified Tests.'; return; }
			}
			if (st) st.textContent = '';
			postToHost({
				command: 'deploy',
				sourcePaths: sourcePaths,
				testLevel: testLevel,
				testClassNames: testClassNames.length ? testClassNames : undefined,
				dryRun: !!(safeGet('validate-only-check') && safeGet('validate-only-check').checked),
				targetOrg: (function(){ var s = safeGet('org-select'); return s && s.value ? s.value : undefined; })(),
				presetName: loadedPresetName || undefined
			});
		};

		// Auto-git is now driven by a FileSystemWatcher on the host side.
		// The webview only needs to: (a) trigger an immediate git-status on enable, (b) save state.
		var gitBtn = safeGet('btn-git-select');
		if (gitBtn) gitBtn.onclick = function() {
			postToHost({ command: 'getChangedFiles' });
			var st = safeGet('deploy-status');
			if (st) st.textContent = 'Reading Git status…';
		};
		var autoGitCheck = safeGet('auto-git-select');
		if (autoGitCheck) {
			autoGitCheck.onchange = function() {
				if (this.checked) {
					// Trigger an immediate git-status when first enabled so the user sees results right away.
					var st = safeGet('deploy-status');
					if (st) st.textContent = 'Reading Git status…';
					postToHost({ command: 'getChangedFiles' });
				}
				scheduleSaveState();
			};
		}

		// ── Test suite helpers ──────────────────────────────────────────────────────
		function renderSuiteSelect() {
			var sel = safeGet('suite-select');
			if (!sel) return;
			var curVal = sel.value;
			sel.innerHTML = '<option value="">— No suite —</option>' + (testSuitesData || []).map(function(s) {
				return '<option value="' + escapeAttr(s.name) + '">' + escapeHtml(s.name) + ' (' + (s.testClassNames || []).length + ')</option>';
			}).join('');
			if (curVal) sel.value = curVal;
			var delBtn = safeGet('btn-delete-suite');
			if (delBtn) delBtn.style.display = (sel.value) ? '' : 'none';
		}
		var suiteSelectEl = safeGet('suite-select');
		if (suiteSelectEl) {
			suiteSelectEl.onchange = function() {
				var name = this.value;
				var delBtn = safeGet('btn-delete-suite');
				if (delBtn) delBtn.style.display = name ? '' : 'none';
				if (!name) return;
				var suite = (testSuitesData || []).find(function(s) { return s.name === name; });
				if (!suite) return;
				document.querySelectorAll('.test-class').forEach(function(cb) { cb.checked = false; });
				(suite.testClassNames || []).forEach(function(cn) {
					document.querySelectorAll('.test-class').forEach(function(cb) { if (cb.value === cn) cb.checked = true; });
				});
				setDirty();
				scheduleSaveState();
			};
		}
		var saveSuiteBtn = safeGet('btn-save-suite');
		if (saveSuiteBtn) saveSuiteBtn.onclick = function() {
			var tcNames = [];
			document.querySelectorAll('.test-class:checked').forEach(function(cb) { tcNames.push(cb.value); });
			var st = safeGet('deploy-status');
			if (!tcNames.length) { if (st) st.textContent = 'Select test classes to save as a suite.'; return; }
			var sel = safeGet('suite-select');
			postToHost({ command: 'saveTestSuite', suiteName: (sel && sel.value) ? sel.value : '', testClassNames: tcNames });
		};
		var deleteSuiteBtn = safeGet('btn-delete-suite');
		if (deleteSuiteBtn) deleteSuiteBtn.onclick = function() {
			var sel = safeGet('suite-select');
			var name = sel && sel.value ? sel.value : '';
			if (!name) return;
			postToHost({ command: 'deleteTestSuite', suiteName: name });
		};

		var savePresetBtn = safeGet('btn-save-preset');
		if (savePresetBtn) savePresetBtn.onclick = function() {
			var state = getCurrentPresetState();
			var st = safeGet('deploy-status');
			if (loadedPresetName) {
				postToHost({
					command: 'savePreset',
					presetName: loadedPresetName,
					sourcePaths: state.sourcePaths,
					deployType: state.deployType,
					testClassNames: state.testClassNames,
					targetOrg: state.targetOrg
				});
				if (st) st.textContent = 'Saving preset…';
			} else {
				var overlay = safeGet('new-preset-modal-overlay');
				var input = safeGet('new-preset-name-input');
				if (overlay && input) { input.value = ''; overlay.style.display = 'flex'; input.focus(); }
			}
		};
		var newPresetSave = safeGet('new-preset-modal-save');
		var newPresetCancel = safeGet('new-preset-modal-cancel');
		var newPresetInput = safeGet('new-preset-name-input');
		if (newPresetSave && newPresetInput) newPresetSave.onclick = function() {
			var name = (newPresetInput.value || '').trim();
			if (!name) return;
			safeGet('new-preset-modal-overlay').style.display = 'none';
			var state = getCurrentPresetState();
			postToHost({
				command: 'savePreset',
				presetName: name,
				sourcePaths: state.sourcePaths,
				deployType: state.deployType,
				testClassNames: state.testClassNames,
				targetOrg: state.targetOrg
			});
			var st = safeGet('deploy-status');
			if (st) st.textContent = 'Saving preset…';
		};
		if (newPresetCancel) newPresetCancel.onclick = function() {
			var o = safeGet('new-preset-modal-overlay');
			if (o) o.style.display = 'none';
		};

		var modalSave = safeGet('preset-modal-save');
		if (modalSave) modalSave.onclick = function() {
			var state = getCurrentPresetState();
			postToHost({
				command: 'savePreset',
				presetName: loadedPresetName || '',
				sourcePaths: state.sourcePaths,
				deployType: state.deployType,
				testClassNames: state.testClassNames,
				targetOrg: state.targetOrg
			});
			finishPresetSwitch();
		};
		var modalDont = safeGet('preset-modal-dont');
		if (modalDont) modalDont.onclick = function() { dirty = false; finishPresetSwitch(); };
		var modalCancel = safeGet('preset-modal-cancel');
		if (modalCancel) modalCancel.onclick = function() {
			pendingPresetIndex = null;
			var o = safeGet('preset-modal-overlay');
			if (o) o.style.display = 'none';
		};

		var statusEl = safeGet('deploy-status');
		if (statusEl) statusEl.textContent = 'Loading…';

		window.addEventListener('message', function(event) {
			var data = event.data;
			if (!data || data.command !== 'init') return;
			treeData = Array.isArray(data.tree) ? data.tree : [];
			testClassesData = Array.isArray(data.testClasses) ? data.testClasses : [];
			presetsData = Array.isArray(data.presets) ? data.presets : [];
			testSuitesData = Array.isArray(data.testSuites) ? data.testSuites : [];
			initialPreset = data.initialPreset || null;
			orgsData = Array.isArray(data.orgs) ? data.orgs : [];
			defaultOrgVal = (data.defaultOrg != null && data.defaultOrg !== '') ? String(data.defaultOrg) : '';
			try {
				var radio = document.querySelector('input[name="testLevel"][value="NoTestRun"]');
				if (radio) radio.checked = true;
				renderOrgSelect();
				renderTree();
				renderTestList();
				renderPresetSelect();
				renderSuiteSelect();
				var savedState = (data.savedState != null && Array.isArray(data.savedState.sourcePaths))
					? data.savedState
					: (vsCodeApi && typeof vsCodeApi.getState === 'function' ? vsCodeApi.getState() : null);
				if (savedState && Array.isArray(savedState.sourcePaths)) restoreState(savedState);
				updateSelectionStatus();
			} catch (e) {
				if (statusEl) statusEl.textContent = 'Error: ' + (e && e.message ? e.message : String(e));
			}
		});
		postToHost({ command: 'panelReady' });
	</script>
</body>
</html>`;
  }
}
