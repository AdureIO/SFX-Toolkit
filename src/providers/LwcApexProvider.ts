import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { findAuraEnabledMethods, formatSignature, AuraMethod } from "../utils/apexAuraMethods";
import {
    auraActionAt,
    auraControllerRef,
    lwcApexImportAt,
    lwcApexRefs,
    auraActionRefs,
    vfControllerRefs,
    classNameMatches,
    Span,
} from "../utils/sfMetadataRefs";
import { lsRequest } from "../languageClient";

/**
 * Bridges LWC / Aura / Visualforce to the Apex they call.
 *
 * Salesforce generates `.d.ts` stubs for `@salesforce/apex/<Class>.<method>` where every type is
 * `any`, and Cmd+click lands in that stub. These providers instead resolve the reference to the
 * real Apex declaration — from the import specifier, the imported binding, its `@wire(…)` use and
 * imperative calls (LWC), `'c.method'` action strings and `controller="Cls"` (Aura), and
 * `controller=` / `extensions=` (Visualforce) — and show the true signature on hover.
 *
 * Resolution goes through the ASFX language server (`sfx/apexDefinition`, `sfx/apexReferences`):
 * the same workspace model as Apex Find References (case-insensitive names, namespaces,
 * overloads → the @AuraEnabled one, unopened files, unsaved Apex buffers). Find References on an
 * imported Apex function lists the Apex declaration, every Apex caller and every LWC / Aura /
 * Visualforce / Flow use — this file's own uses are taken from the live (possibly unsaved)
 * buffer. When the server is not running, a local scan is used instead.
 */

/**
 * Generated / tooling folders. `.sfdx/tools/sobjects` holds SObject stub classes
 * (`Account.cls`, …) that must never be mistaken for a user Apex class.
 */
const EXCLUDE_GLOB = "{**/node_modules/**,**/.sfdx/**,**/.sf/**}";
const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;

/** Cache of resolved class name (lower-case) → file uri (cleared when Apex files are created/deleted). LRU-capped. */
const classFileCache = new Map<string, vscode.Uri | null>();
const MAX_CLASS_FILE_CACHE = 500;

export function clearLwcApexCache(): void {
    classFileCache.clear();
}

/** A case-insensitive glob for a file name (`Ab.cls` → `[aA][bB].cls`). */
function caseInsensitiveGlob(name: string): string {
    return name.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/** Local fallback (server not running): the class's file, case-insensitively. */
async function findClassFile(className: string): Promise<vscode.Uri | undefined> {
    const bare = className.includes(".") ? className.split(".").pop()! : className;
    const key = bare.toLowerCase();
    if (classFileCache.has(key)) return classFileCache.get(key) ?? undefined;
    let hits = await vscode.workspace.findFiles(`**/${bare}.cls`, EXCLUDE_GLOB, 5);
    if (!hits.some((h) => !GENERATED_PATH.test(h.fsPath))) hits = await vscode.workspace.findFiles(`**/${caseInsensitiveGlob(bare)}.cls`, EXCLUDE_GLOB, 5);
    const uri = hits.find((h) => !GENERATED_PATH.test(h.fsPath));
    classFileCache.set(key, uri ?? null);
    while (classFileCache.size > MAX_CLASS_FILE_CACHE) {
        const oldest = classFileCache.keys().next().value;
        if (oldest === undefined) break;
        classFileCache.delete(oldest);
    }
    return uri;
}

/**
 * Text of a file: the open editor buffer when there is one, else the file on disk.
 * Deliberately NOT openTextDocument — that would open a model (and send didOpen to
 * every Apex language server) just to render a hover.
 */
async function readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
        return await fs.promises.readFile(uri.fsPath, "utf8");
    } catch {
        return undefined;
    }
}

interface ApexTarget {
    className: string;
    member?: string;
}

type LspLocation = { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } };

function toLocation(l: LspLocation): vscode.Location {
    return new vscode.Location(
        vscode.Uri.parse(l.uri),
        new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character),
    );
}

/** The Apex declaration of a target: via the language server, else a local scan. */
async function apexDeclaration(t: ApexTarget, token?: vscode.CancellationToken): Promise<{ location: vscode.Location; method?: AuraMethod } | undefined> {
    const fromServer = await lsRequest<LspLocation | null>("sfx/apexDefinition", { className: t.className, member: t.member, prefer: "aura" }, token);
    let location = fromServer ? toLocation(fromServer) : undefined;
    let uri = location?.uri;
    if (!uri) uri = await findClassFile(t.className);
    if (!uri) return undefined;
    const text = await readText(uri);
    const method = t.member && text !== undefined ? findAuraEnabledMethods(text).find((m) => m.name.toLowerCase() === t.member!.toLowerCase()) : undefined;
    if (!location) location = new vscode.Location(uri, method ? new vscode.Position(method.line, method.column) : new vscode.Position(0, 0));
    return { location, method };
}

