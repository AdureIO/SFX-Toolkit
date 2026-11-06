/**
 * Boots the ASFX language server (out/server.js) and bridges its schema requests
 * back to the extension host. Phase 1 serves org-aware SOQL completion in .soql
 * files; the server stays credential-free and asks the host (which owns auth +
 * metadata caches) for object lists and describes on demand.
 */
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	State,
	DidChangeWatchedFilesNotification,
	FileChangeType,
	ResponseError,
} from "vscode-languageclient/node";
import { SoqlSchemaProvider } from "./utils/soqlSchemaProvider";
import { OrgMetadataCache } from "./utils/orgMetadataCache";
import { findSfdxProjectDir, isSalesforceProject } from "./utils/projectUtils";
import { canonicalOrgKey, orgArgForKey } from "./utils/orgKey";
import { SchemaUnavailableError } from "./utils/describeStore";
import { FileEventBatcher } from "./utils/fileEventBatcher";
import { onDidChangeProjectDefaultOrg } from "./utils/defaultOrgEvents";
import { scheduleStubSync, cleanRestartApex, getInitialSyncState, disposeStubSync } from "./utils/sobjectStubSync";
import { getBufferOrgOverride } from "./utils/bufferOrgOverride";
import { outputChannel } from "./utils/outputChannel";
import { registerApexQuickFixCommands } from "./commands/apexQuickFixCommands";

const REQ_OBJECT_LIST = "sfx/objectList";
const REQ_DESCRIBE = "sfx/describe";
const REQ_DESCRIBE_MANY = "sfx/describeMany";
const REQ_PROJECT_INFO = "sfx/projectInfo";
const REQ_OBJECT_INFO = "sfx/objectInfo";
const NOTE_REFRESH = "sfx/refreshSchema";
const NOTE_EPHEMERAL = "sfx/ephemeralBuffers";

// How long a graceful shutdown/exit handshake may take before we kill the process.
const STOP_TIMEOUT_MS = 2000;
// Apex sources outside generated/tooling dirs — the server's type index cares only
// about these (`.sfdx/tools/sobjects` holds thousands of generated stub classes).
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;

let client: LanguageClient | undefined;
/** Workspace folders the running client was started for (detects project switches). */
let clientRootsKey: string | undefined;
/** Resolves once the current client has started (or failed to). */
let clientStarted: Promise<void> | undefined;
/** Per-client listeners/watchers — disposed when that client stops (restart-safe). */
let clientDisposables: vscode.Disposable[] = [];
let stopping: Promise<void> | undefined;
let transitions: Promise<void> = Promise.resolve();
let lifetimeRegistered = false;

function workspaceRootsKey(): string {
	return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.toString()).join("|");
}

/**
 * Start the language server for the current workspace. Idempotent; when the
 * workspace folders changed since the server started (project switch in the same
 * window) or the workspace is no longer an SFDX project, the server is restarted /
 * stopped so its stub root and type index follow the new folders. Safe to call from
 * `onDidChangeWorkspaceFolders`.
 */
export function startLanguageServer(context: vscode.ExtensionContext): void {
	registerLifetime(context);
	if (client) {
		if (clientRootsKey !== workspaceRootsKey() || !isSalesforceProject()) {
			void restartLanguageServerForWorkspaceChange(context);
		}
		return;
	}
	startClient(context);
}

/**
 * Re-root the language server after a workspace-folder change: stop the running
 * server (if its roots differ) and start a fresh one for the new folders — or just
 * stop it when the workspace is no longer an SFDX project. Serialized, so rapid
 * folder changes can't interleave a stop with a start.
 */
export function restartLanguageServerForWorkspaceChange(context: vscode.ExtensionContext): Promise<void> {
	transitions = transitions
		.then(async () => {
			const isProject = isSalesforceProject();
			if (client && clientRootsKey === workspaceRootsKey() && isProject) return;
			if (client || stopping) {
				outputChannel.appendLine("languageClient: workspace folders changed — restarting ASFX language server.");
				await stopLanguageServer();
			}
			if (isProject) startClient(context);
		})
		.catch((e: any) => outputChannel.appendLine(`languageClient: restart after workspace change failed: ${e?.message ?? e}`));
	return transitions;
}

