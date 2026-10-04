import * as vscode from "vscode";
import { listLogs } from "./commands/listLogs";
import { addDebugTrace } from "./commands/addDebugTrace";
import { DeployMetadataPanelProvider } from "./providers/DeployMetadataPanelProvider";
import { executeAnonymous, rerunLastApex } from "./commands/executeAnonymous";
import { executeSOQL } from "./commands/executeSOQL";
import { deleteAllLogs } from "./commands/deleteAllLogs";
import { TraceTreeProvider } from "./providers/TraceTreeProvider";
import { quickTrace, deleteTrace } from "./commands/traceCommands";
import { logContentProvider } from "./providers/LogContentProvider";

import {
  openOrg,
  setAsDefault,
  copyUsername,
  deleteOrg,
  renameAlias,
  generatePassword,
  setAsDefaultDevHub,
  connectOrg,
  createScratch,
  quickScratch
} from "./commands/orgCommands";
import { orgTreeProvider } from "./providers/OrgTreeProvider";
import { ApexCodeLensProvider } from "./providers/ApexCodeLensProvider";
import { registerApexTestController } from "./providers/ApexTestController";
import { ApexCompletionProvider } from "./providers/ApexCompletionProvider";
import { DevActionsProvider } from "./providers/DevActionsProvider";
import {
  pushSource,
  pushSourceForce,
  pullSource,
  pullSourceForce,
  deployCurrentFile,
  retrieveCurrentFile,
  resetSourceTracking
} from "./commands/devCommands";
import { validateApexFile, registerValidateOnSave } from "./commands/validateApex";
import { PermissionSetEditorProvider } from "./editors/PermissionSetEditorProvider";
import { ScratchOrgDefEditorProvider } from "./editors/ScratchOrgDefEditorProvider";
import { SOQLEditorProvider } from "./providers/SOQLEditorProvider";
import { ObjectVisualizerPanelProvider } from "./providers/ObjectVisualizerPanelProvider";
import { ProcessMapPanelProvider } from "./providers/ProcessMapPanelProvider";
import { registerApexLogDecorator } from "./providers/ApexLogDecorator";
import { ApexWorkbenchViewProvider } from "./providers/ApexWorkbenchViewProvider";
import { Logger, outputChannel, registerOutputChannels } from "./utils/outputChannel";
import { Telemetry, categorizeError } from "./utils/telemetry";
import { metadataDiff } from "./commands/metadataDiff";
import { OrgHealthProvider } from "./commands/orgHealth";
import { quickSoqlFromSelection } from "./commands/quickSoql";
import {
  DeployHistoryProvider,
  initDeployHistory,
  disposeDeployHistory,
  setOpenDeployPanelCallback,
  presetFromHistoryEntry
} from "./commands/deployHistory";
import { lwcNavigate, lwcGoToJs, lwcGoToHtml, lwcGoToMeta, lwcGoToCss } from "./commands/lwcNavigator";
import { registerLwcApexProviders } from "./providers/LwcApexProvider";
import { generateLwcApexTypings, registerLwcApexTypingsSync } from "./commands/lwcApexTypings";
import { repairLwcJsconfigCommand } from "./commands/lwcJsconfigRepair";
import {
  showSnippets,
  runSnippet,
  runSnippetFromTree,
  addSnippet,
  deleteSnippet,
  editSnippetFile,
  openSnippetEditor,
  disposeSnippetEvents,
  type ApexSnippet
} from "./commands/apexSnippets";
import { ApexSnippetsPanelProvider } from "./providers/ApexSnippetsPanelProvider";
import { PackageExplorerPanelProvider } from "./providers/PackageExplorerPanelProvider";
import { CoveragePanelProvider } from "./providers/CoveragePanelProvider";
import { ApexCoverageDecorationProvider } from "./providers/ApexCoverageDecorationProvider";
import { CoverageLineDecorator } from "./providers/CoverageLineDecorator";
import { toggleHideMetaXml } from "./commands/toggleHideMeta";
import { registerLwcApexBridge } from "./providers/LwcApexBridge";
import { registerLwcProviders } from "./providers/LwcProviders";
import { registerRestResourceCodeLens } from "./providers/RestResourceCodeLens";
import { apexCoverage, registerCoverageWatchers, clearApexTestResults } from "./utils/apexCoverageService";
import { SnippetTreeProvider } from "./providers/SnippetTreeProvider";
import { addToGitignore, addToForceignore, addToIgnore } from "./commands/addToIgnore";
import { DataToolsPanelProvider } from "./providers/DataToolsPanelProvider";
import { RestExplorerPanelProvider } from "./providers/RestExplorerPanelProvider";
import { DataMigrationPanelProvider } from "./providers/DataMigrationPanelProvider";
import * as path from "path";
import * as fs from "fs";
import { startLanguageServer, stopLanguageServer, restartLanguageServerForWorkspaceChange } from "./languageClient";
import { isSalesforceProject, updateSalesforceProjectContext, NOT_SFDX_PROJECT_MESSAGE } from "./utils/projectUtils";
import { OrgMetadataCache } from "./utils/orgMetadataCache";
import { AuthInfo } from "./utils/authInfo";
import { getDeployDiagnosticCollection, registerDeployDiagnosticAutoClear, deployErrorsContentProvider } from "./utils/deployDiagnostics";
import { OperationPanelProvider, REVEAL_OPERATION_PANEL_COMMAND } from "./providers/OperationPanelProvider";
import { warmOrgListCache, invalidateOrgListCache, refreshOrgListCache } from "./utils/orgListCache";
import { initDefaultOrgWatcher, onDidChangeDefaultOrg, resetDefaultOrgWatcher } from "./utils/defaultOrgEvents";
import { killAllChildProcesses } from "./utils/commandRunner";
import { LiveLogService } from "./utils/liveLogService";
import { SoqlSchemaProvider } from "./utils/soqlSchemaProvider";
import { DescribeStore } from "./utils/describeStore";

