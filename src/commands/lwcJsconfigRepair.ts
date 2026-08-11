import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { buildLwcJsconfig, jsconfigNeedsUpdate, JsconfigShape } from "../utils/lwcJsconfig";
import { reportError } from "../utils/reportError";
import { Logger } from "../utils/outputChannel";
import { isSalesforceProject } from "../utils/projectUtils";

/**
 * Repair the `jsconfig.json` in every `lwc` folder so IntelliSense resolves modules the way the
 * platform does: `c/*` cross-component imports, relative imports into a component's own
 * subdirectories, and the generated `@salesforce/...` typings. Settings we don't own are kept.
 */

function autoRepairEnabled(): boolean {
    return vscode.workspace.getConfiguration("adure-sfx-toolkit").get<boolean>("lwcJsconfig.autoRepair", true);
}

/** Relative path from an lwc folder to `.sfdx/typings/lwc`, POSIX-style for JSON. */
function typingsRelPath(lwcDir: string, root: string): string {
    const target = path.join(root, ".sfdx", "typings", "lwc");
    return path.relative(lwcDir, target).split(path.sep).join("/");
}

function readJson(file: string): JsconfigShape | undefined {
    try {
        if (!fs.existsSync(file)) return undefined;
        // Tolerate comments/trailing commas that editors allow in jsconfig.
        const text = fs
            .readFileSync(file, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/[^\n]*$/gm, "")
            .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(text) as JsconfigShape;
    } catch (e) {
        Logger.warn(`LWC jsconfig: could not parse ${file} — leaving it alone (${e})`);
        return undefined;
    }
}

/** Every `.../lwc` directory that holds components. */
async function findLwcDirs(): Promise<string[]> {
    const metas = await vscode.workspace.findFiles("**/lwc/*/*.js-meta.xml", "**/node_modules/**");
    const dirs = new Set<string>();
    for (const m of metas) dirs.add(path.dirname(path.dirname(m.fsPath))); // component dir → lwc dir
    return [...dirs];
}

/** Repair one lwc folder. Returns true when the file was written. */
function repairDir(lwcDir: string, root: string): boolean {
    const file = path.join(lwcDir, "jsconfig.json");
    const existing = readJson(file);
    // A file that exists but failed to parse reads as undefined — don't clobber it.
    if (fs.existsSync(file) && existing === undefined) return false;
    const rel = typingsRelPath(lwcDir, root);
    if (!jsconfigNeedsUpdate(existing, rel)) return false;
    fs.writeFileSync(file, JSON.stringify(buildLwcJsconfig(existing, rel), null, 2) + "\n", "utf8");
    return true;
}

export async function repairLwcJsconfigs(silent = false): Promise<number> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return 0;
    const dirs = await findLwcDirs();
    let fixed = 0;
    for (const dir of dirs) {
        try {
            if (repairDir(dir, root)) fixed++;
        } catch (e) {
            Logger.warn(`LWC jsconfig: could not update ${dir}: ${e}`);
        }
    }
    Logger.info(`LWC jsconfig: checked ${dirs.length} folder(s), updated ${fixed}`);
    if (!silent) {
        vscode.window.showInformationMessage(
            fixed
                ? `Repaired ${fixed} LWC jsconfig.json file(s) — reload the window if IntelliSense doesn't pick it up.`
                : `LWC jsconfig.json already correct (${dirs.length} folder(s) checked).`
        );
    }
    return fixed;
}

/** The `ASFXT: Repair LWC jsconfig` command. */
export async function repairLwcJsconfigCommand(): Promise<void> {
    try {
        await repairLwcJsconfigs();
    } catch (error) {
        reportError({ operation: "Repair LWC jsconfig", error });
    }
}

/** Check once shortly after activation, and whenever a new component appears. */
export function registerLwcJsconfigRepair(context: vscode.ExtensionContext): void {
    if (!isSalesforceProject()) return;
    const run = () => {
        if (autoRepairEnabled()) void repairLwcJsconfigs(true).catch((e) => Logger.warn(`LWC jsconfig: ${e}`));
    };
    const watcher = vscode.workspace.createFileSystemWatcher("**/lwc/*/*.js-meta.xml");
    watcher.onDidCreate(run); // a new component may mean a new lwc folder
    context.subscriptions.push(watcher);
    setTimeout(run, 3500);
}
