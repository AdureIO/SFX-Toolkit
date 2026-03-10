import * as vscode from 'vscode';

export const TOOLING_API_VERSION = 'v60.0';
export const ASFX_DIR = '.sfdx/asfx';
export const SF_DEBUG_LOGS_DIR = '.sfdx/tools/debug/logs';

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('adure-sfx-toolkit');
}

export function getPollingInterval(): number {
    return getConfig().get<number>('pollingIntervalSeconds', 5);
}

export function getMaxLogFiles(): number {
    return getConfig().get<number>('maxLogFiles', 20);
}

export function getQuickTraceDuration(): number {
    return getConfig().get<number>('quickTraceDurationMinutes', 240);
}

export function getQuickTraceDebugLevel(): string {
    return getConfig().get<string>('quickTraceDebugLevel', 'SFDC_DevConsole');
}

export function getToolingApiVersion(): string {
    return getConfig().get<string>('toolingApiVersion', 'v60.0');
}

export function getParallelDeletes(): number {
    return getConfig().get<number>('parallelDeletes', 8);
}

export function getTestRunTimeout(): number {
    return getConfig().get<number>('testRunTimeoutMinutes', 10);
}

export function getAutoSaveBeforePush(): boolean {
    return getConfig().get<boolean>('autoSaveBeforePush', true);
}

export function getHttpTimeout(): number {
    return getConfig().get<number>('httpTimeoutMs', 30000);
}
