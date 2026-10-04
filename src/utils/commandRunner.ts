import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./outputChannel";

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

/** Process name prefix so extension-spawned processes show as "ASFX sf", "ASFX git" in Activity Monitor. */
const ASFX_PROCESS_PREFIX = "ASFX";

const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// Child process tracking
// ---------------------------------------------------------------------------

/**
 * Every child spawned by this module, with whether it leads its own process group
 * (Unix `detached`). Entries are removed on `close`. `killAllChildProcesses()` uses
 * this on deactivate so no CLI process outlives the window.
 */
const activeChildren = new Map<cp.ChildProcess, boolean>();

function track(child: cp.ChildProcess, processGroup: boolean): void {
  activeChildren.set(child, processGroup);
  const untrack = () => activeChildren.delete(child);
  child.once("close", untrack);
  child.once("error", untrack);
}

/** Kill a child; for group leaders the whole group (sf spawns node workers) is signalled. */
function killChild(child: cp.ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (processGroup && child.pid && !IS_WINDOWS) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone or not a leader; fall through to the direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function isAlive(child: cp.ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * Kill every child process still running (SIGTERM, then SIGKILL after a short grace
 * period for anything that ignored it). Call from the extension's deactivate().
 */
export function killAllChildProcesses(): void {
  const children = [...activeChildren.entries()];
  activeChildren.clear();
  if (children.length === 0) return;
  for (const [child, group] of children) {
    if (isAlive(child)) killChild(child, "SIGTERM", group);
  }
  const t = setTimeout(() => {
    for (const [child, group] of children) {
      if (isAlive(child)) killChild(child, "SIGKILL", group);
    }
  }, 1500);
  t.unref();
}

// ---------------------------------------------------------------------------
// Environment / PATH resolution (Unix)
// ---------------------------------------------------------------------------

/** Env added to spawned processes so they can be identified (Windows + scripting). */
function asfxEnv(baseCommand: string, pathOverride?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ASFX: "1",
    ASFX_CMD: baseCommand,
    // Recent Salesforce CLI releases hide secrets (incl. the access token) from
    // `sf org display --json`. Without the token, every authenticated call fails
    // with a misleading "session expired / revoked" error. This env var restores
    // the token in the JSON output (the CLI's own documented workaround). Honor an
    // existing user-set value if present.
    SF_TEMP_SHOW_SECRETS: process.env.SF_TEMP_SHOW_SECRETS ?? "true"
  };
  if (pathOverride) env.PATH = pathOverride;
  return env;
}

function userShell(): string {
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

const PATH_START = "__ASFX_PATH_START__";
const PATH_END = "__ASFX_PATH_END__";
let loginPathPromise: Promise<string | undefined> | undefined;

/**
 * Resolve the user's login-shell PATH once (Homebrew / nvm / volta setups are only on
 * PATH after the profile ran, and VS Code launched from the Dock doesn't inherit it).
 * Markers strip any noise the profile prints. Resolves undefined on failure, in which
 * case callers fall back to running every command through the login shell.
 */
function resolveLoginPath(): Promise<string | undefined> {
  if (!loginPathPromise) {
    loginPathPromise = new Promise<string | undefined>((resolve) => {
      let out = "";
      let child: cp.ChildProcess;
      try {
        // Works in sh/bash/zsh and fish (fish joins path variables with ':' when quoted).
        child = cp.spawn(userShell(), ["-l", "-c", `printf '%s%s%s' ${PATH_START} "$PATH" ${PATH_END}`], {
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          env: process.env
        });
      } catch {
        resolve(undefined);
        return;
      }
      track(child, false);
      const timer = setTimeout(() => killChild(child, "SIGKILL", false), 10000);
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const s = out.lastIndexOf(PATH_START);
        const e = out.lastIndexOf(PATH_END);
        const value = s >= 0 && e > s ? out.slice(s + PATH_START.length, e).trim() : "";
        resolve(value && value.includes("/") ? value : undefined);
      });
    }).then((p) => {
      if (!p) {
        Logger.info("Could not resolve login-shell PATH; falling back to login shell per command.");
        loginPathPromise = undefined; // retry on next call
      }
      return p;
    });
  }
  return loginPathPromise;
}

