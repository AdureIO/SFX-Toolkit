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
} from "vscode-languageclient/node";
import { SoqlSchemaProvider } from "./utils/soqlSchemaProvider";
import { OrgMetadataCache } from "./utils/orgMetadataCache";
import { findSfdxProjectDir, isSalesforceProject } from "./utils/projectUtils";
import { resolveDefaultTargetOrgUsernameSync } from "./utils/defaultOrg";
import { scheduleStubSync, cleanRestartApex, getInitialSyncState } from "./utils/sobjectStubSync";
import { getBufferOrgOverride } from "./utils/bufferOrgOverride";
import { outputChannel } from "./utils/outputChannel";

const REQ_OBJECT_LIST = "sfx/objectList";
const REQ_DESCRIBE = "sfx/describe";
const REQ_PROJECT_INFO = "sfx/projectInfo";
const REQ_OBJECT_INFO = "sfx/objectInfo";
const NOTE_REFRESH = "sfx/refreshSchema";
const NOTE_EPHEMERAL = "sfx/ephemeralBuffers";

let client: LanguageClient | undefined;

export function startLanguageServer(context: vscode.ExtensionContext): void {
	if (client) return; // already started (idempotent across workspace-folder changes)
	// Never start outside an SFDX project — mirrors how the extension's UI is hidden.
	if (!isSalesforceProject()) return;
	const enabled = vscode.workspace
		.getConfiguration("adure-sfx-toolkit")
		.get<boolean>("soql.enableCompletion", true);
	if (!enabled) return;

	const serverModule = context.asAbsolutePath(path.join("out", "server.js"));
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ["--nolazy", "--inspect=6019"] },
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
		initializationOptions: { apexFeatures, apexCompletion },
		outputChannel,
	};

	client = new LanguageClient(
		"sfxLanguageServer",
		"ASFX Language Server",
		serverOptions,
		clientOptions
	);

	// Resolve which org a request's document belongs to. Walks up to the nearest
	// sfdx-project.json so nested sub-projects (e.g. billing/force-app/...) use their
	// own default org instead of always the workspace root's. Null = default org.
	const orgForUri = (uri?: string): string | null => {
		if (!uri) return null;
		try {
			const fsPath = vscode.Uri.parse(uri).fsPath;
			// A webview buffer (ASFX Workbench) may pin its IntelliSense to a chosen org.
			const ov = getBufferOrgOverride(fsPath);
			if (ov.has) return ov.org;
			const projectDir = findSfdxProjectDir(fsPath) ?? undefined;
			return resolveDefaultTargetOrgUsernameSync(projectDir) ?? null;
		} catch {
			return null;
		}
	};

	client.onRequest(REQ_OBJECT_LIST, async (params: { uri?: string }) => {
		try {
			const org = orgForUri(params?.uri);
			const list = await SoqlSchemaProvider.getObjectList(org);
			outputChannel.appendLine(`languageClient: objectList org=${org ?? "default"} → ${list.length} objects`);
			return list;
		} catch (e: any) {
			outputChannel.appendLine(`languageClient: objectList failed: ${e?.message ?? e}`);
			return [];
		}
	});

	client.onRequest(REQ_DESCRIBE, async (params: { uri?: string; sobject: string }) => {
		try {
			return await SoqlSchemaProvider.getDescribe(orgForUri(params?.uri), params?.sobject);
		} catch (e: any) {
			outputChannel.appendLine(`languageClient: describe failed: ${e?.message ?? e}`);
			return null;
		}
	});

	// Object-level admin Description (Tooling API; not in the standard describe).
	client.onRequest(REQ_OBJECT_INFO, async (params: { uri?: string; sobject: string }) => {
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
	client.onRequest(REQ_PROJECT_INFO, (params: { uri?: string }) => {
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
	const unsubscribe = OrgMetadataCache.onChange(() => {
		SoqlSchemaProvider.invalidateAll();
		void client?.sendNotification(NOTE_REFRESH).catch(() => {});
		// Regenerate ALL SObject schema stubs after org switch / pull / refresh
		// (force: the schema may have changed, so don't trust existing stubs).
		scheduleStubSync({ force: true });
	});

	// Initial background stub generation: incremental — only create stubs that
	// don't exist yet, so a reload with stubs already on disk does almost no work.
	scheduleStubSync();

	// Watch the Salesforce Apex LS and auto-restart it if it gets stuck stopped.
	startApexHealthMonitor(context);

	client.start();
	context.subscriptions.push({ dispose: unsubscribe });
	context.subscriptions.push({ dispose: () => void client?.stop() });
}

export function stopLanguageServer(): Thenable<void> | undefined {
	return client?.stop();
}

/**
 * Tell the language server to drop its cached schema so subsequent completion/
 * hover re-fetch it — used when a webview buffer's org override changes, since the
 * server caches describes by object name (not per org).
 */
export function refreshLanguageServerSchema(): void {
	void client?.sendNotification(NOTE_REFRESH).catch(() => {});
}

/**
 * Register buffer document URIs that must never have SObject stub files written
 * for them (their IntelliSense org may be non-default). Go-to-definition on an
 * SObject in these buffers won't generate stubs into the shared .sfdx folder.
 */
const ephemeralBufferUris = new Set<string>();
export function setEphemeralBuffers(uris: string[]): void {
	for (const u of uris) ephemeralBufferUris.add(u);
	void client?.sendNotification(NOTE_EPHEMERAL, { uris: [...ephemeralBufferUris] }).catch(() => {});
}

/**
 * Watch the Salesforce Apex Language Server and, if it's crashed/stuck after its
 * own retries, escalate to a **clean** restart (reset the Apex DB) — which fixes
 * the DB-corruption crash. Bounded: tries at most MAX_CLEAN_RESTARTS times; if it
 * still fails, shows the user one error and stops (no restart loop). The attempt
 * budget resets once the server is healthy again.
 */
const MAX_CLEAN_RESTARTS = 2;
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

	const timer = setInterval(async () => {
		try {
			const api = apexExt.isActive ? apexExt.exports : await apexExt.activate();
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
	}, 30000);

	context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
