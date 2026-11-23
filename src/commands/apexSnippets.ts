import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { executeAnonymousApex } from "./executeAnonymous";
import { getCachedOrgList, getOrgListForPicker } from "../utils/orgListCache";
import { Logger } from "../utils/outputChannel";
import { isWorkspaceUsable } from "../utils/projectUtils";
import { activeProject, onDidChangeProjects, projects, SfProject } from "../utils/projectRegistry";
import { samePath } from "../utils/projectDiscoveryPure";
import { resolveDefaultTargetOrgUsername } from "../utils/defaultOrg";
import { orgPickerForProject } from "../utils/panelProject";
import {
  ALL_PROJECTS,
  SNIPPETS_REL_DIR,
  SnippetFilter,
  activeFirst,
  addSnippetTarget,
  effectiveFilter,
  legacyMigrationSource,
  showProjectBadge,
  snippetsDirOf
} from "../utils/snippetsPure";

const LEGACY_SNIPPETS_FILE = ".vscode/apex-snippets.json";
/** workspaceState key of the snippet view's project filter ("all" or a project dir). */
export const SNIPPET_FILTER_STATE_KEY = "asfx.snippetFilter";

export interface ApexSnippet {
  name: string;
  code: string;
  /** The project name when more than one project exists (shown as the tree item's description). */
  description?: string;
  /** Absolute path of the backing .apex file — the snippet's real identity (display names are lossy). */
  filePath?: string;
  /** Dir of the project the snippet belongs to (its default org is the snippet's default org). */
  projectDir?: string;
  projectName?: string;
}

// --- Per-project snippet storage + view filter ---

let filterState: vscode.Memento | undefined;

/** Hand the module the workspaceState that persists the view filter (called once by the tree provider). */
export function initSnippetFilterStore(state: vscode.Memento): void {
  filterState = state;
}

/** The project filter of the snippets view: "all" (default) or one project's dir. */
export function getSnippetFilter(): SnippetFilter {
  return effectiveFilter(filterState?.get<string>(SNIPPET_FILTER_STATE_KEY), projects().map((p) => p.dir));
}

export async function setSnippetFilter(filter: SnippetFilter): Promise<void> {
  try {
    await filterState?.update(SNIPPET_FILTER_STATE_KEY, filter);
  } catch {
    /* persistence is best effort */
  }
}

// --- Change notifications (tree view + overview panel both listen) ---

const snippetsChangedEmitter = new vscode.EventEmitter<void>();
/** Fires (debounced) whenever snippets are added/removed/edited via this module or on disk. */
export const onDidChangeSnippets: vscode.Event<void> = snippetsChangedEmitter.event;
let snippetsChangedTimer: ReturnType<typeof setTimeout> | undefined;

/** Signal that the snippet set changed. Debounced so an explicit notify + file-watcher event collapse into one. */
export function notifySnippetsChanged(): void {
  if (snippetsChangedTimer) clearTimeout(snippetsChangedTimer);
  snippetsChangedTimer = setTimeout(() => {
    snippetsChangedTimer = undefined;
    snippetsChangedEmitter.fire();
  }, 100);
}

/**
 * Watch the snippet folders of every project so files created/deleted/saved outside the UI refresh tree + panel.
 * The watchers are recreated (old ones disposed) when workspace folders or the project set change.
 */
export function createSnippetsWatcher(): vscode.Disposable {
  let watchers: vscode.Disposable[] = [];
  const pattern = `**/${SNIPPETS_REL_DIR.split(path.sep).join("/")}/*.apex`;
  const disposeWatchers = () => {
    for (const d of watchers) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    watchers = [];
  };
  const create = () => {
    disposeWatchers();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
      watchers.push(
        watcher,
        watcher.onDidCreate(notifySnippetsChanged),
        watcher.onDidDelete(notifySnippetsChanged),
        watcher.onDidChange(notifySnippetsChanged)
      );
    }
  };
  create();
  const recreate = () => {
    create();
    notifySnippetsChanged(); // a new folder / project may already hold snippets
  };
  const subs = [vscode.workspace.onDidChangeWorkspaceFolders(recreate), onDidChangeProjects(recreate)];
  return new vscode.Disposable(() => {
    subs.forEach((d) => d.dispose());
    disposeWatchers();
  });
}

