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
import { getSalesforceLogDirectory } from "../utils/logPaths";

// ─── Fast REST execution (no CLI spawn) ─────────────────────────────────────────

interface AnonResult {
  compiled?: boolean;
  success?: boolean;
  compileProblem?: string | null;
  exceptionMessage?: string | null;
  exceptionStackTrace?: string | null;
  line?: number;
  column?: number;
}

/** Run anonymous Apex via the Tooling REST API (single authenticated request). */
async function restExecuteAnonymous(org: string | null, code: string): Promise<AnonResult> {
  const version = getToolingApiVersion();
  const { body } = await AuthInfo.get(org, (a) =>
    `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/tooling/executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`
  );
  return JSON.parse(body) as AnonResult;
}

/** Current user's Id via the OAuth userinfo endpoint (cached for the default org). */
async function restUserId(org: string | null): Promise<string> {
  if (org === null && cachedUserId !== null) return cachedUserId;
  try {
    const { body } = await AuthInfo.get(org, (a) => `${a.instanceUrl.replace(/\/$/, "")}/services/oauth2/userinfo`);
    const id = (JSON.parse(body).user_id as string) || "";
    if (org === null && id) cachedUserId = id;
    return id;
  } catch {
    return "";
  }
}

/** Most recent ApexLog Id for the user (REST query); null if none or equal to `exclude`. */
async function restLatestLogId(org: string | null, userId: string, exclude: string | null): Promise<string | null> {
  const version = getToolingApiVersion();
  const q =
    "SELECT Id FROM ApexLog" +
    (userId ? ` WHERE LogUserId = '${userId}'` : "") +
    " ORDER BY StartTime DESC LIMIT 1";
  try {
    const { body } = await AuthInfo.get(org, (a) =>
      `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/query/?q=${encodeURIComponent(q)}`
    );
    const id = (JSON.parse(body).records?.[0]?.Id as string) ?? null;
    return id && id !== exclude ? id : null;
  } catch {
    return null;
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

async function executeContent(text: string, fromPanel?: boolean, targetOrg?: string) {
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
        // Execute Apex panel: run via the Tooling REST API (no CLI spawn — orders
        // of magnitude faster than `sf apex run`), then best-effort fetch the new
        // debug log over REST and open it.
        if (fromPanel) {
          const org = targetOrg || null;
          const userId = await restUserId(org);
          const headBefore = await restLatestLogId(org, userId, null);

          const runResult = await restExecuteAnonymous(org, text);
          if (token.isCancellationRequested) return;

          if (!runResult.compiled || !runResult.success) {
            // Preserve a structured payload so the caller extracts a clean message.
            throw new Error(JSON.stringify({ result: runResult }));
          }

          // Poll briefly for the log this run produced (only if trace logging is on).
          let logId: string | null = null;
          for (let attempt = 0; attempt < 3 && !token.isCancellationRequested; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
            logId = await restLatestLogId(org, userId, headBefore);
            if (logId) break;
          }

          if (logId) {
            const logDir = getSalesforceLogDirectory();
            if (logDir) {
              if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
              // Save original script + result alongside (matches the SF "log exec" layout).
              fs.writeFileSync(path.join(logDir, `${logId}.apex`), text, "utf8");
              fs.writeFileSync(path.join(logDir, `${logId}-result.json`), JSON.stringify(runResult, null, 2), "utf8");
            }
            // openLogById fetches the body via REST (default org) and opens it.
            await openLogById(logId, vscode.ViewColumn.Beside, "sf-anon-log", true, targetOrg);
            vscode.window.showInformationMessage("Anonymous Apex executed successfully.");
          } else {
            vscode.window.showInformationMessage("Anonymous Apex executed successfully, but no debug log was found.");
          }
          return;
        }

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
          if (!fromPanel) {
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
        if (fromPanel) throw e;
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
