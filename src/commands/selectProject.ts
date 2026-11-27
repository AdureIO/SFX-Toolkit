import * as path from "path";
import * as vscode from "vscode";
import { resolveDefaultTargetOrgUsernameSync } from "../utils/defaultOrg";
import { onDidChangeDefaultOrg } from "../utils/defaultOrgEvents";
import { getOrgByTarget, onOrgListUpdated } from "../utils/orgListCache";
import { activeProject, onDidChangeActiveProject, onDidChangeProjects, projects, setActiveProject, SfProject } from "../utils/projectRegistry";

export const SELECT_PROJECT_COMMAND = "adure-sfx-toolkit.selectProject";

/** "alias" (or the username) of a project's default org, or undefined when it has none. */
function defaultOrgLabel(dir: string): string | undefined {
	let raw: string | null = null;
	try {
		raw = resolveDefaultTargetOrgUsernameSync(dir);
	} catch {
		raw = null;
	}
	if (!raw) return undefined;
	return getOrgByTarget(raw)?.alias || raw;
}

const kindLabel = (p: SfProject) => (p.kind === "sfdx" ? "SFDX" : "MDAPI");

/** Quick pick of every discovered project; switches the active project. */
export async function selectProject(): Promise<void> {
	const all = projects();
	if (all.length === 0) {
		void vscode.window.showInformationMessage("No Salesforce project found in this workspace.");
		return;
	}
	const current = activeProject();
	const items = all.map((p) => {
		const rel = path.relative(p.workspaceFolder, p.dir).split(path.sep).join("/") || ".";
		const isCurrent = current?.dir === p.dir;
		return {
			label: `$(folder) ${p.name}`,
			description: `${kindLabel(p)} · ${rel}${isCurrent ? " · active" : ""}`,
			detail: `Default org: ${defaultOrgLabel(p.dir) ?? "none"}`,
			project: p,
		};
	});
	const qp = vscode.window.createQuickPick<(typeof items)[number]>();
	qp.title = "Select Salesforce Project";
	qp.placeholder = "Project the toolkit works on";
	qp.matchOnDescription = true;
	qp.matchOnDetail = true;
	qp.items = items;
	const cur = items.find((i) => i.project.dir === current?.dir);
	if (cur) qp.activeItems = [cur];
	await new Promise<void>((resolve) => {
		qp.onDidAccept(() => {
			const pick = qp.selectedItems[0];
			if (pick) setActiveProject(pick.project.dir);
			qp.hide();
		});
		qp.onDidHide(() => {
			qp.dispose();
			resolve();
		});
		qp.show();
	});
}

/**
 * Status bar item for the active project. Shown only when more than one project exists;
 * clicking it opens the project picker.
 */
export function registerProjectStatusBar(context: vscode.ExtensionContext): () => void {
	// Left of the schema-health item (-110).
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -105);
	item.command = SELECT_PROJECT_COMMAND;
	item.name = "Salesforce Project";

	const render = () => {
		const all = projects();
		const p = activeProject();
		if (all.length < 2 || !p) {
			item.hide();
			return;
		}
		item.text = `$(folder) ${p.name}`;
		const md = new vscode.MarkdownString(`**${p.name}**: ${kindLabel(p)} project\n\nDefault org: ${defaultOrgLabel(p.dir) ?? "none"}\n\nClick to switch project.`);
		item.tooltip = md;
		item.show();
	};

	context.subscriptions.push(
		item,
		onDidChangeProjects(render),
		onDidChangeActiveProject(render),
		onDidChangeDefaultOrg(render),
		new vscode.Disposable(onOrgListUpdated(render))
	);
	render();
	return render;
}
