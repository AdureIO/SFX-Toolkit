import * as vscode from "vscode";
import {
  getTestClassItems,
  buildDeployCommand,
  getPackageDirectories,
  DEPLOY_TYPE_RUN_ALL,
  DEPLOY_TYPE_RUN_RELEVANT,
  DEPLOY_TYPE_SPECIFIED,
  DEPLOY_TYPE_NO_TESTS
} from "../commands/deployMetadata";
import { confirmProductionOrgOperation } from "../utils/orgSafety";
import { listPresets, onDidChangePresets, savePreset, type DeployPreset, type DeployTypeKey } from "../utils/presetsStore";
import { WebPreset, toWebPreset } from "../utils/presetsWebPure";
import { PanelProjectBinding, orgPickerForProject } from "../utils/panelProject";
import { PROJECT_SELECTOR_CSS, projectSelectorMarkup, projectSelectorScript } from "../utils/panelProjectUi";
import { FILTER_BAR_CSS, FILTER_BAR_VARS, filterGroupsMarkup, filterSearchMarkup } from "../utils/filterBarUi";
import { getNonce } from "../utils/htmlUtils";
import { onDidChangeDefaultOrg } from "../utils/defaultOrgEvents";
import { runCommand } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";
import { addDeployHistoryEntry } from "../commands/deployHistory";
import { withSyntheticTestFailures } from "../utils/deployDiagnostics";
import { deployPathsForComponents, pathsToComponents, relativeFilesOf, type RelComponent } from "../utils/deployComponentsPure";
import { hiddenSelectionPrompt, splitByVisibility } from "../utils/orgBrowser/selection";
import { runDeploy, reportDeployOutcome } from "../utils/deployFlow";
import { recordHistory } from "../utils/syncHistory";
import { historyErrorsFromDeploy } from "../utils/historyPure";
import { AuthInfo } from "../utils/authInfo";
import { DeployPanelHost } from "./DeployPanelHost";
import { preDeployPrompt } from "../utils/deployStatusPure";
import { SharedMetadataFilter } from "../utils/sharedFilterState";
import { upsertTestSuite, deleteTestSuite as deleteTestSuiteEntry, loadTestSuites, type TestSuite } from "../utils/testSuites";

/** Panel state we persist in the extension so it survives webview HTML replacement (tab switch/revive). */
export interface DeployPanelState {
  /** Selected components (`Type:fullName`), leaves only. */
  components: string[];
  presetName?: string | null;
  deployType?: string;
  testClassNames?: string[];
  testSuiteName?: string | null;
  targetOrg?: string | null;
  filterOnlySelected?: boolean;
  autoGitSelect?: boolean;
  validateOnly?: boolean;
  /** Webview UI state (filter, collapsed groups, filter panel). */
  ui?: unknown;
}

interface DeployInitData {
  testClasses: { label: string; description: string }[];
  presets: DeployPreset[];
  orgs: { label: string; username: string }[];
  defaultOrg: string;
  testSuites: TestSuite[];
}

export class DeployMetadataPanelProvider {
  public static readonly viewType = "adure-sfx-toolkit.deployMetadataPanel";

  private static ctx: vscode.ExtensionContext | undefined;

  /** Call once on activation. */
  public static init(context: vscode.ExtensionContext): void {
    this.ctx = context;
  }

  /** Panel state per workspace so selection survives when webview content is recreated on tab switch. */
  private static panelStateByWorkspace: Record<string, DeployPanelState> = {};

  /** Cached init data for the current workspace so tab restore (revive) is instant instead of re-running the test-class scan / org list. */
  private static initCache: ({ workspaceRoot: string } & DeployInitData) | null = null;

  /**
   * Per-panel cleanup (message listener, file watcher + debounce timer, default-org subscription).
   * Run when the panel closes or before re-attaching on revive, so a re-attach never leaks the previous closure.
   */
  private static cleanupByPanel = new WeakMap<vscode.WebviewPanel, () => void>();
  /** Panels for which we already registered onDidDispose (one-time cleanup per panel). */
  private static panelsWithDisposeRegistered = new WeakSet<vscode.WebviewPanel>();
  /** Singleton: one Deploy panel (and one retained renderer) at most. */
  private static _panel: vscode.WebviewPanel | undefined;
  /** The singleton's project / org state. */
  private static _host: DeployPanelHost | undefined;

