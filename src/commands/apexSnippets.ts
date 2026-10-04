import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { executeAnonymousApex } from "./executeAnonymous";
import { getCachedOrgList, getOrgListForPicker } from "../utils/orgListCache";
import { Logger } from "../utils/outputChannel";
import { isSalesforceProject } from "../utils/projectUtils";

const SNIPPETS_DIR_NAME = "apex-snippets";
const LEGACY_SNIPPETS_FILE = ".vscode/apex-snippets.json";

export interface ApexSnippet {
  name: string;
  code: string;
  description?: string;
  /** Absolute path of the backing .apex file — the snippet's real identity (display names are lossy). */
  filePath?: string;
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

/** Watch the snippets folder so files created/deleted/saved outside the UI refresh tree + panel. */
export function createSnippetsWatcher(): vscode.Disposable {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return new vscode.Disposable(() => undefined);
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `.vscode/${SNIPPETS_DIR_NAME}/*.apex`)
  );
  const subs = [
    watcher.onDidCreate(notifySnippetsChanged),
    watcher.onDidDelete(notifySnippetsChanged),
    watcher.onDidChange(notifySnippetsChanged)
  ];
  return new vscode.Disposable(() => {
    subs.forEach((d) => d.dispose());
    watcher.dispose();
  });
}

/** Release the module-level emitter/timer (extension deactivate). */
export function disposeSnippetEvents(): void {
  if (snippetsChangedTimer) clearTimeout(snippetsChangedTimer);
  snippetsChangedTimer = undefined;
  snippetsChangedEmitter.dispose();
}

function getSnippetsDir(): string | null {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  return path.join(root, ".vscode", SNIPPETS_DIR_NAME);
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

/** One-time migration from legacy JSON to .apex files. */
async function migrateFromJsonIfNeeded(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  const jsonPath = path.join(root, LEGACY_SNIPPETS_FILE);
  const dir = getSnippetsDir();
  if (!dir || !fs.existsSync(jsonPath)) return;
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

export async function loadSnippets(): Promise<ApexSnippet[]> {
  await migrateFromJsonIfNeeded();
  const dir = getSnippetsDir();
  if (!dir || !fs.existsSync(dir)) return [];

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
        filePath
      });
    } catch {
      // skip unreadable files
    }
  }
  snippets.sort((a, b) => a.name.localeCompare(b.name));
  return snippets;
}

/** Path to the .apex file for a snippet (by display name). Prefer {@link snippetFilePath} for loaded snippets. */
export function getSnippetFilePath(snippetName: string): string | null {
  const dir = getSnippetsDir();
  if (!dir) return null;
  return path.join(dir, nameToFilename(snippetName) + ".apex");
}

/** The snippet's real backing file: its loaded filePath, else derived from its display name (legacy callers). */
export function snippetFilePath(snippet: Pick<ApexSnippet, "name" | "filePath">): string | null {
  return snippet.filePath || getSnippetFilePath(snippet.name || "");
}

/** True when filePath is a .apex file directly inside the snippets folder (guards paths coming from webviews). */
function isInSnippetsDir(filePath: string): boolean {
  const dir = getSnippetsDir();
  if (!dir || !filePath.endsWith(".apex")) return false;
  return path.dirname(path.resolve(filePath)) === path.resolve(dir);
}

/** Read the snippet's current code from disk (falls back to the in-memory code). */
function currentSnippetCode(snippet: { code?: string; name?: string; filePath?: string }): string {
  const filePath = snippet.filePath || getSnippetFilePath(snippet.name || "");
  if (filePath && fs.existsSync(filePath)) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      // keep in-memory snippet code when the file cannot be read
    }
  }
  return snippet.code ?? "";
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
  if (!isSalesforceProject()) {
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

  const name = await vscode.window.showInputBox({
    prompt: "Snippet name (will be the .apex file name)",
    placeHolder: "e.g. Reset Account Flags",
    validateInput: (v) => (v.trim() ? null : "Name is required")
  });
  if (!name) return;

  const dir = getSnippetsDir();
  if (!dir) return;
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
  const dir = getSnippetsDir();
  if (!dir) return;
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

/** Run a specific snippet from the tree sidebar — shows an org selector first. */
export async function runSnippetFromTree(snippet: ApexSnippet): Promise<void> {
  const orgs = getCachedOrgList() ?? (await getOrgListForPicker());

  let targetOrg: string | undefined;
  if (orgs.length === 0) {
    const action = await vscode.window.showWarningMessage(
      "Could not load org list. Run against the default org?",
      "Run",
      "Cancel"
    );
    if (action !== "Run") return;
  } else {
    type OrgPick = vscode.QuickPickItem & { username: string };
    const items: OrgPick[] = orgs.map((o) => ({ label: o.label, username: o.username }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Select target org for "${snippet.name}"`
    });
    if (!picked) return;
    // If user picked the default org option, leave targetOrg undefined (no -o flag)
    targetOrg = picked.label.endsWith("(default)") ? undefined : picked.username;
  }

  const codeToRun = currentSnippetCode(snippet);
  const result = await executeAnonymousApex(codeToRun, { targetOrg });
  if (!result.success) {
    Logger.error(`Snippet "${snippet.name || "unnamed"}" failed`);
  }
}

export async function runSnippet(snippet?: ApexSnippet | { code?: string; name?: string; filePath?: string }): Promise<void> {
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

  const codeToRun = currentSnippetCode(snippet);
  const result = await executeAnonymousApex(codeToRun);
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

/** Delete the snippet stored at filePath (must be inside the snippets folder). Returns true if deleted. */
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
