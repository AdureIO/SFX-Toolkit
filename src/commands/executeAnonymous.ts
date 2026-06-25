import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runCommand } from "../utils/commandRunner";
import { getOrgListForPicker, refreshOrgListCache, warmOrgListCache, type OrgOption } from "../utils/orgListCache";
import { confirmProductionOrgOperation } from "../utils/orgSafety";

export type { OrgOption };
import { openLogById } from "./listLogs";
import { AuthInfo } from "../utils/authInfo";
import { getToolingApiVersion } from "../utils/constants";
import { httpsPost } from "../utils/httpUtils";

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
    if (/INVALID_SESSION_ID|HTTP 401|HTTP 500/i.test(String(e?.message ?? e))) {
      AuthInfo.invalidateOrg(org);
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

// Cache userId for the session to avoid repeated "sf org display user" calls
let cachedUserId: string | null = null;

export async function executeAnonymous() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    // Fallback: If no editor, try to rerun last?
    if (lastAnonymousContent) {
      await executeContent(lastAnonymousContent);
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
  if (!(await confirmProductionOrgOperation("execute anonymous Apex against"))) {
    return;
  }
  await executeContent(text);
}

export async function rerunLastApex() {
  if (!lastAnonymousContent) {
    vscode.window.showInformationMessage("No previous Apex execution found to rerun.");
    return;
  }
  if (!(await confirmProductionOrgOperation("execute anonymous Apex against"))) {
    return;
  }
  await executeContent(lastAnonymousContent);
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

/** Execute Apex code (e.g. from the Execute Apex panel). Updates lastAnonymousContent for rerun.
 * When fromPanel is true, errors are returned instead of opening the output channel.
 * targetOrg: username (or alias) to run against; empty/undefined = default org. */
export async function executeAnonymousApex(
  code: string,
  options?: { fromPanel?: boolean; targetOrg?: string }
): Promise<ExecuteAnonymousResult> {
  if (!code || !code.trim()) {
    const msg = "No code to execute.";
    if (options?.fromPanel) return { success: false, errorMessage: msg };
    vscode.window.showInformationMessage(msg);
    return { success: false, errorMessage: msg };
  }
  lastAnonymousContent = code;
  if (!(await confirmProductionOrgOperation("execute anonymous Apex against", options?.targetOrg))) {
    const msg = "Execution cancelled.";
    if (!options?.fromPanel) {
      vscode.window.showInformationMessage(msg);
    }
    return { success: false, errorMessage: msg };
  }
  try {
    await executeContent(code, options?.fromPanel === true, options?.targetOrg);
    return { success: true };
  } catch (e: any) {
    let message = e?.message || e?.stderr || String(e);
    if (options?.fromPanel) {
      try {
        const j = JSON.parse(message);
        const r = j.result ?? j;
        if (r.compileProblem) message = r.line && r.line > 0 ? `Line ${r.line}: ${r.compileProblem}` : r.compileProblem;
        else if (r.exceptionMessage) message = r.exceptionStackTrace ? `${r.exceptionMessage}\n${r.exceptionStackTrace}` : r.exceptionMessage;
      } catch {
        // use original message
      }
      return { success: false, errorMessage: message };
    }
    throw e;
  }
}

async function executeContent(text: string, _fromPanel?: boolean, targetOrg?: string) {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `anon-${Date.now()}.apex`);
  fs.writeFileSync(tmpFile, text);

  const orgFlag = targetOrg ? ` -o ${targetOrg}` : "";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: targetOrg ? `Executing Anonymous Apex (${targetOrg})...` : "Executing Anonymous Apex...",
      cancellable: true
    },
    async (_progress, token) => {
      try {
        // The Execute Apex panel uses executeAnonymousForPanel (SOAP, inline log).
        // This command path (palette / snippets) keeps the CLI-based flow that
        // also opens the resulting debug log in an editor.
        let userId: string;
        if (targetOrg) {
          try {
            const userRes = await runCommand(`sf org display user --json${orgFlag}`, undefined, undefined, true, token);
            const userJson = JSON.parse(userRes);
            userId = userJson.status === 0 && userJson.result?.id ? userJson.result.id : "";
          } catch {
            userId = "";
          }
        } else {
          const [auth, userRes] = await Promise.all([
            AuthInfo.getAuthInfo(),
            cachedUserId !== null
              ? Promise.resolve(JSON.stringify({ status: 0, result: { id: cachedUserId } }))
              : runCommand("sf org display user --json", undefined, undefined, true, token).catch(() => '{"status":1}')
          ]);
          if (auth) {
            /* warm cache for openLogById REST */
          }
          try {
            const userJson = JSON.parse(userRes);
            if (userJson.status === 0 && userJson.result?.id) {
              userId = userJson.result.id;
              cachedUserId = userId;
            } else {
              userId = "";
            }
          } catch {
            userId = "";
          }
        }

        let oldHeadLogId: string | null = null;
        const query =
          "SELECT Id FROM ApexLog" +
          (userId ? ` WHERE LogUserId = '${userId}'` : "") +
          " ORDER BY StartTime DESC LIMIT 1";

        try {
          const prevRes = await runCommand(
            `sf data query -q "${query}" -t --json${orgFlag}`,
            undefined,
            undefined,
            true,
            token
          );
          const prevJson = JSON.parse(prevRes);
          if (prevJson.status === 0 && prevJson.result.records?.length > 0) {
            oldHeadLogId = prevJson.result.records[0].Id;
          }
        } catch (e: any) {
          if (e.cancelled) return;
        }

        const res = await runCommand(`sf apex run -f "${tmpFile}"${orgFlag}`, undefined, undefined, true, token);

        let logId: string | null = null;
        const maxAttempts = 3;
        const delayMs = 400;
        for (let attempt = 0; attempt < maxAttempts && !token.isCancellationRequested; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));
          const logRes = await runCommand(
            `sf data query -q "${query}" -t --json${orgFlag}`,
            undefined,
            undefined,
            true,
            token
          );
          const logJson = JSON.parse(logRes);
          if (logJson.status === 0 && logJson.result.records?.length > 0) {
            const id = logJson.result.records[0].Id;
            if (id !== oldHeadLogId) {
              logId = id;
              break;
            }
          }
        }

        if (logId) {
          // Strategy:
          // A) If we are in the Primary Source Editor (ViewColumn 1 usually), split DOWN.
          // B) If we are already in a Log View (ViewColumn 2/Bottom), just replace it.

          let targetColumn = vscode.ViewColumn.Beside; // Fallback

          if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn === vscode.ViewColumn.One) {
            // We are in main editor.
            // Check if there is already a 'Bottom' group (e.g. ViewColumn 2 implies split)
            // Hard to check accurately without complicated API.
            // Simple approach: Run 'workbench.action.splitEditorDown'.
            // But we don't want to duplicate the source file.

            // Better: "openLogById" with a specific column?
            // VS Code API 'vscode.window.showTextDocument' takes a column.
            // Column 'Beside' splits horizontally (Side by Side) by default settings,
            // but user asked for "Bottom".
            // Resetting user layout preference is intrusive.
            // However, we can use `workbench.action.moveEditorToBelowGroup` immediately after opening?

            // Let's try:
            // 1. Open Log 'Beside' (Standard split).
            // 2. Then move it 'Down'??

            // Actually, just calling 'workbench.action.splitEditorDown' explicitly CREATES the bottom group active with current file.
            // Then we open log in Active (which is bottom).
            await vscode.commands.executeCommand("workbench.action.splitEditorDown");
            targetColumn = vscode.ViewColumn.Active;
          } else {
            // We are likely already in the split or re-running.
            // Just stay here.
            targetColumn = vscode.ViewColumn.Active;
          }

          await openLogById(logId, targetColumn, "sf-anon-log", true, targetOrg);
          vscode.window.showInformationMessage("Anonymous Apex executed successfully.");
        } else {
          const msg =
            "Code executed successfully, but NO NEW debug log was generated. Please check if a Trace Flag is active for your user.";
          if (!_fromPanel) {
            vscode.window.showWarningMessage(msg);
            const channel = vscode.window.createOutputChannel("Salesforce Apex Execution");
            channel.clear();
            channel.append(res);
            channel.show();
          } else {
            throw new Error(msg);
          }
        }
      } catch (e: any) {
        if (e.cancelled) return;
        if (_fromPanel) throw e;
        const details = e?.stderr || e?.message || String(e);
        vscode.window.showErrorMessage(
          'Anonymous Apex execution failed. See "Salesforce Apex Execution" output for details.'
        );
        const channel = vscode.window.createOutputChannel("Salesforce Apex Execution");
        channel.clear();
        channel.appendLine("Error executing Anonymous Apex:");
        channel.appendLine(details);
        channel.show();
      } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      }
    }
  );
}
