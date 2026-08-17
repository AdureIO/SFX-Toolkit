import * as vscode from "vscode";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import * as fs from "fs";
import * as path from "path";
import { Logger, outputChannel, DeployLog } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { getAutoSaveBeforePush, getTestRunTimeout } from "../utils/constants";
import { DEPLOY_TIMEOUT_MS } from "./deployMetadata";
import { runJsonDeploy } from "../utils/deployEngine";
import { formatStatus, formatElapsed, affectedSchemaObjects, componentSuccessList, parseRetrievedComponents, schemaObjectFromPath, toApiDeployResult, type DeployedComponent } from "../utils/deployStatusMap";
import { clearDeployDiagnostics, setDeployDiagnosticsFromApiResult, setDeployDiagnosticsFromFailure, formatApiDeployResultForLog, componentFailuresOf, withSyntheticTestFailures } from "../utils/deployDiagnostics";
import { reportError, reportSuccess } from "../utils/reportError";
import { OperationPanelProvider } from "../providers/OperationPanelProvider";
import { getDefaultOrg, getDefaultOrgSync } from "../utils/defaultOrg";
import { confirmProductionOrgOperation } from "../utils/orgSafety";
import { Telemetry } from "../utils/telemetry";

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
  const pushStartTime = Date.now();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
  statusBar.command = "adure-sfx-toolkit.showOutput";
  statusBar.text = defaultOrg ? `$(sync~spin) Deploying to ${defaultOrg.displayName}...` : "$(sync~spin) Deploying...";
  statusBar.tooltip = "Click to Show Deployment Logs";
  statusBar.show();

  const operationHandle = OperationPanelProvider.beginOperation(title, defaultOrg?.displayName);

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

          clearDeployDiagnostics();
          // Mutated inside runOne (a closure); a state object keeps TS narrowing honest
          // (property narrowing resets after each await, unlike captured `let`s).
          const state: {
            totalCount: number; // numberComponentsDeployed, aggregated across package dirs
            numTotal: number; // numberComponentsTotal
            numErrors: number; // numberComponentErrors
            cancelled: boolean;
            failure: { apiResult?: import("../utils/deployDiagnostics").ApiDeployResult; errorText?: string } | null;
            components: DeployedComponent[]; // deployed components, for smart schema refresh
            fallbackUsed: boolean; // a non-live CLI deploy ran → no structured component list
          } = { totalCount: 0, numTotal: 0, numErrors: 0, cancelled: false, failure: null, components: [], fallbackUsed: false };

          /**
           * Run one deploy invocation; returns false to stop a multi-package loop (cancel/failure).
           *
           * Push runs a SYNCHRONOUS streaming deploy (no `--async`) so it WAITS for the org and
           * advances local source tracking (→ incremental push; an async submit doesn't, and
           * `deploy resume` can't retro-fix it). To still show live status, we grab the deploy id
           * from the CLI's own output ("Deploy ID: 0Af…") and REST-poll THAT id in parallel — the
           * poll drives the live status + timer and returns the final structured result for the
           * smart schema refresh and the log table.
           */
          const runOne = async (submitBase: string, label?: string): Promise<boolean> => {
            const report = (m: string) => {
              const full = label ? `${label}: ${m}` : m;
              progress.report({ message: full });
              statusBar.text = `$(sync~spin) ${full}`;
            };
            report("Deploying (source tracking)…");
            const outcome = await runJsonDeploy({
              submitCommand: submitBase,
              cwd: rootPath,
              org: null,
              token,
              timeoutMs: DEPLOY_TIMEOUT_MS,
              onStatus: (s) => {
                report(formatStatus(s));
                operationHandle.updateLiveStatus(s);
              }
            });
            if (outcome.kind === "cancelled") { state.cancelled = true; return false; }
            if (outcome.kind === "nothing") return true; // no local changes
            if (outcome.kind === "failed") {
              // Keep the raw errorText even when a (possibly empty) result parsed — CLI-level
              // failures (e.g. ExpectedSourceFilesError) carry the real message only in the text.
              state.failure = { apiResult: outcome.result ? toApiDeployResult(outcome.result) : undefined, errorText: outcome.errorText };
              return false;
            }
            const dr = outcome.result;
            if (dr.numberComponentsDeployed !== undefined || dr.details) {
              state.totalCount += dr.numberComponentsDeployed ?? 0;
              state.numTotal += dr.numberComponentsTotal ?? 0;
              state.numErrors += dr.numberComponentErrors ?? 0;
              state.components.push(...componentSuccessList(dr));
            } else {
              state.fallbackUsed = true; // couldn't read the structured result → refresh fully
            }
            return true;
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

          const flag = force ? "--ignore-conflicts" : "";
          if (hasSourceTracking) {
            // Source tracking active → one deploy of the tracked changes.
            progress.report({ message: "Deploying (source tracking)…" });
            await runOne(`sf project deploy start ${flag}`);
          } else if (packageDirs.length > 0) {
            // No tracking → deploy each package directory in turn.
            progress.report({ message: `Found ${packageDirs.length} package directories.` });
            for (const pkgDir of packageDirs) {
              const fullPkgPath = path.join(rootPath, pkgDir);
              if (!fs.existsSync(fullPkgPath)) continue;
              const cont = await runOne(`sf project deploy start -d ${escapeShellArg(fullPkgPath)} ${flag}`, pkgDir);
              if (!cont) break; // cancelled or failed — stop the sequence
            }
          } else {
            progress.report({ message: "Deploying project…" });
            await runOne(`sf project deploy start ${flag}`);
          }

          if (state.cancelled) {
            Logger.info("Push cancelled by user.");
            Telemetry.event("push", { force: String(force), status: "cancelled" }, { durationMs: Date.now() - pushStartTime });
            operationHandle.dispose();
            return;
          }
          if (state.failure) {
            Telemetry.event("push", { force: String(force), status: "failed" }, { durationMs: Date.now() - pushStartTime });
            const apiResult = state.failure.apiResult;
            const errorText = (state.failure.errorText ?? "").trim();
            // Fold in code coverage warnings and Apex test failures — the API returns those in
            // separate fields (details.runTestResult), not componentFailures, so a push that
            // fails ONLY on org-wide coverage (clean component/test counts) would otherwise show
            // nothing here at all.
            const failures = apiResult ? componentFailuresOf(withSyntheticTestFailures(apiResult)) : [];

            // Populate the Problems view from whichever source has detail.
            if (failures.length) setDeployDiagnosticsFromApiResult(rootPath, withSyntheticTestFailures(apiResult!));
            else if (errorText) await setDeployDiagnosticsFromFailure(rootPath, errorText, null);

            // Prefer the raw CLI error text for the panel — it carries the exact message
            // (e.g. ExpectedSourceFilesError) that a component-less apiResult drops. Otherwise
            // fall back to the actual unmodified JSON payload (the human-readable table already
            // went to the Output log via setDeployDiagnosticsFromApiResult/setDeployDiagnosticsFromFailure above).
            const raw = errorText || (apiResult ? JSON.stringify(apiResult, null, 2) : "Push failed.");
            // Salesforce sometimes reports Status: Failed with clean component/test counts and no
            // errorMessage/stateDetail at all — without a fallback here the pretty card has nothing to show.
            const topError =
              apiResult?.errorMessage ??
              apiResult?.stateDetail ??
              (!errorText && apiResult && failures.length === 0
                ? "Push failed, but the org reported no error message, component failures, or test failures. See the original output below."
                : undefined);
            reportError({
              operation: "Push",
              error: raw,
              failures,
              topError,
              org: getDefaultOrgSync()?.displayName,
              retry: () => { void pushSourceHelper(force); },
              handle: operationHandle
            });
            return;
          }

          // Smart schema refresh: only invalidate/regenerate stubs when the push
          // actually changed objects/fields — a plain Apex push refreshes nothing.
          if (state.fallbackUsed) {
            // No structured component list from the CLI text path → refresh fully to be safe.
            OrgMetadataCache.invalidate(null);
            OrgMetadataCache.warmDefaultOrg();
          } else {
            const { objects, structural } = affectedSchemaObjects(state.components);
            if (objects.length) {
              Logger.info(`Push changed schema for: ${objects.join(", ")}${structural ? " (structural)" : ""}. Refreshing those stubs.`);
              OrgMetadataCache.invalidateSObjects(null, objects, structural);
              if (structural) OrgMetadataCache.warmDefaultOrg();
            }
          }

          const pushElapsed = formatElapsed(Date.now() - pushStartTime);
          DeployLog.line(
            formatApiDeployResultForLog(
              {
                status: "Succeeded",
                numberComponentsDeployed: state.totalCount,
                numberComponentsTotal: state.numTotal || state.totalCount,
                numberComponentErrors: state.numErrors,
                details: { componentSuccesses: state.components },
              },
              `Push succeeded (${pushElapsed}):`
            )
          );
          Telemetry.event(
            "push",
            { force: String(force), status: state.totalCount > 0 ? "succeeded" : "nothing" },
            { durationMs: Date.now() - pushStartTime }
          );
          reportSuccess({
            operation: "Push",
            org: getDefaultOrgSync()?.displayName,
            summary:
              state.totalCount > 0
                ? `Deployed ${state.totalCount} components in ${pushElapsed}.`
                : `Nothing to push — no local changes to deploy.`,
            apiResult: {
              numberComponentsDeployed: state.totalCount,
              numberComponentsTotal: state.numTotal || state.totalCount,
              numberComponentErrors: state.numErrors,
              details: { componentSuccesses: state.components }
            },
            handle: operationHandle
          });
        } catch (e: any) {
          if (e.cancelled) {
            Logger.info("Push cancelled by user.");
            operationHandle.dispose();
            return;
          }
          // e.message contains combined stdout/stderr from commandRunner
          const raw = e.message || e.stderr || "Unknown Error";
          // Report the UNcleaned text — the CLI's JSON error (message/name/warnings) carries the
          // exact cause; cleanDeployOutput strips it for the human-readable log.
          reportError({
            operation: "Push",
            error: raw,
            org: getDefaultOrgSync()?.displayName,
            retry: () => { void pushSourceHelper(force); },
            handle: operationHandle
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

async function pullSourceHelper(force: boolean) {
  const title = force ? "Force Pulling Source from Default Org..." : "Pulling Source from Default Org...";
  const org = getDefaultOrgSync()?.displayName;
  const operationHandle = OperationPanelProvider.beginOperation("Pull", org);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true
    },
    async (_progress, token) => {
      const pullStartTime = Date.now();
      try {
        const flag = force ? "--ignore-conflicts" : "";
        // --json so we can see exactly which components were retrieved and refresh smartly.
        const command = `sf project retrieve start ${flag} --json`.replace(/\s+/g, " ").trim();
        Logger.info(`Running: ${command}`);
        const result = await runCommand(command, undefined, undefined, false, token);
        Logger.info("Pull completed successfully.");

        // Smart schema refresh: only when the pull brought down object/field changes.
        const components = parseRetrievedComponents(result);
        if (!components) {
          // Couldn't read the retrieve result → refresh fully to be safe.
          OrgMetadataCache.invalidate(null);
          OrgMetadataCache.warmDefaultOrg();
        } else {
          const { objects, structural } = affectedSchemaObjects(components);
          if (objects.length) {
            Logger.info(`Pull changed schema for: ${objects.join(", ")}${structural ? " (structural)" : ""}. Refreshing those stubs.`);
            OrgMetadataCache.invalidateSObjects(null, objects, structural);
            if (structural) OrgMetadataCache.warmDefaultOrg();
          }
          // else: no schema changes retrieved → no stub/describe refresh
        }
        Telemetry.event(
          "pull",
          { force: String(force), status: (components?.length ?? 0) > 0 ? "succeeded" : "nothing" },
          { durationMs: Date.now() - pullStartTime }
        );
        reportSuccess({ operation: "Pull", org, summary: "Source pulled successfully.", handle: operationHandle });
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Pull cancelled by user.");
          Telemetry.event("pull", { force: String(force), status: "cancelled" }, { durationMs: Date.now() - pullStartTime });
          operationHandle.dispose();
          return;
        }
        Telemetry.event("pull", { force: String(force), status: "failed" }, { durationMs: Date.now() - pullStartTime });
        reportError({ operation: "Pull", error: e, org, handle: operationHandle });
      }
    }
  );
}

