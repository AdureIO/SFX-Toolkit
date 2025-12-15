import * as vscode from "vscode";
import { runCommand } from "../utils/commandRunner";
import * as fs from "fs";
import * as path from "path";
import { Logger, outputChannel } from "../utils/outputChannel";
import { AuthInfo } from "../utils/authInfo";

// Helper to strip ANSI and progress lines
function cleanDeployOutput(output: string): string {
	const cleanData = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

	// Find where the final status block starts
	// It usually starts with "Status: Succeeded" or "Status: Failed"
	const statusMatch = cleanData.match(/Status: (Succeeded|Failed|SucceededPartial)/);

	if (statusMatch && statusMatch.index !== undefined) {
		// Find the start of the line where Status appears to include indentation
		const lineStart = cleanData.lastIndexOf("\n", statusMatch.index);
		const startIndex = lineStart !== -1 ? lineStart + 1 : statusMatch.index;

		// If failed, we might want to capture context before the status if it contains "Component Failures"
		// But usually "Component Failures" comes AFTER the status line in CLI output.
		// Let's check the user provided example:
		// Status: Failed ... Elapsed Time ... Component Failures [...] Table...
		// So capturing from Status onwards is correct for the standard table.

		return cleanData.substring(startIndex).trim();
	}

	// Fallback if no standard status line found (e.g. strict failure or different format)
	// We want to keep everything except progress updates.
	const lines = cleanData.split(/\r?\n/);
	const filtered = lines.filter((line) => {
		const l = line.trim();
		// Filter header and intro
		if (l.includes("Deploying Metadata") && l.includes("──")) return false;
		if (l.includes("Deploying v") && l.includes("metadata to")) return false;

		// Filter progress lines starting with symbols or specific keywords
		if (/[✔◯▸]/.test(l)) return false;

		if (l.startsWith("Preparing")) return false;
		if (l.startsWith("Waiting for the org to respond")) return false;
		if (l.startsWith("Running Tests")) return false;
		if (l.startsWith("Updating Source Tracking")) return false;
		if (l.startsWith("Components:")) return false;
		if (l.startsWith("Members:")) return false;

		if (l === "Done" || l.startsWith("Done ")) return false;

		// For failures without a "Status:" line, we typically want to see everything else (e.g. Warnings, Errors).
		// But user asked to skip output before status "just like with completed".
		// If there is NO status line, we can't skip "before" it easily without losing the error.
		// However, the user might be referring to cases where "Component Failures" exists but regex missed Status?
		// Or maybe they mean "Component Failures" block should be the start if Status is missing?

		return true;
	});

	// If we have "Component Failures", try to start from there if we didn't find "Status:"
	const result = filtered.join("\n").trim();
	const failuresMatch = result.match(/Component Failures \[\d+\]/);
	if (failuresMatch && failuresMatch.index !== undefined) {
		return result.substring(failuresMatch.index).trim();
	}

	return result;
}

// Helper to extract deployed component count from output
function getDeployedCount(output: string): number {
	const clean = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");

	// Strategy 1: Look for "Status: ... | N/M Components"
	const statusMatch = clean.match(/\|\s*(\d+)\/\d+\s*Components/);
	if (statusMatch) {
		return parseInt(statusMatch[1], 10);
	}

	// Strategy 2: Count lines in "Deployed Source" table
	const lines = output.split(/\r?\n/);
	let inTable = false;
	let count = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.includes("Deployed Source") && !line.startsWith("Not")) {
			inTable = true;
			i += 2; // Skip headers (Table header and separator)
			continue;
		}
		if (inTable) {
			if (!line || line.startsWith("Not Deployed Source") || line.startsWith("Retrieved Source")) {
				break;
			}
			// Check if it's a table row (starts with box chars or has content)
			// Simple check: if it has │ separator
			if (line.includes("│")) {
				count++;
			}
		}
	}

	return count;
}

