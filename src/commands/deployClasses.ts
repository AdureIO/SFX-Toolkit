import * as vscode from "vscode";
import * as glob from "glob";
import * as path from "path";
import * as fs from "fs";
import {
	loadPresets,
	addPreset,
	type DeployPreset,
	type DeployTypeKey,
} from "../utils/deployPresets";

const DEPLOY_TYPE_RUN_ALL = "Run All Tests";
const DEPLOY_TYPE_SPECIFIED = "Run Specified Tests";
const DEPLOY_TYPE_VALIDATE = "Validate Only (dry-run)";
const DEPLOY_TYPE_NO_TESTS = "No Test Run";

const LABEL_NEW = "New deployment";

function runDeploy(
	classPaths: string[],
	testLevel: string,
	testFlags: string,
	dryRun: boolean
): void {
	const sourceArgs = classPaths.map((c) => `-d "${c}"`).join(" ");
	const parts = [
		"sf project deploy start",
		sourceArgs,
		`-l ${testLevel}`,
		testFlags,
		dryRun ? "--dry-run" : "",
	];
	const cmd = parts.filter(Boolean).join(" ");
	const terminal = vscode.window.createTerminal("Salesforce Deploy");
	terminal.show();
	terminal.sendText(cmd);
}

function deployTypeToKey(label: string): DeployTypeKey {
	if (label === DEPLOY_TYPE_RUN_ALL) return "RunAllTestsInOrg";
	if (label === DEPLOY_TYPE_SPECIFIED) return "RunSpecifiedTests";
	if (label === DEPLOY_TYPE_VALIDATE) return "ValidateOnly";
	return "NoTestRun";
}

