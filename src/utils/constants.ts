import * as vscode from "vscode";

export const TOOLING_API_VERSION = "v60.0";
export const ASFX_DIR = ".sfdx/asfx";
export const SF_DEBUG_LOGS_DIR = ".sfdx/tools/debug/logs";

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("adure-sfx-toolkit");
}

export function getPollingInterval(): number {
  return getConfig().get<number>("pollingIntervalSeconds", 5);
}

export function getMaxLogFiles(): number {
  return getConfig().get<number>("maxLogFiles", 20);
}

export function getQuickTraceDuration(): number {
  return getConfig().get<number>("quickTraceDurationMinutes", 240);
}

export function getQuickTraceDebugLevel(): string {
  return getConfig().get<string>("quickTraceDebugLevel", "SFDC_DevConsole");
}

export function getToolingApiVersion(): string {
  return getConfig().get<string>("toolingApiVersion", "v60.0");
}

export function getParallelDeletes(): number {
  return getConfig().get<number>("parallelDeletes", 8);
}

export function getTestRunTimeout(): number {
  return getConfig().get<number>("testRunTimeoutMinutes", 10);
}

export function getAutoSaveBeforePush(): boolean {
  return getConfig().get<boolean>("autoSaveBeforePush", true);
}

export function getHttpTimeout(): number {
  return getConfig().get<number>("httpTimeoutMs", 30000);
}

export function getRemoveFinalNewlineEnabled(): boolean {
  return getConfig().get<boolean>("removeFinalNewline.enabled", false);
}

export function getRemoveFinalNewlinePatterns(): string[] {
  const value = getConfig().get<string[]>("removeFinalNewline.patterns", []);
  return Array.isArray(value) ? value.filter((p) => typeof p === "string" && p.length > 0) : [];
}

export function getRemoveFinalNewlineLanguages(): string[] {
  const defaults = ["javascript", "javascriptreact", "html", "css"];
  const value = getConfig().get<string[]>("removeFinalNewline.languages", defaults);
  return Array.isArray(value) ? value.filter((l) => typeof l === "string" && l.length > 0) : defaults;
}

export function getRemoveFinalNewlineRunOnSave(): boolean {
  return getConfig().get<boolean>("removeFinalNewline.runOnSave", true);
}

export function getWarnOnProductionOrg(): boolean {
  return getConfig().get<boolean>("warnOnProductionOrg", true);
}

export function getTelemetryEnabled(): boolean {
  return getConfig().get<boolean>("telemetry.enabled", true);
}
