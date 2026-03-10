import * as vscode from "vscode";
import { listLogs } from "./commands/listLogs";
import { filterLogDebug, filterLogSOQL, updateContextForEditor } from "./commands/filterLogs"; // Updated imports
import { addDebugTrace } from "./commands/addDebugTrace";
import { deployMetadata } from "./commands/deployMetadata";
import { executeAnonymous, rerunLastApex } from "./commands/executeAnonymous";
import { executeSOQL } from "./commands/executeSOQL";
import { LogTreeProvider, logTreeProvider } from "./providers/LogTreeProvider";
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
	quickScratch,
} from "./commands/orgCommands";
import { orgTreeProvider } from "./providers/OrgTreeProvider";
import { ApexCodeLensProvider } from "./providers/ApexCodeLensProvider";
import { DevActionsProvider } from "./providers/DevActionsProvider";
import { pushSource, pushSourceForce, pullSource, deployCurrentFile, retrieveCurrentFile, runLocalTests, resetSourceTracking } from "./commands/devCommands";
import { PermissionSetEditorProvider } from "./editors/PermissionSetEditorProvider";
import { ScratchOrgDefEditorProvider } from "./editors/ScratchOrgDefEditorProvider";
import { SOQLEditorProvider } from "./providers/SOQLEditorProvider";
import { AnonymousApexViewProvider } from "./providers/AnonymousApexViewProvider";
import { Logger, outputChannel } from "./utils/outputChannel";
import { metadataDiff } from './commands/metadataDiff';
import { OrgHealthProvider } from './commands/orgHealth';
import { quickSoqlFromSelection } from './commands/quickSoql';
import { DeployHistoryProvider } from './commands/deployHistory';
import { lwcNavigate, lwcGoToJs, lwcGoToHtml, lwcGoToMeta, lwcGoToCss } from './commands/lwcNavigator';
import { showSnippets, runSnippet, addSnippet, deleteSnippet, editSnippetFile, deleteSnippetByIndex, openSnippetEditor, type ApexSnippet } from './commands/apexSnippets';
import { ApexSnippetsPanelProvider } from './providers/ApexSnippetsPanelProvider';
import { SnippetTreeProvider } from './providers/SnippetTreeProvider';
import { addToGitignore, addToForceignore, addToIgnore } from './commands/addToIgnore';
import * as path from 'path';
import * as fs from 'fs';
import { getPollingInterval } from './utils/constants';
import { isSalesforceProject, updateSalesforceProjectContext, NOT_SFDX_PROJECT_MESSAGE } from "./utils/projectUtils";
import { OrgMetadataCache } from "./utils/orgMetadataCache";
import { getSalesforceLogDirectory } from "./utils/logPaths";

function updateLwcContext(editor: vscode.TextEditor | undefined): void {
	if (!editor) {
		vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:isLwcFile', false);
		return;
	}
	const filePath = editor.document.uri.fsPath.replace(/\\/g, '/');
	const inLwc = filePath.includes('/lwc/') || filePath.includes('/aura/');
	vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:isLwcFile', inLwc);
	if (!inLwc) {
		vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasJs', false);
		vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasHtml', false);
		vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasCss', false);
		vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasMeta', false);
		return;
	}
	const dir = path.dirname(filePath);
	const base = path.basename(dir);
	const ext = filePath.endsWith('.js-meta.xml') ? '.js-meta.xml' : path.extname(filePath);
	vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasJs', ext !== '.js' && fs.existsSync(path.join(dir, base + '.js')));
	vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasHtml', ext !== '.html' && fs.existsSync(path.join(dir, base + '.html')));
	vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasCss', ext !== '.css' && fs.existsSync(path.join(dir, base + '.css')));
	vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:lwcHasMeta', !filePath.endsWith('.js-meta.xml') && fs.existsSync(path.join(dir, base + '.js-meta.xml')));
}

// Helper to register commands with logging; blocks execution when not in an SFDX project
function register(command: string, callback: (...args: any[]) => any, thisArg?: any): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (...args: any[]) => {
		Logger.info(`Command triggered: ${command}`);
		if (!isSalesforceProject()) {
			vscode.window.showInformationMessage(NOT_SFDX_PROJECT_MESSAGE);
			return;
		}
		try {
			return await callback.call(thisArg, ...args);
		} catch (error) {
			Logger.error(`Error executing command: ${command}`, error);
			throw error;
		}
	});
}