/** Delay before the (CLI-backed) coverage query at startup, so it doesn't compete with activation. */
const COVERAGE_WARM_DELAY_MS = 5000;

/**
 * Pre-fetch what most features need (default-org auth, org list, sObject list, coverage),
 * concurrently with the rest of activation. Only ever runs inside an SFDX project, so
 * opening a non-Salesforce folder spawns no CLI processes. Returns a disposable that
 * cancels the deferred coverage query.
 */
function warmProjectCaches(): vscode.Disposable {
  if (!isSalesforceProject()) return new vscode.Disposable(() => undefined);
  AuthInfo.warmAuthForOrg(null);
  warmOrgListCache();
  OrgMetadataCache.warmDefaultOrg(); // pre-load sobject list for SOQL completion
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    // Explorer coverage badges — skipped when something (e.g. a default-org change) already loaded it.
    if (isSalesforceProject() && apexCoverage.loadedAt === null) void apexCoverage.refresh().catch(() => undefined);
  }, COVERAGE_WARM_DELAY_MS);
  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
}

/** Identity of the open project: changes when the user switches project in the same window. */
function currentProjectKey(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return `${folder?.uri.toString() ?? ""}|${isSalesforceProject() ? "sfdx" : "-"}`;
}

function updateLwcContext(editor: vscode.TextEditor | undefined): void {
  if (!editor) {
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:isLwcFile", false);
    return;
  }
  const filePath = editor.document.uri.fsPath.replace(/\\/g, "/");
  const inLwc = filePath.includes("/lwc/") || filePath.includes("/aura/");
  vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:isLwcFile", inLwc);
  if (!inLwc) {
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:lwcHasJs", false);
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:lwcHasHtml", false);
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:lwcHasCss", false);
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:lwcHasMeta", false);
    return;
  }
  const dir = path.dirname(filePath);
  const base = path.basename(dir);
  const ext = filePath.endsWith(".js-meta.xml") ? ".js-meta.xml" : path.extname(filePath);
  vscode.commands.executeCommand(
    "setContext",
    "adure-sfx-toolkit:lwcHasJs",
    ext !== ".js" && fs.existsSync(path.join(dir, base + ".js"))
  );
  vscode.commands.executeCommand(
    "setContext",
    "adure-sfx-toolkit:lwcHasHtml",
    ext !== ".html" && fs.existsSync(path.join(dir, base + ".html"))
  );
  vscode.commands.executeCommand(
    "setContext",
    "adure-sfx-toolkit:lwcHasCss",
    ext !== ".css" && fs.existsSync(path.join(dir, base + ".css"))
  );
  vscode.commands.executeCommand(
    "setContext",
    "adure-sfx-toolkit:lwcHasMeta",
    !filePath.endsWith(".js-meta.xml") && fs.existsSync(path.join(dir, base + ".js-meta.xml"))
  );
}

