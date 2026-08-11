import * as vscode from "vscode";
import { findAuraEnabledMethods, formatSignature, parseApexImport, AuraMethod } from "../utils/apexAuraMethods";

/**
 * Bridges LWC JavaScript to the Apex it imports.
 *
 * Salesforce generates `.d.ts` stubs for `@salesforce/apex/<Class>.<method>` where every type is
 * `any`, and Cmd+click lands in that stub. These providers instead resolve the import to the real
 * `<Class>.cls`, jump to the method itself, and show its true signature (return type, parameter
 * types, cacheable flag, ApexDoc) on hover.
 */

/** Cache of resolved class name → file uri (cleared when Apex files change). */
const classFileCache = new Map<string, vscode.Uri | null>();

export function clearLwcApexCache(): void {
    classFileCache.clear();
}

async function findClassFile(className: string): Promise<vscode.Uri | undefined> {
    // A namespaced import (`ns.Class`) still lives in `Class.cls` locally.
    const bare = className.includes(".") ? className.split(".").pop()! : className;
    if (classFileCache.has(bare)) return classFileCache.get(bare) ?? undefined;
    const hits = await vscode.workspace.findFiles(`**/${bare}.cls`, "**/node_modules/**", 5);
    const uri = hits[0];
    classFileCache.set(bare, uri ?? null);
    return uri;
}

/** Resolve an `@salesforce/apex/...` import to its Apex method, if the class is in the workspace. */
async function resolveApexMethod(
    spec: string
): Promise<{ uri: vscode.Uri; method?: AuraMethod; methodName: string } | undefined> {
    const parsed = parseApexImport(spec);
    if (!parsed) return undefined;
    const uri = await findClassFile(parsed.className);
    if (!uri) return undefined;
    const doc = await vscode.workspace.openTextDocument(uri);
    const method = findAuraEnabledMethods(doc.getText()).find((m) => m.name === parsed.methodName);
    return { uri, method, methodName: parsed.methodName };
}

/**
 * The `@salesforce/apex/...` specifier under the cursor — either the import string itself, or the
 * local name it was bound to (so Cmd+click works on the call site too).
 */
function apexSpecAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const line = document.lineAt(position.line).text;
    for (const m of line.matchAll(/['"](@salesforce\/apex\/[\w.]+)['"]/g)) {
        const start = m.index ?? 0;
        if (position.character >= start && position.character <= start + m[0].length) return m[1];
    }
    // Otherwise: the identifier under the cursor, matched against this file's apex imports.
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!range) return undefined;
    const word = document.getText(range);
    const importRe = /import\s+(\w+)\s+from\s+['"](@salesforce\/apex\/[\w.]+)['"]/g;
    for (const m of document.getText().matchAll(importRe)) {
        if (m[1] === word) return m[2];
    }
    return undefined;
}

export class LwcApexDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Definition | undefined> {
        const spec = apexSpecAt(document, position);
        if (!spec) return undefined;
        const resolved = await resolveApexMethod(spec);
        if (!resolved) return undefined;
        // Land on the method when we found it; otherwise the top of the class.
        const target = resolved.method
            ? new vscode.Position(resolved.method.line, resolved.method.column)
            : new vscode.Position(0, 0);
        return new vscode.Location(resolved.uri, target);
    }
}

export class LwcApexHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
        const spec = apexSpecAt(document, position);
        if (!spec) return undefined;
        const resolved = await resolveApexMethod(spec);
        if (!resolved) return undefined;

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        if (resolved.method) {
            md.appendCodeblock(formatSignature(resolved.method), "apex");
            if (resolved.method.cacheable) md.appendMarkdown("`cacheable` — usable with `@wire`\n\n");
            if (resolved.method.doc) md.appendMarkdown(resolved.method.doc + "\n\n");
        } else {
            md.appendMarkdown(`\`${resolved.methodName}\` — not found as an \`@AuraEnabled\` method.\n\n`);
        }
        md.appendMarkdown(`_— ASFX Toolkit · ${vscode.workspace.asRelativePath(resolved.uri)}_`);
        return new vscode.Hover(md);
    }
}

/** Register the LWC→Apex definition/hover providers for LWC JavaScript files. */
export function registerLwcApexProviders(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [
        { language: "javascript", scheme: "file" },
        { language: "typescript", scheme: "file" }
    ];
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(selector, new LwcApexDefinitionProvider()),
        vscode.languages.registerHoverProvider(selector, new LwcApexHoverProvider())
    );
    // Apex files moving/changing invalidates the class→file lookup.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cls");
    watcher.onDidCreate(clearLwcApexCache);
    watcher.onDidDelete(clearLwcApexCache);
    context.subscriptions.push(watcher);
}
