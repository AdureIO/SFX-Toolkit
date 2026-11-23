import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getToolingApiVersion } from "../utils/constants";
import { Logger } from "../utils/outputChannel";
import { DEFAULT_ORG_KEY, canonicalOrgKey, orgArgForKey } from "../utils/orgKey";
import { getOrgByTarget } from "../utils/orgListCache";
import { getRetrieveTimes, recordDeployed } from "../utils/retrieveLog";
import { metadataDiffForFile } from "../commands/metadataDiff";
import { DeployOrgStatus } from "../utils/deployOrgStatus";
import { RelComponent, folderRestriction, nameOfComponentKey, pathsToComponents, typeOfComponentKey } from "../utils/deployComponentsPure";
import { OrgCompInfo, PreDeployDecision, evaluatePreDeploy, orgLookupKey } from "../utils/deployStatusPure";
import { effectiveSyncedAt } from "../utils/compareStatusPure";
import { CompareTarget } from "../utils/contentCompare";
import { innerFilesOfEntry, requestNameOf } from "../utils/contentComparePure";
import { CompareLease, acquireCompare, compareMode } from "../utils/contentCompareHost";
import { readLocalInfo } from "../utils/localChangeInfo";
import { ListCancelled } from "../utils/orgBrowser/metadataLister";
import { LocalEntry, buildTypeTable, readPackageDirectories, scanProject } from "../utils/orgBrowser/localIndex";
import { makeSoapCall } from "../utils/orgBrowser/soapTransport";
import { Comp } from "../utils/orgBrowser/types";

/** Result of the live check right before a deploy / validation. */
export interface PreDeployCheck {
	/** Null when the org could not be asked (the deploy still goes ahead). */
	decision: PreDeployDecision | null;
	/** Why the org could not be asked. */
	error?: string;
	/** Metadata types listed live, and the SOAP calls that took (for the log). */
	types: string[];
	soapCalls: number;
	ms: number;
}

export interface DeployHostDeps {
	ctx: vscode.ExtensionContext;
	/** The project the panel shows (a host lives as long as one project is shown). */
	root: string;
	post(msg: Record<string, unknown>): void;
	/** `git status` paths of the project (relative to it), filtered to the package directories. */
	gitStatusPaths(root: string): Promise<string[]>;
}

const posix = (p: string) => p.split(path.sep).join("/");

/**
 * Everything the Deploy panel knows about its project and its target org: the local component index
 * (the Org Browser's `localIndex`), git-modified components, and the org status. The webview does the
 * filtering and the status flags; this class feeds it and answers its row actions.
 */
export class DeployPanelHost implements vscode.Disposable {
	readonly root: string;
	entries = new Map<string, LocalEntry>();
	comps: Comp[] = [];
	hasProject = false;
	/** The first scan; `init` waits for it. */
	readonly ready: Promise<void>;

