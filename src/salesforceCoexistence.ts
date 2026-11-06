/**
 * Living next to the Salesforce Apex extension (Jorje) without duplicate results or its
 * unbounded memory use:
 *
 *  1. Silences Jorje's completion / hover / definition / references / highlights /
 *     signature help via its client middleware while OUR server answers them.
 *  2. One-time recommendation to cap Jorje's heap and to review the TS Apex server extension.
 */
import * as vscode from "vscode";
import { outputChannel } from "./utils/outputChannel";
import { onDidChangeOwnServerState, ownServerStatus } from "./languageClient";
import { MiddlewareSuppressor, keysToSuppress } from "./utils/apexProviderSuppression";
import {
	JORJE_EXTENSION_ID,
	TS_APEX_EXTENSION_ID,
	JORJE_MEMORY_SECTION,
	JORJE_MEMORY_KEY,
	JORJE_MEMORY_LIMIT_MB,
	MEMORY_TIP_SHOWN_KEY,
	planMemoryTip,
	memoryTipMessage,
} from "./utils/salesforceMemoryTips";
import { forceApexRestart } from "./utils/sobjectStubSync";
import { isWorkspaceUsable } from "./utils/projectUtils";

const CONFIG = "adure-sfx-toolkit";
/** Jorje restarts create a new client (new middleware object): look for it this often. */
const POLL_MS = 3000;
const COMMAND_OPTIMIZE = "adure-sfx-toolkit.optimizeSalesforceMemory";

let registered = false;

export function registerSalesforceCoexistence(context: vscode.ExtensionContext): void {
	if (registered) return;
	registered = true;
	context.subscriptions.push(
		{ dispose: () => (registered = false) },
		vscode.commands.registerCommand(COMMAND_OPTIMIZE, () => showMemoryTip(context, true)),
	);
	startJorjeSuppression(context);
	if (isWorkspaceUsable()) {
		const t = setTimeout(() => void showMemoryTip(context, false), 8000);
		t.unref?.();
		context.subscriptions.push({ dispose: () => clearTimeout(t) });
	}
}

// ─── 1. Jorje provider suppression ────────────────────────────────────────────

function jorjeClient(): any | undefined {
	const ext = vscode.extensions.getExtension(JORJE_EXTENSION_ID);
	// Never activate it ourselves: that would boot its JVM where nothing asked for it.
	if (!ext?.isActive) return undefined;
	try {
		return (ext.exports as any)?.languageClientManager?.getClientInstance?.() ?? undefined;
	} catch {
		return undefined;
	}
}

