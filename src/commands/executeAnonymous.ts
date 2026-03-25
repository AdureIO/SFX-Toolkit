import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runCommand } from "../utils/commandRunner";
import { openLogById } from "./listLogs";
import { AuthInfo } from "../utils/authInfo";
import { getSalesforceLogDirectory } from "../utils/logPaths";

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
  await executeContent(text);
}

export async function rerunLastApex() {
  if (!lastAnonymousContent) {
    vscode.window.showInformationMessage("No previous Apex execution found to rerun.");
    return;
  }
  await executeContent(lastAnonymousContent);
}

export type ExecuteAnonymousResult = { success: true } | { success: false; errorMessage: string };

/** Org option for the Execute Apex panel dropdown. */
export type OrgOption = { label: string; username: string };

/** Returns list of orgs (alias/username) for the target-org dropdown. Default org first. */
export async function getAnonymousApexOrgList(): Promise<OrgOption[]> {
  try {
    const result = await runCommand("sf org list --json", undefined, undefined, true);
    const parsed = JSON.parse(result);
    if (parsed.status !== 0 || !parsed.result) return [];
    const { nonScratchOrgs = [], scratchOrgs = [] } = parsed.result;
    const all: { alias?: string; username: string; isDefaultUsername?: boolean }[] = [
      ...(nonScratchOrgs as any[]),
      ...(scratchOrgs as any[])
    ];
    const defaultUsername = all.find((o: any) => o.isDefaultUsername)?.username;
    const options: OrgOption[] = all
      .filter((o: any) => o.username)
      .map((o: any) => ({
        label: (o.alias || o.username) + (o.username === defaultUsername ? " (default)" : ""),
        username: o.username
      }));
    options.sort((a, b) => (b.username === defaultUsername ? 1 : 0) - (a.username === defaultUsername ? 1 : 0));
    return options;
  } catch {
    return [];
  }
}

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
  try {
    await executeContent(code, options?.fromPanel === true, options?.targetOrg);
    return { success: true };
  } catch (e: any) {
    let message = e?.message || e?.stderr || String(e);
    if (options?.fromPanel) {
      try {
        const j = JSON.parse(message);
        if (j.compileProblem) message = j.compileProblem;
        else if (j.exceptionMessage) message = j.exceptionMessage;
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
        // Execute Apex panel: run with --json, then same as Salesforce extension: download log to
        // .sfdx/tools/debug/logs and save original script + JSON result alongside; open the log.
        if (fromPanel) {
          const runOut = await runCommand(
            `sf apex run -f "${tmpFile}" --json${orgFlag}`,
            undefined,
            undefined,
            true,
            token
          );

          /**
           * NOTE: `sf apex run --json` wraps the actual result under `result`.
           * We normalize that here so `compiled`/`success` checks work reliably.
           */
          let raw: any;
          try {
            raw = JSON.parse(runOut);
          } catch {
            raw = {};
          }
          const runResult: {
            compiled?: boolean;
            success?: boolean;
            logs?: string;
            compileProblem?: string;
            exceptionMessage?: string;
          } = raw && typeof raw === "object" && raw.result && typeof raw.result === "object" ? raw.result : raw || {};

          if (!runResult.compiled || !runResult.success) {
            // Preserve full structured payload so the caller can extract a clean error message.
            const errorPayload = {
              ...(typeof raw === "object" ? raw : {}),
              result: {
                ...(typeof runResult === "object" ? runResult : {})
              }
            };
            throw new Error(JSON.stringify(errorPayload));
          }

          let userId: string;
          if (targetOrg) {
            try {
              const userRes = await runCommand(
                `sf org display user --json${orgFlag}`,
                undefined,
                undefined,
                true,
                token
              );
              const userJson = JSON.parse(userRes);
              userId = userJson.status === 0 && userJson.result?.id ? userJson.result.id : "";
            } catch {
              userId = "";
            }
          } else {
            if (cachedUserId !== null) {
              userId = cachedUserId;
            } else {
              try {
                const userRes = await runCommand("sf org display user --json", undefined, undefined, true, token);
                const userJson = JSON.parse(userRes);
                userId = userJson.status === 0 && userJson.result?.id ? userJson.result.id : "";
                if (userId) cachedUserId = userId;
              } catch {
                userId = "";
              }
            }
          }
          const query =
            "SELECT Id FROM ApexLog" +
            (userId ? ` WHERE LogUserId = '${userId}'` : "") +
            " ORDER BY StartTime DESC LIMIT 1";
          await new Promise((r) => setTimeout(r, 350));
          let logId: string | null = null;
          try {
            const logRes = await runCommand(
              `sf data query -q "${query}" -t --json${orgFlag}`,
              undefined,
              undefined,
              true,
              token
            );
            const logJson = JSON.parse(logRes);
            if (logJson.status === 0 && logJson.result.records?.length > 0) {
              logId = logJson.result.records[0].Id;
            }
          } catch {
            // no log id; we still succeeded
          }

          if (logId) {
            const logDir = getSalesforceLogDirectory();
            if (logDir) {
              if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
              }
              // Reuse Salesforce extension behavior: download log to logs directory
              await runCommand(
                `sf apex get log -i ${logId} -d "${logDir}"${orgFlag}`,
                undefined,
                undefined,
                true,
                token
              );
              // Save original script and JSON result alongside (like Salesforce extension "log exec")
              const scriptPath = path.join(logDir, `${logId}.apex`);
              const resultPath = path.join(logDir, `${logId}-result.json`);
              fs.writeFileSync(scriptPath, text, "utf8");
              fs.writeFileSync(resultPath, JSON.stringify(runResult, null, 2), "utf8");
            }
            const targetColumn = vscode.ViewColumn.Beside;
            await openLogById(logId, targetColumn, "sf-anon-log", true, targetOrg);
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
