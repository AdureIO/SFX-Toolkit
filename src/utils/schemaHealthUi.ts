/**
 * UI for schema fetch problems: one status bar item while any org is failing and a
 * single (throttled, see schemaHealth.PROBLEM_THROTTLE_MS) warning per org+problem —
 * never a popup per request.
 */
import * as vscode from "vscode";
import { setSchemaHealthSink, SchemaFailureKind } from "./schemaHealth";
import { outputChannel } from "./outputChannel";

export function registerSchemaHealthUi(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -110);
	item.command = "adure-sfx-toolkit.showOutput";
	const problems = new Map<string, { kind: SchemaFailureKind; message: string }>();
	/** org|kind pairs already shown as a popup this session (the status bar item stays). */
	const popped = new Set<string>();

	const render = () => {
		if (!problems.size) {
			item.hide();
			return;
		}
		const list = [...problems.values()];
		const auth = list.some((p) => p.kind === "sessionExpired" || p.kind === "noCredentials");
		item.text = auth ? "$(warning) ASFX schema: login needed" : "$(warning) ASFX schema: offline";
		item.tooltip = list.map((p) => p.message).join("\n");
		item.show();
	};

	setSchemaHealthSink({
		onProblem(orgKey, kind, message) {
			problems.set(orgKey, { kind, message });
			render();
			outputChannel.appendLine(message);
			// Popups only for problems the user must act on; offline is status-bar only.
			const id = `${orgKey}|${kind}`;
			if ((kind === "sessionExpired" || kind === "noCredentials") && !popped.has(id)) {
				popped.add(id);
				void vscode.window.showWarningMessage(message);
			}
		},
		onRecovered(orgKey) {
			if (problems.delete(orgKey)) render();
		},
	});

	context.subscriptions.push(item, new vscode.Disposable(() => setSchemaHealthSink(undefined)));
}