let bashPathCache: string | null | undefined;
/** /bin/bash when present (needed for `exec -a`, which POSIX sh lacks). */
function bashPath(): string | null {
  if (bashPathCache === undefined) {
    bashPathCache = fs.existsSync("/bin/bash") ? "/bin/bash" : null;
  }
  return bashPathCache;
}

function processName(firstWord: string): string {
  const name = /^[a-zA-Z0-9_-]+$/.test(firstWord) ? firstWord : "sh";
  return `${ASFX_PROCESS_PREFIX} ${name}`;
}

/** On Unix, wrap command so the process shows as "ASFX <cmd>" in process monitor (uses exec -a). */
function wrapWithAsfxProcessName(fullCommand: string, firstWord: string): string {
  // `exec` replaces the shell, so anything after a control operator (&&, |, ;) would never
  // run. Only rename simple commands; operators inside quotes just skip the naming.
  if (/[;&|\n]/.test(fullCommand.replace(/'[^']*'/g, ""))) return fullCommand;
  return `exec -a "${processName(firstWord)}" ${fullCommand}`;
}

/** Fallback: run via a login shell so PATH includes user's CLI (e.g. sf from Homebrew/nvm). */
function runViaLoginShell(command: string): { argv0: string; args: string[] } {
  const shellPath = userShell();
  // fish is not POSIX; the command strings we build are sh syntax.
  if (/\/fish$/.test(shellPath)) {
    return { argv0: shellPath, args: ["-l", "-c", `exec /bin/sh -c ${escapePosixArg(command)}`] };
  }
  return { argv0: shellPath, args: ["-l", "-c", command] };
}

/**
 * Unix spawn plan for an argv-style command. With a resolved PATH the command runs
 * without any profile re-read: bash `exec -a` keeps the "ASFX <cmd>" process name and
 * receives the argv as positional parameters (never re-parsed, so no injection); without
 * bash the command is spawned directly.
 */
function unixArgvPlan(command: string, args: string[], loginPath: string | undefined): { file: string; argv: string[]; env: NodeJS.ProcessEnv } {
  if (!loginPath) {
    const fullCommand = [command, ...args.map(escapeArgForShell)].join(" ");
    const { argv0, args: shellArgs } = runViaLoginShell(wrapWithAsfxProcessName(fullCommand, command));
    return { file: argv0, argv: shellArgs, env: asfxEnv(command) };
  }
  const env = asfxEnv(command, loginPath);
  const bash = bashPath();
  if (bash) {
    return { file: bash, argv: ["-c", `exec -a "${processName(command)}" "$0" "$@"`, command, ...args], env };
  }
  return { file: command, argv: args, env };
}

/** Unix spawn plan for a shell-string command (sh syntax). */
function unixStringPlan(command: string, firstWord: string, loginPath: string | undefined): { file: string; argv: string[]; env: NodeJS.ProcessEnv } {
  if (!loginPath) {
    const { argv0, args } = runViaLoginShell(wrapWithAsfxProcessName(command, firstWord));
    return { file: argv0, argv: args, env: asfxEnv(firstWord) };
  }
  const env = asfxEnv(firstWord, loginPath);
  const bash = bashPath();
  if (bash) return { file: bash, argv: ["-c", wrapWithAsfxProcessName(command, firstWord)], env };
  return { file: "/bin/sh", argv: ["-c", command], env };
}

// ---------------------------------------------------------------------------
// Windows argv handling
// ---------------------------------------------------------------------------

// cmd.exe metacharacters (same set as cross-spawn).
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument for a `cmd.exe /d /s /c "..."` command line: MSVCRT quoting
 * (backslashes before quotes doubled, quotes backslash-escaped, wrapped in quotes),
 * then every cmd metacharacter caret-escaped. `.cmd`/`.bat` targets (npm shims like
 * sf.cmd) are parsed by cmd a second time, so carets are applied twice for them.
 * This is the cross-spawn algorithm.
 */
export function escapeCmdArg(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  a = a.replace(CMD_META_RE, "^$1");
  if (doubleEscape) a = a.replace(CMD_META_RE, "^$1");
  return a;
}

const winResolveCache = new Map<string, string | null>();
/** Resolve a bare command name (e.g. "sf") against PATH + PATHEXT; null when not found. */
function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  if (winResolveCache.has(command)) return winResolveCache.get(command)!;
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  const names = path.extname(command) ? [command] : exts.map((e) => command + e);
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [""] : (env.PATH || env.Path || "").split(";").filter(Boolean);
  let found: string | null = null;
  for (const dir of dirs) {
    found = names.map((n) => (dir ? path.join(dir, n) : n)).find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    }) ?? null;
    if (found) break;
  }
  winResolveCache.set(command, found);
  return found;
}

