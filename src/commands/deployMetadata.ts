import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { escapeShellArg } from "../utils/commandRunner";

export const DEPLOY_TYPE_RUN_ALL = "Run All Tests";
export const DEPLOY_TYPE_RUN_RELEVANT = "Run Relevant Tests";
export const DEPLOY_TYPE_SPECIFIED = "Run Specified Tests";
export const DEPLOY_TYPE_NO_TESTS = "No Test Run";

/** Test levels accepted by `sf project deploy start -l`. Anything else is rejected (presets are repo files). */
const VALID_TEST_LEVELS = new Set(["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg", "RunRelevantTests"]);

/** Apex test name: `Class`, `ns.Class`, `Class.method` or `ns.Class.method` (identifiers only). */
const APEX_TEST_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,2}$/;

/**
 * Normalize test flags to validated `-t <name>` pairs. Accepts an array of test names or the
 * legacy `-t A -t B` string (built by the panel from preset files). Throws on anything that
 * is not a plain Apex test name, so preset content can never inject shell syntax.
 */
function buildTestArgs(testFlags: string | string[]): string {
  let names: string[];
  if (Array.isArray(testFlags)) {
    names = testFlags.map((t) => t.trim()).filter(Boolean);
  } else {
    const tokens = testFlags.trim().split(/\s+/).filter(Boolean);
    names = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === "-t" || tok === "--tests") continue;
      names.push(tok);
    }
  }
  for (const n of names) {
    if (!APEX_TEST_NAME_RE.test(n)) throw new Error(`Invalid Apex test name: ${JSON.stringify(n)}`);
  }
  return names.map((n) => `-t ${n}`).join(" ");
}

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

/** Recursive file/folder node under a package dir. Path is relative to workspace (forward slashes). */
export interface DeployFileTreeNode {
  label: string;
  path: string;
  children?: DeployFileTreeNode[];
}

/** Package root with its full filesystem tree (all files and subfolders under SFDX package dirs). */
export interface DeployTreePackageNode {
  label: string;
  path: string;
  children: DeployFileTreeNode[];
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "__pycache__", "bin", ".sfdx"]);

/** Recursively build a tree of all files and folders under dirRel (relative to workspaceRoot). Skip -meta.xml when a partner file exists, except under LWC. In staticresources, subdirs are treated as single deployable items (no recursion). */
function buildFileTree(workspaceRoot: string, dirRel: string): DeployFileTreeNode[] {
  const fullDir = path.join(workspaceRoot, dirRel);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];
  const result: DeployFileTreeNode[] = [];
  const norm = (p: string) => p.replace(/\\/g, "/");
  const dirNorm = norm(dirRel);
  const segments = dirNorm.split("/").filter(Boolean);
  const inStaticResources = segments[segments.length - 1] === "staticresources";
  const inLwc = dirNorm.includes("/lwc/");
  try {
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    const namesSet = new Set(entries.map((e) => e.name));
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isFile() && ent.name.endsWith("-meta.xml")) {
        const partnerName = ent.name.slice(0, -"-meta.xml".length);
        if (namesSet.has(partnerName) && !inLwc) continue;
      }
      const childRel = norm(path.join(dirRel, ent.name));
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        if (inLwc && (ent.name === "__tests__" || ent.name === "__tests")) continue;
        if (inStaticResources) {
          result.push({ label: ent.name, path: childRel });
        } else {
          const children = buildFileTree(workspaceRoot, path.join(dirRel, ent.name));
          result.push({ label: ent.name, path: childRel, children });
        }
      } else {
        result.push({ label: ent.name, path: childRel });
      }
    }
  } catch {
    // ignore
  }
  return collapseSingleChildFolders(filterEmptyFolders(result));
}

/** Remove folder nodes that have no file descendants (only empty subfolders). */
function filterEmptyFolders(nodes: DeployFileTreeNode[]): DeployFileTreeNode[] {
  return nodes
    .map((node): DeployFileTreeNode | null => {
      if (!node.children || node.children.length === 0) return node; // file or leaf
      const filtered = filterEmptyFolders(node.children);
      if (filtered.length === 0) return null;
      return { ...node, children: filtered };
    })
    .filter((n): n is DeployFileTreeNode => n !== null);
}

/** Collapse directories that have only one child (and that child is a directory) into a single combined node to save space, e.g. force-app/main/default. */
function collapseSingleChildFolders(nodes: DeployFileTreeNode[]): DeployFileTreeNode[] {
  return nodes.map(collapseSingleChildChain);
}

function collapseSingleChildChain(node: DeployFileTreeNode): DeployFileTreeNode {
  if (!node.children || node.children.length === 0) return node;
  if (node.children.length > 1) {
    return { ...node, children: node.children.map(collapseSingleChildChain) };
  }
  const only = node.children[0];
  if (!only.children) return { ...node, children: [only] };
  const collapsedChild = collapseSingleChildChain(only);
  return {
    label: node.label + "/" + collapsedChild.label,
    path: collapsedChild.path,
    children: collapsedChild.children ?? []
  };
}

/** Full filesystem tree under each SFDX package root from sfdx-project.json. */
export function getMetadataTreeByPackage(workspaceRoot: string): DeployTreePackageNode[] {
  const packageDirs = getPackageDirectories(workspaceRoot);
  const norm = (p: string) => p.replace(/\\/g, "/");
  return packageDirs.map((pkg) => {
    const pkgNorm = norm(pkg);
    let children = buildFileTree(workspaceRoot, pkg);
    let label = pkg;
    let pathVal = pkgNorm;
    // Keep merging root with its single child folder until we have multiple children or a file (saves space: adser-utils + famkosoft-utility/.../tests -> one row)
    while (children.length === 1 && children[0].children !== undefined) {
      const only = children[0];
      label = label + "/" + only.label;
      pathVal = only.path;
      children = only.children ?? [];
    }
    return { label, path: pathVal, children };
  });
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

/** Resolve selected paths to absolute paths; empty array = entire project. */
export function resolveSourcePaths(selected: string[], workspaceRoot: string): string[] {
  if (selected.length === 0) return [];
  return selected.map((p) => (path.isAbsolute(p) ? p : path.join(workspaceRoot, p)));
}

/** True if the given absolute path is inside a package directory from sfdx-project.json. */
function isPathInPackageDirs(workspaceRoot: string, absPath: string): boolean {
  const packageDirs = getPackageDirectories(workspaceRoot);
  const normalizedPath = path.normalize(absPath);
  for (const dir of packageDirs) {
    const packageRoot = path.normalize(path.join(workspaceRoot, dir));
    if (normalizedPath === packageRoot || normalizedPath.startsWith(packageRoot + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Keep only paths that lie inside an sfdx package root (from sfdx-project.json). */
export function filterPathsToPackageDirs(workspaceRoot: string, absPaths: string[]): string[] {
  if (absPaths.length === 0) return absPaths;
  const packageDirs = getPackageDirectories(workspaceRoot);
  if (packageDirs.length === 0) return absPaths;
  return absPaths.filter((p) => isPathInPackageDirs(workspaceRoot, p));
}
