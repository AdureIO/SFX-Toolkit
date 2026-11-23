/**
 * Project selector binding of a webview panel/view. See docs/multi-project-design.md ("Views and panels").
 *
 * The panel follows the active project until the user picks another project in its selector.
 * `attach(webview)` wires the selector UI (panelProjectUi.ts) without the panel's own
 * message handler having to know about it; the panel subscribes to `onDidChange` and
 * reloads its project-bound data from `current()`.
 */
import * as vscode from "vscode";
import { getDefaultOrgSync, resolveDefaultTargetOrgUsername } from "./defaultOrg";
import { OrgOption, getOrgByTarget, getOrgListForPicker } from "./orgListCache";
import {
	PanelProjectOption,
	buildOptions,
	pinAfterPick,
	reconcilePin,
	resolveCurrentDir,
	selectorVisible,
} from "./panelProjectPure";
import { samePath } from "./projectDiscoveryPure";
import { projects, activeProject, onDidChangeActiveProject, onDidChangeProjects, SfProject } from "./projectRegistry";

export type { PanelProjectOption } from "./panelProjectPure";

function orgLabel(dir: string): string {
	try {
		return getDefaultOrgSync(dir)?.displayName ?? "";
	} catch {
		return "";
	}
}

export class PanelProjectBinding implements vscode.Disposable {
	private pinnedDir: string | undefined;
	private readonly emitter = new vscode.EventEmitter<SfProject | undefined>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly webviews = new Set<vscode.Webview>();
	/** Fires when current() changed: the panel's own pick, or an active-project change while not pinned. */
	readonly onDidChange: vscode.Event<SfProject | undefined> = this.emitter.event;

	constructor() {
		this.disposables.push(
			this.emitter,
			onDidChangeActiveProject(() => {
				this.postOptions();
				// Pinned: the panel stays, only the "active" marker moves.
				if (!this.pinnedDir) this.emitter.fire(this.currentProject());
			}),
			onDidChangeProjects(() => {
				const before = this.current();
				this.pinnedDir = reconcilePin(projects(), this.pinnedDir);
				this.postOptions();
				if (!samePath(before, this.current())) this.emitter.fire(this.currentProject());
			})
		);
	}

	/** Dir of the project the panel shows, or undefined when there is none. */
	current(): string | undefined {
		return resolveCurrentDir(projects(), activeProject()?.dir, this.pinnedDir);
	}

	currentProject(): SfProject | undefined {
		const dir = this.current();
		return dir ? projects().find((p) => samePath(p.dir, dir)) : undefined;
	}

	/** True while the user has picked a project other than the active one. */
	get pinned(): boolean {
		return this.pinnedDir !== undefined;
	}

	/** The selector is shown (more than one project). */
	get visible(): boolean {
		return selectorVisible(projects().length);
	}

	options(): PanelProjectOption[] {
		return buildOptions(projects(), activeProject()?.dir, orgLabel);
	}

	/** The panel's own pick. Picking the active project unpins (the panel follows again). */
	pick(dir: string): void {
		if (!projects().some((p) => samePath(p.dir, dir))) return;
		const before = this.current();
		this.pinnedDir = pinAfterPick(activeProject()?.dir, dir);
		this.postOptions();
		if (!samePath(before, this.current())) this.emitter.fire(this.currentProject());
	}

	/**
	 * Org picker list for the selected project (its default org first, labelled "(default)").
	 * Panels whose "(default)" entry means "no org given" (workbench, SOQL builder) would resolve that to the
	 * ACTIVE project's default. While the panel is pinned to another project the default is therefore
	 * relabelled "(project default)": those panels then treat it as an explicit org.
	 */
	async orgList(): Promise<OrgOption[]> {
		const dir = this.current();
		if (!dir) return [];
		const { orgs } = await orgPickerForProject(dir);
		return this.pinned ? orgs.map((o) => ({ ...o, label: o.label.replace(" (default)", " (project default)") })) : orgs;
	}

	/** Connect a webview that hosts the selector UI. */
	attach(webview: vscode.Webview): vscode.Disposable {
		this.webviews.add(webview);
		const sub = webview.onDidReceiveMessage((m: { type?: string; dir?: string } | undefined) => {
			if (m?.type === "asfxProjectReady") this.post(webview);
			else if (m?.type === "selectProject" && typeof m.dir === "string") this.pick(m.dir);
		});
		return new vscode.Disposable(() => {
			this.webviews.delete(webview);
			sub.dispose();
		});
	}

	private post(webview: vscode.Webview): void {
		void Promise.resolve(
			webview.postMessage({
				type: "projectOptions",
				visible: this.visible,
				current: this.current(),
				options: this.options(),
			})
		).then(undefined, () => undefined);
	}

	private postOptions(): void {
		for (const w of this.webviews) this.post(w);
	}

	dispose(): void {
		this.webviews.clear();
		for (const d of this.disposables) d.dispose();
		this.disposables.length = 0;
	}
}

/**
 * Org picker list for a project: every authenticated org, with that PROJECT's default org first
 * and labelled "(default)". (The cached `sf org list` flags the default of the active project only.)
 * `defaultOrg` is the project default's username, "" when the project has none.
 */
export async function orgPickerForProject(projectDir: string): Promise<{ orgs: OrgOption[]; defaultOrg: string }> {
	let list: OrgOption[] = [];
	try {
		list = await getOrgListForPicker();
	} catch {
		list = [];
	}
	let def: string | null = null;
	try {
		def = await resolveDefaultTargetOrgUsername(projectDir);
	} catch {
		def = null;
	}
	const defUsername = def ? (getOrgByTarget(def)?.username ?? def) : "";
	const orgs = list.map((o) => ({
		label: o.label.replace(/ \(default\)$/, "") + (o.username === defUsername ? " (default)" : ""),
		username: o.username,
	}));
	orgs.sort((a, b) => (b.username === defUsername ? 1 : 0) - (a.username === defUsername ? 1 : 0));
	return { orgs, defaultOrg: orgs.some((o) => o.username === defUsername) ? defUsername : "" };
}
