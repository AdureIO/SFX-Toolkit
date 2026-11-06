/**
 * Shared Apex symbol resolution + occurrence search, used by references, rename,
 * go-to-implementation and type hierarchy.
 *
 * Resolution (`resolveAt`) turns the identifier under the cursor into one of:
 *   local   — a local variable / parameter (confined to its declaring method)
 *   field   — a field, property or enum value of a workspace type (owner = declaring type)
 *   method  — a method of a workspace type (owner = nearest declaring type; the overload
 *             is picked by the call's argument count, or exactly when on a declaration)
 *   type    — a workspace class / interface / enum (top-level or inner)
 * or a rejection explaining why it isn't a workspace symbol (keyword, standard library,
 * org schema, unresolvable receiver…).
 *
 * The search (`findOccurrences`) scans the declaring document (locals) or the whole
 * workspace (members/types — never capped):
 *   1. candidates from the token index (tokenIndex.ts: every .cls/.trigger + metadata
 *      file, code tokens only) plus open buffers (unsaved text wins). A member can only
 *      be reached from a file that declares a family type, names one, or names a
 *      "producer" — a workspace member whose declared type mentions a family type
 *      (`instance()`, `List<Svc> items`…) — so files that merely reuse the member name
 *      on unrelated types are never parsed;
 *   2. each candidate is parsed in the parse worker (open buffers: their exact current
 *      version) and every case-insensitive whole-word occurrence in code is classified
 *      against the target: receiver types (`x.name`, `this` / `super`, static
 *      `Type.member`, `ns.Type.member`, and full expression chains such as
 *      `a.b().c()[0].name` typed with the expression resolver, apexResolve.ts), bare uses
 *      inside the owner's hierarchy, shadowing locals, variable-vs-type positions,
 *      constructor declarations, overload arity, enum values in `when` clauses;
 *   3. Salesforce metadata that refers to the symbol by name (metadataRefs.ts): LWC
 *      imports + call sites, Aura `c.method`, Visualforce, Flows, `Type.forName`.
 * Methods use their "family" (the override / implementation slot: base declarations
 * and every override) — like Java language servers, an override and its base method are
 * the same symbol for references and rename.
 *
 * Mode `references` keeps occurrences whose receiver can't be typed at all (e.g. a
 * receiver of a type outside this workspace's knowledge) — inclusive; receivers typed to
 * a different (workspace, standard or SObject) type are always excluded. Mode `rename`
 * drops every occurrence it can't prove refers to the symbol.
 */
import { CancellationToken, LSPErrorCodes, Range, ResponseError } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ServerContext } from './context';
import type { ApexIndex, ApexMemberDecl, ApexParseResult, ApexTypeDecl, VarDecl } from './apexSymbols';
import { WorkspaceIndex, TypeGraph, TypeNode, isIgnoredPath } from './workspaceIndex';
import { blankNonCode } from '../../src/utils/apexReferences';
import { typeForNameRefs, classNameMatches } from '../../src/utils/sfMetadataRefs';
import { stdTypeName, stdMembersFor } from './apexStdlib';
import { stubbedObjectNames } from './sobjectStub';
import { throwIfCancelled } from './cancel';
import { baseTypeName, isApex } from './textUtil';
import { lruGet, lruSet } from './caches';
import { ParseWorker } from './parseWorkerClient';
import { TokenIndex } from './tokenIndex';
import { Resolver, receiverExprBefore } from './apexResolve';
import type { ParseView } from './parseCache';
import { metadataOccurrences } from './metadataRefs';

// ─── Apex words ─────────────────────────────────────────────────────────────────

/** Apex reserved words (cannot be used as identifiers). */
export const APEX_RESERVED = new Set(
    (
        'abstract activate and any array as asc autonomous begin bigdecimal blob boolean break bulk by byte ' +
        'case cast catch char class collect commit const continue currency date datetime decimal default delete ' +
        'desc do double else end enum exception exit export extends false final finally float for from global ' +
        'goto group having hint if implements import in inner insert instanceof int integer interface into join ' +
        'like limit list long loop map merge new not null nulls number object of on or outer override package ' +
        'parallel pragma private protected public retrieve return rollback select set short sobject sort static ' +
        'string super switch synchronized system testmethod then this throw time transaction trigger true try ' +
        'undelete update upsert using virtual void webservice when where while ' +
        'after before count excludes first includes last order sharing with without'
    ).split(' '),
);

/** Why a new name is not a valid Apex identifier (undefined = valid). */
export function invalidIdentifierReason(name: string, isType: boolean): string | undefined {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return `'${name}' is not a valid Apex identifier (letters, digits and _; must start with a letter).`;
    if (name.includes('__')) return `'${name}' is not a valid Apex identifier (no consecutive underscores).`;
    if (name.endsWith('_')) return `'${name}' is not a valid Apex identifier (cannot end with an underscore).`;
    if (APEX_RESERVED.has(name.toLowerCase())) return `'${name}' is a reserved Apex keyword.`;
    if (isType && name.length > 40) return `Apex type names are limited to 40 characters.`;
    if (name.length > 255) return `Apex identifiers are limited to 255 characters.`;
    return undefined;
}

// ─── File models ────────────────────────────────────────────────────────────────

/** A parsed Apex file: text, blanked code (comments/strings → spaces), parse index. */
export interface FileModel {
    /** fs path (or the URI for non-file buffers). */
    path: string;
    uri: string;
    text: string;
    code: string;
    index: ApexIndex;
    typeDecls: ApexTypeDecl[];
    /** typeDecl.range objects — a VarDecl whose scope is one of these is a field. */
    typeScopes: Set<Range>;
    lineStarts: number[];
    /** Document version for open buffers (undefined for files read from disk). */
    version?: number;
}

/**
 * Comments and string contents blanked (offsets preserved), string delimiters kept so
 * `f('x')` still has one argument (a fully blanked literal would look like `f(   )`).
 */
function blankCode(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
        .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${' '.repeat(m.length - 2)}'`);
}

function makeModel(path: string, uri: string, text: string, index: ApexIndex, version?: number): FileModel {
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const typeDecls = index.typeDecls ?? [];
    return {
        path,
        uri,
        text,
        code: blankCode(text),
        index,
        typeDecls,
        typeScopes: new Set(typeDecls.map((t) => t.range)),
        lineStarts,
        version,
    };
}

export function offsetOf(m: FileModel, line: number, character: number): number {
    return (m.lineStarts[line] ?? m.text.length) + character;
}

export function positionOf(m: FileModel, offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = m.lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (m.lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, character: offset - m.lineStarts[lo] };
}

export function pathOfUri(uri: string): string {
    if (!uri.startsWith('file:')) return uri;
    try {
        return fileURLToPath(uri);
    } catch {
        return uri;
    }
}

/**
 * Parsed closed files (path → mtime + model), shared across requests (LRU). Capped by
 * count and by total text size (a model holds the text, its blanked copy and the parse
 * index — roughly 6× the text in memory).
 */
const MAX_CLOSED_MODELS = 800;
const MAX_CLOSED_CHARS = 12_000_000;
const closedModels = new Map<string, { mtime: number; model: FileModel }>();
let closedChars = 0;

function cacheClosed(path: string, mtime: number, model: FileModel): void {
    const prev = closedModels.get(path);
    if (prev) closedChars -= prev.model.text.length;
    lruSet(closedModels, path, { mtime, model }, Number.MAX_SAFE_INTEGER);
    closedChars += model.text.length;
    while (closedModels.size > 1 && (closedModels.size > MAX_CLOSED_MODELS || closedChars > MAX_CLOSED_CHARS)) {
        const [k, v] = closedModels.entries().next().value as [string, { model: FileModel }];
        closedModels.delete(k);
        closedChars -= v.model.text.length;
    }
}

/** Release the closed-file model cache (call on shutdown). */
export function clearSearchCaches(): void {
    closedModels.clear();
    closedChars = 0;
}

/** Thrown when an open document changed while a request computed exact ranges for it. */
export function contentModified(): ResponseError<void> {
    return new ResponseError(LSPErrorCodes.ContentModified, 'The document changed while the request was computed.');
}

/**
 * Per-request state: the open documents (by fs path), the type graph (built once per
 * request), and parsed file models. Cancellation is checked on every async step.
 */