/** Release the module-level emitter/timer (extension deactivate). */
export function disposeSnippetEvents(): void {
  if (snippetsChangedTimer) clearTimeout(snippetsChangedTimer);
  snippetsChangedTimer = undefined;
  snippetsChangedEmitter.dispose();
}

/** Snippets folder of a project (default: the active project); null with no project. */
function getSnippetsDir(projectDir?: string): string | null {
  const root = projectDir ?? activeProject()?.dir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  return snippetsDirOf(root);
}

/** Sanitize display name to a safe filename stem for NEW files (e.g. "My Snippet" -> "My_Snippet", "v1.2" stays "v1.2"). */
function nameToFilename(name: string): string {
  const stem = name
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-.]/g, "")
    .replace(/^\.+/, "");
  return stem || "Snippet";
}

/** Filename stem to display name (e.g. "My_Snippet" -> "My Snippet"). */
function filenameToName(stem: string): string {
  return stem.replace(/_/g, " ");
}

/** Copy the pre-multi-project snippets of the workspace folder into the project that owns them. The old files stay. */
function migrateFromWorkspaceFolderIfNeeded(project: SfProject): void {
  try {
    const source = legacyMigrationSource({
      workspaceFolder: project.workspaceFolder,
      projectDirs: projects().map((p) => p.dir),
      projectDir: project.dir,
      legacyDirExists: fs.existsSync(snippetsDirOf(project.workspaceFolder)),
      projectDirHasSnippetsDir: fs.existsSync(snippetsDirOf(project.dir))
    });
    if (!source) return;
    const target = snippetsDirOf(project.dir);
    fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(source).filter((n) => n.endsWith(".apex"))) {
      fs.copyFileSync(path.join(source, f), path.join(target, f), fs.constants.COPYFILE_EXCL);
    }
  } catch {
    // ignore migration errors
  }
}

/** One-time migration from legacy JSON to .apex files. */
async function migrateFromJsonIfNeeded(project: SfProject): Promise<void> {
  const jsonPath = path.join(project.dir, LEGACY_SNIPPETS_FILE);
  const dir = snippetsDirOf(project.dir);
  if (!fs.existsSync(jsonPath)) return;
  if (fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith(".apex")).length > 0) return;

  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    if (arr.length === 0) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const s of arr) {
      const name = (s.name || "Untitled").trim();
      const code = (s.code || "").trim() || "System.debug('Hello from snippet');";
      const filePath = path.join(dir, nameToFilename(name) + ".apex");
      fs.writeFileSync(filePath, code, "utf8");
    }
  } catch {
    // ignore migration errors
  }
}

/** The snippets of one project (no badge description). */
async function loadProjectSnippets(project: SfProject): Promise<ApexSnippet[]> {
  migrateFromWorkspaceFolderIfNeeded(project);
  await migrateFromJsonIfNeeded(project);
  const dir = snippetsDirOf(project.dir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".apex"));
  const snippets: ApexSnippet[] = [];
  for (const file of files) {
    const stem = path.basename(file, ".apex");
    if (!stem) continue;
    const filePath = path.join(dir, file);
    try {
      const code = fs.readFileSync(filePath, "utf8");
      snippets.push({
        name: filenameToName(stem),
        code,
        filePath,
        projectDir: project.dir,
        projectName: project.name
      });
    } catch {
      // skip unreadable files
    }
  }
  return snippets;
}

/**
 * The snippets of every project (or of `projectDir` only), by name. With more than one project each
 * snippet's `description` is its project's name (the badge).
 */
export async function loadSnippets(projectDir?: string): Promise<ApexSnippet[]> {
  const all = projects();
  const scope = projectDir ? all.filter((p) => samePath(p.dir, projectDir)) : all;
  const badge = showProjectBadge(all.length);
  const out: ApexSnippet[] = [];
  for (const p of scope) {
    for (const s of await loadProjectSnippets(p)) out.push(badge ? { ...s, description: p.name } : s);
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || (a.projectName ?? "").localeCompare(b.projectName ?? ""));
  return out;
}