	private readonly status: DeployOrgStatus;
	private relCache: RelComponent[] | undefined;
	private targetOrg: string | null = null;
	private orgKey = "";
	private orgArg: string | null = null;
	/** Bumped on every org change: late results of a previous org are dropped. */
	private gen = 0;
	private run: { cancelled: boolean } | undefined;
	private autoGit = false;
	private scannedWithTypes = false;
	private watchers: vscode.Disposable[] = [];
	private rescanTimer: ReturnType<typeof setTimeout> | undefined;
	private gitTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	/** SOAP calls sent to the org (the pre-deploy check reports its cost). */
	private soapCalls = 0;
	/** The shared content-compare service of (project, target org). */
	private lease: CompareLease | undefined;
	private leaseSubs: { dispose(): void }[] = [];
	private compareTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly deps: DeployHostDeps) {
		this.root = deps.root;
		const apiVersion = getToolingApiVersion().replace(/^v/, "");
		const storage = deps.ctx.globalStorageUri.fsPath;
		this.status = new DeployOrgStatus({
			cacheDir: path.join(storage, "deploy-org-status"),
			seedDir: path.join(storage, "org-browser"),
			apiVersion,
			makeCall: (org) => {
				const call = makeSoapCall(org, apiVersion);
				return (op) => {
					this.soapCalls++;
					return call(op);
				};
			},
		});
		this.ready = this.scanLocal().catch((e) => Logger.error("Deploy panel: local scan failed", e));
		this.setupWatchers();
	}

	private post(msg: Record<string, unknown>): void {
		if (!this.disposed) this.deps.post(msg);
	}

	dispose(): void {
		this.disposed = true;
		this.gen++;
		if (this.run) this.run.cancelled = true;
		for (const w of this.watchers) w.dispose();
		this.watchers = [];
		if (this.rescanTimer) clearTimeout(this.rescanTimer);
		if (this.gitTimer) clearTimeout(this.gitTimer);
		if (this.compareTimer) clearTimeout(this.compareTimer);
		this.releaseLease();
	}

	// ── Local index ──────────────────────────────────────────────────────────────

	/** Scan the project's package directories. Posts nothing: callers decide (init carries the rows). */
	async scanLocal(): Promise<void> {
		const root = this.root;
		this.relCache = undefined;
		if (!fs.existsSync(path.join(root, "sfdx-project.json"))) {
			this.entries = new Map();
			this.comps = [];
			this.hasProject = false;
			return;
		}
		const dirs = readPackageDirectories(root);
		const types = this.status.knownTypes();
		const index = await scanProject(root, dirs.length > 0 ? dirs : ["force-app"], buildTypeTable(types));
		if (this.disposed) return;
		this.scannedWithTypes = types.length > 0;
		this.entries = index.entries;
		this.hasProject = true;
		this.comps = [...index.entries.values()].map((e) => ({
			t: e.type,
			n: e.name,
			ns: "",
			ms: "",
			by: "",
			bi: "",
			lm: 0,
			cd: 0,
			id: "",
			f: posix(path.relative(root, e.primary)),
		}));
	}

	/** Components with project-relative file paths (for mapping git paths and old presets to components). */
	relComponents(): RelComponent[] {
		if (!this.relCache) {
			this.relCache = [...this.entries.values()].map((e) => ({ key: e.key, files: e.files.map((f) => posix(path.relative(this.root, f))) }));
		}
		return this.relCache;
	}

	private localTypes(): string[] {
		return [...new Set([...this.entries.values()].map((e) => e.type))];
	}

	/** A rescan after files were created / deleted: post the new rows and list any type seen for the first time. */
	private async rescanAndPost(): Promise<void> {
		await this.scanLocal();
		if (this.disposed) return;
		this.post({ command: "localRows", comps: this.comps, hasProject: this.hasProject });
		this.postOrgStatus(this.lastState);
		const unseen = this.localTypes().filter((t) => !this.status.isListed(t) && !this.status.hasFailed(t));
		if (unseen.length > 0 && this.orgKey && this.orgKey !== DEFAULT_ORG_KEY) void this.refreshOrg(unseen);
		void this.refreshModified(false);
		this.scheduleCompare(1500);
	}

	private setupWatchers(): void {
		const root = this.root;
		const dirs = readPackageDirectories(root);
		const schedule = (structural: boolean) => {
			if (structural) {
				if (this.rescanTimer) clearTimeout(this.rescanTimer);
				this.rescanTimer = setTimeout(() => void this.rescanAndPost().catch((e) => Logger.error("Deploy panel: rescan failed", e)), 700);
			} else {
				if (this.gitTimer) clearTimeout(this.gitTimer);
				this.gitTimer = setTimeout(() => void this.refreshModified(this.autoGit), 600);
				// A saved file changes its local contents: compare again once the burst of saves is over.
				this.scheduleCompare(4000);
			}
		};
		for (const pkg of dirs.length > 0 ? dirs : ["force-app"]) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.resolve(root, pkg), "**/*"), false, false, false);
			w.onDidCreate(() => schedule(true));
			w.onDidDelete(() => schedule(true));
			w.onDidChange(() => schedule(false));
			this.watchers.push(w);
		}
	}

	// ── Git ──────────────────────────────────────────────────────────────────────

	setAutoGit(on: boolean): void {
		this.autoGit = on;
	}

	/**
	 * Components whose files git reports as changed → the webview's `modified-locally` status.
	 * `select`: also add them to the selection (the "Select changed (Git)" button, auto-select).
	 */
	async refreshModified(select: boolean): Promise<void> {
		if (this.disposed) return;
		let paths: string[] | null = null;
		try {
			await this.ready;
			paths = await this.deps.gitStatusPaths(this.root);
			const { keys, unmatched } = pathsToComponents(paths, this.relComponents());
			this.post({ command: "modifiedKeys", keys, select, total: paths.length, unmatched: unmatched.length });
		} catch (e) {
			paths = null;
			this.post({ command: "modifiedKeys", keys: [], select, total: 0, unmatched: 0, error: String((e as Error)?.message ?? e) });
		}
		await this.postLocalInfo(paths);
	}

	/** Local change times + git dirty per component (the status compare's local side). Without git: file times only. */
	private async postLocalInfo(dirtyPaths: string[] | null): Promise<void> {
		try {
			const dirs = readPackageDirectories(this.root);
			const local = await readLocalInfo(this.root, this.entries.values(), dirs.length > 0 ? dirs : ["force-app"], dirtyPaths);
			this.post({ command: "compareLocal", local });
			await this.pushContent();
		} catch (e) {
			Logger.info(`Deploy panel: could not read the local change times: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
		}
	}

	// ── Org status ───────────────────────────────────────────────────────────────

	private lastState: "none" | "checking" | "ok" | "error" = "none";
	private lastError = "";

	private orgLabel(): string {
		return this.targetOrg ? getOrgByTarget(this.targetOrg)?.alias || this.targetOrg : "";
	}

	private postOrgStatus(state: "none" | "checking" | "ok" | "error", error = ""): void {
		this.lastState = state;
		this.lastError = error;
		const local = [...this.entries.values()].map((e) => ({ key: e.key, type: e.type, name: e.name }));
		const snapshot = this.status.snapshot(local);
		const all = this.orgKey && this.orgKey !== DEFAULT_ORG_KEY ? getRetrieveTimes(this.orgArg) : {};
		const synced: Record<string, number> = {};
		for (const l of local) if (all[l.key] !== undefined) synced[l.key] = all[l.key];
		this.post({ command: "orgStatus", state, error: error || undefined, orgLabel: this.orgLabel(), snapshot, synced, sentAt: Date.now() });
		if (state === "ok") {
			void this.pushContent();
			this.scheduleCompare(0);
		}
	}

	/** The target org changed (or was chosen first): show what is cached at once, then refresh the local types. */
	async setTargetOrg(org: string | null): Promise<void> {
		const gen = ++this.gen;
		if (this.run) this.run.cancelled = true;
		this.targetOrg = org || null;
		this.status.reset();
		this.releaseLease();
		if (!org) {
			this.orgKey = "";
			this.orgArg = null;
			this.postOrgStatus("none", "No target org selected.");
			return;
		}
		const key = canonicalOrgKey(org, this.root);
		this.orgKey = key;
		this.orgArg = orgArgForKey(key);
		if (key === DEFAULT_ORG_KEY) {
			this.postOrgStatus("none", "No target org selected.");
			return;
		}
		// Nothing of the previous org may stay on the rows while this one loads.
		this.postOrgStatus("checking");
		await this.acquireLease(key, this.orgArg, gen);
		await this.ready;
		await this.status.load(key, this.orgArg);
		if (gen !== this.gen || this.disposed) return;
		// The cached org types may map more directories to types than the built-in table did.
		if (!this.scannedWithTypes && this.status.knownTypes().length > 0) {
			await this.scanLocal();
			if (gen !== this.gen || this.disposed) return;
			this.post({ command: "localRows", comps: this.comps, hasProject: this.hasProject });
		}
		await this.refreshOrg(undefined, gen);
	}

	/** Re-list `types` (default: every metadata type present locally) in the background and update the rows when done. */
	async refreshOrg(types?: string[], gen = this.gen): Promise<void> {
		if (!this.orgKey || this.orgKey === DEFAULT_ORG_KEY || gen !== this.gen || this.disposed) return;
		if (this.run) this.run.cancelled = true;
		const run = { cancelled: false };
		this.run = run;
		const isCancelled = () => run.cancelled || gen !== this.gen || this.disposed;
		this.postOrgStatus("checking");
		try {
			await this.status.refresh(types ?? this.localTypes(), { isCancelled });
			if (isCancelled()) return;
			this.postOrgStatus("ok");
		} catch (e: unknown) {
			if (e instanceof ListCancelled || isCancelled()) return;
			const msg = String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 240);
			Logger.info(`Deploy panel: could not list the org's metadata: ${msg}`);
			this.postOrgStatus("error", msg);
		} finally {
			if (this.run === run) this.run = undefined;
		}
	}

	// ── Content compare ──────────────────────────────────────────────────────────

	private releaseLease(): void {
		for (const d of this.leaseSubs) d.dispose();
		this.leaseSubs = [];
		if (this.lease) {
			this.lease.release();
			this.lease = undefined;
			if (!this.disposed) {
				this.post({ command: "compareContent", full: true, content: {} });
				this.post({ command: "compareProgress", progress: { state: "idle", done: 0, total: 0, failed: 0 } });
			}
		}
	}

	/** Join the shared compare service of this project and org; the rows get its results as they come. */
	private async acquireLease(orgKey: string, orgArg: string | null, gen: number): Promise<void> {
		const lease = acquireCompare(this.root, orgKey, orgArg);
		this.lease = lease;
		const service = lease.service;
		this.leaseSubs.push(
			service.onDidUpdate((keys) => this.post({ command: "compareContent", full: false, content: service.contentInfo(keys) })),
			service.onDidProgress((progress) => this.post({ command: "compareProgress", progress }))
		);
		await service.load();
		if (gen !== this.gen || this.disposed || this.lease !== lease) return;
		this.post({ command: "compareProgress", progress: service.progress() });
		await this.pushContent();
	}

	/** Send every still-valid compare result (full replace of the webview's map). */
	private async pushContent(): Promise<void> {
		const lease = this.lease;
		if (!lease || this.disposed) return;
		await this.ready;
		const content = await lease.service.validContentInfo(this.compareTargets());
		if (this.lease !== lease || this.disposed) return;
		this.post({ command: "compareContent", full: true, content });
	}

	/** The local components that exist in the org, ready for the compare service (`keys`: only these). */
	private compareTargets(keys?: Iterable<string>): CompareTarget[] {
		const dirs = readPackageDirectories(this.root);
		const pkgAbs = (dirs.length > 0 ? dirs : ["force-app"]).map((d) => path.resolve(this.root, d));
		const table = buildTypeTable(this.status.knownTypes());
		const list = keys ? [...keys].map((k) => this.entries.get(k)).filter((e): e is LocalEntry => !!e) : [...this.entries.values()];
		const out: CompareTarget[] = [];
		for (const e of list) {
			const org = this.status.get(e.type, e.name);
			if (!org) continue;
			out.push({ key: e.key, type: e.type, name: e.name, orgLm: org.lm, files: innerFilesOfEntry(e, pkgAbs, table) });
		}
		return out;
	}

	/** Queue the content compare (setting `auto`) after `ms`. */
	private scheduleCompare(ms: number): void {
		if (this.compareTimer) clearTimeout(this.compareTimer);
		this.compareTimer = setTimeout(() => {
			this.compareTimer = undefined;
			if (compareMode() === "auto") void this.requestCompare(false);
		}, ms);
	}

	/**
	 * Compare contents now: the components that need it (never compared, or the org time / local contents changed
	 * since), or with `force` the given `keys` (default all) again.
	 */
	async requestCompare(force: boolean, keys?: string[]): Promise<void> {
		const lease = this.lease;
		if (!lease || this.disposed || this.lastState === "none") return;
		await lease.service.load();
		await this.ready;
		if (this.lease !== lease || this.disposed) return;
		lease.service.request(this.compareTargets(keys), force);
	}

	/** Stop the running compare (a deploy starts); `resumeCompare` continues it. */
	pauseCompare(): void {
		this.lease?.service.pause();
	}

	resumeCompare(): void {
		this.lease?.service.resume();
	}

	// ── Row actions ──────────────────────────────────────────────────────────────

	async rowAction(action: string, key: string): Promise<boolean> {
		const e = this.entries.get(key);
		if (!e) {
			this.post({ command: "toast", text: "This component is not in the project.", kind: "warn" });
			return false;
		}
		switch (action) {
			case "compare":
				await metadataDiffForFile(e.primary, this.orgArg);
				return true;
			case "openFile":
				await vscode.window.showTextDocument(vscode.Uri.file(e.primary));
				return true;
			case "reveal":
				await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(e.root ?? e.primary));
				return true;
		}
		return false;
	}

	// ── Right before a deploy ────────────────────────────────────────────────────

	/**
	 * Ask the org NOW (never the cache) whether any selected component changed since this toolkit last
	 * retrieved or deployed it. Lists live only the metadata types of the selected components (folder
	 * types: only their folders), then decides with `evaluatePreDeploy`. An org that cannot be asked
	 * (expired session, offline) does not block: the result has no decision and the deploy goes on.
	 */
	async checkBeforeDeploy(keys: string[]): Promise<PreDeployCheck> {
		const types = [...new Set(keys.map(typeOfComponentKey))];
		const t0 = Date.now();
		const calls0 = this.soapCalls;
		const done = (decision: PreDeployDecision | null, error?: string): PreDeployCheck => ({ decision, error, types, soapCalls: this.soapCalls - calls0, ms: Date.now() - t0 });
		if (!this.orgKey || this.orgKey === DEFAULT_ORG_KEY) return done(null, "no target org");
		// A background refresh would race with this one over the same state.
		if (this.run) this.run.cancelled = true;
		const selected = keys.map((key) => ({ key, type: typeOfComponentKey(key), name: nameOfComponentKey(key) }));
		try {
			const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Checking the org for changes…" }, () =>
				this.status.refresh(types, { onlyFolders: folderRestriction(keys) })
			);
			const orgComps = new Map<string, OrgCompInfo>();
			for (const c of selected) {
				const info = this.status.get(c.type, c.name);
				if (info) orgComps.set(orgLookupKey(c.type, c.name), info);
			}
			// Last sync = retrieve / deploy log or the last content-verified "same"; verified-equal components never warn.
			const log = getRetrieveTimes(this.orgArg);
			const service = this.lease?.service;
			const syncedAt: Record<string, number> = {};
			for (const c of selected) {
				const t = effectiveSyncedAt(log[c.key], service?.verifiedSyncAt(c.key));
				if (t !== undefined) syncedAt[c.key] = t;
			}
			const verifiedEqual = service ? await service.verifiedEqualNow(this.compareTargets(selected.map((c) => c.key))) : undefined;
			const decision = evaluatePreDeploy({
				selected,
				orgComps,
				listedTypes: new Set(outcome.listed),
				failedTypes: outcome.failed,
				syncedAt,
				verifiedEqual,
			});
			this.postOrgStatus("ok"); // the rows get the fresher data too
			return done(decision);
		} catch (e: unknown) {
			if (e instanceof ListCancelled) return done(null, "cancelled");
			return done(null, String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 240));
		}
	}

	/**
	 * After a successful deploy: re-list the deployed types and record each component in the retrieve /
	 * deploy log with the org's NEW lastModifiedDate (so our own deploy never shows as changed-in-org);
	 * where the org does not report one, with `completedAt` (the deploy's completion time).
	 */
	async afterDeploy(keys: string[], completedAt: number): Promise<void> {
		if (keys.length === 0) return;
		const types = [...new Set(keys.map(typeOfComponentKey))];
		if (this.orgKey && this.orgKey !== DEFAULT_ORG_KEY) {
			if (this.run) this.run.cancelled = true;
			try {
				await this.status.refresh(types, { onlyFolders: folderRestriction(keys) });
			} catch (e) {
				Logger.info(`Deploy panel: could not re-list ${types.join(", ")} after the deploy: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
			}
		}
		recordDeployed(
			this.orgArg,
			keys.map((k) => {
				const type = typeOfComponentKey(k);
				const name = nameOfComponentKey(k);
				const lm = this.status.get(type, name)?.lm;
				return { type, fullName: name, at: lm ? new Date(lm) : undefined };
			}),
			new Date(completedAt)
		);
		if (this.disposed) return;
		this.postOrgStatus("ok");
	}
}