// Helper to register commands with logging; blocks execution when not in an SFDX project
function register(command: string, callback: (...args: any[]) => any, thisArg?: any): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: any[]) => {
    Logger.info(`Command triggered: ${command}`);
    if (!isSalesforceProject()) {
      vscode.window.showInformationMessage(NOT_SFDX_PROJECT_MESSAGE);
      return;
    }
    const start = Date.now();
    try {
      const result = await callback.call(thisArg, ...args);
      Telemetry.event("command", { command }, { durationMs: Date.now() - start, success: 1 });
      return result;
    } catch (error) {
      Logger.error(`Error executing command: ${command}`, error);
      Telemetry.error("commandError", { command, reason: categorizeError(error) });
      Telemetry.event("command", { command }, { durationMs: Date.now() - start, success: 0 });
      throw error;
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  registerOutputChannels(context);
  Logger.info('Extension "adure-sfx-toolkit" is starting activation...');

  // Warm the default-org auth token (and the other project caches) first — the initial
  // fetches shell out to the CLI, so kicking them off here runs them concurrently with the
  // rest of activation. No-op outside an SFDX project.
  let warmup = warmProjectCaches();
  context.subscriptions.push(new vscode.Disposable(() => warmup.dispose()));

  // Watch for default (target) org changes — extension command or external `sf config set` —
  // so the workbenches can realign their selected org and we drop stale default-org caches.
  initDefaultOrgWatcher(context);

  // Set context so panels can show placeholder when not in SFDX project; kept current by
  // the single workspace-folder handler at the end of activate().
  updateSalesforceProjectContext();

  try {
    Logger.info("Extension activation starting...");

    // 0. Telemetry (anonymous usage; respects VS Code global + opt-out setting)
    Telemetry.init(context);
    Telemetry.event("activated", { extensionVersion: context.extension.packageJSON.version });

    // 0. Bootstrap persistent state stores
    initDeployHistory(context);

    // Org-aware SOQL language server (JVM-free). Safe no-op outside SFDX projects.
    try {
      startLanguageServer(context);
    } catch (e) {
      Logger.error(`Failed to start SFX language server: ${e instanceof Error ? e.message : String(e)}`);
    }
    setOpenDeployPanelCallback((entry) => {
      // Re-deploy from history must replay the same kind of operation: a validation
      // (dry run) must never come back as a real deploy.
      // (missing flag on an old/corrupt entry = dry run). The panel applies the preset
      // object itself and honours `validateOnly`, so the test level carries over too.
      const preset = presetFromHistoryEntry(entry);
      if (entry.dryRun !== false) preset.validateOnly = true;
      void DeployMetadataPanelProvider.show(preset);
    });

    // Sync Context on Switch (dispose on deactivate to avoid leak)
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        updateLwcContext(editor);
      })
    );

    // Initialize context for current editor
    if (vscode.window.activeTextEditor) {
      updateLwcContext(vscode.window.activeTextEditor);
    }

    // 2. List Logs
    const listLogsCmd = register("adure-sfx-toolkit.listLogs", listLogs);

    // 3. Add Debug Trace
    const addDebugTraceCmd = register("adure-sfx-toolkit.addDebugTrace", addDebugTrace);

    // 4. Deploy Metadata (panel with tree, presets, org, test level)
    context.subscriptions.push(getDeployDiagnosticCollection());
    registerDeployDiagnosticAutoClear(context);
    const deployMetadataCmd = register("adure-sfx-toolkit.deployMetadata", () => DeployMetadataPanelProvider.show());
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(DeployMetadataPanelProvider.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          await DeployMetadataPanelProvider.revive(panel);
        }
      })
    );

    // 5. Execute Anonymous Apex
    const executeAnonCmd = register("adure-sfx-toolkit.executeAnonymous", executeAnonymous);
    const rerunAnonCmd = register("adure-sfx-toolkit.rerunLastApex", rerunLastApex);

    // CodeLens
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        // Only anonymous-Apex scratch files (.apex) — NOT .cls classes/tests, where
        // "Run Anonymous Apex" makes no sense (you can't run a class anonymously).
        [
          { language: "apex-anon", scheme: "file" },
          { pattern: "**/*.apex", scheme: "file" }
        ],
        new ApexCodeLensProvider()
      )
    );

    // Apex tests in VS Code's native Testing view (discovery + run + coverage)
    registerApexTestController(context);

    // Apex completion — covers .apex files, .cls files, and any editor with language "apex"
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(
        [
          { language: "apex", scheme: "file" },
          { pattern: "**/*.apex", scheme: "file" },
          { pattern: "**/*.cls", scheme: "file" },
          { pattern: "**/*.trigger", scheme: "file" }
        ],
        new ApexCompletionProvider(),
        ".", // member completion
        "@", // Apex annotations (@IsTest, @AuraEnabled, …)
        "'" // picklist values in obj.Field = '…'
      )
    );

    // 6. Execute SOQL
    const executeSOQLCmd = register("adure-sfx-toolkit.executeSOQL", executeSOQL);

    const deleteAllLogsCmd = register("adure-sfx-toolkit.deleteAllLogs", deleteAllLogs);

    // 8. Side Bar Trace Provider (clear timer on deactivate to avoid leak)
    const traceProvider = new TraceTreeProvider();
    const traceView = vscode.window.createTreeView("adure-sfx-toolkit.traces", { treeDataProvider: traceProvider });
    context.subscriptions.push(
      traceProvider,
      traceView,
      // No expiry timer / refreshes while the view is hidden; one refresh on show.
      traceView.onDidChangeVisibility((e) => traceProvider.setVisible(e.visible))
    );

    const refreshTracesCmd = register("adure-sfx-toolkit.refreshTraces", () => {
      traceProvider.refresh();
    });

    const quickTraceCmd = register("adure-sfx-toolkit.quickTrace", quickTrace);

    // For deleteTrace, we expect a TraceItem which has a traceId, or a generic call.
    const deleteTraceCmd = register("adure-sfx-toolkit.deleteTrace", async (item?: any) => {
      if (item && item.traceId) {
        await deleteTrace(item.traceId);
      } else {
        // If called without context, maybe show list? or just return.
        // Usually context menu passes item.
        vscode.window.showInformationMessage("Use the context menu on a trace to delete it.");
      }
    });

    // 7. Org Manager
    const orgTreeView = vscode.window.createTreeView("adure-sfx-toolkit.orgs", {
      treeDataProvider: orgTreeProvider
    });
    context.subscriptions.push(
      orgTreeProvider,
      orgTreeView,
      orgTreeView.onDidChangeVisibility((e) => {
        if (e.visible && isSalesforceProject()) {
          warmOrgListCache();
        }
      })
    );

    const refreshOrgsCmd = register("adure-sfx-toolkit.refreshOrgs", () => {
      // 1. Evict everything synchronously so nothing stale is served
      AuthInfo.clearCache();
      OrgMetadataCache.invalidate(null);
      invalidateOrgListCache();
      // 2. Redraw tree immediately (user sees spinner, not stale data)
      orgTreeProvider.refresh();
      // 3. Default org: warm auth + metadata right away (most-used, highest priority)
      AuthInfo.warmAuthForOrg(null);
      OrgMetadataCache.refresh(null, { background: true });
      // 4. All orgs: rebuild the org list, then warm auth for every connected org so
      //    stale tokens for non-default orgs are also refreshed proactively.
      void refreshOrgListCache()
        .then((orgs) => {
          for (const org of orgs) {
            AuthInfo.warmAuthForOrg(org.username);
          }
        })
        .catch(() => { /* non-fatal — orgs warmed lazily on next use */ });
    });
    const openOrgCmd = register("adure-sfx-toolkit.openOrg", openOrg);
    const setAsDefaultCmd = register("adure-sfx-toolkit.setAsDefaultOrg", setAsDefault);
    const setAsDefaultDevHubCmd = register("adure-sfx-toolkit.setAsDefaultDevHub", setAsDefaultDevHub);
    const copyUsernameCmd = register("adure-sfx-toolkit.copyUsername", copyUsername);
    const renameAliasCmd = register("adure-sfx-toolkit.renameAlias", renameAlias);
    const generatePasswordCmd = register("adure-sfx-toolkit.generatePassword", generatePassword);
    const deleteOrgCmd = register("adure-sfx-toolkit.deleteOrg", deleteOrg);

    const connectOrgCmd = register("adure-sfx-toolkit.connectOrg", connectOrg);
    const createScratchCmd = register("adure-sfx-toolkit.createScratch", createScratch);
    const quickScratchCmd = register("adure-sfx-toolkit.quickScratch", quickScratch);

    // 8. Highlight Salesforce debug logs (.log + opened logs) per the configured rules.
    registerApexLogDecorator(context);

    // 8b. Apex Workbench panel (org-switchable logs, traces & execute).
    const workbenchProvider = new ApexWorkbenchViewProvider(context.extensionUri);
    context.subscriptions.push(
      workbenchProvider,
      vscode.window.registerWebviewViewProvider(
        "adure-sfx-toolkit.apexWorkbench",
        workbenchProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );

    // 9. Development Actions
    const devProvider = new DevActionsProvider();
    context.subscriptions.push(
      devProvider,
      vscode.window.registerTreeDataProvider("adure-sfx-toolkit.development", devProvider)
    );

    const pushCmd = register("adure-sfx-toolkit.pushSource", pushSource);
    const pushForceCmd = register("adure-sfx-toolkit.pushSourceForce", pushSourceForce);
    const pullCmd = register("adure-sfx-toolkit.pullSource", pullSource);
    const pullForceCmd = register("adure-sfx-toolkit.pullSourceForce", pullSourceForce);
    const deployFileCmd = register("adure-sfx-toolkit.deployCurrentFile", deployCurrentFile);
    const retrieveFileCmd = register("adure-sfx-toolkit.retrieveCurrentFile", retrieveCurrentFile);
    const resetTrackingCmd = register("adure-sfx-toolkit.resetSourceTracking", resetSourceTracking);
    const validateApexCmd = register("adure-sfx-toolkit.validateApexFile", () => validateApexFile());
    registerValidateOnSave(context);
    // LWC → Apex: Cmd+click an `@salesforce/apex/...` import to land on the real method, and hover
    // it for the true signature (Salesforce's generated .d.ts types everything as `any`).
    registerLwcApexProviders(context);
    const lwcApexTypingsCmd = register("adure-sfx-toolkit.generateLwcApexTypings", generateLwcApexTypings);
    // Keep the typings in step with the Apex source automatically (initial sync + on save/change).
    registerLwcApexTypingsSync(context);
    // Repairs are opt-in (sidebar "Repair" section / command palette) — they edit the workspace.
    const lwcJsconfigCmd = register("adure-sfx-toolkit.repairLwcJsconfig", repairLwcJsconfigCommand);
    const refreshMetadataCmd = register("adure-sfx-toolkit.refreshMetadata", async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Refreshing org metadata cache...",
          cancellable: false
        },
        () => OrgMetadataCache.refresh(null)
      );
      vscode.window.showInformationMessage("Org metadata cache refreshed.");
    });

    // 10. Permission Set Editor
    context.subscriptions.push(PermissionSetEditorProvider.register(context));

    // Command to open permission set in UI mode
    const openPermissionSetUICmd = register("adure-sfx-toolkit.openPermissionSetUI", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.fileName.endsWith(".permissionset-meta.xml")) {
        await vscode.commands.executeCommand(
          "vscode.openWith",
          editor.document.uri,
          "adure-sfx-toolkit.permissionSetEditor"
        );
      }
    });
    context.subscriptions.push(openPermissionSetUICmd);

    // Register Scratch Org Definition Editor
    context.subscriptions.push(ScratchOrgDefEditorProvider.register(context));

    // 11. Log Content Provider (sf-log scheme); clear cache when log doc closed to avoid leak
    context.subscriptions.push(
      logContentProvider,
      vscode.workspace.registerTextDocumentContentProvider("sf-log", logContentProvider),
      new vscode.Disposable(() => {
        OperationPanelProvider.disposeAll();
        PackageExplorerPanelProvider.disposeAll();
      })
    );
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("adure-deploy", deployErrorsContentProvider));
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === "sf-log") {
          logContentProvider.clearContent(doc.uri);
        }
      })
    );

    // (Log discovery is now event-driven — see the Logs view registration above.
    //  The old fixed-interval polling has been retired.)

    // 13. SOQL Editor
    const openSOQLEditorCmd = register("adure-sfx-toolkit.openSOQLEditor", (query?: unknown, org?: unknown) => {
      SOQLEditorProvider.show(
        context.extensionUri,
        typeof query === "string" ? query : undefined,
        typeof org === "string" && org ? org : undefined
      );
    });
    // Restore the SOQL panel after a window reload (so its tab doesn't vanish).
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(SOQLEditorProvider.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          await SOQLEditorProvider.revive(panel, context.extensionUri);
        }
      })
    );

    // 13b. Object Visualizer
    const objectVisualizerCmd = register("adure-sfx-toolkit.objectVisualizer", () => {
      ObjectVisualizerPanelProvider.show(context.extensionUri);
    });
    const processMapCmd = register("adure-sfx-toolkit.processMap", () => {
      ProcessMapPanelProvider.show(context.extensionUri);
    });
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(ObjectVisualizerPanelProvider.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          await ObjectVisualizerPanelProvider.revive(panel, context.extensionUri);
        }
      })
    );

    // 14. Show Output
    const showOutputCmd = register("adure-sfx-toolkit.showOutput", () => {
      outputChannel.show();
    });
    // Status bar "Live Progress" item click → reveal the Operation panel (Deploy/Push/Pull/…).
    const revealOperationPanelCmd = register(REVEAL_OPERATION_PANEL_COMMAND, () => {
      OperationPanelProvider.revealCurrent();
    });

    // 15. New Feature Commands
    const metadataDiffCmd = register("adure-sfx-toolkit.metadataDiff", metadataDiff);
    const orgHealthCmd = register("adure-sfx-toolkit.orgHealth", () => OrgHealthProvider.show(context.extensionUri));
    const quickSoqlCmd = register("adure-sfx-toolkit.quickSoql", () => quickSoqlFromSelection(context.extensionUri));
    const deployHistoryCmd = register("adure-sfx-toolkit.deployHistory", () => DeployHistoryProvider.show());

    // 16. Apex Snippets (sidebar view like Debug Traces + quick pick + overview panel)
    const snippetProvider = new SnippetTreeProvider();
    const snippetsTreeView = vscode.window.createTreeView("adure-sfx-toolkit.snippets", {
      treeDataProvider: snippetProvider
    });
    context.subscriptions.push(
      snippetProvider,
      snippetsTreeView,
      new vscode.Disposable(disposeSnippetEvents),
      snippetsTreeView.onDidChangeVisibility((e) => {
        if (e.visible && isSalesforceProject()) {
          warmOrgListCache();
        }
      })
    );
    const showSnippetsCmd = register("adure-sfx-toolkit.showSnippets", showSnippets);
    const openSnippetsPanelCmd = register("adure-sfx-toolkit.openSnippetsPanel", () =>
      ApexSnippetsPanelProvider.show()
    );
    const runSnippetCmd = register("adure-sfx-toolkit.runSnippet", (snippet?: any) => runSnippet(snippet));
    const runSnippetFromTreeCmd = register(
      "adure-sfx-toolkit.runSnippetFromTree",
      (snippetOrItem?: { snippet?: ApexSnippet } | ApexSnippet) => {
        const s = (snippetOrItem && "snippet" in snippetOrItem ? snippetOrItem.snippet : snippetOrItem) as
          | ApexSnippet
          | undefined;
        if (s && typeof s.name === "string") runSnippetFromTree(s);
      }
    );
    // Tree + panel refresh themselves via onDidChangeSnippets.
    const addSnippetCmd = register("adure-sfx-toolkit.addSnippet", () => addSnippet());
    // Delete by file path (tree item / snippet), with confirmation; no arg → pick one.
    const deleteSnippetCmd = register("adure-sfx-toolkit.deleteSnippet", (item?: any) => deleteSnippet(item));
    const editSnippetFileCmd = register("adure-sfx-toolkit.editSnippetFile", async () => {
      await editSnippetFile();
      snippetProvider.refresh();
    });
    const refreshSnippetsCmd = register("adure-sfx-toolkit.refreshSnippets", () => snippetProvider.refresh());
    const editSnippetCmd = register(
      "adure-sfx-toolkit.editSnippet",
      (snippetOrItem?: { snippet?: ApexSnippet; name?: string; code?: string }) => {
        const s = (snippetOrItem?.snippet ?? snippetOrItem) as ApexSnippet | undefined;
        if (s && typeof s.name === "string") openSnippetEditor(s);
      }
    );
    const snippetQuickRunStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    snippetQuickRunStatusBarItem.text = "$(play) Run Apex Snippet";
    snippetQuickRunStatusBarItem.tooltip = "Quick run an Apex snippet against the default org";
    snippetQuickRunStatusBarItem.command = "adure-sfx-toolkit.runSnippet";
    if (isSalesforceProject()) snippetQuickRunStatusBarItem.show();
    context.subscriptions.push(snippetQuickRunStatusBarItem);
    const updateSnippetStatusBar = () => {
      if (isSalesforceProject()) snippetQuickRunStatusBarItem.show();
      else snippetQuickRunStatusBarItem.hide();
    };
    updateSnippetStatusBar();

    // 17. Add to Ignore
    const addToGitignoreCmd = register("adure-sfx-toolkit.addToGitignore", (uri?: vscode.Uri) => addToGitignore(uri));

    // 19. Data Export / Import
    const dataToolsCmd = register("adure-sfx-toolkit.dataTools", () => DataToolsPanelProvider.show());

    // 20. REST API Explorer
    const restExplorerCmd = register("adure-sfx-toolkit.restExplorer", () => RestExplorerPanelProvider.show());
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(RestExplorerPanelProvider.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          await RestExplorerPanelProvider.revive(panel);
        }
      })
    );

    // 21. Data Migration Wizard
    const dataMigrationCmd = register("adure-sfx-toolkit.dataMigration", () =>
      DataMigrationPanelProvider.show(context.globalStorageUri.fsPath)
    );

    // 22. Package Explorer (Dev Hub 2GP)
    const packageExplorerCmd = register("adure-sfx-toolkit.openPackageExplorer", (arg?: { orgData?: { username?: string } }) =>
      PackageExplorerPanelProvider.show(arg?.orgData?.username)
    );
    const listInstalledPackagesCmd = register(
      "adure-sfx-toolkit.listInstalledPackages",
      (arg?: { orgData?: { username?: string } }) => {
        const username = arg?.orgData?.username;
        if (!username) {
          vscode.window.showInformationMessage("Select an org from the Orgs panel to list its installed packages.");
          return;
        }
        return PackageExplorerPanelProvider.showInstalled(username);
      }
    );

    // 24. Apex ↔ LWC bridge — go-to-definition from LWC apex imports + @AuraEnabled CodeLens
    registerLwcApexBridge(context);
    // 25. LWC @salesforce/* import completion + go-to-def + component usage CodeLens
    registerLwcProviders(context);
    // 26. @RestResource → "Test in REST Explorer" CodeLens
    registerRestResourceCodeLens(context);

    // 23. Apex coverage — Explorer badges + structured panel (shared store)
    const covDecorator = new ApexCoverageDecorationProvider(context);
    context.subscriptions.push(covDecorator, vscode.window.registerFileDecorationProvider(covDecorator));
    registerCoverageWatchers(context); // auto-refresh when SF extensions write test results
    const openCoverageCmd = register("adure-sfx-toolkit.openApexCoverage", () => CoveragePanelProvider.show());
    const refreshCoverageCmd = register("adure-sfx-toolkit.refreshApexCoverage", () => CoveragePanelProvider.refreshData());
    const lineDecorator = new CoverageLineDecorator(context);
    context.subscriptions.push(lineDecorator);
    const toggleCoverageLinesCmd = register("adure-sfx-toolkit.toggleApexCoverageLines", () => lineDecorator.toggle());
    const toggleCoverageBadgeCmd = register("adure-sfx-toolkit.toggleApexCoverageBadge", () => covDecorator.toggleBadge());
    const toggleHideMetaCmd = register("adure-sfx-toolkit.toggleHideMetaXml", () => toggleHideMetaXml());
    const clearTestResultsCmd = register("adure-sfx-toolkit.clearApexTestResults", async () => {
      const ok = await vscode.window.showWarningMessage(
        "Delete all local Apex test results (.sfdx/tools/testresults) and clear coverage?",
        { modal: true },
        "Clear"
      );
      if (ok !== "Clear") return;
      const removed = await clearApexTestResults();
      vscode.window.showInformationMessage(`Cleared Apex test results (${removed} item${removed === 1 ? "" : "s"}) and coverage.`);
    });
    const addToForceignoreCmd = register("adure-sfx-toolkit.addToForceignore", (uri?: vscode.Uri) =>
      addToForceignore(uri)
    );
    const addToIgnoreCmd = register("adure-sfx-toolkit.addToIgnore", (uri?: vscode.Uri) => addToIgnore(uri));

    // 18. LWC Navigator
    const lwcNavCmd = register("adure-sfx-toolkit.lwcNavigate", lwcNavigate);
    const lwcJsCmd = register("adure-sfx-toolkit.lwcGoToJs", lwcGoToJs);
    const lwcHtmlCmd = register("adure-sfx-toolkit.lwcGoToHtml", lwcGoToHtml);
    const lwcMetaCmd = register("adure-sfx-toolkit.lwcGoToMeta", lwcGoToMeta);
    const lwcCssCmd = register("adure-sfx-toolkit.lwcGoToCss", lwcGoToCss);

    context.subscriptions.push(
      listLogsCmd,
      addDebugTraceCmd,
      deployMetadataCmd,
      executeAnonCmd,
      rerunAnonCmd,
      executeSOQLCmd,
      deleteAllLogsCmd,
      refreshTracesCmd,
      quickTraceCmd,
      deleteTraceCmd,
      refreshOrgsCmd,
      openOrgCmd,
      setAsDefaultCmd,
      setAsDefaultDevHubCmd,
      copyUsernameCmd,
      renameAliasCmd,
      generatePasswordCmd,
      deleteOrgCmd,
      connectOrgCmd,
      createScratchCmd,
      quickScratchCmd,
      pushCmd,
      pushForceCmd,
      pullCmd,
      pullForceCmd,
      deployFileCmd,
      retrieveFileCmd,
      resetTrackingCmd,
      validateApexCmd,
      lwcApexTypingsCmd,
      lwcJsconfigCmd,
      refreshMetadataCmd,
      openSOQLEditorCmd,
      objectVisualizerCmd,
      processMapCmd,
      showOutputCmd,
      revealOperationPanelCmd,
      metadataDiffCmd,
      orgHealthCmd,
      quickSoqlCmd,
      deployHistoryCmd,
      addToGitignoreCmd,
      addToForceignoreCmd,
      addToIgnoreCmd,
      showSnippetsCmd,
      openSnippetsPanelCmd,
      refreshSnippetsCmd,
      runSnippetCmd,
      runSnippetFromTreeCmd,
      addSnippetCmd,
      deleteSnippetCmd,
      editSnippetFileCmd,
      editSnippetCmd,
      lwcNavCmd,
      lwcJsCmd,
      lwcHtmlCmd,
      lwcMetaCmd,
      lwcCssCmd,
      dataToolsCmd,
      restExplorerCmd,
      dataMigrationCmd,
      packageExplorerCmd,
      listInstalledPackagesCmd,
      openCoverageCmd,
      refreshCoverageCmd,
      toggleCoverageLinesCmd,
      toggleCoverageBadgeCmd,
      toggleHideMetaCmd,
      clearTestResultsCmd
    );

    // Default (target) org changed — via Set-as-Default or an external `sf config set`.
    // defaultOrgEvents already dropped the default-org caches; repaint what shows org data.
    context.subscriptions.push(
      onDidChangeDefaultOrg(() => {
        orgTreeProvider.refresh();
        traceProvider.refresh();
        // Drop the old org's coverage first so its badges/line highlights never linger
        // (onDidChange also clears CoverageLineDecorator's per-class line cache).
        apexCoverage.clear();
        if (isSalesforceProject()) void apexCoverage.refresh().catch(() => undefined);
      })
    );

    // Single workspace-folder handler. A folder added/removed beside the same project only
    // re-evaluates the SFDX context; a different project (first folder changed, or an SFDX
    // project appeared/disappeared) resets every project-scoped cache and re-roots watchers.
    let projectKey = currentProjectKey();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        updateSalesforceProjectContext();
        updateSnippetStatusBar();
        devProvider.refresh();

        const nextKey = currentProjectKey();
        if (nextKey === projectKey) return;
        projectKey = nextKey;
        Logger.info("Workspace project changed — resetting project-scoped caches.");

        teardownStep("cancel warm-up", () => warmup.dispose());
        teardownStep("stop live log polling", () => LiveLogService.disposeAll());
        teardownStep("clear auth cache", () => AuthInfo.disposeAll());
        teardownStep("clear SOQL schema cache", () => SoqlSchemaProvider.disposeAll());
        teardownStep("clear describe store", () => DescribeStore.disposeAll());
        // clearAll (not disposeAll) keeps the language client's change listener subscribed.
        teardownStep("clear metadata cache", () => OrgMetadataCache.clearAll());
        teardownStep("clear org list cache", () => invalidateOrgListCache());
        teardownStep("clear coverage", () => apexCoverage.clear());
        teardownStep("close org health", () => OrgHealthProvider.dispose());
        // CLI calls started for the previous project (queries, log polls, retrieves) are stale.
        teardownStep("kill child processes", () => killAllChildProcesses());
        teardownStep("re-root default org watcher", () => resetDefaultOrgWatcher());
        orgTreeProvider.refresh();
        traceProvider.refresh();
        snippetProvider.refresh();

        // Re-root the language server on the new folders (or stop it outside an SFDX project).
        void restartLanguageServerForWorkspaceChange(context).catch((e) =>
          Logger.error(`Failed to restart SFX language server: ${e instanceof Error ? e.message : String(e)}`)
        );

        warmup = warmProjectCaches();
      })
    );

    Logger.info('Extension "adure-sfx-toolkit" activated successfully.');
  } catch (error) {
    Logger.error('Failed to activate extension "adure-sfx-toolkit"', error);
  }
}

