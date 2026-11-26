import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
	DEPLOY_TYPE_NO_TESTS,
	DEPLOY_TYPE_RUN_ALL,
	DEPLOY_TYPE_RUN_RELEVANT,
	DEPLOY_TYPE_SPECIFIED,
	getTestClassItems,
} from "../commands/deployMetadata";
import { compareTargetsFor, localFilesOf } from "../utils/compareTargetsHost";
import { LocalInfoMap } from "../utils/compareStatusPure";
import { CompareLease, acquireCompare, compareMode } from "../utils/contentCompareHost";
import { onDidChangeDefaultOrg } from "../utils/defaultOrgEvents";
import { getDefaultOrgSync } from "../utils/defaultOrg";
import { deleteFromOrg } from "../utils/deleteFromOrg";
import { withSyntheticTestFailures } from "../utils/deployDiagnostics";
import { deployLabel, reportDeployOutcome, runDeploy, validateDeployInput } from "../utils/deployFlow";
import { deployPathsForComponents, pathsToComponents, relativeFilesOf, RelComponent } from "../utils/deployComponentsPure";
import { DeployOrgStatus } from "../utils/deployOrgStatus";
import { orgLookupKey, preDeployPrompt } from "../utils/deployStatusPure";
import { confirmationMatches, deleteListing } from "../utils/destructivePure";
import { getToolingApiVersion } from "../utils/constants";
import { getNonce } from "../utils/htmlUtils";
import { HistoryEntry, cleanLabel, historyErrorsFromDeploy } from "../utils/historyPure";
import { COLUMNS_STORE_KEY, normalizeLayout } from "../utils/syncCenterColumnsPure";
import { checkDeleteTestOptions } from "../utils/deployTestArgsPure";
import { readLocalInfo } from "../utils/localChangeInfo";
import { openOrgPath } from "../utils/openOrgPath";
import { resolveCurrentUser } from "../utils/orgBrowser/currentUser";
import { LocalEntry, LocalIndex, OBJECT_CHILD_TYPES, overwriteTargets, partialObjectKeys, readPackageDirectories } from "../utils/orgBrowser/localIndex";
import { listFailureView, runListing } from "../utils/orgBrowser/listingRunner";
import { ListCancelled, expandOnlyTypes, loadListingCache, saveListingCache } from "../utils/orgBrowser/metadataLister";
import { hiddenSelectionPrompt, splitByVisibility } from "../utils/orgBrowser/selection";
import { setupTarget } from "../utils/orgBrowser/setupUrl";
import { makeSoapCall } from "../utils/orgBrowser/soapTransport";
import { Comp, ListFailure, TypeInfo, compKey } from "../utils/orgBrowser/types";
import { Logger } from "../utils/outputChannel";
import { DEFAULT_ORG_KEY, canonicalOrgKey, orgArgForKey } from "../utils/orgKey";
import { checkOrgForDestructive, confirmProductionOrgOperation } from "../utils/orgSafety";
import { getOrgByTarget, onOrgListUpdated } from "../utils/orgListCache";
import { PanelProjectBinding, orgPickerForProject } from "../utils/panelProject";
import { projectSelectorScript } from "../utils/panelProjectUi";
import { checkOrgBeforeDeploy } from "../utils/preDeployCheck";
import { loadTestSuites } from "../utils/testSuites";
import { resolveRunTests } from "../utils/testSuitesPure";
import { handleSuiteMessage, subscribeSuites } from "./testSuitesHost";
import { DeployPreset, DeployTypeKey, listPresets, onDidChangePresets, savePreset } from "../utils/presetsStore";
import { addDeployHistoryEntry } from "../commands/deployHistory";
import { toWebPreset } from "../utils/presetsWebPure";
import { isSalesforceProject, primaryProjectRoot } from "../utils/projectUtils";
import { runRetrieveFlow } from "../utils/retrieveFlow";
import { getRetrieveTimes, recordDeployed } from "../utils/retrieveLog";
import { SharedMetadataFilter } from "../utils/sharedFilterState";
import { getHistory, onDidChangeHistory, recordHistory } from "../utils/syncHistory";
import { openComponentDiff } from "../utils/syncDiff";
import { deploymentSetupPath, historyDeployLocalKeys, onlyOrgRefs, overwriteLocalKeys, refOfKey, rowKeyOf } from "../utils/syncCenterUiPure";
import { reauthenticateOrg } from "../commands/orgCommands";
import { runGitStatusSfdxPaths } from "../utils/gitStatusPaths";
import { OperationPanelProvider } from "./OperationPanelProvider";
import { syncCenterHtml } from "./syncCenterHtml";
import { OpHandle, OpenTimings, SyncCenterActivity, mergeTokens } from "./syncCenterActivityHost";
import { peekLocalIndex, peekLocalInfo, scanProjectCached } from "../utils/projectScanCache";

const UI_STATE_KEY = "adure-sfx-toolkit.syncCenter.ui";
const CHUNK = 4000;

export interface SyncCenterOpenOptions {
	/** Project to show (alias of a registered project's dir); default: the active project. */
	projectDir?: string;
	/** Org (alias or username) to show; default: the project's default org. */
	org?: string | null;
	/** Components to select (`Type:name` in either naming). */
	selection?: string[];
	/** Absolute paths (files or folders) whose components are selected once the project is read; the filter is adjusted so they show. */
	paths?: string[];
	/** A stored preset or a deploy-history entry to apply (selection, test level, validate only, tests) once the project is read. */
	preset?: DeployPreset & { validateOnly?: boolean };
}

type Busy = "deploy" | "retrieve" | "delete";

/**
 * Deploy & Retrieve Metadata: the union of the local project and the org's metadata with one selection, smart
 * quick actions, per-row diff, deploy, retrieve, delete from the org, history and presets. Singleton webview
 * panel; the rows are built in the webview from what this class feeds it (the org listing, the local index, the
 * compare results). The engine rules live in utils/syncCenterPure.ts and utils/syncCenterUiPure.ts.
 */
export class SyncCenterPanelProvider {
	public static readonly viewType = "adure-sfx-toolkit.syncCenter";

	private static ctx: vscode.ExtensionContext | undefined;
	private static panel: vscode.WebviewPanel | undefined;
	private static disposables: vscode.Disposable[] = [];
	private static watchers: vscode.Disposable[] = [];
	private static watchTimer: ReturnType<typeof setTimeout> | undefined;

	/** Bumped on every org switch: late results of a previous org are dropped. */
	private static gen = 0;
	private static run: { cancelled: boolean } | undefined;
	private static userPicked = false;

	private static orgKey = DEFAULT_ORG_KEY;
	private static orgArg: string | null = null;
	private static comps: Comp[] = [];
	private static compMap = new Map<string, Comp>();
	private static types: TypeInfo[] = [];
	private static failures: ListFailure[] = [];
	private static listedAt = 0;
	private static typeListedAt: Record<string, number> = {};
	private static local: LocalIndex | undefined;
	/** Local entries by the key the org listing uses (`Type:Name`, name percent-decoded). */
	private static byOrgKey = new Map<string, LocalEntry>();
	private static lease: CompareLease | undefined;
	private static leaseSubs: { dispose(): void }[] = [];
	private static compareTimer: ReturnType<typeof setTimeout> | undefined;
	private static infoTimer: ReturnType<typeof setTimeout> | undefined;
	private static binding: PanelProjectBinding | undefined;
	private static busy: Busy | null = null;
	/** Nested loads / scans / listings in progress: the webview's progress bar (`{type:"busy", on, label}`). */
	private static loadDepth = 0;
	private static autoGit = false;
	/** Options of a `show` that switched the project: applied once the panel has rebuilt for it. */
	private static pendingOpen: SyncCenterOpenOptions | undefined;
	/** The selection to hand the webview with the next init. */
	private static initialSelection: string[] = [];
	/** Paths / preset of an open that wait for the project index (applied by `applyPendingOpen`). */
	private static openPaths: string[] | undefined;
	private static openPreset: (DeployPreset & { validateOnly?: boolean }) | undefined;
	/** A project switch the user made while a deploy / retrieve / delete ran: applied when it ends. */
	private static switchPending = false;
	private static soapCalls = 0;
	private static compareStartedAt = 0;
	/** Live operations, recent deploys, cancel (see syncCenterActivityHost). */
	private static activity: SyncCenterActivity | undefined;
	/** Phases of opening the panel, logged once. */
	private static timings: OpenTimings | undefined;
	/** `refreshLocal` runs one at a time; a call during a run makes it run once more afterwards (open used to start three scans at once). */
	private static localRun: Promise<void> | undefined;
	private static localAgain = false;
	private static localForce = false;
	/** The Apex test classes, read while the webview loads. */
	private static testClassesFor: { root: string; p: Promise<{ label: string; description: string }[]> } | undefined;
	private static endCompareBusy: (() => void) | undefined;

	/** The project while an operation runs: a switch made meanwhile waits (`switchPending`), the operation keeps its project. */
	private static busyRoot: string | undefined;

