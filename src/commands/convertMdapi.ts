import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { runCommandArgs } from "../utils/commandRunner";
import { getToolingApiVersion } from "../utils/constants";
import { Logger } from "../utils/outputChannel";
import { reportError } from "../utils/reportError";
import {
	CONVERT_MDAPI_COMMAND,
	MDAPI_PROJECT_MESSAGE,
	isMdapiProject,
	mdapiFolders,
	updateSalesforceProjectContext,
} from "../utils/projectUtils";
import {
	OUTPUT_DIR,
	countComponents,
	describePlan,
	planConversion,
	type SrcChoice,
} from "../utils/convertMdapiPure";

export interface ConvertHooks {
	/** Called after a successful conversion: refresh views, language server, stubs, default org. */
	onConverted(): void;
}

const CONVERT_BUTTON = "Convert to SFDX format…";

/** Hint shown when a source-based command is used in an MDAPI project. */
export async function showConvertHint(): Promise<void> {
	const pick = await vscode.window.showInformationMessage(MDAPI_PROJECT_MESSAGE, CONVERT_BUTTON);
	if (pick === CONVERT_BUTTON) await vscode.commands.executeCommand(CONVERT_MDAPI_COMMAND);
}

async function isGitRepo(dir: string): Promise<boolean> {
	try {
		const out = await runCommandArgs("git", ["rev-parse", "--is-inside-work-tree"], dir, undefined, false);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

function listFilesRel(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else out.push(path.relative(root, full));
		}
	};
	if (fs.existsSync(root)) walk(root);
	return out;
}

async function pickFolder(): Promise<string | undefined> {
	const folders = mdapiFolders();
	if (folders.length === 0) {
		void vscode.window.showInformationMessage("No MDAPI project (src/package.xml) found in this workspace.");
		return undefined;
	}
	if (folders.length === 1) return folders[0];
	const pick = await vscode.window.showQuickPick(
		folders.map((f) => ({ label: path.basename(f), description: f, folder: f })),
		{ placeHolder: "Which MDAPI project do you want to convert?" }
	);
	return pick?.folder;
}

const KEEP = "Convert and keep src";
const MOVE = "Convert and move src to mdapi-src";

