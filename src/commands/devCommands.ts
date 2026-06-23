import * as vscode from "vscode";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import * as fs from "fs";
import * as path from "path";
import { Logger, outputChannel } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { getAutoSaveBeforePush, getTestRunTimeout } from "../utils/constants";
import { DEPLOY_TIMEOUT_MS } from "./deployMetadata";
import { getDefaultOrg, getDefaultOrgSync } from "../utils/defaultOrg";
import { confirmProductionOrgOperation } from "../utils/orgSafety";

// Helper to strip ANSI and progress lines
export function cleanDeployOutput(output: string): string {
  const cleanData = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

  // Find where the final status block starts
  // It usually starts with "Status: Succeeded" or "Status: Failed"
  const statusMatch = cleanData.match(/Status: (Succeeded|Failed|SucceededPartial)/);

  if (statusMatch && statusMatch.index !== undefined) {
    // Find the start of the line where Status appears to include indentation
    const lineStart = cleanData.lastIndexOf("\n", statusMatch.index);
    const startIndex = lineStart !== -1 ? lineStart + 1 : statusMatch.index;

    // If failed, we might want to capture context before the status if it contains "Component Failures"
    // But usually "Component Failures" comes AFTER the status line in CLI output.
    // Let's check the user provided example:
    // Status: Failed ... Elapsed Time ... Component Failures [...] Table...
    // So capturing from Status onwards is correct for the standard table.

    return cleanData.substring(startIndex).trim();
  }

  // Fallback if no standard status line found (e.g. strict failure or different format)
  // We want to keep everything except progress updates.
  const lines = cleanData.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const l = line.trim();
    // Filter header and intro
    if (l.includes("Deploying Metadata") && l.includes("──")) return false;
    if (l.includes("Deploying v") && l.includes("metadata to")) return false;

    // Filter progress lines starting with symbols or specific keywords
    if (/[✔◯▸]/.test(l)) return false;

    if (l.startsWith("Preparing")) return false;
    if (l.startsWith("Waiting for the org to respond")) return false;
    if (l.startsWith("Running Tests")) return false;
    if (l.startsWith("Updating Source Tracking")) return false;
    if (l.startsWith("Components:")) return false;
    if (l.startsWith("Members:")) return false;

    if (l === "Done" || l.startsWith("Done ")) return false;

    // For failures without a "Status:" line, we typically want to see everything else (e.g. Warnings, Errors).
    // But user asked to skip output before status "just like with completed".
    // If there is NO status line, we can't skip "before" it easily without losing the error.
    // However, the user might be referring to cases where "Component Failures" exists but regex missed Status?
    // Or maybe they mean "Component Failures" block should be the start if Status is missing?

    return true;
  });

  // If we have "Component Failures", try to start from there if we didn't find "Status:"
  const result = filtered.join("\n").trim();
  const failuresMatch = result.match(/Component Failures \[\d+\]/);
  if (failuresMatch && failuresMatch.index !== undefined) {
    return result.substring(failuresMatch.index).trim();
  }

  return result;
}

/** Parse component/test counts from deploy CLI output (text mode, ANSI-stripped). */
export function parseDeployStats(output: string): {
  components: number;
  componentErrors: number;
  testsPassed: number;
  testsFailed: number;
} {
  const clean = output.replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, "");
  let components = 0, componentErrors = 0, testsPassed = 0, testsFailed = 0;

  // Progress line: "| 45/60 Components"
  const compProg = clean.match(/\|\s*(\d+)\/\d+\s*Components/);
  if (compProg) {
    components = parseInt(compProg[1], 10);
  } else {
    const compStatus = clean.match(/Components:\s*(\d+)/);
    if (compStatus) components = parseInt(compStatus[1], 10);
  }

  // "Component Failures [N]" or "Component Errors: N"
  const errMatch = clean.match(/Component Failures\s*\[(\d+)\]/) ?? clean.match(/Component Errors:\s*(\d+)/);
  if (errMatch) componentErrors = parseInt(errMatch[1], 10);

  // "N Passed  M Failed" (SF CLI test summary line)
  const testLine = clean.match(/(\d+)\s+Passed[^\n]*?(\d+)\s+Failed/);
  if (testLine) {
    testsPassed = parseInt(testLine[1], 10);
    testsFailed = parseInt(testLine[2], 10);
  } else {
    // Alternate: "Passing: N / Failing: M"
    const passing = clean.match(/Passing:\s*(\d+)/);
    const failing = clean.match(/Failing:\s*(\d+)/);
    if (passing) testsPassed = parseInt(passing[1], 10);
    if (failing) testsFailed = parseInt(failing[1], 10);
  }

  return { components, componentErrors, testsPassed, testsFailed };
}

