import * as vscode from "vscode";
import * as glob from "glob";
import * as path from "path";
import * as fs from "fs";
import { loadPresets, addPreset, type DeployPreset, type DeployTypeKey } from "../utils/deployPresets";
import { escapeShellArg, runCommand } from "../utils/commandRunner";
import { confirmProductionOrgOperation } from "../utils/orgSafety";

export const DEPLOY_TYPE_RUN_ALL = "Run All Tests";
export const DEPLOY_TYPE_RUN_RELEVANT = "Run Relevant Tests";
export const DEPLOY_TYPE_SPECIFIED = "Run Specified Tests";
export const DEPLOY_TYPE_VALIDATE = "Validate Only (dry-run)";
export const DEPLOY_TYPE_NO_TESTS = "No Test Run";

const LABEL_NEW = "New deployment";
const LABEL_ENTER_PATH = "Enter path...";
const LABEL_BROWSE = "Browse for folder(s)...";
const LABEL_SELECT_FILES = "Select specific file(s)...";
const NAV_BY_FOLDER = "By folder";
const NAV_BY_TYPE = "By metadata type";
const DEPLOY_ALL_FOLDERS = "Deploy all folders of selected type(s)";
const SELECT_SPECIFIC_FILES = "Select specific files from selected type(s)";

/** Standard metadata folder names (under package dirs) and their display labels. */
const METADATA_TYPE_FOLDERS: { dirName: string; label: string }[] = [
  { dirName: "classes", label: "Classes" },
  { dirName: "triggers", label: "Triggers" },
  { dirName: "lwc", label: "LWC" },
  { dirName: "aura", label: "Aura" },
  { dirName: "objects", label: "Objects" },
  { dirName: "tabs", label: "Tabs" },
  { dirName: "layouts", label: "Layouts" },
  { dirName: "permissionsets", label: "Permission Sets" },
  { dirName: "flows", label: "Flows" },
  { dirName: "flexipages", label: "FlexiPages" },
  { dirName: "applications", label: "Applications" },
  { dirName: "customMetadata", label: "Custom Metadata" },
  { dirName: "staticresources", label: "Static Resources" },
  { dirName: "profiles", label: "Profiles" },
  { dirName: "customLabels", label: "Custom Labels" },
  { dirName: "reportTypes", label: "Report Types" },
  { dirName: "dashboards", label: "Dashboards" },
  { dirName: "reports", label: "Reports" },
  { dirName: "quickActions", label: "Quick Actions" },
  { dirName: "settings", label: "Settings" },
  { dirName: "translations", label: "Translations" },
  { dirName: "weblinks", label: "Web Links" },
  { dirName: "customPermissions", label: "Custom Permissions" },
  { dirName: "fieldSets", label: "Field Sets" }
];

export function buildDeployCommand(
  sourcePaths: string[],
  testLevel: string,
  testFlags: string,
  dryRun: boolean,
  workspaceRoot: string,
  targetOrg?: string,
  asyncJson?: boolean
): string {
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
    testFlags,
    targetOrg ? `-o ${escapeShellArg(targetOrg)}` : "",
    dryRun ? "--dry-run" : "",
    asyncJson ? "--async --json" : ""
  ];
  return parts.filter(Boolean).join(" ");
}

/** Parse deploy request ID from CLI JSON output (sf project deploy start --async --json). Expects result.id or result.deployId. */
export function parseDeployIdFromJson(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: { id?: string; deployId?: string }; id?: string };
    const id = parsed.result?.id ?? parsed.result?.deployId ?? parsed.id;
    if (id && /^0Af\w+$/.test(String(id))) return String(id);
    return null;
  } catch {
    return null;
  }
}

