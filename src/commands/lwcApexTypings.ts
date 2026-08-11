import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { typingsForClass } from "../utils/apexAuraMethods";
import { reportError } from "../utils/reportError";
import { Logger } from "../utils/outputChannel";
import { isSalesforceProject } from "../utils/projectUtils";

/**
 * Keep `@salesforce/apex/<Class>.<method>` typings in sync with the Apex source.
 *
 * Salesforce's LWC tooling generates these declarations with every parameter and return value
 * typed `any`. We write the SAME files with the real types derived from each `@AuraEnabled`
 * signature (plus the Apex signature as a doc comment).
 *
 * Writing to Salesforce's own path is deliberate: two files declaring the same module would be a
 * duplicate-default-export error, and that folder is already on the LWC `jsconfig` include path —
 * so replacing their stub is what makes the types actually reach IntelliSense. Salesforce may
 * regenerate a file at any time, which is why this runs automatically on save rather than once.
 */

const TYPINGS_DIR = path.join(".sfdx", "typings", "lwc", "apex");

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function autoGenerateEnabled(): boolean {
    return vscode.workspace.getConfiguration("adure-sfx-toolkit").get<boolean>("lwcApexTypings.autoGenerate", true);
}

/** Write (or remove) the declaration file for one Apex class. Returns true when a file was written. */
function writeTypingsFor(root: string, classFile: string): boolean {
    const className = path.basename(classFile, ".cls");
    const target = path.join(root, TYPINGS_DIR, `${className}.d.ts`);
    let source = "";
    try {
        source = fs.readFileSync(classFile, "utf8");
    } catch {
        return false; // deleted between the event and the read
    }
    const body = typingsForClass(className, source);
    if (!body) {
        // No @AuraEnabled methods — drop a stale file we previously generated.
        try {
            if (fs.existsSync(target) && fs.readFileSync(target, "utf8").includes("ASFX Toolkit")) fs.unlinkSync(target);
        } catch {
            /* best effort */
        }
        return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
    return true;
}

/** Regenerate typings for every Apex class in the workspace. */
export async function syncAllLwcApexTypings(silent = false): Promise<{ classes: number }> {
    const root = workspaceRoot();
    if (!root) return { classes: 0 };
    const files = await vscode.workspace.findFiles("**/*.cls", "**/node_modules/**");
    let classes = 0;
    for (const file of files) if (writeTypingsFor(root, file.fsPath)) classes++;
    Logger.info(`LWC Apex typings: synced ${classes} class(es) → ${TYPINGS_DIR}`);
    if (!silent) {
        vscode.window.showInformationMessage(
            classes ? `Generated LWC typings for ${classes} Apex class(es).` : "No @AuraEnabled methods found."
        );
    }
    return { classes };
}

/** The `ASFXT: Generate LWC Apex Typings` command — a manual full resync. */
export async function generateLwcApexTypings(): Promise<void> {
    try {
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Generating LWC Apex typings…" },
            () => syncAllLwcApexTypings()
        );
    } catch (error) {
        reportError({ operation: "Generate LWC Apex typings", error });
    }
}

/**
 * Keep typings current automatically: a full sync shortly after activation, then per-class updates
 * whenever an Apex file is saved, created or deleted.
 */
export function registerLwcApexTypingsSync(context: vscode.ExtensionContext): void {
    if (!isSalesforceProject()) return;

    const regenerate = (uri: vscode.Uri) => {
        const root = workspaceRoot();
        if (!root || !autoGenerateEnabled() || !uri.fsPath.endsWith(".cls")) return;
        try {
            writeTypingsFor(root, uri.fsPath);
        } catch (e) {
            Logger.warn(`LWC Apex typings: could not update ${path.basename(uri.fsPath)}: ${e}`);
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => regenerate(doc.uri))
    );

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cls");
    watcher.onDidCreate(regenerate);
    watcher.onDidChange(regenerate); // covers writes from a pull/retrieve, not just editor saves
    watcher.onDidDelete((uri) => {
        const root = workspaceRoot();
        if (!root || !autoGenerateEnabled()) return;
        const target = path.join(root, TYPINGS_DIR, `${path.basename(uri.fsPath, ".cls")}.d.ts`);
        try {
            if (fs.existsSync(target) && fs.readFileSync(target, "utf8").includes("ASFX Toolkit")) fs.unlinkSync(target);
        } catch {
            /* best effort */
        }
    });
    context.subscriptions.push(watcher);

    // Initial sync in the background so activation isn't blocked by a full workspace scan.
    if (autoGenerateEnabled()) {
        setTimeout(() => {
            void syncAllLwcApexTypings(true).catch((e) => Logger.warn(`LWC Apex typings: initial sync failed: ${e}`));
        }, 3000);
    }
}