/** Single coverage row returned by parseCoverageData. */
export interface CoverageEntry {
  name: string;
  covered: number;
  total: number;
  pct: number;
}

/** Parse Apex code-coverage table from deploy CLI text output (multiple format variants). */
export function parseCoverageData(output: string): CoverageEntry[] {
  const clean = output.replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
  const entries: CoverageEntry[] = [];
  const lines = clean.split(/\r?\n/);
  let inSection = false;
  let headerSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    // Detect coverage section
    if (/apex.{0,30}coverage|coverage.{0,30}class/i.test(line)) {
      inSection = true;
      headerSeen = false;
      continue;
    }
    // Exit section on blank line (once we have at least one entry)
    if (inSection && !line && entries.length > 0) { inSection = false; continue; }
    if (!inSection) continue;
    // Skip separator / column header lines
    if (/^[─═\-=▸]+$/.test(line) || /^NAME\s+/i.test(line) || /^CLASSES\s+/i.test(line)) {
      headerSeen = true;
      continue;
    }
    if (!headerSeen) continue;
    // Pattern A: "ClassName  87%  [uncovered lines]"
    const patA = line.match(/^(\S+)\s+(\d+)%/);
    if (patA) { entries.push({ name: patA[1], covered: 0, total: 0, pct: parseInt(patA[2], 10) }); continue; }
    // Pattern B: "ClassName  39  45  86.67%"
    const patB = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+([\d.]+)%/);
    if (patB) {
      entries.push({ name: patB[1], covered: parseInt(patB[2], 10), total: parseInt(patB[3], 10), pct: Math.round(parseFloat(patB[4])) });
      continue;
    }
  }
  return entries;
}

// Helper to extract deployed component count from output
function getDeployedCount(output: string): number {
  const clean = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

  // Strategy 1: Look for "Status: ... | N/M Components"
  const statusMatch = clean.match(/\|\s*(\d+)\/\d+\s*Components/);
  if (statusMatch) {
    return parseInt(statusMatch[1], 10);
  }

  // Strategy 2: Count lines in "Deployed Source" table
  const lines = output.split(/\r?\n/);
  let inTable = false;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes("Deployed Source") && !line.startsWith("Not")) {
      inTable = true;
      i += 2; // Skip headers (Table header and separator)
      continue;
    }
    if (inTable) {
      if (!line || line.startsWith("Not Deployed Source") || line.startsWith("Retrieved Source")) {
        break;
      }
      // Check if it's a table row (starts with box chars or has content)
      // Simple check: if it has │ separator
      if (line.includes("│")) {
        count++;
      }
    }
  }

  return count;
}

