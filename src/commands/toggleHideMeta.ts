import * as vscode from "vscode";

/** Apex class/trigger sidecar metadata files. */
const PATTERNS = ["**/*.cls-meta.xml", "**/*.trigger-meta.xml"];

/**
 * Toggle hiding Apex `.cls-meta.xml` / `.trigger-meta.xml` files in the Explorer by
 * flipping `files.exclude`. Only the workspace-level value is edited (via `inspect`),
 * so the merged defaults aren't copied into settings and other excludes are preserved.
 */
export async function toggleHideMetaXml(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const inspected = config.inspect<Record<string, boolean>>("files.exclude");
  const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
  const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;

  const existing = (hasWorkspace ? inspected?.workspaceValue : inspected?.globalValue) ?? {};
  const next: Record<string, boolean> = { ...existing };
  const currentlyHidden = PATTERNS.every((p) => next[p] === true);

  if (currentlyHidden) {
    for (const p of PATTERNS) delete next[p];
  } else {
    for (const p of PATTERNS) next[p] = true;
  }

  await config.update("files.exclude", next, target);
  vscode.window.setStatusBarMessage(
    currentlyHidden ? "Apex -meta.xml files shown" : "Apex -meta.xml files hidden",
    2000
  );
}
