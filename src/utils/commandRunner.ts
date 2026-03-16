import * as cp from "child_process";
import * as vscode from "vscode";
import { Logger } from "./outputChannel";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

/** Escape one arg for safe use inside shell -c '...' (single-quoted). */
function escapeArgForShell(arg: string): string {
	if (!/[\s'\\]/.test(arg)) return arg;
	return "'" + arg.replace(/\\/g, "\\\\").replace(/'/g, "'\\''") + "'";
}

export async function runCommandArgs(
	command: string,
	args: string[],
	cwd?: string,
	onOutput?: (data: string) => void,
	logOnError: boolean = true,
	timeoutMs?: number
): Promise<string> {
	Logger.info(`Executing Command: ${command} ${args.join(" ")}`);
	return new Promise((resolve, reject) => {
		const cwdPath = cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let child: cp.ChildProcess;

		if (process.platform === "win32") {
			child = cp.spawn(command, args, {
				shell: true,
				cwd: cwdPath,
			});
		} else {
			const fullCommand = [command, ...args.map(escapeArgForShell)].join(" ");
			const { argv0, args: shellArgs } = runViaLoginShell(fullCommand);
			child = cp.spawn(argv0, shellArgs, {
				shell: false,
				cwd: cwdPath,
			});
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
			clearTimeout(timer);
			Logger.error(`Command error: ${command}`, error.message);
			reject(error);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				const error = new Error(`Command timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${command}`);
				(error as any).timedOut = true;
				reject(error);
				return;
			}
			if (code === 0) {
				Logger.info(`Command executed successfully: ${command}`);
				resolve(stdout);
			} else {
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

/** On Unix, run via a login shell so PATH includes user's CLI (e.g. sf from Homebrew/nvm). */
function runViaLoginShell(command: string): { argv0: string; args: string[] } {
	const shellPath = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
	return { argv0: shellPath, args: ['-l', '-c', command] };
}

function shouldLogCommand(command: string): boolean {
	const t = command.trim();
	return !t.startsWith("git status --porcelain");
}

export async function runCommand(
	command: string,
	cwd?: string,
	onOutput?: (data: string) => void,
	logOnError: boolean = true,
	cancellationToken?: vscode.CancellationToken,
	timeoutMs?: number
): Promise<string> {
	if (shouldLogCommand(command)) Logger.info(`Executing Command: ${command}`);
	return new Promise((resolve, reject) => {
		const cwdPath = cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let child: cp.ChildProcess;
		const useProcessGroup = !!cancellationToken && process.platform !== "win32";
		if (process.platform === 'win32') {
			child = cp.spawn(command, {
				shell: true,
				cwd: cwdPath,
			});
		} else {
			const { argv0, args } = runViaLoginShell(command);
			child = cp.spawn(argv0, args, {
				shell: false,
				cwd: cwdPath,
				detached: useProcessGroup,
				stdio: useProcessGroup ? ["ignore", "pipe", "pipe"] : undefined,
			});
		}
		let cancelledByUser = false;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			if (useProcessGroup && child.pid) {
				try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
			} else {
				child.kill("SIGTERM");
			}
		}, timeoutMs ?? DEFAULT_TIMEOUT_MS);

		if (cancellationToken) {
			const sub = cancellationToken.onCancellationRequested(() => {
				cancelledByUser = true;
				clearTimeout(timer);
				if (useProcessGroup && child.pid) {
					try { process.kill(-child.pid, "SIGINT"); } catch { child.kill("SIGINT"); }
				} else {
					child.kill("SIGINT");
				}
			});
			child.on("close", () => sub.dispose());
		}

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
				const chunk = data.toString();
				stderr += chunk;
				if (onOutput) onOutput(chunk);
			});
		}

		child.on("error", (error) => {
			clearTimeout(timer);
			Logger.error(`Command error: ${command}`, error.message);
			reject(error);
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (cancelledByUser) {
				const err = new Error("Command cancelled.");
				(err as any).cancelled = true;
				reject(err);
				return;
			}
			if (timedOut) {
				const error = new Error(`Command timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${command}`);
				(error as any).timedOut = true;
				reject(error);
				return;
			}
			if (code === 0) {
				if (shouldLogCommand(command)) Logger.info(`Command executed successfully: ${command}`);
				resolve(stdout);
			} else {
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
