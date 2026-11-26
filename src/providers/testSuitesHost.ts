/**
 * Host side of the test-suite controls, shared by Deploy & Retrieve Metadata: the
 * save / delete messages of the webview mount (webview/shared/testSuites.ts) and the live update when the
 * other panel changed the suites of the project.
 */
import * as vscode from "vscode";
import { deleteTestSuite, onDidChangeTestSuites, TestSuite, upsertTestSuite } from "../utils/testSuites";
import { cleanNames, saveTarget } from "../utils/testSuitesPure";

export interface SuiteMessage {
	command?: string;
	suiteName?: string;
	testClassNames?: unknown;
}

/**
 * Handle `saveTestSuite` / `deleteTestSuite`. Returns true when the message was one of them (handled), after
 * which `send` was called with the new list, unless the user cancelled the name prompt.
 */
export async function handleSuiteMessage(msg: SuiteMessage, projectDir: string, send: (suites: TestSuite[]) => void): Promise<boolean> {
	if (msg.command === "saveTestSuite") {
		const testClassNames = cleanNames(msg.testClassNames);
		let name = saveTarget(msg.suiteName);
		if (!name) {
			const input = await vscode.window.showInputBox({
				title: "Save test suite",
				prompt: "Suite name",
				validateInput: (v) => (!v?.trim() ? "Name is required" : null),
			});
			if (!input?.trim()) return true;
			name = input.trim();
		}
		send(upsertTestSuite(projectDir, { name, testClassNames }));
		return true;
	}
	if (msg.command === "deleteTestSuite") {
		const name = (msg.suiteName ?? "").trim();
		if (name) send(deleteTestSuite(projectDir, name));
		return true;
	}
	return false;
}

/** Call `onChange(dir)` when the suites of `currentDir()` changed (by either panel). */
export function subscribeSuites(currentDir: () => string | undefined, onChange: (dir: string) => void): { dispose(): void } {
	return onDidChangeTestSuites((dir) => {
		if (dir === currentDir()) onChange(dir);
	});
}