/** Path to the .apex file for a snippet (by display name) in a project (default: the active one). Prefer {@link snippetFilePath} for loaded snippets. */
export function getSnippetFilePath(snippetName: string, projectDir?: string): string | null {
  const dir = getSnippetsDir(projectDir);
  if (!dir) return null;
  return path.join(dir, nameToFilename(snippetName) + ".apex");
}

/** The snippet's real backing file: its loaded filePath, else derived from its display name (legacy callers). */
export function snippetFilePath(snippet: Pick<ApexSnippet, "name" | "filePath" | "projectDir">): string | null {
  return snippet.filePath || getSnippetFilePath(snippet.name || "", snippet.projectDir);
}

/** True when filePath is a .apex file directly inside a project's snippets folder (guards paths coming from webviews). */
function isInSnippetsDir(filePath: string): boolean {
  if (!filePath.endsWith(".apex")) return false;
  const parent = path.dirname(path.resolve(filePath));
  return projects().some((p) => path.resolve(snippetsDirOf(p.dir)) === parent);
}

/** Read the snippet's current code from disk (falls back to the in-memory code). */
function currentSnippetCode(snippet: { code?: string; name?: string; filePath?: string; projectDir?: string }): string {
  const filePath = snippet.filePath || getSnippetFilePath(snippet.name || "", snippet.projectDir);
  if (filePath && fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      // keep in-memory snippet code when the file cannot be read
    }
  }
  return snippet.code ?? "";
}

/**
 * Org a snippet runs against by default: its OWN project's default org. Undefined = let the run use the
 * active project's default (the snippet is in the active project). `ok: false` = the snippet's project is
 * not the active one and has no default org (running would silently hit another project's org).
 */
async function snippetDefaultOrg(snippet: { projectDir?: string; projectName?: string }): Promise<{ ok: true; targetOrg?: string } | { ok: false }> {
  if (!snippet.projectDir || samePath(snippet.projectDir, activeProject()?.dir)) return { ok: true };
  const username = await resolveDefaultTargetOrgUsername(snippet.projectDir);
  if (!username) {
    vscode.window.showWarningMessage(
      `Project "${snippet.projectName ?? snippet.projectDir}" has no default org. Set one (or run the snippet with "select org").`
    );
    return { ok: false };
  }
  return { ok: true, targetOrg: username };
}

/** Pick the project for a new snippet / the snippets folder (see addSnippetTarget). */
async function chooseProjectForNew(): Promise<SfProject | undefined> {
  const all = projects();
  const target = addSnippetTarget(getSnippetFilter(), all.map((p) => p.dir));
  if (target.kind === "none") return undefined;
  if (target.kind === "dir") return all.find((p) => samePath(p.dir, target.dir));
  const ordered = activeFirst(all.map((p) => p.dir), activeProject()?.dir);
  type ProjectPick = vscode.QuickPickItem & { project: SfProject };
  const items: ProjectPick[] = ordered.map((dir) => {
    const p = all.find((x) => x.dir === dir) as SfProject;
    return { label: p.name, description: samePath(p.dir, activeProject()?.dir) ? "active project" : undefined, detail: p.dir, project: p };
  });
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Project for the new snippet" });
  return picked?.project;
}

/** Open the .apex file for a snippet in the editor (code completion, Cursor chat). */
export async function openSnippetEditor(snippet: ApexSnippet): Promise<void> {
  const filePath = snippetFilePath(snippet);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, snippet.code || "System.debug('Hello');", "utf8");
    notifySnippetsChanged();
  }
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
}

/** Entry point from Development view: show Run / Add / Edit / Delete. */
export async function showSnippets(): Promise<void> {
  if (!isWorkspaceUsable()) {
    vscode.window.showInformationMessage(
      "Open an SFDX project (folder containing sfdx-project.json) to use Apex Snippets."
    );
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(list-unordered) Open Snippets Overview", description: "Panel with all snippets", id: "panel" },
      { label: "$(play) Run snippet", description: "Execute a saved snippet", id: "run" },
      { label: "$(add) Add snippet", description: "Create new .apex snippet file", id: "add" },
      { label: "$(folder-opened) Open Snippets Folder", description: "Open .vscode/apex-snippets", id: "edit" },
      { label: "$(trash) Delete snippet", description: "Remove a saved snippet", id: "delete" }
    ],
    { placeHolder: "Apex Snippets" }
  );
  if (!choice) return;
  switch (choice.id) {
    case "panel":
      await vscode.commands.executeCommand("adure-sfx-toolkit.openSnippetsPanel");
      break;
    case "run":
      await runSnippet();
      break;
    case "add":
      await addSnippet();
      break;
    case "edit":
      await editSnippetFile();
      break;
    case "delete":
      await deleteSnippet();
      break;
  }
}

