import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { typingsForClass, findApexTypeShapes, interfacesForShapes, ApexTypeShape } from "../utils/apexAuraMethods";
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
/** Ambient interfaces for custom Apex types, shared by every generated module declaration. */
const TYPES_FILE = "__asfx-apex-types.d.ts";

/** Generated / tooling folders: `.sfdx/tools/sobjects` alone holds thousands of SObject stub classes. */
const EXCLUDE_GLOB = "{**/node_modules/**,**/.sfdx/**,**/.sf/**}";
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;
/** Coalesce bursts (a pull/retrieve touching many classes) into one regeneration pass. */
const REGENERATE_DEBOUNCE_MS = 750;
/** Files read between event-loop yields during a full sync. */
const YIELD_EVERY = 25;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A user Apex class outside generated folders. */
function isUserApexClass(fsPath: string): boolean {
    return fsPath.endsWith(".cls") && !GENERATED_PATH.test(fsPath);
}

/** Cache of custom Apex type shapes, so a single-file save doesn't rescan the whole workspace. */
let knownShapes: ApexTypeShape[] = [];
let knownTypeNames = new Set<string>();

function workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function autoGenerateEnabled(): boolean {
    return vscode.workspace.getConfiguration("adure-sfx-toolkit").get<boolean>("lwcApexTypings.autoGenerate", true);
}

/** Remove a typings file, but only one we generated. */
async function removeGeneratedTypings(target: string): Promise<void> {
    try {
        if ((await fs.promises.readFile(target, "utf8")).includes("ASFX Toolkit")) await fs.promises.unlink(target);
    } catch {
        /* missing or unreadable — nothing to remove */
    }
}

/**
 * Write (or remove) the declaration file for one Apex class. Returns true when a file was written.
 * `source` may be passed when the caller already read the class.
 */
async function writeTypingsFor(root: string, classFile: string, source?: string): Promise<boolean> {
    const className = path.basename(classFile, ".cls");
    const target = path.join(root, TYPINGS_DIR, `${className}.d.ts`);
    if (source === undefined) {
        try {
            source = await fs.promises.readFile(classFile, "utf8");
        } catch {
            return false; // deleted between the event and the read
        }
    }
    const body = typingsForClass(className, source, knownTypeNames);
    if (!body) {
        // No @AuraEnabled methods — drop a stale file we previously generated.
        await removeGeneratedTypings(target);
        return false;
    }
    // Skip identical rewrites (no churn for the TS server's watcher).
    try {
        if ((await fs.promises.readFile(target, "utf8")) === body) return true;
    } catch {
        /* not there yet */
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, body, "utf8");
    return true;
}

