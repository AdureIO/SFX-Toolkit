import * as vscode from 'vscode';
import { logContentProvider, FilterType } from '../providers/LogContentProvider';
import { Logger } from '../utils/outputChannel';

export async function updateContextForEditor(editor: vscode.TextEditor | undefined) {
    if (!editor || (editor.document.uri.scheme !== 'sf-log' && editor.document.uri.scheme !== 'sf-anon-log')) {
        // Reset or disable
        await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:filterDebug', false);
        await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:filterSOQL', false);
        await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:isLogFile', false);
        return;
    }

    const uri = editor.document.uri;
    const isDebug = logContentProvider.isFilterActive(uri, 'DEBUG');
    const isSOQL = logContentProvider.isFilterActive(uri, 'SOQL');
    
    Logger.info(`Updating Context for ${uri.toString()}: DEBUG=${isDebug}, SOQL=${isSOQL}`);

    await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:filterDebug', isDebug);
    await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:filterSOQL', isSOQL);
    await vscode.commands.executeCommand('setContext', 'adure-sfx-toolkit:isLogFile', true);
}

async function toggleFilter(type: FilterType, uri?: vscode.Uri) {
    // If URI is passed (from context menu/title bar), use it. Otherwise use active editor.
    let targetUri = uri;
    let editor = vscode.window.activeTextEditor;

    if (!targetUri) {
        if (!editor) return;
        targetUri = editor.document.uri;
    }

    // Only works for our custom scheme
    if (targetUri.scheme === 'sf-log' || targetUri.scheme === 'sf-anon-log') {
        Logger.info(`Toggling filter ${type} for ${targetUri.toString()}`);
        
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Applying ${type} Filter...`,
            cancellable: false
        }, async () => {
            // Toggle the filter
            logContentProvider.toggleFilter(targetUri!, type);
            
            // Update context if the modified log is the active one
            if (editor && editor.document.uri.toString() === targetUri!.toString()) {
                await updateContextForEditor(editor);
            }
        });
    } else {
        vscode.window.showInformationMessage('Open a log via the Salesforce Logs view to use this filter.');
    }
}

export async function filterLogDebug(uri?: vscode.Uri) {
    await toggleFilter('DEBUG', uri);
}

export async function filterLogSOQL(uri?: vscode.Uri) {
    await toggleFilter('SOQL', uri);
}