export class SearchSession {
    readonly openByPath = new Map<string, TextDocument>();
    private graphP: Promise<TypeGraph> | undefined;
    private models = new Map<string, FileModel>();
    private nsP: Promise<string | null> | undefined;
    private docs = new Map<string, TextDocument>();

    constructor(readonly ctx: ServerContext, readonly token?: CancellationToken) {
        for (const d of ctx.documents.all()) {
            if (isApex(d.uri) && d.languageId !== 'soql') this.openByPath.set(pathOfUri(d.uri), d);
        }
    }

    check(): void {
        throwIfCancelled(this.token);
    }

    graph(): Promise<TypeGraph> {
        if (!this.graphP) {
            const texts = new Map<string, string>();
            for (const [p, d] of this.openByPath) if (d.uri.startsWith('file:')) texts.set(p, d.getText());
            this.graphP = WorkspaceIndex.typeGraph(texts, this.token);
        }
        return this.graphP;
    }

    /** The project namespace (sfdx-project.json via the host), or null. Asked once per request. */
    namespace(): Promise<string | null> {
        if (!this.nsP) {
            const any = this.openByPath.values().next().value as TextDocument | undefined;
            const uri = any?.uri ?? pathToFileURL(WorkspaceIndex.allFiles()[0] ?? '/').href;
            this.nsP = this.ctx.schema.projectNamespace(uri, this.token).catch(() => null);
        }
        return this.nsP;
    }

    /**
     * Model of an open document: its exact CURRENT version, parsed in the worker. If the
     * document changes while we wait, parse again (ranges must line up with the text).
     */
    async modelForDoc(doc: TextDocument): Promise<FileModel> {
        const p = pathOfUri(doc.uri);
        const hit = this.models.get(p);
        if (hit && hit.version === doc.version) return hit;
        for (let attempt = 0; attempt < 3; attempt++) {
            const version = doc.version;
            const text = doc.getText();
            const parse = await this.ctx.parses.currentAsync(doc);
            this.check();
            if (doc.version !== version) continue;
            const m = makeModel(p, doc.uri, text, parse.index, version);
            this.models.set(p, m);
            return m;
        }
        throw contentModified();
    }

    /** Model of any Apex file: the open buffer if open, else the file on disk (parsed in the worker). */
    async load(path: string): Promise<FileModel | undefined> {
        const open = this.openByPath.get(path);
        if (open) return this.modelForDoc(open);
        const hit = this.models.get(path);
        if (hit) return hit;
        try {
            const st = await fs.promises.stat(path);
            const cached = lruGet(closedModels, path);
            if (cached && cached.mtime === st.mtimeMs) {
                this.models.set(path, cached.model);
                return cached.model;
            }
            const text = await fs.promises.readFile(path, 'utf8');
            this.check();
            const parse = await ParseWorker.parseText(text, 'background');
            this.check();
            const m = makeModel(path, pathToFileURL(path).href, text, parse.index);
            cacheClosed(path, st.mtimeMs, m);
            this.models.set(path, m);
            return m;
        } catch (e) {
            this.check();
            if (e instanceof ResponseError) throw e;
            return undefined;
        }
    }

    /** Text of a file without parsing (open buffer or disk). */
    async textOf(path: string): Promise<string | undefined> {
        const open = this.openByPath.get(path);
        if (open) return open.getText();
        const m = this.models.get(path);
        if (m) return m.text;
        try {
            return await fs.promises.readFile(path, 'utf8');
        } catch {
            return undefined;
        }
    }

    /** URI to report for a file (the open document's own URI when open). */
    uriOf(path: string): string {
        return this.openByPath.get(path)?.uri ?? (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? pathToFileURL(path).href : path);
    }

    /** A TextDocument view of a model (for the expression resolver). */
    docOf(m: FileModel): TextDocument {
        const open = this.openByPath.get(m.path);
        if (open && open.version === m.version) return open;
        let d = this.docs.get(m.path);
        if (!d || d.getText() !== m.text) {
            d = TextDocument.create(m.uri, 'apex', 0, m.text);
            this.docs.set(m.path, d);
        }
        return d;
    }

    /** The parse declaration of a graph node. */
    async declOf(node: TypeNode): Promise<ApexTypeDecl | undefined> {
        const m = await this.load(node.file);
        return m ? typeDeclFor(m, node.qname) : undefined;
    }

    /** Members declared directly in a graph node's type. */
    async membersOf(node: TypeNode): Promise<ApexMemberDecl[]> {
        return (await this.declOf(node))?.members ?? [];
    }
}

function typeDeclFor(m: FileModel, qname: string): ApexTypeDecl | undefined {
    const lc = qname.toLowerCase();
    return m.typeDecls.find((t) => (t.outer ? `${t.outer}.${t.name}` : t.name).toLowerCase() === lc);
}

function qnameOf(t: ApexTypeDecl): string {
    return t.outer ? `${t.outer}.${t.name}` : t.name;
}

// ─── Small helpers ──────────────────────────────────────────────────────────────

function contains(r: Range, line: number, ch: number): boolean {
    const afterStart = line > r.start.line || (line === r.start.line && ch >= r.start.character);
    const beforeEnd = line < r.end.line || (line === r.end.line && ch <= r.end.character);
    return afterStart && beforeEnd;
}

function size(r: Range): number {
    return (r.end.line - r.start.line) * 100_000 + (r.end.character - r.start.character);
}

function at(r: Range, p: { line: number; character: number }): boolean {
    return r.start.line === p.line && r.start.character === p.character;
}

/** Enclosing type declarations at a position, innermost first. */
export function enclosingTypes(m: FileModel, line: number, ch: number): ApexTypeDecl[] {
    return m.typeDecls.filter((t) => contains(t.range, line, ch)).sort((a, b) => size(a.range) - size(b.range));
}

/**
 * The declaration a variable name refers to at a position: the narrowest enclosing
 * scope wins (locals shadow fields), then the latest declaration before the position.
 * Locals must be declared before use; fields are visible anywhere in their type.
 */
export function varAt(m: FileModel, name: string, line: number, ch: number): VarDecl | undefined {
    const lc = name.toLowerCase();
    let best: VarDecl | undefined;
    for (const d of m.index.varDecls) {
        if (d.name.toLowerCase() !== lc) continue;
        if (!contains(d.scope, line, ch)) continue;
        const isField = m.typeScopes.has(d.scope);
        if (!isField && (d.line > line || (d.line === line && (d.character ?? 0) > ch))) continue;
        if (!best) {
            best = d;
            continue;
        }
        const ds = size(d.scope);
        const bs = size(best.scope);
        if (ds < bs || (ds === bs && d.line >= best.line)) best = d;
    }
    return best;
}

function isFieldDecl(m: FileModel, d: VarDecl): boolean {
    return m.typeScopes.has(d.scope);
}

/** Receiver of `<recv>.name` ending just before `start` (in blanked code); `dot` = offset of the `.`. */
type Receiver = { kind: 'none' } | { kind: 'ident'; name: string; dot: number } | { kind: 'complex'; dot: number };

function receiverAt(code: string, start: number): Receiver {
    let i = start - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== '.') return { kind: 'none' };
    const dot = i;
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
    const end = i + 1;
    while (i >= 0 && /\w/.test(code[i])) i--;
    const name = code.slice(i + 1, end);
    if (!/^[A-Za-z_]\w*$/.test(name)) return { kind: 'complex', dot };
    let j = i;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (code[j] === '.') return { kind: 'complex', dot }; // a.b.name — chain
    return { kind: 'ident', name, dot };
}

function followedByCall(code: string, end: number): boolean {
    return /^\s*\(/.test(code.slice(end, end + 200));
}

/**
 * Number of arguments of the call whose name ends at `end` (`name(a, b)` → 2), or
 * undefined when the parens can't be matched. Generic `<…>` (written without a space
 * before `<`) and nested brackets don't split arguments.
 */
export function callArity(code: string, end: number): number | undefined {
    let i = end;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '(') return undefined;
    let depth = 0;
    let angle = 0;
    let commas = 0;
    let any = false;
    for (i++; i < code.length; i++) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) {
                if (c !== ')') return undefined;
                return any ? commas + 1 : 0;
            }
            depth--;
        } else if (c === '<' && /\w/.test(code[i - 1] ?? '')) angle++;
        else if (c === '>' && angle > 0) angle--;
        else if (c === ',' && depth === 0 && angle === 0) commas++;
        else if (c === ';') return undefined;
        if (!/\s/.test(c)) any = true;
    }
    return undefined;
}

