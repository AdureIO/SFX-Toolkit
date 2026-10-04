import * as vscode from "vscode";
import * as fs from "fs";
import { findAuraEnabledMethods, formatSignature, parseApexImport, AuraMethod } from "../utils/apexAuraMethods";

/**
 * Bridges LWC JavaScript to the Apex it imports.
 *
 * Salesforce generates `.d.ts` stubs for `@salesforce/apex/<Class>.<method>` where every type is
 * `any`, and Cmd+click lands in that stub. These providers instead resolve the import to the real
 * `<Class>.cls`, jump to the method itself, and show its true signature (return type, parameter
 * types, cacheable flag, ApexDoc) on hover.
 */

/**
 * Generated / tooling folders. `.sfdx/tools/sobjects` holds SObject stub classes
 * (`Account.cls`, …) that must never be mistaken for a user Apex class.
 */
const EXCLUDE_GLOB = "{**/node_modules/**,**/.sfdx/**,**/.sf/**}";
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;

/** Cache of resolved class name → file uri (cleared when Apex files are created/deleted). LRU-capped. */
const classFileCache = new Map<string, vscode.Uri | null>();
const MAX_CLASS_FILE_CACHE = 500;

export function clearLwcApexCache(): void {
    classFileCache.clear();
}

async function findClassFile(className: string): Promise<vscode.Uri | undefined> {
    // A namespaced import (`ns.Class`) still lives in `Class.cls` locally.
    const bare = className.includes(".") ? className.split(".").pop()! : className;
    if (classFileCache.has(bare)) return classFileCache.get(bare) ?? undefined;
    const hits = await vscode.workspace.findFiles(`**/${bare}.cls`, EXCLUDE_GLOB, 5);
    const uri = hits.find((h) => !GENERATED_PATH.test(h.fsPath));
    classFileCache.set(bare, uri ?? null);
    while (classFileCache.size > MAX_CLASS_FILE_CACHE) {
        const oldest = classFileCache.keys().next().value;
        if (oldest === undefined) break;
        classFileCache.delete(oldest);
    }
    return uri;
}

/**
 * Text of a class: the open editor buffer when there is one, else the file on disk.
 * Deliberately NOT openTextDocument — that would open a model (and send didOpen to
 * every Apex language server) just to render a hover.
 */
async function readClassText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
        return await fs.promises.readFile(uri.fsPath, "utf8");
    } catch {
        return undefined;
    }
}

/** Resolve an `@salesforce/apex/...` import to its Apex method, if the class is in the workspace. */
async function resolveApexMethod(
    spec: string
): Promise<{ uri: vscode.Uri; method?: AuraMethod; methodName: string } | undefined> {
    const parsed = parseApexImport(spec);
    if (!parsed) return undefined;
    const uri = await findClassFile(parsed.className);
    if (!uri) return undefined;
    const text = await readClassText(uri);
    if (text === undefined) return undefined;
    const method = findAuraEnabledMethods(text).find((m) => m.name === parsed.methodName);
    return { uri, method, methodName: parsed.methodName };
}

/**
 * The `@salesforce/apex/...` specifier under the cursor — either the import string itself, or the
 * local name it was bound to (so Cmd+click works on the call site too).
 */
function apexSpecAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const line = document.lineAt(position.line).text;
    for (const m of line.matchAll(/['"]((?:@salesforce\/|c\/|lightning\/)[\w./-]+)['"]/g)) {
        const start = m.index ?? 0;
        if (position.character >= start && position.character <= start + m[0].length) return m[1];
    }
    // Otherwise: the identifier under the cursor, matched against this file's apex imports.
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!range) return undefined;
    const word = document.getText(range);
    const importRe = /import\s+(?:\*\s+as\s+)?(\w+)[^'"\n]*from\s+['"]((?:@salesforce\/|c\/|lightning\/)[\w./-]+)['"]/g;
    for (const m of document.getText().matchAll(importRe)) {
        if (m[1] === word) return m[2];
    }
    return undefined;
}


/** `c/myComponent` → the component's own .js file in any `lwc` folder. */
async function resolveLwcComponent(spec: string): Promise<vscode.Uri | undefined> {
    const m = /^c\/(\w+)$/.exec(spec.trim());
    if (!m) return undefined;
    const name = m[1];
    const hits = await vscode.workspace.findFiles(`**/lwc/${name}/${name}.js`, EXCLUDE_GLOB, 2);
    return hits[0];
}

/** `@salesforce/schema/Account.Name` → { object, field }. */
export function parseSchemaImport(spec: string): { object: string; field?: string } | undefined {
    const m = /^@salesforce\/schema\/([\w.]+)$/.exec(spec.trim());
    if (!m) return undefined;
    const parts = m[1].split(".");
    return parts.length > 1 ? { object: parts[0], field: parts.slice(1).join(".") } : { object: parts[0] };
}

export class LwcApexDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<vscode.Definition | undefined> {
        const spec = apexSpecAt(document, position);
        if (!spec) return undefined;

        const component = await resolveLwcComponent(spec);
        if (component) return new vscode.Location(component, new vscode.Position(0, 0));

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

        const component = await resolveLwcComponent(spec);
        if (component) {
            const md = new vscode.MarkdownString(`LWC component \`${spec}\`\n\n`);
            md.appendMarkdown(`_— ASFX Toolkit · ${vscode.workspace.asRelativePath(component)}_`);
            return new vscode.Hover(md);
        }
        const schema = parseSchemaImport(spec);
        if (schema) {
            const md = new vscode.MarkdownString(
                schema.field
                    ? `Field reference — \`${schema.object}.${schema.field}\`\n\n`
                    : `Object reference — \`${schema.object}\`\n\n`
            );
            md.appendMarkdown("_— ASFX Toolkit_");
            return new vscode.Hover(md);
        }

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
    // Stub (re)generation under .sfdx creates/deletes thousands of .cls files — ignore those.
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.cls", false, true, false);
    const onApexFileSetChanged = (uri: vscode.Uri) => {
        if (!GENERATED_PATH.test(uri.fsPath)) clearLwcApexCache();
    };
    context.subscriptions.push(
        watcher,
        watcher.onDidCreate(onApexFileSetChanged),
        watcher.onDidDelete(onApexFileSetChanged),
        { dispose: clearLwcApexCache },
    );
}