// Helper to reuse push logic
async function pushSourceHelper(force: boolean) {
	const title = "ASFXT: " + (force ? " F-" : " ") + "Push";

	// Ensure active file is saved before pushing
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		await activeEditor.document.save();
	}

	// We want to stream output to the log so user sees progress.
	outputChannel.clear();
	// outputChannel.show(); // Only show on error or explicit request
	Logger.info(`Starting Push Operation: ${title}`);

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
	statusBar.command = "adure-sfx-toolkit.showOutput";
	statusBar.text = "$(sync~spin) Deploying...";
	statusBar.tooltip = "Click to Show Deployment Logs";
	statusBar.show();

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: title,
				cancellable: false,
			},
			async (progress) => {
				try {
					// 1. Detect sfdx-project.json
					const workspaceFolders = vscode.workspace.workspaceFolders;
					if (!workspaceFolders) {
						// Fallback
						const flag = force ? "--ignore-conflicts" : "";
						Logger.info(`Running: sf project deploy start ${flag}`);
						const result = await runCommand(`sf project deploy start ${flag}`);
						Logger.info(result);
						vscode.window.showInformationMessage("Source pushed successfully (No workspace).");
						return;
					}

					const rootPath = workspaceFolders[0].uri.fsPath;
					const projectJsonPath = path.join(rootPath, "sfdx-project.json");

					let packageDirs: string[] = [];

					if (fs.existsSync(projectJsonPath)) {
						try {
							const content = fs.readFileSync(projectJsonPath, "utf8");
							const projectConfig = JSON.parse(content);
							if (projectConfig.packageDirectories && Array.isArray(projectConfig.packageDirectories)) {
								packageDirs = projectConfig.packageDirectories.map((pkg: any) => pkg.path);
							}
						} catch (jsonErr) {
							Logger.error("Error parsing sfdx-project.json", jsonErr);
						}
					}

					// State for status updates
					let lastPrefix = "";
					let currentPhase = "";
					let currentDetails = "";
					const startTime = Date.now();

					// Common callback to stream output to log and update progress
					const handleOutput = (data: string, prefix?: string) => {
						// Reset state if prefix changes (new package)
						if (prefix && prefix !== lastPrefix) {
							lastPrefix = prefix;
							currentPhase = "";
							currentDetails = "";
						}

						// Strip ANSI codes but keep non-ASCII (spinners, checkmarks)
						// We need to see spinners to know what's active.
						const cleanData = data.replace(
							/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
							""
						);

						const lines = cleanData.split(/[\r\n]+/);

						// 1. Determine Status Message for Notification
						for (const line of lines) {
							const l = line.trim();
							if (!l) continue;

							// Check for spinner/activity indicators
							// \u2800-\u28FF are Braille patterns often used for spinners
							// \u2026 is ellipsis ...
							// \u22EE is vertical ellipsis
							const isSpinner = /[\u2800-\u28FF\u2026\u22EE]/.test(l);
							const isCheckmark = /[✓\u2713\u2714]/.test(l);
							const isSquare = /[▪■]/.test(l); // Often used for pending steps

							// If line has a spinner, it is the active phase!
							if (isSpinner) {
								// Extract the text part of the line (remove spinner) to preserve time info if present
								const cleanLine = l.replace(/^[^\w\s]+/, "").trim();

								if (l.includes("Deploying Metadata")) {
									currentPhase = cleanLine;
								} else if (l.includes("Running Tests")) {
									currentPhase = cleanLine;
									currentDetails = "";
								} else if (l.includes("Preparing")) {
									currentPhase = cleanLine;
								} else if (l.includes("Waiting for the org to respond")) {
									currentPhase = cleanLine;
								}
							}
							// If line has a checkmark, it is done. Don't set as current phase if we have a spinner.
							else if (isCheckmark) {
								// Do nothing, or maybe set as "Last Completed: ..." if we wanted more detail.
							}
							// If line has a square, it is likely pending.
							else if (isSquare) {
								// Do nothing, wait for it to spin.
							}
							// Fallback logic for lines without clear indicators or standard status lines
							else {
								if (l.includes("Components:")) {
									currentDetails = l.replace(/^[^\w\s]+/, "").trim();
								} else if (l.startsWith("Status:")) {
									if (!l.includes("In Progress") && !l.includes("Pending")) {
										const s = l.replace("Status:", "").trim();
										if (s.length > 0) {
											// Prevent "Running Tests" from being overwritten by stale status lines
											if (currentPhase === "Running Tests" && !l.includes("Running Tests")) {
												// Ignore status updates if we are already in Running Tests phase,
												// unless the new status is "Done" or "Failed"
												if (s === "Done" || s === "Failed" || s === "Succeeded") {
													currentPhase = `Status: ${s}`;
												}
											} else {
												currentPhase = `Status: ${s}`;
											}
										}
									}
								}
							}
						}

						const statusMsg = [currentPhase, currentDetails].filter(Boolean).join(" | ");
						if (statusMsg) {
							const msg = prefix ? `${prefix}: ${statusMsg}` : statusMsg;
							progress.report({ message: msg });
							statusBar.text = `$(sync~spin) ${msg}`;
						}
					};

					// Check if source tracking is active locally
					// Logic: Get Org ID and check if .sf/orgs/<OrgID> exists
					let hasSourceTracking = false;

					try {
						const authInfo = await AuthInfo.getAuthInfo();
						if (authInfo && authInfo.orgId) {
							const sfOrgPath = path.join(rootPath, ".sf", "orgs", authInfo.orgId);
							if (fs.existsSync(sfOrgPath)) {
								hasSourceTracking = true;
							}
						}
					} catch (e) {
						Logger.warn("Failed to check source tracking status. Assuming no tracking.");
					}

					if (hasSourceTracking) {
						// Use Source Tracking (Deploy changes only)
						progress.report({ message: "Deploying project (Source Tracking)..." });
						const flag = force ? "--ignore-conflicts" : "";
						Logger.info(`Running: sf project deploy start ${flag}`);

						const result = await runCommand(
							`sf project deploy start ${flag}`,
							undefined,
							(data) => handleOutput(data),
							false
						);
						Logger.info(cleanDeployOutput(result));

						const count = getDeployedCount(result);
						vscode.window.showInformationMessage(`ASFXT: Push: Deployed ${count} components.`);
					} else {
						// No Source Tracking -> Full Sequential Deploy
						if (packageDirs.length > 0) {
							progress.report({ message: `Found ${packageDirs.length} package directories.` });

							let totalCount = 0;

							for (const pkgDir of packageDirs) {
								const fullPkgPath = path.join(rootPath, pkgDir);
								if (!fs.existsSync(fullPkgPath)) continue;

								progress.report({ message: `Starting ${pkgDir}...` });
								const flag = force ? "--ignore-conflicts" : "";
								Logger.info(`Deploying Package: ${pkgDir}`);

								const result = await runCommand(
									`sf project deploy start -d "${fullPkgPath}" ${flag}`,
									undefined,
									(data) => handleOutput(data, pkgDir),
									false
								);
								Logger.info(cleanDeployOutput(result));
								totalCount += getDeployedCount(result);
							}
							vscode.window.showInformationMessage(
								`Successfully pushed source for ${packageDirs.length} packages. Deployed ${totalCount} components.`
							);
						} else {
							// Fallback if no packages found
							progress.report({ message: "Deploying project..." });
							const flag = force ? "--ignore-conflicts" : "";
							Logger.info(`Running: sf project deploy start ${flag}`);

							const result = await runCommand(`sf project deploy start ${flag}`, undefined, (data) =>
								handleOutput(data)
							);
							Logger.info(cleanDeployOutput(result));

							const count = getDeployedCount(result);
							vscode.window.showInformationMessage(
								`Source pushed successfully. Deployed ${count} components.`
							);
						}
					}
				} catch (e: any) {
					// e.message contains combined stdout/stderr from commandRunner
					const cleanError = cleanDeployOutput(e.message || e.stderr || "Unknown Error");
					Logger.error(`Push failed:`, cleanError);
					outputChannel.show(); // Auto-open log on error

					vscode.window
						.showErrorMessage(`Push failed. Check output log for details.`, "View Log")
						.then((selection) => {
							if (selection === "View Log") {
								outputChannel.show();
							}
						});
				}
			}
		);
	} finally {
		statusBar.dispose();
	}
}

