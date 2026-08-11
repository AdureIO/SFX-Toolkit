import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * LWC IntelliSense that complements the official LWC extension:
 *  • Completion for `@salesforce/*` imports — Apex classes/@AuraEnabled methods,
 *    custom labels, static resources, message channels (all from local metadata).
 *  • Go-to-definition for label / resourceUrl / messageChannel imports.
 *  • A CodeLens on a component showing how many other components use `<c-…>`.
 */

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

function readFile(uri: vscode.Uri): string | undefined {
    try {
        return fs.readFileSync(uri.fsPath, "utf8");
    } catch {
        return undefined;
    }
}

function camelToKebab(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// ── local-metadata lookups ────────────────────────────────────────────────────

async function apexClassNames(): Promise<string[]> {
    const files = await vscode.workspace.findFiles("**/classes/**/*.cls");
    return files.map((f) => path.basename(f.fsPath, ".cls")).sort();
}

async function auraEnabledMethods(cls: string): Promise<string[]> {
    const files = await vscode.workspace.findFiles(`**/${cls}.cls`, undefined, 1);
    const text = files.length ? readFile(files[0]) : undefined;
    if (!text) return [];
    const out = new Set<string>();
    for (const am of text.matchAll(/@AuraEnabled\b/gi)) {
        const after = text.slice(am.index ?? 0, (am.index ?? 0) + 400);
        const mm = /\b(?:global|public)\b(?:\s+static)?\s+[\w.<>[\], ]+?\s+(\w+)\s*\(/.exec(after);
        if (mm) out.add(mm[1]);
    }
    return [...out].sort();
}

async function customLabels(): Promise<{ name: string; uri: vscode.Uri; offset: number }[]> {
    const files = await vscode.workspace.findFiles("**/labels/*.labels-meta.xml");
    const out: { name: string; uri: vscode.Uri; offset: number }[] = [];
    for (const uri of files) {
        const text = readFile(uri);
        if (!text) continue;
        for (const m of text.matchAll(/<fullName>([^<]+)<\/fullName>/g)) {
            out.push({ name: m[1], uri, offset: m.index ?? 0 });
        }
    }
    return out;
}

async function metadataNames(glob: string, suffix: string): Promise<string[]> {
    const files = await vscode.workspace.findFiles(glob);
    return files.map((f) => path.basename(f.fsPath).replace(suffix, "")).sort();
}

// ── completion ────────────────────────────────────────────────────────────────

function item(label: string, kind: vscode.CompletionItemKind, detail: string): vscode.CompletionItem {
    const it = new vscode.CompletionItem(label, kind);
    it.detail = detail;
    return it;
}

const importCompletion: vscode.CompletionItemProvider = {
    async provideCompletionItems(doc, position) {
        const line = doc.getText(new vscode.Range(position.line, 0, position.line, position.character));
        const m = /@salesforce\/(\w+)\/([\w.]*)$/.exec(line);
        if (!m) return undefined;
        const kind = m[1];
        const partial = m[2];
        switch (kind) {
            case "apex": {
                if (partial.includes(".")) {
                    const cls = partial.split(".")[0];
                    return (await auraEnabledMethods(cls)).map((mth) => item(mth, vscode.CompletionItemKind.Method, `${cls}.${mth} (@AuraEnabled)`));
                }
                return (await apexClassNames()).map((c) => item(c, vscode.CompletionItemKind.Class, "Apex class"));
            }
            case "label": {
                const labels = await customLabels();
                return labels.map((l) => item(l.name, vscode.CompletionItemKind.Constant, "Custom label"));
            }
            case "resourceUrl":
                return (await metadataNames("**/staticresources/*.resource-meta.xml", ".resource-meta.xml")).map((n) =>
                    item(n, vscode.CompletionItemKind.File, "Static resource"),
                );
            case "messageChannel":
                return (await metadataNames("**/messageChannels/*.messageChannel-meta.xml", ".messageChannel-meta.xml")).map((n) =>
                    item(n, vscode.CompletionItemKind.Event, "Lightning message channel"),
                );
            default:
                return undefined;
        }
    }
};

// ── definition (label / resourceUrl / messageChannel) ─────────────────────────

const importDefinition: vscode.DefinitionProvider = {
    async provideDefinition(doc, position) {
        const line = doc.lineAt(position.line).text;
        const m = /@salesforce\/(\w+)\/([\w./-]+)/.exec(line);
        if (!m) return undefined;
        const kind = m[1];
        const ref = m[2].replace(/^c\./, "");
        if (kind === "label") {
            for (const l of await customLabels()) {
                if (l.name === ref) {
                    const text = readFile(l.uri) ?? "";
                    return new vscode.Location(l.uri, offsetToPosition(text, l.offset));
                }
            }
            return undefined;
        }
        const globs: Record<string, string> = {
            resourceUrl: `**/staticresources/${ref}.resource-meta.xml`,
            messageChannel: `**/messageChannels/${ref}.messageChannel-meta.xml`
        };
        const glob = globs[kind];
        if (!glob) return undefined;
        const files = await vscode.workspace.findFiles(glob, undefined, 1);
        return files.length ? new vscode.Location(files[0], new vscode.Position(0, 0)) : undefined;
    }
};

// ── component usage CodeLens (`<c-…>` references) ─────────────────────────────

let usageCache: Map<string, vscode.Location[]> | undefined;
let usageBuilding: Promise<Map<string, vscode.Location[]>> | undefined;

async function buildUsageIndex(): Promise<Map<string, vscode.Location[]>> {
    const map = new Map<string, vscode.Location[]>();
    const files = await vscode.workspace.findFiles("**/lwc/**/*.html");
    for (const uri of files) {
        const text = readFile(uri);
        if (!text) continue;
        for (const m of text.matchAll(/<(c-[a-z][a-z0-9-]*)/g)) {
            const tag = m[1].toLowerCase();
            const pos = offsetToPosition(text, m.index ?? 0);
            const list = map.get(tag) ?? [];
            list.push(new vscode.Location(uri, new vscode.Range(pos, pos)));
            map.set(tag, list);
        }
    }
    return map;
}

function usageIndex(): Promise<Map<string, vscode.Location[]>> {
    if (usageCache) return Promise.resolve(usageCache);
    if (!usageBuilding) {
        usageBuilding = buildUsageIndex().then((idx) => {
            usageCache = idx;
            usageBuilding = undefined;
            return idx;
        });
    }
    return usageBuilding;
}

class LwcUsageCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;
    fireChange(): void {
        this._onDidChange.fire();
    }

    async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        // Only on a component's main file (basename === its folder name).
        const dir = path.basename(path.dirname(doc.fileName));
        const base = path.basename(doc.fileName).replace(/\.(js|html)$/, "");
        if (dir !== base) return [];
        const tag = "c-" + camelToKebab(dir);
        // Exclude self-references (a component using itself is rare; still filter by file).
        const refs = (await usageIndex()).get(tag)?.filter((l) => path.dirname(l.uri.fsPath) !== path.dirname(doc.fileName)) ?? [];
        const title = refs.length === 0 ? `No usages of <${tag}>` : `${refs.length} usage${refs.length === 1 ? "" : "s"} of <${tag}>`;
        const pos = new vscode.Position(0, 0);
        return [
            new vscode.CodeLens(new vscode.Range(pos, pos), {
                title,
                command: refs.length ? "adure-sfx-toolkit.findLwcComponentRefs" : "",
                arguments: [doc.uri, pos, refs]
            })
        ];
    }
}