/** Once per activation: make sure everything we own is torn down with the extension. */
function registerLifetime(context: vscode.ExtensionContext): void {
	if (lifetimeRegistered) return;
	lifetimeRegistered = true;
	context.subscriptions.push({
		dispose: () => {
			lifetimeRegistered = false;
			disposeStubSync();
			void stopLanguageServer();
		},
	});
	// The Salesforce Apex LS watchdog is independent of our server's lifetime.
	startApexHealthMonitor(context);
	// Host commands used by the server's quick fixes (e.g. create a field stub file).
	registerApexQuickFixCommands(context);
}

function startClient(context: vscode.ExtensionContext): void {
	if (client) return;
	// Never start outside an SFDX project — mirrors how the extension's UI is hidden.
	if (!isSalesforceProject()) return;
	const enabled = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("soql.enableCompletion", true);
	if (!enabled) return;

	const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
	// Heap cap for the server process so a pathological workspace can't balloon it
	// (adure-sfx-toolkit.apex.languageServerMaxMemoryMB, default 512).
	const heapArg = `--max-old-space-size=${languageServerHeapMB()}`;
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: [heapArg] } },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ["--nolazy", "--inspect=6019", heapArg] },
		},
	};

	// Apex semantic features (outline, diagnostics). Default "on" — always enabled;
	// "auto" enables them only when the official Salesforce Apex extension is absent
	// (avoids duplicate results); "off" disables them.
	const apexMode = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<string>("apex.languageServer", "on");
	const hasSalesforceApex = !!vscode.extensions.getExtension("salesforce.salesforcedx-vscode-apex");
	const apexFeatures = apexMode === "on" || (apexMode === "auto" && !hasSalesforceApex);
	// Org-aware Apex completion (SObject fields, `new`, type names) is additive and
	// on by default — independent of the Salesforce extension. Turn off to avoid
	// duplicate completion items.
	const apexCompletion = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("apex.enableCompletion", true);
	// Offline schema validation (Tier 1) — flags SObject member accesses that don't
	// exist in org metadata. Gated by apexFeatures on the server too.
	const apexValidateSchema = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("apex.validateSemantics", true);
	// Semantic highlighting for Apex/SOQL (SObject fields vs locals, etc.).
	const apexSemanticHighlighting = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("apex.semanticHighlighting", true);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: "file", language: "soql" },
			{ scheme: "file", pattern: "**/*.soql" },
			// Apex files: inline [SELECT …] queries + org-aware completion.
			{ scheme: "file", language: "apex" },
			// Anonymous Apex (.apex) — the Salesforce extension registers these as
			// the `apex-anon` language, and the Execute Apex panel's hidden buffer is
			// a `.apex` file; match both so completion works there too.
			{ scheme: "file", language: "apex-anon" },
			{ scheme: "file", pattern: "**/*.apex" },
			{ scheme: "file", pattern: "**/*.cls" },
			{ scheme: "file", pattern: "**/*.trigger" },
		],
		initializationOptions: { apexFeatures, apexCompletion, apexValidateSchema, apexSemanticHighlighting },
		outputChannel,
	};

	const lc = new LanguageClient(
		"sfxLanguageServer",
		"ASFX Language Server",
		serverOptions,
		clientOptions
	);
	client = lc;
	clientRootsKey = workspaceRootsKey();
	const disposables: vscode.Disposable[] = [];
	clientDisposables = disposables;

	// Resolve which org a request's document belongs to, as the CANONICAL org key
	// (username) — the same key the warm-up, push/pull invalidation and every host
	// cache use. Walks up to the nearest sfdx-project.json so nested sub-projects
	// (e.g. billing/force-app/...) use their own default org. Null = no org resolvable
	// (the CLI's global default).
	const projectDirCache = new Map<string, string | null>();
	const orgForUri = (uri?: string): string | null => {
		try {
			if (!uri) return orgArgForKey(canonicalOrgKey(null));
			const fsPath = vscode.Uri.parse(uri).fsPath;
			// A webview buffer (ASFX Workbench) may pin its IntelliSense to a chosen org.
			const ov = getBufferOrgOverride(fsPath);
			if (ov.has) return orgArgForKey(canonicalOrgKey(ov.org));
			const dir = path.dirname(fsPath);
			let projectDir = projectDirCache.get(dir);
			if (projectDir === undefined) {
				projectDir = findSfdxProjectDir(fsPath);
				if (projectDirCache.size > 2000) projectDirCache.clear();
				projectDirCache.set(dir, projectDir);
			}
			return orgArgForKey(canonicalOrgKey(null, projectDir ?? undefined));
		} catch {
			return null;
		}
	};

	/** Transient host failures reject the request (the server must not negative-cache them). */
	const unavailable = (e: unknown): ResponseError<void> =>
		new ResponseError(-32803 /* RequestFailed */, `schema unavailable: ${(e as any)?.message ?? e}`);

	lc.onRequest(REQ_OBJECT_LIST, async (params: { uri?: string }) => {
		try {
			return await SoqlSchemaProvider.getObjectList(orgForUri(params?.uri));
		} catch (e: any) {
			outputChannel.appendLine(`languageClient: objectList failed: ${e?.message ?? e}`);
			return [];
		}
	});

	lc.onRequest(REQ_DESCRIBE, async (params: { uri?: string; sobject: string }) => {
		try {
			return await SoqlSchemaProvider.getDescribeStrict(orgForUri(params?.uri), params?.sobject);
		} catch (e: any) {
			if (e instanceof SchemaUnavailableError) throw unavailable(e);
			outputChannel.appendLine(`languageClient: describe failed: ${e?.message ?? e}`);
			return null;
		}
	});

	// Batched describes (contract 3): same Describe shape as REQ_DESCRIBE, same order as
	// `names`, null = not an SObject. Misses go out as REST composite/batch (<=25 each)
	// through the shared DescribeStore cache. Rejects when the org can't answer.
	lc.onRequest(REQ_DESCRIBE_MANY, async (params: { names?: string[]; uri?: string }) => {
		const names = Array.isArray(params?.names) ? params.names.slice(0, 500) : [];
		try {
			return await SoqlSchemaProvider.getDescribeMany(orgForUri(params?.uri), names, { strict: true });
		} catch (e: any) {
			if (e instanceof SchemaUnavailableError) throw unavailable(e);
			outputChannel.appendLine(`languageClient: describeMany failed: ${e?.message ?? e}`);
			return names.map(() => null);
		}
	});

	// Object-level admin Description (Tooling API; not in the standard describe).
	lc.onRequest(REQ_OBJECT_INFO, async (params: { uri?: string; sobject: string }) => {
		try {
			const description = await SoqlSchemaProvider.getObjectDescription(orgForUri(params?.uri), params?.sobject);
			return { description };
		} catch {
			return { description: null };
		}
	});

	// Project namespace (from sfdx-project.json) for the document's sub-project.
	// Lets the server match/resolve names with the namespace optional.
	const nsCache = new Map<string, string | null>();
	lc.onRequest(REQ_PROJECT_INFO, (params: { uri?: string }) => {
		try {
			if (!params?.uri) return { namespace: null };
			const fsPath = vscode.Uri.parse(params.uri).fsPath;
			const projectDir = findSfdxProjectDir(fsPath);
			if (!projectDir) return { namespace: null };
			if (nsCache.has(projectDir)) return { namespace: nsCache.get(projectDir) ?? null };
			let namespace: string | null = null;
			try {
				const raw = fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8");
				const ns = JSON.parse(raw).namespace;
				namespace = typeof ns === "string" && ns.trim() ? ns.trim() : null;
			} catch {
				namespace = null;
			}
			nsCache.set(projectDir, namespace);
			return { namespace };
		} catch {
			return { namespace: null };
		}
	});

	// When the org switches or metadata is refreshed, drop the host-side describe
	// cache and tell the server to drop its own.
	const unsubscribe = OrgMetadataCache.onChange((org, change) => {
		if (change) {
			// Targeted: a push/pull touched only these objects' schema (their describes are
			// already dropped), and `structural` = objects were added/removed, so the server
			// must also drop its object list (contract 2).
			const objects = change.objects.length ? change.objects : undefined;
			const params: { objects?: string[]; structural?: boolean } = {};
			if (objects) params.objects = objects;
			if (change.structural) params.structural = true;
			if (lc.isRunning() && (objects || change.structural)) void lc.sendNotification(NOTE_REFRESH, params).catch(() => {});
			// Regenerate just those stubs — not the org. A structural-only change (the object
			// list differed on revalidation) runs an incremental pass: it creates stubs for
			// newly referenced objects and removes managed stubs of deleted ones, rewriting
			// nothing that already exists.
			if (objects) scheduleStubSync({ only: objects });
			else if (change.structural) scheduleStubSync();
			return;
		}
		// Full invalidation (org switch / manual refresh). The emitting cache already dropped
		// that org's describes; only the admin descriptions live here.
		SoqlSchemaProvider.invalidateDescriptions(org);
		projectDirCache.clear();
		if (lc.isRunning()) void lc.sendNotification(NOTE_REFRESH).catch(() => {});
		// Don't trust any stub.
		scheduleStubSync({ force: true });
	});

	disposables.push({ dispose: unsubscribe });

	// A nested project's own default org changed: drop only its documents' org context.
	disposables.push(
		onDidChangeProjectDefaultOrg((projectDir) => {
			projectDirCache.clear();
			const prefix = projectDir.replace(/[\\/]+$/, "") + path.sep;
			const uris = vscode.workspace.textDocuments
				.filter((d) => d.uri.scheme === "file" && d.uri.fsPath.startsWith(prefix))
				.map((d) => d.uri.toString());
			if (lc.isRunning()) {
				void lc.sendNotification(NOTE_REFRESH, uris.length ? { uris } : undefined).catch(() => {});
			}
			// That project's stubs now describe the wrong org. A forced pass rewrites only
			// files whose content actually changes (other projects' describes are cached).
			scheduleStubSync({ force: true });
		})
	);

	// Keep the server's Apex type index current (new / deleted classes). Events are
	// filtered here — the stub sync writes thousands of `.cls` files under `.sfdx` that
	// must never reach the server — and batched into one notification.
	disposables.push(watchApexSources(lc));

	// Initial background stub generation: incremental — only create stubs that
	// don't exist yet, so a reload with stubs already on disk does almost no work.
	scheduleStubSync();

	clientStarted = lc.start().then(
		() => {
			// A restarted server starts with an empty ephemeral set — re-send it.
			if (ephemeralBufferUris.size && client === lc) {
				void lc.sendNotification(NOTE_EPHEMERAL, { uris: [...ephemeralBufferUris] }).catch(() => {});
			}
		},
		(e: any) => {
			outputChannel.appendLine(`languageClient: failed to start ASFX language server: ${e?.message ?? e}`);
		},
	);
}