// Helper to reuse push logic
async function pushSourceHelper(force: boolean) {
  const title = force ? "Force Push" : "Push";
  const defaultOrg = getDefaultOrgSync() ?? (await getDefaultOrg());
  const titleWithOrg = defaultOrg ? `${title} to ${defaultOrg.displayName}` : title;

  if (getAutoSaveBeforePush()) {
    await vscode.workspace.saveAll(false);
  } else {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      await activeEditor.document.save();
    }
  }

  // We want to stream output to the log so user sees progress.
  outputChannel.clear();
  // outputChannel.show(); // Only show on error or explicit request
  Logger.info(`Starting Push Operation: ${titleWithOrg}`);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  statusBar.command = "adure-sfx-toolkit.showOutput";
  statusBar.text = defaultOrg ? `$(sync~spin) Deploying to ${defaultOrg.displayName}...` : "$(sync~spin) Deploying...";
  statusBar.tooltip = "Click to Show Deployment Logs";
  statusBar.show();

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: titleWithOrg,
        cancellable: true
      },
      async (progress, token) => {
        try {
          if (!(await confirmProductionOrgOperation("push source to"))) {
            return;
          }
          // 1. Detect sfdx-project.json
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (!workspaceFolders) {
            // Fallback
            const flag = force ? "--ignore-conflicts" : "";
            Logger.info(`Running: sf project deploy start ${flag}`);
            const result = await runCommand(`sf project deploy start ${flag}`, undefined, undefined, true, token);
            Logger.info(result);
            vscode.window.showInformationMessage("Source pushed successfully (No workspace).");
            return;
          }

          const rootPath = workspaceFolders[0].uri.fsPath;
          const projectJsonPath = path.join(rootPath, "sfdx-project.json");

          let packageDirs: string[] = [];

          if (fs.existsSync(projectJsonPath)) {
            try {
              const content = fs.readFileSync(projectJsonPath, "utf8");
              const projectConfig = JSON.parse(content);
              if (projectConfig.packageDirectories && Array.isArray(projectConfig.packageDirectories)) {
                packageDirs = projectConfig.packageDirectories.map((pkg: any) => pkg.path);
              }
            } catch (jsonErr) {
              Logger.error("Error parsing sfdx-project.json", jsonErr);
            }
          }

          // State for status updates
          let lastPrefix = "";
          let currentPhase = "";
          let currentDetails = "";

          // Common callback to stream output to log and update progress
          const handleOutput = (data: string, prefix?: string) => {
            // Reset state if prefix changes (new package)
            if (prefix && prefix !== lastPrefix) {
              lastPrefix = prefix;
              currentPhase = "";
              currentDetails = "";
            }

            // Strip ANSI codes but keep non-ASCII (spinners, checkmarks)
            // We need to see spinners to know what's active.
            const cleanData = data.replace(
              /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
              ""
            );

            const lines = cleanData.split(/[\r\n]+/);

            // 1. Determine Status Message for Notification
            for (const line of lines) {
              const l = line.trim();
              if (!l) continue;

              // Check for spinner/activity indicators
              // \u2800-\u28FF are Braille patterns often used for spinners
              // \u2026 is ellipsis ...
              // \u22EE is vertical ellipsis
              const isSpinner = /[\u2800-\u28FF\u2026\u22EE]/.test(l);
              const isCheckmark = /[✓\u2713\u2714]/.test(l);
              const isSquare = /[▪■]/.test(l); // Often used for pending steps

              // If line has a spinner, it is the active phase!
              if (isSpinner) {
                // Extract the text part of the line (remove spinner) to preserve time info if present
                const cleanLine = l.replace(/^[^\w\s]+/, "").trim();

                if (l.includes("Deploying Metadata")) {
                  currentPhase = cleanLine;
                } else if (l.includes("Running Tests")) {
                  currentPhase = cleanLine;
                  currentDetails = "";
                } else if (l.includes("Preparing")) {
                  currentPhase = cleanLine;
                } else if (l.includes("Waiting for the org to respond")) {
                  currentPhase = cleanLine;
                }
              }
              // If line has a checkmark, it is done. Don't set as current phase if we have a spinner.
              else if (isCheckmark) {
                // Do nothing, or maybe set as "Last Completed: ..." if we wanted more detail.
              }
              // If line has a square, it is likely pending.
              else if (isSquare) {
                // Do nothing, wait for it to spin.
              }
              // Fallback logic for lines without clear indicators or standard status lines
              else {
                if (l.includes("Components:")) {
                  currentDetails = l.replace(/^[^\w\s]+/, "").trim();
                } else if (l.startsWith("Status:")) {
                  if (!l.includes("In Progress") && !l.includes("Pending")) {
                    const s = l.replace("Status:", "").trim();
                    if (s.length > 0) {
                      // Prevent "Running Tests" from being overwritten by stale status lines
                      if (currentPhase === "Running Tests" && !l.includes("Running Tests")) {
                        // Ignore status updates if we are already in Running Tests phase,
                        // unless the new status is "Done" or "Failed"
                        if (s === "Done" || s === "Failed" || s === "Succeeded") {
                          currentPhase = `Status: ${s}`;
                        }
                      } else {
                        currentPhase = `Status: ${s}`;
                      }
                    }
                  }
                }
              }
            }

            const statusMsg = [currentPhase, currentDetails].filter(Boolean).join(" | ");
            if (statusMsg) {
              const msg = prefix ? `${prefix}: ${statusMsg}` : statusMsg;
              progress.report({ message: msg });
              statusBar.text = `$(sync~spin) ${msg}`;
            }
          };

          // Check if source tracking is active locally
          // Logic: Get Org ID and check if .sf/orgs/<OrgID> exists
          let hasSourceTracking = false;

          try {
            const authInfo = await AuthInfo.getAuthInfo();
            if (authInfo && authInfo.orgId) {
              const sfOrgPath = path.join(rootPath, ".sf", "orgs", authInfo.orgId);
              if (fs.existsSync(sfOrgPath)) {
                hasSourceTracking = true;
              }
            }
          } catch (e) {
            Logger.warn("Failed to check source tracking status. Assuming no tracking.");
          }

          if (hasSourceTracking) {
            // Use Source Tracking (Deploy changes only)
            progress.report({ message: "Deploying project (Source Tracking)..." });
            const flag = force ? "--ignore-conflicts" : "";
            Logger.info(`Running: sf project deploy start ${flag}`);

            const result = await runCommand(
              `sf project deploy start ${flag}`,
              undefined,
              (data) => handleOutput(data),
              false,
              token,
              DEPLOY_TIMEOUT_MS
            );
            Logger.info(cleanDeployOutput(result));

            const count = getDeployedCount(result);
            vscode.window.showInformationMessage(
              count > 0 ? `Deployed ${count} components.` : "Source pushed successfully."
            );
          } else {
            // No Source Tracking -> Full Sequential Deploy
            if (packageDirs.length > 0) {
              progress.report({ message: `Found ${packageDirs.length} package directories.` });

              let totalCount = 0;

              for (const pkgDir of packageDirs) {
                const fullPkgPath = path.join(rootPath, pkgDir);
                if (!fs.existsSync(fullPkgPath)) continue;

                progress.report({ message: `Starting ${pkgDir}...` });
                const flag = force ? "--ignore-conflicts" : "";
                Logger.info(`Deploying Package: ${pkgDir}`);

                const result = await runCommand(
                  `sf project deploy start -d ${escapeShellArg(fullPkgPath)} ${flag}`,
                  undefined,
                  (data) => handleOutput(data, pkgDir),
                  false,
                  token,
                  DEPLOY_TIMEOUT_MS
                );
                Logger.info(cleanDeployOutput(result));
                totalCount += getDeployedCount(result);
              }
              OrgMetadataCache.invalidate(null);
              OrgMetadataCache.warmDefaultOrg();
              vscode.window.showInformationMessage(
                totalCount > 0
                  ? `Successfully pushed source for ${packageDirs.length} packages. Deployed ${totalCount} components.`
                  : `Successfully pushed source for ${packageDirs.length} packages.`
              );
            } else {
              // Fallback if no packages found
              progress.report({ message: "Deploying project..." });
              const flag = force ? "--ignore-conflicts" : "";
              Logger.info(`Running: sf project deploy start ${flag}`);

              const result = await runCommand(
                `sf project deploy start ${flag}`,
                undefined,
                (data) => handleOutput(data),
                true,
                token,
                DEPLOY_TIMEOUT_MS
              );
              Logger.info(cleanDeployOutput(result));

              const count = getDeployedCount(result);
              OrgMetadataCache.invalidate(null);
              OrgMetadataCache.warmDefaultOrg();
              vscode.window.showInformationMessage(
                count > 0 ? `Source pushed successfully. Deployed ${count} components.` : "Source pushed successfully."
              );
            }
          }
        } catch (e: any) {
          if (e.cancelled) {
            Logger.info("Push cancelled by user.");
            return;
          }
          // e.message contains combined stdout/stderr from commandRunner
          const raw = e.message || e.stderr || "Unknown Error";
          const cleanError = cleanDeployOutput(raw);

          // First log the high-level failure.
          Logger.error("Push failed:", cleanError);

          // Also log a structured summary so it mirrors the deploy panel behavior.
          Logger.info(`Deploy result (from CLI output):\n${cleanError}`);

          outputChannel.show(); // Auto-open log on error

          vscode.window.showErrorMessage(`Push failed. Check output log for details.`, "View Log").then((selection) => {
            if (selection === "View Log") {
              outputChannel.show();
            }
          });
        }
      }
    );
  } finally {
    statusBar.dispose();
  }
}