export function activate(context: vscode.ExtensionContext) {
	Logger.info('Extension "adure-sfx-toolkit" is starting activation...');

	// Set context so panels can show placeholder when not in SFDX project; update when workspace changes
	updateSalesforceProjectContext();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => updateSalesforceProjectContext())
	);

	try {
		Logger.info('Extension activation starting...');

		// 1. Filter Logs Commands
		// 1. Filter Logs Commands (Normal and Active versions point to same handler)
		let filterDebugCmd = register("adure-sfx-toolkit.filterLogDebug", filterLogDebug);
		let filterDebugActiveCmd = register("adure-sfx-toolkit.filterLogDebugActive", filterLogDebug);

		let filterSOQLCmd = register("adure-sfx-toolkit.filterLogSOQL", filterLogSOQL);
		let filterSOQLActiveCmd = register("adure-sfx-toolkit.filterLogSOQLActive", filterLogSOQL);

		// Sync Context on Switch
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			updateContextForEditor(editor);
			updateLwcContext(editor);
		});

        // Initialize context for current editor
        if (vscode.window.activeTextEditor) {
            updateContextForEditor(vscode.window.activeTextEditor);
			updateLwcContext(vscode.window.activeTextEditor);
        }

		// 2. List Logs
		let listLogsCmd = register("adure-sfx-toolkit.listLogs", listLogs);

		// 3. Add Debug Trace
		let addDebugTraceCmd = register("adure-sfx-toolkit.addDebugTrace", addDebugTrace);

		// 4. Deploy Metadata
		let deployMetadataCmd = register("adure-sfx-toolkit.deployMetadata", deployMetadata);

		// 5. Execute Anonymous Apex
		let executeAnonCmd = register("adure-sfx-toolkit.executeAnonymous", executeAnonymous);
		let rerunAnonCmd = register("adure-sfx-toolkit.rerunLastApex", rerunLastApex);

		// CodeLens
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider(
				[
					{ language: "apex", scheme: "file" },
					{ pattern: "**/*.apex", scheme: "file" },
				],
				new ApexCodeLensProvider()
			)
		);

		// 6. Execute SOQL
		let executeSOQLCmd = register("adure-sfx-toolkit.executeSOQL", executeSOQL);

		// 7. Side Bar Log Provider (shows logs from .sfdx/tools/debug/logs, no own download)
		vscode.window.registerTreeDataProvider("adure-sfx-toolkit.logs", logTreeProvider);

		let refreshLogsCmd = register("adure-sfx-toolkit.refreshLogs", async () => {
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

		let openLogCmd = register("adure-sfx-toolkit.openLog", async (logId: string) => {
			if (logId) {
				await openLogById(logId);
			}
		});

		let deleteAllLogsCmd = register("adure-sfx-toolkit.deleteAllLogs", deleteAllLogs);

		// 8. Side Bar Trace Provider
		const traceProvider = new TraceTreeProvider();
		vscode.window.registerTreeDataProvider("adure-sfx-toolkit.traces", traceProvider);

		let refreshTracesCmd = register("adure-sfx-toolkit.refreshTraces", () => {
			traceProvider.refresh();
		});

		let quickTraceCmd = register("adure-sfx-toolkit.quickTrace", quickTrace);

		// For deleteTrace, we expect a TraceItem which has a traceId, or a generic call.
		let deleteTraceCmd = register("adure-sfx-toolkit.deleteTrace", async (item?: any) => {
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
			treeDataProvider: orgTreeProvider,
		});

		let refreshOrgsCmd = register("adure-sfx-toolkit.refreshOrgs", () => orgTreeProvider.refresh());
		let openOrgCmd = register("adure-sfx-toolkit.openOrg", openOrg);
		let setAsDefaultCmd = register("adure-sfx-toolkit.setAsDefaultOrg", setAsDefault);
		let setAsDefaultDevHubCmd = register("adure-sfx-toolkit.setAsDefaultDevHub", setAsDefaultDevHub);
		let copyUsernameCmd = register("adure-sfx-toolkit.copyUsername", copyUsername);
		let renameAliasCmd = register("adure-sfx-toolkit.renameAlias", renameAlias);
		let generatePasswordCmd = register("adure-sfx-toolkit.generatePassword", generatePassword);
		let deleteOrgCmd = register("adure-sfx-toolkit.deleteOrg", deleteOrg);

		let connectOrgCmd = register("adure-sfx-toolkit.connectOrg", connectOrg);
		let createScratchCmd = register("adure-sfx-toolkit.createScratch", createScratch);
		let quickScratchCmd = register("adure-sfx-toolkit.quickScratch", quickScratch);

		// 8. Execute Apex panel (bottom panel only; content persisted in .vscode/anon-apex-buffer.apex)
		const anonymousApexProvider = new AnonymousApexViewProvider(context.extensionUri);
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider("adure-sfx-toolkit.anonymousApexPanel", anonymousApexProvider)
		);

		// 9. Development Actions
		const devProvider = new DevActionsProvider();
		vscode.window.registerTreeDataProvider("adure-sfx-toolkit.development", devProvider);

		let pushCmd = register("adure-sfx-toolkit.pushSource", pushSource);
		let pushForceCmd = register("adure-sfx-toolkit.pushSourceForce", pushSourceForce);
		let pullCmd = register("adure-sfx-toolkit.pullSource", pullSource);
		let deployFileCmd = register("adure-sfx-toolkit.deployCurrentFile", deployCurrentFile);
		let retrieveFileCmd = register("adure-sfx-toolkit.retrieveCurrentFile", retrieveCurrentFile);
		let runTestsCmd = register("adure-sfx-toolkit.runLocalTests", runLocalTests);
		let resetTrackingCmd = register("adure-sfx-toolkit.resetSourceTracking", resetSourceTracking);
		let refreshMetadataCmd = register("adure-sfx-toolkit.refreshMetadata", async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: "Refreshing org metadata cache...", cancellable: false },
				() => OrgMetadataCache.refresh(null)
			);
			vscode.window.showInformationMessage("Org metadata cache refreshed.");
		});

		// 10. Permission Set Editor
		context.subscriptions.push(PermissionSetEditorProvider.register(context));

		// Command to open permission set in UI mode
		let openPermissionSetUICmd = register("adure-sfx-toolkit.openPermissionSetUI", async () => {
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

		// 11. Log Content Provider (sf-log and sf-anon-log scheme)
		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("sf-log", logContentProvider));
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider("sf-anon-log", logContentProvider)
		);

		// 12. Polling Logic
		let pollingInterval: NodeJS.Timeout | undefined;
		let isPolling = false;

		let startPollingCmd = register("adure-sfx-toolkit.startPolling", async () => {
			isPolling = true;
			logTreeProvider.isPolling = true;
			await vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", true);

			if (!pollingInterval) {
				// Immediate fetch from org, then every N seconds
				logTreeProvider.fetchNewLogsFromOrg().then(() => logTreeProvider.refresh());
				pollingInterval = setInterval(() => {
					if (logTreeProvider.isPolling) {
						logTreeProvider.fetchNewLogsFromOrg();
					}
				}, getPollingInterval() * 1000);
			}
			vscode.window.showInformationMessage(`Log polling started: retrieving logs every ${getPollingInterval()}s`);
		});

		let stopPollingCmd = register("adure-sfx-toolkit.stopPolling", async () => {
			isPolling = false;
			logTreeProvider.isPolling = false;
			await vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", false);

			if (pollingInterval) {
				clearInterval(pollingInterval);
				pollingInterval = undefined;
			}
			vscode.window.showInformationMessage("Log Polling Stopped");
		});

		// Initialize context
		vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", false);

		// 13. SOQL Editor
		let openSOQLEditorCmd = register("adure-sfx-toolkit.openSOQLEditor", () => {
			SOQLEditorProvider.show(context.extensionUri);
		});

		// 14. Show Output
		let showOutputCmd = register("adure-sfx-toolkit.showOutput", () => {
			outputChannel.show();
		});

		// 15. New Feature Commands
		let metadataDiffCmd = register("adure-sfx-toolkit.metadataDiff", metadataDiff);
		let orgHealthCmd = register("adure-sfx-toolkit.orgHealth", () => OrgHealthProvider.show(context.extensionUri));
		let quickSoqlCmd = register("adure-sfx-toolkit.quickSoql", () => quickSoqlFromSelection(context.extensionUri));
		let deployHistoryCmd = register("adure-sfx-toolkit.deployHistory", () => DeployHistoryProvider.show());

		// 16. Apex Snippets (sidebar view like Debug Traces + quick pick + overview panel)
		const snippetProvider = new SnippetTreeProvider();
		vscode.window.registerTreeDataProvider('adure-sfx-toolkit.snippets', snippetProvider);
		let showSnippetsCmd = register('adure-sfx-toolkit.showSnippets', showSnippets);
		let openSnippetsPanelCmd = register('adure-sfx-toolkit.openSnippetsPanel', () => ApexSnippetsPanelProvider.show());
		let runSnippetCmd = register('adure-sfx-toolkit.runSnippet', (snippet?: any) => runSnippet(snippet));
		let addSnippetCmd = register('adure-sfx-toolkit.addSnippet', async () => {
			await addSnippet();
			snippetProvider.refresh();
			ApexSnippetsPanelProvider.refreshPanel();
		});
		let deleteSnippetCmd = register('adure-sfx-toolkit.deleteSnippet', async (item?: { index?: number }) => {
			if (item != null && typeof item.index === 'number' && item.index >= 0) {
				await deleteSnippetByIndex(item.index);
				snippetProvider.refresh();
				ApexSnippetsPanelProvider.refreshPanel();
			} else {
				await deleteSnippet();
				snippetProvider.refresh();
			}
		});
		let editSnippetFileCmd = register('adure-sfx-toolkit.editSnippetFile', async () => {
			await editSnippetFile();
			snippetProvider.refresh();
		});
		let refreshSnippetsCmd = register('adure-sfx-toolkit.refreshSnippets', () => snippetProvider.refresh());
		let editSnippetCmd = register('adure-sfx-toolkit.editSnippet', (snippetOrItem?: { snippet?: ApexSnippet; name?: string; code?: string }) => {
			const s = (snippetOrItem?.snippet ?? snippetOrItem) as ApexSnippet | undefined;
			if (s && typeof s.name === 'string') openSnippetEditor(s);
		});
		const snippetStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		snippetStatusBarItem.text = '$(code) Apex Snippets';
		snippetStatusBarItem.tooltip = 'Click for Apex Snippets menu';
		snippetStatusBarItem.command = 'adure-sfx-toolkit.showSnippets';
		if (isSalesforceProject()) snippetStatusBarItem.show();
		context.subscriptions.push(snippetStatusBarItem);
		const updateSnippetStatusBar = () => {
			if (isSalesforceProject()) snippetStatusBarItem.show();
			else snippetStatusBarItem.hide();
		};
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				updateSalesforceProjectContext();
				updateSnippetStatusBar();
			})
		);
		updateSnippetStatusBar();

		// 17. Add to Ignore
		let addToGitignoreCmd = register('adure-sfx-toolkit.addToGitignore', (uri?: vscode.Uri) => addToGitignore(uri));
		let addToForceignoreCmd = register('adure-sfx-toolkit.addToForceignore', (uri?: vscode.Uri) => addToForceignore(uri));
		let addToIgnoreCmd = register('adure-sfx-toolkit.addToIgnore', (uri?: vscode.Uri) => addToIgnore(uri));

		// 18. LWC Navigator
		let lwcNavCmd = register("adure-sfx-toolkit.lwcNavigate", lwcNavigate);
		let lwcJsCmd = register("adure-sfx-toolkit.lwcGoToJs", lwcGoToJs);
		let lwcHtmlCmd = register("adure-sfx-toolkit.lwcGoToHtml", lwcGoToHtml);
		let lwcMetaCmd = register("adure-sfx-toolkit.lwcGoToMeta", lwcGoToMeta);
		let lwcCssCmd = register("adure-sfx-toolkit.lwcGoToCss", lwcGoToCss);

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
			addSnippetCmd,
			deleteSnippetCmd,
			editSnippetFileCmd,
			editSnippetCmd,
			lwcNavCmd,
			lwcJsCmd,
			lwcHtmlCmd,
			lwcMetaCmd,
			lwcCssCmd
		);

		Logger.info('Extension "adure-sfx-toolkit" activated successfully.');
	} catch (error) {
		Logger.error('Failed to activate extension "adure-sfx-toolkit"', error);
	}
}

export function deactivate() {
	Logger.info('Extension "adure-sfx-toolkit" is deactivating...');
}
