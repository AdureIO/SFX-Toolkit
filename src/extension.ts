import * as vscode from 'vscode';
import { listLogs } from './commands/listLogs';
import { filterLogDebug, filterLogSOQL, filterLogDML, updateContextForEditor } from './commands/filterLogs'; // Updated imports
import { addDebugTrace } from './commands/addDebugTrace';
import { deployClasses } from './commands/deployClasses';
import { executeAnonymous, rerunLastApex } from './commands/executeAnonymous';
import { executeSOQL } from './commands/executeSOQL';
import { LogTreeProvider, logTreeProvider } from './providers/LogTreeProvider';
import { openLogById } from './commands/listLogs';
import { deleteAllLogs } from './commands/deleteAllLogs';
import { TraceTreeProvider } from './providers/TraceTreeProvider';
import { quickTrace, deleteTrace } from './commands/traceCommands';
import { logContentProvider } from './providers/LogContentProvider';

import { openOrg, setAsDefault, copyUsername, deleteOrg, renameAlias, generatePassword, setAsDefaultDevHub, connectOrg, createScratch, quickScratch } from './commands/orgCommands';
import { orgTreeProvider } from './providers/OrgTreeProvider';
import { ApexCodeLensProvider } from './providers/ApexCodeLensProvider';
import { DevActionsProvider } from './providers/DevActionsProvider';
import { pushSource, pullSource, deployCurrentFile, retrieveCurrentFile, runLocalTests } from './commands/devCommands';
import { PermissionSetEditorProvider } from './editors/PermissionSetEditorProvider';
import { ScratchOrgDefEditorProvider } from './editors/ScratchOrgDefEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "adure-sfx-toolkit" is now active!');

    // 1. Filter Logs Commands
    // 1. Filter Logs Commands (Normal and Active versions point to same handler)
    let filterDebugCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogDebug', filterLogDebug);
    let filterDebugActiveCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogDebugActive', filterLogDebug);
    
    let filterSOQLCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogSOQL', filterLogSOQL);
    let filterSOQLActiveCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogSOQLActive', filterLogSOQL);
    
    let filterDMLCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogDML', filterLogDML);
    let filterDMLActiveCmd = vscode.commands.registerCommand('adure-sfx-toolkit.filterLogDMLActive', filterLogDML);
    
    // Sync Context on Switch
    vscode.window.onDidChangeActiveTextEditor(editor => {
        updateContextForEditor(editor);
    });

    // 2. List Logs
    let listLogsCmd = vscode.commands.registerCommand('adure-sfx-toolkit.listLogs', listLogs);

    // 3. Add Debug Trace
    let addDebugTraceCmd = vscode.commands.registerCommand('adure-sfx-toolkit.addDebugTrace', addDebugTrace);

    // 4. Deploy Classes
    let deployClassesCmd = vscode.commands.registerCommand('adure-sfx-toolkit.deployClasses', deployClasses);

    // 5. Execute Anonymous Apex
    let executeAnonCmd = vscode.commands.registerCommand('adure-sfx-toolkit.executeAnonymous', executeAnonymous);
    let rerunAnonCmd = vscode.commands.registerCommand('adure-sfx-toolkit.rerunLastApex', rerunLastApex);
    
    // CodeLens
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [{ language: 'apex', scheme: 'file' }, { pattern: '**/*.apex', scheme: 'file' }], 
            new ApexCodeLensProvider()
        )
    );

    // 6. Execute SOQL
    let executeSOQLCmd = vscode.commands.registerCommand('adure-sfx-toolkit.executeSOQL', executeSOQL);

    // 7. Side Bar Log Provider
    // Use singleton
    vscode.window.registerTreeDataProvider('adure-sfx-toolkit.logs', logTreeProvider);

    let refreshLogsCmd = vscode.commands.registerCommand('adure-sfx-toolkit.refreshLogs', () => {
        logTreeProvider.refresh();
    });

    let openLogCmd = vscode.commands.registerCommand('adure-sfx-toolkit.openLog', async (logId: string) => {
        if (logId) {
            await openLogById(logId);
        }
    });

    let deleteAllLogsCmd = vscode.commands.registerCommand('adure-sfx-toolkit.deleteAllLogs', deleteAllLogs);

    // 8. Side Bar Trace Provider
    const traceProvider = new TraceTreeProvider();
    vscode.window.registerTreeDataProvider('adure-sfx-toolkit.traces', traceProvider);

    let refreshTracesCmd = vscode.commands.registerCommand('adure-sfx-toolkit.refreshTraces', () => {
        traceProvider.refresh();
    });

    let quickTraceCmd = vscode.commands.registerCommand('adure-sfx-toolkit.quickTrace', quickTrace);

    // For deleteTrace, we expect a TraceItem which has a traceId, or a generic call.
    let deleteTraceCmd = vscode.commands.registerCommand('adure-sfx-toolkit.deleteTrace', async (item?: any) => {
        if (item && item.traceId) {
            await deleteTrace(item.traceId);
        } else {
             // If called without context, maybe show list? or just return.
             // Usually context menu passes item.
             vscode.window.showInformationMessage('Use the context menu on a trace to delete it.');
        }
    });
    
    // 7. Org Manager
    const orgTreeView = vscode.window.createTreeView('adure-sfx-toolkit.orgs', { treeDataProvider: orgTreeProvider });
    
    let refreshOrgsCmd = vscode.commands.registerCommand('adure-sfx-toolkit.refreshOrgs', () => orgTreeProvider.refresh());
    let openOrgCmd = vscode.commands.registerCommand('adure-sfx-toolkit.openOrg', openOrg);
    let setAsDefaultCmd = vscode.commands.registerCommand('adure-sfx-toolkit.setAsDefaultOrg', setAsDefault);
    let setAsDefaultDevHubCmd = vscode.commands.registerCommand('adure-sfx-toolkit.setAsDefaultDevHub', setAsDefaultDevHub);
    let copyUsernameCmd = vscode.commands.registerCommand('adure-sfx-toolkit.copyUsername', copyUsername);
    let renameAliasCmd = vscode.commands.registerCommand('adure-sfx-toolkit.renameAlias', renameAlias);
    let generatePasswordCmd = vscode.commands.registerCommand('adure-sfx-toolkit.generatePassword', generatePassword);
    let deleteOrgCmd = vscode.commands.registerCommand('adure-sfx-toolkit.deleteOrg', deleteOrg);

    let connectOrgCmd = vscode.commands.registerCommand('adure-sfx-toolkit.connectOrg', connectOrg);
    let createScratchCmd = vscode.commands.registerCommand('adure-sfx-toolkit.createScratch', createScratch);
    let quickScratchCmd = vscode.commands.registerCommand('adure-sfx-toolkit.quickScratch', quickScratch);

    // 8. Development Actions
    const devProvider = new DevActionsProvider();
    vscode.window.registerTreeDataProvider('adure-sfx-toolkit.development', devProvider);
    
    let pushCmd = vscode.commands.registerCommand('adure-sfx-toolkit.pushSource', pushSource);
    let pullCmd = vscode.commands.registerCommand('adure-sfx-toolkit.pullSource', pullSource);
    let deployFileCmd = vscode.commands.registerCommand('adure-sfx-toolkit.deployCurrentFile', deployCurrentFile);
    let retrieveFileCmd = vscode.commands.registerCommand('adure-sfx-toolkit.retrieveCurrentFile', retrieveCurrentFile);
    let runTestsCmd = vscode.commands.registerCommand('adure-sfx-toolkit.runLocalTests', runLocalTests);

    // 9. Permission Set Editor
    context.subscriptions.push(
        PermissionSetEditorProvider.register(context)
    );
    
    // Command to open permission set in UI mode
    let openPermissionSetUICmd = vscode.commands.registerCommand('adure-sfx-toolkit.openPermissionSetUI', async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.fileName.endsWith('.permissionset-meta.xml')) {
            await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, 'adure-sfx-toolkit.permissionSetEditor');
        }
    });
    context.subscriptions.push(openPermissionSetUICmd);

    // Register Scratch Org Definition Editor
    context.subscriptions.push(
        ScratchOrgDefEditorProvider.register(context)
    );

    // 10. Log Content Provider (sf-log and sf-anon-log scheme)
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('sf-log', logContentProvider));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('sf-anon-log', logContentProvider));

    // 11. Polling Logic
    let pollingInterval: NodeJS.Timeout | undefined;
    let isPolling = false;

    let startPollingCmd = vscode.commands.registerCommand('adure-sfx-toolkit.startPolling', async () => {
        isPolling = true;
        logTreeProvider.isPolling = true;
        await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:polling', true);
        
        // Refresh every 5 seconds
        if (!pollingInterval) {
            logTreeProvider.refresh(); // Immediate refresh
            pollingInterval = setInterval(() => {
                logTreeProvider.refresh();
            }, 5000);
        }
        vscode.window.showInformationMessage('Log Polling Started (5s)');
    });

    let stopPollingCmd = vscode.commands.registerCommand('adure-sfx-toolkit.stopPolling', async () => {
        isPolling = false;
        logTreeProvider.isPolling = false;
        await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:polling', false);
        
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = undefined;
        }
        vscode.window.showInformationMessage('Log Polling Stopped');
    });
    
    // Initialize context
    vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:polling', false);

    context.subscriptions.push(
        filterDebugCmd,
        filterDebugActiveCmd,
        filterSOQLCmd, 
        filterSOQLActiveCmd,
        filterDMLCmd, 
        filterDMLActiveCmd, 
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
}

export function deactivate() {}
