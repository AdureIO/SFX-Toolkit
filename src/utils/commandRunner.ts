import * as cp from "child_process";
import * as vscode from "vscode";
import { Logger } from "./outputChannel";

export async function runCommandArgs(
	command: string,
	args: string[],
	cwd?: string,
	onOutput?: (data: string) => void,
	logOnError: boolean = true
): Promise<string> {
	Logger.info(`Executing Command: ${command} ${args.join(" ")}`);
	return new Promise((resolve, reject) => {
		const options: cp.SpawnOptions = {
			shell: false,
			cwd: cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		};

		const child = cp.spawn(command, args, options);

		let stdout = "";
		let stderr = "";

		if (child.stdout) {
			child.stdout.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;
				if (onOutput) {
					onOutput(chunk);
				}
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}

		child.on("error", (error) => {
			Logger.error(`Command error: ${command}`, error.message);
			reject(error);
		});

		child.on("close", (code) => {
			if (code === 0) {
				Logger.info(`Command executed successfully: ${command}`);
				resolve(stdout);
			} else {
				// The CLI might output useful info to STDOUT even on error (like failures tables).
				// We should capture that and not just stderr.
				const combinedOutput = stdout + (stderr ? "\n" + stderr : "");
				
				if (logOnError) {
					Logger.error(`Command failed: ${command}`, combinedOutput);
				} else {
					Logger.error(`Command failed: ${command}`);
				}

				const error = new Error(`Command exited with code ${code}`);
				(error as any).stderr = stderr;
				(error as any).stdout = stdout;
				(error as any).message = combinedOutput;
				reject(error);
			}
		});
	});
}

export async function runCommand(
	command: string,
	cwd?: string,
	onOutput?: (data: string) => void,
	logOnError: boolean = true
): Promise<string> {
	Logger.info(`Executing Command: ${command}`);
	return new Promise((resolve, reject) => {
		const options: cp.SpawnOptions = {
			shell: true,
			cwd: cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		};

		const child = cp.spawn(command, options);

		let stdout = "";
		let stderr = "";

		if (child.stdout) {
			child.stdout.on("data", (data) => {
				const chunk = data.toString();
				stdout += chunk;
				if (onOutput) {
					onOutput(chunk);
				}
			});
		}

		if (child.stderr) {
			child.stderr.on("data", (data) => {
				stderr += data.toString();
			});
		}

		child.on("error", (error) => {
			Logger.error(`Command error: ${command}`, error.message);
			reject(error);
		});

		child.on("close", (code) => {
			if (code === 0) {
				Logger.info(`Command executed successfully: ${command}`);
				resolve(stdout);
			} else {
				// The CLI might output useful info to STDOUT even on error (like failures tables).
				// We should capture that and not just stderr.
				const combinedOutput = stdout + (stderr ? "\n" + stderr : "");
				
				if (logOnError) {
					Logger.error(`Command failed: ${command}`, combinedOutput);
				} else {
					Logger.error(`Command failed: ${command}`);
				}

				const error = new Error(`Command exited with code ${code}`);
				(error as any).stderr = stderr;
				(error as any).stdout = stdout;
				(error as any).message = combinedOutput;
				reject(error);
			}
		});
	});
}