function precededByNew(code: string, start: number): boolean {
    return /\bnew\s+$/i.test(code.slice(Math.max(0, start - 30), start));
}

/**
 * Whether an identifier occurrence sits where only a TYPE can appear (so a variable of
 * the same name in scope doesn't capture it): after `new` / `instanceof`, a generic
 * argument, an array type, a cast, `X.class`, or the type of a declaration (`X name =`).
 */
export function isTypePosition(code: string, start: number, end: number): boolean {
    const before = code.slice(Math.max(0, start - 80), start);
    const after = code.slice(end, end + 120);
    if (/\b(new|instanceof)\s+$/i.test(before)) return true;
    if (/^\s*\[\s*\]/.test(after)) return true;
    if (/^\s*\.\s*class\b/i.test(after)) return true;
    const decl = /^\s+([A-Za-z_]\w*)\s*([=;,):]|$)/.exec(after);
    if (decl && !APEX_RESERVED.has(decl[1].toLowerCase())) return true;
    // Generic argument: inside an unclosed `<` on this line.
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
    if (/[<,]\s*$/.test(lineBefore) && /^\s*[>,]/.test(after) && lineBefore.lastIndexOf('<') > lineBefore.lastIndexOf('(')) return true;
    // Cast: `(X) expr`.
    if (/\(\s*$/.test(before) && /^\s*\)\s*[A-Za-z_(]/.test(after)) return true;
    return false;
}

/** `when A, B {` — an identifier in a switch `when` value list (enum values are written bare there). */
function inWhenClause(code: string, start: number): boolean {
    const lineBefore = code.slice(code.lastIndexOf('\n', start - 1) + 1, start);
    return /\bwhen\s+(?:[A-Za-z_]\w*\s*,\s*)*$/i.test(lineBefore);
}

const SCHEMA_SUFFIX = /__(c|r|mdt|e|x|b|share|history|feed|kav|ka|changeevent)$/i;

// ─── Receiver typing (expression chains) ────────────────────────────────────────

/**
 * Drop a leading namespace qualifier: `myns.AccountService.x` → `AccountService.x`, when
 * the first segment is no variable / type in scope, is the project namespace (or the
 * namespace is unknown), and the next segment is a workspace type.
 */
async function stripNamespace(s: SearchSession, g: TypeGraph, m: FileModel, expr: string, pos: { line: number; character: number }): Promise<string> {
    const mm = /^\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/.exec(expr);
    if (!mm) return expr;
    if (!isNamespaceQualifier(m, g, mm[1], mm[2], pos)) return expr;
    const ns = await s.namespace();
    if (ns && ns.toLowerCase() !== mm[1].toLowerCase()) return expr;
    return expr.slice(expr.indexOf('.', mm.index + mm[1].length) + 1).trimStart();
}

function isNamespaceQualifier(m: FileModel, g: TypeGraph, first: string, next: string, pos: { line: number; character: number }): boolean {
    const lc = first.toLowerCase();
    if (lc === 'this' || lc === 'super' || APEX_RESERVED.has(lc)) return false;
    if (varAt(m, first, pos.line, pos.character)) return false;
    if (g.resolve(first, m.path)) return false;
    if (stdTypeName(first) || stdMembersFor(first)) return false;
    return !!g.resolve(next, m.path);
}

/**
 * The workspace type of the receiver expression ending at `dot` (`a.b().c[0]` in
 * `a.b().c[0].name`): a node, `'external'` when it resolves to a standard / SObject /
 * non-workspace type, or undefined when it can't be typed.
 */
async function typeOfReceiver(
    s: SearchSession,
    g: TypeGraph,
    m: FileModel,
    dot: number,
    pos: { line: number; character: number },
): Promise<TypeNode | 'external' | undefined> {
    let expr = receiverExprBefore(m.text, dot);
    if (!expr) return undefined;
    expr = await stripNamespace(s, g, m, expr, pos);
    const view: ParseView = { result: { index: m.index } as ApexParseResult, stale: false, toParsePosition: (p) => p };
    let v;
    try {
        v = await new Resolver(s.ctx, s.docOf(m), pos, [view], s.token).exprValue(expr);
    } catch (e) {
        s.check();
        return undefined;
    }
    s.check();
    if (!v) return undefined;
    if (v.t.k !== 'user') return 'external';
    const qn = v.t.decl.outer ? `${v.t.decl.outer}.${v.t.decl.name}` : v.t.decl.name;
    return g.find(v.t.ft.file, qn) ?? g.resolve(qn, m.path) ?? undefined;
}

// ─── Overload selection by argument types ───────────────────────────────────────

/** Lower-cased simple type name of an argument / parameter (`undefined` = not determinable). */
export type ArgType = string | undefined;

function normType(t: string): string {
    const x = t.trim();
    if (/\[\s*\]$/.test(x)) return 'list';
    return (x.replace(/<[\s\S]*$/, '').split('.').pop() ?? '').trim().toLowerCase();
}

/** Normalised parameter types of a method / constructor declaration (read from the file text). */
export function paramTypesOf(m: FileModel, member: ApexMemberDecl): string[] {
    const code = m.code;
    let i = offsetOf(m, member.nameRange.end.line, member.nameRange.end.character);
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '(') return [];
    const parts: string[] = [];
    let depth = 0;
    let from = i + 1;
    for (i++; i < code.length; i++) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '<') depth++;
        else if (c === ']' || c === '>') depth--;
        else if (c === ')') {
            if (depth === 0) {
                parts.push(code.slice(from, i));
                break;
            }
            depth--;
        } else if (c === ',' && depth === 0) {
            parts.push(code.slice(from, i));
            from = i + 1;
        }
    }
    return parts
        .map((p) => p.trim())
        .filter((p) => p)
        .map((p) => normType(p.replace(/^(?:final\s+)+/i, '').replace(/\s+[A-Za-z_]\w*\s*$/, '')));
}

const NUMERIC_RANK: Record<string, number> = { integer: 1, long: 2, double: 3, decimal: 3 };
const PRIMITIVES = new Set(['integer', 'long', 'double', 'decimal', 'boolean']);

/** Compatibility score of passing an `arg` to a `param` (negative = not callable). */
function argScore(arg: ArgType, param: string, isSub: (a: string, p: string) => boolean): number {
    if (arg === undefined) return 0;
    if (param === 'object') return 1;
    if (arg === param) return 4;
    if (arg === 'null') return PRIMITIVES.has(param) ? -1 : 1;
    const ra = NUMERIC_RANK[arg];
    const rp = NUMERIC_RANK[param];
    if (ra && rp) return rp >= ra ? 3 - 0.1 * (rp - ra) : -1;
    if ((arg === 'string' && param === 'id') || (arg === 'id' && param === 'string')) return 2;
    if (isSub(arg, param)) return 3;
    if (param === 'sobject' && !PRIMITIVES.has(arg) && arg !== 'string' && arg !== 'list' && arg !== 'set' && arg !== 'map') return 2;
    return -1;
}

export interface OverloadChoice<T> {
    picks: T[];
    /** True when the argument types single out exactly one signature. */
    sure: boolean;
}

/**
 * Choose among same-arity overloads by the call's argument types. `picks` keeps the
 * candidates' order (nearest first); it is every candidate when nothing can be told.
 */
export function chooseOverload<T extends { params: string[] }>(
    cands: T[],
    args: ArgType[] | undefined,
    isSub: (a: string, p: string) => boolean,
): OverloadChoice<T> {
    const sigs = new Set(cands.map((c) => c.params.join(',')));
    if (!args || sigs.size <= 1) return { picks: cands, sure: sigs.size <= 1 };
    const scored = cands.map((c) => {
        let total = 0;
        for (let k = 0; k < args.length; k++) {
            const sc = argScore(args[k], c.params[k] ?? '', isSub);
            if (sc < 0) return { c, total: -1 };
            total += sc;
        }
        return { c, total };
    });
    const compat = scored.filter((x) => x.total >= 0);
    if (!compat.length) return { picks: cands, sure: false };
    const best = Math.max(...compat.map((x) => x.total));
    const picks = compat.filter((x) => x.total === best).map((x) => x.c);
    const allKnown = args.every((a) => a !== undefined);
    const compatSigs = new Set(compat.map((x) => x.c.params.join(',')));
    const pickSigs = new Set(picks.map((c) => c.params.join(',')));
    return { picks, sure: pickSigs.size === 1 && (allKnown || compatSigs.size === 1) };
}