/** Run one teardown step; a failure is logged and never blocks the remaining steps. */
function teardownStep(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    Logger.error(`deactivate: ${name} failed`, e);
  }
}

/**
 * Tear down everything that could outlive the window: the language server process, every
 * CLI child process, and module-level caches. Disposables in context.subscriptions (views,
 * watchers, timers, emitters) are disposed by VS Code right after this returns.
 */
export function deactivate(): Thenable<void> | undefined {
  Logger.info('Extension "adure-sfx-toolkit" is deactivating...');

  let lsStop: Thenable<void> | undefined;
  teardownStep("stop language server", () => {
    lsStop = stopLanguageServer();
  });
  teardownStep("stop live log polling", () => LiveLogService.disposeAll());
  teardownStep("dispose auth cache", () => AuthInfo.disposeAll());
  teardownStep("dispose SOQL schema cache", () => SoqlSchemaProvider.disposeAll());
  teardownStep("dispose describe store", () => DescribeStore.disposeAll());
  teardownStep("dispose metadata cache", () => OrgMetadataCache.disposeAll());
  teardownStep("close org health", () => OrgHealthProvider.dispose());
  teardownStep("dispose deploy history", () => disposeDeployHistory());
  // Last, after the LS stop has been kicked off: no CLI process may outlive the window.
  teardownStep("kill child processes", () => killAllChildProcesses());

  if (!lsStop) return undefined;
  return Promise.resolve(lsStop).catch((e) => {
    Logger.error("deactivate: language server stop failed", e);
  });
}