export async function pushSource() {
	await pushSourceHelper(false);
}

export async function pushSourceForce() {
	await pushSourceHelper(true);
}

export async function pullSource() {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Pulling Source from Default Org...",
			cancellable: false,
		},
		async () => {
			try {
				await runCommand("sf project retrieve start");
				vscode.window.showInformationMessage("Source pulled successfully.");
			} catch (e: any) {
				vscode.window.showErrorMessage(`Pull failed: ${e.message}`);
			}
		}
	);
}

export async function deployCurrentFile() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("No active editor.");
		return;
	}

	await editor.document.save(); // Save the current file before deploying

	const filePath = editor.document.uri.fsPath;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Deploying current file...",
			cancellable: false,
		},
		async () => {
			try {
				// Use --source-dir or -d to deploy specific file/path
				const result = await runCommand(`sf project deploy start -d "${filePath}"`);
				const count = getDeployedCount(result);
				vscode.window.showInformationMessage(`File deployed successfully. Deployed ${count} components.`);
			} catch (e: any) {
				vscode.window.showErrorMessage(`Deploy failed: ${e.message}`);
			}
		}
	);
}

export async function retrieveCurrentFile() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("No active editor.");
		return;
	}

	const filePath = editor.document.uri.fsPath;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Retrieving current file...",
			cancellable: false,
		},
		async () => {
			try {
				await runCommand(`sf project retrieve start -d "${filePath}"`);
				vscode.window.showInformationMessage("File retrieved successfully.");
			} catch (e: any) {
				vscode.window.showErrorMessage(`Retrieve failed: ${e.message}`);
			}
		}
	);
}

