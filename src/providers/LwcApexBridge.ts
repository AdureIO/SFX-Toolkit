import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Bridges Apex and LWC:
 *  • Go-to-definition from an LWC `import x from '@salesforce/apex/MyClass.myMethod'`
 *    straight to the Apex method.
 *  • A CodeLens on every `@AuraEnabled` Apex method showing how many LWC components
 *    import it; clicking peeks those references.
 *
 * The LWC → (Class.method) import index is scanned once and cached, invalidated by a
 * watcher on the LWC JavaScript files.
 */

interface ImportIndex {
    map: Map<string, vscode.Location[]>; // 'class.method' (lower) -> import sites
}

let cache: ImportIndex | undefined;
let building: Promise<ImportIndex> | undefined;

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
    const files = await vscode.workspace.findFiles("**/lwc/**/*.js");
    for (const uri of files) {
        let text: string;
        try {
            text = fs.readFileSync(uri.fsPath, "utf8");
        } catch {
            continue;
        }
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
        building = buildIndex().then((idx) => {
            cache = idx;
            building = undefined;
            return idx;
        });
    }
    return building;
}

/** Definition provider: LWC apex import → Apex method. */
const definitionProvider: vscode.DefinitionProvider = {
    async provideDefinition(doc, position) {
        const line = doc.lineAt(position.line).text;
        const m = /@salesforce\/apex\/([\w.]+)/.exec(line);
        if (!m) return undefined;
        const parts = m[1].split(".");
        const method = parts.pop();
        const cls = parts.pop();
        if (!cls || !method) return undefined;

        const files = await vscode.workspace.findFiles(`**/${cls}.cls`, undefined, 1);
        if (!files.length) return undefined;
        const clsUri = files[0];
        let text: string;
        try {
            text = fs.readFileSync(clsUri.fsPath, "utf8");
        } catch {
            return undefined;
        }
        const mm = new RegExp(`\\b${escapeRegExp(method)}\\s*\\(`).exec(text);
        const pos = mm ? offsetToPosition(text, mm.index) : new vscode.Position(0, 0);
        return new vscode.Location(clsUri, pos);
    }
};

const METHOD_DECL = /\b(?:global|public|private|protected)\b(?:\s+(?:static|override|virtual|abstract|final|transient))*\s+[\w.<>[\], ]+?\s+(\w+)\s*\(/;

/** CodeLens provider: `@AuraEnabled` Apex methods → LWC consumer count. */
class AuraEnabledCodeLensProvider implements vscode.CodeLensProvider {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this._onDidChange.event;

    fireChange(): void {
        this._onDidChange.fire();
    }

    async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (!doc.fileName.toLowerCase().endsWith(".cls")) return [];
        const text = doc.getText();
        const className = path.basename(doc.fileName, ".cls");
        const index = await getIndex();
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
        vscode.languages.registerDefinitionProvider({ language: "javascript", pattern: "**/lwc/**/*.js" }, definitionProvider),
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

    // Invalidate the import index and refresh lenses when LWC JS changes.
    const watcher = vscode.workspace.createFileSystemWatcher("**/lwc/**/*.js");
    const invalidate = () => {
        cache = undefined;
        building = undefined;
        codeLens.fireChange();
    };
    watcher.onDidCreate(invalidate);
    watcher.onDidChange(invalidate);
    watcher.onDidDelete(invalidate);
    context.subscriptions.push(watcher);
}