export async function addSnippet(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let initialCode = "System.debug('Hello from snippet');";
  if (editor && !editor.selection.isEmpty) {
    initialCode = editor.document.getText(editor.selection);
  }

  const project = await chooseProjectForNew();
  if (!project) return;

  const name = await vscode.window.showInputBox({
    prompt: "Snippet name (will be the .apex file name)",
    placeHolder: "e.g. Reset Account Flags",
    validateInput: (v) => (v.trim() ? null : "Name is required")
  });
  if (!name) return;

  const dir = snippetsDirOf(project.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = nameToFilename(name.trim()) + ".apex";
  const filePath = path.join(dir, fileName);
  if (fs.existsSync(filePath)) {
    vscode.window.showWarningMessage(`Snippet "${name.trim()}" already exists. Open it to edit.`);
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
    return;
  }

  fs.writeFileSync(filePath, initialCode.trim(), "utf8");
  notifySnippetsChanged();
  const doc = await vscode.workspace.openTextDocument(filePath);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    `Snippet "${name.trim()}" created. Edit the .apex file and save; use Run to execute.`
  );
}

/** Open the snippets folder: reveal in Explorer and open first .apex if any. */
export async function editSnippetFile(): Promise<void> {
  const project = await chooseProjectForNew();
  if (!project) return;
  const dir = snippetsDirOf(project.dir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const uri = vscode.Uri.file(dir);
  await vscode.commands.executeCommand("revealInExplorer", uri);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".apex"));
  if (files.length > 0) {
    const first = path.join(dir, files[0]);
    const doc = await vscode.workspace.openTextDocument(first);
    await vscode.window.showTextDocument(doc);
  }
}

