import * as vscode from "vscode";
import * as path from "path";
import * as glob from "glob";
import { DeployLog } from "./outputChannel";
import { getPackageDirectories } from "../commands/deployMetadata";

const DEPLOY_DIAGNOSTIC_SOURCE = "Deploy";

/** Metadata API deploy result details (see https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_rest_deploy_checkstatus.htm ). */
export interface ApiComponentFailure {
  fileName?: string;
  fullName?: string;
  componentType?: string;
  lineNumber?: number;
  columnNumber?: number;
  problem?: string;
}

/** A successfully-deployed component; `created`/`changed`/`deleted` give the native state. */
export interface ApiComponentSuccess {
  fileName?: string;
  fullName?: string;
  componentType?: string;
  created?: boolean;
  changed?: boolean;
  deleted?: boolean;
}

export interface ApiDeployResult {
  status?: string;
  numberComponentsDeployed?: number;
  numberComponentsTotal?: number;
  numberComponentErrors?: number;
  numberTestsCompleted?: number;
  numberTestsTotal?: number;
  numberTestErrors?: number;
  stateDetail?: string;
  errorStatusCode?: string;
  errorMessage?: string;
  details?: {
    componentFailures?: ApiComponentFailure | ApiComponentFailure[];
    componentSuccesses?: ApiComponentSuccess | ApiComponentSuccess[];
  };
}

