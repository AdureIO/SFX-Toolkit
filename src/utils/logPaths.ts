import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/** Directory name under project root so logs live in project context for IDE/tooling (e.g. Cursor). */
const ASFX_DIR = '.sfdx/asfx';

/** Where Salesforce VS Code extensions (e.g. Apex Replay Debugger) store debug logs. We monitor this instead of downloading. */
const SF_DEBUG_LOGS_DIR = '.sfdx/tools/debug/logs';

const README_NAME = 'README.md';
const README_CONTENT = `# ASFXT Debug Logs

Debug logs from the Salesforce org are stored here as \`.log\` files (e.g. by log Id).

Keeping logs inside the project folder allows tools like Cursor to use them in the context of this project for analysis and search.
`;

/**
 * Returns the directory where log files are stored.
 * Uses project folder <workspace>/.sfdx/asfx so logs are in project context for IDEs and tools (e.g. Cursor).
 * Falls back to system temp only when no workspace is open.
 */
export function getLogDirectory(): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        return path.join(workspaceRoot, ASFX_DIR);
    }
    return path.join(os.tmpdir(), 'salesforce-vscode-logs');
}

/**
 * Returns the directory where Salesforce extensions store debug logs.
 * Use this to list and open logs (we do not download/cache logs ourselves).
 */
export function getSalesforceLogDirectory(): string | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return null;
    return path.join(workspaceRoot, SF_DEBUG_LOGS_DIR);
}

/** Ensures the log directory exists and has a README; returns the path. */
export function ensureLogDirectory(): string {
    const dir = getLogDirectory();
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            // ignore
        }
    }
    const readmePath = path.join(dir, README_NAME);
    if (!fs.existsSync(readmePath)) {
        try {
            fs.writeFileSync(readmePath, README_CONTENT, 'utf8');
        } catch (e) {
            // ignore
        }
    }
    return dir;
}
