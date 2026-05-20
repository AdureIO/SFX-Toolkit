import * as vscode from "vscode";
import {
  getMetadataTreeByPackage,
  getTestClassItems,
  resolveSourcePaths,
  filterPathsToPackageDirs,
  buildDeployCommand,
  createDeployProgressHandler,
  DEPLOY_TIMEOUT_MS,
  DEPLOY_TYPE_RUN_ALL,
  DEPLOY_TYPE_RUN_RELEVANT,
  DEPLOY_TYPE_SPECIFIED,
  DEPLOY_TYPE_VALIDATE,
  DEPLOY_TYPE_NO_TESTS,
  type DeployTreePackageNode
} from "../commands/deployMetadata";
import { confirmProductionOrgOperation } from "../utils/orgSafety";
import { loadPresets, addPreset, type DeployPreset, type DeployTypeKey } from "../utils/deployPresets";
import { getAnonymousApexOrgList } from "../commands/executeAnonymous";
import { runCommand } from "../utils/commandRunner";
import { Logger } from "../utils/outputChannel";
import { cleanDeployOutput } from "../commands/devCommands";
import { clearDeployDiagnostics, setDeployDiagnosticsFromFailure } from "../utils/deployDiagnostics";
import { AuthInfo } from "../utils/authInfo";