export async function runDeploy(
  sourcePaths: string[],
  testLevel: string,
  testFlags: string,
  dryRun: boolean,
  workspaceRoot: string,
  targetOrg?: string
): Promise<void> {
  const action = dryRun ? "validate a deployment against" : "deploy metadata to";
  if (!(await confirmProductionOrgOperation(action, targetOrg))) {
    return;
  }
  const cmd = buildDeployCommand(sourcePaths, testLevel, testFlags, dryRun, workspaceRoot, targetOrg);
  const terminal = vscode.window.createTerminal("Salesforce Deploy");
  terminal.show();
  terminal.sendText(cmd);
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

/** Extract deployed component count from deploy CLI stdout or async result message (e.g. "Deployed 5 component(s)."). */
export function getDeployedCountFromOutput(output: string): number {
  const clean = stripAnsi(output);
  const statusMatch = clean.match(/\|\s*(\d+)\/\d+\s*Components/);
  if (statusMatch) return parseInt(statusMatch[1], 10);
  const deployedMatch = clean.match(/Deployed\s+(\d+)\s+component/);
  if (deployedMatch) return parseInt(deployedMatch[1], 10);
  return 0;
}

/** Run deploy in background; supports cancellation and optional progress reporting (same as push). */
export async function runDeployAsync(
  sourcePaths: string[],
  testLevel: string,
  testFlags: string,
  dryRun: boolean,
  workspaceRoot: string,
  targetOrg: string | undefined,
  cancellationToken: vscode.CancellationToken,
  onProgress?: (message: string) => void
): Promise<string> {
  const action = dryRun ? "validate a deployment against" : "deploy metadata to";
  if (!(await confirmProductionOrgOperation(action, targetOrg))) {
    const err = new Error("Deploy cancelled.");
    (err as { cancelled?: boolean }).cancelled = true;
    throw err;
  }
  const cmd = buildDeployCommand(sourcePaths, testLevel, testFlags, dryRun, workspaceRoot, targetOrg);
  const onOutput = onProgress ? createDeployProgressHandler(onProgress) : undefined;
  return runCommand(cmd, workspaceRoot, onOutput, true, cancellationToken, DEPLOY_TIMEOUT_MS);
}

function deployTypeToKey(label: string): DeployTypeKey {
  if (label === DEPLOY_TYPE_RUN_ALL) return "RunAllTestsInOrg";
  if (label === DEPLOY_TYPE_RUN_RELEVANT) return "RunRelevantTests";
  if (label === DEPLOY_TYPE_SPECIFIED) return "RunSpecifiedTests";
  if (label === DEPLOY_TYPE_VALIDATE) return "ValidateOnly";
  return "NoTestRun";
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

export function getTestClassItems(workspaceRoot: string): { label: string; description: string }[] {
  const classFiles = glob.sync("**/*.cls", {
    cwd: workspaceRoot,
    ignore: ["**/node_modules/**", "**/bin/**"]
  });
  return classFiles
    .filter((f) => {
      if (/test/i.test(path.basename(f, ".cls"))) return true;
      try {
        const content = fs.readFileSync(path.join(workspaceRoot, f), "utf8");
        if (/@isTest/i.test(content)) return true;
      } catch {
        /* ignore */
      }
      return false;
    })
    .map((f) => ({ label: path.basename(f, ".cls"), description: f }));
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

/** Discover folders by metadata type. Returns list of { typeLabel, paths } for types that exist. */
function getMetadataByType(workspaceRoot: string): { typeLabel: string; paths: string[] }[] {
  const ignore = ["**/node_modules/**", "**/bin/**", "**/.git/**"];
  const result: { typeLabel: string; paths: string[] }[] = [];

  for (const { dirName, label } of METADATA_TYPE_FOLDERS) {
    const pattern = `**/${dirName}`;
    const matches = glob.sync(pattern, { cwd: workspaceRoot, ignore, mark: true });
    const dirs = matches.filter((m) => {
      const full = path.join(workspaceRoot, m);
      try {
        return fs.existsSync(full) && fs.statSync(full).isDirectory();
      } catch {
        return false;
      }
    });
    if (dirs.length > 0) {
      result.push({ typeLabel: label, paths: dirs });
    }
  }

  return result;
}

/** Recursively collect all subfolder paths under dir (relative to workspaceRoot). Includes dir itself. */
function getAllSubfolderPaths(workspaceRoot: string, dirRel: string): string[] {
  const fullDir = path.join(workspaceRoot, dirRel);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];
  const result: string[] = [dirRel];
  try {
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith(".") && ent.name !== "node_modules") {
        const childRel = path.join(dirRel, ent.name);
        result.push(childRel);
        result.push(...getAllSubfolderPaths(workspaceRoot, childRel));
      }
    }
  } catch {
    // ignore
  }
  return result;
}

