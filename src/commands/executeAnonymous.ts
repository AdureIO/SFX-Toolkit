import * as vscode from "vscode";
import { getOrgListForPicker, refreshOrgListCache, warmOrgListCache, type OrgOption } from "../utils/orgListCache";
import { confirmProductionOrgOperation } from "../utils/orgSafety";

export type { OrgOption };
import { AuthInfo } from "../utils/authInfo";
import { Telemetry } from "../utils/telemetry";
import { getToolingApiVersion } from "../utils/constants";
import { httpsPost } from "../utils/httpUtils";
import { ApexWorkbenchViewProvider } from "../providers/ApexWorkbenchViewProvider";

// ─── Fast SOAP execution (no CLI spawn; debug log inline) ───────────────────────
//
// The Salesforce "Execute Anonymous" button is fast and returns the debug log
// without a TraceFlag because it uses the SOAP Apex API with a DebuggingHeader:
// one request returns both the result and the log inline. We do the same here.

interface AnonResult {
  compiled?: boolean;
  success?: boolean;
  compileProblem?: string | null;
  exceptionMessage?: string | null;
  exceptionStackTrace?: string | null;
  line?: number;
  column?: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** First inner text of a tag (namespace-prefix tolerant); null when absent/nil. */
function soapTag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}

const SOAP_LOG_CATEGORIES: [string, string][] = [
  ["Db", "INFO"],
  ["Workflow", "INFO"],
  ["Validation", "INFO"],
  ["Callout", "INFO"],
  ["Apex_code", "DEBUG"],
  ["Apex_profiling", "INFO"],
  ["Visualforce", "INFO"],
  ["System", "DEBUG"],
];

function buildSoapEnvelope(sessionId: string, code: string): string {
  const cats = SOAP_LOG_CATEGORIES.map(
    ([c, l]) => `<apex:categories><apex:category>${c}</apex:category><apex:level>${l}</apex:level></apex:categories>`
  ).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">` +
    `<env:Header>` +
    `<apex:SessionHeader><apex:sessionId>${xmlEscape(sessionId)}</apex:sessionId></apex:SessionHeader>` +
    `<apex:DebuggingHeader>${cats}</apex:DebuggingHeader>` +
    `</env:Header>` +
    `<env:Body><apex:executeAnonymous><apex:String>${xmlEscape(code)}</apex:String></apex:executeAnonymous></env:Body>` +
    `</env:Envelope>`
  );
}

function parseSoapAnon(xml: string): { result: AnonResult; log: string } {
  const result: AnonResult = {
    compiled: soapTag(xml, "compiled") === "true",
    success: soapTag(xml, "success") === "true",
    compileProblem: soapTag(xml, "compileProblem"),
    exceptionMessage: soapTag(xml, "exceptionMessage"),
    exceptionStackTrace: soapTag(xml, "exceptionStackTrace"),
    line: parseInt(soapTag(xml, "line") ?? "-1", 10),
    column: parseInt(soapTag(xml, "column") ?? "-1", 10),
  };
  if (result.compileProblem) result.compileProblem = xmlUnescape(result.compileProblem);
  if (result.exceptionMessage) result.exceptionMessage = xmlUnescape(result.exceptionMessage);
  if (result.exceptionStackTrace) result.exceptionStackTrace = xmlUnescape(result.exceptionStackTrace);
  const log = soapTag(xml, "debugLog");
  return { result, log: log ? xmlUnescape(log) : "" };
}

/**
 * Run anonymous Apex via the SOAP Apex API with a DebuggingHeader — a single
 * request that returns the result AND the debug log inline (no TraceFlag,
 * no ApexLog polling). Refreshes the session once on an expired-session fault.
 */
async function soapExecuteAnonymous(org: string | null, code: string): Promise<{ result: AnonResult; log: string }> {
  const version = getToolingApiVersion().replace(/^v/i, ""); // "v59.0" → "59.0"
  const send = async (): Promise<string> => {
    const auth = await AuthInfo.getAuthInfoForOrg(org);
    if (!auth) throw new Error("Not authenticated. Run: sf org login web");
    const endpoint = `${auth.instanceUrl.replace(/\/$/, "")}/services/Soap/s/${version}`;
    return httpsPost(endpoint, buildSoapEnvelope(auth.accessToken, code), {
      "Content-Type": "text/xml; charset=UTF-8",
      SOAPAction: '""',
    });
  };
  let body: string;
  try {
    body = await send();
  } catch (e: any) {
    // An expired session comes back as a SOAP fault (HTTP 500) whose body carries
    // INVALID_SESSION_ID. Only that is worth a retry — any other 500 (e.g. a server
    // fault) would just fail again. `sf org display` alone returns the same stale
    // token, so force the CLI refresh-token flow first.
    if (/INVALID_SESSION_ID/.test(String(e?.message ?? e))) {
      await AuthInfo.refreshAuth(org);
      body = await send();
    } else {
      throw e;
    }
  }
  return parseSoapAnon(body);
}

/** Build a human-readable error message from an executeAnonymous result. */
function formatAnonError(r: AnonResult): string {
  if (r.compileProblem) return r.line && r.line > 0 ? `Line ${r.line}: ${r.compileProblem}` : r.compileProblem;
  if (r.exceptionMessage) return r.exceptionStackTrace ? `${r.exceptionMessage}\n${r.exceptionStackTrace}` : r.exceptionMessage;
  return "Execution failed.";
}

