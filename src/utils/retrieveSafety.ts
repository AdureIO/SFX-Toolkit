/**
 * Overwrite safety for retrieve: a retrieve silently replaces local files, so before it runs
 * we look for unsaved editor edits and uncommitted git changes under the target paths and ask once.
 * Shared by the Org Browser and the right-click retrieve.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "./commandRunner";
import { Logger } from "./outputChannel";
import { affectedFiles, isSameOrUnder, overwriteMessage, parsePorcelain } from "./retrieveSafetyPure";

/** Dirty documents the user agreed to overwrite (fsPaths), reverted by `revertOpenEditors` after the retrieve. */
const pendingRevert = new Set<string>();

function dirtyDocsUnder(paths: string[]): vscode.TextDocument[] {
	return vscode.workspace.textDocuments.filter(
		(d) => d.isDirty && d.uri.scheme === "file" && paths.some((p) => isSameOrUnder(p, d.uri.fsPath))
	);
}

function nearestExistingDir(p: string): string | undefined {
	let cur = path.resolve(p);
	for (let i = 0; i < 64; i++) {
		try {
			if (fs.statSync(cur).isDirectory()) return cur;
		} catch {
			/* keep climbing */
		}
		const parent = path.dirname(cur);
		if (parent === cur) return undefined;
		cur = parent;
	}
	return undefined;
}

/** Absolute paths with uncommitted changes (incl. untracked) under `paths`; [] when not a git repo. */
async function gitDirtyFiles(paths: string[]): Promise<string[]> {
	const cwd = nearestExistingDir(paths[0]);
	if (!cwd) return [];
	let root: string;
	try {
		root = (await runCommandArgs("git", ["-C", cwd, "rev-parse", "--show-toplevel"], cwd, undefined, false)).trim();
	} catch {
		return []; // not a git repository (or git missing): only dirty editors are checked
	}
	if (!root) return [];
	try {
		const out = await runCommandArgs(
			"git",
			["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=all", "--", ...paths],
			root,
			undefined,
			false
		);
		return parsePorcelain(out).map((rel) => path.join(root, rel));
	} catch (e: any) {
		Logger.info(`retrieveSafety: git status failed (${e?.message ?? e}); checking editors only`);
		return [];
	}
}

/**
 * Resolves true without prompting when no path in `paths` (files, or files under folders) has
 * unsaved edits in an open editor or uncommitted git changes. Otherwise shows ONE modal listing the
 * affected files; resolves true only on "Overwrite". Dirty editors the user agrees to overwrite are
 * remembered — call `revertOpenEditors(paths)` after the retrieve so they reload from disk.
 */
export async function confirmOverwrite(paths: string[], what: string): Promise<boolean> {
	const targets = paths.filter(Boolean);
	if (targets.length === 0) return true;
	const dirtyDocs = dirtyDocsUnder(targets);
	const gitDirty = await gitDirtyFiles(targets);
	const files = affectedFiles(targets, [...dirtyDocs.map((d) => d.uri.fsPath), ...gitDirty]);
	if (files.length === 0) return true;
	const choice = await vscode.window.showWarningMessage(overwriteMessage(what, files), { modal: true }, "Overwrite");
	if (choice !== "Overwrite") return false;
	for (const d of dirtyDocs) pendingRevert.add(d.uri.fsPath);
	return true;
}

/**
 * Revert open editors under `paths` that still hold unsaved edits, so they show the retrieved
 * content instead of a stale buffer. Only documents the user agreed to overwrite in
 * `confirmOverwrite` (or, when none were recorded, any dirty one under `paths`) are touched.
 */
export async function revertOpenEditors(paths: string[]): Promise<void> {
	const docs = dirtyDocsUnder(paths).filter((d) => pendingRevert.size === 0 || pendingRevert.has(d.uri.fsPath));
	const previous = vscode.window.activeTextEditor;
	for (const d of docs) {
		try {
			await vscode.window.showTextDocument(d, { preview: false, preserveFocus: false });
			await vscode.commands.executeCommand("workbench.action.files.revert");
		} catch (e: any) {
			Logger.info(`retrieveSafety: could not revert ${d.uri.fsPath}: ${e?.message ?? e}`);
		}
	}
	for (const d of docs) pendingRevert.delete(d.uri.fsPath);
	if (docs.length > 0 && previous && !previous.document.isClosed) {
		try {
			await vscode.window.showTextDocument(previous.document, { viewColumn: previous.viewColumn, preview: false });
		} catch {
			/* best effort */
		}
	}
}