/** Panel state we persist in the extension so it survives webview HTML replacement (tab switch/revive). */
export interface DeployPanelState {
  sourcePaths: string[];
  presetName?: string | null;
  deployType?: string;
  testClassNames?: string[];
  targetOrg?: string | null;
  treeSearch?: string;
  filterOnlySelected?: boolean;
  autoGitSelect?: boolean;
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
      enableScripts: true
    });

    let tree: DeployTreePackageNode[] = [];
    let testClasses: { label: string; description: string }[] = [];
    let presets: DeployPreset[] = [];
    let orgs: { label: string; username: string }[] = [];
    let defaultOrg = "";

    try {
      tree = getMetadataTreeByPackage(workspaceRoot);
    } catch {
      /* non-fatal: empty tree */
    }
    try {
      testClasses = getTestClassItems(workspaceRoot);
    } catch {
      /* non-fatal: no test class list */
    }
    try {
      presets = await loadPresets(folder.uri);
    } catch {
      /* non-fatal: no presets */
    }
    try {
      orgs = await getAnonymousApexOrgList();
      defaultOrg = orgs.length > 0 ? orgs[0].username : "";
    } catch {
      /* non-fatal: no org list */
    }

    DeployMetadataPanelProvider.initCache = { workspaceRoot, tree, testClasses, presets, orgs, defaultOrg };
    AuthInfo.warmAuthForOrg(defaultOrg || null);
    const initPayload = { tree, testClasses, presets, initialPreset: initialPreset ?? null, orgs, defaultOrg };
    try {
      panel.webview.html = this.getHtml();
    } catch (e) {
      vscode.window.showErrorMessage(
        "Deploy Metadata panel failed to load: " + (e instanceof Error ? e.message : String(e))
      );
      panel.webview.html = `<html><body><p style="color: red;">Failed to load panel. Check Output &gt; Adure SFX Toolkit.</p></body></html>`;
      return;
    }

    this.attachMessageHandler(panel, initPayload, folder, workspaceRoot);
  }

  /** Call when panel is restored (e.g. after switching back to the tab). Uses cached data so restore is instant. */
  public static async revive(panel: vscode.WebviewPanel): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      panel.webview.html = `<html><body><p>No workspace open. Close this tab and run "ASFXT: Deploy Metadata" with a folder open.</p></body></html>`;
      return;
    }
    const workspaceRoot = folder.uri.fsPath;
    const cache = DeployMetadataPanelProvider.initCache;
    let tree: DeployTreePackageNode[];
    let testClasses: { label: string; description: string }[];
    let presets: DeployPreset[];
    let orgs: { label: string; username: string }[];
    let defaultOrg: string;
    if (cache && cache.workspaceRoot === workspaceRoot) {
      tree = cache.tree;
      testClasses = cache.testClasses;
      presets = cache.presets;
      orgs = cache.orgs;
      defaultOrg = cache.defaultOrg;
    } else {
      tree = [];
      testClasses = [];
      presets = [];
      orgs = [];
      defaultOrg = "";
      try {
        tree = getMetadataTreeByPackage(workspaceRoot);
      } catch {
        /* non-fatal: empty tree */
      }
      try {
        testClasses = getTestClassItems(workspaceRoot);
      } catch {
        /* non-fatal: no test class list */
      }
      try {
        presets = await loadPresets(folder.uri);
      } catch {
        /* non-fatal: no presets */
      }
      try {
        orgs = await getAnonymousApexOrgList();
        defaultOrg = orgs.length > 0 ? orgs[0].username : "";
      } catch {
        /* non-fatal: no org list */
      }
      DeployMetadataPanelProvider.initCache = { workspaceRoot, tree, testClasses, presets, orgs, defaultOrg };
    }
    const state = DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot];
    AuthInfo.warmAuthForOrg((state?.targetOrg ?? defaultOrg) || null);
    const initPayload = { tree, testClasses, presets, initialPreset: null, orgs, defaultOrg };
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.getHtml();
    this.attachMessageHandler(panel, initPayload, folder, workspaceRoot);
  }

  private static attachMessageHandler(
    panel: vscode.WebviewPanel,
    initPayload: {
      tree: DeployTreePackageNode[];
      testClasses: { label: string; description: string }[];
      presets: DeployPreset[];
      initialPreset: DeployPreset | null;
      orgs: { label: string; username: string }[];
      defaultOrg: string;
    },
    folder: vscode.WorkspaceFolder,
    workspaceRoot: string
  ): void {
    // Dispose previous listener when re-attaching (e.g. on revive) to avoid leaking listeners and large closures.
    const existing = DeployMetadataPanelProvider.messageListenerByPanel.get(panel);
    if (existing) {
      existing.dispose();
      DeployMetadataPanelProvider.messageListenerByPanel.delete(panel);
    }
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
      }) => {
        if (msg.command === "persistPanelState" && msg.state !== null && msg.state !== undefined) {
          DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] = msg.state;
          return;
        }
        if (msg.command === "panelReady") {
          const savedState = DeployMetadataPanelProvider.panelStateByWorkspace[workspaceRoot] ?? null;
          AuthInfo.warmAuthForOrg(savedState?.targetOrg ?? initPayload.defaultOrg ?? null);
          panel.webview.postMessage({ command: "init", ...initPayload, savedState });
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
            // Dedupe while preserving order (same path can appear as add + modify)
            const seen = new Set<string>();
            const unique = paths.filter((p) => {
              if (seen.has(p)) return false;
              seen.add(p);
              return true;
            });
            panel.webview.postMessage({ command: "setChangedPaths", paths: unique });
          } catch (e) {
            panel.webview.postMessage({ command: "setChangedPaths", paths: [], error: String(e) });
          }
          return;
        }
        if (msg.command !== "deploy" || !msg.sourcePaths || !msg.testLevel) return;
        const dryRun = msg.dryRun === true;
        const prodAction = dryRun ? "validate a deployment against" : "deploy metadata to";
        if (!(await confirmProductionOrgOperation(prodAction, msg.targetOrg || undefined))) {
          return;
        }
        let testLevel = msg.testLevel;
        let testFlags = "";
        if (
          msg.testLevel === "RunSpecifiedTests" &&
          Array.isArray(msg.testClassNames) &&
          msg.testClassNames.length > 0
        ) {
          testFlags = msg.testClassNames.map((t) => `-t ${t}`).join(" ");
        } else if (msg.testLevel === "ValidateOnly") {
          testLevel = "RunLocalTests";
        }
        const resolved = resolveSourcePaths(msg.sourcePaths, workspaceRoot);
        const absPaths = filterPathsToPackageDirs(workspaceRoot, resolved);
        type DeployOutcome =
          | { done: true; success: true; result: string }
          | { done: true; success: false; error: string }
          | { done: true; cancelled: true };
        let resolveProgress: (outcome: DeployOutcome) => void;
        const progressPromise = new Promise<DeployOutcome>((resolve) => {
          resolveProgress = resolve;
        });
        let progressSettled = false;
        const outcome: DeployOutcome = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: dryRun ? "Validating deployment…" : "Deploying",
            cancellable: true
          },
          async (progress, token): Promise<DeployOutcome> => {
            clearDeployDiagnostics();
            progress.report({ message: "Preparing…" });
            const cmd = buildDeployCommand(
              absPaths,
              testLevel,
              testFlags,
              dryRun,
              workspaceRoot,
              msg.targetOrg || undefined
            );
            const progressHandler = createDeployProgressHandler((message) => progress.report({ message }), {
              onStatusFailed: () => {
                progress.report({ message: "Status: Failed" });
              }
            });
            runCommand(cmd, workspaceRoot, progressHandler, false, token, DEPLOY_TIMEOUT_MS)
              .then((result) => {
                if (!progressSettled) {
                  progressSettled = true;
                  resolveProgress({ done: true, success: true, result });
                }
              })
              .catch((e: unknown) => {
                const err = e as { cancelled?: boolean; message?: string };
                if (err.cancelled) {
                  if (!progressSettled) {
                    progressSettled = true;
                    resolveProgress({ done: true, cancelled: true });
                  }
                } else {
                  const fullOutput = err.message ?? String(e);
                  if (!progressSettled) {
                    progressSettled = true;
                    resolveProgress({ done: true, success: false, error: fullOutput });
                  }
                }
              });
            return progressPromise;
          }
        );
        if ("cancelled" in outcome && outcome.cancelled) return;
        if ("success" in outcome && outcome.success) {
          // Log a concise, cleaned summary of the successful deploy so users can see details like Status and components.
          const cleaned = cleanDeployOutput(outcome.result);
          Logger.info(`Deploy result (from CLI output):\n${cleaned}`);

          if (dryRun) {
            vscode.window.showInformationMessage("Validation completed successfully.");
          } else {
            vscode.window.showInformationMessage("Deploy completed successfully.");
          }
        } else if ("error" in outcome) {
          Logger.show();

          vscode.window.showErrorMessage("Deploy failed. Check Output for details.", "View Log").then((choice) => {
            if (choice === "View Log") {
              Logger.show();
            }
          });
          void vscode.window
            .withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Parsing failure details…",
                cancellable: false
              },
              async (progress) => {
                progress.report({ message: "Setting diagnostics from deploy output…" });
                await setDeployDiagnosticsFromFailure(workspaceRoot, outcome.error, msg.targetOrg ?? null);
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
        }
      },
      null,
      []
    );
    DeployMetadataPanelProvider.messageListenerByPanel.set(panel, listenerDisposable);
    if (!DeployMetadataPanelProvider.panelsWithDisposeRegistered.has(panel)) {
      DeployMetadataPanelProvider.panelsWithDisposeRegistered.add(panel);
      panel.onDidDispose(() => {
        const d = DeployMetadataPanelProvider.messageListenerByPanel.get(panel);
        if (d) {
          d.dispose();
          DeployMetadataPanelProvider.messageListenerByPanel.delete(panel);
        }
        DeployMetadataPanelProvider.initCache = null;
      });
    }
  }

  private static getHtml(): string {
    const testLevels = [
      { value: "NoTestRun", label: DEPLOY_TYPE_NO_TESTS },
      { value: "RunAllTestsInOrg", label: DEPLOY_TYPE_RUN_ALL },
      { value: "RunRelevantTests", label: DEPLOY_TYPE_RUN_RELEVANT },
      { value: "RunSpecifiedTests", label: DEPLOY_TYPE_SPECIFIED },
      { value: "ValidateOnly", label: DEPLOY_TYPE_VALIDATE }
    ];

    return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
	<style>
		* { box-sizing: border-box; }
		body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; min-width: 960px; height: 100vh; display: flex; flex-direction: row; overflow: hidden; }
		.panel-left { flex: 1; min-width: 420px; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--vscode-panel-border); }
		.panel-right { flex: 0 0 auto; width: 340px; min-width: 300px; display: flex; flex-direction: column; padding: 12px; min-height: 0; overflow: hidden; }
		.panel-left .section { flex: 1; display: flex; flex-direction: column; min-height: 0; margin: 0; border: none; border-radius: 0; border-bottom: 1px solid var(--vscode-panel-border); }
		.panel-right .section { flex: 1 1 auto; min-height: 0; margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
		.panel-right .deployment-header { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; flex-shrink: 0; }
		.panel-right .deployment-left { flex-direction: column; gap: 8px; }
		.panel-right .deployment-left select { width: 100%; max-width: 100%; }
		.panel-right .deployment-right { flex-wrap: wrap; }
		.section-title { background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px 12px; font-weight: 600; flex-shrink: 0; }
		.deployment-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px; }
		.deployment-left { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
		.deployment-left label { margin: 0; }
		.deployment-left select { min-width: 160px; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
		.deployment-right { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
		.radio-group { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
		.radio-group label { margin: 0; cursor: pointer; display: flex; align-items: center; gap: 4px; }
		.test-classes-block { padding: 8px 12px 12px; border-top: 1px solid var(--vscode-panel-border); display: none; flex-shrink: 0; }
		.test-classes-block.visible { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; }
		.test-classes-block .subtitle { font-size: 12px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
		.test-search-row { padding: 4px 0 8px 0; flex-shrink: 0; }
		.test-search-row .tree-search-input { width: 100%; }
		.test-list { min-height: 80px; flex: 1 1 auto; overflow-y: auto; border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; background: var(--vscode-input-background); }
		.test-list .tree-node { margin: 2px 0; }
		.test-list .folder-row, .test-list .file-node { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
		.test-list .folder-row { background: var(--vscode-list-inactiveSelectionBackground); border-radius: 3px; }
		.test-list .folder-icon, .test-list .file-icon { flex-shrink: 0; font-size: 14px; }
		.test-list .node-children { margin-left: 20px; }
		.tree-search-row { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
		.btn-tree-toolbar { padding: 4px 8px; font-size: 12px; line-height: 1; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border); border-radius: 4px; flex-shrink: 0; }
		.btn-select-deselect-all { padding: 4px 8px; font-size: 14px; line-height: 1; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border); border-radius: 4px; flex-shrink: 0; }
		.btn-select-deselect-all .btn-select-deselect-icon { display: inline-block; }
		.tree-search-input { flex: 1; min-width: 120px; padding: 6px 10px; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; box-sizing: border-box; }
		.tree-filter-only-selected { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
		.tree-filter-only-selected input { margin: 0; }
		.panel-left .tree-wrap { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
		.tree-wrap { padding: 8px; }
		.tree-node { margin: 2px 0; }
		.tree-node .node-children, .tree-node .package-children { margin-left: 20px; }
		.tree-node .package-row, .tree-node .folder-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
		.tree-node .folder-row .row-label, .tree-node .package-row .row-label { flex: 1; cursor: pointer; display: flex; align-items: center; gap: 6px; }
		.tree-node .folder-row .row-label:hover, .tree-node .package-row .row-label:hover { background: var(--vscode-list-hoverBackground); border-radius: 2px; }
		.folder-icon { display: inline-block; width: 1.1em; color: var(--vscode-icon-foreground); font-size: 14px; flex-shrink: 0; }
		.tree-node .package-row .folder-icon { color: var(--vscode-textLink-foreground); }
		.tree-node .folder-row { background: var(--vscode-list-inactiveSelectionBackground); border-radius: 3px; margin: 1px 0; }
		.tree-node .package-row { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; margin: 1px 0; padding: 2px 4px; }
		.tree-node label.file-node { cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 2px 0; }
		.file-icon { display: inline-block; width: 1.1em; font-size: 14px; flex-shrink: 0; color: var(--vscode-icon-foreground); }
		.tree-node input[type="checkbox"] { flex-shrink: 0; }
		.btn-toggle { margin-left: 4px; padding: 2px 6px; font-size: 12px; line-height: 1; cursor: pointer; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-button-border); border-radius: 3px; flex-shrink: 0; }
		.btn-toggle:hover { background: var(--vscode-list-hoverBackground); }
		.deploy-btn { width: 100%; padding: 8px 20px; font-size: 13px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border); border-radius: 4px; cursor: pointer; }
		.auto-git-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
		.auto-git-label input { margin: 0; }
		.btn-git-select, .btn-save-preset { padding: 6px 12px; font-size: 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border); border-radius: 4px; }
		.modal-overlay { position: fixed; left: 0; top: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
		.modal-box { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 16px; min-width: 280px; }
		.modal-box p { margin: 0 0 16px 0; }
		.modal-buttons { display: flex; gap: 8px; justify-content: flex-end; }
		.modal-btn { padding: 6px 14px; cursor: pointer; border-radius: 4px; border: 1px solid var(--vscode-button-border); }
		.deploy-status { padding: 8px 12px; font-size: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); }
	</style>
</head>
<body>
	<div class="panel-left">
		<div class="section">
			<div class="section-title">Metadata to deploy</div>
			<div class="tree-search-row">
				<button type="button" class="btn-tree-toolbar" id="btn-expand-all" title="Expand all" aria-label="Expand all">▼</button>
				<button type="button" class="btn-tree-toolbar" id="btn-collapse-all" title="Collapse all" aria-label="Collapse all">▶</button>
				<button type="button" class="btn-select-deselect-all" id="btn-select-deselect-all" title="Select all" aria-label="Select all"><span class="btn-select-deselect-icon" aria-hidden="true">☑</span></button>
				<input type="text" id="tree-search" class="tree-search-input" placeholder="Search files…" aria-label="Search metadata files" />
				<label class="tree-filter-only-selected"><input type="checkbox" id="filter-only-selected" aria-label="Only show selected" /> Only show selected</label>
			</div>
			<div class="tree-wrap" id="tree-wrap"></div>
		</div>
	</div>
	<div class="panel-right">
		<div class="section">
			<div class="section-title">Deployment</div>
			<div class="deployment-header">
				<div class="deployment-left">
					<label for="org-select">Target org:</label>
					<select id="org-select"></select>
					<label for="preset-select">Preset:</label>
					<select id="preset-select"><option value="">— None —</option></select>
					<div class="radio-group" id="test-level">
						${testLevels.map((t) => `<label><input type="radio" name="testLevel" value="${t.value}"> ${t.label}</label>`).join("")}
					</div>
				</div>
				<div class="deployment-right">
					<label class="auto-git-label" title="Periodically add Git-changed files to selection"><input type="checkbox" id="auto-git-select" aria-label="Auto select changed files in Git"> Auto select changed (Git)</label>
					<button type="button" class="btn-git-select" id="btn-git-select" title="Preselect files changed in Git">Select changed (Git)</button>
					<button type="button" class="btn-save-preset" id="btn-save-preset" title="Save current options as preset">Save preset</button>
					<button class="deploy-btn" id="deploy-btn">Deploy</button>
				</div>
			</div>
			<div class="test-classes-block" id="specified-tests-wrap">
				<div class="subtitle">Test classes (select for Run Specified Tests):</div>
				<div class="test-search-row"><input type="text" id="test-search" class="tree-search-input" placeholder="Search tests…" aria-label="Search test classes" /></div>
				<div class="test-list" id="test-list"></div>
			</div>
		</div>
		<div class="deploy-status" id="deploy-status"></div>
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
		var lastRenderedTreeData = null;
		var extraPaths = [], loadedPresetName = null, dirty = false, pendingPresetIndex = null;
		var autoGitTimer = null;
		var vsCodeApi = null;
		try { if (typeof acquireVsCodeApi !== 'undefined') vsCodeApi = acquireVsCodeApi(); } catch (e) { console.error('acquireVsCodeApi failed', e); }
		function postToHost(payload) { try { if (vsCodeApi) vsCodeApi.postMessage(payload); } catch (err) { console.error('postMessage failed', err); } }
		var saveStateTimer = null;
		function saveState() {
			try {
				var s = getCurrentPresetState();
				var searchEl = safeGet('tree-search');
				var filterEl = safeGet('filter-only-selected');
				var autoGitEl = safeGet('auto-git-select');
				var state = {
					sourcePaths: s.sourcePaths,
					presetName: loadedPresetName || null,
					deployType: s.deployType,
					testClassNames: s.testClassNames || [],
					targetOrg: s.targetOrg || null,
					treeSearch: (searchEl && searchEl.value) ? searchEl.value : '',
					filterOnlySelected: !!(filterEl && filterEl.checked),
					autoGitSelect: !!(autoGitEl && autoGitEl.checked)
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
			var radio = document.querySelector('input[name="testLevel"][value="' + (state.deployType || 'NoTestRun') + '"]');
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
				toggleAutoGitTimer(true);
			}
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
			var paths = [];
			document.querySelectorAll('.path-check:checked').forEach(function(cb) { paths.push(cb.getAttribute('data-path')); });
			if (paths.length === 0) { statusEl.textContent = 'Ready. No metadata selected.'; return; }
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
			if (!search && !onlySelected) {
				if (lastRenderedTreeData !== treeData) {
					var selectedSet = getSelectedPathSet();
			renderTreeWithData(treeData, selectedSet, false);
				} else {
					wrap.querySelectorAll('.package-node, .folder-node, .file-node').forEach(function(n) { n.style.display = ''; });
				}
				return;
			}
			var selectedSet = getSelectedPathSet();
			var filtered = (treeData || []).map(function(pkg) {
				var visibleChildren = filterTreeDataToVisible(pkg.children || [], search, onlySelected, selectedSet);
				if (visibleChildren.length === 0) return null;
				visibleChildren = mergeFewChildFoldersIntoParent(visibleChildren);
				visibleChildren = collapseSingleChildInTree(visibleChildren);
				if (visibleChildren.length === 1 && visibleChildren[0].children) {
					var only = visibleChildren[0];
					return { label: pkg.label + '/' + only.label, path: only.path, children: only.children || [] };
				}
				return { label: pkg.label, path: pkg.path, children: visibleChildren };
			}).filter(Boolean);
			renderTreeWithData(filtered, selectedSet, true);
		}

		function getMinimalSourcePaths() {
			var items = [];
			document.querySelectorAll('.path-check:checked').forEach(function(cb) {
				var p = cb.getAttribute('data-path');
				if (!p) return;
				var isFolder = cb.classList.contains('folder-check');
				items.push({ path: norm(p), isFolder: isFolder });
			});
			extraPaths.forEach(function(p) { items.push({ path: norm(p), isFolder: false }); });
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
			var currentSelected = getSelectedPathSet();
			var allTreePaths = getAllPathsFromTreeData(treeData);
			var matchResult = matchGitPathsToTreePaths(paths, allTreePaths);
			var matchedTreePaths = matchResult.matched;
			var newSelectedSet = new Set(currentSelected);
			matchedTreePaths.forEach(function(p) { newSelectedSet.add(p); });
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
			var radio = document.querySelector('input[name="testLevel"][value="' + deployType + '"]');
			if (radio) { radio.checked = true; var w = safeGet('specified-tests-wrap'); if (w) w.classList.toggle('visible', deployType === 'RunSpecifiedTests'); }
			document.querySelectorAll('.test-class').forEach(function(cb) { cb.checked = Array.isArray(preset.testClassNames) && preset.testClassNames.indexOf(cb.value) !== -1; });
			var orgSel = safeGet('org-select');
			if (orgSel && preset.targetOrg) { var found = Array.from(orgSel.options).find(function(o){ return o.value === preset.targetOrg; }); if (found) orgSel.value = preset.targetOrg; }
			document.querySelectorAll('.folder-node, .package-node').forEach(function(f) { updateFolderCheckboxState(f); });
			updateSelectAllButtonState();
			updateSelectionStatus();
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
					updateAncestorCheckboxes(folderNode.parentElement);
					updateSelectAllButtonState();
					updateSelectionStatus();
				};
			});
			// Only attach to file checkboxes so we don't overwrite the folder-check handler above
			wrap.querySelectorAll('.path-check:not(.folder-check)').forEach(function(cb) {
				cb.onchange = function() {
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
				testLevel: testLevel === 'ValidateOnly' ? 'ValidateOnly' : testLevel,
				testClassNames: testClassNames.length ? testClassNames : undefined,
				dryRun: testLevel === 'ValidateOnly',
				targetOrg: (function(){ var s = safeGet('org-select'); return s && s.value ? s.value : undefined; })()
			});
		};

		function toggleAutoGitTimer(skipImmediate) {
			var el = safeGet('auto-git-select');
			if (!el) return;
			if (autoGitTimer) { clearInterval(autoGitTimer); autoGitTimer = null; }
			if (el.checked) {
				if (!skipImmediate) postToHost({ command: 'getChangedFiles' });
				autoGitTimer = setInterval(function() { postToHost({ command: 'getChangedFiles' }); }, 8000);
			}
		}
		var gitBtn = safeGet('btn-git-select');
		if (gitBtn) gitBtn.onclick = function() {
			postToHost({ command: 'getChangedFiles' });
			var st = safeGet('deploy-status');
			if (st) st.textContent = 'Reading Git status…';
		};
		var autoGitCheck = safeGet('auto-git-select');
		if (autoGitCheck) {
			autoGitCheck.onchange = function() { scheduleSaveState(); toggleAutoGitTimer(); };
			toggleAutoGitTimer();
		}

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