/** Normalize API componentFailures to an array (API may return single object or array). */
function getComponentFailuresList(result: ApiDeployResult): ApiComponentFailure[] {
  const raw = result.details?.componentFailures;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

/** Public accessor for the normalized component-failure list (used by the interpreted error panel). */
export function componentFailuresOf(result: ApiDeployResult): ApiComponentFailure[] {
  return getComponentFailuresList(result);
}

/** Normalize API componentSuccesses to an array. */
function getComponentSuccessesList(result: ApiDeployResult): ApiComponentSuccess[] {
  const raw = result.details?.componentSuccesses;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

/** Native deploy state for a successful component (mirrors the CLI's State column). */
function componentState(c: ApiComponentSuccess): string {
  if (c.deleted) return "Deleted";
  if (c.created) return "Created";
  if (c.changed) return "Changed";
  return "Unchanged";
}

/**
 * Format deploy API result for the Output log so the user can see what went wrong
 * when diagnostics do not map to files (e.g. path resolution fails).
 * @param title optional header line (default "Deploy result (Metadata API):")
 */
export function formatApiDeployResultForLog(
  apiResult: ApiDeployResult,
  title: string = "Deploy result (Metadata API):"
): string {
  const lines: string[] = [title, `  Status: ${apiResult.status ?? "unknown"}`];
  if (apiResult.stateDetail) {
    lines.push(`  Detail: ${apiResult.stateDetail}`);
  }
  if (
    (apiResult.numberComponentsTotal !== null && apiResult.numberComponentsTotal !== undefined) ||
    (apiResult.numberComponentsDeployed !== null && apiResult.numberComponentsDeployed !== undefined)
  ) {
    const err = apiResult.numberComponentErrors ?? getComponentFailuresList(apiResult).length;
    lines.push(
      `  Components: ${apiResult.numberComponentsDeployed ?? "?"}/${apiResult.numberComponentsTotal ?? "?"}` +
        (err > 0 ? ` (${err} errors)` : "")
    );
  }
  if (
    apiResult.numberTestsTotal !== null &&
    apiResult.numberTestsTotal !== undefined &&
    ((apiResult.numberTestsCompleted !== null && apiResult.numberTestsCompleted !== undefined) ||
      (apiResult.numberTestErrors !== null && apiResult.numberTestErrors !== undefined))
  ) {
    lines.push(
      `  Tests: ${apiResult.numberTestsCompleted ?? "?"}/${apiResult.numberTestsTotal}` +
        ((apiResult.numberTestErrors ?? 0) > 0 ? ` (${apiResult.numberTestErrors} failed)` : "")
    );
  }
  // CLI-style component table: State | Type Name | Location [| problem]. Failures
  // first (most important), then successes with their native state.
  const failures = getComponentFailuresList(apiResult);
  const successes = getComponentSuccessesList(apiResult);

  interface Row { state: string; comp: string; loc: string; problem?: string }
  const rows: Row[] = [];
  const compLabel = (type?: string, name?: string) => [type, name].filter(Boolean).join(" ") || "—";

  for (const f of failures) {
    let loc = f.fileName?.trim() || "";
    if (f.lineNumber !== null && f.lineNumber !== undefined) {
      loc += `:${f.lineNumber}${f.columnNumber !== null && f.columnNumber !== undefined ? ":" + f.columnNumber : ""}`;
    }
    rows.push({ state: "Failed", comp: compLabel(f.componentType, f.fullName), loc, problem: (f.problem ?? "Deploy error").replace(/\s+/g, " ").slice(0, 300) });
  }
  for (const s of successes) {
    rows.push({ state: componentState(s), comp: compLabel(s.componentType, s.fullName), loc: s.fileName?.trim() || "" });
  }

  if (rows.length > 0) {
    const stateW = Math.max(...rows.map((r) => r.state.length));
    const compW = Math.min(48, Math.max(...rows.map((r) => r.comp.length)));
    lines.push(`  Components (${rows.length}):`);
    for (const r of rows) {
      let line = `    ${r.state.padEnd(stateW)}  ${r.comp.padEnd(compW)}  ${r.loc}`.replace(/\s+$/, "");
      if (r.problem) line += `  — ${r.problem}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}

/** Virtual URI for deploy errors that couldn't be mapped to a file (shows in Problems with full message). */
export const DEPLOY_ERRORS_URI = vscode.Uri.parse("adure-deploy:errors");

/** Diagnostic collection for deploy/validation errors so they appear in Problems and in the editor. */
let deployDiagnosticCollection: vscode.DiagnosticCollection | undefined;

export function getDeployDiagnosticCollection(): vscode.DiagnosticCollection {
  if (!deployDiagnosticCollection) {
    deployDiagnosticCollection = vscode.languages.createDiagnosticCollection("Adure SFX Toolkit Deploy");
  }
  return deployDiagnosticCollection;
}

/** Clear all deploy diagnostics (e.g. when starting a new deploy or when deploy succeeds). */
export function clearDeployDiagnostics(): void {
  getDeployDiagnosticCollection().clear();
}

/**
 * Remove a deploy-failure diagnostic once the user edits its line — the error is
 * being worked on, so keeping the stale red squiggle is noise. Registered once at
 * activation.
 */
export function registerDeployDiagnosticAutoClear(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      const collection = getDeployDiagnosticCollection();
      const existing = collection.get(e.document.uri);
      if (!existing || existing.length === 0) return;

      const editedLines = new Set<number>();
      for (const c of e.contentChanges) {
        for (let ln = c.range.start.line; ln <= c.range.end.line; ln++) editedLines.add(ln);
      }

      const kept = existing.filter((d) => {
        for (let ln = d.range.start.line; ln <= d.range.end.line; ln++) {
          if (editedLines.has(ln)) return false; // this diagnostic's line was edited → drop it
        }
        return true;
      });
      if (kept.length !== existing.length) collection.set(e.document.uri, kept);
    })
  );
}

/** Strip ANSI codes from CLI output. */
function stripAnsi(s: string): string {
  return s.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

/**
 * Trim to the failure section only: remove all progress output before the final failed state; keep from "Status: Failed" until the end (including Component Failures table).
 * The CLI repeats blocks (Deploy ID, Status: In Progress) during progress, so we must start at the line with "Status: Failed" (or last "Deploy ID:" / "Component Failures") so we do not include repeated status blocks.
 */
function trimToFailureSection(errorOutput: string): string {
  const clean = stripAnsi(errorOutput);
  const lines = clean.split(/\r?\n/);
  // Prefer the actual failure line so we skip all "Status: In Progress" / spinner blocks
  const statusFailedIdx = lines.findIndex((l) => /Status:\s*Failed\b/i.test(l));
  if (statusFailedIdx >= 0) {
    return lines.slice(statusFailedIdx).join("\n");
  }
  const componentFailuresIdx = lines.findIndex((l) => /Component\s+Failures?/i.test(l));
  if (componentFailuresIdx >= 0) {
    return lines.slice(componentFailuresIdx).join("\n");
  }
  // Last "Deploy ID:" is in the final block; first one is in an early progress block
  let lastDeployIdIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Deploy\s+ID:/i.test(lines[i])) lastDeployIdIdx = i;
  }
  if (lastDeployIdIdx >= 0) {
    return lines.slice(lastDeployIdIdx).join("\n");
  }
  return clean;
}

/**
 * Parse deploy result from CLI failure output (Component Failures table) without calling the API.
 * Returns an ApiDeployResult with details.componentFailures if the table can be parsed, otherwise null.
 */
function parseDeployResultFromCliOutput(errorOutput: string): ApiDeployResult | null {
  const clean = stripAnsi(errorOutput);
  const lines = clean.split(/\r?\n/);
  const sectionIdx = lines.findIndex((l) => /Component\s+Failures?\s*\[\d+\]/i.test(l));
  if (sectionIdx < 0) return null;

  const failures: ApiComponentFailure[] = [];
  let i = sectionIdx + 1;
  // Skip until we find the header line (Type, Name, Problem)
  while (i < lines.length) {
    const l = lines[i];
    if (/Type/i.test(l) && /Name/i.test(l) && (/Problem/i.test(l) || /Line:Column/i.test(l))) {
      i++;
      break;
    }
    i++;
  }
  // Skip separator line (├─── or ─── or ===)
  while (i < lines.length && (/^[\s│├└┬┴┼─═┌┐┘└]+$/.test(lines[i]) || /^[\s\-=]+$/.test(lines[i]))) i++;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (/^(Test\s+Failures?|Deploy\s+ID|Status:)/i.test(line)) break;
    // Skip box-drawing separator lines (├───┼─── or └───┴───)
    if (/^[\s│├└┬┴┼─═]+$/.test(line)) {
      i++;
      continue;
    }
    let componentType: string;
    let name: string;
    let problem: string;
    let lineNum: number | undefined;
    let colNum: number | undefined;
    // Box-drawing table: │ Type │ Name │ Problem │ Line:Column │
    if (line.includes("│")) {
      const parts = line.split("│").map((p) => p.trim());
      if (parts.length >= 4) {
        componentType = parts[1] ?? "";
        name = parts[2] ?? "";
        problem = parts[3] ?? "";
        const lineCol = parts[4] ?? "";
        const lcMatch = lineCol.match(/^(\d+):(\d+)$/);
        if (lcMatch) {
          lineNum = parseInt(lcMatch[1], 10);
          colNum = parseInt(lcMatch[2], 10);
        }
      } else {
        i++;
        continue;
      }
    } else {
      // Space-separated table
      const parts = line
        .split(/\s{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length < 3) {
        i++;
        continue;
      }
      componentType = parts[0];
      name = parts[1];
      if (parts.length >= 5 && /^\d+$/.test(parts[2]) && /^\d+$/.test(parts[3])) {
        lineNum = parseInt(parts[2], 10);
        colNum = parseInt(parts[3], 10);
        problem = parts.slice(4).join(" ").trim();
      } else if (parts.length >= 4 && /^\d+$/.test(parts[2])) {
        lineNum = parseInt(parts[2], 10);
        problem = parts.slice(3).join(" ").trim();
      } else {
        problem = parts.slice(2).join(" ").trim();
      }
    }
    if (componentType && name) {
      failures.push({
        componentType,
        fullName: name.trim(),
        lineNumber: lineNum,
        columnNumber: colNum,
        problem: (problem || "Deploy error").trim()
      });
    }
    i++;
  }

  if (failures.length === 0) return null;
  return {
    status: "Failed",
    details: { componentFailures: failures },
    numberComponentErrors: failures.length
  };
}

/** Map metadata type + component name to glob patterns (first match wins). */
function getGlobPatternsForComponent(componentType: string, componentName: string): string[] {
  switch (componentType) {
    case "ApexClass":
      return [`**/${componentName}.cls`];
    case "ApexTrigger":
      return [`**/${componentName}.trigger`];
    case "ApexPage":
    case "VisualforcePage":
      return [`**/${componentName}.page`];
    case "ApexComponent":
    case "VisualforceComponent":
      return [`**/${componentName}.component`];
    case "LightningComponentBundle":
      return [`**/lwc/${componentName}/${componentName}.js`, `**/lwc/${componentName}.js`, `**/${componentName}.js`];
    case "Flow":
      return [`**/flows/${componentName}.flow-meta.xml`, `**/${componentName}.flow-meta.xml`];
    case "CustomObject":
      return [`**/objects/${componentName}.object-meta.xml`, `**/${componentName}.object-meta.xml`];
    case "CustomLabel":
    case "Labels":
      return [`**/labels/${componentName}.labels-meta.xml`, `**/${componentName}.labels-meta.xml`];
    default:
      return [`**/${componentName}.cls`, `**/${componentName}.xml`, `**/${componentName}.js`];
  }
}

/** Directories to skip when resolving component paths (avoids slow scans over node_modules, .git, etc.). */
const GLOB_IGNORE = ["**/node_modules/**", "**/bin/**", "**/.git/**"];

/**
 * Run a glob pattern only under sfdx-project.json package directories. Returns first match as full path, or null.
 * If no package dirs are defined, falls back to workspace root.
 */
function globFirstInPackageDirs(workspaceRoot: string, pattern: string): string | null {
  const packageDirs = getPackageDirectories(workspaceRoot);
  const searchRoots = packageDirs.length > 0 ? packageDirs : [""];
  for (const dir of searchRoots) {
    const cwd = dir ? path.join(workspaceRoot, dir) : workspaceRoot;
    const matches = glob.sync(pattern, { cwd, nodir: true, ignore: GLOB_IGNORE });
    if (matches.length > 0) {
      return path.join(cwd, matches[0]);
    }
  }
  return null;
}

/** Resolve Type + Name from CLI table to a full file path under workspaceRoot, or null if not found. */
function resolveComponentToFilePath(
  workspaceRoot: string,
  componentType: string,
  componentName: string
): string | null {
  const patterns = getGlobPatternsForComponent(componentType, componentName.trim());
  for (const pattern of patterns) {
    const fullPath = globFirstInPackageDirs(workspaceRoot, pattern);
    if (fullPath) return fullPath;
  }
  return null;
}

/** Resolve API fileName (e.g. "classes/MyClass.cls") or componentType+fullName to a full path under workspaceRoot so diagnostics open the correct file. */
function resolveApiFileNameToPath(
  workspaceRoot: string,
  fileName: string,
  componentType?: string,
  fullName?: string
): string | null {
  const normalized = fileName.replace(/\\/g, "/").trim();
  // When no fileName (e.g. from CLI table), resolve by component type + name so clicking the error opens the file
  if (!normalized) {
    if (componentType && fullName) {
      return resolveComponentToFilePath(workspaceRoot, componentType, fullName.trim());
    }
    return null;
  }
  // Try direct path first (e.g. force-app/main/default/classes/MyClass.cls or classes/MyClass.cls)
  const directPath = globFirstInPackageDirs(workspaceRoot, `**/${path.basename(normalized)}`);
  if (directPath) return directPath;
  const baseName = path.basename(normalized, path.extname(normalized));
  if (componentType && fullName) {
    const byType = resolveComponentToFilePath(workspaceRoot, componentType, fullName);
    if (byType) return byType;
  }
  // Fallback: any file with that base name
  return globFirstInPackageDirs(workspaceRoot, `**/${baseName}.*`);
}

/**
 * Set deploy diagnostics from Metadata API deploy result (details.componentFailures).
 * Logs the formatted result to Output unless options.skipLog is true (e.g. caller already logged it).
 */
export function setDeployDiagnosticsFromApiResult(
  workspaceRoot: string,
  apiResult: ApiDeployResult,
  options?: { skipLog?: boolean }
): void {
  if (!options?.skipLog) {
    DeployLog.line(formatApiDeployResultForLog(apiResult));
  }
  const collection = getDeployDiagnosticCollection();
  collection.clear();
  const failures = getComponentFailuresList(apiResult);
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const f of failures) {
    const fileName = f.fileName || "";
    const lineNum = typeof f.lineNumber === "number" ? f.lineNumber : parseInt(String(f.lineNumber || "0"), 10);
    const colNum = typeof f.columnNumber === "number" ? f.columnNumber : undefined;
    const message = (f.problem || "Deploy error").slice(0, 500);
    const filePath = resolveApiFileNameToPath(workspaceRoot, fileName, f.componentType, f.fullName);
    if (!filePath) continue;
    const range = new vscode.Range(
      Math.max(0, lineNum - 1),
      Math.max(0, (colNum ?? 1) - 1),
      Math.max(0, lineNum - 1),
      Math.max(0, (colNum ?? 1) - 1)
    );
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = DEPLOY_DIAGNOSTIC_SOURCE;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath)!.push(diagnostic);
  }
  byFile.forEach((diagnostics, fsPath) => {
    collection.set(vscode.Uri.file(fsPath), diagnostics);
  });
  if (failures.length > 0 && byFile.size === 0) {
    // Could not resolve any file paths; show fallback
    const messages = failures.map((f) => (f.problem || "Deploy error").slice(0, 500));
    collection.set(
      DEPLOY_ERRORS_URI,
      messages.map((msg) => {
        const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), msg, vscode.DiagnosticSeverity.Error);
        d.source = DEPLOY_DIAGNOSTIC_SOURCE;
        return d;
      })
    );
  } else if (failures.length === 0) {
    // API returned Failed but no componentFailures; show at least one diagnostic so Problems shows something
    const message = apiResult.stateDetail?.trim() || "Deploy failed. See Output (Adure SFX Toolkit) for details.";
    const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error);
    d.source = DEPLOY_DIAGNOSTIC_SOURCE;
    collection.set(DEPLOY_ERRORS_URI, [d]);
  }
}

import { cleanDeployOutput } from "../commands/devCommands";
/**
 * Set deploy diagnostics from deploy failure.
 * Uses only the sf command output: trims to the last status (no API, no auth). Parses the Component Failures table from CLI output if present and sets diagnostics.
 */
export async function setDeployDiagnosticsFromFailure(
  workspaceRoot: string,
  errorOutput: string,
  _targetOrg?: string | null
): Promise<void> {
  const trimres = cleanDeployOutput(errorOutput);
  const parsedResult = parseDeployResultFromCliOutput(trimres);
  if (parsedResult && getComponentFailuresList(parsedResult).length > 0) {
    DeployLog.line(formatApiDeployResultForLog(parsedResult, "Deploy result (from CLI output):"));
    setDeployDiagnosticsFromApiResult(workspaceRoot, parsedResult, { skipLog: true });
    return;
  }

  setDeployDiagnosticsFromOutput(workspaceRoot, errorOutput);
}

/**
 * Set deploy diagnostics when no API result is available (e.g. no target org or API failed).
 * Does not parse CLI output; logs the failure section to Output and adds a single fallback diagnostic
 * so the user can open the log to see what went wrong.
 */
export function setDeployDiagnosticsFromOutput(workspaceRoot: string, errorOutput: string): void {
  const trimmed = trimToFailureSection(errorOutput);
  DeployLog.line("Deploy failed (no API result). Failure output:\n" + (trimmed || errorOutput));
  const collection = getDeployDiagnosticCollection();
  collection.clear();
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    "Deploy failed. See Output (Adure SFX Toolkit) for details.",
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = DEPLOY_DIAGNOSTIC_SOURCE;
  collection.set(DEPLOY_ERRORS_URI, [diagnostic]);
}