/** Complete references of a target (server), else the declaration only. */
async function apexReferences(t: ApexTarget, includeDeclaration: boolean, token?: vscode.CancellationToken): Promise<vscode.Location[]> {
    const fromServer = await lsRequest<LspLocation[]>("sfx/apexReferences", { className: t.className, member: t.member, prefer: "aura", includeDeclaration }, token);
    if (fromServer) return fromServer.map(toLocation);
    const decl = includeDeclaration ? await apexDeclaration(t, token) : undefined;
    return decl ? [decl.location] : [];
}

function spanRange(doc: vscode.TextDocument, s: Span): vscode.Range {
    return new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end));
}

/** Merge server references with this document's live-buffer ones (the server reads it from disk). */
function withLiveDocument(doc: vscode.TextDocument, server: vscode.Location[], live: Span[]): vscode.Location[] {
    const self = doc.uri.toString();
    const out = server.filter((l) => l.uri.toString() !== self);
    for (const s of live) out.push(new vscode.Location(doc.uri, spanRange(doc, s)));
    return out;
}

// ─── LWC ────────────────────────────────────────────────────────────────────────

function lwcTargetAt(doc: vscode.TextDocument, position: vscode.Position): (ApexTarget & { onClass: boolean }) | undefined {
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const hit = lwcApexImportAt(text, offset);
    if (!hit) return undefined;
    const onClass = hit.on === "spec" && offset >= hit.imp.cls.start - (hit.imp.ns ? hit.imp.ns.length + 1 : 0) && offset <= hit.imp.cls.end && offset < hit.imp.method.start;
    return { className: hit.imp.cls.name, member: onClass ? undefined : hit.imp.method.name, onClass };
}

/** `c/myComponent` → the component's own .js file in any `lwc` folder. */
async function resolveLwcComponent(spec: string): Promise<vscode.Uri | undefined> {
    const m = /^c\/(\w+)$/.exec(spec.trim());
    if (!m) return undefined;
    const name = m[1];
    const hits = await vscode.workspace.findFiles(`**/lwc/${name}/${name}.js`, EXCLUDE_GLOB, 2);
    return hits[0];
}

/** A non-Apex `@salesforce/…` / `c/…` / `lightning/…` specifier string under the cursor. */
function otherSpecAt(doc: vscode.TextDocument, position: vscode.Position): string | undefined {
    const line = doc.lineAt(position.line).text;
    for (const m of line.matchAll(/['"]((?:@salesforce\/|c\/|lightning\/)[\w./-]+)['"]/g)) {
        const start = m.index ?? 0;
        if (position.character >= start && position.character <= start + m[0].length) return m[1];
    }
    // The local name of a `c/…` import (Cmd+click on the binding).
    const range = doc.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!range) return undefined;
    const word = doc.getText(range);
    for (const m of doc.getText().matchAll(/import\s+(\w+)[^'"\n]*from\s+['"](c\/[\w./-]+)['"]/g)) if (m[1] === word) return m[2];
    return undefined;
}

/** `@salesforce/schema/Account.Name` → { object, field }. */
export function parseSchemaImport(spec: string): { object: string; field?: string } | undefined {
    const m = /^@salesforce\/schema\/([\w.]+)$/.exec(spec.trim());
    if (!m) return undefined;
    const parts = m[1].split(".");
    return parts.length > 1 ? { object: parts[0], field: parts.slice(1).join(".") } : { object: parts[0] };
}

export class LwcApexDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
        const target = lwcTargetAt(document, position);
        if (target) return (await apexDeclaration(target, token))?.location;
        const spec = otherSpecAt(document, position);
        if (!spec) return undefined;
        const component = await resolveLwcComponent(spec);
        return component ? new vscode.Location(component, new vscode.Position(0, 0)) : undefined;
    }
}

export class LwcApexReferenceProvider implements vscode.ReferenceProvider {
    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.Location[] | undefined> {
        const target = lwcTargetAt(document, position);
        if (!target) return undefined;
        const server = await apexReferences(target, context.includeDeclaration, token);
        return withLiveDocument(document, server, lwcApexRefs(document.getText(), target.className, target.member));
    }
}

async function apexHover(target: ApexTarget, token?: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const resolved = await apexDeclaration(target, token);
    if (!resolved) return undefined;
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    if (!target.member) {
        md.appendCodeblock(`class ${target.className}`, "apex");
    } else if (resolved.method) {
        md.appendCodeblock(formatSignature(resolved.method), "apex");
        if (resolved.method.cacheable) md.appendMarkdown("`cacheable` — usable with `@wire`\n\n");
        if (resolved.method.doc) md.appendMarkdown(resolved.method.doc + "\n\n");
    } else {
        md.appendMarkdown(`\`${target.member}\` — not found as an \`@AuraEnabled\` method.\n\n`);
    }
    md.appendMarkdown(`_— ASFX Toolkit · ${vscode.workspace.asRelativePath(resolved.location.uri)}_`);
    return new vscode.Hover(md);
}