export async function pullSource() {
  await pullSourceHelper(false);
}

export async function pullSourceForce() {
  await pullSourceHelper(true);
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
  const operationHandle = OperationPanelProvider.beginOperation("Deploy", defaultOrg?.displayName);

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
        // Only refresh stubs if the deployed file is object/field schema.
        const schema = schemaObjectFromPath(filePath);
        if (schema) {
          OrgMetadataCache.invalidateSObjects(null, [schema.object], schema.structural);
          if (schema.structural) OrgMetadataCache.warmDefaultOrg();
        }
        Telemetry.event("deployFile", { status: "succeeded" });
        reportSuccess({
          operation: "Deploy",
          org: defaultOrg?.displayName,
          summary: count > 0 ? `Deployed ${count} components.` : "File deployed successfully.",
          handle: operationHandle
        });
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Deploy cancelled by user.");
          Telemetry.event("deployFile", { status: "cancelled" });
          operationHandle.dispose();
          return;
        }
        Telemetry.event("deployFile", { status: "failed" });
        reportError({ operation: "Deploy", error: e, org: defaultOrg?.displayName, handle: operationHandle });
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
  const org = getDefaultOrgSync()?.displayName;
  const operationHandle = OperationPanelProvider.beginOperation("Retrieve", org);

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
        // Only refresh stubs if the retrieved file is object/field schema.
        const schema = schemaObjectFromPath(filePath);
        if (schema) {
          OrgMetadataCache.invalidateSObjects(null, [schema.object], schema.structural);
          if (schema.structural) OrgMetadataCache.warmDefaultOrg();
        }
        Telemetry.event("retrieveFile", { status: "succeeded" });
        reportSuccess({ operation: "Retrieve", org, summary: "File retrieved successfully.", handle: operationHandle });
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Retrieve cancelled by user.");
          Telemetry.event("retrieveFile", { status: "cancelled" });
          operationHandle.dispose();
          return;
        }
        Telemetry.event("retrieveFile", { status: "failed" });
        reportError({ operation: "Retrieve", error: e, org, handle: operationHandle });
      }
    }
  );
}

export async function runLocalTests() {
  const org = getDefaultOrgSync()?.displayName;
  const operationHandle = OperationPanelProvider.beginOperation("Run local tests", org);

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

        const passed = result.includes("Pass") && !result.includes("Fail");
        Telemetry.event("testRun", { outcome: passed ? "pass" : "fail" });
        if (passed) {
          reportSuccess({ operation: "Run local tests", org, summary: "Tests passed.", handle: operationHandle });
        } else {
          reportError({
            operation: "Run local tests",
            error: "Some tests failed. See the 'Salesforce Test Results' output channel for details.",
            org,
            handle: operationHandle
          });
        }
      } catch (e: any) {
        if (e.cancelled) {
          Logger.info("Run Local Tests cancelled by user.");
          operationHandle.dispose();
          return;
        }
        Telemetry.event("testRun", { outcome: "error" });
        reportError({ operation: "Run local tests", error: e, org, handle: operationHandle });
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
        reportError({ operation: "Reset source tracking", error: e, org: getDefaultOrgSync()?.displayName });
      }
    }
  );
}