export async function pushSource() {
  await pushSourceHelper(false);
}

export async function pushSourceForce() {
  await pushSourceHelper(true);
}

export async function pullSource() {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Pulling Source from Default Org...",
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const result = await runCommand("sf project retrieve start", undefined, undefined, true, token);
        Logger.info("Pull completed successfully.");
        Logger.info(cleanDeployOutput(result));
        OrgMetadataCache.invalidate(null);
        OrgMetadataCache.warmDefaultOrg();
        vscode.window.showInformationMessage("Source pulled successfully.");
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Pull cancelled by user.");
          return;
        }
        const msg = e?.message || e?.stderr || String(e);
        Logger.error("Pull failed", msg);
        outputChannel.show();
        vscode.window
          .showErrorMessage('Pull failed. Check "Adure SFX Toolkit" output for details.', "View Log")
          .then((selection) => {
            if (selection === "View Log") {
              outputChannel.show();
            }
          });
      }
    }
  );
}

export async function deployCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor.");
    return;
  }

  await editor.document.save(); // Save the current file before deploying

  const filePath = editor.document.uri.fsPath;
  const defaultOrg = getDefaultOrgSync() ?? (await getDefaultOrg());
  const deployTitle = defaultOrg ? `Deploy file to ${defaultOrg.displayName}` : "Deploying current file...";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: deployTitle,
      cancellable: true
    },
    async (_progress, token) => {
      try {
        if (!(await confirmProductionOrgOperation("deploy metadata to"))) {
          return;
        }
        const result = await runCommand(
          `sf project deploy start -d ${escapeShellArg(filePath)}`,
          undefined,
          undefined,
          true,
          token
        );
        const count = getDeployedCount(result);
        Logger.info(
          count > 0
            ? `File deploy succeeded for ${filePath}. Deployed ${count} components.`
            : `File deploy succeeded for ${filePath}.`
        );
        Logger.info(cleanDeployOutput(result));
        vscode.window.showInformationMessage(
          count > 0 ? `File deployed successfully. Deployed ${count} components.` : "File deployed successfully."
        );
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Deploy cancelled by user.");
          return;
        }
        const msg = e?.message || e?.stderr || String(e);
        Logger.error("Deploy current file failed", msg);
        outputChannel.show();
        vscode.window
          .showErrorMessage('Deploy failed. Check "Adure SFX Toolkit" output for details.', "View Log")
          .then((selection) => {
            if (selection === "View Log") {
              outputChannel.show();
            }
          });
      }
    }
  );
}

