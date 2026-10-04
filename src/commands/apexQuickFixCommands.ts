/**
 * Host-side commands invoked by ASFX language-server quick fixes (server/src/codeActions.ts)
 * when the client can't apply the change as a WorkspaceEdit itself.
 *
 *   adure-sfx-toolkit.apex.createFieldStub  { path, content } → write a new
 *     `<Field>.field-meta.xml` (never overwrites) inside the workspace and open it.
 *
 * Internal commands: invoked from code actions only, not contributed to the palette.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export const CMD_CREATE_FIELD_STUB = "adure-sfx-toolkit.apex.createFieldStub";

function insideWorkspace(file: string): boolean {
	return (vscode.workspace.workspaceFolders ?? []).some((f) => {
		const rel = path.relative(f.uri.fsPath, file);
		return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

export function registerApexQuickFixCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(CMD_CREATE_FIELD_STUB, async (args?: { path?: string; content?: string }) => {
			const file = args?.path;
			const content = args?.content;
			if (typeof file !== "string" || typeof content !== "string" || !file.endsWith(".field-meta.xml") || !insideWorkspace(file)) {
				void vscode.window.showErrorMessage("ASFX: invalid field stub request.");
				return;
			}
			if (fs.existsSync(file)) {
				void vscode.window.showInformationMessage(`${path.basename(file)} already exists.`);
			} else {
				await fs.promises.mkdir(path.dirname(file), { recursive: true });
				await fs.promises.writeFile(file, content, { encoding: "utf8", flag: "wx" });
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file));
		}),
	);
}
