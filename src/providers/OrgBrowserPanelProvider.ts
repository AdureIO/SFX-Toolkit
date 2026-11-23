import * as vscode from "vscode";
import * as path from "path";
import { AuthInfo } from "../utils/authInfo";
import { runCommandArgs } from "../utils/commandRunner";
import { getToolingApiVersion } from "../utils/constants";
import { getDefaultOrgSync } from "../utils/defaultOrg";
import { onDidChangeDefaultOrg } from "../utils/defaultOrgEvents";
import { getNonce } from "../utils/htmlUtils";
import { Logger } from "../utils/outputChannel";
import { DEFAULT_ORG_KEY, canonicalOrgKey, orgArgForKey } from "../utils/orgKey";
import { getOrgByTarget, getOrgListForPicker, onOrgListUpdated } from "../utils/orgListCache";
import { primaryProjectRoot, isSalesforceProject } from "../utils/projectUtils";
import { PanelProjectBinding } from "../utils/panelProject";
import { PROJECT_SELECTOR_CSS, projectSelectorMarkup, projectSelectorScript } from "../utils/panelProjectUi";
import { SharedMetadataFilter } from "../utils/sharedFilterState";
import { FILTER_BAR_CSS, FILTER_BAR_VARS, filterGroupsMarkup, filterSearchMarkup } from "../utils/filterBarUi";
import { confirmOverwrite, revertOpenEditors } from "../utils/retrieveSafety";
import { retrieveComponents } from "../utils/retrieveEngine";
import { recordHistory } from "../utils/syncHistory";
import { historyErrorsFromRetrieve } from "../utils/historyPure";
import { getRetrieveTimes } from "../utils/retrieveLog";
import { LocalInfoMap, ContentInfoMap } from "../utils/compareStatusPure";
import { CompareTarget } from "../utils/contentCompare";
import { innerFilesOfEntry } from "../utils/contentComparePure";
import { CompareLease, acquireCompare, compareMode } from "../utils/contentCompareHost";
import { readLocalInfo } from "../utils/localChangeInfo";
import { orgLookupKey } from "../utils/deployStatusPure";
import { DeployMetadataPanelProvider } from "./DeployMetadataPanelProvider";
import { classifyHealth } from "../utils/schemaHealth";
import { reauthenticateOrg } from "../commands/orgCommands";
import { metadataDiffForFile } from "../commands/metadataDiff";
import {
	ListCancelled,
	ListingCache,
	ListProgress,
	expandOnlyTypes,
	listOrgMetadata,
	loadListingCache,
	mergeTypeRefresh,
	saveListingCache,
} from "../utils/orgBrowser/metadataLister";
import { hiddenSelectionPrompt, splitByVisibility } from "../utils/orgBrowser/selection";
import { LocalEntry, LocalIndex, buildTypeTable, overwriteTargets, partialObjectKeys, readPackageDirectories, scanProject } from "../utils/orgBrowser/localIndex";
import { makeSoapCall } from "../utils/orgBrowser/soapTransport";
import { setupTarget } from "../utils/orgBrowser/setupUrl";
import { Comp, ListFailure, TypeInfo, compKey } from "../utils/orgBrowser/types";

const UI_STATE_KEY = "adure-sfx-toolkit.orgBrowser.ui";
const CHUNK = 4000;

interface OrgOpt {
	label: string;
	username: string;
	isDefault: boolean;
}

/**
 * Org Browser: every metadata component of an org with fast search / filters, and retrieve into the
 * local project. Singleton webview panel; re-opening for another org switches org.
 */
export class OrgBrowserPanelProvider {
	public static readonly viewType = "adure-sfx-toolkit.orgBrowser";

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
	/** The shared content-compare service of (project, org). */
	private static lease: CompareLease | undefined;
	private static leaseSubs: { dispose(): void }[] = [];
	private static compareTimer: ReturnType<typeof setTimeout> | undefined;
	private static infoTimer: ReturnType<typeof setTimeout> | undefined;
	/** The project the panel shows (project selector); follows the active project until the user picks another. */
	private static binding: PanelProjectBinding | undefined;

	/** Dir of the project the panel works on. */
	private static projectDir(): string | undefined {
		return this.binding?.current() ?? primaryProjectRoot();
	}

	/** The panel's project is an SFDX project (retrieve and the local index need source format). */
	private static hasSfdxProject(): boolean {
		const p = this.binding?.currentProject();
		return p ? p.kind === "sfdx" : isSalesforceProject();
	}

	/** The project of the panel changed: rebuild everything bound to it, as if the panel were newly opened. */
	private static async onProjectChanged(): Promise<void> {
		if (!this.panel) return;
		this.userPicked = false;
		for (const d of this.watchers) d.dispose();
		this.watchers = [];
		this.setupWatchers();
		await this.sendInit();
		await this.loadOrg(null);
	}