export class LwcApexHoverProvider implements vscode.HoverProvider {
    async provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        const target = lwcTargetAt(document, position);
        if (target) return apexHover(target, token);
        const spec = otherSpecAt(document, position);
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
                schema.field ? `Field reference — \`${schema.object}.${schema.field}\`\n\n` : `Object reference — \`${schema.object}\`\n\n`,
            );
            md.appendMarkdown("_— ASFX Toolkit_");
            return new vscode.Hover(md);
        }
        return undefined;
    }
}

// ─── Aura ───────────────────────────────────────────────────────────────────────

/** The Apex controller of the Aura bundle a file belongs to (`controller=` on its .cmp/.app). */
async function auraBundleController(file: string): Promise<string | undefined> {
    const dir = path.dirname(file);
    const name = path.basename(dir);
    for (const ext of ["cmp", "app"]) {
        const text = await readText(vscode.Uri.file(path.join(dir, `${name}.${ext}`)));
        const ref = text !== undefined ? auraControllerRef(text) : undefined;
        if (ref) return ref.name;
    }
    return undefined;
}

async function auraJsTarget(doc: vscode.TextDocument, position: vscode.Position): Promise<ApexTarget | undefined> {
    const action = auraActionAt(doc.getText(), doc.offsetAt(position));
    if (!action) return undefined;
    const cls = await auraBundleController(doc.uri.fsPath);
    return cls ? { className: cls, member: action.name } : undefined;
}

/** `controller="Cls"` (Aura markup) / `controller=` / `extensions=` (Visualforce) under the cursor. */
function markupControllerAt(doc: vscode.TextDocument, position: vscode.Position): ApexTarget | undefined {
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const refs = /\.(cmp|app)$/i.test(doc.fileName) ? [auraControllerRef(text)].filter((r): r is NonNullable<typeof r> => !!r) : vfControllerRefs(text);
    const r = refs.find((x) => offset >= x.start - (x.ns ? x.ns.length + 1 : 0) && offset <= x.end);
    return r ? { className: r.name } : undefined;
}

const auraJsDefinition: vscode.DefinitionProvider = {
    async provideDefinition(doc, position, token) {
        const t = await auraJsTarget(doc, position);
        return t ? (await apexDeclaration(t, token))?.location : undefined;
    },
};

const auraJsReferences: vscode.ReferenceProvider = {
    async provideReferences(doc, position, context, token) {
        const t = await auraJsTarget(doc, position);
        if (!t || !t.member) return undefined;
        const server = await apexReferences(t, context.includeDeclaration, token);
        return withLiveDocument(doc, server, auraActionRefs(doc.getText(), t.member));
    },
};

const auraJsHover: vscode.HoverProvider = {
    async provideHover(doc, position, token) {
        const t = await auraJsTarget(doc, position);
        return t ? apexHover(t, token) : undefined;
    },
};

const markupDefinition: vscode.DefinitionProvider = {
    async provideDefinition(doc, position, token) {
        const t = markupControllerAt(doc, position);
        return t ? (await apexDeclaration(t, token))?.location : undefined;
    },
};

const markupReferences: vscode.ReferenceProvider = {
    async provideReferences(doc, position, context, token) {
        const t = markupControllerAt(doc, position);
        if (!t) return undefined;
        const server = await apexReferences(t, context.includeDeclaration, token);
        const text = doc.getText();
        const live = (/\.(cmp|app)$/i.test(doc.fileName) ? [auraControllerRef(text)] : vfControllerRefs(text)).filter(
            (r): r is NonNullable<typeof r> => !!r && classNameMatches(r.name, r.ns, t.className),
        );
        return withLiveDocument(doc, server, live);
    },
};

/** Register the LWC / Aura / Visualforce → Apex definition, references and hover providers. */
export function registerLwcApexProviders(context: vscode.ExtensionContext): void {
    const lwcSelector: vscode.DocumentSelector = [
        { language: "javascript", scheme: "file" },
        { language: "typescript", scheme: "file" },
    ];
    const lwcOnly: vscode.DocumentSelector = [
        { scheme: "file", pattern: "**/lwc/**/*.js" },
        { scheme: "file", pattern: "**/lwc/**/*.ts" },
    ];
    const auraJs: vscode.DocumentSelector = { scheme: "file", pattern: "**/aura/**/*.js" };
    const markup: vscode.DocumentSelector = [
        { scheme: "file", pattern: "**/aura/**/*.{cmp,app}" },
        { scheme: "file", pattern: "**/*.{page,component}" },
    ];
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(lwcSelector, new LwcApexDefinitionProvider()),
        vscode.languages.registerHoverProvider(lwcSelector, new LwcApexHoverProvider()),
        vscode.languages.registerReferenceProvider(lwcOnly, new LwcApexReferenceProvider()),
        vscode.languages.registerDefinitionProvider(auraJs, auraJsDefinition),
        vscode.languages.registerReferenceProvider(auraJs, auraJsReferences),
        vscode.languages.registerHoverProvider(auraJs, auraJsHover),
        vscode.languages.registerDefinitionProvider(markup, markupDefinition),
        vscode.languages.registerReferenceProvider(markup, markupReferences),
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