/**
 * Windows spawn for argv commands. `.exe`/`.com` run directly (shell:false, no parsing).
 * `.cmd`/`.bat` shims can't be spawned without a shell (Node CVE-2024-27980 fix), so they
 * run through cmd.exe with every argument escaped by `escapeCmdArg` and verbatim argv,
 * which keeps SOQL with `& | " %` intact and non-injectable.
 */
function spawnWindowsArgv(command: string, args: string[], cwd: string | undefined): cp.ChildProcess {
  const env = asfxEnv(command);
  const resolved = resolveWindowsCommand(command, env);
  if (resolved && /\.(exe|com)$/i.test(resolved)) {
    return cp.spawn(resolved, args, { shell: false, cwd, env, windowsHide: true });
  }
  const target = resolved ?? command;
  const line = [target.replace(CMD_META_RE, "^$1"), ...args.map((a) => escapeCmdArg(a, true))].join(" ");
  return cp.spawn(env.comspec || env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    shell: false,
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true
  });
}

// ---------------------------------------------------------------------------
// Escaping helpers
// ---------------------------------------------------------------------------

/** POSIX single-quoting: no expansion of $, `, etc. */
function escapePosixArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape one arg for a `runCommand` string, for the shell runCommand actually uses: POSIX
 * single-quoting on Unix; on Windows (cmd.exe) MSVCRT double-quoting with every cmd
 * metacharacter caret-escaped twice, because the commands we build target `sf`, an npm
 * `.cmd` shim that cmd parses a second time. Prefer runCommandArgs for new code.
 */
export function escapeShellArg(arg: string): string {
  return IS_WINDOWS ? escapeCmdArg(arg, true) : escapePosixArg(arg);
}

/** Escape one arg when embedding in a shell command string; unquoted when plainly safe. */
function escapeArgForShell(arg: string): string {
  if (!/[\s'$`!"\\$&|;<>()#~*?[\]{}]/.test(arg)) {
    return arg;
  }
  return escapePosixArg(arg);
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

interface RunOptions {
  label: string;
  logCommand: boolean;
  onOutput?: (data: string) => void;
  /** Forward stderr chunks to onOutput as well. */
  stderrToOutput: boolean;
  logOnError: boolean;
  cancellationToken?: vscode.CancellationToken;
  timeoutMs?: number;
  processGroup: boolean;
}

/** Shared lifecycle: tracking, timeout, cancellation, output collection, exit handling. */
function supervise(child: cp.ChildProcess, opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    track(child, opts.processGroup);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let cancelledByUser = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM", opts.processGroup);
    }, timeoutMs);

    let sub: vscode.Disposable | undefined;
    if (opts.cancellationToken) {
      const onCancel = () => {
        cancelledByUser = true;
        clearTimeout(timer);
        killChild(child, "SIGINT", opts.processGroup);
      };
      if (opts.cancellationToken.isCancellationRequested) onCancel();
      else sub = opts.cancellationToken.onCancellationRequested(onCancel);
    }

    const finish = () => {
      clearTimeout(timer);
      sub?.dispose();
      sub = undefined;
    };

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (opts.onOutput) opts.onOutput(chunk);
    });

    child.stderr?.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (opts.stderrToOutput && opts.onOutput) opts.onOutput(chunk);
    });

    child.on("error", (error) => {
      finish();
      if (settled) return;
      settled = true;
      Logger.error(`Command error: ${opts.label}`, error.message);
      reject(error);
    });

    child.on("close", (code) => {
      finish();
      if (settled) return;
      settled = true;
      if (cancelledByUser) {
        const err = new Error("Command cancelled.");
        (err as any).cancelled = true;
        (err as any).stdout = stdout;
        reject(err);
        return;
      }
      if (timedOut) {
        const error = new Error(`Command timed out after ${timeoutMs}ms: ${opts.label}`);
        (error as any).timedOut = true;
        (error as any).stdout = stdout;
        reject(error);
        return;
      }
      if (code === 0) {
        if (opts.logCommand) Logger.info(`Command executed successfully: ${opts.label}`);
        resolve(stdout);
      } else {
        const combinedOutput = stdout + (stderr ? "\n" + stderr : "");

        if (opts.logOnError) {
          Logger.error(`Command failed: ${opts.label}`, combinedOutput);
        } else {
          Logger.error(`Command failed: ${opts.label}`);
        }

        const error = new Error(`Command exited with code ${code}`);
        (error as any).code = code;
        (error as any).stderr = stderr;
        (error as any).stdout = stdout;
        if (combinedOutput.trim()) (error as any).message = combinedOutput;
        reject(error);
      }
    });
  });
}