	/** Call once on activation. */
	public static init(context: vscode.ExtensionContext): void {
		this.ctx = context;
	}

	/** Open (or reveal) the browser; `org` (alias or username) switches it to that org. */
	public static async show(org?: string | null): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		if (this.panel) {
			this.panel.reveal(column);
			if (org) {
				this.userPicked = true;
				await this.loadOrg(org);
			}
			return;
		}
		this.userPicked = !!org;
		const panel = vscode.window.createWebviewPanel(this.viewType, "Org Browser", column, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "resources")],
		});
		this.panel = panel;
		panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "resources", "icon.png");
		panel.webview.html = this.getHtml(panel.webview, ctx.extensionUri);

		const initialOrg: string | null = org ?? null;
		const binding = new PanelProjectBinding();
		this.binding = binding;
		this.disposables.push(
			binding,
			binding.attach(panel.webview),
			binding.onDidChange(() => void this.onProjectChanged().catch((e) => Logger.error("Org Browser project switch failed", e))),
			panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg, () => initialOrg).catch((e) => Logger.error("Org Browser message failed", e))),
			onDidChangeDefaultOrg(async () => {
				await this.sendOrgs();
				if (!this.userPicked) await this.loadOrg(null);
			}),
			{ dispose: onOrgListUpdated(() => void this.sendOrgs()) }
		);
		this.setupWatchers();
		panel.onDidDispose(() => this.dispose());
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
		this.releaseLease();
		this.byOrgKey = new Map();
		this.binding = undefined;
		// Release the (potentially 50k-row) listing.
		this.comps = [];
		this.compMap = new Map();
		this.local = undefined;
	}

	private static post(msg: Record<string, unknown>): void {
		void this.panel?.webview.postMessage(msg);
	}

	// ── Messages from the webview ────────────────────────────────────────────────

	private static async onMessage(msg: { command: string; [k: string]: any }, initialOrg: () => string | null): Promise<void> {
		const pair = () => ({ t: String(msg.t ?? ""), n: String(msg.n ?? "") });
		switch (msg.command) {
			case "ready": {
				await this.sendInit();
				await this.loadOrg(this.userPicked && this.orgKey !== DEFAULT_ORG_KEY ? this.orgKey : initialOrg());
				break;
			}
			case "selectOrg":
				this.userPicked = true;
				await this.loadOrg(String(msg.org));
				break;
			case "refresh":
				if (this.orgKey === DEFAULT_ORG_KEY) await this.loadOrg(null);
				else await this.list();
				break;
			case "refreshTypes":
				if (Array.isArray(msg.types) && msg.types.length > 0) await this.list(msg.types.map(String));
				break;
			case "retrieve":
				await this.retrieve(
					Array.isArray(msg.items) ? msg.items.map((i: any) => ({ type: String(i.t), fullName: String(i.n) })) : [],
					Array.isArray(msg.visible) ? new Set<string>(msg.visible.map(String)) : undefined
				);
				break;
			case "setup":
				await this.openSetup(pair().t, pair().n);
				break;
			case "compareContents":
				// The "Compare contents" button: what needs it, or (force) the components the filter shows, again.
				void this.requestCompare(msg.force === true, Array.isArray(msg.keys) ? msg.keys.map(String) : undefined);
				break;
			case "compare": {
				const e = this.entryFor(pair().t, pair().n);
				if (!e) {
					this.post({ type: "toast", text: "This component is not in the project.", kind: "warn" });
					break;
				}
				await metadataDiffForFile(e.primary, this.orgArg);
				break;
			}
			case "reveal": {
				const e = this.entryFor(pair().t, pair().n);
				if (e) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(e.root ?? e.primary));
				break;
			}
			case "openFile": {
				const e = this.entryFor(pair().t, pair().n);
				if (e) await vscode.window.showTextDocument(vscode.Uri.file(e.primary));
				break;
			}
			case "copy":
				if (typeof msg.text === "string") await vscode.env.clipboard.writeText(msg.text);
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
			case "sharedFilter":
				SharedMetadataFilter.set(this.projectDir(), { query: msg.query, types: msg.types }, "orgBrowser");
				break;
		}
	}

	// ── Init / org list ──────────────────────────────────────────────────────────

	private static async orgOptions(): Promise<OrgOpt[]> {
		const list = await getOrgListForPicker().catch(() => []);
		const def = getDefaultOrgSync(this.projectDir())?.username ?? null;
		const out: OrgOpt[] = [];
		for (const o of list) {
			const rec = getOrgByTarget(o.username);
			if (rec?.isExpired) continue;
			out.push({ label: rec?.alias || o.username, username: o.username, isDefault: o.username === def });
		}
		return out;
	}

	private static async sendInit(): Promise<void> {
		const root = this.projectDir();
		const orgs = await this.orgOptions();
		const key = canonicalOrgKey(null, root);
		this.post({
			type: "init",
			orgs,
			org: key === DEFAULT_ORG_KEY ? null : key,
			hasProject: !!root && this.hasSfdxProject(),
			projectName: root ? path.basename(root) : "",
			ui: this.ctx?.workspaceState.get(UI_STATE_KEY) ?? null,
			shared: SharedMetadataFilter.get(root),
		});
	}

	private static async sendOrgs(): Promise<void> {
		if (!this.panel) return;
		this.post({ type: "orgs", orgs: await this.orgOptions(), org: this.orgKey === DEFAULT_ORG_KEY ? null : this.orgKey });
	}

	// ── Loading an org ───────────────────────────────────────────────────────────

	private static cacheDir(): string {
		return path.join(this.ctx!.globalStorageUri.fsPath, "org-browser");
	}

	private static apiVersion(): string {
		return getToolingApiVersion().replace(/^v/, "");
	}

	private static setComps(comps: Comp[]): void {
		this.comps = comps;
		const map = new Map<string, Comp>();
		for (const c of comps) map.set(compKey(c.t, c.n), c);
		this.compMap = map;
	}

	private static async loadOrg(org: string | null): Promise<void> {
		if (!this.panel) return;
		const gen = ++this.gen;
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

		if ((await this.orgOptions()).length === 0) {
			this.post({ type: "orgs", orgs: [], org: null });
			return;
		}
		if (key === DEFAULT_ORG_KEY) {
			this.post({ type: "loadError", state: "noDefaultOrg", message: "No default org is set. Choose an org to browse its metadata." });
			void this.refreshLocal();
			return;
		}
		void this.acquireLease(key, gen);
		void this.refreshLocal();
		void this.resolveMe(gen);

		const cache = await loadListingCache(this.cacheDir(), key);
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
			const ver = this.apiVersion();
			const { body } = await AuthInfo.get(this.orgArg, (a) => {
				const soql = `SELECT Id, Name FROM User WHERE Username = '${a.username.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' LIMIT 1`;
				return `${a.instanceUrl}/services/data/v${ver}/query?q=${encodeURIComponent(soql)}`;
			});
			const rec = JSON.parse(body)?.records?.[0];
			if (gen === this.gen) this.post({ type: "me", ids: rec?.Id ? [rec.Id] : [], name: rec?.Name ?? "" });
		} catch (e: any) {
			Logger.info(`Org Browser: could not resolve the current user: ${e?.message ?? e}`);
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

		let buf: Comp[] = [];
		let lastProgress: ListProgress = { done: 0, total: 0, label: "" };
		let lastFlush = 0;
		const flush = () => {
			if (gen !== this.gen) return;
			this.post({ type: "batch", comps: buf, done: lastProgress.done, total: lastProgress.total, label: lastProgress.label });
			buf = [];
			lastFlush = Date.now();
		};
		try {
			const result = await listOrgMetadata({
				call: makeSoapCall(this.orgArg, this.apiVersion()),
				apiVersion: this.apiVersion(),
				knownTypes: only && this.types.length > 0 ? this.types : undefined,
				only: expanded,
				isCancelled,
				onTypes: (t) => {
					if (!only) this.post({ type: "types", types: t });
				},
				onBatch: (comps, progress) => {
					lastProgress = progress;
					buf.push(...comps);
					if (buf.length >= 1500 || Date.now() - lastFlush >= 150) flush();
				},
			});
			if (isCancelled()) return;
			flush();
			const now = Date.now();
			let cache: ListingCache;
			if (expanded) {
				const base: ListingCache = {
					v: 1,
					orgKey: this.orgKey,
					apiVersion: this.apiVersion(),
					listedAt: this.listedAt || now,
					types: this.types,
					comps: this.comps,
					failures: this.failures,
					typeListedAt: this.typeListedAt,
				};
				cache = mergeTypeRefresh(base, expanded, result, now);
				cache.listedAt = this.listedAt || now;
			} else {
				cache = { v: 1, orgKey: this.orgKey, apiVersion: this.apiVersion(), listedAt: now, types: result.types, comps: result.comps, failures: result.failures };
			}
			this.types = expanded ? this.types : result.types;
			this.failures = cache.failures;
			this.listedAt = expanded ? now : cache.listedAt;
			this.typeListedAt = cache.typeListedAt ?? {};
			this.setComps(cache.comps);
			this.post({ type: "loadEnd", listedAt: this.listedAt, failures: this.failures, types: this.types, dropTypes: expanded });
			void this.refreshLocal();
			await saveListingCache(this.cacheDir(), { ...cache, types: this.types }).catch((e) => Logger.error("Org Browser: could not write the listing cache", e));
		} catch (e: any) {
			if (e instanceof ListCancelled || isCancelled()) return;
			if (buf.length > 0) flush();
			const msg = String(e?.message ?? e).replace(/\s+/g, " ").trim();
			const health = classifyHealth(e, this.orgKey);
			Logger.error("Org Browser: listing failed", msg);
			const label =
				this.orgKey === DEFAULT_ORG_KEY
					? getDefaultOrgSync(this.projectDir())?.displayName || "the default org"
					: getOrgByTarget(this.orgKey)?.alias || this.orgKey;
			let state: string = health.state;
			let text: string;
			if (health.state === "authInvalid") {
				text = health.scratchExpired
					? `The scratch org ${label} has expired or was deleted. Choose another org.`
					: `The connection to ${label} is expired or invalid. Re-authenticate to continue.`;
			} else if (health.state === "noDefaultOrg") {
				text = "No default org is set. Choose an org to browse its metadata.";
			} else {
				state = "unreachable";
				text = `Couldn’t reach ${label}: ${msg.slice(0, 240)}`;
			}
			this.post({ type: "loadError", state, message: text });
		} finally {
			if (this.run === run) this.run = undefined;
		}
	}

	// ── Local index ──────────────────────────────────────────────────────────────

	private static async refreshLocal(): Promise<void> {
		if (!this.panel) return;
		const gen = this.gen;
		const root = this.projectDir();
		if (!root || !this.hasSfdxProject()) {
			this.post({ type: "local", keys: [], partial: [], retrieved: {}, hasProject: false });
			return;
		}
		try {
			const dirs = readPackageDirectories(root);
			const index = await scanProject(root, dirs.length > 0 ? dirs : ["force-app"], buildTypeTable(this.types));
			if (gen !== this.gen || !this.panel) return;
			this.local = index;
			this.byOrgKey = new Map([...index.entries.values()].map((e) => [orgLookupKey(e.type, e.name), e]));
			this.post({ type: "local", keys: [...this.byOrgKey.keys()], partial: partialObjectKeys(index.entries), retrieved: getRetrieveTimes(this.orgKey === DEFAULT_ORG_KEY ? null : this.orgKey), hasProject: true });
			await this.refreshLocalInfo();
		} catch (e: any) {
			Logger.error("Org Browser: local scan failed", e?.message ?? e);
		}
	}

	// ── Content compare ──────────────────────────────────────────────────────────

	private static entryFor(type: string, name: string): LocalEntry | undefined {
		return this.byOrgKey.get(compKey(type, name)) ?? this.local?.entries.get(compKey(type, name));
	}

	private static releaseLease(): void {
		for (const d of this.leaseSubs) d.dispose();
		this.leaseSubs = [];
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
			service.onDidUpdate((localKeys) => this.post({ type: "compareContent", full: false, content: this.toOrgKeys(service.contentInfo(localKeys)) })),
			service.onDidProgress((progress) => this.post({ type: "compareProgress", progress }))
		);
		await service.load();
		if (gen !== this.gen || this.lease !== lease) return;
		this.post({ type: "compareProgress", progress: service.progress() });
		await this.pushContent();
	}

	/** Content results are keyed by the local index's key; this panel's rows use the org listing's key. */
	private static toOrgKeys<T>(m: Record<string, T>): Record<string, T> {
		const out: Record<string, T> = {};
		for (const [k, v] of Object.entries(m)) {
			const e = this.local?.entries.get(k);
			out[e ? orgLookupKey(e.type, e.name) : k] = v;
		}
		return out;
	}

	/** Local components that are in the listing, ready for the compare service (`orgKeys`: only these). */
	private static compareTargets(orgKeys?: Iterable<string>): CompareTarget[] {
		const root = this.projectDir();
		if (!root) return [];
		const dirs = readPackageDirectories(root);
		const pkgAbs = (dirs.length > 0 ? dirs : ["force-app"]).map((d) => path.resolve(root, d));
		const table = buildTypeTable(this.types);
		const list = orgKeys ? [...orgKeys].map((k) => this.byOrgKey.get(k)).filter((e): e is LocalEntry => !!e) : [...this.byOrgKey.values()];
		const out: CompareTarget[] = [];
		for (const e of list) {
			const c = this.compMap.get(orgLookupKey(e.type, e.name));
			if (!c) continue;
			out.push({ key: e.key, type: e.type, name: e.name, orgLm: c.lm, files: innerFilesOfEntry(e, pkgAbs, table) });
		}
		return out;
	}

	private static async pushContent(): Promise<void> {
		const lease = this.lease;
		if (!lease) return;
		lease.setTypes(this.types);
		const content: ContentInfoMap = this.toOrgKeys(await lease.service.validContentInfo(this.compareTargets()));
		if (this.lease !== lease) return;
		this.post({ type: "compareContent", full: true, content });
	}

	/** Local change times + git dirty per component, then the compare results that are still valid. */
	private static async refreshLocalInfo(): Promise<void> {
		const root = this.projectDir();
		const gen = this.gen;
		if (!root || !this.local || !this.panel || !this.hasSfdxProject()) return;
		let dirty: string[] | null = null;
		try {
			dirty = await DeployMetadataPanelProvider.runGitStatusSfdxPaths(root);
		} catch {
			dirty = null; // not a git repository: file times only
		}
		const dirs = readPackageDirectories(root);
		const local: LocalInfoMap = await readLocalInfo(root, this.local.entries.values(), dirs.length > 0 ? dirs : ["force-app"], dirty);
		if (gen !== this.gen || !this.panel) return;
		this.post({ type: "compareLocal", local: this.toOrgKeys(local) });
		await this.pushContent();
		this.scheduleCompare(0);
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

	// ── Retrieve ─────────────────────────────────────────────────────────────────

	/**
	 * @param visibleKeys keys the current filter shows; when given and some of `components` are not in it,
	 *   the user is asked whether to retrieve the hidden ones too. Omitted for single-row retrieves.
	 */
	private static async retrieve(components: { type: string; fullName: string }[], visibleKeys?: ReadonlySet<string>): Promise<void> {
		const root = this.projectDir();
		if (!root || !this.hasSfdxProject()) {
			this.post({ type: "toast", text: "Open an SFDX project to retrieve.", kind: "warn" });
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			return;
		}
		if (components.length === 0) {
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			return;
		}
		if (visibleKeys) {
			const { visible, hidden } = splitByVisibility(components.map((c) => compKey(c.type, c.fullName)), visibleKeys);
			if (hidden.length > 0) {
				const { message, detail } = hiddenSelectionPrompt(components.length, hidden);
				const all = `Retrieve all ${components.length}`;
				const only = `Retrieve visible ${visible.length} only`;
				const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, all, ...(visible.length > 0 ? [only] : []));
				if (choice === only) {
					const keep = new Set(visible);
					components = components.filter((c) => keep.has(compKey(c.type, c.fullName)));
				} else if (choice !== all) {
					this.post({ type: "retrieveResult", results: [], cancelled: true });
					return;
				}
			}
		}
		const targets = [...new Set(components.flatMap((c) => {
			const e = this.entryFor(c.type, c.fullName);
			return e ? overwriteTargets(e) : [];
		}))];
		if (!(await confirmOverwrite(targets, "Retrieve"))) {
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			return;
		}
		const label =
				this.orgKey === DEFAULT_ORG_KEY
					? getDefaultOrgSync(this.projectDir())?.displayName || "the default org"
					: getOrgByTarget(this.orgKey)?.alias || this.orgKey;
		let outcome: Awaited<ReturnType<typeof retrieveComponents>> | undefined;
		let cancelled = false;
		const startedAt = Date.now();
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Retrieving ${components.length} component${components.length === 1 ? "" : "s"} from ${label}…`, cancellable: true },
			async (progress, token) => {
				let reported = 0;
				try {
					outcome = await retrieveComponents({
						org: this.orgArg,
						components,
						projectDir: root,
						token,
						onProgress: (done, total) => {
							progress.report({ message: `${done}/${total}`, increment: ((done - reported) / total) * 100 });
							reported = done;
						},
					});
				} catch (e: any) {
					if (e?.cancelled) cancelled = true;
					else throw e;
				}
			}
		).then(undefined, (e) => {
			Logger.error("Org Browser: retrieve failed", e);
			vscode.window.showErrorMessage(`Retrieve failed: ${e?.message ?? e}`);
			cancelled = true;
		});
		await revertOpenEditors(targets);
		await this.refreshLocal();
		if (cancelled || !outcome) {
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			if (cancelled) vscode.window.setStatusBarMessage("Retrieve cancelled", 3000);
			return;
		}
		recordHistory(root, {
			kind: "retrieve",
			org: this.orgArg ?? getDefaultOrgSync(root)?.username ?? label,
			at: startedAt,
			durationMs: Date.now() - startedAt,
			components: components.map((c) => compKey(c.type, c.fullName)),
			ok: outcome.failed.length === 0,
			errors: outcome.failed.length > 0 ? historyErrorsFromRetrieve(outcome.failed) : undefined,
			source: "orgBrowser",
		});
		const results = [
			...outcome.retrieved.map((r) => ({ key: compKey(r.type, r.fullName), ok: true })),
			...outcome.failed.map((f) => ({ key: compKey(f.type, f.fullName), ok: false, error: f.error })),
		];
		this.post({ type: "retrieveResult", results });
		const ok = outcome.retrieved.length;
		const bad = outcome.failed.length;
		for (const f of outcome.failed) Logger.info(`Retrieve failed: ${f.type}:${f.fullName} — ${f.error}`);
		const text = bad > 0 ? `Retrieved ${ok}, ${bad} failed` : `Retrieved ${ok} component${ok === 1 ? "" : "s"}`;
		if (bad > 0) {
			void vscode.window.showWarningMessage(text, "Show Output").then((pick) => {
				if (pick) void vscode.commands.executeCommand("adure-sfx-toolkit.showOutput");
			});
		} else {
			void vscode.window.showInformationMessage(text);
		}
	}

	// ── Setup ────────────────────────────────────────────────────────────────────

	private static async openSetup(type: string, name: string): Promise<void> {
		const comp = this.compMap.get(compKey(type, name));
		const target = setupTarget(type, name, comp?.id ?? "");
		const args = ["org", "open", "--path", target.path];
		if (this.orgArg) args.push("--target-org", this.orgArg);
		if (target.quickFind) {
			await vscode.env.clipboard.writeText(name);
			vscode.window.setStatusBarMessage(`Opening Setup — “${name}” copied for Quick Find`, 4000);
		} else {
			vscode.window.setStatusBarMessage(`Opening ${name} in Setup…`, 3000);
		}
		try {
			await runCommandArgs("sf", args, this.projectDir(), undefined, false);
		} catch (e: any) {
			vscode.window.showErrorMessage(`Couldn’t open Setup: ${String(e?.message ?? e).slice(0, 300)}`);
		}
	}

	// ── HTML ─────────────────────────────────────────────────────────────────────

	private static getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "resources", "webview", "orgBrowser.js"));
		const nonce = getNonce();
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Org Browser</title>
<style>
${CSS}
${PROJECT_SELECTOR_CSS}
.top .asfx-project { margin-left: 0; }
</style>
</head>
<body>
<div id="app">
  <div class="top">
    ${projectSelectorMarkup()}
    <select id="org" aria-label="Org"></select>
    ${filterSearchMarkup("Search name or type…   type:ApexClass  ns:abc  by:smith  status:changed  Acc*Handler  ApexClass:Foo   ( / )")}
    <span id="listedInfo" class="muted"></span>
    <button id="refreshBtn" class="ghost" title="Re-list every type from the org">↻ Refresh</button>
    <span id="cmpInfo" class="muted"></span>
    <button id="cmpBtn" class="ghost" title="Compare the contents of the components that are in the project with the org (the ones that need it; with a filter active: the shown ones again)">≈ Compare contents</button>
    <span class="spacer"></span>
    <span id="selHidden" class="selhidden" hidden><span id="selHiddenText"></span> <button id="selHiddenShow" class="link" title="Reset the filters and show only the selected components">show</button> · <button id="selHiddenClear" class="link" title="Deselect the selected components the current filter hides">clear hidden</button></span>
    <span id="selChip" class="selchip" hidden><button id="selChipText" title="Show only the selected components"></button><button id="selChipClear" title="Clear selection" aria-label="Clear selection">×</button></span>
    <button id="retrieveBtn" class="primary" disabled>Retrieve (0)</button>
  </div>
  <div id="progress" class="progress" hidden><div id="progressBar"></div></div>
  <div id="banner"></div>
  <div class="main">
    <aside id="side" aria-label="Filters">${filterGroupsMarkup({ statusTitle: "Local vs org" })}
    </aside>
    <section class="center">
      <div class="gridbar">
        <span id="countInfo" class="muted"></span>
        <button id="selAll" class="linkbtn">Select all filtered (0)</button>
        <span class="spacer"></span>
        <label class="inl"><input type="checkbox" id="groupToggle"> Group by type</label>
        <button id="collapseAll" class="linkbtn" title="Collapse / expand all groups">Collapse all</button>
      </div>
      <div class="gridwrap">
        <div id="scroller" class="scroller" tabindex="0" role="grid" aria-label="Metadata components">
          <div class="inner">
            <div class="ghead" role="row">
              <span class="hcell cb"><input type="checkbox" id="headCb" aria-label="Select all filtered"></span>
              <span class="hcell" data-sort="name">Name</span>
              <span class="hcell" data-sort="type">Type<i class="grip" data-col="type"></i></span>
              <span class="hcell" data-sort="ns">Namespace<i class="grip" data-col="ns"></i></span>
              <span class="hcell" data-sort="by">Last modified by<i class="grip" data-col="by"></i></span>
              <span class="hcell" data-sort="modified">Last modified<i class="grip" data-col="mod"></i></span>
              <span class="hcell" data-sort="status">Local vs org<i class="grip" data-col="status"></i></span>
              <span class="hcell"></span>
            </div>
            <div id="spacer" class="vspacer"><div id="rowsEl" class="rowsEl"></div></div>
          </div>
        </div>
        <div id="overlay" class="overlay" hidden></div>
      </div>
      <div id="failBox" class="failbox" hidden></div>
    </section>
  </div>
</div>
<div id="menu" class="menu" role="menu" hidden></div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">${projectSelectorScript("window.__asfxApi")}</script>
</body>
</html>`;
	}
}