/** Regenerate typings for every Apex class in the workspace. */
export async function syncAllLwcApexTypings(silent = false): Promise<{ classes: number }> {
    const root = workspaceRoot();
    if (!root) return { classes: 0 };
    const files = (await vscode.workspace.findFiles("**/*.cls", EXCLUDE_GLOB)).filter((f) => isUserApexClass(f.fsPath));

    // Pass 1 — collect every custom Apex type (incl. inner classes) so parameters and return
    // values reference a real interface instead of `any`. Only classes with @AuraEnabled
    // methods are kept for pass 2, so their source isn't read twice.
    const byName = new Map<string, ApexTypeShape>();
    const auraSources: { file: string; text: string }[] = [];
    const others: string[] = [];
    let n = 0;
    for (const file of files) {
        if (++n % YIELD_EVERY === 0) await yieldToLoop();
        try {
            const text = await fs.promises.readFile(file.fsPath, "utf8");
            for (const shape of findApexTypeShapes(text)) if (!byName.has(shape.name)) byName.set(shape.name, shape);
            if (/@AuraEnabled\b/i.test(text)) auraSources.push({ file: file.fsPath, text });
            else others.push(file.fsPath);
        } catch {
            /* unreadable file — skip */
        }
    }
    knownShapes = [...byName.values()];
    knownTypeNames = new Set(byName.keys());

    await fs.promises.mkdir(path.join(root, TYPINGS_DIR), { recursive: true });
    await fs.promises.writeFile(path.join(root, TYPINGS_DIR, TYPES_FILE), interfacesForShapes(knownShapes), "utf8");

    // Pass 2 — module declarations, now able to name those types.
    let classes = 0;
    for (const { file, text } of auraSources) {
        if (await writeTypingsFor(root, file, text)) classes++;
    }
    // Classes without @AuraEnabled: only drop stale files we generated earlier (checked
    // against one directory listing instead of probing a file per class).
    let existing = new Set<string>();
    try {
        existing = new Set(await fs.promises.readdir(path.join(root, TYPINGS_DIR)));
    } catch {
        /* no typings dir yet */
    }
    for (const file of others) {
        const name = `${path.basename(file, ".cls")}.d.ts`;
        if (existing.has(name)) await removeGeneratedTypings(path.join(root, TYPINGS_DIR, name));
    }
    Logger.info(`LWC Apex typings: synced ${classes} class(es), ${knownShapes.length} custom type(s) → ${TYPINGS_DIR}`);
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

    // Changed/created and deleted classes are queued and processed in one debounced pass.
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let timer: NodeJS.Timeout | undefined;
    let running: Promise<void> | undefined;

    const flush = async (): Promise<void> => {
        timer = undefined;
        const root = workspaceRoot();
        if (!root || !autoGenerateEnabled()) {
            changed.clear();
            deleted.clear();
            return;
        }
        const toWrite = [...changed];
        const toDelete = [...deleted];
        changed.clear();
        deleted.clear();
        for (const file of toWrite) {
            try {
                await writeTypingsFor(root, file);
            } catch (e) {
                Logger.warn(`LWC Apex typings: could not update ${path.basename(file)}: ${e}`);
            }
        }
        for (const file of toDelete) {
            await removeGeneratedTypings(path.join(root, TYPINGS_DIR, `${path.basename(file, ".cls")}.d.ts`));
        }
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            // Never overlap two passes; a pass queued meanwhile runs after this one.
            const run = () => {
                running = flush().finally(() => {
                    running = undefined;
                    if ((changed.size || deleted.size) && !timer) schedule();
                });
            };
            if (running) void running.then(() => { if (!running && !timer) run(); });
            else run();
        }, REGENERATE_DEBOUNCE_MS);
    };
    const queue = (uri: vscode.Uri, kind: "changed" | "deleted") => {
        if (uri.scheme !== "file" || !isUserApexClass(uri.fsPath) || !autoGenerateEnabled()) return;
        if (kind === "deleted") {
            changed.delete(uri.fsPath);
            deleted.add(uri.fsPath);
        } else {
            deleted.delete(uri.fsPath);
            changed.add(uri.fsPath);
        }
        schedule();
    };

    // The file watcher alone covers editor saves AND writes from a pull/retrieve; an extra
    // onDidSaveTextDocument listener would process every save twice.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cls");
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => queue(uri, "changed")),
        watcher.onDidChange((uri) => queue(uri, "changed")),
        watcher.onDidDelete((uri) => queue(uri, "deleted")),
    );

    // Initial sync in the background so activation isn't blocked by a full workspace scan.
    let initialTimer: NodeJS.Timeout | undefined;
    if (autoGenerateEnabled()) {
        initialTimer = setTimeout(() => {
            initialTimer = undefined;
            void syncAllLwcApexTypings(true).catch((e) => Logger.warn(`LWC Apex typings: initial sync failed: ${e}`));
        }, 3000);
    }
    context.subscriptions.push({
        dispose: () => {
            if (timer) clearTimeout(timer);
            if (initialTimer) clearTimeout(initialTimer);
            timer = initialTimer = undefined;
            changed.clear();
            deleted.clear();
        },
    });
}