export function registerLwcProviders(context: vscode.ExtensionContext): void {
    const jsSelector: vscode.DocumentSelector = { language: "javascript", pattern: "**/lwc/**/*.js" };
    const lwcSelector: vscode.DocumentSelector = { pattern: "**/lwc/**/*.{js,html}" };
    const usageLens = new LwcUsageCodeLensProvider();

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(jsSelector, importCompletion, "/", "."),
        vscode.languages.registerDefinitionProvider(jsSelector, importDefinition),
        vscode.languages.registerCodeLensProvider(lwcSelector, usageLens),
        vscode.commands.registerCommand(
            "adure-sfx-toolkit.findLwcComponentRefs",
            (uri: vscode.Uri, pos: vscode.Position, refs: vscode.Location[]) => {
                if (!refs?.length) {
                    vscode.window.showInformationMessage("This component isn't used by any other component.");
                    return;
                }
                void vscode.commands.executeCommand("editor.action.showReferences", uri, pos, refs);
            }
        )
    );

    const watcher = vscode.workspace.createFileSystemWatcher("**/lwc/**/*.html");
    const invalidate = () => {
        usageCache = undefined;
        usageBuilding = undefined;
        usageLens.fireChange();
    };
    watcher.onDidCreate(invalidate);
    watcher.onDidChange(invalidate);
    watcher.onDidDelete(invalidate);
    context.subscriptions.push(watcher);
}