/** The value type of an argument expression, or undefined. */
async function argTypeOf(s: SearchSession, m: FileModel, expr: string, pos: { line: number; character: number }): Promise<ArgType> {
    const e = expr.trim();
    if (!e) return undefined;
    if (e[0] === "'") return /^'(?:[^'\\]|\\.)*'$/.test(e) || /^'(?:[^'\\]|\\.)*'\s*\+/.test(e) ? 'string' : undefined;
    if (/^[-+]?\d+$/.test(e)) return 'integer';
    if (/^[-+]?\d+[lL]$/.test(e)) return 'long';
    if (/^[-+]?(\d+\.\d*|\.\d+)[dD]?$/.test(e)) return 'decimal';
    if (/^(true|false)$/i.test(e)) return 'boolean';
    if (/^null$/i.test(e)) return 'null';
    const cast = /^\(\s*([A-Za-z_][\w.]*(?:<[^()]*>)?(?:\[\])?)\s*\)\s*[A-Za-z_(]/.exec(e);
    if (cast) return normType(cast[1]);
    if (/^[A-Za-z_]\w*$/.test(e)) {
        const v = varAt(m, e, pos.line, pos.character);
        if (v) return normType(v.type);
    }
    const view: ParseView = { result: { index: m.index } as ApexParseResult, stale: false, toParsePosition: (p) => p };
    try {
        const v = await new Resolver(s.ctx, s.docOf(m), pos, [view], s.token).exprValue(e);
        if (!v || v.static) return undefined;
        switch (v.t.k) {
            case 'user':
                return v.t.decl.name.toLowerCase();
            case 'std':
                return v.t.cls.name.toLowerCase();
            case 'sobject':
                return v.t.name.toLowerCase();
            default:
                return undefined;
        }
    } catch {
        s.check();
        return undefined;
    }
}

/** Argument types of the call whose name ends at `end` (undefined when the parens don't match). */
export async function argTypesAt(s: SearchSession, m: FileModel, end: number, pos: { line: number; character: number }): Promise<ArgType[] | undefined> {
    const code = m.code;
    let i = end;
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] !== '(') return undefined;
    const spans: [number, number][] = [];
    let depth = 0;
    let angle = 0;
    let from = i + 1;
    let closed = false;
    for (i++; i < code.length; i++) {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) {
                if (c !== ')') return undefined;
                if (code.slice(from, i).trim() || spans.length) spans.push([from, i]);
                closed = true;
                break;
            }
            depth--;
        } else if (c === '<' && /\w/.test(code[i - 1] ?? '')) angle++;
        else if (c === '>' && angle > 0) angle--;
        else if (c === ',' && depth === 0 && angle === 0) {
            spans.push([from, i]);
            from = i + 1;
        } else if (c === ';') return undefined;
    }
    if (!closed) return undefined;
    const out: ArgType[] = [];
    for (const [a, b] of spans) out.push(await argTypeOf(s, m, m.text.slice(a, b), pos));
    return out;
}

/** Subtype test on the workspace graph, by simple names. */
function subtypeTest(g: TypeGraph, fromPath: string): (a: string, p: string) => boolean {
    return (a, p) => {
        const n = g.resolve(a, fromPath);
        return !!n && g.ancestors(n).some((x) => x.header.name.toLowerCase() === p);
    };
}

/** A same-arity method candidate with its normalised parameter types. */
interface OverloadCand {
    owner: TypeNode;
    member: ApexMemberDecl;
    params: string[];
}