/** Run a specific snippet from the tree sidebar — shows an org selector first (its project's default org first). */
export async function runSnippetFromTree(snippet: ApexSnippet): Promise<void> {
  const inActive = !snippet.projectDir || samePath(snippet.projectDir, activeProject()?.dir);
  let orgs: { label: string; username: string }[];
  if (snippet.projectDir && !inActive) {
    orgs = (await orgPickerForProject(snippet.projectDir)).orgs;
  } else {
    orgs = getCachedOrgList() ?? (await getOrgListForPicker());
  }

  let targetOrg: string | undefined;
  if (orgs.length === 0) {
    const action = await vscode.window.showWarningMessage(
      "Could not load org list. Run against the default org?",
      "Run",
      "Cancel"
    );
    if (action !== "Run") return;
    const def = await snippetDefaultOrg(snippet);
    if (!def.ok) return;
    targetOrg = def.targetOrg;
  } else {
    type OrgPick = vscode.QuickPickItem & { username: string };
    const items: OrgPick[] = orgs.map((o) => ({ label: o.label, username: o.username }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Select target org for "${snippet.name}"${snippet.projectName && !inActive ? ` (${snippet.projectName})` : ""}`
    });
    if (!picked) return;
    // The active project's default org: leave targetOrg undefined (no -o flag). Another project's default
    // is passed explicitly, since "no org" would resolve to the active project's.
    targetOrg = picked.label.endsWith("(default)") && inActive ? undefined : picked.username;
  }

  const codeToRun = currentSnippetCode(snippet);
  const result = await executeAnonymousApex(codeToRun, { targetOrg, name: snippet.name });
  if (!result.success) {
    Logger.error(`Snippet "${snippet.name || "unnamed"}" failed`);
  }
}

export async function runSnippet(snippet?: ApexSnippet | { code?: string; name?: string; filePath?: string; projectDir?: string; projectName?: string }): Promise<void> {
  if (!snippet || !snippet.code) {
    const snippets = await loadSnippets();
    if (snippets.length === 0) {
      const action = await vscode.window.showInformationMessage(
        "No snippets configured. Create one?",
        "Create Snippet",
        "Open Snippets Folder"
      );
      if (action === "Create Snippet") await addSnippet();
      else if (action === "Open Snippets Folder") await editSnippetFile();
      return;
    }

    type SnippetPick = vscode.QuickPickItem & { snippet: ApexSnippet };
    const items: SnippetPick[] = snippets.map((s) => ({
      label: `$(play) ${s.name}`,
      description: s.description || "",
      detail: s.code.length > 80 ? s.code.substring(0, 77) + "..." : s.code,
      snippet: s
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select snippet to execute"
    });
    if (!picked) return;
    snippet = picked.snippet;
  }

  // The snippet runs against ITS project's default org.
  const def = await snippetDefaultOrg(snippet);
  if (!def.ok) return;
  const codeToRun = currentSnippetCode(snippet);
  const result = await executeAnonymousApex(codeToRun, { targetOrg: def.targetOrg, name: snippet.name });
  if (!result.success) {
    Logger.error(`Snippet "${snippet.name || "unnamed"}" failed`);
  }
}

/**
 * Delete a snippet. With a target (snippet, or tree item carrying `.snippet`) it deletes that file
 * after confirmation; without one it asks which snippet to delete.
 */
export async function deleteSnippet(target?: ApexSnippet | { snippet?: ApexSnippet }): Promise<void> {
  const given = target && "snippet" in target ? target.snippet : (target as ApexSnippet | undefined);
  let snippet: ApexSnippet | undefined = given && typeof given.name === "string" ? given : undefined;

  if (!snippet) {
    const snippets = await loadSnippets();
    if (snippets.length === 0) {
      vscode.window.showInformationMessage("No snippets to delete.");
      return;
    }

    type PickItem = vscode.QuickPickItem & { snippet: ApexSnippet };
    const picked = await vscode.window.showQuickPick<PickItem>(
      snippets.map((s) => ({ label: s.name, description: s.description || "", snippet: s })),
      { placeHolder: "Select snippet to delete" }
    );
    if (!picked) return;
    snippet = picked.snippet;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete snippet "${snippet.name}"? This removes the .apex file.`,
    "Delete",
    "Cancel"
  );
  if (confirm !== "Delete") return;

  const filePath = snippetFilePath(snippet);
  if (filePath) await deleteSnippetByPath(filePath);
}

/** Delete the snippet stored at filePath (must be inside a project's snippets folder). Returns true if deleted. */
export async function deleteSnippetByPath(filePath: string): Promise<boolean> {
  if (!isInSnippetsDir(filePath) || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  notifySnippetsChanged();
  vscode.window.showInformationMessage(`Snippet "${filenameToName(path.basename(filePath, ".apex"))}" deleted.`);
  return true;
}

/**
 * Delete snippet by index (legacy, for tree/panel callers). Index refers to {@link loadSnippets} order,
 * which can shift between listing and deleting — prefer {@link deleteSnippetByPath}. Returns true if deleted.
 */
export async function deleteSnippetByIndex(index: number): Promise<boolean> {
  const snippets = await loadSnippets();
  if (index < 0 || index >= snippets.length) return false;
  const filePath = snippetFilePath(snippets[index]);
  return filePath ? deleteSnippetByPath(filePath) : false;
}

/** Quick pick for the snippets view's project filter ("All projects" plus each project). */
export async function pickSnippetFilter(): Promise<boolean> {
  const all = projects();
  const current = getSnippetFilter();
  type FilterPick = vscode.QuickPickItem & { filter: SnippetFilter };
  const items: FilterPick[] = [
    { label: "All projects", description: current === ALL_PROJECTS ? "current" : undefined, filter: ALL_PROJECTS },
    ...all.map((p) => ({
      label: p.name,
      description: samePath(p.dir, current) ? "current" : undefined,
      detail: p.dir,
      filter: p.dir
    }))
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Show snippets of…" });
  if (!picked) return false;
  await setSnippetFilter(picked.filter);
  return true;
}
