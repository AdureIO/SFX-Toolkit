import * as vscode from "vscode";
import { listLogs } from "./commands/listLogs";
import { filterLogDebug, filterLogSOQL, updateContextForEditor } from "./commands/filterLogs"; // Updated imports
import { addDebugTrace } from "./commands/addDebugTrace";
import { DeployMetadataPanelProvider } from "./providers/DeployMetadataPanelProvider";
import { executeAnonymous, rerunLastApex } from "./commands/executeAnonymous";
import { executeSOQL } from "./commands/executeSOQL";
import { logTreeProvider } from "./providers/LogTreeProvider";
import { openLogById } from "./commands/listLogs";
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
  deployCurrentFile,
  retrieveCurrentFile,
  runLocalTests,
  resetSourceTracking
} from "./commands/devCommands";
import { PermissionSetEditorProvider } from "./editors/PermissionSetEditorProvider";
import { ScratchOrgDefEditorProvider } from "./editors/ScratchOrgDefEditorProvider";
import { SOQLEditorProvider } from "./providers/SOQLEditorProvider";
import { AnonymousApexViewProvider } from "./providers/AnonymousApexViewProvider";
import { Logger, outputChannel } from "./utils/outputChannel";
import { Telemetry, categorizeError } from "./utils/telemetry";
import { metadataDiff } from "./commands/metadataDiff";
import { OrgHealthProvider } from "./commands/orgHealth";
import { quickSoqlFromSelection } from "./commands/quickSoql";
import { DeployHistoryProvider, initDeployHistory, setOpenDeployPanelCallback } from "./commands/deployHistory";
import { lwcNavigate, lwcGoToJs, lwcGoToHtml, lwcGoToMeta, lwcGoToCss } from "./commands/lwcNavigator";
import {
  showSnippets,
  runSnippet,
  runSnippetFromTree,
  addSnippet,
  deleteSnippet,
  editSnippetFile,
  deleteSnippetByIndex,
  openSnippetEditor,
  type ApexSnippet
} from "./commands/apexSnippets";
import { ApexSnippetsPanelProvider } from "./providers/ApexSnippetsPanelProvider";
import { SnippetTreeProvider } from "./providers/SnippetTreeProvider";
import { addToGitignore, addToForceignore, addToIgnore } from "./commands/addToIgnore";
import { DataToolsPanelProvider } from "./providers/DataToolsPanelProvider";
import { RestExplorerPanelProvider } from "./providers/RestExplorerPanelProvider";
import { DataMigrationPanelProvider } from "./providers/DataMigrationPanelProvider";
import * as path from "path";
import * as fs from "fs";
import { getPollingInterval } from "./utils/constants";
import { isSalesforceProject, updateSalesforceProjectContext, NOT_SFDX_PROJECT_MESSAGE } from "./utils/projectUtils";
import { OrgMetadataCache } from "./utils/orgMetadataCache";
import { AuthInfo } from "./utils/authInfo";
import { getDeployDiagnosticCollection } from "./utils/deployDiagnostics";
import { warmOrgListCache, invalidateOrgListCache, refreshOrgListCache } from "./utils/orgListCache";
import { registerRemoveFinalNewlineHook } from "./utils/removeFinalNewlineHook";

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
  Logger.info('Extension "adure-sfx-toolkit" is starting activation...');

  // Set context so panels can show placeholder when not in SFDX project; update when workspace changes
  updateSalesforceProjectContext();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateSalesforceProjectContext()));

  try {
    Logger.info("Extension activation starting...");

    // 0. Telemetry (anonymous usage; respects VS Code global + opt-out setting)
    Telemetry.init(context);
    Telemetry.event("activated", { extensionVersion: context.extension.packageJSON.version });

    // 0. Bootstrap persistent state stores
    initDeployHistory(context);
    setOpenDeployPanelCallback((entry) => {
      const preset = {
        name: entry.presetName || "Re-deploy",
        sourcePaths: entry.sourcePaths,
        deployType: "NoTestRun" as const,
        testClassNames: [],
        targetOrg: entry.targetOrg
      };
      void DeployMetadataPanelProvider.show(preset);
    });

    // Remove-final-newline save hook (config-gated; safe to register before SFDX checks)
    registerRemoveFinalNewlineHook(context);

    // 1. Filter Logs Commands
    // 1. Filter Logs Commands (Normal and Active versions point to same handler)
    const filterDebugCmd = register("adure-sfx-toolkit.filterLogDebug", filterLogDebug);
    const filterDebugActiveCmd = register("adure-sfx-toolkit.filterLogDebugActive", filterLogDebug);

    const filterSOQLCmd = register("adure-sfx-toolkit.filterLogSOQL", filterLogSOQL);
    const filterSOQLActiveCmd = register("adure-sfx-toolkit.filterLogSOQLActive", filterLogSOQL);

    // Sync Context on Switch (dispose on deactivate to avoid leak)
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        updateContextForEditor(editor);
        updateLwcContext(editor);
      })
    );

    // Initialize context for current editor
    if (vscode.window.activeTextEditor) {
      updateContextForEditor(vscode.window.activeTextEditor);
      updateLwcContext(vscode.window.activeTextEditor);
    }

    // 2. List Logs
    const listLogsCmd = register("adure-sfx-toolkit.listLogs", listLogs);

    // 3. Add Debug Trace
    const addDebugTraceCmd = register("adure-sfx-toolkit.addDebugTrace", addDebugTrace);

    // 4. Deploy Metadata (panel with tree, presets, org, test level)
    context.subscriptions.push(getDeployDiagnosticCollection());
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
        "." // also fires on dot for member completion
      )
    );

    // 6. Execute SOQL
    const executeSOQLCmd = register("adure-sfx-toolkit.executeSOQL", executeSOQL);

    // 7. Side Bar Log Provider (shows logs from .sfdx/tools/debug/logs, no own download)
    vscode.window.registerTreeDataProvider("adure-sfx-toolkit.logs", logTreeProvider);

    const refreshLogsCmd = register("adure-sfx-toolkit.refreshLogs", async () => {
      await logTreeProvider.fetchNewLogsFromOrg();
      logTreeProvider.refresh();
    });

    // Watch .sfdx/tools/debug/logs so the tree updates when Salesforce extensions add/change/remove logs
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const logWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, ".sfdx/tools/debug/logs/*.log")
      );
      logWatcher.onDidCreate(() => logTreeProvider.refresh());
      logWatcher.onDidChange(() => logTreeProvider.refresh());
      logWatcher.onDidDelete(() => logTreeProvider.refresh());
      context.subscriptions.push(logWatcher);
    }

    const openLogCmd = register("adure-sfx-toolkit.openLog", async (logId: string) => {
      if (logId) {
        await openLogById(logId);
      }
    });

    const deleteAllLogsCmd = register("adure-sfx-toolkit.deleteAllLogs", deleteAllLogs);

    // 8. Side Bar Trace Provider (clear timer on deactivate to avoid leak)
    const traceProvider = new TraceTreeProvider();
    vscode.window.registerTreeDataProvider("adure-sfx-toolkit.traces", traceProvider);
    context.subscriptions.push(new vscode.Disposable(() => traceProvider.clearTimer()));

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

    // 8. Execute Apex panel (bottom panel only; content persisted in .vscode/anon-apex-buffer.apex)
    const anonymousApexProvider = new AnonymousApexViewProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("adure-sfx-toolkit.anonymousApexPanel", anonymousApexProvider)
    );

    // 9. Development Actions
    const devProvider = new DevActionsProvider();
    vscode.window.registerTreeDataProvider("adure-sfx-toolkit.development", devProvider);

    const pushCmd = register("adure-sfx-toolkit.pushSource", pushSource);
    const pushForceCmd = register("adure-sfx-toolkit.pushSourceForce", pushSourceForce);
    const pullCmd = register("adure-sfx-toolkit.pullSource", pullSource);
    const deployFileCmd = register("adure-sfx-toolkit.deployCurrentFile", deployCurrentFile);
    const retrieveFileCmd = register("adure-sfx-toolkit.retrieveCurrentFile", retrieveCurrentFile);
    const runTestsCmd = register("adure-sfx-toolkit.runLocalTests", runLocalTests);
    const resetTrackingCmd = register("adure-sfx-toolkit.resetSourceTracking", resetSourceTracking);
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

    // 11. Log Content Provider (sf-log and sf-anon-log scheme); clear cache when log doc closed to avoid leak
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("sf-log", logContentProvider));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("sf-anon-log", logContentProvider));
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === "sf-log" || doc.uri.scheme === "sf-anon-log") {
          logContentProvider.clearContent(doc.uri);
        }
      })
    );

    // 12. Polling Logic (clear interval on deactivate to avoid leak)
    const pollingIntervalRef = { current: undefined as NodeJS.Timeout | undefined };

    const startPollingCmd = register("adure-sfx-toolkit.startPolling", async () => {
      logTreeProvider.isPolling = true;
      await vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", true);

      if (!pollingIntervalRef.current) {
        // Immediate fetch from org, then every N seconds
        logTreeProvider.fetchNewLogsFromOrg().then(() => logTreeProvider.refresh());
        pollingIntervalRef.current = setInterval(() => {
          if (logTreeProvider.isPolling) {
            logTreeProvider.fetchNewLogsFromOrg();
          }
        }, getPollingInterval() * 1000);
      }
      vscode.window.showInformationMessage(`Log polling started: retrieving logs every ${getPollingInterval()}s`);
    });

    const stopPollingCmd = register("adure-sfx-toolkit.stopPolling", async () => {
      logTreeProvider.isPolling = false;
      await vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", false);

      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = undefined;
      }
      vscode.window.showInformationMessage("Log Polling Stopped");
    });

    context.subscriptions.push(
      new vscode.Disposable(() => {
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = undefined;
        }
      })
    );

    // Initialize context
    vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", false);

    // 13. SOQL Editor
    const openSOQLEditorCmd = register("adure-sfx-toolkit.openSOQLEditor", () => {
      SOQLEditorProvider.show(context.extensionUri);
    });
    // Restore the SOQL panel after a window reload (so its tab doesn't vanish).
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(SOQLEditorProvider.viewType, {
        async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
          await SOQLEditorProvider.revive(panel, context.extensionUri);
        }
      })
    );

    // 14. Show Output
    const showOutputCmd = register("adure-sfx-toolkit.showOutput", () => {
      outputChannel.show();
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
    const addSnippetCmd = register("adure-sfx-toolkit.addSnippet", async () => {
      await addSnippet();
      snippetProvider.refresh();
      ApexSnippetsPanelProvider.refreshPanel();
    });
    const deleteSnippetCmd = register("adure-sfx-toolkit.deleteSnippet", async (item?: { index?: number }) => {
      if (item !== null && item !== undefined && typeof item.index === "number" && item.index >= 0) {
        await deleteSnippetByIndex(item.index);
        snippetProvider.refresh();
        ApexSnippetsPanelProvider.refreshPanel();
      } else {
        await deleteSnippet();
        snippetProvider.refresh();
      }
    });
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

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        updateSalesforceProjectContext();
        updateSnippetStatusBar();
      })
    );
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
    const dataMigrationCmd = register("adure-sfx-toolkit.dataMigration", () => DataMigrationPanelProvider.show());
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
      filterDebugCmd,
      filterDebugActiveCmd,
      filterSOQLCmd,
      filterSOQLActiveCmd,
      listLogsCmd,
      addDebugTraceCmd,
      deployMetadataCmd,
      executeAnonCmd,
      rerunAnonCmd,
      executeSOQLCmd,
      refreshLogsCmd,
      openLogCmd,
      deleteAllLogsCmd,
      refreshTracesCmd,
      quickTraceCmd,
      deleteTraceCmd,
      startPollingCmd,
      stopPollingCmd,
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
      deployFileCmd,
      retrieveFileCmd,
      runTestsCmd,
      resetTrackingCmd,
      refreshMetadataCmd,
      openSOQLEditorCmd,
      showOutputCmd,
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
      dataMigrationCmd
    );

    if (isSalesforceProject()) {
      warmOrgListCache();
      AuthInfo.warmAuthForOrg(null);       // pre-fetch token so first API call doesn't start cold
      OrgMetadataCache.warmDefaultOrg();   // pre-load sobject list for SOQL completion
    }
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (isSalesforceProject()) {
          warmOrgListCache();
          AuthInfo.warmAuthForOrg(null);
          OrgMetadataCache.warmDefaultOrg();
        }
      })
    );

    Logger.info('Extension "adure-sfx-toolkit" activated successfully.');
  } catch (error) {
    Logger.error('Failed to activate extension "adure-sfx-toolkit"', error);
  }
}

export function deactivate() {
  Logger.info('Extension "adure-sfx-toolkit" is deactivating...');
}