/** Get deployable items (files or component dirs) for given type folders. Returns { label, path }[]. */
function getDeployableItemsForTypeFolders(
  workspaceRoot: string,
  typeFolders: { typeLabel: string; paths: string[] }[]
): { label: string; path: string }[] {
  const items: { label: string; path: string }[] = [];
  const ignore = ["**/node_modules/**", "**/bin/**"];

  for (const { typeLabel, paths: typePaths } of typeFolders) {
    const dirName = METADATA_TYPE_FOLDERS.find((t) => t.label === typeLabel)?.dirName ?? "";
    for (const folderRel of typePaths) {
      const fullDir = path.join(workspaceRoot, folderRel);
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;

      if (dirName === "classes" || dirName === "triggers") {
        const ext = dirName === "classes" ? ".cls" : ".trigger";
        const pattern = `**/*${ext}`;
        const matches = glob.sync(pattern, { cwd: fullDir, ignore, mark: true });
        for (const m of matches) {
          const fullPath = path.join(fullDir, m);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            const rel = path.join(folderRel, m);
            items.push({ label: `${typeLabel}: ${path.basename(m)}`, path: rel });
          }
        }
      } else if (dirName === "lwc" || dirName === "aura") {
        const files = fs.readdirSync(fullDir, { withFileTypes: true });
        for (const ent of files) {
          if (ent.isDirectory() && !ent.name.startsWith(".")) {
            const rel = path.join(folderRel, ent.name);
            items.push({ label: `${typeLabel}: ${ent.name}`, path: rel });
          }
        }
      } else {
        // Other types: list direct children (files or dirs) that look like metadata
        const files = fs.readdirSync(fullDir, { withFileTypes: true });
        for (const ent of files) {
          const rel = path.join(folderRel, ent.name);
          if (ent.isDirectory()) {
            items.push({ label: `${typeLabel}: ${ent.name}`, path: rel });
          } else if (
            ent.isFile() &&
            (ent.name.endsWith("-meta.xml") ||
              ent.name.endsWith(".xml") ||
              ent.name.endsWith(".permissionset-meta.xml"))
          ) {
            items.push({ label: `${typeLabel}: ${ent.name}`, path: rel });
          }
        }
      }
    }
  }
  return items;
}