export async function runLocalTests() {
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Running Local Tests...",
			cancellable: true,
		},
		async (progress, token) => {
			try {
				// -w 10 (wait 10 mins), -l RunLocalTests, -r human
				// Use runCommand but maybe output to channel?
				// Tests can have long output.

				const result = await runCommand("sf apex run test -l RunLocalTests -w 10 -r human");

				const channel = vscode.window.createOutputChannel("Salesforce Test Results");
				channel.clear();
				channel.append(result);
				channel.show();

				if (result.includes("Pass") && !result.includes("Fail")) {
					vscode.window.showInformationMessage("Tests Passed.");
				} else {
					vscode.window.showWarningMessage("Some tests failed. Check output.");
				}
			} catch (e: any) {
				vscode.window.showErrorMessage(`Tests execution failed.`);
				const channel = vscode.window.createOutputChannel("Salesforce Test Results");
				channel.append(e.stderr || e.message);
				channel.show();
			}
		}
	);
}

export async function resetSourceTracking() {
	// Usually target org is the default one, but let's confirm or assume default.
	// User requested: sf project reset tracking --target-org my-scratch
	// We will use the default target org unless we add UI to select.
	// For now, let's assume default to keep it simple as per other commands.

	const confirm = await vscode.window.showWarningMessage(
		"Are you sure you want to reset source tracking for the default org? This cannot be undone.",
		"Yes",
		"No"
	);

	if (confirm !== "Yes") return;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Resetting Source Tracking...",
			cancellable: false,
		},
		async () => {
			try {
				const result = await runCommand("sf project reset tracking --no-prompt");
				Logger.info(result);
				vscode.window.showInformationMessage("Source tracking reset successfully.");
			} catch (e: any) {
				const msg = e.stderr || e.message;
				Logger.error("Reset tracking failed:", msg);
				vscode.window.showErrorMessage(`Reset tracking failed: ${msg}`);
			}
		}
	);
}