	private static projectDir(): string | undefined {
		if (this.busy && this.busyRoot) return this.busyRoot;
		return this.binding?.current() ?? primaryProjectRoot();
	}

	private static hasSfdxProject(): boolean {
		const p = this.binding?.currentProject();
		return p ? p.kind === "sfdx" : isSalesforceProject();
	}

	public static init(context: vscode.ExtensionContext): void {
		this.ctx = context;
	}

	/** Open (or reveal) the Center; `opts` picks project, org and selection. */
	public static async show(opts: SyncCenterOpenOptions = {}): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (this.panel) {
			this.panel.reveal(column);
			await this.applyOpen(opts);
			return;
		}
		const panel = vscode.window.createWebviewPanel(this.viewType, "Deploy & Retrieve Metadata", column, this.webviewOptions());
		this.attach(panel, opts);
	}

	/** The webview options of the panel (also what a restored panel needs again). */
	private static webviewOptions(): vscode.WebviewOptions & vscode.WebviewPanelOptions {
		const roots = this.ctx ? [vscode.Uri.joinPath(this.ctx.extensionUri, "resources")] : undefined;
		return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots };
	}

	/** Call when VS Code restores the panel after a reload. The project and org are the active ones again; the selection is not kept. */
	public static revive(panel: vscode.WebviewPanel): void {
		if (!this.ctx) return;
		if (this.panel) {
			panel.dispose();
			return;
		}
		panel.webview.options = this.webviewOptions();
		this.attach(panel, {});
	}

	private static attach(panel: vscode.WebviewPanel, opts: SyncCenterOpenOptions): void {
		const ctx = this.ctx!;
		this.userPicked = !!opts.org;
		this.initialSelection = opts.selection ?? [];
		this.openPaths = opts.paths?.length ? opts.paths : undefined;
		this.openPreset = opts.preset;
		this.panel = panel;
		this.timings = new OpenTimings();
		this.activity = new SyncCenterActivity({
			post: (m) => this.post(m),
			projectDir: () => this.projectDir(),
			orgArg: () => (this.orgKey === DEFAULT_ORG_KEY ? null : this.orgArg),
			orgLabel: () => this.orgLabel(),
			sameOrg: (o) => this.sameOrg(o),
			generation: () => this.gen,
			cacheDir: () => this.cacheDir(),
			orgKey: () => this.orgKey,
			busy: (label) => {
				this.beginLoad(label);
				let ended = false;
				return () => {
					if (!ended) {
						ended = true;
						this.endLoad();
					}
				};
			},
		});
		panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "resources", "icon.png");
		panel.webview.html = this.getHtml(panel.webview, ctx.extensionUri);

		const initialOrg: string | null = opts.org ?? null;
		const binding = new PanelProjectBinding();
		this.binding = binding;
		if (opts.projectDir) binding.pick(opts.projectDir);
		this.prefetchTestClasses();
		this.disposables.push(
			binding,
			binding.attach(panel.webview),
			binding.onDidChange(() => void this.onProjectChanged().catch((e) => Logger.error("Deploy & Retrieve Metadata project switch failed", e))),
			panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg, () => initialOrg).catch((e) => Logger.error("Deploy & Retrieve Metadata message failed", e))),
			onDidChangeDefaultOrg(async () => {
				await this.sendOrgs();
				if (!this.userPicked) await this.loadOrg(null);
			}),
			{ dispose: onOrgListUpdated(() => void this.sendOrgs()) },
			onDidChangeHistory((dir) => {
				if (dir === this.projectDir()) this.postHistory();
			}),
			onDidChangePresets((dir) => {
				if (dir === this.projectDir()) void this.postPresets();
			}),
			subscribeSuites(() => this.projectDir(), () => this.postSuites()),
			SharedMetadataFilter.subscribe("syncCenter", () => this.projectDir(), (f) => this.post({ type: "sharedFilter", query: f.query, types: f.types }))
		);
		this.setupWatchers();
		panel.onDidDispose(() => this.dispose());
	}

	/** A `show` on an open panel: switch project / org, carry the selection. */
	private static async applyOpen(opts: SyncCenterOpenOptions): Promise<void> {
		const binding = this.binding;
		if (opts.projectDir && binding && opts.projectDir !== this.projectDir()) {
			this.pendingOpen = opts;
			binding.pick(opts.projectDir);
			return;
		}
		if (opts.org) {
			this.userPicked = true;
			await this.loadOrg(opts.org);
		}
		if (opts.selection) this.post({ type: "applySelection", keys: opts.selection, reveal: true });
		if (opts.paths?.length) this.openPaths = opts.paths;
		if (opts.preset) this.openPreset = opts.preset;
		this.applyPendingOpen();
	}

	/** Paths / preset of an open, once the local index is there: select their components (and show them), apply the preset. */
	private static applyPendingOpen(): void {
		const root = this.projectDir();
		if (!root || !this.local) return;
		const rel = this.relComponents();
		if (this.openPaths) {
			const paths = this.openPaths;
			this.openPaths = undefined;
			const relPaths = paths.map((a) => path.relative(root, a).split(path.sep).join("/")).filter((r) => r !== "" && !r.startsWith(".."));
			const { keys } = pathsToComponents(relPaths, rel);
			if (keys.length > 0) this.post({ type: "applySelection", keys, reveal: true });
			else this.status("None of the given files belongs to a component of this project.");
		}
		if (this.openPreset) {
			const preset = this.openPreset;
			this.openPreset = undefined;
			this.post({ type: "applyPreset", preset: toWebPreset(preset, rel) });
		}
	}

	private static dispose(): void {
		this.gen++;
		if (this.run) this.run.cancelled = true;
		this.run = undefined;
		for (const d of this.disposables) d.dispose();
		for (const d of this.watchers) d.dispose();
		this.disposables = [];
		this.watchers = [];
		if (this.watchTimer) clearTimeout(this.watchTimer);
		if (this.compareTimer) clearTimeout(this.compareTimer);
		if (this.infoTimer) clearTimeout(this.infoTimer);
		this.panel = undefined;
		this.loadDepth = 0;
		this.releaseLease();
		this.endCompareBusy = undefined;
		this.activity?.dispose();
		this.activity = undefined;
		this.timings = undefined;
		this.testClassesFor = undefined;
		this.localRun = undefined;
		this.byOrgKey = new Map();
		this.binding = undefined;
		this.busy = null;
		this.busyRoot = undefined;
		this.switchPending = false;
		this.openPaths = undefined;
		this.openPreset = undefined;
		this.comps = [];
		this.compMap = new Map();
		this.local = undefined;
	}

	private static post(msg: Record<string, unknown>): void {
		void this.panel?.webview.postMessage(msg);
	}

	private static status(text: string): void {
		this.post({ type: "status", text });
	}

	/** Mark a load / scan / listing as running; the webview shows its progress bar while any is. Pair with `endLoad` (try/finally). */
	private static beginLoad(label: string): void {
		this.loadDepth++;
		this.post({ type: "busy", on: true, label });
	}

	private static endLoad(): void {
		this.loadDepth = Math.max(0, this.loadDepth - 1);
		if (this.loadDepth === 0) this.post({ type: "busy", on: false });
	}

	/** The project of the panel changed: rebuild everything bound to it, as if the panel were newly opened. */
	private static async onProjectChanged(): Promise<void> {
		if (!this.panel) return;
		// Reloading mid-deploy would drop its progress and result: apply the switch when the operation ends.
		if (this.busy) {
			this.switchPending = true;
			this.post({ type: "toast", text: "The project switch applies after this operation.", kind: "info" });
			return;
		}
		this.userPicked = false;
		for (const d of this.watchers) d.dispose();
		this.watchers = [];
		this.setupWatchers();
		const open = this.pendingOpen;
		this.pendingOpen = undefined;
		if (open?.org) this.userPicked = true;
		if (open?.selection) this.initialSelection = open.selection;
		if (open?.paths?.length) this.openPaths = open.paths;
		if (open?.preset) this.openPreset = open.preset;
		this.prefetchTestClasses();
		await this.sendInit();
		await this.loadOrg(open?.org ?? null);
	}

	// ── Messages from the webview ────────────────────────────────────────────────

	private static async onMessage(msg: { command: string; [k: string]: any }, initialOrg: () => string | null): Promise<void> {
		const key = () => String(msg.key ?? "");
		if (this.activity?.handle(msg)) return;
		switch (msg.command) {
			case "ready":
				await this.sendInit();
				await this.loadOrg(this.userPicked && this.orgKey !== DEFAULT_ORG_KEY ? this.orgKey : initialOrg());
				break;
			case "selectOrg":
				this.userPicked = true;
				await this.loadOrg(String(msg.org));
				break;
			case "refresh":
				this.localForce = true; // Refresh does not trust the stored project index
				if (this.orgKey === DEFAULT_ORG_KEY) await this.loadOrg(null);
				else await this.list();
				break;
			case "refreshTypes":
				if (Array.isArray(msg.types) && msg.types.length > 0) await this.list(msg.types.map(String));
				break;
			case "compareContents":
				void this.requestCompare(msg.force === true, Array.isArray(msg.keys) ? msg.keys.map(String) : undefined);
				break;
			case "cancelCompare":
				this.lease?.service.cancelAll();
				break;
			case "deploy":
				await this.deployFromWebview(msg);
				break;
			case "retrieve":
				await this.retrieveFromWebview(msg);
				break;
			case "delete":
				await this.deleteFromWebview(msg);
				break;
			case "diff":
				await this.openDiff(key(), String(msg.status ?? ""));
				break;
			case "openFile": {
				const e = this.byOrgKey.get(key());
				if (e) await vscode.window.showTextDocument(vscode.Uri.file(e.primary));
				break;
			}
			case "reveal": {
				const e = this.byOrgKey.get(key());
				if (e) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(e.root ?? e.primary));
				break;
			}
			case "setup":
				await this.openSetup(String(msg.t ?? ""), String(msg.n ?? ""));
				break;
			case "copy":
				if (typeof msg.text === "string") await vscode.env.clipboard.writeText(msg.text);
				break;
			case "gitSelect":
				await this.gitSelect(true);
				break;
			case "autoGit":
				this.autoGit = msg.on === true;
				// `restore`: the webview only tells the saved option; the first change times select (no Git read before the index is there).
				if (this.autoGit && msg.restore !== true) await this.gitSelect(true);
				break;
			case "savePreset":
				await this.savePresetFromWebview(msg);
				break;
			case "historyRerun":
				await this.historyRerun(String(msg.id ?? ""), Array.isArray(msg.testClassNames) ? msg.testClassNames.map(String) : []);
				break;
			case "historyOpenSetup":
				await this.historyOpenSetup(String(msg.id ?? ""));
				break;
			case "reauth":
				await reauthenticateOrg(this.orgKey);
				await this.loadOrg(this.orgKey === DEFAULT_ORG_KEY ? null : this.orgKey);
				break;
			case "chooseOrg":
				await vscode.commands.executeCommand("adure-sfx-toolkit.schemaHealthActions");
				break;
			case "connectOrg":
				await vscode.commands.executeCommand("adure-sfx-toolkit.connectOrg");
				break;
			case "uiState":
				void this.ctx?.workspaceState.update(UI_STATE_KEY, msg.state);
				break;
			case "columns":
				// Per computer (not per workspace): order, visibility and widths of the grid columns.
				void this.ctx?.globalState.update(COLUMNS_STORE_KEY, normalizeLayout(msg.layout));
				break;
			case "saveTestSuite":
			case "deleteTestSuite": {
				const dir = this.projectDir();
				if (dir) await handleSuiteMessage(msg, dir, () => this.postSuites());
				break;
			}
			case "sharedFilter":
				SharedMetadataFilter.set(this.projectDir(), { query: msg.query, types: msg.types }, "syncCenter");
				break;
		}
	}

	// ── Init / org list ──────────────────────────────────────────────────────────

	/** Read the test classes now (they are a file scan): by the time the webview says `ready` they are usually done. */
	private static prefetchTestClasses(): void {
		const root = this.projectDir();
		if (!root) return;
		this.testClassesFor = { root, p: Promise.resolve().then(() => getTestClassItems(root)).catch(() => []) };
	}

	private static takeTestClasses(root: string): Promise<{ label: string; description: string }[]> {
		const pre = this.testClassesFor;
		this.testClassesFor = undefined;
		if (pre && pre.root === root) return pre.p;
		return Promise.resolve().then(() => getTestClassItems(root)).catch(() => []);
	}

	private static async sendInit(): Promise<void> {
		const root = this.projectDir();
		const picker = root ? await orgPickerForProject(root).catch(() => ({ orgs: [], defaultOrg: "" })) : { orgs: [], defaultOrg: "" };
		const key = canonicalOrgKey(null, root);
		// The test class scan is not awaited either (the specified-tests list fills in when it is done).
		const testClassesP = root ? this.takeTestClasses(root) : Promise.resolve([]);
		const selection = this.initialSelection;
		this.initialSelection = [];
		// Not awaited: the org check can take a while and must not hold up the first render. Until its `orgs` message
		// arrives (loadOrg sends it) the org counts as production, the safe side.
		const production = true;
		this.post({
			type: "init",
			orgs: picker.orgs,
			org: key === DEFAULT_ORG_KEY ? null : key,
			production,
			hasProject: !!root && this.hasSfdxProject(),
			projectDir: root ?? "",
			projectName: root ? path.basename(root) : "",
			ui: this.ctx?.workspaceState.get(UI_STATE_KEY) ?? null,
			columns: normalizeLayout(this.ctx?.globalState.get(COLUMNS_STORE_KEY)),
			shared: SharedMetadataFilter.get(root),
			testClasses: [],
			childTypes: [...OBJECT_CHILD_TYPES],
			selection,
		});
		void testClassesP.then((testClasses) => {
			if (root === this.projectDir()) this.post({ type: "testClasses", testClasses });
		});
		this.postHistory();
		void this.postPresets();
		this.postSuites();
	}

	private static async sendOrgs(): Promise<void> {
		if (!this.panel) return;
		const key = this.orgKey;
		const root = this.projectDir();
		const picker = root ? await orgPickerForProject(root).catch(() => ({ orgs: [], defaultOrg: "" })) : { orgs: [], defaultOrg: "" };
		const production = await this.orgIsProduction(key, root);
		if (key !== this.orgKey) return; // the org changed while the check ran; its own message follows
		this.post({ type: "orgs", orgs: picker.orgs, org: key === DEFAULT_ORG_KEY ? null : key, production });
	}

	/** Production or not verifiable: the same rule the Delete section's test check uses. */
	private static async orgIsProduction(key: string, root: string | null | undefined): Promise<boolean> {
		const check = await checkOrgForDestructive(orgArgForKey(key), root || undefined).catch(() => null);
		return !check || check.production || !check.known;
	}

	private static postHistory(): void {
		const root = this.projectDir();
		this.post({ type: "history", entries: root ? getHistory(root) : [] });
	}

	private static relComponents(): RelComponent[] {
		const root = this.projectDir();
		if (!root || !this.local) return [];
		return [...this.local.entries.values()].map((e) => ({ key: e.key, files: e.files.map((f) => path.relative(root, f).split(path.sep).join("/")) }));
	}

	private static postSuites(): void {
		const root = this.projectDir();
		this.post({ type: "testSuites", suites: root ? loadTestSuites(root) : [] });
	}

	private static async postPresets(): Promise<void> {
		const root = this.projectDir();
		if (!root) return;
		const rel = this.relComponents();
		const list = await listPresets(root);
		if (root !== this.projectDir()) return;
		this.post({ type: "presets", presets: list.map((p) => toWebPreset(p, rel)) });
	}

	// ── Loading an org ───────────────────────────────────────────────────────────

	private static cacheDir(): string {
		return path.join(this.ctx!.globalStorageUri.fsPath, "org-browser");
	}

	private static apiVersion(): string {
		return getToolingApiVersion().replace(/^v/, "");
	}

	private static orgLabel(): string {
		return this.orgKey === DEFAULT_ORG_KEY ? getDefaultOrgSync(this.projectDir())?.displayName || "the default org" : getOrgByTarget(this.orgKey)?.alias || this.orgKey;
	}

	private static setComps(comps: Comp[]): void {
		this.comps = comps;
		const map = new Map<string, Comp>();
		for (const c of comps) map.set(compKey(c.t, c.n), c);
		this.compMap = map;
	}

	private static async loadOrg(org: string | null): Promise<void> {
		this.beginLoad("Loading…");
		try {
			await this.loadOrgInner(org);
		} finally {
			this.endLoad();
		}
	}

	private static async loadOrgInner(org: string | null): Promise<void> {
		if (!this.panel) return;
		const gen = ++this.gen;
		this.timings = new OpenTimings();
		if (this.run) this.run.cancelled = true;
		const key = canonicalOrgKey(org, this.projectDir());
		this.orgKey = key;
		this.orgArg = orgArgForKey(key);
		this.setComps([]);
		this.types = [];
		this.failures = [];
		this.listedAt = 0;
		this.typeListedAt = {};
		this.local = undefined;
		this.byOrgKey = new Map();
		this.releaseLease();
		this.post({ type: "reset", org: key === DEFAULT_ORG_KEY ? null : key });
		this.activity?.reset();
		// The org's last deploy list from disk goes out at once (the Deployment history tab never opens empty).
		void this.activity?.sendCachedDeploys();
		void this.sendOrgs();

		const root = this.projectDir();
		// What does not depend on the org list starts at once and runs beside it: the local scan and the stored listing.
		const t0 = Date.now();
		void this.refreshLocal();
		// The Org Browser's listing cache is shared: opening the Center for an org the Org Browser listed is instant.
		const cacheP =
			key === DEFAULT_ORG_KEY
				? Promise.resolve(null)
				: loadListingCache(this.cacheDir(), key).then((c) => {
					this.timings?.mark(`stored listing${c ? ` (${c.comps.length} components)` : " (none)"}`, Date.now() - t0);
					return c;
				});
		const picker = root ? await orgPickerForProject(root).catch(() => ({ orgs: [], defaultOrg: "" })) : { orgs: [], defaultOrg: "" };
		this.timings?.mark("org list", Date.now() - t0);
		if (gen !== this.gen) return;
		if (picker.orgs.length === 0) {
			this.post({ type: "orgs", orgs: [], org: null });
			return;
		}
		if (key === DEFAULT_ORG_KEY) {
			this.post({ type: "loadError", state: "noDefaultOrg", message: "No default org is set. Choose an org to compare the project with." });
			return;
		}
		void this.acquireLease(key, gen);
		void this.resolveMe(gen);

		const cache = await cacheP;
		if (gen !== this.gen) return;
		if (cache) {
			this.types = cache.types;
			this.failures = cache.failures;
			this.listedAt = cache.listedAt;
			this.typeListedAt = cache.typeListedAt ?? {};
			this.setComps(cache.comps);
			this.post({ type: "loadStart", mode: "cache" });
			this.post({ type: "types", types: cache.types });
			for (let i = 0; i < cache.comps.length; i += CHUNK) {
				this.post({ type: "batch", comps: cache.comps.slice(i, i + CHUNK), done: 0, total: 0, label: "" });
			}
			this.post({ type: "loadEnd", listedAt: cache.listedAt, failures: cache.failures, types: cache.types });
			void this.refreshLocal();
			return;
		}
		await this.list();
	}

	private static async resolveMe(gen: number): Promise<void> {
		try {
			const me = await resolveCurrentUser(this.orgArg, this.apiVersion());
			if (gen === this.gen) this.post({ type: "me", ids: me.ids, name: me.name });
		} catch (e: any) {
			Logger.info(`Deploy & Retrieve Metadata: could not resolve the current user: ${e?.message ?? e}`);
		}
	}

	// ── Listing ──────────────────────────────────────────────────────────────────

	/** List the whole org, or only `only` types (per-type refresh). */
	private static async list(only?: string[]): Promise<void> {
		if (!this.panel || this.orgKey === DEFAULT_ORG_KEY) return;
		const gen = this.gen;
		if (this.run) this.run.cancelled = true;
		const run = { cancelled: false };
		this.run = run;
		const isCancelled = () => run.cancelled || gen !== this.gen;
		const expanded = only ? expandOnlyTypes(only) : undefined;
		this.post({ type: "loadStart", mode: only ? "types" : this.comps.length > 0 ? "refresh" : "live", only: expanded });
		this.beginLoad(only ? "Listing metadata…" : "Listing the org’s metadata…");
		try {
			const out = await runListing({
				orgKey: this.orgKey,
				apiVersion: this.apiVersion(),
				call: makeSoapCall(this.orgArg, this.apiVersion()),
				state: { types: this.types, comps: this.comps, failures: this.failures, listedAt: this.listedAt, typeListedAt: this.typeListedAt },
				only,
				isCancelled,
				onTypes: (t) => this.post({ type: "types", types: t }),
				onBatch: (comps, progress) => {
					if (gen === this.gen) this.post({ type: "batch", comps, done: progress.done, total: progress.total, label: progress.label });
				},
			});
			if (!out) return;
			const { cache } = out;
			const now = Date.now();
			this.types = expanded ? this.types : cache.types;
			this.failures = cache.failures;
			this.listedAt = expanded ? now : cache.listedAt;
			this.typeListedAt = cache.typeListedAt ?? {};
			this.setComps(cache.comps);
			this.post({ type: "loadEnd", listedAt: this.listedAt, failures: this.failures, types: this.types, dropTypes: expanded });
			void this.refreshLocal();
			await saveListingCache(this.cacheDir(), { ...cache, types: this.types }).catch((e) => Logger.error("Deploy & Retrieve Metadata: could not write the listing cache", e));
		} catch (e: any) {
			if (e instanceof ListCancelled || isCancelled()) return;
			const view = listFailureView(e, this.orgKey, this.orgLabel());
			Logger.error("Deploy & Retrieve Metadata: listing failed", view.log);
			this.post({ type: "loadError", state: view.state, message: view.message });
		} finally {
			if (this.run === run) this.run = undefined;
			this.endLoad();
		}
	}

	// ── Local index ──────────────────────────────────────────────────────────────

	/**
	 * Scan the project (and read its change times). One run at a time: a call during a run (open used to start three
	 * scans at once: before the org list, after it, after the listing) makes it run once more afterwards.
	 * `force`: do not trust the stored index (the Refresh button).
	 */
	private static refreshLocal(force = false): Promise<void> {
		if (force) this.localForce = true;
		if (this.localRun) {
			this.localAgain = true;
			return this.localRun;
		}
		const run = (async () => {
			try {
				do {
					this.localAgain = false;
					const f = this.localForce;
					this.localForce = false;
					this.beginLoad("Reading the project…");
					try {
						await this.refreshLocalInner(f);
					} finally {
						this.endLoad();
					}
				} while (this.localAgain && this.panel);
			} finally {
				this.localRun = undefined;
			}
		})();
		this.localRun = run;
		return run;
	}

	/** Send the local index to the webview (`local` message) and remember it for the compare and the actions. */
	private static applyLocal(index: LocalIndex, root: string): void {
		this.local = index;
		this.byOrgKey = new Map([...index.entries.values()].map((e) => [orgLookupKey(e.type, e.name), e]));
		this.post({
			type: "local",
			entries: [...index.entries.values()].map((e) => ({ type: e.type, name: e.name, key: e.key, path: path.relative(root, e.primary).split(path.sep).join("/") })),
			partial: partialObjectKeys(index.entries),
			retrieved: getRetrieveTimes(this.orgKey === DEFAULT_ORG_KEY ? null : this.orgKey),
			hasProject: true,
		});
		this.timings?.once("first rows");
		void this.postPresets();
		this.applyPendingOpen();
	}

	private static async refreshLocalInner(force: boolean): Promise<void> {
		if (!this.panel) return;
		const gen = this.gen;
		const root = this.projectDir();
		if (!root || !this.hasSfdxProject()) {
			this.post({ type: "local", entries: [], partial: [], retrieved: {}, hasProject: false });
			return;
		}
		try {
			const dirs = readPackageDirectories(root);
			const pkg = dirs.length > 0 ? dirs : ["force-app"];
			// 1. Paint at once from the stored index (and the stored change times); 2. check it against the disk in the background.
			if (!this.local && !force) {
				const t = Date.now();
				const stored = await peekLocalIndex(root, pkg, this.types);
				if (gen !== this.gen || !this.panel) return;
				if (stored) {
					this.applyLocal(stored, root);
					const info = await peekLocalInfo(root, stored.entries.keys());
					if (gen !== this.gen || !this.panel) return;
					if (info) this.post({ type: "compareLocal", local: info });
					this.timings?.mark(`stored project index (${stored.entries.size} components)`, Date.now() - t);
				}
			}
			const t1 = Date.now();
			const r = await scanProjectCached(root, pkg, this.types, { force });
			if (gen !== this.gen || !this.panel) return;
			if (!r.reused || !this.local) this.applyLocal(r.index, root);
			this.timings?.mark(r.reused ? "index check (unchanged)" : `project scan (${r.index.entries.size} components)`, Date.now() - t1);
			await this.refreshLocalInfo();
		} catch (e: any) {
			Logger.error("Deploy & Retrieve Metadata: local scan failed", e?.message ?? e);
		}
	}

	// ── Content compare ──────────────────────────────────────────────────────────

	private static releaseLease(): void {
		for (const d of this.leaseSubs) d.dispose();
		this.leaseSubs = [];
		this.endCompareBusy?.();
		this.endCompareBusy = undefined;
		if (this.lease) {
			this.lease.release();
			this.lease = undefined;
			this.post({ type: "compareContent", full: true, content: {} });
			this.post({ type: "compareProgress", progress: { state: "idle", done: 0, total: 0, failed: 0 } });
		}
	}

	private static async acquireLease(orgKey: string, gen: number): Promise<void> {
		const root = this.projectDir();
		if (!root || !this.hasSfdxProject() || orgKey === DEFAULT_ORG_KEY) return;
		const lease = acquireCompare(root, orgKey, orgArgForKey(orgKey));
		this.lease = lease;
		const service = lease.service;
		this.leaseSubs.push(
			// Results are keyed by the local index key, which is what the rows look them up by.
			service.onDidUpdate((localKeys) => this.post({ type: "compareContent", full: false, content: service.contentInfo(localKeys) })),
			service.onDidProgress((progress) => {
				this.post({ type: "compareProgress", progress });
				this.trackCompareBusy(progress.state === "running", progress);
			})
		);
		await service.load();
		if (gen !== this.gen || this.lease !== lease) return;
		this.post({ type: "compareProgress", progress: service.progress() });
		await this.pushContent();
	}

	/** The compare's phase as the webview's busy bar: on while contents are being retrieved and compared. */
	private static trackCompareBusy(running: boolean, p: { done: number; total: number }): void {
		if (running && !this.endCompareBusy) {
			this.endCompareBusy = this.activity?.busyBegin("Comparing contents…");
			this.compareStartedAt = Date.now();
		} else if (!running && this.endCompareBusy) {
			this.endCompareBusy();
			this.endCompareBusy = undefined;
			Logger.info(`Deploy & Retrieve Metadata: content compare finished: ${p.done} component(s) in ${Date.now() - this.compareStartedAt} ms`);
		}
	}

	/** Local components that are in the listing, ready for the compare service (`orgKeys`: only these). */
	private static compareTargets(orgKeys?: Iterable<string>): ReturnType<typeof compareTargetsFor> {
		const root = this.projectDir();
		if (!root) return [];
		const list = orgKeys ? [...orgKeys].map((k) => this.byOrgKey.get(k)).filter((e): e is LocalEntry => !!e) : [...this.byOrgKey.values()];
		return compareTargetsFor(root, this.types, list, this.compMap);
	}

	private static compareTargetsOfLocalKeys(localKeys: string[]): ReturnType<typeof compareTargetsFor> {
		const root = this.projectDir();
		if (!root || !this.local) return [];
		const list = localKeys.map((k) => this.local!.entries.get(k)).filter((e): e is LocalEntry => !!e);
		return compareTargetsFor(root, this.types, list, this.compMap);
	}

	private static async pushContent(): Promise<void> {
		const lease = this.lease;
		if (!lease) return;
		lease.setTypes(this.types);
		const content = await lease.service.validContentInfo(this.compareTargets());
		if (this.lease !== lease) return;
		this.post({ type: "compareContent", full: true, content });
	}

	/** Local change times + git dirty per component, then the compare results that are still valid. */
	private static async refreshLocalInfo(): Promise<void> {
		const root = this.projectDir();
		const gen = this.gen;
		if (!root || !this.local || !this.panel || !this.hasSfdxProject()) return;
		this.beginLoad("Reading change times…");
		try {
			const t0 = Date.now();
			let dirty: string[] | null = null;
			try {
				dirty = await runGitStatusSfdxPaths(root);
			} catch {
				dirty = null; // not a git repository: file times only
			}
			const t1 = Date.now();
			const dirs = readPackageDirectories(root);
			const local: LocalInfoMap = await readLocalInfo(root, this.local.entries.values(), dirs.length > 0 ? dirs : ["force-app"], dirty);
			if (gen !== this.gen || !this.panel) return;
			this.timings?.mark("git status", t1 - t0);
			this.timings?.mark("change times", Date.now() - t1);
			this.post({ type: "compareLocal", local });
			if (this.autoGit && dirty) this.postModified(dirty, true);
			const t2 = Date.now();
			await this.pushContent();
			this.timings?.mark("stored compare results", Date.now() - t2);
			this.timings?.at("ready");
			this.timings?.log("Deploy & Retrieve Metadata open");
			this.scheduleCompare(0);
			// Idle after the first render: the org's recent deploys for the Deployment history tab.
			this.activity?.prefetchDeploys(1500);
		} finally {
			this.endLoad();
		}
	}

	private static scheduleCompare(ms: number): void {
		if (this.compareTimer) clearTimeout(this.compareTimer);
		this.compareTimer = setTimeout(() => {
			this.compareTimer = undefined;
			if (compareMode() === "auto") void this.requestCompare(false);
		}, ms);
	}

	private static async requestCompare(force: boolean, orgKeys?: string[]): Promise<void> {
		const lease = this.lease;
		if (!lease || !this.local || this.comps.length === 0) return;
		await lease.service.load();
		if (this.lease !== lease) return;
		lease.setTypes(this.types);
		lease.service.request(this.compareTargets(orgKeys), force);
	}

	private static setupWatchers(): void {
		const root = this.projectDir();
		if (!root) return;
		const rescan = () => {
			if (this.watchTimer) clearTimeout(this.watchTimer);
			this.watchTimer = setTimeout(() => void this.refreshLocal(), 700);
		};
		for (const pkg of readPackageDirectories(root)) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.resolve(root, pkg), "**/*"), false, false, false);
			w.onDidCreate(rescan);
			w.onDidDelete(rescan);
			// A saved file: its local change time / git status and compare result are out of date.
			w.onDidChange(() => {
				if (this.infoTimer) clearTimeout(this.infoTimer);
				this.infoTimer = setTimeout(() => void this.refreshLocalInfo(), 800);
				this.scheduleCompare(4000);
			});
			this.watchers.push(w);
		}
	}

	// ── Git ──────────────────────────────────────────────────────────────────────

	/** Components git reports as changed → the webview selects them. */
	private static async gitSelect(select: boolean): Promise<void> {
		const root = this.projectDir();
		if (!root || !this.local) {
			this.status("Open an SFDX project to read Git changes.");
			return;
		}
		try {
			const paths = await runGitStatusSfdxPaths(root);
			this.postModified(paths, select);
		} catch (e) {
			this.post({ type: "modifiedKeys", keys: [], select, total: 0, unmatched: 0, error: String((e as Error)?.message ?? e) });
		}
	}

	private static postModified(paths: string[], select: boolean): void {
		const { keys, unmatched } = pathsToComponents(paths, this.relComponents());
		this.post({ type: "modifiedKeys", keys, select, total: paths.length, unmatched: unmatched.length });
	}

	// ── Hidden selection prompt ──────────────────────────────────────────────────

	/** Selected components the current filter hides are never acted on by accident: ask. undefined = the user cancelled. */
	private static async confirmHidden<T extends { key: string }>(items: T[], visible: unknown, verb: string): Promise<T[] | undefined> {
		if (!Array.isArray(visible)) return items;
		const { visible: vis, hidden } = splitByVisibility(items.map((i) => i.key), new Set(visible.map(String)));
		if (hidden.length === 0) return items;
		const { message, detail } = hiddenSelectionPrompt(items.length, hidden, verb);
		const all = `${verb} all ${items.length}`;
		const only = `${verb} visible ${vis.length} only`;
		const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, all, ...(vis.length > 0 ? [only] : []));
		if (choice === only) {
			const keep = new Set(vis);
			return items.filter((i) => keep.has(i.key));
		}
		return choice === all ? items : undefined;
	}

	// ── Deploy ───────────────────────────────────────────────────────────────────

	private static async deployFromWebview(msg: { [k: string]: any }): Promise<void> {
		const raw: { key: string; local: string[] }[] = Array.isArray(msg.items)
			? msg.items.map((i: any) => ({ key: String(i.key), local: Array.isArray(i.local) ? i.local.map(String) : [] }))
			: [];
		const dryRun = msg.dryRun === true;
		const items = await this.confirmHidden(raw, msg.visible, dryRun ? "Validate" : "Deploy");
		if (!items) {
			this.post({ type: "deployResult", cancelled: true, dryRun });
			return;
		}
		// A conflict row's own Deploy icon acts directly: say what it overwrites first. A validation overwrites nothing.
		if (msg.conflict === true && !dryRun) {
			const name = items[0]?.key ?? "this component";
			const go = "Overwrite org";
			const choice = await vscode.window.showWarningMessage(`Conflict: overwrite the org’s version with your local version?`, { modal: true, detail: `${name} changed in the project and in the org. Deploying replaces the org’s version with the local one.` }, go);
			if (choice !== go) {
				this.post({ type: "deployResult", cancelled: true, dryRun });
				return;
			}
		}
		const localKeys = [...new Set(items.flatMap((i) => i.local))];
		await this.doDeploy({
			localKeys,
			testLevel: String(msg.testLevel ?? ""),
			testNames: Array.isArray(msg.testClassNames) ? msg.testClassNames.map(String) : [],
			dryRun,
			label: cleanLabel(msg.label),
			presetName: typeof msg.presetName === "string" && msg.presetName ? msg.presetName : undefined,
		});
	}

	private static async doDeploy(p: { localKeys: string[]; testLevel: string; testNames: string[]; dryRun: boolean; label?: string; presetName?: string }): Promise<void> {
		const { dryRun, testLevel } = p;
		const root = this.projectDir();
		const fail = (error: string, toast = true) => {
			this.post({ type: "deployResult", success: false, cancelled: false, dryRun, components: 0, componentErrors: 0, testsPassed: 0, testsFailed: 0, durationMs: 0, error });
			if (toast) void vscode.window.showErrorMessage(`${deployLabel(dryRun)} not started: ${error}`);
		};
		if (!root || !this.local || !this.hasSfdxProject()) return fail("Open an SFDX project to deploy.");
		if (this.orgKey === DEFAULT_ORG_KEY || !this.orgArg) return fail("Choose an org first.");
		if (this.busy) {
			this.post({ type: "toast", text: `A ${this.busy} is running.`, kind: "warn" });
			return;
		}
		const targetOrg = this.orgArg;
		const entries = this.local.entries;
		const { paths: absPaths, missing } = deployPathsForComponents(p.localKeys, entries);
		if (missing.length > 0) Logger.info(`Deploy & Retrieve Metadata: ${missing.length} selected component(s) are not in the project any more: ${missing.slice(0, 10).join(", ")}`);
		if (absPaths.length === 0) return fail("None of the selected components is in the project any more.");
		const deployedKeys = p.localKeys.filter((k) => !missing.includes(k));
		const testFlags = testLevel === "RunSpecifiedTests" ? p.testNames.filter((t) => t.trim() !== "") : [];
		try {
			// Validate up front so invalid input is reported, not an unhandled rejection mid-deploy.
			validateDeployInput({ absPaths, testLevel, testFlags, dryRun, root, targetOrg });
		} catch (e) {
			return fail(e instanceof Error ? e.message : String(e));
		}
		const sourcePaths = relativeFilesOf(deployedKeys, entries, root);
		/** The classic deployment history (the "Deployment History" command) keeps working: same entry as the removed Deploy panel wrote. */
		const legacyHistory = (status: "Succeeded" | "Failed" | "Cancelled", at: number, durationMs: number, stats?: { components: number; componentErrors: number; testsPassed: number; testsFailed: number }) =>
			addDeployHistoryEntry({
				timestamp: at,
				status,
				dryRun,
				components: stats?.components ?? 0,
				componentErrors: stats?.componentErrors ?? 0,
				testsPassed: stats?.testsPassed ?? 0,
				testsFailed: stats?.testsFailed ?? 0,
				durationMs,
				targetOrg,
				sourcePaths,
				presetName: p.presetName ?? null,
				deployType: testLevel as DeployTypeKey,
				testClassNames: testFlags.length ? testFlags : undefined,
			});
		this.setBusy("deploy");
		const opN = deployedKeys.length;
		const op = this.activity?.beginOp(dryRun ? "validate" : "deploy", p.label || `${dryRun ? "Validate" : "Deploy"} ${opN} component${opN === 1 ? "" : "s"}`);
		let opError: unknown;
		const service = this.lease?.service;
		// No background content compare while a deploy / validation runs; it continues afterwards.
		service?.pause();
		try {
			if (!(await confirmProductionOrgOperation(dryRun ? "validate a deployment against" : "deploy metadata to", targetOrg, root))) {
				this.post({ type: "deployResult", cancelled: true, dryRun });
				return;
			}
			// Right before: ask the org NOW (live, only the selected components' types) whether any selected component
			// changed there since this toolkit last retrieved or deployed it. Never the cached status.
			this.status("Checking the org for changes…");
			const check = await this.preDeployCheck(deployedKeys, service);
			Logger.info(
				`Deploy & Retrieve Metadata pre-deploy check: ${check.types.length} type(s) listed live (${check.types.join(", ")}) in ${check.soapCalls} SOAP call(s), ${check.ms} ms; ` +
					(check.decision ? `${check.decision.changed.length} changed in the org, ${check.decision.unverified.length} not verifiable` : `org not checked (${check.error ?? "unknown"}) — going on`)
			);
			if (check.decision?.needsConfirmation) {
				const { message, detail } = preDeployPrompt(check.decision.changed, dryRun, (ms) => new Date(ms).toLocaleString());
				const go = dryRun ? "Validate anyway" : "Deploy anyway";
				const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, go, "Compare");
				if (choice === "Compare") {
					this.status("Not deployed: compare the changed components with the org first.");
					const first = check.decision.changed[0];
					await this.openDiff(orgLookupKey(first.type, first.name), "changed-in-org");
					this.post({ type: "deployResult", cancelled: true, dryRun });
					return;
				}
				if (choice !== go) {
					this.status(`${deployLabel(dryRun)} cancelled: ${check.decision.changed.length} component(s) changed in the org.`);
					this.post({ type: "deployResult", cancelled: true, dryRun });
					return;
				}
			}
			this.status("");
			this.post({ type: "deployStart", dryRun });
			op?.running();
			const run = await runDeploy({ absPaths, testLevel, testFlags, dryRun, root, targetOrg, onProgress: (s) => op?.live(s), cancelToken: op?.token });
			const { outcome, startedAt, durationMs } = run;
			op?.settle(outcome);
			if (outcome.kind === "cancelled") {
				this.post({ type: "deployResult", success: false, cancelled: true, dryRun, durationMs });
				legacyHistory("Cancelled", startedAt, durationMs);
			} else if (outcome.kind === "success") {
				const { stats, coverage, apiResult } = outcome;
				this.post({ type: "deployResult", success: true, cancelled: false, dryRun, ...stats, coverage, durationMs });
				legacyHistory("Succeeded", startedAt, durationMs, stats);
				recordHistory(root, { kind: dryRun ? "validate" : "deploy", org: targetOrg, at: startedAt, durationMs, components: deployedKeys, testLevel, tests: testFlags, deployId: outcome.deployId, ok: true, source: "center", ...(p.label ? { label: p.label } : {}) });
				// A real deploy: record the components with the org's new lastModifiedDate (our own deploy must not show as "changed in org").
				if (!dryRun && (apiResult !== undefined || stats.components > 0)) await this.afterDeploy(deployedKeys, outcome.completedAt ?? Date.now());
			} else {
				const { stats, coverage, apiResult, errorText } = outcome;
				this.post({ type: "deployResult", success: false, cancelled: false, dryRun, ...stats, coverage, durationMs });
				legacyHistory("Failed", startedAt, durationMs, stats);
				recordHistory(root, {
					kind: dryRun ? "validate" : "deploy",
					org: targetOrg,
					at: startedAt,
					durationMs,
					components: deployedKeys,
					testLevel,
					tests: testFlags,
					deployId: outcome.deployId,
					ok: false,
					errors: historyErrorsFromDeploy(apiResult ? withSyntheticTestFailures(apiResult) : undefined, errorText),
					source: "center",
					...(p.label ? { label: p.label } : {}),
				});
			}
			reportDeployOutcome({ run, dryRun, root, targetOrg });
		} catch (e) {
			opError = e;
			throw e;
		} finally {
			// Declined at a confirmation = cancelled; an error thrown on the way = failed.
			if (op && !op.finished) op.end(opError ? "failed" : "cancelled", opError ? String((opError as Error)?.message ?? opError) : undefined);
			service?.resume();
			this.setBusy(null);
		}
	}

	/** The live check right before a deploy, over a listing state of its own (it never touches the grid's). */
	private static async preDeployCheck(localKeys: string[], service: CompareLease["service"] | undefined) {
		const apiVersion = this.apiVersion();
		const status = new DeployOrgStatus({
			cacheDir: path.join(this.ctx!.globalStorageUri.fsPath, "sync-center-precheck"),
			apiVersion,
			makeCall: (org) => {
				const call = makeSoapCall(org, apiVersion);
				return (op) => {
					this.soapCalls++;
					return call(op);
				};
			},
		});
		await status.load(this.orgKey, this.orgArg);
		return checkOrgBeforeDeploy(
			{
				status,
				orgKey: this.orgKey,
				orgArg: this.orgArg,
				service,
				compareTargets: (keys) => this.compareTargetsOfLocalKeys(keys),
				soapCalls: () => this.soapCalls,
				cancelBackground: () => undefined,
			},
			localKeys
		);
	}

	/** Re-list the deployed types, record the components with the org's new lastModifiedDate, rescan and re-compare them. */
	private static async afterDeploy(localKeys: string[], completedAt: number): Promise<void> {
		if (localKeys.length === 0) return;
		const types = [...new Set(localKeys.map((k) => refOfKey(k).type))];
		await this.list(types);
		recordDeployed(
			this.orgArg,
			localKeys.map((k) => {
				const r = refOfKey(k);
				const lm = this.compMap.get(orgLookupKey(r.type, r.fullName))?.lm;
				return { type: r.type, fullName: r.fullName, at: lm ? new Date(lm) : undefined };
			}),
			new Date(completedAt)
		);
		await this.refreshLocal();
		void this.requestCompare(true, localKeys.map((k) => rowKeyOf(k)));
	}

	// ── Retrieve ─────────────────────────────────────────────────────────────────

	private static async retrieveFromWebview(msg: { [k: string]: any }): Promise<void> {
		const raw: { key: string; refs: { type: string; fullName: string }[] }[] = Array.isArray(msg.items)
			? msg.items.map((i: any) => ({ key: String(i.key), refs: Array.isArray(i.refs) ? i.refs.map((r: any) => ({ type: String(r.type), fullName: String(r.fullName) })) : [] }))
			: [];
		const items = await this.confirmHidden(raw, msg.visible, "Retrieve");
		if (!items) {
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			return;
		}
		// A conflict row's own Retrieve icon acts directly: say what it overwrites first.
		if (msg.conflict === true) {
			const name = items[0]?.key ?? "this component";
			const go = "Overwrite local";
			const choice = await vscode.window.showWarningMessage(`Conflict: overwrite your local version with the org’s version?`, { modal: true, detail: `${name} changed in the project and in the org. Retrieving replaces the local files with the org’s version.` }, go);
			if (choice !== go) {
				this.post({ type: "retrieveResult", results: [], cancelled: true });
				return;
			}
		}
		const seen = new Set<string>();
		const refs = items.flatMap((i) => i.refs).filter((r) => {
			const k = compKey(r.type, r.fullName);
			return seen.has(k) ? false : (seen.add(k), true);
		});
		await this.doRetrieve({ refs, confirm: msg.confirm !== false });
	}

	private static async doRetrieve(p: { refs: { type: string; fullName: string }[]; confirm: boolean }): Promise<void> {
		const root = this.projectDir();
		const cancel = () => this.post({ type: "retrieveResult", results: [], cancelled: true });
		if (!root || !this.hasSfdxProject() || !this.local) {
			this.post({ type: "toast", text: "Open an SFDX project to retrieve.", kind: "warn" });
			return cancel();
		}
		if (this.orgKey === DEFAULT_ORG_KEY) {
			this.post({ type: "toast", text: "Choose an org first.", kind: "warn" });
			return cancel();
		}
		if (p.refs.length === 0) return cancel();
		if (this.busy) {
			this.post({ type: "toast", text: `A ${this.busy} is running.`, kind: "warn" });
			return cancel();
		}
		this.setBusy("retrieve");
		let op: OpHandle | undefined;
		try {
			const locals = [...this.local.entries.values()];
			const targets = [
				...new Set(
					overwriteLocalKeys(p.refs, locals, OBJECT_CHILD_TYPES).flatMap((k) => {
						const e = this.local!.entries.get(k);
						return e ? overwriteTargets(e) : [];
					})
				),
			];
			const flow = await runRetrieveFlow({
				projectDir: root,
				org: this.orgArg,
				orgLabel: this.orgLabel(),
				historyOrg: getDefaultOrgSync(root)?.username ?? this.orgLabel(),
				components: p.refs,
				targets,
				confirm: p.confirm,
				source: "center",
				afterWrite: () => this.refreshLocal(),
				// A retrieve has no queued phase: it starts once the overwrite confirmation (if any) is accepted.
				onStart: () => {
					op = this.activity?.beginOp("retrieve", `Retrieve ${p.refs.length} component${p.refs.length === 1 ? "" : "s"}`, "running");
				},
				onProgress: (done, total) => op?.retrieveProgress(done, total),
			});
			if (flow.cancelled || !flow.outcome) {
				op?.end("failed", "Cancelled");
				return cancel();
			}
			const out = flow.outcome;
			op?.end(out.failed.length > 0 ? "failed" : "done", out.failed.length > 0 ? `Retrieved ${out.retrieved.length}, ${out.failed.length} failed` : `Retrieved ${out.retrieved.length}`);
			this.post({
				type: "retrieveResult",
				results: [
					...out.retrieved.map((r) => ({ key: compKey(r.type, r.fullName), ok: true })),
					...out.failed.map((f) => ({ key: compKey(f.type, f.fullName), ok: false, error: f.error })),
				],
			});
			// The retrieved copies are the org's now: compare them again so the rows settle on Equal.
			void this.requestCompare(true, out.retrieved.map((r) => compKey(r.type, r.fullName)));
		} finally {
			op?.end("failed", "Interrupted");
			this.setBusy(null);
		}
	}

	// ── Delete from the org ──────────────────────────────────────────────────────

	private static async deleteFromWebview(msg: { [k: string]: any }): Promise<void> {
		const refs: { type: string; fullName: string }[] = Array.isArray(msg.items) ? msg.items.map((i: any) => ({ type: String(i.type), fullName: String(i.fullName) })) : [];
		await this.doDelete({
			refs,
			testLevel: String(msg.testLevel ?? ""),
			testNames: Array.isArray(msg.testClassNames) ? msg.testClassNames.map(String) : [],
		});
	}

	private static async doDelete(p: { refs: { type: string; fullName: string }[]; testLevel: string; testNames: string[] }): Promise<void> {
		const root = this.projectDir();
		const cancelled = () => this.post({ type: "deleteResult", cancelled: true });
		if (!root || !this.hasSfdxProject()) {
			void vscode.window.showErrorMessage("Delete from org: open an SFDX project first.");
			return cancelled();
		}
		if (this.orgKey === DEFAULT_ORG_KEY || !this.orgArg) {
			void vscode.window.showErrorMessage("Delete from org: choose an org first.");
			return cancelled();
		}
		if (p.refs.length === 0) return cancelled();
		if (this.busy) {
			this.post({ type: "toast", text: `A ${this.busy} is running.`, kind: "warn" });
			return cancelled();
		}
		// Only components that are not in the project may be deleted; the webview (or a History re-run) can be stale.
		if (!this.local) {
			void vscode.window.showWarningMessage("Delete from org: Local project not scanned yet.");
			return cancelled();
		}
		const localKeys = new Set<string>([...this.local.entries.values()].map((e) => orgLookupKey(e.type, e.name)));
		for (const k of partialObjectKeys(this.local.entries)) localKeys.add(rowKeyOf(k));
		const { keep, dropped } = onlyOrgRefs(p.refs, localKeys);
		if (keep.length === 0) {
			void vscode.window.showInformationMessage("Delete from org: nothing to delete, all selected components exist locally.");
			return cancelled();
		}
		p = { ...p, refs: keep };
		const skippedLine = dropped.length > 0 ? [`Skipped ${dropped.length} component(s) that exist locally: ${dropped.slice(0, 5).map((r) => `${r.type}:${r.fullName}`).join(", ")}${dropped.length > 5 ? ", …" : ""}`, ""] : [];
		const org = this.orgArg;
		const check = await checkOrgForDestructive(org, root);
		// The Delete section's own test options. An org that could not be verified counts as production.
		const testCheck = checkDeleteTestOptions(p.testLevel, p.testNames, p.refs.map((r) => r.type), check.production || !check.known);
		if (testCheck.error) {
			this.post({ type: "deleteResult", success: false, cancelled: false, error: testCheck.error });
			void vscode.window.showErrorMessage(`Delete from org not started: ${testCheck.error}`);
			return;
		}
		const n = p.refs.length;
		const who = check.username && check.username !== check.display ? `${check.display} (${check.username})` : check.display;
		const detail = [`Org: ${who}`, `Tests: ${p.testLevel}`, ...(testCheck.hint ? [testCheck.hint] : []), "", ...skippedLine, ...deleteListing(p.refs, 20), "", "This deletes the components from the org. It cannot be undone."].join("\n");
		const go = "Delete from org";
		const choice = await vscode.window.showWarningMessage(`Delete ${n} component${n === 1 ? "" : "s"} from ${check.display}?`, { modal: true, detail }, go);
		if (choice !== go) return cancelled();
		if (check.needsTypedConfirmation) {
			const typed = await vscode.window.showInputBox({
				title: `Delete from ${check.display}`,
				prompt: `${check.known ? "This is a production org." : "This org could not be verified and is treated as production."} Type ${check.confirmText} to confirm.`,
				ignoreFocusOut: true,
				validateInput: (v) => (confirmationMatches(v, check.confirmText) ? null : `Type ${check.confirmText}`),
			});
			if (!confirmationMatches(typed, check.confirmText)) return cancelled();
		}
		this.setBusy("delete");
		this.post({ type: "deleteStart" });
		const handle = OperationPanelProvider.beginOperation("Delete", org);
		const op = this.activity?.beginOp("delete", `Delete ${n} component${n === 1 ? "" : "s"} from ${check.display}`);
		try {
			const startedAt = Date.now();
			op?.running();
			const res = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Deleting ${n} component${n === 1 ? "" : "s"} from ${check.display}…`, cancellable: true },
				(_progress, token) => {
					// The notification's Cancel and the right panel's Cancel stop the same run.
					const merged = mergeTokens(token, op?.token);
					return deleteFromOrg({
						projectDir: root,
						org,
						components: p.refs,
						testLevel: p.testLevel,
						specifiedTests: p.testLevel === "RunSpecifiedTests" ? p.testNames : [],
						token: merged.token,
						onStatus: (s) => op?.live(s),
					}).finally(() => merged.dispose());
				}
			);
			const out = res.outcome;
			op?.settle(out);
			if (out.kind === "cancelled") this.post({ type: "deleteResult", cancelled: true, success: false });
			else this.post({ type: "deleteResult", success: out.kind === "success", cancelled: false, components: out.stats.components, componentErrors: out.stats.componentErrors, durationMs: res.durationMs });
			reportDeployOutcome({ run: { outcome: out, startedAt, durationMs: res.durationMs, handle }, dryRun: false, root, targetOrg: org, label: "Delete" });
			if (out.kind === "success") {
				await this.list(res.types);
				await this.refreshLocal();
			}
		} catch (e) {
			handle.dispose();
			const error = e instanceof Error ? e.message : String(e);
			op?.end("failed", error);
			this.post({ type: "deleteResult", success: false, cancelled: false, error });
			void vscode.window.showErrorMessage(`Delete from org not started: ${error}`);
		} finally {
			this.setBusy(null);
		}
	}

	private static setBusy(b: Busy | null): void {
		if (b && !this.busy) this.busyRoot = this.projectDir();
		this.busy = b;
		if (!b) this.busyRoot = undefined;
		this.post({ type: "busy", op: b });
		if (!b && this.switchPending) {
			this.switchPending = false;
			void this.onProjectChanged().catch((e) => Logger.error("Deploy & Retrieve Metadata project switch failed", e));
		}
	}

	// ── Diff ─────────────────────────────────────────────────────────────────────

	/** Newest modification time of the kept org copy (0 = none). */
	private static orgCopyMtime(files: Map<string, string> | undefined): number {
		let newest = 0;
		for (const abs of files?.values() ?? []) {
			try {
				newest = Math.max(newest, fs.statSync(abs).mtimeMs);
			} catch {
				/* vanished */
			}
		}
		return newest;
	}

	/**
	 * The diff of a row against the org copy kept by the content compare. A row changed in the org (or in conflict) whose
	 * kept copy is older than the org's last modification gets a fresh copy first, so the diff shows the latest org version.
	 */
	private static async openDiff(rowKey: string, status: string): Promise<void> {
		const root = this.projectDir();
		const lease = this.lease;
		const entry = this.byOrgKey.get(rowKey);
		if (!root || !lease || !entry) {
			this.post({ type: "toast", text: entry ? "The org is not loaded yet." : "This component is not in the project.", kind: "warn" });
			return;
		}
		const comp = this.compMap.get(rowKey);
		const type = comp?.t ?? entry.type;
		const name = comp?.n ?? orgLookupKey(entry.type, entry.name).slice(entry.type.length + 1);
		lease.setTypes(this.types);
		if (comp && (status === "changed-in-org" || status === "conflict")) {
			const kept = lease.service.orgCopyFiles(rowKey);
			if (!kept || this.orgCopyMtime(kept) < comp.lm) {
				try {
					await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Retrieving the latest ${name} from the org…` }, () => lease.service.fetchOrgCopy({ type, name }));
				} catch (e) {
					Logger.info(`Deploy & Retrieve Metadata: could not refresh the org copy of ${rowKey}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
				}
			}
		}
		await openComponentDiff(lease, { key: rowKey, type, name, files: localFilesOf(root, this.types, entry) }, root);
	}

	private static async openSetup(type: string, name: string): Promise<void> {
		const comp = this.compMap.get(compKey(type, name));
		const target = setupTarget(type, name, comp?.id ?? "");
		if (target.quickFind) {
			await vscode.env.clipboard.writeText(name);
			vscode.window.setStatusBarMessage(`Opening Setup — “${name}” copied for Quick Find`, 4000);
		} else {
			vscode.window.setStatusBarMessage(`Opening ${name} in Setup…`, 3000);
		}
		try {
			await openOrgPath(this.orgArg, target.path, this.projectDir());
		} catch (e: any) {
			void vscode.window.showErrorMessage(`Couldn’t open Setup: ${String(e?.message ?? e).slice(0, 300)}`);
		}
	}

	// ── Presets ──────────────────────────────────────────────────────────────────

	private static async savePresetFromWebview(msg: { [k: string]: any }): Promise<void> {
		const root = this.projectDir();
		if (!root) return;
		const components = Array.isArray(msg.components) ? msg.components.filter((k: unknown): k is string => typeof k === "string") : [];
		let name = String(msg.presetName ?? "").trim();
		try {
			if (!name) {
				const input = await vscode.window.showInputBox({ title: "Save as preset", prompt: "Enter a name for this preset", validateInput: (v) => (!v || !v.trim() ? "Name is required" : null) });
				if (!input?.trim()) return;
				name = input.trim();
			}
			await savePreset(root, {
				name,
				sourcePaths: this.local ? relativeFilesOf(components, this.local.entries, root) : [],
				components,
				deployType: (msg.deployType || "RunRelevantTests") as any,
				testClassNames: Array.isArray(msg.testClassNames) ? msg.testClassNames.map(String) : [],
				targetOrg: msg.targetOrg || undefined,
				...(msg.validateOnly ? { validateOnly: true } : {}),
			} as Parameters<typeof savePreset>[1]);
			this.post({ type: "presetSaved", name });
			void vscode.window.showInformationMessage(`Preset "${name}" saved.`);
		} catch (e) {
			void vscode.window.showErrorMessage("Failed to save preset: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	// ── History ──────────────────────────────────────────────────────────────────

	private static entryOf(id: string): HistoryEntry | undefined {
		const root = this.projectDir();
		return root ? getHistory(root).find((e) => e.id === id) : undefined;
	}

	/** The entry ran against the org the panel shows (by username, alias-insensitive). */
	private static sameOrg(entryOrg: string): boolean {
		const norm = (o: string) => (getOrgByTarget(o)?.username ?? o).toLowerCase();
		return norm(entryOrg) === norm(this.orgKey);
	}

	private static async historyOpenSetup(id: string): Promise<void> {
		const e = this.entryOf(id);
		if (!e?.deployId) return;
		try {
			await openOrgPath(e.org || this.orgArg, deploymentSetupPath(e.deployId), this.projectDir());
		} catch (err: any) {
			void vscode.window.showErrorMessage(`Couldn’t open Setup: ${String(err?.message ?? err).slice(0, 300)}`);
		}
	}

	/** Run an entry again: same kind, same components, same test level; asks first. A delete goes through the full delete confirmation. */
	private static async historyRerun(id: string, checkedTests: string[]): Promise<void> {
		const e = this.entryOf(id);
		if (!e || !this.local) return;
		if (!this.sameOrg(e.org)) {
			void vscode.window.showWarningMessage(`This entry ran against ${e.org}. Switch the panel to that org to run it again.`);
			return;
		}
		const n = Math.max(e.componentCount, e.components.length);
		const verb = e.kind === "validate" ? "Validate" : e.kind === "deploy" ? "Deploy" : e.kind === "retrieve" ? "Retrieve" : "Delete";
		// The tests the entry recorded; when it recorded none, the classes checked in the Deploy section.
		const tests = resolveRunTests(e.tests, e.testLevel === "RunSpecifiedTests" ? checkedTests : []);
		if (e.kind === "delete") {
			await this.doDelete({ refs: e.components.map(refOfKey), testLevel: e.testLevel || "RunLocalTests", testNames: tests });
			return;
		}
		const detail = `${n} component${n === 1 ? "" : "s"}${e.testLevel ? ` · ${e.testLevel}` : ""} · ${this.orgLabel()}`;
		const ok = await vscode.window.showWarningMessage(`${verb} these ${n} component${n === 1 ? "" : "s"} again?`, { modal: true, detail }, verb);
		if (ok !== verb) return;
		if (e.kind === "retrieve") {
			await this.doRetrieve({ refs: e.components.map(refOfKey), confirm: true });
			return;
		}
		const locals = [...this.local.entries.values()];
		const r = historyDeployLocalKeys(e.components, locals, OBJECT_CHILD_TYPES);
		if (r.keys.length === 0) {
			void vscode.window.showErrorMessage("None of the components of this entry is in the project any more.");
			return;
		}
		if (r.missing > 0) this.status(`${r.missing} component${r.missing === 1 ? " is" : "s are"} not in the project any more and are left out.`);
		if (e.testLevel === "RunSpecifiedTests" && tests.length === 0) {
			void vscode.window.showWarningMessage("This entry ran specified tests that were not recorded. Check the test classes in the Deploy section (or pick a suite) and re-run.");
			return;
		}
		await this.doDeploy({ localKeys: r.keys, testLevel: e.testLevel || "RunLocalTests", testNames: tests, dryRun: e.kind === "validate", label: e.label });
	}

	// ── HTML ─────────────────────────────────────────────────────────────────────

	private static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "resources", "webview", "syncCenter.js"));
		const nonce = getNonce();
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");
		return syncCenterHtml({
			nonce,
			csp,
			scriptUri: String(scriptUri),
			selectorScript: projectSelectorScript("window.__asfxApi"),
			testLevels: [
				{ value: "NoTestRun", label: DEPLOY_TYPE_NO_TESTS },
				{ value: "RunAllTestsInOrg", label: DEPLOY_TYPE_RUN_ALL },
				{ value: "RunRelevantTests", label: DEPLOY_TYPE_RUN_RELEVANT },
				{ value: "RunSpecifiedTests", label: DEPLOY_TYPE_SPECIFIED },
			],
		});
	}
}