const CSS = `
${FILTER_BAR_CSS}
*,*::before,*::after { box-sizing: border-box; }
:root {
  ${FILTER_BAR_VARS}
  --cols: 34px minmax(180px,1fr) 150px 90px 150px 120px 130px 132px;
  --minw: 986px;
}
[hidden] { display: none !important; }
html, body { height: 100%; }
body { margin: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; }
#app { height: 100vh; display: flex; flex-direction: column; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 1px solid var(--ob-accent); outline-offset: 1px; }
.spacer { flex: 1; min-width: 8px; }
.top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--ob-border); flex-wrap: wrap; flex-shrink: 0; }
select, input[type="text"], input[type="date"] { height: 28px; padding: 0 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--ob-border)); border-radius: 4px; font: inherit; }
select { max-width: 240px; }
select:focus, input:focus { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; border-radius: 4px; height: 28px; padding: 0 14px; font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.ghost { background: transparent; border: 1px solid var(--ob-border); border-radius: 4px; height: 28px; padding: 0 10px; }
button.ghost:hover:not(:disabled) { background: var(--ob-hover); }
.selhidden { font-size: 11px; color: var(--vscode-descriptionForeground); margin-right: 6px; white-space: nowrap; }
.selhidden .link { background: transparent; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; font: inherit; }
.selchip { display: inline-flex; align-items: center; border: 1px solid var(--ob-border-strong); border-radius: 999px; overflow: hidden; }
.selchip button { background: transparent; border: 0; padding: 3px 9px; }
.selchip button:hover { background: var(--ob-hover); }
.selchip.on { border-color: var(--ob-accent); background: color-mix(in srgb, var(--ob-accent) 16%, transparent); }
.progress { height: 2px; background: var(--ob-border); flex-shrink: 0; }
#progressBar { height: 100%; width: 0; background: var(--ob-accent); transition: width .2s; }
.bn { padding: 6px 12px; font-size: 12px; border-bottom: 1px solid var(--ob-border); }
.bn.err { background: color-mix(in srgb, var(--ob-bad) 14%, transparent); }
.bn.info { background: color-mix(in srgb, var(--ob-accent) 10%, transparent); }
.bn button { margin-left: 8px; }
.main { flex: 1; display: flex; min-height: 0; }
#side { width: 248px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--ob-border); background: var(--ob-surface); padding: 6px 10px 12px; }
.center { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.gridbar { display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-bottom: 1px solid var(--ob-border); font-size: 12px; flex-shrink: 0; }
.inl { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.gridwrap { position: relative; flex: 1; min-height: 0; }
.scroller { position: absolute; inset: 0; overflow: auto; outline: none; }
.inner { min-width: var(--minw); }
.ghead { position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: var(--cols); height: 30px; align-items: center; background: var(--vscode-editor-background); border-bottom: 1px solid var(--ob-border-strong); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
.hcell { position: relative; padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: 100%; display: flex; align-items: center; user-select: none; }
.hcell[data-sort] { cursor: pointer; }
.hcell[data-sort]:hover { color: var(--vscode-foreground); }
.hcell.sorted { color: var(--vscode-foreground); }
.hcell.sorted[data-dir="asc"]::after { content: " \\25B2"; font-size: 9px; margin-left: 4px; }
.hcell.sorted[data-dir="desc"]::after { content: " \\25BC"; font-size: 9px; margin-left: 4px; }
.hcell.cb { justify-content: center; padding: 0; }
.grip { position: absolute; right: 0; top: 4px; bottom: 4px; width: 7px; cursor: col-resize; border-right: 1px solid var(--ob-border); }
.grip:hover { border-right: 2px solid var(--ob-accent); }
.vspacer { position: relative; }
.rowsEl { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.row { display: grid; grid-template-columns: var(--cols); height: 28px; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.row:hover { background: var(--ob-hover); }
.row.sel { background: color-mix(in srgb, var(--ob-accent) 14%, transparent); }
.row.active { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
.row.failed { box-shadow: inset 3px 0 0 var(--ob-bad); }
.c { padding: 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.c.cb { display: flex; justify-content: center; padding: 0; }
.c.nm { font-weight: 500; }
.c.ty, .c.ns, .c.by, .c.md { color: var(--vscode-descriptionForeground); }
mark { background: color-mix(in srgb, var(--ob-warn) 45%, transparent); color: inherit; border-radius: 2px; padding: 0 1px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid var(--ob-border); }
.badge.none { color: var(--vscode-descriptionForeground); }
.badge.equal { color: var(--ob-ok); border-color: color-mix(in srgb, var(--ob-ok) 50%, transparent); }
.badge.partial { color: var(--ob-accent); border-color: color-mix(in srgb, var(--ob-accent) 50%, transparent); }
.badge.changed-org { color: var(--ob-warn); border-color: color-mix(in srgb, var(--ob-warn) 55%, transparent); background: color-mix(in srgb, var(--ob-warn) 12%, transparent); }
.badge.changed-local { color: var(--vscode-charts-blue, #3794ff); border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 55%, transparent); }
.badge.conflict { color: var(--ob-bad); border-color: color-mix(in srgb, var(--ob-bad) 60%, transparent); background: color-mix(in srgb, var(--ob-bad) 12%, transparent); }
.badge.unknown { color: var(--vscode-descriptionForeground); border-style: dashed; }
.badge.prov { border-style: dashed; opacity: .75; }
.res { font-weight: 700; cursor: help; }
.res.ok { color: var(--ob-ok); }
.res.bad { color: var(--ob-bad); }
.acts { display: flex; gap: 1px; padding: 0 4px; visibility: hidden; }
.row:hover .acts, .row.active .acts, .row:focus-within .acts { visibility: visible; }
.acts button { background: transparent; border: 0; border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; opacity: .8; }
.acts button:hover { background: color-mix(in srgb, var(--vscode-foreground) 16%, transparent); opacity: 1; }
.row.grp { background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); cursor: pointer; font-weight: 600; }
.row.grp .gname { grid-column: 2 / -1; display: flex; align-items: center; gap: 8px; }
.chev { display: inline-flex; transition: transform .12s; opacity: .8; }
.chev.open { transform: rotate(90deg); }
.gcount { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: 12px; }
.gref { background: transparent; border: 0; opacity: 0; width: 22px; height: 22px; border-radius: 4px; }
.row.grp:hover .gref { opacity: .8; }
.overlay { position: absolute; inset: 30px 0 0 0; display: flex; align-items: center; justify-content: center; z-index: 4; pointer-events: none; }
.overlay .card { pointer-events: auto; max-width: 440px; text-align: center; padding: 22px 26px; border: 1px solid var(--ob-border); border-radius: 10px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 8px 28px -10px rgba(0,0,0,.5); }
.overlay h3 { margin: 0 0 8px; }
.overlay p { margin: 0 0 14px; color: var(--vscode-descriptionForeground); }
.overlay .btns { display: flex; gap: 8px; justify-content: center; }
.overlay button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; border-radius: 4px; height: 28px; padding: 0 14px; }
.overlay button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.failbox { border-top: 1px solid var(--ob-border); padding: 4px 12px; font-size: 12px; max-height: 180px; overflow: auto; flex-shrink: 0; }
.failbox summary { cursor: pointer; color: var(--ob-warn); }
.failbox ul { margin: 6px 0; padding-left: 18px; }
.menu { position: fixed; z-index: 20; min-width: 190px; padding: 4px; border: 1px solid var(--ob-border-strong); border-radius: 6px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); color: var(--vscode-menu-foreground, var(--vscode-foreground)); box-shadow: 0 6px 22px rgba(0,0,0,.4); }
.menu[hidden] { display: none; }
.menu button { display: block; width: 100%; text-align: left; background: transparent; border: 0; padding: 5px 10px; border-radius: 4px; }
.menu button:hover, .menu button:focus { background: var(--vscode-menu-selectionBackground, var(--ob-hover)); color: var(--vscode-menu-selectionForeground, inherit); outline: none; }
.toast { position: fixed; right: 16px; bottom: 16px; max-width: 420px; padding: 8px 14px; border-radius: 6px; background: var(--vscode-editorWidget-background); border: 1px solid var(--ob-border-strong); box-shadow: 0 6px 22px rgba(0,0,0,.4); opacity: 0; transform: translateY(8px); pointer-events: none; transition: opacity .15s, transform .15s; z-index: 30; }
.toast.show { opacity: 1; transform: none; }
.toast.warn { border-color: var(--ob-warn); }
.toast.error { border-color: var(--ob-bad); }
@media (max-width: 760px) { #side { display: none; } }
@media (forced-colors: active) { .badge, .chip, .selchip { border-color: CanvasText; } }
`;