export interface PanelExecResult {
  success: boolean;
  compiled: boolean;
  errorMessage?: string;
  log?: string;
}

/**
 * Run anonymous Apex for the Execute Apex panel via the SOAP Apex API (no CLI,
 * no TraceFlag): a single request returns the result and the debug log inline —
 * matching the speed and behavior of the Salesforce "Execute Anonymous" button.
 */
export async function executeAnonymousForPanel(code: string, targetOrg?: string): Promise<PanelExecResult> {
  if (!code || !code.trim()) return { success: false, compiled: false, errorMessage: "No code to execute." };
  if (!(await confirmProductionOrgOperation("execute anonymous Apex against", targetOrg))) {
    return { success: false, compiled: false, errorMessage: "Cancelled." };
  }
  const org = targetOrg || null;
  try {
    lastAnonymousContent = code;
    const { result, log } = await soapExecuteAnonymous(org, code);
    if (!result.compiled || !result.success) {
      return { success: false, compiled: !!result.compiled, errorMessage: formatAnonError(result), log };
    }
    return { success: true, compiled: true, log };
  } catch (e: any) {
    return { success: false, compiled: false, errorMessage: e?.message || e?.stderr || String(e) };
  }
}

// Track last executed file for Rerun capability
let lastAnonymousContent: string = "";

export async function executeAnonymous() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    // Fallback: If no editor, try to rerun last?
    if (lastAnonymousContent) {
      await runAndShowInWorkbench(lastAnonymousContent);
      return;
    }
    vscode.window.showErrorMessage("No active editor.");
    return;
  }

  const doc = editor.document;
  const text = doc.getText(editor.selection.isEmpty ? undefined : editor.selection);

  if (!text.trim()) {
    vscode.window.showInformationMessage("No code to execute.");
    return;
  }

  // Save if dirty
  if (doc.isDirty && !doc.isUntitled) {
    await doc.save();
  }

  lastAnonymousContent = text;
  await runAndShowInWorkbench(text);
}

export async function rerunLastApex() {
  if (!lastAnonymousContent) {
    vscode.window.showInformationMessage("No previous Apex execution found to rerun.");
    return;
  }
  await runAndShowInWorkbench(lastAnonymousContent);
}

export type ExecuteAnonymousResult = { success: true } | { success: false; errorMessage: string };

/** Returns list of orgs (alias/username) for the target-org dropdown. Uses background cache when warm. */
export async function getAnonymousApexOrgList(): Promise<OrgOption[]> {
  try {
    return await getOrgListForPicker();
  } catch {
    return [];
  }
}

export { warmOrgListCache, refreshOrgListCache };

/**
 * Run Apex from outside the workbench (command palette, rerun, a saved snippet) and show the
 * result on the ASFX Workbench's Execute tab — the same direct SOAP path (one request, result +
 * debug log inline) the workbench's own Execute tab uses, so this is not a separate/slower flow.
 * Never opens the debug log as a separate editor tab/file: the workbench's own "Open log" button
 * is the sole, explicit opt-in for that.
 */
async function runAndShowInWorkbench(code: string, targetOrg?: string): Promise<ExecuteAnonymousResult> {
  Telemetry.event("apexExecute", { surface: "command" });
  const result = await executeAnonymousForPanel(code, targetOrg);
  if (result.errorMessage === "Cancelled.") {
    return { success: false, errorMessage: result.errorMessage };
  }
  await ApexWorkbenchViewProvider.showExternalExecResult({
    success: result.success,
    errorMessage: result.errorMessage,
    log: result.log
  });
  return result.success ? { success: true } : { success: false, errorMessage: result.errorMessage || "Execution failed." };
}

/**
 * Execute Apex code from a saved snippet. Updates lastAnonymousContent for rerun.
 *
 * Quiet on success, loud on failure: snippets are often run repeatedly/in quick succession, so
 * popping the workbench open on every clean run would be disruptive — a toast with an "Open log"
 * button lets the user pull it up when they actually want to. A failure is the opposite: you DO
 * want to see it immediately, so that reveals the workbench right away.
 *
 * targetOrg: username (or alias) to run against; empty/undefined = default org.
 */
export async function executeAnonymousApex(
  code: string,
  options?: { targetOrg?: string }
): Promise<ExecuteAnonymousResult> {
  if (!code || !code.trim()) {
    const msg = "No code to execute.";
    vscode.window.showInformationMessage(msg);
    return { success: false, errorMessage: msg };
  }
  lastAnonymousContent = code;
  Telemetry.event("apexExecute", { surface: "command" });
  const result = await executeAnonymousForPanel(code, options?.targetOrg);
  if (result.errorMessage === "Cancelled.") {
    return { success: false, errorMessage: result.errorMessage };
  }

  if (result.success) {
    ApexWorkbenchViewProvider.pushExecResultSilently({ success: true, log: result.log });
    vscode.window.showInformationMessage("Snippet executed successfully.", "Open log").then((pick) => {
      if (pick === "Open log") void ApexWorkbenchViewProvider.reveal();
    });
    return { success: true };
  }

  await ApexWorkbenchViewProvider.showExternalExecResult({ success: false, errorMessage: result.errorMessage });
  return { success: false, errorMessage: result.errorMessage || "Execution failed." };
}