export async function retrieveCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor.");
    return;
  }

  const filePath = editor.document.uri.fsPath;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Retrieving current file...",
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const result = await runCommand(
          `sf project retrieve start -d ${escapeShellArg(filePath)}`,
          undefined,
          undefined,
          true,
          token
        );
        Logger.info(`Retrieve current file succeeded for ${filePath}.`);
        Logger.info(cleanDeployOutput(result));
        OrgMetadataCache.invalidate(null);
        OrgMetadataCache.warmDefaultOrg();
        vscode.window.showInformationMessage("File retrieved successfully.");
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Retrieve cancelled by user.");
          return;
        }
        const msg = e?.message || e?.stderr || String(e);
        Logger.error("Retrieve current file failed", msg);
        outputChannel.show();
        vscode.window
          .showErrorMessage('Retrieve failed. Check "Adure SFX Toolkit" output for details.', "View Log")
          .then((selection) => {
            if (selection === "View Log") {
              outputChannel.show();
            }
          });
      }
    }
  );
}

export async function runLocalTests() {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Running Local Tests...",
      cancellable: true
    },
    async (progress, token) => {
      try {
        // -w 10 (wait 10 mins), -l RunLocalTests, -r human
        const result = await runCommand(
          `sf apex run test -l RunLocalTests -w ${getTestRunTimeout()} -r human`,
          undefined,
          undefined,
          true,
          token
        );

        const channel = vscode.window.createOutputChannel("Salesforce Test Results");
        channel.clear();
        channel.append(result);
        channel.show();

        if (result.includes("Pass") && !result.includes("Fail")) {
          vscode.window.showInformationMessage("Tests Passed.");
        } else {
          vscode.window.showWarningMessage("Some tests failed. Check output.");
        }
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Run Local Tests cancelled by user.");
          return;
        }
        vscode.window.showErrorMessage(`Tests execution failed.`);
        const channel = vscode.window.createOutputChannel("Salesforce Test Results");
        channel.append(e.stderr || e.message);
        channel.show();
      }
    }
  );
}

export async function resetSourceTracking() {
  // Usually target org is the default one, but let's confirm or assume default.
  // User requested: sf project reset tracking --target-org my-scratch
  // We will use the default target org unless we add UI to select.
  // For now, let's assume default to keep it simple as per other commands.

  const confirm = await vscode.window.showWarningMessage(
    "Are you sure you want to reset source tracking for the default org? This cannot be undone.",
    "Yes",
    "No"
  );

  if (confirm !== "Yes") return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Resetting Source Tracking...",
      cancellable: true
    },
    async (_progress, token) => {
      try {
        const result = await runCommand("sf project reset tracking --no-prompt", undefined, undefined, true, token);
        Logger.info(result);
        vscode.window.showInformationMessage("Source tracking reset successfully.");
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Reset tracking cancelled by user.");
          return;
        }
        const msg = e.stderr || e.message;
        Logger.error("Reset tracking failed:", msg);
        vscode.window.showErrorMessage(`Reset tracking failed: ${msg}`);
      }
    }
  );
}
