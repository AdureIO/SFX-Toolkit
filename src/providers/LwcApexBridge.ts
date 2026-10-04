import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * A CodeLens on every `@AuraEnabled` Apex method showing how many LWC components import it;
 * clicking peeks those references.
 *
 * The other direction — go-to-definition from an LWC apex import — is LwcApexProvider's.
 *
 * The LWC → (Class.method) import index is scanned once and cached, invalidated by a
 * watcher on the LWC JavaScript files.
 */

interface ImportIndex {
    map: Map<string, vscode.Location[]>; // 'class.method' (lower) -> import sites
}

let cache: ImportIndex | undefined;
let building: Promise<ImportIndex> | undefined;
/** Bumped on invalidation so a build that started before a change can't install a stale index. */
let generation = 0;

const EXCLUDE_GLOB = "{**/node_modules/**,**/.sfdx/**,**/.sf/**}";
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;
const INVALIDATE_DEBOUNCE_MS = 500;
const YIELD_EVERY = 25;

function offsetToPosition(text: string, offset: number): vscode.Position {
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === "\n") {
            line++;
            lineStart = i + 1;
        }
    }
    return new vscode.Position(line, offset - lineStart);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildIndex(): Promise<ImportIndex> {
    const map = new Map<string, vscode.Location[]>();
    const files = await vscode.workspace.findFiles("**/lwc/**/*.js", EXCLUDE_GLOB);
    let n = 0;
    for (const uri of files) {
        if (++n % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        let text: string;
        try {
            text = await fs.promises.readFile(uri.fsPath, "utf8");
        } catch {
            continue;
        }
        if (!text.includes("@salesforce/apex/")) continue; // cheap reject
        const re = /@salesforce\/apex\/([\w.]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            const parts = m[1].split(".");
            if (parts.length < 2) continue;
            const method = parts[parts.length - 1];
            const cls = parts[parts.length - 2];
            const key = `${cls}.${method}`.toLowerCase();
            const pos = offsetToPosition(text, m.index);
            const list = map.get(key) ?? [];
            list.push(new vscode.Location(uri, new vscode.Range(pos, pos)));
            map.set(key, list);
        }
    }
    return { map };
}

function getIndex(): Promise<ImportIndex> {
    if (cache) return Promise.resolve(cache);
    if (!building) {
        const gen = generation;
        const b = buildIndex().then(
            (idx) => {
                if (gen === generation) {
                    cache = idx;
                    building = undefined;
                }
                return idx;
            },
            (e) => {
                if (gen === generation) building = undefined;
                throw e;
            },
        );
        building = b;
    }
    return building;
}

const METHOD_DECL = /\b(?:global|public|private|protected)\b(?:\s+(?:static|override|virtual|abstract|final|transient))*\s+[\w.<>[\], ]+?\s+(\w+)\s*\(/;

/** CodeLens provider: `@AuraEnabled` Apex methods → LWC consumer count. */
class AuraEnabledCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    fireChange(): void {
        this._onDidChange.fire();
    }

    dispose(): void {
        this._onDidChange.dispose();
    }

    async provideCodeLenses(doc: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (!doc.fileName.toLowerCase().endsWith(".cls") || GENERATED_PATH.test(doc.fileName)) return [];
        const text = doc.getText();
        if (!/@AuraEnabled\b/i.test(text)) return []; // no index build for classes without lenses
        const className = path.basename(doc.fileName, ".cls");
        const index = await getIndex();
        if (token?.isCancellationRequested) return [];
        const lenses: vscode.CodeLens[] = [];
        const seen = new Set<string>();

        for (const am of text.matchAll(/@AuraEnabled\b/gi)) {
            const after = text.slice(am.index ?? 0, (am.index ?? 0) + 400);
            const mm = METHOD_DECL.exec(after);
            if (!mm || mm.index === undefined) continue;
            const method = mm[1];
            if (seen.has(method.toLowerCase())) continue;
            seen.add(method.toLowerCase());

            const declPos = offsetToPosition(text, (am.index ?? 0) + mm.index);
            const refs = index.map.get(`${className}.${method}`.toLowerCase()) ?? [];
            const title = refs.length === 0 ? "No LWC references" : `${refs.length} LWC ${refs.length === 1 ? "reference" : "references"}`;
            lenses.push(
                new vscode.CodeLens(new vscode.Range(declPos, declPos), {
                    title,
                    command: refs.length ? "adure-sfx-toolkit.findLwcApexRefs" : "",
                    arguments: [doc.uri, declPos, refs]
                })
            );
        }
        return lenses;
    }
}

export function registerLwcApexBridge(context: vscode.ExtensionContext): void {
    const codeLens = new AuraEnabledCodeLensProvider();

    context.subscriptions.push(
        codeLens,
        // Go-to-definition for `@salesforce/apex/...` lives in LwcApexProvider, which also
        // resolves the local name at a call site and lands on the method's exact position.
        // Registering a second provider for the same thing only produces a disambiguation
        // popup where there is nothing to disambiguate.
        vscode.languages.registerCodeLensProvider({ pattern: "**/*.cls" }, codeLens),
        vscode.commands.registerCommand(
            "adure-sfx-toolkit.findLwcApexRefs",
            (uri: vscode.Uri, pos: vscode.Position, refs: vscode.Location[]) => {
                if (!refs?.length) {
                    vscode.window.showInformationMessage("No LWC components import this method.");
                    return;
                }
                void vscode.commands.executeCommand("editor.action.showReferences", uri, pos, refs);
            }
        )
    );

    // Invalidate the import index and refresh lenses when LWC JS changes — debounced, so a
    // pull/retrieve touching many components triggers one rebuild (lazily, on next lens).
    const watcher = vscode.workspace.createFileSystemWatcher("**/lwc/**/*.js");
    let timer: NodeJS.Timeout | undefined;
    const invalidate = (uri: vscode.Uri) => {
        if (GENERATED_PATH.test(uri.fsPath)) return;
        generation++;
        cache = undefined;
        building = undefined;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            codeLens.fireChange();
        }, INVALIDATE_DEBOUNCE_MS);
    };
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(invalidate),
        watcher.onDidChange(invalidate),
        watcher.onDidDelete(invalidate),
        {
            dispose: () => {
                if (timer) clearTimeout(timer);
                timer = undefined;
                generation++;
                cache = undefined;
                building = undefined;
            },
        },
    );
}