const DEFAULT_SERVER_HEAP_MB = 512;

/** The language server's V8 heap cap in MB (setting, clamped to a sane range). */
function languageServerHeapMB(): number {
	const v = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<number>("apex.languageServerMaxMemoryMB", DEFAULT_SERVER_HEAP_MB);
	return typeof v === "number" && Number.isFinite(v) ? Math.min(8192, Math.max(128, Math.round(v))) : DEFAULT_SERVER_HEAP_MB;
}

/**
 * Forward relevant create/change/delete events to the server (batched): Apex sources
 * (`.cls`/`.trigger`, the type index) and the metadata that refers to Apex by name
 * (LWC / Aura JS + markup, Visualforce, Flows — the Find References / rename token index).
 */
function watchApexSources(lc: LanguageClient): vscode.Disposable {
	const watcher = vscode.workspace.createFileSystemWatcher(
		"{**/*.cls,**/*.trigger,**/lwc/**/*.js,**/lwc/**/*.ts,**/aura/**/*.js,**/aura/**/*.cmp,**/aura/**/*.app,**/*.page,**/*.component,**/*.flow-meta.xml}",
	);
	// Deduped by URI (last net change per file) — a huge branch switch coalesces instead
	// of being truncated, so no file event is ever lost.
	const pending = new FileEventBatcher();
	let flushTimer: NodeJS.Timeout | undefined;
	const flush = () => {
		flushTimer = undefined;
		const changes = pending.drain().map((c) => ({ uri: c.uri, type: c.type as FileChangeType }));
		if (!changes.length || !lc.isRunning()) return;
		void lc.sendNotification(DidChangeWatchedFilesNotification.type, { changes }).catch(() => {});
	};
	const queue = (uri: vscode.Uri, type: FileChangeType) => {
		if (uri.scheme !== "file" || GENERATED_PATH.test(uri.fsPath)) return;
		pending.add(uri.toString(), type);
		if (!flushTimer) flushTimer = setTimeout(flush, 500);
	};
	const subs = [
		watcher,
		watcher.onDidCreate((u) => queue(u, FileChangeType.Created)),
		watcher.onDidChange((u) => queue(u, FileChangeType.Changed)),
		watcher.onDidDelete((u) => queue(u, FileChangeType.Deleted)),
	];
	return {
		dispose: () => {
			if (flushTimer) clearTimeout(flushTimer);
			flushTimer = undefined;
			pending.clear();
			for (const d of subs) d.dispose();
		},
	};
}