/**
 * Run a command with an argv array — arguments are never re-parsed by a shell on Unix
 * and are cmd-escaped on Windows, so user input (SOQL, aliases, paths) is safe here.
 * On a non-zero exit the rejected error carries `stdout`, `stderr` and `code`.
 */
export async function runCommandArgs(
  command: string,
  args: string[],
  cwd?: string,
  onOutput?: (data: string) => void,
  logOnError: boolean = true,
  timeoutMs?: number,
  cancellationToken?: vscode.CancellationToken
): Promise<string> {
  Logger.info(`Executing Command: ${command} ${args.join(" ")}`);
  const cwdPath = cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let child: cp.ChildProcess;
  if (IS_WINDOWS) {
    child = spawnWindowsArgv(command, args, cwdPath);
  } else {
    const plan = unixArgvPlan(command, args, await resolveLoginPath());
    // Own process group so timeout / cancel / deactivate also kill sf's worker children.
    child = cp.spawn(plan.file, plan.argv, { shell: false, cwd: cwdPath, env: plan.env, detached: true });
  }
  return supervise(child, {
    label: command,
    logCommand: true,
    onOutput,
    stderrToOutput: false,
    logOnError,
    cancellationToken,
    timeoutMs,
    processGroup: !IS_WINDOWS
  });
}

function shouldLogCommand(command: string): boolean {
  const t = command.trim();
  return !t.startsWith("git status --porcelain");
}

/**
 * Run a shell-string command (sh syntax on Unix, cmd syntax on Windows). Interpolated
 * values MUST be escaped by the caller (escapeShellArg) — prefer runCommandArgs.
 */
export async function runCommand(
  command: string,
  cwd?: string,
  onOutput?: (data: string) => void,
  logOnError: boolean = true,
  cancellationToken?: vscode.CancellationToken,
  timeoutMs?: number
): Promise<string> {
  const log = shouldLogCommand(command);
  if (log) Logger.info(`Executing Command: ${command}`);
  const cwdPath = cwd ? cwd : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const firstWord = command.trim().split(/\s+/)[0] || "sh";
  let child: cp.ChildProcess;
  if (IS_WINDOWS) {
    child = cp.spawn(command, {
      shell: true,
      cwd: cwdPath,
      env: asfxEnv(firstWord),
      windowsHide: true
    });
  } else {
    const plan = unixStringPlan(command, firstWord, await resolveLoginPath());
    // Without a token nothing writes to stdin; keep the historical default (pipe) then.
    child = cp.spawn(plan.file, plan.argv, {
      shell: false,
      cwd: cwdPath,
      detached: true,
      stdio: cancellationToken ? ["ignore", "pipe", "pipe"] : undefined,
      env: plan.env
    });
  }
  return supervise(child, {
    label: command,
    logCommand: log,
    onOutput,
    stderrToOutput: true,
    logOnError,
    cancellationToken,
    timeoutMs,
    processGroup: !IS_WINDOWS
  });
}