function startJorjeSuppression(context: vscode.ExtensionContext): void {
	const suppressor = new MiddlewareSuppressor();
	const hooked = new WeakSet<object>();
	let loggedFor: object | undefined;
	let lastLogged = "";

	const evaluate = (): void => {
		try {
			const c = jorjeClient();
			const mw = c?.middleware;
			const own = ownServerStatus();
			const prefer = vscode.workspace.getConfiguration(CONFIG).get<boolean>("apex.preferOwnProviders", true);
			const keys = keysToSuppress({
				jorjeClientAvailable: !!mw && typeof mw === "object",
				ownServerRunning: own.running,
				preferOwnProviders: prefer,
				apexFeatures: own.apexFeatures,
				apexCompletion: own.apexCompletion,
			});
			if (c && typeof c.onDidChangeState === "function" && !hooked.has(c)) {
				hooked.add(c);
				const d = c.onDidChangeState(() => evaluate());
				if (d?.dispose) context.subscriptions.push(d);
			}
			if (!mw || typeof mw !== "object") {
				// Jorje gone or not started: nothing to patch (a stale object is garbage).
				suppressor.restore();
				return;
			}
			if (keys.length === 0) {
				if (suppressor.isBoundTo(mw)) suppressor.apply(mw, []);
				else suppressor.restore();
			} else {
				suppressor.apply(mw, keys);
			}
			const summary = suppressor.active().sort().join(",");
			if (summary !== lastLogged || loggedFor !== c) {
				if (summary || lastLogged) {
					outputChannel.appendLine(
						summary
							? `Salesforce coexistence: silencing Salesforce Apex providers (${summary}); ASFX answers them.`
							: "Salesforce coexistence: Salesforce Apex providers restored.",
					);
				}
				lastLogged = summary;
				loggedFor = c;
			}
		} catch (e: any) {
			outputChannel.appendLine(`Salesforce coexistence: could not adjust Salesforce Apex providers (${e?.message ?? e}).`);
		}
	};

	evaluate();
	const timer = setInterval(evaluate, POLL_MS);
	timer.unref?.();
	context.subscriptions.push(
		{
			dispose: () => {
				clearInterval(timer);
				try {
					suppressor.restore();
				} catch {
					/* ignore */
				}
			},
		},
		onDidChangeOwnServerState(() => evaluate()),
		vscode.extensions.onDidChange(() => evaluate()),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${CONFIG}.apex`)) evaluate();
		}),
	);
}

// ─── 2. RAM recommendation ───────────────────────────────────────────────────

async function showMemoryTip(context: vscode.ExtensionContext, force: boolean): Promise<void> {
	try {
		const jorjeMemory = vscode.workspace.getConfiguration(JORJE_MEMORY_SECTION).get<unknown>(JORJE_MEMORY_KEY);
		const plan = planMemoryTip({
			jorjeInstalled: !!vscode.extensions.getExtension(JORJE_EXTENSION_ID),
			jorjeMemory,
			// getExtension only returns enabled extensions.
			tsServerEnabled: !!vscode.extensions.getExtension(TS_APEX_EXTENSION_ID),
			alreadyShown: context.globalState.get<boolean>(MEMORY_TIP_SHOWN_KEY, false),
			force,
		});
		if (!plan.show) {
			if (force) void vscode.window.showInformationMessage("Nothing to optimize: the Salesforce extensions are already limited or not installed.");
			return;
		}
		await context.globalState.update(MEMORY_TIP_SHOWN_KEY, true);

		const LIMIT = "Limit Jorje to 1 GB";
		const SHOW_TS = "Show TS Apex server";
		const NOT_NOW = "Not now";
		const buttons = [...(plan.offerLimitJorje ? [LIMIT] : []), ...(plan.offerShowTsServer ? [SHOW_TS] : []), NOT_NOW];
		const choice = await vscode.window.showInformationMessage(memoryTipMessage(plan), ...buttons);

		if (choice === LIMIT) {
			await vscode.workspace
				.getConfiguration(JORJE_MEMORY_SECTION)
				.update(JORJE_MEMORY_KEY, JORJE_MEMORY_LIMIT_MB, vscode.ConfigurationTarget.Global);
			outputChannel.appendLine(`Salesforce coexistence: set ${JORJE_MEMORY_SECTION}.${JORJE_MEMORY_KEY}=${JORJE_MEMORY_LIMIT_MB} (user setting).`);
			const RESTART = "Restart Apex Language Server";
			const next = await vscode.window.showInformationMessage("Jorje is limited to 1 GB. Restart the Apex Language Server to apply it.", RESTART);
			if (next === RESTART) {
				const ok = await forceApexRestart(vscode);
				if (!ok) {
					void vscode.window.showWarningMessage("Could not restart automatically. Run 'SFDX: Restart Apex Language Server' or reload the window.");
				}
			}
		} else if (choice === SHOW_TS) {
			try {
				await vscode.commands.executeCommand("extension.open", TS_APEX_EXTENSION_ID);
			} catch {
				await vscode.commands.executeCommand("workbench.extensions.search", `@installed ${TS_APEX_EXTENSION_ID}`);
			}
		}
	} catch (e: any) {
		outputChannel.appendLine(`Salesforce coexistence: memory tip failed (${e?.message ?? e}).`);
	}
}