/**
 * Stop the language server and make sure its process is gone: graceful
 * shutdown/exit with a timeout, then a hard kill of the child process if it is
 * still alive (e.g. the server hung). Safe to call repeatedly / concurrently;
 * returns the in-flight stop.
 */
export function stopLanguageServer(): Promise<void> | undefined {
	if (stopping) return stopping;
	const lc = client;
	if (!lc) return undefined;
	const started = clientStarted;
	client = undefined;
	clientRootsKey = undefined;
	clientStarted = undefined;
	for (const d of clientDisposables.splice(0)) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}
	stopping = (async () => {
		// A client that is still starting can't be stopped — wait (bounded) for it first.
		if (lc.state === State.Starting && started) {
			await Promise.race([started, delay(STOP_TIMEOUT_MS)]);
		}
		// Grab the child before stop() forgets it, for the kill fallback.
		const proc: import("child_process").ChildProcess | undefined = (lc as any)._serverProcess;
		try {
			await lc.stop(STOP_TIMEOUT_MS);
		} catch (e: any) {
			outputChannel.appendLine(`languageClient: stop failed (${e?.message ?? e}) — killing server process.`);
		} finally {
			try {
				if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill();
			} catch {
				/* already gone */
			}
		}
	})().finally(() => {
		stopping = undefined;
	});
	return stopping;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the language server to drop its cached schema so subsequent completion/
 * hover re-fetch it — used when a webview buffer's org override changes, since the
 * server caches describes per project/buffer (it cannot see org overrides).
 */