async function candOf(s: SearchSession, owner: TypeNode, member: ApexMemberDecl): Promise<OverloadCand> {
    const m = await s.load(owner.file);
    return { owner, member, params: m ? paramTypesOf(m, member) : [] };
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

export type ResolvedSymbol =
    | { kind: 'local'; name: string; model: FileModel; decl: VarDecl }
    | { kind: 'field' | 'method'; name: string; owner: TypeNode; member: ApexMemberDecl }
    | { kind: 'type'; name: string; node: TypeNode };

export interface Rejection {
    reject: string;
}

export interface Resolution {
    /** The identifier span under the cursor (exact text range) and its text. */
    range: Range;
    word: string;
    symbol?: ResolvedSymbol;
    rejection?: Rejection;
}

function isMethodKind(k: ApexMemberDecl['kind']): boolean {
    return k === 'method';
}
function isFieldKind(k: ApexMemberDecl['kind']): boolean {
    return k === 'field' || k === 'property';
}

/** Among same-named methods, the one whose arity matches the call (else the first). */
function pickOverload(list: ApexMemberDecl[], arity: number | undefined): ApexMemberDecl | undefined {
    if (arity !== undefined) {
        const exact = list.find((x) => x.arity === arity);
        if (exact) return exact;
    }
    return list[0];
}

/**
 * First type in [start, ...ancestors] declaring a member `name` of the wanted kind. For
 * methods, every same-arity overload along the chain competes when `args` is given: the
 * call's argument types pick the signature (nearest declaration first among equals).
 */
async function findMemberOwner(
    s: SearchSession,
    start: TypeNode,
    name: string,
    want: 'method' | 'field',
    arity?: number,
    args?: () => Promise<ArgType[] | undefined>,
): Promise<{ owner: TypeNode; member: ApexMemberDecl } | undefined> {
    const g = await s.graph();
    const lc = name.toLowerCase();
    let fallback: { owner: TypeNode; member: ApexMemberDecl } | undefined;
    const exact: { owner: TypeNode; member: ApexMemberDecl }[] = [];
    for (const t of [start, ...g.ancestors(start)]) {
        s.check();
        const list = (await s.membersOf(t)).filter(
            (x) => x.name.toLowerCase() === lc && (want === 'method' ? isMethodKind(x.kind) : isFieldKind(x.kind)),
        );
        if (!list.length) continue;
        if (want === 'method' && arity !== undefined) {
            const same = list.filter((x) => x.arity === arity);
            if (!same.length) {
                fallback ??= { owner: t, member: list[0] };
                continue; // an overload with this arity may be inherited
            }
            for (const x of same) exact.push({ owner: t, member: x });
            if (!args) break;
            continue;
        }
        const member = want === 'method' ? pickOverload(list, arity) : list[0];
        if (member) return { owner: t, member };
    }
    if (!exact.length) return fallback;
    if (exact.length === 1 || !args) return exact[0];
    const cands = await Promise.all(exact.map((e) => candOf(s, e.owner, e.member)));
    if (new Set(cands.map((c) => c.params.join(','))).size <= 1) return exact[0];
    const choice = chooseOverload(cands, await args(), subtypeTest(g, start.file));
    const pick = choice.picks[0] ?? cands[0];
    return { owner: pick.owner, member: pick.member };
}

/** Graph node for a type declared in a model. */
async function nodeOf(s: SearchSession, m: FileModel, t: ApexTypeDecl): Promise<TypeNode | undefined> {
    return (await s.graph()).find(m.path, qnameOf(t));
}

/** Resolve the identifier at `pos` in an open document. */
export async function resolveAt(
    s: SearchSession,
    doc: TextDocument,
    pos: { line: number; character: number },
): Promise<Resolution | undefined> {
    const m = await s.modelForDoc(doc);
    const offset = offsetOf(m, pos.line, pos.character);
    // Word under the cursor (in blanked code: nothing inside comments/strings resolves).
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(m.code[start - 1])) start--;
    while (end < m.code.length && /\w/.test(m.code[end])) end++;
    const word = m.code.slice(start, end);
    if (!/^[A-Za-z_]\w*$/.test(word)) return undefined;
    const sp = positionOf(m, start);
    const range: Range = { start: sp, end: { line: sp.line, character: sp.character + word.length } };
    const out = (symbol?: ResolvedSymbol, reject?: string): Resolution => ({
        range,
        word,
        symbol,
        rejection: reject ? { reject } : undefined,
    });
    const lc = word.toLowerCase();

    if (APEX_RESERVED.has(lc) && stdTypeName(word)) return out(undefined, `'${word}' is a standard Apex type.`);
    if (APEX_RESERVED.has(lc) && !/^(sharing|with|without|after|before|first|last|count|order|includes|excludes)$/.test(lc)) {
        return out(undefined, `'${word}' is an Apex keyword.`);
    }
    if (m.uri.startsWith('file:') && isIgnoredPath(m.path)) {
        return out(undefined, `'${word}' is declared outside the workspace sources (generated / tooling folder).`);
    }
    const g = await s.graph();
    s.check();

    // ── On a declaration name: exactly that declaration (overloads stay apart) ──
    for (const t of m.typeDecls) {
        if (at(t.nameRange, sp)) {
            const n = await nodeOf(s, m, t);
            if (n) return out({ kind: 'type', name: t.name, node: n });
        }
        const member = t.members.find((x) => at(x.nameRange, sp) && x.name.toLowerCase() === lc);
        if (!member) continue;
        const n = await nodeOf(s, m, t);
        if (!n) break;
        if (member.kind === 'constructor') return out({ kind: 'type', name: t.name, node: n });
        return out({ kind: isMethodKind(member.kind) ? 'method' : 'field', name: member.name, owner: n, member });
    }

    const call = followedByCall(m.code, end);
    const arity = call ? callArity(m.code, end) : undefined;
    const argsFn = call ? () => argTypesAt(s, m, end, sp) : undefined;
    const recv = receiverAt(m.code, start);
    const notWorkspace = (what?: string): Resolution => {
        if (SCHEMA_SUFFIX.test(word) || stubbedObjectNames().has(lc)) return out(undefined, `'${word}' is part of the org schema (SObject/field) and can't be renamed here.`);
        if (stdTypeName(word)) return out(undefined, `'${word}' is a standard Apex type.`);
        return out(undefined, what ?? `'${word}' is not declared in this workspace.`);
    };
    const memberOf = async (nodes: TypeNode[]): Promise<Resolution> => {
        const want = call ? 'method' : 'field';
        for (const n of nodes) {
            const hit = await findMemberOwner(s, n, word, want, arity, argsFn);
            if (hit) return out({ kind: want, name: hit.member.name, owner: hit.owner, member: hit.member });
        }
        // A static access of an inner type: `Outer.Inner`.
        if (!call) for (const n of nodes) {
            const inner = g.resolve(`${n.qname}.${word}`, m.path);
            if (inner) return out({ kind: 'type', name: inner.header.name, node: inner });
        }
        return out(undefined, `'${word}' is not declared in ${nodes.map((n) => n.qname).join(', ')} or its workspace supertypes.`);
    };

    // ── Receiver-qualified: this.x / super.x / var.x / Type.x / ns.Type / expr.x ──
    if (recv.kind === 'complex') {
        const t = await typeOfReceiver(s, g, m, recv.dot, sp);
        if (t && t !== 'external') return memberOf([t]);
        if (t === 'external') return notWorkspace(`'${word}' is a member of a type that is not declared in this workspace.`);
        return out(undefined, `Can't resolve the expression before '.${word}'.`);
    }
    if (recv.kind === 'ident') {
        const r = recv.name;
        const rlc = r.toLowerCase();
        let startNodes: TypeNode[] = [];
        if (rlc === 'this' || rlc === 'super') {
            const enc = enclosingTypes(m, sp.line, sp.character)[0];
            const n = enc && (await nodeOf(s, m, enc));
            if (!n) return notWorkspace();
            startNodes = rlc === 'this' ? [n] : g.supertypes(n);
            if (!startNodes.length) return out(undefined, `'super.${word}' refers to a type outside this workspace.`);
        } else {
            const v = varAt(m, r, sp.line, sp.character);
            if (v) {
                const tn = g.resolve(baseTypeName(v.type), m.path);
                if (!tn) {
                    const base = baseTypeName(v.type);
                    if (stdTypeName(base) || stdMembersFor(base)) return out(undefined, `'${word}' is a member of the standard Apex type ${base}.`);
                    return out(undefined, `'${word}' is a member of ${base}, which is not declared in this workspace (org schema / managed / standard).`);
                }
                startNodes = [tn];
            } else {
                const tn = g.resolve(r, m.path);
                if (tn) {
                    // Outer.Inner → the inner type (unless it's a static method call of that name).
                    const inner = g.resolve(`${tn.qname}.${word}`, m.path);
                    if (inner && (!call || !(await findMemberOwner(s, tn, word, 'method')))) {
                        return out({ kind: 'type', name: inner.header.name, node: inner });
                    }
                    startNodes = [tn];
                } else if (!call && isNamespaceQualifier(m, g, r, word, sp)) {
                    // `ns.Type` — the type itself.
                    const ns = await s.namespace();
                    const tn2 = g.resolve(word, m.path);
                    if (tn2 && (!ns || ns.toLowerCase() === rlc)) return out({ kind: 'type', name: tn2.header.name, node: tn2 });
                    return notWorkspace(`Can't resolve '${r}' to a workspace type.`);
                } else if (stdTypeName(r) || stdMembersFor(r)) {
                    return out(undefined, `'${r}.${word}' is part of the Apex standard library.`);
                } else {
                    // An inherited field / something the expression resolver knows.
                    const t = await typeOfReceiver(s, g, m, recv.dot, sp);
                    if (t && t !== 'external') return memberOf([t]);
                    return notWorkspace(`Can't resolve '${r}' to a workspace type.`);
                }
            }
        }
        return memberOf(startNodes);
    }

    // ── Bare identifier ──
    const isNew = precededByNew(m.code, start);
    const encl = enclosingTypes(m, sp.line, sp.character);
    if (!isNew && !call) {
        const v = varAt(m, word, sp.line, sp.character);
        if (v && !isTypePosition(m.code, start, end)) {
            if (!isFieldDecl(m, v)) return out({ kind: 'local', name: v.name, model: m, decl: v });
            const t = m.typeDecls.find((x) => x.range === v.scope);
            const n = t && (await nodeOf(s, m, t));
            const member = t?.members.find((x) => isFieldKind(x.kind) && x.name.toLowerCase() === lc);
            if (n && member) return out({ kind: 'field', name: member.name, owner: n, member });
        }
    }
    if (call && !isNew) {
        for (const t of encl) {
            const n = await nodeOf(s, m, t);
            if (!n) continue;
            const hit = await findMemberOwner(s, n, word, 'method', arity, argsFn);
            if (hit) return out({ kind: 'method', name: hit.member.name, owner: hit.owner, member: hit.member });
        }
        if (stdTypeName(word) || stdMembersFor(word)) return notWorkspace();
        return out(undefined, `Method '${word}' is not declared in this workspace.`);
    }
    // A type: declared in this file (inner types first), else workspace.
    const tn = g.resolve(word, m.path);
    if (tn) return out({ kind: 'type', name: tn.header.name, node: tn });
    // An inherited field used bare inside a subclass / an enum value in a `when` clause.
    for (const t of encl) {
        const n = await nodeOf(s, m, t);
        if (!n) continue;
        const hit = await findMemberOwner(s, n, word, 'field');
        if (hit) return out({ kind: 'field', name: hit.member.name, owner: hit.owner, member: hit.member });
    }
    if (inWhenClause(m.code, start)) {
        // `when HIGH` — an enum value of an enum declared in this file.
        for (const t of m.typeDecls) {
            if (t.kind !== 'enum') continue;
            const member = t.members.find((x) => x.modifiers.includes('enumvalue') && x.name.toLowerCase() === lc);
            const n = member && (await nodeOf(s, m, t));
            if (member && n) return out({ kind: 'field', name: member.name, owner: n, member });
        }
    }
    return notWorkspace();
}

// ─── Occurrence search ──────────────────────────────────────────────────────────

/**
 * How an occurrence refers to the symbol (metadata occurrences only; Apex code
 * occurrences have no role). Rename uses it to decide what text to write.
 */
export type OccurrenceRole =
    | 'typeforname' // Type.forName('Cls') string in Apex
    | 'lwc-class' // class segment of an @salesforce/apex import
    | 'lwc-spec' // method segment of an @salesforce/apex import
    | 'lwc-use' // the import's local binding / its call sites (not renamed)
    | 'aura-controller' // controller="Cls"
    | 'aura-action' // 'c.method'
    | 'vf-controller' // controller= / extensions=
    | 'vf' // {!name} for a member of the same name
    | 'vf-getter' // {!foo} for getFoo()
    | 'vf-setter' // {!foo} for setFoo(x)
    | 'flow-class' // <apexClass> / <actionName> as a class reference
    | 'flow-invocable'; // <actionName> as a reference to the @InvocableMethod (it names the class)

