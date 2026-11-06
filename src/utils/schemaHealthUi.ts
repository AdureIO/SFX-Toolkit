/**
 * UI for schema health: ONE status bar item that describes the project of the active editor
 * (primary project as fallback) — no default org, invalid/expired connection, or unreachable
 * org — with a click-through quick pick holding the one-click fix. Popups are throttled to
 * one per org + state per session (schemaHealth.shouldNotify); the item stays until resolved.
 */
import * as vscode from "vscode";
import {
	describeHealth,
	getSchemaProblem,
	healthActions,
	healthStateOfKind,
	NO_ORG_KEY,
	onDefaultOrgChangedHealth,
	selectActiveProject,
	setSchemaHealthSink,
	shouldNotify,
	HealthDisplay,
} from "./schemaHealth";
import { outputChannel } from "./outputChannel";
import { canonicalOrgKey } from "./orgKey";
import { getOrgByTarget, onOrgListUpdated } from "./orgListCache";
import { primaryProjectRoot, isSalesforceProject } from "./projectUtils";
import { onDidChangeDefaultOrg, onDidChangeProjectDefaultOrg } from "./defaultOrgEvents";
import { checkExpiredScratch, checkNoDefaultOrg, knownProjectDirs, noteProjectDir, noteProjectOfFile } from "./schemaHealthMonitor";
import { chooseDefaultOrg, reauthenticateOrg } from "../commands/orgCommands";

export const SCHEMA_HEALTH_ACTIONS_COMMAND = "adure-sfx-toolkit.schemaHealthActions";

interface Shown {
	orgKey: string;
	projectDir: string | undefined;
	display: HealthDisplay;
	label: string;
}

export function registerSchemaHealthUi(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -110);
	item.command = SCHEMA_HEALTH_ACTIONS_COMMAND;
	/** org|state pairs the user dismissed from the status bar (until the state changes). */
	const dismissed = new Set<string>();
	let shown: Shown | undefined;

	const labelOf = (orgKey: string): string => {
		if (orgKey === NO_ORG_KEY) return NO_ORG_KEY;
		const rec = getOrgByTarget(orgKey);
		return rec?.alias || orgKey;
	};

	const activeProject = (): string | undefined => {
		const ed = vscode.window.activeTextEditor;
		const file = ed && ed.document.uri.scheme === "file" ? ed.document.uri.fsPath : undefined;
		if (file) noteProjectOfFile(file);
		return selectActiveProject(file, knownProjectDirs(), primaryProjectRoot());
	};

	const render = () => {
		let next: Shown | undefined;
		try {
			const projectDir = activeProject();
			const orgKey = canonicalOrgKey(null, projectDir);
			const label = labelOf(orgKey);
			const display = describeHealth(getSchemaProblem(orgKey), label);
			if (display && !dismissed.has(`${orgKey}|${display.state}`)) next = { orgKey, projectDir, display, label };
		} catch {
			next = undefined;
		}
		shown = next;
		if (!next) {
			item.hide();
			return;
		}
		item.text = next.display.text;
		item.tooltip = next.display.tooltip;
		item.backgroundColor =
			next.display.state === "authInvalid"
				? new vscode.ThemeColor("statusBarItem.errorBackground")
				: next.display.state === "noDefaultOrg"
					? new vscode.ThemeColor("statusBarItem.warningBackground")
					: undefined;
		item.command = next.display.state === "unreachable" ? "adure-sfx-toolkit.showOutput" : SCHEMA_HEALTH_ACTIONS_COMMAND;
		item.show();
	};

	/** Re-run the proactive checks (activation, default-org change, workspace change). */
	const recheck = async () => {
		try {
			if (!isSalesforceProject()) {
				render();
				return;
			}
			await checkNoDefaultOrg();
			checkExpiredScratch();
		} catch (e: any) {
			outputChannel.appendLine(`schemaHealth: check failed: ${e?.message ?? e}`);
		}
		render();
	};

	const onDefaultChanged = () => {
		for (const k of [...dismissed]) if (k.startsWith(`${NO_ORG_KEY}|`)) dismissed.delete(k);
		onDefaultOrgChangedHealth();
		void recheck();
	};

	setSchemaHealthSink({
		onProblem(orgKey, kind, message) {
			outputChannel.appendLine(message);
			const state = healthStateOfKind(kind, orgKey);
			if (shouldNotify(orgKey, state)) {
				void vscode.window.showWarningMessage(message, "Fix…").then((pick) => {
					if (pick) void vscode.commands.executeCommand(SCHEMA_HEALTH_ACTIONS_COMMAND);
				});
			}
			render();
		},
		onRecovered() {
			render();
		},
		onChange: render,
	});

	const actionsCommand = vscode.commands.registerCommand(SCHEMA_HEALTH_ACTIONS_COMMAND, async () => {
		render();
		const cur = shown;
		if (!cur) {
			void vscode.window.showInformationMessage("ASFX: no schema problems for this project.");
			return;
		}
		const commands = await vscode.commands.getCommands(true);
		const actions = healthActions(cur.display, commands.includes("adure-sfx-toolkit.createScratch"));
		const pick = await vscode.window.showQuickPick(
			actions.map((a) => ({ label: a.label, id: a.id })),
			{ placeHolder: cur.display.tooltip }
		);
		switch (pick?.id) {
			case "setDefaultOrg":
			case "chooseOrg":
				await chooseDefaultOrg(cur.projectDir);
				break;
			case "createScratch":
				await vscode.commands.executeCommand("adure-sfx-toolkit.createScratch");
				break;
			case "reauth":
				await reauthenticateOrg(cur.orgKey);
				break;
			case "showDetails":
				await vscode.commands.executeCommand("adure-sfx-toolkit.showOutput");
				break;
			case "dismiss":
				dismissed.add(`${cur.orgKey}|${cur.display.state}`);
				render();
				break;
		}
	});

	context.subscriptions.push(
		item,
		actionsCommand,
		new vscode.Disposable(() => setSchemaHealthSink(undefined)),
		onDidChangeDefaultOrg(onDefaultChanged),
		onDidChangeProjectDefaultOrg((dir) => {
			noteProjectDir(dir);
			onDefaultChanged();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => render()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void recheck()),
		new vscode.Disposable(onOrgListUpdated(() => {
			checkExpiredScratch();
			render();
		}))
	);

	// Activation: look for nested projects once, then check every project's default org.
	void (async () => {
		try {
			const found = await vscode.workspace.findFiles("**/sfdx-project.json", "**/node_modules/**", 50);
			for (const u of found) noteProjectDir(vscode.Uri.joinPath(u, "..").fsPath);
		} catch {
			/* discovery is best effort */
		}
		await recheck();
	})();
}