export async function convertMdapiProject(hooks: ConvertHooks): Promise<void> {
	if (!isMdapiProject()) {
		void vscode.window.showInformationMessage("Nothing to convert: no MDAPI project (src/package.xml) is open.");
		return;
	}
	const folder = await pickFolder();
	if (!folder) return;

	const repo = await isGitRepo(folder);
	let packageXml: string | undefined;
	try {
		packageXml = fs.readFileSync(path.join(folder, "src", "package.xml"), "utf8");
	} catch {
		packageXml = undefined;
	}
	const gitignorePath = path.join(folder, ".gitignore");
	const plan = planConversion({
		folderName: path.basename(folder),
		packageXml,
		toolingApiVersion: getToolingApiVersion(),
		forceAppExists: fs.existsSync(path.join(folder, OUTPUT_DIR)),
		sfdxProjectExists: fs.existsSync(path.join(folder, "sfdx-project.json")),
		forceignoreExists: fs.existsSync(path.join(folder, ".forceignore")),
		gitignoreContent: fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : undefined,
		isGitRepo: repo,
		manifestPackageExists: fs.existsSync(path.join(folder, "manifest", "package.xml")),
		srcChoice: "keep",
	});
	if (!plan.ok) {
		void vscode.window.showErrorMessage(`Convert to SFDX format: ${plan.reason}`);
		return;
	}

	const steps = describePlan(plan, "keep").slice(0, -1);
	const choice = await vscode.window.showInformationMessage(
		"Convert this MDAPI project to SFDX format?",
		{
			modal: true,
			detail:
				steps.map((s) => `• ${s}`).join("\n") +
				"\n\nsrc/ is never deleted: choose to keep it where it is, or move it to mdapi-src/" +
				(repo ? " with git mv." : "."),
		},
		KEEP,
		MOVE
	);
	if (choice !== KEEP && choice !== MOVE) return;
	const srcChoice: SrcChoice = choice === MOVE ? "move" : "keep";

	// Re-plan with the chosen src handling (git/fs state is unchanged).
	const finalPlan = planConversion({
		folderName: path.basename(folder),
		packageXml,
		toolingApiVersion: getToolingApiVersion(),
		forceAppExists: fs.existsSync(path.join(folder, OUTPUT_DIR)),
		sfdxProjectExists: fs.existsSync(path.join(folder, "sfdx-project.json")),
		forceignoreExists: fs.existsSync(path.join(folder, ".forceignore")),
		gitignoreContent: fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : undefined,
		isGitRepo: repo,
		manifestPackageExists: fs.existsSync(path.join(folder, "manifest", "package.xml")),
		srcChoice,
	});
	if (!finalPlan.ok) {
		void vscode.window.showErrorMessage(`Convert to SFDX format: ${finalPlan.reason}`);
		return;
	}

	const projectJsonPath = path.join(folder, "sfdx-project.json");
	let createdProjectJson = false;
	try {
		fs.writeFileSync(projectJsonPath, finalPlan.sfdxProjectJson, { encoding: "utf8", flag: "wx" });
		createdProjectJson = true;
	} catch (e) {
		reportError({ operation: "Convert to SFDX format", error: e });
		return;
	}

	const converted = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "Converting MDAPI project to SFDX format…", cancellable: true },
		async (_progress, token) => {
			try {
				await runCommandArgs("sf", finalPlan.convertArgs, folder, undefined, true, undefined, token);
				return true;
			} catch (e: any) {
				if (createdProjectJson) {
					try {
						fs.unlinkSync(projectJsonPath);
					} catch (rmErr) {
						Logger.error("Convert MDAPI: could not remove sfdx-project.json after failure", rmErr);
					}
				}
				if (e?.cancelled) {
					void vscode.window.showInformationMessage("Conversion cancelled. No project files were kept.");
				} else {
					reportError({
						operation: "Convert to SFDX format",
						error: e,
						message: `Convert to SFDX format failed. sfdx-project.json was removed; a partial "${OUTPUT_DIR}" folder may remain, remove it before retrying.`,
					});
				}
				return false;
			}
		}
	);
	if (!converted) return;

	const notes: string[] = [];
	try {
		if (finalPlan.copyManifest) {
			fs.mkdirSync(path.join(folder, "manifest"), { recursive: true });
			fs.copyFileSync(path.join(folder, "src", "package.xml"), path.join(folder, "manifest", "package.xml"));
		}
		if (finalPlan.forceignoreContent !== null) {
			fs.writeFileSync(path.join(folder, ".forceignore"), finalPlan.forceignoreContent, { encoding: "utf8", flag: "wx" });
		}
		if (finalPlan.gitignore) {
			fs.writeFileSync(gitignorePath, finalPlan.gitignore.content, "utf8");
		}
	} catch (e) {
		Logger.error("Convert MDAPI: post-conversion file step failed", e);
		notes.push("some helper files could not be written (see output log)");
	}

	if (finalPlan.srcAction !== "none") {
		const from = path.join(folder, "src");
		const to = path.join(folder, finalPlan.movedSrcDir);
		if (fs.existsSync(to)) {
			notes.push(`${finalPlan.movedSrcDir}/ already exists, so src/ was kept`);
		} else {
			let moved = false;
			if (finalPlan.srcAction === "git-mv") {
				try {
					await runCommandArgs("git", ["mv", "src", finalPlan.movedSrcDir], folder, undefined, false);
					moved = true;
				} catch (e) {
					Logger.info(`Convert MDAPI: git mv failed, falling back to rename: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			if (!moved) {
				try {
					fs.renameSync(from, to);
					moved = true;
				} catch (e) {
					Logger.error("Convert MDAPI: moving src failed", e);
					notes.push("src/ could not be moved and was kept");
				}
			}
		}
	}

	updateSalesforceProjectContext();
	hooks.onConverted();

	const count = countComponents(listFilesRel(path.join(folder, OUTPUT_DIR)));
	const suffix = notes.length ? ` Note: ${notes.join("; ")}.` : "";
	const open = await vscode.window.showInformationMessage(
		`Converted ${count} components into ${OUTPUT_DIR}.${suffix}`,
		"Open force-app"
	);
	if (open === "Open force-app") {
		await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(path.join(folder, OUTPUT_DIR)));
	}
}

// ─── MDAPI UX: status bar item + one-time notification ───────────────────────

const NOTICE_KEY_PREFIX = "adure-sfx-toolkit.mdapiNoticeDismissed:";
const sessionDismissed = new Set<string>();

/**
 * Status bar item ("$(info) MDAPI project", click → convert) and the one-per-folder
 * conversion notice. Returns a refresh function to call on workspace-folder changes.
 */
export function registerMdapiUi(context: vscode.ExtensionContext): () => void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	item.text = "$(info) MDAPI project";
	item.tooltip = new vscode.MarkdownString(
		"Legacy Metadata API (MDAPI) project (`src/package.xml`).\n\nOrg features work. Deploy, retrieve, source tracking and local schema need SFDX format: click to convert."
	);
	item.command = CONVERT_MDAPI_COMMAND;
	context.subscriptions.push(item);

	const refresh = () => {
		if (isMdapiProject()) item.show();
		else item.hide();
	};

	const notify = () => {
		if (!isMdapiProject()) return;
		const folder = mdapiFolders()[0];
		if (!folder) return;
		const key = NOTICE_KEY_PREFIX + folder;
		if (context.workspaceState.get<boolean>(key) || sessionDismissed.has(key)) return;
		const CONVERT = "Convert…";
		const NOT_NOW = "Not now";
		const NEVER = "Don't ask again";
		void vscode.window
			.showInformationMessage(
				"MDAPI-format project detected. Convert to SFDX format to unlock deploy, retrieve, source tracking and local schema.",
				CONVERT,
				NOT_NOW,
				NEVER
			)
			.then((pick) => {
				if (pick === CONVERT) void vscode.commands.executeCommand(CONVERT_MDAPI_COMMAND);
				else if (pick === NEVER) void context.workspaceState.update(key, true);
				else sessionDismissed.add(key);
			});
	};

	refresh();
	notify();
	return refresh;
}
