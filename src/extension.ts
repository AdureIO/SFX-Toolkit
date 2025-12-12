import * as vscode from "vscode";
import { listLogs } from "./commands/listLogs";
import { filterLogDebug, filterLogSOQL, updateContextForEditor } from "./commands/filterLogs"; // Updated imports
import { addDebugTrace } from "./commands/addDebugTrace";
import { deployClasses } from "./commands/deployClasses";
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
import { pushSource, pullSource, deployCurrentFile, retrieveCurrentFile, runLocalTests } from "./commands/devCommands";
import { PermissionSetEditorProvider } from "./editors/PermissionSetEditorProvider";
import { ScratchOrgDefEditorProvider } from "./editors/ScratchOrgDefEditorProvider";
import { Logger } from "./utils/outputChannel";
import { isSalesforceProject } from "./utils/projectUtils";

// Helper to register commands with logging
function register(command: string, callback: (...args: any[]) => any, thisArg?: any): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (...args: any[]) => {
		Logger.info(`Command triggered: ${command}`);
		try {
			// Check if project is valid for commands that likely require it
			// Most commands interact with SF, so we can do a broad check or check inside commands.
			// The user requested checking on activation, but checking here protects execution.
			if (!isSalesforceProject()) {
				// Allow some commands like creating a project or settings? 
				// For now, let's warn but allow execution if the user persists, or maybe block sensitive ones?
				// User said "to avoid errors", so let's log a warning.
				// However, blocking might be too aggressive if they are just opening a log file.
				// Let's just rely on the activation check for the main warning.
			}
			return await callback.call(thisArg, ...args);
		} catch (error) {
			Logger.error(`Error executing command: ${command}`, error);
			throw error;
		}
	});
}

export function activate(context: vscode.ExtensionContext) {
	Logger.info('Extension "adure-sfx-toolkit" is starting activation...');

	// Check for Salesforce Project
	if (!isSalesforceProject()) {
		const msg = 'Adure SFX Toolkit: No "sfdx-project.json" found in workspace root. Some Salesforce features may not work correctly.';
		Logger.warn(msg);
		vscode.window.showWarningMessage(msg);
	}

	try {
		console.log('Congratulations, your extension "adure-sfx-toolkit" is now active!');

		// 1. Filter Logs Commands
		// 1. Filter Logs Commands (Normal and Active versions point to same handler)
		let filterDebugCmd = register("adure-sfx-toolkit.filterLogDebug", filterLogDebug);
		let filterDebugActiveCmd = register("adure-sfx-toolkit.filterLogDebugActive", filterLogDebug);

		let filterSOQLCmd = register("adure-sfx-toolkit.filterLogSOQL", filterLogSOQL);
		let filterSOQLActiveCmd = register("adure-sfx-toolkit.filterLogSOQLActive", filterLogSOQL);

		// Sync Context on Switch
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			updateContextForEditor(editor);
		});

        // Initialize context for current editor
        if (vscode.window.activeTextEditor) {
            updateContextForEditor(vscode.window.activeTextEditor);
        }

		// 2. List Logs
		let listLogsCmd = register("adure-sfx-toolkit.listLogs", listLogs);

		// 3. Add Debug Trace
		let addDebugTraceCmd = register("adure-sfx-toolkit.addDebugTrace", addDebugTrace);

		// 4. Deploy Classes
		let deployClassesCmd = register("adure-sfx-toolkit.deployClasses", deployClasses);

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

		// 7. Side Bar Log Provider
		// Use singleton
		vscode.window.registerTreeDataProvider("adure-sfx-toolkit.logs", logTreeProvider);

		let refreshLogsCmd = register("adure-sfx-toolkit.refreshLogs", () => {
			logTreeProvider.refresh();
		});

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

		// 8. Development Actions
		const devProvider = new DevActionsProvider();
		vscode.window.registerTreeDataProvider("adure-sfx-toolkit.development", devProvider);

		let pushCmd = register("adure-sfx-toolkit.pushSource", pushSource);
		let pullCmd = register("adure-sfx-toolkit.pullSource", pullSource);
		let deployFileCmd = register("adure-sfx-toolkit.deployCurrentFile", deployCurrentFile);
		let retrieveFileCmd = register("adure-sfx-toolkit.retrieveCurrentFile", retrieveCurrentFile);
		let runTestsCmd = register("adure-sfx-toolkit.runLocalTests", runLocalTests);

		// 9. Permission Set Editor
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

		// 10. Log Content Provider (sf-log and sf-anon-log scheme)
		context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("sf-log", logContentProvider));
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider("sf-anon-log", logContentProvider)
		);

		// 11. Polling Logic
		let pollingInterval: NodeJS.Timeout | undefined;
		let isPolling = false;

		let startPollingCmd = register("adure-sfx-toolkit.startPolling", async () => {
			isPolling = true;
			logTreeProvider.isPolling = true;
			await vscode.commands.executeCommand("setContext", "adure-sfx-toolkit:polling", true);

			// Refresh every 5 seconds
			if (!pollingInterval) {
				logTreeProvider.refresh(); // Immediate refresh
				pollingInterval = setInterval(() => {
					logTreeProvider.refresh();
				}, 5000);
			}
			vscode.window.showInformationMessage("Log Polling Started (5s)");
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

		context.subscriptions.push(
			filterDebugCmd,
			filterDebugActiveCmd,
			filterSOQLCmd,
			filterSOQLActiveCmd,
			listLogsCmd,
			addDebugTraceCmd,
			deployClassesCmd,
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
			quickScratchCmd
		);

		Logger.info('Extension "adure-sfx-toolkit" activated successfully.');
	} catch (error) {
		Logger.error('Failed to activate extension "adure-sfx-toolkit"', error);
	}
}

export function deactivate() {
	Logger.info('Extension "adure-sfx-toolkit" is deactivating...');
}