export interface Occurrence {
    path: string;
    uri: string;
    range: Range;
    role?: OccurrenceRole;
}

export type SearchMode = 'references' | 'rename';

/** The method "family": every type whose `name` method is the same virtual slot. */
async function methodFamily(s: SearchSession, owner: TypeNode, name: string): Promise<Set<TypeNode>> {
    const g = await s.graph();
    const lc = name.toLowerCase();
    const declares = async (t: TypeNode) => (await s.membersOf(t)).some((x) => isMethodKind(x.kind) && x.name.toLowerCase() === lc);
    // Topmost declarers among owner + its ancestors.
    const roots: TypeNode[] = [owner];
    for (const a of g.ancestors(owner)) if (await declares(a)) roots.push(a);
    const fam = new Set<TypeNode>();
    for (const r of roots) {
        fam.add(r);
        for (const d of g.descendants(r)) fam.add(d);
    }
    return fam;
}

/** The type family a member symbol lives in (method: override slot; field: owner + subtypes). */
export async function symbolFamily(s: SearchSession, sym: Exclude<ResolvedSymbol, { kind: 'local' }>): Promise<Set<TypeNode>> {
    const g = await s.graph();
    if (sym.kind === 'type') return new Set([sym.node]);
    if (sym.kind === 'method') {
        if (sym.member.modifiers.includes('static')) return new Set([sym.owner, ...g.descendants(sym.owner)]);
        return methodFamily(s, sym.owner, sym.name);
    }
    return new Set([sym.owner, ...g.descendants(sym.owner)]);
}

/** Overrides of / implementations of a method in subtypes (for go-to-implementation). */
export async function methodImplementations(s: SearchSession, owner: TypeNode, name: string): Promise<{ node: TypeNode; member: ApexMemberDecl }[]> {
    const g = await s.graph();
    const lc = name.toLowerCase();
    const out: { node: TypeNode; member: ApexMemberDecl }[] = [];
    for (const d of g.descendants(owner)) {
        s.check();
        if (d.header.kind !== 'class') continue;
        for (const mem of await s.membersOf(d)) {
            if (isMethodKind(mem.kind) && mem.name.toLowerCase() === lc && !mem.modifiers.includes('abstract')) out.push({ node: d, member: mem });
        }
    }
    return out;
}

/**
 * Names of standard-library interface methods: renaming one of these in a class that
 * implements a non-workspace interface would break the contract.
 */
const EXTERNAL_CONTRACT_METHODS = new Set([
    'execute', 'start', 'finish', 'compareto', 'iterator', 'hasnext', 'next', 'respond', 'call',
    'oninstall', 'onuninstall', 'handleinboundemail', 'handlemethodcall', 'doinvoke', 'createuser',
    'updateuser', 'equals', 'hashcode', 'tostring', 'getmessage',
]);

/** Extra rename restrictions for a resolved symbol (undefined = renameable). */
export async function renameRestriction(s: SearchSession, sym: ResolvedSymbol): Promise<string | undefined> {
    if (sym.kind === 'type') {
        if (isIgnoredPath(sym.node.file)) return `'${sym.name}' is declared outside the workspace sources.`;
        return undefined;
    }
    if (sym.kind === 'local') return undefined;
    if (isIgnoredPath(sym.owner.file)) return `'${sym.name}' is declared outside the workspace sources.`;
    if (sym.kind === 'method') {
        const g = await s.graph();
        const fam = await methodFamily(s, sym.owner, sym.name);
        for (const t of fam) {
            const refs = [...(t.header.extendsType ? [t.header.extendsType] : []), ...t.header.implementsTypes];
            const external = refs.filter((r) => !g.resolve(r, t.file));
            if (!external.length) continue;
            const mem = (await s.membersOf(t)).find((x) => isMethodKind(x.kind) && x.name.toLowerCase() === sym.name.toLowerCase());
            if (mem && (mem.modifiers.includes('override') || EXTERNAL_CONTRACT_METHODS.has(sym.name.toLowerCase()))) {
                return `'${sym.name}' in ${t.qname} implements/overrides a method of ${external.join(', ')}, which is declared outside this workspace.`;
            }
        }
    }
    return undefined;
}

const isFsPath = (f: string) => f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f);
const wordRe = (n: string) => new RegExp(`(?<![\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'i');

/**
 * Candidate files for a member / type search: open buffers containing the name, plus
 * indexed files whose CODE contains it — for members only those that can reach the
 * family (declare / name a family type or a producer member). Declaring files first.
 */
async function candidateFiles(s: SearchSession, sym: Exclude<ResolvedSymbol, { kind: 'local' }>, family: Set<TypeNode>): Promise<string[]> {
    await TokenIndex.ensure(s.token);
    s.check();
    const lc = sym.name.toLowerCase();
    const familyFiles = new Set([...family].map((t) => t.file));
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (f: string) => {
        if (seen.has(f)) return;
        seen.add(f);
        if (isFsPath(f) && isIgnoredPath(f)) return;
        out.push(f);
    };
    const open = s.openByPath;
    const re = wordRe(lc);
    // Open buffers decide by their own (unsaved) text.
    const openHas = (f: string, token: RegExp) => token.test(blankNonCode(open.get(f)!.getText()));
    for (const f of familyFiles) add(f);
    if (sym.kind === 'type') {
        for (const f of TokenIndex.lookup(lc)) if (!open.has(f) && /\.(cls|trigger)$/i.test(f)) add(f);
        for (const f of TokenIndex.lookup(`'${lc}`)) if (!open.has(f)) add(f);
        for (const f of open.keys()) {
            const t = open.get(f)!.getText();
            if (re.test(blankNonCode(t)) || (/forName/i.test(t) && typeForNameRefs(t).some((r) => r.name.toLowerCase() === lc))) add(f);
        }
        return out;
    }
    // Family type names + producers (members whose declared type mentions a family type).
    const famNames = new Set<string>();
    for (const t of family) {
        famNames.add(t.header.name.toLowerCase());
        if (t.header.outer) famNames.add(t.header.outer.toLowerCase());
    }
    const mentionFiles = new Set<string>();
    for (const n of famNames) for (const f of TokenIndex.lookup(n)) if (!open.has(f)) mentionFiles.add(f);
    const famRes = [...famNames].map((n) => wordRe(n));
    for (const f of open.keys()) if (famRes.some((r) => openHas(f, r))) mentionFiles.add(f);
    const producers = new Set<string>();
    const mention = [...mentionFiles];
    for (let i = 0; i < mention.length; i += 16) {
        s.check();
        // The full model (worker parse, cached): these files are almost always candidates too.
        const typeMaps = await Promise.all(mention.slice(i, i + 16).map((f) => s.load(f).then((m) => m?.index.types)));
        for (const types of typeMaps) for (const members of types?.values() ?? []) {
            for (const mem of members) {
                if (!mem.type || mem.kind === 'constructor' || mem.kind === 'enumValue') continue;
                if (famRes.some((r) => r.test(mem.type!))) producers.add(mem.name.toLowerCase());
            }
        }
    }
    const viaProducer = new Set<string>();
    for (const p of producers) {
        for (const f of TokenIndex.lookup(p)) if (!open.has(f)) viaProducer.add(f);
        const pr = wordRe(p);
        for (const f of open.keys()) if (openHas(f, pr)) viaProducer.add(f);
    }
    for (const f of mentionFiles) if (open.has(f) ? openHas(f, re) : TokenIndex.has(f, lc)) add(f);
    // Files that reach the family only through a producer: parse them only if an occurrence's
    // receiver expression actually goes through one (`x.svc.name`, `instance().name`) —
    // bare / `this` uses outside the family and receivers naming no producer can't be hits.
    let n = 0;
    for (const f of viaProducer) {
        if (seen.has(f)) continue;
        if (!(open.has(f) ? openHas(f, re) : TokenIndex.has(f, lc))) continue;
        if (++n % 25 === 0) await new Promise<void>((r) => setImmediate(r));
        s.check();
        const text = await s.textOf(f);
        if (text !== undefined && receiverThroughProducer(blankNonCode(text), lc, producers)) add(f);
    }
    return out;
}

