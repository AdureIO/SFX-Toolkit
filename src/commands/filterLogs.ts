import * as vscode from 'vscode';
import { logContentProvider, FilterType } from '../providers/LogContentProvider';

export async function updateContextForEditor(editor: vscode.TextEditor | undefined) {
    if (!editor || (editor.document.uri.scheme !== 'sf-log' && editor.document.uri.scheme !== 'sf-anon-log')) {
        // Reset or disable
        await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterDebug', false);
        await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterSOQL', false);
        await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterDML', false);
        return;
    }

    const uri = editor.document.uri;
    await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterDebug', logContentProvider.isFilterActive(uri, 'DEBUG'));
    await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterSOQL', logContentProvider.isFilterActive(uri, 'SOQL'));
    await vscode.commands.executeCommand('setContext', 'salesforce-utils:filterDML', logContentProvider.isFilterActive(uri, 'DML'));
}

async function toggleFilter(type: FilterType) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const document = editor.document;
    
    // Only works for our custom scheme
    if (document.uri.scheme === 'sf-log' || document.uri.scheme === 'sf-anon-log') {
        logContentProvider.toggleFilter(document.uri, type);
        await updateContextForEditor(editor);
    } else {
        vscode.window.showInformationMessage('Open a log via the Salesforce Logs view to use this filter.');
    }
}

export async function filterLogDebug() {
    await toggleFilter('DEBUG');
}

export async function filterLogSOQL() {
    await toggleFilter('SOQL');
}

export async function filterLogDML() {
    await toggleFilter('DML');
}
