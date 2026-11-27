import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { escapeShellArg } from "../utils/commandRunner";
import { VALID_TEST_LEVELS, buildTestArgs } from "../utils/deployTestArgsPure";

export const DEPLOY_TYPE_RUN_ALL = "Run All Tests";
export const DEPLOY_TYPE_RUN_RELEVANT = "Run Relevant Tests";
export const DEPLOY_TYPE_SPECIFIED = "Run Specified Tests";
export const DEPLOY_TYPE_NO_TESTS = "No Test Run";

export function buildDeployCommand(
  sourcePaths: string[],
  testLevel: string,
  testFlags: string | string[],
  dryRun: boolean,
  workspaceRoot: string,
  targetOrg?: string,
  asyncJson?: boolean
): string {
  if (!VALID_TEST_LEVELS.has(testLevel)) throw new Error(`Invalid test level: ${JSON.stringify(testLevel)}`);
  const sourceArgs =
    sourcePaths.length > 0
      ? sourcePaths
          .map((p) => {
            const full = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
            return `-d ${escapeShellArg(full)}`;
          })
          .join(" ")
      : "";
  const parts = [
    "sf project deploy start",
    sourceArgs,
    `-l ${testLevel}`,
    buildTestArgs(testFlags),
    targetOrg ? `-o ${escapeShellArg(targetOrg)}` : "",
    // The panel is an explicit "deploy exactly this selection" action, so it must always
    // deploy what was asked — never let source-tracking conflict detection block it.
    "--ignore-conflicts",
    dryRun ? "--dry-run" : "",
    asyncJson ? "--async --json" : ""
  ];
  return parts.filter(Boolean).join(" ");
}

// Max time to wait for a single deploy CLI invocation before treating it as timed out.
// Large orgs or validate-all-tests runs can easily exceed 15 minutes, so use 45 minutes.
export const DEPLOY_TIMEOUT_MS = 2700000; // 45 minutes

/** Strip ANSI codes from CLI output. */
function stripAnsi(data: string): string {
  return data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

export interface DeployProgressHandlerOptions {
  /** Called as soon as "Status: Failed" is seen in the stream. Receives accumulated output so far. Call once. */
  onStatusFailed?: (outputSoFar: string) => void;
}

/** Create an onOutput callback that parses deploy CLI output and reports status (same as push command). */
export function createDeployProgressHandler(
  report: (message: string) => void,
  options?: DeployProgressHandlerOptions
): (data: string) => void {
  let currentPhase = "";
  let currentDetails = "";
  let accumulated = "";
  let failedNotified = false;
  return (data: string) => {
    accumulated += data;
    const cleanData = stripAnsi(data);
    const lines = cleanData.split(/[\r\n]+/);
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      const isSpinner = /[\u2800-\u28FF\u2026\u22EE]/.test(l);
      const cleanLine = l.replace(/^[^\w\s]+/, "").trim();
      if (isSpinner) {
        if (l.includes("Deploying Metadata")) currentPhase = cleanLine;
        else if (l.includes("Running Tests")) {
          currentPhase = cleanLine;
          currentDetails = "";
        } else if (l.includes("Preparing")) currentPhase = cleanLine;
        else if (l.includes("Waiting for the org to respond")) currentPhase = cleanLine;
      } else {
        if (l.includes("Components:")) currentDetails = l.replace(/^[^\w\s]+/, "").trim();
        else if (l.startsWith("Status:")) {
          if (!l.includes("In Progress") && !l.includes("Pending")) {
            const s = l.replace("Status:", "").trim();
            if (s.length > 0) {
              if (currentPhase === "Running Tests" && !l.includes("Running Tests")) {
                if (s === "Done" || s === "Failed" || s === "Succeeded") currentPhase = `Status: ${s}`;
              } else currentPhase = `Status: ${s}`;
            }
            if (/Failed/i.test(s) && options?.onStatusFailed && !failedNotified) {
              failedNotified = true;
              options.onStatusFailed(accumulated);
            }
          }
        }
      }
    }
    const statusMsg = [currentPhase, currentDetails].filter(Boolean).join(" | ");
    if (statusMsg) report(statusMsg);
  };
}

/** Package directory paths from sfdx-project.json (e.g. ["force-app"]). Used for deploy tree and path resolution. */
export function getPackageDirectories(workspaceRoot: string): string[] {
  const projectPath = path.join(workspaceRoot, "sfdx-project.json");
  if (!fs.existsSync(projectPath)) {
    // Fallback: common roots if they exist
    const candidates = ["force-app", "manifest", "src"];
    return candidates.filter((d) => fs.existsSync(path.join(workspaceRoot, d)));
  }
  try {
    const content = fs.readFileSync(projectPath, "utf8");
    const config = JSON.parse(content);
    if (config.packageDirectories && Array.isArray(config.packageDirectories)) {
      return config.packageDirectories.map((p: { path?: string }) => p.path).filter(Boolean);
    }
  } catch {
    // ignore
  }
  return [];
}

/**
 * Apex test classes in the workspace (name contains "test" or file has @isTest). Async and
 * scoped: skips CLI caches (.sfdx/.sf hold thousands of sObject stub .cls files),
 * node_modules and bin, and reads files with bounded concurrency.
 */
export async function getTestClassItems(workspaceRoot: string): Promise<{ label: string; description: string }[]> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceRoot, "**/*.cls"),
    "{**/node_modules/**,**/bin/**,**/.sfdx/**,**/.sf/**,**/.git/**}"
  );
  const files = uris.map((u) => u.fsPath).sort();
  const isTest = new Array<boolean>(files.length).fill(false);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const idx = next++;
      const f = files[idx];
      if (/test/i.test(path.basename(f, ".cls"))) {
        isTest[idx] = true;
        continue;
      }
      try {
        isTest[idx] = /@isTest/i.test(await fs.promises.readFile(f, "utf8"));
      } catch {
        /* ignore */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
  return files
    .filter((_, i) => isTest[i])
    .map((f) => ({ label: path.basename(f, ".cls"), description: path.relative(workspaceRoot, f).replace(/\\/g, "/") }));
}

