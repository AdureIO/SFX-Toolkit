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

import { openOrg, setAsDefault, copyUsername, deleteOrg, renameAlias, generatePassword, setAsDefaultDevHub } from './commands/orgCommands';
import { orgTreeProvider } from './providers/OrgTreeProvider';
import { ApexCodeLensProvider } from './providers/ApexCodeLensProvider';
import { DevActionsProvider } from './providers/DevActionsProvider';
import { pushSource, pullSource, deployCurrentFile, retrieveCurrentFile, runLocalTests } from './commands/devCommands';
import { PermissionSetEditorProvider } from './editors/PermissionSetEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "salesforce-utils" is now active!');

    // 1. Filter Logs Commands
    // 1. Filter Logs Commands (Normal and Active versions point to same handler)
    let filterDebugCmd = vscode.commands.registerCommand('salesforce-utils.filterLogDebug', filterLogDebug);
    let filterDebugActiveCmd = vscode.commands.registerCommand('salesforce-utils.filterLogDebugActive', filterLogDebug);
    
    let filterSOQLCmd = vscode.commands.registerCommand('salesforce-utils.filterLogSOQL', filterLogSOQL);
    let filterSOQLActiveCmd = vscode.commands.registerCommand('salesforce-utils.filterLogSOQLActive', filterLogSOQL);
    
    let filterDMLCmd = vscode.commands.registerCommand('salesforce-utils.filterLogDML', filterLogDML);
    let filterDMLActiveCmd = vscode.commands.registerCommand('salesforce-utils.filterLogDMLActive', filterLogDML);
    
    // Sync Context on Switch
    vscode.window.onDidChangeActiveTextEditor(editor => {
        updateContextForEditor(editor);
    });

    // 2. List Logs
    let listLogsCmd = vscode.commands.registerCommand('salesforce-utils.listLogs', listLogs);

    // 3. Add Debug Trace
    let addDebugTraceCmd = vscode.commands.registerCommand('salesforce-utils.addDebugTrace', addDebugTrace);

    // 4. Deploy Classes
    let deployClassesCmd = vscode.commands.registerCommand('salesforce-utils.deployClasses', deployClasses);

    // 5. Execute Anonymous Apex
    let executeAnonCmd = vscode.commands.registerCommand('salesforce-utils.executeAnonymous', executeAnonymous);
    let rerunAnonCmd = vscode.commands.registerCommand('salesforce-utils.rerunLastApex', rerunLastApex);
    
    // CodeLens
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [{ language: 'apex', scheme: 'file' }, { pattern: '**/*.apex', scheme: 'file' }], 
            new ApexCodeLensProvider()
        )
    );

    // 6. Execute SOQL
    let executeSOQLCmd = vscode.commands.registerCommand('salesforce-utils.executeSOQL', executeSOQL);

    // 7. Side Bar Log Provider
    // Use singleton
    vscode.window.registerTreeDataProvider('salesforce-utils.logs', logTreeProvider);

    let refreshLogsCmd = vscode.commands.registerCommand('salesforce-utils.refreshLogs', () => {
        logTreeProvider.refresh();
    });

    let openLogCmd = vscode.commands.registerCommand('salesforce-utils.openLog', async (logId: string) => {
        if (logId) {
            await openLogById(logId);
        }
    });

    let deleteAllLogsCmd = vscode.commands.registerCommand('salesforce-utils.deleteAllLogs', deleteAllLogs);

    // 8. Side Bar Trace Provider
    const traceProvider = new TraceTreeProvider();
    vscode.window.registerTreeDataProvider('salesforce-utils.traces', traceProvider);

    let refreshTracesCmd = vscode.commands.registerCommand('salesforce-utils.refreshTraces', () => {
        traceProvider.refresh();
    });

    let quickTraceCmd = vscode.commands.registerCommand('salesforce-utils.quickTrace', quickTrace);

    // For deleteTrace, we expect a TraceItem which has a traceId, or a generic call.
    let deleteTraceCmd = vscode.commands.registerCommand('salesforce-utils.deleteTrace', async (item?: any) => {
        if (item && item.traceId) {
            await deleteTrace(item.traceId);
        } else {
             // If called without context, maybe show list? or just return.
             // Usually context menu passes item.
             vscode.window.showInformationMessage('Use the context menu on a trace to delete it.');
        }
    });
    
    // 7. Org Manager
    vscode.window.registerTreeDataProvider('salesforce-utils.orgs', orgTreeProvider);
    
    let refreshOrgsCmd = vscode.commands.registerCommand('salesforce-utils.refreshOrgs', () => orgTreeProvider.refresh());
    let openOrgCmd = vscode.commands.registerCommand('salesforce-utils.openOrg', openOrg);
    let setAsDefaultCmd = vscode.commands.registerCommand('salesforce-utils.setAsDefaultOrg', setAsDefault);
    let setAsDefaultDevHubCmd = vscode.commands.registerCommand('salesforce-utils.setAsDefaultDevHub', setAsDefaultDevHub);
    let copyUsernameCmd = vscode.commands.registerCommand('salesforce-utils.copyUsername', copyUsername);
    let renameAliasCmd = vscode.commands.registerCommand('salesforce-utils.renameAlias', renameAlias);
    let generatePasswordCmd = vscode.commands.registerCommand('salesforce-utils.generatePassword', generatePassword);
    let deleteOrgCmd = vscode.commands.registerCommand('salesforce-utils.deleteOrg', deleteOrg);

    // 8. Development Actions
    const devProvider = new DevActionsProvider();
    vscode.window.registerTreeDataProvider('salesforce-utils.development', devProvider);
    
    let pushCmd = vscode.commands.registerCommand('salesforce-utils.pushSource', pushSource);
    let pullCmd = vscode.commands.registerCommand('salesforce-utils.pullSource', pullSource);
    let deployFileCmd = vscode.commands.registerCommand('salesforce-utils.deployCurrentFile', deployCurrentFile);
    let retrieveFileCmd = vscode.commands.registerCommand('salesforce-utils.retrieveCurrentFile', retrieveCurrentFile);
    let runTestsCmd = vscode.commands.registerCommand('salesforce-utils.runLocalTests', runLocalTests);

    // 9. Permission Set Editor
    context.subscriptions.push(PermissionSetEditorProvider.register(context));

    // 10. Log Content Provider (sf-log and sf-anon-log scheme)
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('sf-log', logContentProvider));
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('sf-anon-log', logContentProvider));

    // 11. Polling Logic
    let pollingInterval: NodeJS.Timeout | undefined;
    let isPolling = false;

    let startPollingCmd = vscode.commands.registerCommand('salesforce-utils.startPolling', async () => {
        isPolling = true;
        logTreeProvider.isPolling = true;
        await vscode.commands.executeCommand('setContext', 'salesforce-utils:polling', true);
        
        // Refresh every 5 seconds
        if (!pollingInterval) {
            logTreeProvider.refresh(); // Immediate refresh
            pollingInterval = setInterval(() => {
                logTreeProvider.refresh();
            }, 5000);
        }
        vscode.window.showInformationMessage('Log Polling Started (5s)');
    });

    let stopPollingCmd = vscode.commands.registerCommand('salesforce-utils.stopPolling', async () => {
        isPolling = false;
        logTreeProvider.isPolling = false;
        await vscode.commands.executeCommand('setContext', 'salesforce-utils:polling', false);
        
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = undefined;
        }
        vscode.window.showInformationMessage('Log Polling Stopped');
    });
    
    // Initialize context
    vscode.commands.executeCommand('setContext', 'salesforce-utils:polling', false);

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
        deleteOrgCmd
    );
}

export function deactivate() {}