export async function deployClasses() {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		vscode.window.showErrorMessage("No workspace open");
		return;
	}
	const workspaceRoot = folder.uri.fsPath;
	const workspaceUri = folder.uri;

	const classFiles = glob.sync("**/*.cls", {
		cwd: workspaceRoot,
		ignore: ["**/node_modules/**", "**/bin/**"],
	});

	if (classFiles.length === 0) {
		vscode.window.showErrorMessage("No Apex classes found in workspace.");
		return;
	}

	const items = classFiles.map((f) => ({
		label: path.basename(f),
		description: f,
	}));

	// 0. New deployment vs Use preset
	const presets = await loadPresets(workspaceUri);
	const startChoices: { label: string; preset?: DeployPreset }[] = [
		{ label: LABEL_NEW },
		...presets.map((p) => ({ label: `Preset: ${p.name}`, preset: p })),
	];
	const startChoice = await vscode.window.showQuickPick(startChoices, {
		placeHolder: "New deployment or use a saved preset",
	});

	if (startChoice === undefined) return;

	if (startChoice.preset) {
		// Run from preset
		const preset = startChoice.preset;
		const missing = preset.classPaths.filter(
			(rel) => !fs.existsSync(path.join(workspaceRoot, rel))
		);
		if (missing.length > 0) {
			vscode.window.showErrorMessage(
				`Preset "${preset.name}": some classes no longer exist: ${missing.join(", ")}`
			);
			return;
		}
		let testLevel: string;
		let testFlags = "";
		const dryRun = preset.deployType === "ValidateOnly";
		if (preset.deployType === "RunAllTestsInOrg") testLevel = "RunAllTestsInOrg";
		else if (preset.deployType === "RunSpecifiedTests") {
			testLevel = "RunSpecifiedTests";
			testFlags = preset.testClassNames.map((t) => `-t ${t}`).join(" ");
		} else if (preset.deployType === "ValidateOnly") testLevel = "RunLocalTests";
		else testLevel = "NoTestRun";

		const runChoice = await vscode.window.showQuickPick(
			[{ label: "Run", description: `Deploy ${preset.classPaths.length} class(es)` }, { label: "Cancel" }],
			{ placeHolder: `Preset: ${preset.name}` }
		);
		if (runChoice === undefined || runChoice.label === "Cancel") return;
		runDeploy(preset.classPaths, testLevel, testFlags, dryRun);
		return;
	}

	// 1. Select classes to deploy
	const selectedClasses = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		placeHolder: "Select Apex Classes to deploy",
	});

	if (selectedClasses === undefined) return;
	if (selectedClasses.length === 0) {
		vscode.window.showInformationMessage("No classes selected. Deploy cancelled.");
		return;
	}

	// 2. Select deploy type
	const deployTypes = [
		{ label: DEPLOY_TYPE_RUN_ALL, detail: "RunAllTestsInOrg" },
		{ label: DEPLOY_TYPE_SPECIFIED, detail: "RunSpecifiedTests – choose test classes next" },
		{ label: DEPLOY_TYPE_VALIDATE, detail: "Validate only (dry-run), no save to org" },
		{ label: DEPLOY_TYPE_NO_TESTS, detail: "NoTestRun" },
	];
	const chosenType = await vscode.window.showQuickPick(deployTypes, {
		placeHolder: "Select deploy / test option",
		matchOnDetail: true,
	});

	if (chosenType === undefined) return;

	let testLevel: string;
	let testFlags = "";
	const dryRun = chosenType.label === DEPLOY_TYPE_VALIDATE;
	let testClassNames: string[] = [];

	if (chosenType.label === DEPLOY_TYPE_RUN_ALL) {
		testLevel = "RunAllTestsInOrg";
	} else if (chosenType.label === DEPLOY_TYPE_SPECIFIED) {
		testLevel = "RunSpecifiedTests";
		const testClassItems = items.filter((i) => /test/i.test(i.label));
		if (testClassItems.length === 0) {
			vscode.window.showWarningMessage(
				'No test classes found (names containing "Test"). Deploy cancelled.'
			);
			return;
		}
		const selectedTests = await vscode.window.showQuickPick(testClassItems, {
			canPickMany: true,
			placeHolder: "Select Test Classes to run",
		});
		if (selectedTests === undefined) return;
		if (selectedTests.length === 0) {
			vscode.window.showInformationMessage(
				"No test classes selected for Run Specified Tests. Deploy cancelled."
			);
			return;
		}
		testClassNames = selectedTests.map((t) => path.basename(t.label, ".cls"));
		testFlags = testClassNames.map((t) => `-t ${t}`).join(" ");
	} else if (chosenType.label === DEPLOY_TYPE_VALIDATE) {
		testLevel = "RunLocalTests";
	} else {
		testLevel = "NoTestRun";
	}

	const classPaths = selectedClasses.map((c) => c.description);

	// 3. Run or Save as preset
	const actionChoice = await vscode.window.showQuickPick(
		[
			{ label: "Run", description: "Run deploy now" },
			{ label: "Save as preset...", description: "Save this configuration for later" },
		],
		{ placeHolder: "Run deploy or save as preset" }
	);

	if (actionChoice === undefined) return;

	if (actionChoice.label === "Save as preset...") {
		const name = await vscode.window.showInputBox({
			prompt: "Preset name",
			placeHolder: "e.g. My Feature Deploy",
			validateInput: (v) => (v.trim() ? null : "Enter a name"),
		});
		if (name === undefined) return;
		const trimmed = name.trim();
		if (!trimmed) return;
		const preset: DeployPreset = {
			name: trimmed,
			classPaths,
			deployType: deployTypeToKey(chosenType.label),
			testClassNames,
		};
		await addPreset(workspaceUri, preset);
		vscode.window.showInformationMessage(`Preset "${trimmed}" saved.`);
		const runNow = await vscode.window.showQuickPick(
			[{ label: "Yes", description: "Run deploy now" }, { label: "No" }],
			{ placeHolder: "Run deploy now?" }
		);
		if (runNow === undefined || runNow.label === "No") return;
	}

	runDeploy(classPaths, testLevel, testFlags, dryRun);
}