  /** Everything the panel loads for a project, in parallel (the init message awaits it). */
  private static loadInitData(workspaceRoot: string): Promise<DeployInitData> {
    return Promise.allSettled([
      Promise.resolve().then(() => getTestClassItems(workspaceRoot)),
      listPresets(workspaceRoot),
      orgPickerForProject(workspaceRoot),
      Promise.resolve().then(() => loadTestSuites(workspaceRoot))
    ]).then(([testR, presetsR, orgsR, suitesR]) => {
      const testClasses = testR.status === "fulfilled" ? testR.value : ([] as { label: string; description: string }[]);
      const presets = presetsR.status === "fulfilled" ? presetsR.value : ([] as DeployPreset[]);
      const orgs = orgsR.status === "fulfilled" ? orgsR.value.orgs : ([] as { label: string; username: string }[]);
      // The project's default org; with none, the first org of the list (as before).
      const defaultOrg = (orgsR.status === "fulfilled" ? orgsR.value.defaultOrg : "") || (orgs.length > 0 ? orgs[0].username : "");
      const testSuites = suitesR.status === "fulfilled" ? suitesR.value : ([] as TestSuite[]);
      return { testClasses, presets, orgs, defaultOrg, testSuites };
    });
  }

  private static webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    const roots = this.ctx ? [vscode.Uri.joinPath(this.ctx.extensionUri, "resources")] : undefined;
    return { enableScripts: true, localResourceRoots: roots, retainContextWhenHidden: true };
  }

  /** A stored preset as the webview sees it (old path presets are mapped to components through the local index). */
  private static toWebPreset(p: DeployPreset & { validateOnly?: boolean }, rel: readonly RelComponent[]): WebPreset {
    return toWebPreset(p, rel);
  }

  public static async show(initialPreset?: DeployPreset): Promise<void> {
    const binding = new PanelProjectBinding();
    const workspaceRoot = binding.current() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      binding.dispose();
      vscode.window.showErrorMessage("No workspace open.");
      return;
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    const existing = DeployMetadataPanelProvider._panel;
    if (existing) {
      binding.dispose();
      existing.reveal(column);
      if (initialPreset) {
        const host = DeployMetadataPanelProvider._host;
        await host?.ready;
        void existing.webview.postMessage({ command: "applyPresetFromHost", preset: this.toWebPreset(initialPreset, host?.relComponents() ?? []) });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(DeployMetadataPanelProvider.viewType, "Deploy Metadata", column, this.webviewOptions());

    // Render HTML immediately — panel is visible with "Loading…" while data loads in parallel.
    try {
      panel.webview.html = this.getHtml(panel.webview);
    } catch (e) {
      binding.dispose();
      vscode.window.showErrorMessage(
        "Deploy Metadata panel failed to load: " + (e instanceof Error ? e.message : String(e))
      );
      panel.webview.html = `<html><body><p style="color: red;">Failed to load panel. Check Output &gt; Adure SFX Toolkit.</p></body></html>`;
      return;
    }

    // Load all data in parallel. The message handler awaits this before sending 'init'.
    const dataPromise = DeployMetadataPanelProvider.loadInitData(workspaceRoot);

    this.attachMessageHandler(panel, initialPreset ?? null, dataPromise, binding, workspaceRoot);
  }

  /** Call when panel is restored (e.g. after switching back to the tab). Uses cached data so restore is instant. */
  public static async revive(panel: vscode.WebviewPanel): Promise<void> {
    const binding = new PanelProjectBinding();
    const workspaceRoot = binding.current() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      binding.dispose();
      panel.webview.html = `<html><body><p>No workspace open. Close this tab and run "ASFXT: Deploy Metadata" with a folder open.</p></body></html>`;
      return;
    }

    // Render HTML immediately — visible at once regardless of cache hit/miss.
    panel.webview.options = this.webviewOptions();
    panel.webview.html = this.getHtml(panel.webview);

    const cache = DeployMetadataPanelProvider.initCache;
    const dataPromise: Promise<DeployInitData> = (cache && cache.workspaceRoot === workspaceRoot)
      ? Promise.resolve({ testClasses: cache.testClasses, presets: cache.presets, orgs: cache.orgs, defaultOrg: cache.defaultOrg, testSuites: cache.testSuites ?? [] })
      : DeployMetadataPanelProvider.loadInitData(workspaceRoot);

    this.attachMessageHandler(panel, null, dataPromise, binding, workspaceRoot);
  }

  private static createHost(panel: vscode.WebviewPanel, root: string): DeployPanelHost {
    const host = new DeployPanelHost({
      ctx: this.ctx!,
      root,
      post: (m) => void panel.webview.postMessage(m),
      gitStatusPaths: (r) => DeployMetadataPanelProvider.runGitStatusSfdxPaths(r)
    });
    DeployMetadataPanelProvider._host = host;
    return host;
  }

  private static attachMessageHandler(
    panel: vscode.WebviewPanel,
    initialPreset: DeployPreset | null,
    initialData: Promise<DeployInitData>,
    binding: PanelProjectBinding,
    initialRoot: string
  ): void {
    // The project the panel shows. Changes when the user picks another project in the selector
    // (or the active project changes while the panel is not pinned). Handlers snapshot it per message.
    let liveRoot = initialRoot;
    let liveData = initialData;
    let projectSwitched = false;
    let reloadSeq = 0;
    // Deploys / validations in flight, and a project switch deferred until they finish.
    let inFlight = 0;
    let switchPending = false;
    const trackDeploy = async <T>(run: () => PromiseLike<T>): Promise<T> => {
      inFlight++;
      try {
        return await run();
      } finally {
        inFlight--;
        if (inFlight === 0 && switchPending) {
          switchPending = false;
          applyProjectSwitch();
        }
      }
    };
    // Dispose previous listener/watcher when re-attaching (e.g. on revive) to avoid leaking listeners and large closures.
    const previousCleanup = DeployMetadataPanelProvider.cleanupByPanel.get(panel);
    if (previousCleanup) {
      previousCleanup();
      DeployMetadataPanelProvider.cleanupByPanel.delete(panel);
    }
    // A restored panel arriving while another is open: keep just one.
    if (DeployMetadataPanelProvider._panel && DeployMetadataPanelProvider._panel !== panel) DeployMetadataPanelProvider._panel.dispose();
    DeployMetadataPanelProvider._panel = panel;

    // Local component index, git status and org status of the shown project (file watchers included).
    let host = DeployMetadataPanelProvider.createHost(panel, liveRoot);

    const listenerDisposable = panel.webview.onDidReceiveMessage(
      async (msg: {
        command: string;
        components?: string[];
        visible?: string[];
        testLevel?: string;
        testClassNames?: string[];
        dryRun?: boolean;
        targetOrg?: string;
        presetName?: string;
        deployType?: DeployTypeKey;
        state?: DeployPanelState;
        suiteName?: string;
        org?: string | null;
        types?: string[];
        key?: string;
        keys?: string[];
        force?: boolean;
        query?: string;
        legacyState?: { sourcePaths?: string[] } & Partial<DeployPanelState>;
      }) => {
        // A message from a webview load that a project switch has since replaced: its root / paths are stale.
        const msgSeq = (msg as { seq?: unknown }).seq;
        if (typeof msgSeq === "number" && msgSeq !== reloadSeq) {
          Logger.info(`Deploy panel: dropped stale '${msg.command}' message (webview load ${msgSeq}, current ${reloadSeq})`);
          return;
        }
        // Snapshot: a project switch mid-flight (deploy, git status) must not redirect running work.
        const workspaceRoot = liveRoot;
        const dataPromise = liveData;
        const hostNow = host;
        if (msg.command === "persistPanelState" && msg.state !== null && msg.state !== undefined) {
          DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] = msg.state;
          hostNow.setAutoGit(msg.state.autoGitSelect ?? false);
          return;
        }
        if (msg.command === "panelReady") {
          const { testClasses, presets, orgs, defaultOrg, testSuites } = await dataPromise;
          await hostNow.ready;
          DeployMetadataPanelProvider.initCache = { workspaceRoot, testClasses, presets, orgs, defaultOrg, testSuites };
          const rel = hostNow.relComponents();
          // After a project switch the webview must not fall back to its own getState() (the previous
          // project's selection): an empty state restores "nothing selected".
          let savedState: DeployPanelState | null = DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] ?? null;
          // A webview state written by an older version stores file paths: map them to components.
          const legacy = msg.legacyState;
          if (!savedState && legacy && Array.isArray(legacy.sourcePaths) && !projectSwitched) {
            const { sourcePaths, ...rest } = legacy;
            savedState = { ...rest, components: pathsToComponents(sourcePaths, rel).keys };
          }
          if (!savedState && projectSwitched) savedState = { components: [] };
          AuthInfo.warmAuthForOrg((savedState?.targetOrg ?? defaultOrg) || null);
          hostNow.setAutoGit(savedState?.autoGitSelect ?? false);
          panel.webview.postMessage({
            command: "init",
            comps: hostNow.comps,
            hasProject: hostNow.hasProject,
            testClasses,
            presets: presets.map((p) => DeployMetadataPanelProvider.toWebPreset(p, rel)),
            initialPreset: initialPreset ? DeployMetadataPanelProvider.toWebPreset(initialPreset, rel) : null,
            orgs,
            defaultOrg,
            savedState,
            testSuites,
            sharedFilter: SharedMetadataFilter.get(workspaceRoot)
          });
          void hostNow.refreshModified(false);
          return;
        }
        if (msg.command === "sharedFilter") {
          // Search text and type selection are shared with the Org Browser (per project).
          const m = msg as { query?: unknown; types?: unknown };
          SharedMetadataFilter.set(workspaceRoot, { query: m.query, types: m.types }, "deploy");
          return;
        }
        if (msg.command === "openCenter") {
          // Same project and org; the selection (local component keys) comes along.
          void vscode.commands.executeCommand("adure-sfx-toolkit.openSyncCenter", {
            projectDir: workspaceRoot,
            org: typeof msg.targetOrg === "string" && msg.targetOrg ? msg.targetOrg : null,
            selection: Array.isArray(msg.components) ? msg.components.filter((k): k is string => typeof k === "string") : []
          });
          return;
        }
        if (msg.command === "orgChanged") {
          void hostNow.setTargetOrg(typeof msg.org === "string" && msg.org ? msg.org : null);
          return;
        }
        if (msg.command === "refreshOrgStatus") {
          void hostNow.refreshOrg(Array.isArray(msg.types) && msg.types.length > 0 ? msg.types.map(String) : undefined);
          return;
        }
        if (msg.command === "compareContents") {
          // The "Compare contents" button: the components that need it, or (force) the ones the filter shows, again.
          void hostNow.requestCompare(msg.force === true, Array.isArray(msg.keys) ? msg.keys.map(String) : undefined);
          return;
        }
        if (msg.command === "compare" || msg.command === "openFile" || msg.command === "reveal") {
          if (typeof msg.key === "string") await hostNow.rowAction(msg.command, msg.key);
          return;
        }
        if (msg.command === "savePreset") {
          const deployType = (msg.deployType || "RunRelevantTests") as DeployTypeKey;
          const components = Array.isArray(msg.components) ? msg.components.filter((k): k is string => typeof k === "string") : [];
          // Next to the authoritative component list, the files they stand for (what older versions of the panel read).
          const sourcePaths = relativeFilesOf(components, hostNow.entries, workspaceRoot);
          const testClassNames = Array.isArray(msg.testClassNames) ? msg.testClassNames : [];
          const targetOrg = msg.targetOrg || undefined;
          const webPresets = async () => (await listPresets(workspaceRoot)).map((p) => DeployMetadataPanelProvider.toWebPreset(p, hostNow.relComponents()));
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
                  presets: await webPresets()
                });
                return;
              }
              await savePreset(workspaceRoot, {
                name: newName.trim(),
                sourcePaths,
                components,
                deployType,
                testClassNames,
                targetOrg
              });
              panel.webview.postMessage({
                command: "presetSaved",
                name: newName.trim(),
                isNew: true,
                presets: await webPresets()
              });
              vscode.window.showInformationMessage(`Preset "${newName.trim()}" saved.`);
            } else {
              await savePreset(workspaceRoot, {
                name,
                sourcePaths,
                components,
                deployType,
                testClassNames,
                targetOrg
              });
              panel.webview.postMessage({ command: "presetSaved", name, isNew: false, presets: await webPresets() });
              vscode.window.showInformationMessage(`Preset "${name}" updated.`);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage("Failed to save preset: " + errMsg);
            try {
              panel.webview.postMessage({
                command: "presetSaved",
                error: errMsg,
                presets: await webPresets()
              });
            } catch {
              // ignore
            }
          }
          return;
        }
        if (msg.command === "getChangedFiles") {
          await hostNow.refreshModified(true);
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
        if (msg.command !== "deploy" || !Array.isArray(msg.components) || !msg.testLevel) return;
        // No background content compare while a deploy / validation runs; it continues afterwards.
        hostNow.pauseCompare();
        try {
        const dryRun = msg.dryRun === true;
        await hostNow.ready;
        // The selection is a set of components: each deploys exactly its own files (never a folder).
        let keys = msg.components.filter((k): k is string => typeof k === "string");
        // Selected components the current filter hides are never deployed by accident: ask.
        if (Array.isArray(msg.visible)) {
          const { visible, hidden } = splitByVisibility(keys, new Set(msg.visible.map(String)));
          if (hidden.length > 0) {
            const { message, detail } = hiddenSelectionPrompt(keys.length, hidden, dryRun ? "Validate" : "Deploy");
            const all = `${dryRun ? "Validate" : "Deploy"} all ${keys.length}`;
            const only = `${dryRun ? "Validate" : "Deploy"} visible ${visible.length} only`;
            const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, all, ...(visible.length > 0 ? [only] : []));
            if (choice === only) keys = visible;
            else if (choice !== all) return;
          }
        }
        const { paths: absPaths, missing } = deployPathsForComponents(keys, hostNow.entries);
        if (missing.length > 0) Logger.info(`Deploy panel: ${missing.length} selected component(s) are not in the project any more: ${missing.slice(0, 10).join(", ")}`);
        if (absPaths.length === 0) {
          const error = "None of the selected components is in the project any more.";
          panel.webview.postMessage({ command: "deployResult", success: false, cancelled: false, dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs: 0, targetOrg: msg.targetOrg ?? "", error });
          vscode.window.showErrorMessage(`${dryRun ? "Validation" : "Deploy"} not started: ${error}`);
          return;
        }
        const deployedKeys = keys.filter((k) => !missing.includes(k));
        const sourcePathsForHistory = relativeFilesOf(deployedKeys, hostNow.entries, workspaceRoot);
        const prodAction = dryRun ? "validate a deployment against" : "deploy metadata to";
        if (!(await confirmProductionOrgOperation(prodAction, msg.targetOrg || undefined, workspaceRoot))) {
          return;
        }
        const testLevel = msg.testLevel;
        // Test names go as an array; buildDeployCommand validates level + names and throws on bad input.
        const testFlags: string[] =
          msg.testLevel === "RunSpecifiedTests" && Array.isArray(msg.testClassNames)
            ? msg.testClassNames.filter((t): t is string => typeof t === "string" && t.trim() !== "")
            : [];
        const targetOrg = msg.targetOrg || null;
        try {
          // Validate up front so invalid input is reported, not an unhandled rejection mid-deploy.
          buildDeployCommand(absPaths, testLevel, testFlags, dryRun, workspaceRoot, msg.targetOrg || undefined);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          panel.webview.postMessage({ command: "deployResult", success: false, cancelled: false, dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs: 0, targetOrg: msg.targetOrg ?? "", error });
          vscode.window.showErrorMessage(`${dryRun ? "Validation" : "Deploy"} not started: ${error}`);
          return;
        }

        // Right before: ask the org NOW (live, only the selected components' types) whether any selected component
        // changed there since this toolkit last retrieved or deployed it. Never the cached status.
        panel.webview.postMessage({ command: "status", text: "Checking the org for changes…" });
        const check = await hostNow.checkBeforeDeploy(deployedKeys);
        Logger.info(
          `Deploy panel pre-deploy check: ${check.types.length} type(s) listed live (${check.types.join(", ")}) in ${check.soapCalls} SOAP call(s), ${check.ms} ms; ` +
            (check.decision
              ? `${check.decision.changed.length} changed in the org, ${check.decision.unverified.length} not verifiable`
              : `org not checked (${check.error ?? "unknown"}) — going on`)
        );
        if (check.decision?.needsConfirmation) {
          const { message, detail } = preDeployPrompt(check.decision.changed, dryRun, (ms) => new Date(ms).toLocaleString());
          const go = dryRun ? "Validate anyway" : "Deploy anyway";
          const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, go, "Compare");
          if (choice === "Compare") {
            panel.webview.postMessage({ command: "status", text: "Not deployed: compare the changed components with the org first." });
            await hostNow.rowAction("compare", check.decision.changed[0].key);
            return;
          }
          if (choice !== go) {
            panel.webview.postMessage({ command: "status", text: `${dryRun ? "Validation" : "Deploy"} cancelled: ${check.decision.changed.length} component(s) changed in the org.` });
            return;
          }
        } else if (check.decision === null) {
          Logger.info(`Deploy panel: the org could not be checked for changes before the ${dryRun ? "validation" : "deploy"} (${check.error ?? "unknown"}); going on`);
        }
        panel.webview.postMessage({ command: "status", text: "" });

        panel.webview.postMessage({ command: "deployStart", dryRun });
        const run = await runDeploy({ absPaths, testLevel, testFlags, dryRun, root: workspaceRoot, targetOrg, track: trackDeploy });
        const { outcome, startedAt: deployStartTime, durationMs } = run;
        const report = () => reportDeployOutcome({ run, dryRun, root: workspaceRoot, targetOrg });

        if (outcome.kind === "cancelled") {
          panel.webview.postMessage({ command: "deployResult", success: false, cancelled: true, dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs, targetOrg: msg.targetOrg ?? "" });
          addDeployHistoryEntry({ timestamp: deployStartTime, status: "Cancelled", dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: sourcePathsForHistory, presetName: msg.presetName ?? null, deployType: msg.deployType, testClassNames: msg.testClassNames });
          report();
          return;
        }

        if (outcome.kind === "success") {
          const { stats, coverage, apiResult } = outcome;
          panel.webview.postMessage({ command: "deployResult", success: true, cancelled: false, dryRun, ...stats, coverage, durationMs, targetOrg: msg.targetOrg ?? "" });
          // A real deploy: record the components with the org's new lastModifiedDate (our own deploy must not show as "changed in org") and re-list their types.
          if (!dryRun && (apiResult !== undefined || stats.components > 0)) void hostNow.afterDeploy(deployedKeys, outcome.completedAt ?? Date.now());
          addDeployHistoryEntry({ timestamp: deployStartTime, status: "Succeeded", dryRun, ...stats, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: sourcePathsForHistory, presetName: msg.presetName ?? null, deployType: msg.deployType, testClassNames: msg.testClassNames });
          recordHistory(workspaceRoot, { kind: dryRun ? "validate" : "deploy", org: msg.targetOrg ?? "", at: deployStartTime, durationMs, components: deployedKeys, testLevel: testLevel, tests: testFlags, deployId: outcome.deployId, ok: true, source: "deployPanel" });
          report();
          return;
        }

        // outcome.kind === "failed"
        const { stats, coverage, apiResult, errorText } = outcome;
        panel.webview.postMessage({ command: "deployResult", success: false, cancelled: false, dryRun, ...stats, coverage, durationMs, targetOrg: msg.targetOrg ?? "" });
        addDeployHistoryEntry({ timestamp: deployStartTime, status: "Failed", dryRun, ...stats, durationMs, targetOrg: msg.targetOrg ?? "", sourcePaths: sourcePathsForHistory, presetName: msg.presetName ?? null, deployType: msg.deployType, testClassNames: msg.testClassNames });
        recordHistory(workspaceRoot, { kind: dryRun ? "validate" : "deploy", org: msg.targetOrg ?? "", at: deployStartTime, durationMs, components: deployedKeys, testLevel: testLevel, tests: testFlags, deployId: outcome.deployId, ok: false, errors: historyErrorsFromDeploy(apiResult ? withSyntheticTestFailures(apiResult) : undefined, errorText), source: "deployPanel" });
        report();
        } finally {
          hostNow.resumeCompare();
        }
      },
      null,
      []
    );
    // Default org changed: drop cached init data (its org list/default is stale) and realign the selector.
    const defaultOrgSub = onDidChangeDefaultOrg(async () => {
      DeployMetadataPanelProvider.initCache = null;
      try {
        const root = liveRoot;
        const { orgs, defaultOrg } = await orgPickerForProject(root);
        if (DeployMetadataPanelProvider._panel !== panel || root !== liveRoot) return;
        void panel.webview.postMessage({ command: "defaultOrgChanged", orgs, defaultOrg: defaultOrg || (orgs[0]?.username ?? "") });
      } catch { /* keep the current list */ }
    });

    // Presets saved elsewhere (the Deploy & Retrieve Center) show up in the list at once.
    const presetsSub = onDidChangePresets((dir) => {
      if (dir !== liveRoot) return;
      void listPresets(dir).then((list) => {
        if (dir !== liveRoot) return;
        void panel.webview.postMessage({ command: "presetsChanged", presets: list.map((p) => DeployMetadataPanelProvider.toWebPreset(p, host.relComponents())) });
      });
    });

    const sharedFilterSub = SharedMetadataFilter.subscribe("deploy", () => liveRoot, (f) => void panel.webview.postMessage({ command: "sharedFilter", query: f.query, types: f.types }));

    // Project selector: the header dropdown (or the active project, while not pinned) switched the
    // panel's project. Reload everything project-bound as if the panel were newly opened.
    const selectorSub = binding.attach(panel.webview);
    const applyProjectSwitch = (): void => {
      const next = binding.current();
      if (!next || next === liveRoot) return;
      liveRoot = next;
      projectSwitched = true;
      DeployMetadataPanelProvider.initCache = null;
      liveData = DeployMetadataPanelProvider.loadInitData(next);
      // New project: its own local index, git status, org status and watchers.
      host.dispose();
      host = DeployMetadataPanelProvider.createHost(panel, next);
      // A distinct HTML string forces a reload (identical html is ignored); the panelReady handshake re-inits.
      panel.webview.html = DeployMetadataPanelProvider.getHtml(panel.webview, ++reloadSeq);
    };
    const projectSub = binding.onDidChange(() => {
      const next = binding.current();
      if (!next || next === liveRoot) return;
      // Reloading the webview mid-deploy would drop its progress / result: apply after it finishes.
      if (inFlight > 0) {
        switchPending = true;
        void panel.webview.postMessage({ command: "projectSwitchPending" });
        return;
      }
      applyProjectSwitch();
    });

    DeployMetadataPanelProvider.cleanupByPanel.set(panel, () => {
      host.dispose(); // watchers, debounce timers, running org listing
      listenerDisposable.dispose();
      defaultOrgSub.dispose();
      sharedFilterSub.dispose();
      presetsSub.dispose();
      projectSub.dispose();
      selectorSub.dispose();
      binding.dispose();
    });
    if (!DeployMetadataPanelProvider.panelsWithDisposeRegistered.has(panel)) {
      DeployMetadataPanelProvider.panelsWithDisposeRegistered.add(panel);
      panel.onDidDispose(() => {
        const cleanup = DeployMetadataPanelProvider.cleanupByPanel.get(panel);
        if (cleanup) {
          cleanup();
          DeployMetadataPanelProvider.cleanupByPanel.delete(panel);
        }
        if (DeployMetadataPanelProvider._panel === panel) {
          DeployMetadataPanelProvider._panel = undefined;
          DeployMetadataPanelProvider._host = undefined;
          // Only the singleton's close releases the cached test data.
          DeployMetadataPanelProvider.initCache = null;
        }
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
    const all = paths.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
    // `--porcelain` paths are relative to the repository root; the project may be a subfolder of it (multi-project workspaces).
    let prefix = "";
    try {
      const out2 = await runCommand("git rev-parse --show-prefix", workspaceRoot, undefined, false, undefined, 5000);
      const line = (out2 || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
      if (/^[^\s:*?"<>|]+\/$/.test(line)) prefix = line.replace(/\\/g, "/");
    } catch { /* not a repository: the status above failed already */ }
    const unique = prefix ? all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)) : all;
    const packageDirs = getPackageDirectories(workspaceRoot);
    return packageDirs.length > 0
      ? unique.filter((p) => packageDirs.some((dir) => {
          const d = dir.replace(/\\/g, "/").replace(/\/$/, "");
          return p === d || p.startsWith(d + "/");
        }))
      : unique;
  }

  private static getHtml(webview: vscode.Webview, reload = 0): string {
    const extensionUri = this.ctx!.extensionUri;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "resources", "webview", "deployPanel.js"));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
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
	<!-- reload ${reload} -->
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<style>
		${PROJECT_SELECTOR_CSS}
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
			${FILTER_BAR_VARS}
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

		/* ── Component list (same look as the Org Browser grid) ──────────────────── */
		${FILTER_BAR_CSS}
		.panel-left .section-title .org-info { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--vscode-descriptionForeground); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.org-info.err { color: var(--asfx-warn); }
		.org-info.busy::before { content: "⟳ "; }
		#banner { padding: 6px 12px; font-size: 12px; background: color-mix(in srgb, var(--asfx-warn) 14%, transparent); border-bottom: 1px solid var(--asfx-border); flex-shrink: 0; }
		#banner[hidden], #noRows[hidden], #selHidden[hidden] { display: none; }
		.tree-search-row { flex-wrap: wrap; }
		.tree-search-row .search { flex: 1 1 150px; min-width: 120px; }
		#filtersToggle { width: auto; padding: 0 9px; gap: 4px; }
		#filtersToggle.on { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--asfx-border); opacity: 1; }
		.main { flex: 1; display: flex; min-height: 0; }
		#side { width: 248px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--ob-border); background: var(--ob-surface); padding: 6px 10px 12px; }
		.panel-left[data-side="closed"] #side, .panel-left[data-side="auto"][data-narrow] #side { display: none; }
		.center { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
		#selHidden { padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--asfx-border); flex-shrink: 0; }
		#selHidden button { background: transparent; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; font: inherit; }
		.gridbar { display: flex; align-items: center; gap: 10px; padding: 4px 12px; border-bottom: 1px solid var(--asfx-border); font-size: 12px; flex-shrink: 0; }
		.gridbar .spacer { flex: 1; }
		.gridwrap { position: relative; flex: 1; min-height: 0; }
		.scroller { position: absolute; inset: 0; overflow: auto; outline: none; }
		.vspacer { position: relative; }
		.rowsEl { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
		#noRows { padding: 18px 16px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; }
		.drow { display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 8px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
		.drow:hover { background: var(--ob-hover); }
		.drow.sel { background: color-mix(in srgb, var(--ob-accent) 14%, transparent); }
		.drow.active { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
		.drow.conflict { box-shadow: inset 3px 0 0 var(--ob-bad); }
		.drow .c { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.drow .cb { display: flex; justify-content: center; width: 18px; flex-shrink: 0; }
		.drow .cb input { margin: 0; accent-color: var(--asfx-accent); cursor: pointer; }
		.drow .nm { flex: 1; min-width: 60px; font-weight: 500; }
		.drow .st { flex-shrink: 0; display: flex; gap: 4px; }
		.drow .md { flex-shrink: 0; max-width: 170px; font-size: 11px; color: var(--vscode-descriptionForeground); }
		.drow .acts { display: flex; gap: 1px; visibility: hidden; flex-shrink: 0; }
		.drow:hover .acts, .drow.active .acts, .drow:focus-within .acts { visibility: visible; }
		.acts button { background: transparent; border: 0; border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; opacity: .8; cursor: pointer; color: inherit; }
		.acts button:hover { background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent); opacity: 1; }
		.drow.grp { background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); cursor: pointer; font-weight: 600; }
		.gname { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
		.chev { display: inline-flex; transition: transform .12s; opacity: .8; }
		.chev.open { transform: rotate(90deg); }
		.gcount { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 12px; }
		mark { background: color-mix(in srgb, var(--ob-warn) 45%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
		.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--ob-border); white-space: nowrap; }
		.badge.new { color: var(--ob-accent); border-color: color-mix(in srgb, var(--ob-accent) 50%, transparent); }
		.badge.equal { color: var(--ob-ok); border-color: color-mix(in srgb, var(--ob-ok) 50%, transparent); }
		.badge.changed-org { color: var(--ob-warn); border-color: color-mix(in srgb, var(--ob-warn) 55%, transparent); background: color-mix(in srgb, var(--ob-warn) 12%, transparent); }
		.badge.changed-local { color: var(--vscode-charts-blue, #3794ff); border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 55%, transparent); }
		.badge.conflict { color: var(--ob-bad); border-color: color-mix(in srgb, var(--ob-bad) 60%, transparent); background: color-mix(in srgb, var(--ob-bad) 12%, transparent); }
		.badge.unknown { color: var(--vscode-descriptionForeground); border-style: dashed; }
		.badge.prov { border-style: dashed; opacity: .75; }
		@media (forced-colors: active) { .badge { border-color: CanvasText; } }

	</style>
</head>
<body>
	<div class="panel-left">
		<div class="section">
			<div class="section-title"><span class="st-icon" aria-hidden="true">📦</span><span>Metadata to deploy</span><span class="st-spacer"></span><span id="orgInfo" class="org-info" role="status"></span><span id="cmpInfo" class="org-info" role="status"></span><button type="button" class="btn-tree-toolbar" id="cmpBtn" title="Compare the contents of the local components with the org (the ones that need it; with a filter active: the shown ones again)" aria-label="Compare contents">&#8776;</button><button type="button" class="btn-tree-toolbar" id="orgRefresh" title="Re-list this project's metadata types in the target org" aria-label="Refresh org status">↻</button></div>
			<div id="banner" hidden></div>
			<div class="tree-search-row">
				<button type="button" class="btn-select-deselect-all" id="btn-select-deselect-all" title="Select all filtered" aria-label="Select all filtered"><span class="btn-select-deselect-icon" aria-hidden="true">☑</span></button>
				${filterSearchMarkup("Search…  type:ApexClass  status:conflict  by:smith  Acc*Handler   ( / )")}
				<button type="button" class="btn-tree-toolbar" id="filtersToggle" title="Show / hide the filter sidebar" aria-expanded="true">Filters</button>
				<label class="tree-filter-only-selected"><input type="checkbox" id="filter-only-selected" aria-label="Only show selected" /> Selected <span id="sel-count-badge"></span></label>
			</div>
			<div class="main">
			<aside id="side" aria-label="Filters">${filterGroupsMarkup({ statusTitle: "Status in the org", namespace: true, state: false, modified: true, mine: false })}</aside>
			<div class="center">
			<div id="selHidden" hidden><span id="selHiddenText"></span> <button type="button" id="selHiddenShow" title="Reset the filters and show only the selected components">show</button> · <button type="button" id="selHiddenClear" title="Deselect the selected components the current filter hides">clear hidden</button></div>
			<div class="gridbar"><span id="countInfo" class="muted"></span><span class="spacer"></span><button type="button" id="collapseAll" class="linkbtn" title="Collapse / expand all groups">Collapse all</button></div>
			<div class="gridwrap">
				<div id="scroller" class="scroller" tabindex="0" role="grid" aria-label="Metadata components">
					<div id="spacer" class="vspacer"><div id="rowsEl" class="rowsEl"></div></div>
				</div>
				<div id="noRows" hidden></div>
			</div>
			</div>
			</div>
		</div>
	</div>
	<div id="panelSplit" title="Drag to resize"><span></span></div>
	<div class="panel-right">
		<div class="section">
			<div class="section-title"><span class="st-icon" aria-hidden="true">⚡</span><span>Deployment</span><button type="button" class="btn-tree-toolbar" id="openCenterBtn" style="width:auto;padding:0 8px;margin-left:auto;text-transform:none;letter-spacing:normal;font-weight:400;opacity:1;border-color:var(--asfx-border);" title="Open in Deploy &amp; Retrieve Center" aria-label="Open in Deploy &amp; Retrieve Center">Open in Center ⇄</button>${projectSelectorMarkup()}</div>
			<div id="switch-note" style="display:none;margin:4px 0;font-size:11px;opacity:.8" role="status">Project switch applies after this deploy.</div>
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
					<button type="button" class="btn-git-select" id="btn-git-select" title="Select components changed in Git">Select changed (Git)</button>
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
	<script nonce="${nonce}">window.__asfxLoadSeq = ${reload};</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
	<script nonce="${nonce}">${projectSelectorScript("window.__asfxApi")}</script>
</body>
</html>`;
  }
}
