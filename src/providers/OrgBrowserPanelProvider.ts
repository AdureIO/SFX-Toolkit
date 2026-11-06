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
import { confirmOverwrite, revertOpenEditors } from "../utils/retrieveSafety";
import { retrieveComponents } from "../utils/retrieveEngine";
import { getRetrieveTimes } from "../utils/retrieveLog";
import { classifyHealth } from "../utils/schemaHealth";
import { reauthenticateOrg } from "../commands/orgCommands";
import { metadataDiffForFile } from "../commands/metadataDiff";
import {
	FOLDER_TYPES,
	ListCancelled,
	ListingCache,
	ListProgress,
	listOrgMetadata,
	loadListingCache,
	mergeTypeRefresh,
	saveListingCache,
} from "../utils/orgBrowser/metadataLister";
import { hiddenSelectionPrompt, splitByVisibility } from "../utils/orgBrowser/selection";
import { LocalIndex, buildTypeTable, overwriteTargets, partialObjectKeys, readPackageDirectories, scanProject } from "../utils/orgBrowser/localIndex";
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

/** Types touched by a per-type refresh: the folder type travels with its content type and vice versa. */
function expandOnly(only: string[]): string[] {
	const out = new Set(only);
	for (const [content, f] of Object.entries(FOLDER_TYPES)) {
		if (out.has(content)) out.add(f.folderType);
		if (out.has(f.folderType)) out.add(content);
	}
	return [...out];
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
		this.disposables.push(
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
		this.panel = undefined;
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
			case "compare": {
				const e = this.local?.entries.get(compKey(pair().t, pair().n));
				if (!e) {
					this.post({ type: "toast", text: "This component is not in the project.", kind: "warn" });
					break;
				}
				await metadataDiffForFile(e.primary, this.orgArg);
				break;
			}
			case "reveal": {
				const e = this.local?.entries.get(compKey(pair().t, pair().n));
				if (e) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(e.root ?? e.primary));
				break;
			}
			case "openFile": {
				const e = this.local?.entries.get(compKey(pair().t, pair().n));
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
		}
	}

	// ── Init / org list ──────────────────────────────────────────────────────────

	private static async orgOptions(): Promise<OrgOpt[]> {
		const list = await getOrgListForPicker().catch(() => []);
		const def = getDefaultOrgSync()?.username ?? null;
		const out: OrgOpt[] = [];
		for (const o of list) {
			const rec = getOrgByTarget(o.username);
			if (rec?.isExpired) continue;
			out.push({ label: rec?.alias || o.username, username: o.username, isDefault: o.username === def });
		}
		return out;
	}

	private static async sendInit(): Promise<void> {
		const root = primaryProjectRoot();
		const orgs = await this.orgOptions();
		const key = canonicalOrgKey(null);
		this.post({
			type: "init",
			orgs,
			org: key === DEFAULT_ORG_KEY ? null : key,
			hasProject: !!root && isSalesforceProject(),
			projectName: root ? path.basename(root) : "",
			ui: this.ctx?.workspaceState.get(UI_STATE_KEY) ?? null,
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
		const key = canonicalOrgKey(org);
		this.orgKey = key;
		this.orgArg = orgArgForKey(key);
		this.setComps([]);
		this.types = [];
		this.failures = [];
		this.listedAt = 0;
		this.typeListedAt = {};
		this.local = undefined;
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
		const expanded = only ? expandOnly(only) : undefined;

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
			const label = getOrgByTarget(this.orgKey)?.alias || this.orgKey;
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
		const root = primaryProjectRoot();
		if (!root || !isSalesforceProject()) {
			this.post({ type: "local", keys: [], partial: [], retrieved: {}, hasProject: false });
			return;
		}
		try {
			const dirs = readPackageDirectories(root);
			const index = await scanProject(root, dirs.length > 0 ? dirs : ["force-app"], buildTypeTable(this.types));
			if (gen !== this.gen || !this.panel) return;
			this.local = index;
			this.post({ type: "local", keys: [...index.entries.keys()], partial: partialObjectKeys(index.entries), retrieved: getRetrieveTimes(this.orgKey === DEFAULT_ORG_KEY ? null : this.orgKey), hasProject: true });
		} catch (e: any) {
			Logger.error("Org Browser: local scan failed", e?.message ?? e);
		}
	}

	private static setupWatchers(): void {
		const root = primaryProjectRoot();
		if (!root) return;
		const rescan = () => {
			if (this.watchTimer) clearTimeout(this.watchTimer);
			this.watchTimer = setTimeout(() => void this.refreshLocal(), 700);
		};
		for (const pkg of readPackageDirectories(root)) {
			const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.resolve(root, pkg), "**/*"), false, true, false);
			w.onDidCreate(rescan);
			w.onDidDelete(rescan);
			this.watchers.push(w);
		}
	}

	// ── Retrieve ─────────────────────────────────────────────────────────────────

	/**
	 * @param visibleKeys keys the current filter shows; when given and some of `components` are not in it,
	 *   the user is asked whether to retrieve the hidden ones too. Omitted for single-row retrieves.
	 */
	private static async retrieve(components: { type: string; fullName: string }[], visibleKeys?: ReadonlySet<string>): Promise<void> {
		const root = primaryProjectRoot();
		if (!root || !isSalesforceProject()) {
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
			const e = this.local?.entries.get(compKey(c.type, c.fullName));
			return e ? overwriteTargets(e) : [];
		}))];
		if (!(await confirmOverwrite(targets, "Retrieve"))) {
			this.post({ type: "retrieveResult", results: [], cancelled: true });
			return;
		}
		const label = getOrgByTarget(this.orgKey)?.alias || this.orgKey;
		let outcome: Awaited<ReturnType<typeof retrieveComponents>> | undefined;
		let cancelled = false;
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
			await runCommandArgs("sf", args, undefined, undefined, false);
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
</style>
</head>
<body>
<div id="app">
  <div class="top">
    <select id="org" aria-label="Org"></select>
    <div class="search">
      <input id="search" type="text" spellcheck="false" autocomplete="off" aria-label="Search metadata"
        placeholder="Search name or type…   type:ApexClass  ns:abc  by:smith  status:changed  Acc*Handler  ApexClass:Foo   ( / )">
      <button id="clearSearch" class="x" title="Clear (Esc)" aria-label="Clear search">×</button>
    </div>
    <span id="listedInfo" class="muted"></span>
    <button id="refreshBtn" class="ghost" title="Re-list every type from the org">↻ Refresh</button>
    <span class="spacer"></span>
    <span id="selHidden" class="selhidden" hidden><span id="selHiddenText"></span> <button id="selHiddenShow" class="link" title="Reset the filters and show only the selected components">show</button> · <button id="selHiddenClear" class="link" title="Deselect the selected components the current filter hides">clear hidden</button></span>
    <span id="selChip" class="selchip" hidden><button id="selChipText" title="Show only the selected components"></button><button id="selChipClear" title="Clear selection" aria-label="Clear selection">×</button></span>
    <button id="retrieveBtn" class="primary" disabled>Retrieve (0)</button>
  </div>
  <div id="progress" class="progress" hidden><div id="progressBar"></div></div>
  <div id="banner"></div>
  <div class="main">
    <aside id="side" aria-label="Filters">
      <div class="fgroup"><h4>Local status</h4><div id="fStatus"></div></div>
      <div class="fgroup">
        <h4>Metadata type <span id="typeCount" class="muted"></span></h4>
        <input id="typeSearch" type="text" placeholder="Find a type…" spellcheck="false" autocomplete="off">
        <div id="typeList" class="typelist"></div>
        <div class="hint">Alt-click a type for “only this”</div>
      </div>
      <div class="fgroup"><h4>Namespace</h4><div id="fNs"></div></div>
      <div class="fgroup"><h4>Manageable state</h4><div id="fState"></div></div>
      <div class="fgroup">
        <h4>Modified</h4>
        <label class="frow2"><input type="checkbox" id="fMine"> Modified by me</label>
        <select id="fWithin" aria-label="Modified within">
          <option value="any">Any time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option><option value="custom">Custom range…</option>
        </select>
        <div id="fCustom" class="custom" hidden><input type="date" id="fFrom" aria-label="From"><input type="date" id="fTo" aria-label="To"></div>
      </div>
      <button id="clearFilters" class="linkbtn" hidden>Clear all filters</button>
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
              <span class="hcell" data-sort="status">Local status<i class="grip" data-col="status"></i></span>
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
</body>
</html>`;
	}
}

const CSS = `
*,*::before,*::after { box-sizing: border-box; }
:root {
  --ob-border: color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  --ob-border-strong: color-mix(in srgb, var(--vscode-foreground) 30%, transparent);
  --ob-surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --ob-hover: var(--vscode-list-hoverBackground);
  --ob-accent: var(--vscode-focusBorder, #4c8bf5);
  --ob-ok: var(--vscode-testing-iconPassed, #3fb950);
  --ob-bad: var(--vscode-errorForeground, #f14c4c);
  --ob-warn: var(--vscode-editorWarning-foreground, #d29922);
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
.muted { color: var(--vscode-descriptionForeground); }
.pad { padding: 6px 4px; }
.spacer { flex: 1; min-width: 8px; }
.top { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--ob-border); flex-wrap: wrap; flex-shrink: 0; }
select, input[type="text"], input[type="date"] { height: 28px; padding: 0 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--ob-border)); border-radius: 4px; font: inherit; }
select { max-width: 240px; }
select:focus, input:focus { outline: 1px solid var(--ob-accent); outline-offset: -1px; }
.search { position: relative; flex: 1 1 320px; min-width: 220px; max-width: 760px; }
.search input { width: 100%; padding-right: 26px; }
.search .x { position: absolute; right: 2px; top: 2px; height: 24px; width: 24px; border: 0; background: transparent; opacity: .6; font-size: 16px; line-height: 1; }
.search .x:hover { opacity: 1; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; border-radius: 4px; height: 28px; padding: 0 14px; font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.ghost { background: transparent; border: 1px solid var(--ob-border); border-radius: 4px; height: 28px; padding: 0 10px; }
button.ghost:hover:not(:disabled) { background: var(--ob-hover); }
button.linkbtn { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 0 4px; font-size: 12px; }
button.linkbtn:hover { text-decoration: underline; }
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
.fgroup { padding: 8px 0 10px; border-bottom: 1px solid var(--ob-border); }
.fgroup:last-of-type { border-bottom: 0; }
.fgroup h4 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); display: flex; gap: 6px; align-items: baseline; }
#typeSearch { width: 100%; margin-bottom: 4px; height: 26px; }
.typelist { max-height: 280px; overflow-y: auto; }
.hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
.frow, .frow2 { display: flex; align-items: center; gap: 6px; padding: 2px 2px; border-radius: 3px; cursor: pointer; min-height: 22px; }
.frow:hover { background: var(--ob-hover); }
.frow.zero { opacity: .5; }
.frow .fl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.frow .only, .frow .tref { visibility: hidden; border: 0; background: transparent; font-size: 11px; color: var(--vscode-textLink-foreground); padding: 0 3px; }
.frow .tref { opacity: .8; }
.frow:hover .only, .frow:hover .tref { visibility: visible; }
.frow input, .frow2 input { margin: 0; }
.chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.chip { background: transparent; border: 1px solid var(--ob-border-strong); border-radius: 999px; padding: 1px 9px; font-size: 12px; }
.chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.custom { display: flex; gap: 4px; margin-top: 4px; }
.custom input { flex: 1; min-width: 0; }
#fWithin { width: 100%; margin-top: 4px; }
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
.badge.local { color: var(--ob-ok); border-color: color-mix(in srgb, var(--ob-ok) 50%, transparent); }
.badge.partial { color: var(--ob-accent); border-color: color-mix(in srgb, var(--ob-accent) 50%, transparent); }
.badge.changed { color: var(--ob-warn); border-color: color-mix(in srgb, var(--ob-warn) 55%, transparent); background: color-mix(in srgb, var(--ob-warn) 12%, transparent); }
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
