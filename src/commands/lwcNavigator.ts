import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const LWC_EXTENSIONS = [".js", ".html", ".css", ".js-meta.xml"];

const LABELS: Record<string, string> = {
  ".js": "$(file-code) JavaScript",
  ".html": "$(code) HTML Template",
  ".css": "$(paintcan) CSS Styles",
  ".js-meta.xml": "$(settings-gear) Meta XML"
};

function isInsideLwc(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts.includes("lwc") || parts.includes("aura");
}

function getLwcSiblings(filePath: string): { label: string; filePath: string }[] {
  const dir = path.dirname(filePath);
  const baseName = path.basename(dir);

  const siblings: { label: string; filePath: string }[] = [];

  for (const ext of LWC_EXTENSIONS) {
    const candidate = path.join(dir, baseName + ext);
    if (candidate !== filePath && fs.existsSync(candidate)) {
      const label = LABELS[ext] || path.basename(candidate);
      siblings.push({ label, filePath: candidate });
    }
  }

  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (full === filePath) continue;

      const alreadyListed = siblings.some((s) => s.filePath === full);
      if (alreadyListed) continue;

      if (fs.statSync(full).isFile()) {
        const ext = path.extname(entry);
        if (ext === ".js" && entry !== baseName + ".js") {
          siblings.push({ label: `$(file-code) ${entry}`, filePath: full });
        } else if (ext === ".html" && entry !== baseName + ".html") {
          siblings.push({ label: `$(code) ${entry}`, filePath: full });
        } else if (ext === ".css" && entry !== baseName + ".css") {
          siblings.push({ label: `$(paintcan) ${entry}`, filePath: full });
        } else if (entry.endsWith("-meta.xml") && entry !== baseName + ".js-meta.xml") {
          siblings.push({ label: `$(settings-gear) ${entry}`, filePath: full });
        } else if (ext === ".svg" || ext === ".json") {
          siblings.push({ label: `$(file) ${entry}`, filePath: full });
        }
      }
    }
  } catch {
    // directory read failed
  }

  return siblings;
}

export async function lwcNavigate() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("No active editor.");
    return;
  }

  const filePath = editor.document.uri.fsPath;

  if (!isInsideLwc(filePath)) {
    vscode.window.showInformationMessage("This file is not inside an LWC or Aura component folder.");
    return;
  }

  const siblings = getLwcSiblings(filePath);

  if (siblings.length === 0) {
    vscode.window.showInformationMessage("No sibling component files found.");
    return;
  }

  if (siblings.length === 1) {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(siblings[0].filePath));
    return;
  }

  type SiblingItem = vscode.QuickPickItem & { filePath: string };
  const items: SiblingItem[] = siblings.map((s) => ({
    label: s.label,
    description: path.basename(s.filePath),
    filePath: s.filePath
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Navigate to component file"
  });

  if (picked) {
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(picked.filePath));
  }
}

export async function lwcGoToJs() {
  await lwcGoToExt(".js");
}
export async function lwcGoToHtml() {
  await lwcGoToExt(".html");
}
export async function lwcGoToMeta() {
  await lwcGoToExt(".js-meta.xml");
}
export async function lwcGoToCss() {
  await lwcGoToExt(".css");
}

async function lwcGoToExt(targetExt: string) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const currentUri = editor.document.uri;
  const dir = path.dirname(currentUri.fsPath);
  const baseName = path.basename(dir);
  const targetPath = path.join(dir, baseName + targetExt);

  if (!fs.existsSync(targetPath)) {
    vscode.window.showInformationMessage(`No ${targetExt} file found for this component.`);
    return;
  }

  if (targetPath === currentUri.fsPath) return;

  const targetUri = vscode.Uri.file(targetPath);
  try {
    await vscode.commands.executeCommand("vscode.open", targetUri);
  } catch {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