export async function deployMetadata() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("No workspace open");
    return;
  }
  const workspaceRoot = folder.uri.fsPath;
  const workspaceUri = folder.uri;
  const packageDirs = getPackageDirectories(workspaceRoot);

  // 0. New deployment vs Use preset
  const presets = await loadPresets(workspaceUri);
  const startChoices: { label: string; preset?: DeployPreset }[] = [
    { label: LABEL_NEW },
    ...presets.map((p) => ({ label: `Preset: ${p.name}`, preset: p }))
  ];
  const startChoice = await vscode.window.showQuickPick(startChoices, {
    placeHolder: "New deployment or use a saved preset"
  });

  if (startChoice === undefined) return;

  if (startChoice.preset) {
    const preset = startChoice.preset;
    const sourcePaths = preset.sourcePaths || [];
    const missing = sourcePaths.filter((rel) => {
      const full = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
      return !fs.existsSync(full);
    });
    if (missing.length > 0) {
      vscode.window.showErrorMessage(`Preset "${preset.name}": some paths no longer exist: ${missing.join(", ")}`);
      return;
    }
    let testLevel: string;
    let testFlags = "";
    const dryRun = preset.deployType === "ValidateOnly";
    if (preset.deployType === "RunAllTestsInOrg") testLevel = "RunAllTestsInOrg";
    else if (preset.deployType === "RunRelevantTests") testLevel = "RunRelevantTests";
    else if (preset.deployType === "RunSpecifiedTests") {
      testLevel = "RunSpecifiedTests";
      testFlags = (preset.testClassNames || []).map((t) => `-t ${t}`).join(" ");
    } else if (preset.deployType === "ValidateOnly") testLevel = "RunLocalTests";
    else testLevel = "NoTestRun";

    const desc = sourcePaths.length === 0 ? "Entire project" : `${sourcePaths.length} path(s)`;
    const runChoice = await vscode.window.showQuickPick(
      [{ label: "Run", description: `Deploy ${desc}` }, { label: "Cancel" }],
      { placeHolder: `Preset: ${preset.name}` }
    );
    if (runChoice === undefined || runChoice.label === "Cancel") return;
    const absPaths = filterPathsToPackageDirs(workspaceRoot, resolveSourcePaths(sourcePaths, workspaceRoot));
    await runDeploy(absPaths, testLevel, testFlags, dryRun, workspaceRoot);
    return;
  }

  // 1. How to choose what to deploy
  let sourcePaths: string[] = [];
  const navChoice = await vscode.window.showQuickPick(
    [
      { label: NAV_BY_FOLDER, description: "Select package dirs, enter path, or browse" },
      { label: NAV_BY_TYPE, description: "Select by type (Classes, LWC, Triggers, …)" },
      { label: LABEL_SELECT_FILES, description: "Pick specific file(s) or folder(s) to deploy" }
    ],
    { placeHolder: "How do you want to choose what to deploy?" }
  );

  if (navChoice === undefined) return;

  if (navChoice.label === LABEL_SELECT_FILES) {
    // Picker: allow multiple files and/or folders (e.g. specific .cls files or an LWC component folder)
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      defaultUri: folder.uri,
      openLabel: "Select file(s) and/or folder(s) to deploy"
    });
    if (picked === undefined) return;
    if (picked.length === 0) {
      vscode.window.showInformationMessage("Nothing selected. Deploy cancelled.");
      return;
    }
    for (const uri of picked) {
      const rel = path.relative(workspaceRoot, uri.fsPath);
      sourcePaths.push(rel.startsWith("..") ? uri.fsPath : rel);
    }
  } else if (navChoice.label === NAV_BY_TYPE) {
    const byType = getMetadataByType(workspaceRoot);
    if (byType.length === 0) {
      vscode.window.showWarningMessage('No metadata type folders found (e.g. classes, lwc). Try "By folder" instead.');
      return;
    }
    const typeOptions = byType.map((t) => ({
      label: t.typeLabel,
      description: `${t.paths.length} folder(s)`,
      detail: t.paths.slice(0, 2).join(", ") + (t.paths.length > 2 ? "…" : ""),
      paths: t.paths
    }));
    const selectedTypes = await vscode.window.showQuickPick(typeOptions, {
      canPickMany: true,
      placeHolder: "Select metadata type(s) to deploy",
      matchOnDetail: true
    });
    if (selectedTypes === undefined) return;
    if (selectedTypes.length === 0) {
      vscode.window.showInformationMessage("No types selected. Deploy cancelled.");
      return;
    }
    // Deploy all folders of type(s) vs select specific files within those types
    const scopeChoice = await vscode.window.showQuickPick(
      [
        { label: DEPLOY_ALL_FOLDERS, description: "Deploy every folder of the selected type(s)" },
        { label: SELECT_SPECIFIC_FILES, description: "Pick individual files or components" }
      ],
      { placeHolder: "Deploy all or select specific items?" }
    );
    if (scopeChoice === undefined) return;

    if (scopeChoice.label === SELECT_SPECIFIC_FILES) {
      // Ask per metadata type so user always sees classes, LWC, etc. separately
      for (const typeOption of selectedTypes) {
        const typeFolders = [{ typeLabel: typeOption.label, paths: typeOption.paths }];
        const items = getDeployableItemsForTypeFolders(workspaceRoot, typeFolders);
        if (items.length === 0) continue;
        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: `Select which ${typeOption.label} to deploy`,
          matchOnDetail: true
        });
        if (selected === undefined) return;
        for (const i of selected) {
          sourcePaths.push(i.path);
        }
      }
      if (sourcePaths.length === 0) {
        vscode.window.showInformationMessage("No items selected. Deploy cancelled.");
        return;
      }
    } else {
      const seen = new Set<string>();
      for (const t of selectedTypes) {
        for (const p of t.paths) {
          if (!seen.has(p)) {
            seen.add(p);
            sourcePaths.push(p);
          }
        }
      }
    }
  } else {
    // By folder: all folders and subfolders under package dirs, plus Enter path + Browse
    const allFolderPaths: string[] = [];
    for (const d of packageDirs) {
      allFolderPaths.push(...getAllSubfolderPaths(workspaceRoot, d));
    }
    const pathOptions: { label: string; description?: string; value?: string }[] = [
      ...allFolderPaths.map((p) => ({ label: p, description: "Folder", value: p })),
      { label: LABEL_ENTER_PATH, description: "Type one or more paths (comma-separated)" },
      { label: LABEL_BROWSE, description: "Pick folders from file system" }
    ];

    const pathChoice = await vscode.window.showQuickPick(pathOptions, {
      canPickMany: pathOptions.filter((o) => o.value != null).length > 0,
      placeHolder: "Select folder(s) or choose Enter path / Browse",
      matchOnDescription: true
    });

    if (pathChoice === undefined) return;

    const chosenArray = Array.isArray(pathChoice) ? pathChoice : [pathChoice];

    const hasEnter = chosenArray.some((c) => c.label === LABEL_ENTER_PATH);
    const hasBrowse = chosenArray.some((c) => c.label === LABEL_BROWSE);
    const selectedDirs = chosenArray
      .filter((c) => (c as { value?: string }).value != null)
      .map((c) => (c as { value?: string }).value as string);

    if (hasEnter || hasBrowse) {
      sourcePaths.push(...selectedDirs);
      if (hasEnter) {
        const entered = await vscode.window.showInputBox({
          prompt: "Path(s) relative to workspace (comma-separated for multiple)",
          placeHolder: "e.g. force-app/main/default or force-app, manifest",
          validateInput: (v) => (v.trim() ? null : "Enter at least one path")
        });
        if (entered === undefined) return;
        const parts = entered
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        sourcePaths.push(...parts);
      }
      if (hasBrowse) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectMany: true,
          defaultUri: folder.uri,
          openLabel: "Select folder(s) to deploy"
        });
        if (picked === undefined) return;
        if (picked.length === 0 && sourcePaths.length === 0) {
          vscode.window.showInformationMessage("No paths selected. Deploy cancelled.");
          return;
        }
        for (const uri of picked) {
          const rel = path.relative(workspaceRoot, uri.fsPath);
          sourcePaths.push(rel.startsWith("..") ? uri.fsPath : rel);
        }
      }
    } else {
      sourcePaths = selectedDirs.length > 0 ? selectedDirs : chosenArray.map((c) => c.label);
    }
  }

  if (sourcePaths.length === 0) {
    vscode.window.showInformationMessage("No paths selected. Deploy cancelled.");
    return;
  }

  // 2. Deploy / test option
  const deployTypes = [
    { label: DEPLOY_TYPE_RUN_ALL, detail: "RunAllTestsInOrg" },
    { label: DEPLOY_TYPE_RUN_RELEVANT, detail: "RunRelevantTests" },
    { label: DEPLOY_TYPE_SPECIFIED, detail: "RunSpecifiedTests – choose test classes next" },
    { label: DEPLOY_TYPE_VALIDATE, detail: "Validate only (dry-run), no save to org" },
    { label: DEPLOY_TYPE_NO_TESTS, detail: "NoTestRun" }
  ];
  const chosenType = await vscode.window.showQuickPick(deployTypes, {
    placeHolder: "Select deploy / test option",
    matchOnDetail: true
  });

  if (chosenType === undefined) return;

  let testLevel: string;
  let testFlags = "";
  const dryRun = chosenType.label === DEPLOY_TYPE_VALIDATE;
  let testClassNames: string[] = [];

  if (chosenType.label === DEPLOY_TYPE_RUN_ALL) {
    testLevel = "RunAllTestsInOrg";
  } else if (chosenType.label === DEPLOY_TYPE_RUN_RELEVANT) {
    testLevel = "RunRelevantTests";
  } else if (chosenType.label === DEPLOY_TYPE_SPECIFIED) {
    testLevel = "RunSpecifiedTests";
    const testClassItems = getTestClassItems(workspaceRoot);
    if (testClassItems.length === 0) {
      vscode.window.showWarningMessage('No test classes found (names containing "Test" or @isTest). Deploy cancelled.');
      return;
    }
    const selectedTests = await vscode.window.showQuickPick(testClassItems, {
      canPickMany: true,
      placeHolder: "Select Test Classes to run"
    });
    if (selectedTests === undefined) return;
    if (selectedTests.length === 0) {
      vscode.window.showInformationMessage("No test classes selected for Run Specified Tests. Deploy cancelled.");
      return;
    }
    testClassNames = selectedTests.map((t) => t.label);
    testFlags = testClassNames.map((t) => `-t ${t}`).join(" ");
  } else if (chosenType.label === DEPLOY_TYPE_VALIDATE) {
    testLevel = "RunLocalTests";
  } else {
    testLevel = "NoTestRun";
  }

  // Store relative paths for preset / display; only include paths inside package dirs
  const resolved = resolveSourcePaths(sourcePaths, workspaceRoot);
  const absPaths = filterPathsToPackageDirs(workspaceRoot, resolved);
  const pathsForPreset = absPaths.map((p) => path.relative(workspaceRoot, p));

  // 3. Run or Save as preset
  const actionChoice = await vscode.window.showQuickPick(
    [
      { label: "Run", description: "Run deploy now" },
      { label: "Save as preset...", description: "Save this configuration for later" }
    ],
    { placeHolder: "Run deploy or save as preset" }
  );

  if (actionChoice === undefined) return;

  if (actionChoice.label === "Save as preset...") {
    const name = await vscode.window.showInputBox({
      prompt: "Preset name",
      placeHolder: "e.g. My Feature Deploy",
      validateInput: (v) => (v.trim() ? null : "Enter a name")
    });
    if (name === undefined) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const preset: DeployPreset = {
      name: trimmed,
      sourcePaths: pathsForPreset,
      deployType: deployTypeToKey(chosenType.label),
      testClassNames
    };
    await addPreset(workspaceUri, preset);
    vscode.window.showInformationMessage(`Preset "${trimmed}" saved.`);
    const runNow = await vscode.window.showQuickPick(
      [{ label: "Yes", description: "Run deploy now" }, { label: "No" }],
      { placeHolder: "Run deploy now?" }
    );
    if (runNow === undefined || runNow.label === "No") return;
  }

  await runDeploy(absPaths, testLevel, testFlags, dryRun, workspaceRoot);
}