export function refreshLanguageServerSchema(): void {
	if (client?.isRunning()) void client.sendNotification(NOTE_REFRESH).catch(() => {});
}

/**
 * Register buffer document URIs that must never have SObject stub files written
 * for them (their IntelliSense org may be non-default). Go-to-definition on an
 * SObject in these buffers won't generate stubs into the shared .sfdx folder.
 */
const ephemeralBufferUris = new Set<string>();
export function setEphemeralBuffers(uris: string[]): void {
	for (const u of uris) ephemeralBufferUris.add(u);
	if (client?.isRunning()) void client.sendNotification(NOTE_EPHEMERAL, { uris: [...ephemeralBufferUris] }).catch(() => {});
}

/**
 * Watch the Salesforce Apex Language Server and, if it's crashed/stuck after its
 * own retries, escalate to a **clean** restart (reset the Apex DB) — which fixes
 * the DB-corruption crash. Bounded: tries at most MAX_CLEAN_RESTARTS times; if it
 * still fails, shows the user one error and stops (no restart loop). The attempt
 * budget resets once the server is healthy again.
 */
const MAX_CLEAN_RESTARTS = 2;
const HEALTH_CHECK_INTERVAL_MS = 30000;
function startApexHealthMonitor(context: vscode.ExtensionContext): void {
	const enabled = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("apex.monitorLanguageServer", true);
	if (!enabled) return;
	const apexExt = vscode.extensions.getExtension("salesforce.salesforcedx-vscode-apex");
	if (!apexExt) return;

	const restartAfterInitialLoad = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("apex.restartAfterInitialLoad", true);

	let downChecks = 0;
	let cleanAttempts = 0;
	let gaveUp = false;
	let initialRestartHandled = false;

	// Self-rescheduling timeout (not setInterval): the next check is only scheduled
	// after the current one — including any awaited clean restart — has finished, so
	// two checks can never run concurrently and fight over restartBehavior.
	let timer: NodeJS.Timeout | undefined;
	let disposed = false;
	const schedule = () => {
		if (disposed) return;
		timer = setTimeout(() => {
			timer = undefined;
			void check().finally(schedule);
		}, HEALTH_CHECK_INTERVAL_MS);
		timer.unref?.();
	};
	const stop = () => {
		disposed = true;
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const check = async (): Promise<void> => {
		if (disposed) return;
		// Extension uninstalled/disabled since activation → stop monitoring for good.
		if (!vscode.extensions.getExtension("salesforce.salesforcedx-vscode-apex")) {
			stop();
			return;
		}
		// Never activate the Salesforce extension ourselves (that would boot its JVM
		// language server in a workspace where nothing asked for it).
		if (!apexExt.isActive) return;
		try {
			const api = apexExt.exports;
			const lcm: any = api?.languageClientManager;
			if (!lcm?.getClientInstance) return; // API not available; nothing to monitor
			const lspClient = lcm.getClientInstance();

			if (lspClient && lspClient.state === State.Running) {
				// Healthy again — reset the recovery budget.
				downChecks = 0;
				cleanAttempts = 0;
				gaveUp = false;

				// Once, after the LS has finished its initial load, do a single clean
				// restart so the stubs generated this session are indexed. We wait for
				// the initial stub sync to finish; a clean (reset-DB) restart rebuilds
				// fresh, avoiding the orphan-deletion path that can crash the indexer.
				if (!initialRestartHandled && restartAfterInitialLoad) {
					const init = getInitialSyncState();
					if (init.done) {
						initialRestartHandled = true;
						if (init.wrote) {
							outputChannel.appendLine("Initial load complete — clean-restarting Apex LS to index generated stub types.");
							await cleanRestartApex(vscode);
						}
					}
				}
				return;
			}
			if (lspClient && lspClient.state === State.Starting) {
				// It's (re)starting on its own; give it time, don't count as down.
				downChecks = 0;
				return;
			}

			// Stopped or no client.
			downChecks++;
			if (downChecks < 2 || gaveUp) return; // wait ~60s; or we've already given up
			downChecks = 0;

			if (cleanAttempts < MAX_CLEAN_RESTARTS) {
				cleanAttempts++;
				outputChannel.appendLine(
					`Apex Language Server is down — clean restart attempt ${cleanAttempts}/${MAX_CLEAN_RESTARTS}.`,
				);
				await cleanRestartApex(vscode);
			} else {
				gaveUp = true;
				outputChannel.appendLine("Apex Language Server still failing after clean restarts — giving up.");
				void vscode.window.showErrorMessage(
					"The Salesforce Apex Language Server keeps failing to start. Try 'SFDX: Clean Apex DB and Restart', or check the Apex Language Server output for the underlying error.",
				);
			}
		} catch {
			/* ignore transient errors */
		}
	};

	schedule();
	context.subscriptions.push({ dispose: stop });
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct LS requests + virtual documents (owned by the UI team — contract 6).
//
// The webview editors (ASFX Workbench Execute/SOQL tabs, SOQL Builder panel) talk
// to OUR language server directly instead of going through
// `vscode.execute*Provider`, which fans out to every registered provider (Jorje for
// apex-anon buffers, the Salesforce SOQL extension for any scheme, …) — that
// produced duplicate items and let the slowest provider set the latency.
//
// Their text lives in virtual documents on the `asfx-buffer:` scheme, synced with
// synthetic didOpen/didChange/didClose notifications. Nothing is written to disk on
// the completion path, so no save participants / didSave full parses per keystroke.
// The URI's path is the (historic) buffer file path, so host lookups keyed by
// fsPath — the workbench org override, sfdx-project / default-org resolution —
// keep working unchanged. These documents are NOT VS Code TextDocuments, so the
// client's documentSelector deliberately does not include the scheme (VS Code would
// otherwise sync a second copy if anyone opened such a URI).
// ─────────────────────────────────────────────────────────────────────────────

/** URI scheme of the webview editors' in-memory buffers. */
export const VIRTUAL_BUFFER_SCHEME = "asfx-buffer";

interface VirtualDocState {
	languageId: string;
	version: number;
	text: string;
}

const virtualDocs = new Map<string, VirtualDocState>();
let stateHooked: LanguageClient | undefined;

/**
 * Re-announce open virtual documents after the server (re)started — it lost them.
 * A REPLACED client (restartLanguageServerForWorkspaceChange) never saw them at all:
 * forget them so the next sync sends a fresh didOpen instead of a didChange.
 */
function hookClientState(): void {
	if (!client || stateHooked === client) return;
	if (stateHooked) virtualDocs.clear();
	stateHooked = client;
	const c = client;
	c.onDidChangeState((e) => {
		if (e.newState !== State.Running || c !== client) return;
		for (const [uri, d] of virtualDocs) {
			void c.sendNotification("textDocument/didOpen", {
				textDocument: { uri, languageId: d.languageId, version: d.version, text: d.text },
			}).catch(() => {});
		}
	});
}

/** True when our language server is started (or starting) and can take requests. */
export function isLanguageServerAvailable(): boolean {
	if (!client) return false;
	hookClientState();
	return client.state === State.Running || client.state === State.Starting;
}

/** Server capabilities from the initialize result (undefined until initialized). */
export function languageServerCapabilities(): Record<string, any> | undefined {
	return (client?.initializeResult?.capabilities as Record<string, any> | undefined) ?? undefined;
}

/**
 * Send a request straight to our language server (no provider fan-out). Resolves to
 * undefined when the server isn't available, the request was cancelled, or it failed.
 */
export async function lsRequest<R>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<R | undefined> {
	if (!isLanguageServerAvailable() || !client) return undefined;
	if (token?.isCancellationRequested) return undefined;
	try {
		return (await client.sendRequest(method, params, token)) as R;
	} catch {
		return undefined;
	}
}

/**
 * Open (or replace the text of) a virtual document. Returns false when the server
 * is not available — callers then fall back to a file-backed buffer.
 */
export async function syncVirtualDocument(uri: string, languageId: string, text: string): Promise<boolean> {
	if (!isLanguageServerAvailable() || !client) return false;
	const cur = virtualDocs.get(uri);
	try {
		if (!cur || cur.languageId !== languageId) {
			if (cur) await client.sendNotification("textDocument/didClose", { textDocument: { uri } });
			const state: VirtualDocState = { languageId, version: (cur?.version ?? 0) + 1, text };
			virtualDocs.set(uri, state);
			await client.sendNotification("textDocument/didOpen", {
				textDocument: { uri, languageId, version: state.version, text },
			});
		} else if (cur.text !== text) {
			cur.version++;
			cur.text = text;
			// A change without a range replaces the whole document (valid for any sync kind).
			await client.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: cur.version },
				contentChanges: [{ text }],
			});
		}
		return true;
	} catch {
		virtualDocs.delete(uri); // resend a full didOpen next time
		return false;
	}
}

/** Close a virtual document (panel disposed). */
export function closeVirtualDocument(uri: string): void {
	if (!virtualDocs.delete(uri)) return;
	if (!isLanguageServerAvailable() || !client) return;
	void client.sendNotification("textDocument/didClose", { textDocument: { uri } }).catch(() => {});
}

/**
 * Targeted schema refresh (contract 2): the server drops only the org context /
 * caches for these document URIs — used when a webview buffer's org override
 * changes, instead of a full NOTE_REFRESH that clears every open document.
 */
export function refreshLanguageServerSchemaFor(uris: string[]): void {
	if (!uris.length) return;
	void client?.sendNotification(NOTE_REFRESH, { uris }).catch(() => {});
}