/** Whether some `….name` occurrence in code has a receiver expression mentioning a producer. */
function receiverThroughProducer(code: string, lcName: string, producers: Set<string>): boolean {
    const re = new RegExp(`(?<![\\w])${lcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi');
    for (const mm of code.matchAll(re)) {
        let i = (mm.index ?? 0) - 1;
        while (i >= 0 && /\s/.test(code[i])) i--;
        if (code[i] !== '.') continue;
        const expr = receiverExprBefore(code, i);
        if (!expr) return true; // can't tell — parse it
        for (const t of expr.matchAll(/[A-Za-z_]\w*/g)) if (producers.has(t[0].toLowerCase())) return true;
    }
    return false;
}

/**
 * Every occurrence of the resolved symbol. Locals: the declaring document only.
 * Members/types: all workspace Apex files that can refer to it (open buffers
 * preferred), plus Salesforce metadata references. Cancellable, yields between files.
 */
export async function findOccurrences(s: SearchSession, sym: ResolvedSymbol, mode: SearchMode): Promise<Occurrence[]> {
    if (sym.kind === 'local') return localOccurrences(sym.model, sym.decl);

    const g = await s.graph();
    const family = await symbolFamily(s, sym);
    const files = await candidateFiles(s, sym, family);
    const arities = sym.kind === 'method' ? await familyArities(s, family, sym.name) : undefined;
    const ov = sym.kind === 'method' ? await overloadSet(s, family, sym) : undefined;

    const out: Occurrence[] = [];
    // Parse candidates a few ahead (the worker queues them); classify in order. Every load
    // promise gets a handler at once so a cancellation never leaves a rejection unhandled.
    const AHEAD = 16;
    const loads: Promise<{ m?: FileModel; e?: unknown }>[] = [];
    const start = (i: number) => {
        if (i < files.length && !loads[i]) loads[i] = s.load(files[i]).then((m) => ({ m }), (e) => ({ e }));
    };
    for (let i = 0; i < Math.min(AHEAD, files.length); i++) start(i);
    for (let i = 0; i < files.length; i++) {
        start(i + AHEAD);
        const r = await loads[i];
        if (r.e) {
            // Drain the rest quietly, then surface the cancellation / content change.
            void Promise.all(loads.slice(i + 1));
            throw r.e;
        }
        s.check();
        if (i % 10 === 9) await new Promise<void>((res) => setImmediate(res));
        const m = r.m;
        if (!m) continue;
        for (const o of await classifyFile(s, m, g, sym, family, mode, arities, ov)) out.push({ path: m.path, uri: s.uriOf(m.path), ...o });
    }
    for (const o of await metadataOccurrences(s, sym, family)) out.push(o);
    return dedupeOccurrences(out);
}

function dedupeOccurrences(list: Occurrence[]): Occurrence[] {
    const seen = new Set<string>();
    return list.filter((o) => {
        const k = `${o.uri}:${o.range.start.line}:${o.range.start.character}:${o.range.end.character}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Arities declared for `name` across a method family (overload filtering). */
async function familyArities(s: SearchSession, family: Set<TypeNode>, name: string): Promise<Set<number>> {
    const lc = name.toLowerCase();
    const out = new Set<number>();
    for (const t of family) for (const x of await s.membersOf(t)) if (isMethodKind(x.kind) && x.name.toLowerCase() === lc && x.arity !== undefined) out.add(x.arity);
    return out;
}

/**
 * The same-arity overloads of a method across its family, when they differ in parameter
 * types (undefined = not overloaded at that arity: arity alone decides).
 */
interface OverloadSet {
    arity: number;
    symSig: string;
    cands: OverloadCand[];
}

async function overloadSet(s: SearchSession, family: Set<TypeNode>, sym: { name: string; owner: TypeNode; member: ApexMemberDecl }): Promise<OverloadSet | undefined> {
    const arity = sym.member.arity;
    if (arity === undefined) return undefined;
    const lc = sym.name.toLowerCase();
    const cands: OverloadCand[] = [];
    for (const t of family) {
        for (const x of await s.membersOf(t)) {
            if (isMethodKind(x.kind) && x.name.toLowerCase() === lc && x.arity === arity) cands.push(await candOf(s, t, x));
        }
    }
    if (new Set(cands.map((c) => c.params.join(','))).size <= 1) return undefined;
    const me = cands.find((c) => c.member === sym.member) ?? (await candOf(s, sym.owner, sym.member));
    return { arity, symSig: me.params.join(','), cands };
}

function wordRanges(m: FileModel, name: string, from = 0, to = m.code.length): { start: number; end: number }[] {
    const re = new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`, 'gi');
    re.lastIndex = from;
    const out: { start: number; end: number }[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(m.code)) !== null && mm.index < to) out.push({ start: mm.index, end: mm.index + mm[0].length });
    return out;
}

function toRange(m: FileModel, start: number, end: number): Range {
    const s = positionOf(m, start);
    return { start: s, end: { line: s.line, character: s.character + (end - start) } };
}

/** Occurrences of a local/param: inside its scope, resolving to the same declaration. */
function localOccurrences(m: FileModel, decl: VarDecl): Occurrence[] {
    const from = offsetOf(m, decl.scope.start.line, decl.scope.start.character);
    const to = offsetOf(m, decl.scope.end.line, decl.scope.end.character);
    const out: Occurrence[] = [];
    for (const w of wordRanges(m, decl.name, from, to)) {
        if (receiverAt(m.code, w.start).kind !== 'none') continue; // x.name — a member of something else
        if (followedByCall(m.code, w.end)) continue; // name(…) — a method call
        const p = positionOf(m, w.start);
        if (varAt(m, decl.name, p.line, p.character) !== decl) continue;
        if (isTypePosition(m.code, w.start, w.end) && !(decl.line === p.line && decl.character === p.character)) continue;
        out.push({ path: m.path, uri: m.uri, range: toRange(m, w.start, w.end) });
    }
    return out;
}

/** Classify every occurrence of the symbol's name in one file. */
async function classifyFile(
    s: SearchSession,
    m: FileModel,
    g: TypeGraph,
    sym: Exclude<ResolvedSymbol, { kind: 'local' }>,
    family: Set<TypeNode>,
    mode: SearchMode,
    arities?: Set<number>,
    ov?: OverloadSet,
): Promise<{ range: Range; role?: OccurrenceRole }[]> {
    const out: { range: Range; role?: OccurrenceRole }[] = [];
    const nodeFor = (t: ApexTypeDecl | undefined) => (t ? g.find(m.path, qnameOf(t)) : undefined);
    const inFamily = (n: TypeNode | undefined) => !!n && family.has(n);
    const lcName = sym.name.toLowerCase();
    /** Does the receiver before `dot` denote a family type? undefined = can't be typed. */
    const receiverInFamily = async (recv: Exclude<Receiver, { kind: 'none' }>, line: number, ch: number): Promise<boolean | undefined> => {
        if (recv.kind === 'ident') {
            const rlc = recv.name.toLowerCase();
            const encl = enclosingTypes(m, line, ch);
            if (rlc === 'this') return inFamily(nodeFor(encl[0]));
            if (rlc === 'super') {
                const n = nodeFor(encl[0]);
                return !!n && g.supertypes(n).some((x) => family.has(x));
            }
            const v = varAt(m, recv.name, line, ch);
            if (v) {
                const tn = g.resolve(baseTypeName(v.type), m.path);
                return tn ? family.has(tn) : false;
            }
            const tn = g.resolve(recv.name, m.path);
            if (tn) return family.has(tn);
            if (stdTypeName(recv.name) || stdMembersFor(recv.name)) return false;
        }
        const t = await typeOfReceiver(s, g, m, recv.dot, { line, character: ch });
        if (t === 'external') return false;
        return t ? family.has(t) : undefined;
    };
    /** Exclude same-named overloads with a different arity (declarations and calls). */
    const arityOk = (a: number | undefined): boolean => {
        if (sym.kind !== 'method' || a === undefined || sym.member.arity === undefined) return true;
        if (a === sym.member.arity) return true;
        return !arities?.has(a); // an arity no family overload declares: keep (can't tell)
    };
    const memberDeclAt = (p: { line: number; character: number }) => {
        for (const t of m.typeDecls) {
            const x = t.members.find((mm) => at(mm.nameRange, p));
            if (x) return { t, x };
        }
        return undefined;
    };

    for (const w of wordRanges(m, sym.name)) {
        const p = positionOf(m, w.start);
        const recv = receiverAt(m.code, w.start);
        const call = followedByCall(m.code, w.end);
        const isNew = precededByNew(m.code, w.start);
        let hit = false;

        if (sym.kind === 'type') {
            const node = sym.node;
            if (recv.kind === 'ident') {
                if (node.header.outer) hit = recv.name.toLowerCase() === node.header.outer.toLowerCase();
                else if (isNamespaceQualifier(m, g, recv.name, sym.name, p) && g.resolve(sym.name, m.path) === node) {
                    const ns = await s.namespace();
                    hit = !ns || ns.toLowerCase() === recv.name.toLowerCase();
                }
            } else if (recv.kind === 'none') {
                if (g.resolve(m.code.slice(w.start, w.end), m.path) !== node) hit = false;
                else {
                    const v = varAt(m, sym.name, p.line, p.character);
                    const isVar = !!v && !isTypePosition(m.code, w.start, w.end);
                    const isVarDeclName = !!v && v.line === p.line && v.character === p.character;
                    if (isVar || isVarDeclName) hit = false;
                    else if (call && !isNew) {
                        hit = m.typeDecls.some(
                            (t) =>
                                t.name.toLowerCase() === lcName &&
                                t.members.some((x) => x.kind === 'constructor' && at(x.nameRange, p)),
                        );
                    } else {
                        // Not a same-named member declaration (method/field names never collide with type refs here).
                        hit = !m.typeDecls.some((t) => t.members.some((x) => x.kind !== 'constructor' && at(x.nameRange, p)));
                    }
                }
            }
        } else if (sym.kind === 'method') {
            if (!call || isNew) hit = false;
            else if (!arityOk(callArity(m.code, w.end))) hit = false;
            else if (recv.kind !== 'none') {
                const r = await receiverInFamily(recv, p.line, p.character);
                hit = r === undefined ? mode === 'references' : r;
            } else {
                const d = memberDeclAt(p);
                if (d) {
                    // A declaration: one of the family's (same arity) declarations.
                    hit = isMethodKind(d.x.kind) && inFamily(nodeFor(d.t)) && arityOk(d.x.arity);
                    if (hit && ov && d.x.arity === ov.arity && paramTypesOf(m, d.x).join(',') !== ov.symSig) hit = false;
                } else {
                    // Bare call: inside a family type (innermost→outer: inner classes may call outer statics).
                    hit = enclosingTypes(m, p.line, p.character).some((t) => inFamily(nodeFor(t)));
                }
            }
            // Overloads that differ only in parameter types: the argument types decide. A call
            // whose target can't be proven stays a reference but is never renamed.
            if (hit && ov && !memberDeclAt(p) && callArity(m.code, w.end) === ov.arity) {
                const choice = chooseOverload(ov.cands, await argTypesAt(s, m, w.end, p), subtypeTest(g, m.path));
                if (!choice.picks.some((c) => c.params.join(',') === ov.symSig)) hit = false;
                else if (!choice.sure && mode === 'rename') hit = false;
            }
        } else {
            // field / property / enum value
            const enumValue = sym.member.modifiers.includes('enumvalue');
            if (call) hit = false;
            else if (recv.kind !== 'none') {
                const r = await receiverInFamily(recv, p.line, p.character);
                hit = r === undefined ? mode === 'references' : r;
            } else if (isTypePosition(m.code, w.start, w.end)) {
                hit = false;
            } else {
                const d = memberDeclAt(p);
                const v = varAt(m, sym.name, p.line, p.character);
                if (d) {
                    hit = isFieldKind(d.x.kind) && nodeFor(d.t) === sym.owner;
                } else if (v) {
                    if (!isFieldDecl(m, v)) hit = false; // shadowed by a local/param
                    else {
                        const owner = nodeFor(m.typeDecls.find((t) => t.range === v.scope));
                        hit = owner === sym.owner;
                    }
                } else if (enumValue && inWhenClause(m.code, w.start)) {
                    // `when HIGH` — the switch's enum is the one declaring the value, if it's reachable here.
                    hit = m.path === sym.owner.file || (await reachesType(s, m, sym.owner));
                } else {
                    // Inherited field used bare inside a subclass.
                    const n = nodeFor(enclosingTypes(m, p.line, p.character)[0]);
                    hit = !!n && n !== sym.owner && family.has(n);
                }
            }
        }
        if (hit) out.push({ range: toRange(m, w.start, w.end) });
    }

    // `Type.forName('Cls')` strings.
    if (sym.kind === 'type' && !sym.node.header.outer && /forName/i.test(m.text)) {
        const ns = await s.namespace();
        for (const r of typeForNameRefs(m.text)) {
            if (classNameMatches(r.name, r.ns, sym.name, ns)) out.push({ range: toRange(m, r.start, r.end), role: 'typeforname' });
        }
    }
    return out;
}

/** Whether a file mentions a type by name (cheap reachability check for bare enum values). */
async function reachesType(s: SearchSession, m: FileModel, t: TypeNode): Promise<boolean> {
    return wordRe(t.header.outer ?? t.header.name).test(m.code);
}

/** Location helper: the declaration name range of a resolved symbol. */
export function declarationOf(s: SearchSession, sym: ResolvedSymbol): Occurrence | undefined {
    if (sym.kind === 'local') {
        const r: Range = {
            start: { line: sym.decl.line, character: sym.decl.character ?? 0 },
            end: { line: sym.decl.line, character: (sym.decl.character ?? 0) + sym.decl.name.length },
        };
        return { path: sym.model.path, uri: sym.model.uri, range: r };
    }
    if (sym.kind === 'type') return { path: sym.node.file, uri: s.uriOf(sym.node.file), range: sym.node.header.nameRange };
    return { path: sym.owner.file, uri: s.uriOf(sym.owner.file), range: sym.member.nameRange };
}

/**
 * `new Cls(args)` at a resolved type: the constructor declaration the call selects (by
 * argument count, then argument types), or undefined when the class declares none.
 */
export async function constructorTarget(
    s: SearchSession,
    m: FileModel,
    node: TypeNode,
    wordStart: number,
    wordEnd: number,
): Promise<Occurrence | undefined> {
    if (!/\bnew\s+(?:[A-Za-z_]\w*\s*\.\s*)*$/i.test(m.code.slice(Math.max(0, wordStart - 120), wordStart)) || !followedByCall(m.code, wordEnd)) return undefined;
    const ctors = (await s.membersOf(node)).filter((x) => x.kind === 'constructor');
    if (!ctors.length) return undefined;
    const arity = callArity(m.code, wordEnd);
    let list = ctors;
    if (arity !== undefined) {
        const same = ctors.filter((c) => c.arity === arity);
        if (same.length) list = same;
    }
    let pick = list[0];
    if (list.length > 1) {
        const cands = await Promise.all(list.map((c) => candOf(s, node, c)));
        const g = await s.graph();
        const args = await argTypesAt(s, m, wordEnd, positionOf(m, wordStart));
        pick = chooseOverload(cands, args, subtypeTest(g, m.path)).picks[0]?.member ?? list[0];
    }
    return { path: node.file, uri: s.uriOf(node.file), range: pick.nameRange };
}

export function sameRange(a: Range, b: Range): boolean {
    return a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;
}

/**
 * Resolve a workspace Apex class (and optionally one of its members) by name — for
 * metadata navigation (LWC / Aura / Visualforce → Apex). Case-insensitive; a member
 * prefers an `@AuraEnabled` declaration (LWC/Aura can only call those), else the first.
 */
export async function resolveByName(
    s: SearchSession,
    className: string,
    member?: string,
    prefer?: 'aura' | 'invocable',
): Promise<ResolvedSymbol | undefined> {
    const g = await s.graph();
    const node = g.resolve(className);
    if (!node) return undefined;
    if (!member) return { kind: 'type', name: node.header.name, node };
    const lc = member.toLowerCase();
    for (const t of [node, ...g.ancestors(node)]) {
        const list = (await s.membersOf(t)).filter((x) => x.name.toLowerCase() === lc && x.kind !== 'constructor');
        if (!list.length) continue;
        const tag = prefer === 'aura' ? '@auraenabled' : prefer === 'invocable' ? '@invocablemethod' : undefined;
        const best = (tag && list.find((x) => x.modifiers.includes(tag))) || list.find((x) => isMethodKind(x.kind)) || list[0];
        return { kind: isMethodKind(best.kind) ? 'method' : 'field', name: best.name, owner: t, member: best };
    }
    return undefined;
}
