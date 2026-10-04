/**
 * Shared Apex symbol resolution + occurrence search, used by references, rename,
 * go-to-implementation and type hierarchy.
 *
 * Resolution (`resolveAt`) turns the identifier under the cursor into one of:
 *   local   — a local variable / parameter (confined to its declaring method)
 *   field   — a field or property of a workspace type (owner = declaring type)
 *   method  — a method of a workspace type (owner = nearest declaring type)
 *   type    — a workspace class / interface / enum (top-level or inner)
 * or a rejection explaining why it isn't a workspace symbol (keyword, standard library,
 * org schema, unresolvable receiver…).
 *
 * The search (`findOccurrences`) then scans the current document (locals) or the
 * workspace (members/types): a cheap text prefilter, then each candidate file is
 * parsed (open documents: the exact `current` parse; other files: read from disk,
 * small LRU) and every case-insensitive whole-word occurrence is classified against
 * the target — receiver types (`x.name` with `x` declared as the owner or a subtype),
 * `this`/`super`, static `Type.member`, bare uses inside the owner's hierarchy,
 * shadowing locals, variable-vs-type positions, and constructor declarations.
 * Apex is case-insensitive, so matching ignores case; returned ranges are the exact
 * text spans.
 *
 * Mode `references` also keeps occurrences whose receiver can't be resolved (e.g.
 * `getFoo().name`) — inclusive, like the old text search; mode `rename` drops them so
 * a rename never edits code it can't prove refers to the symbol.
 */
import type { CancellationToken, Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ServerContext } from './context';
import { parseApex, ApexIndex, ApexMemberDecl, ApexTypeDecl, VarDecl } from './apexSymbols';
import { WorkspaceIndex, TypeGraph, TypeNode, isIgnoredPath } from './workspaceIndex';
import { blankNonCode } from '../../src/utils/apexReferences';
import { stdTypeName, stdMembersFor } from './apexStdlib';
import { stubbedObjectNames } from './sobjectStub';
import { throwIfCancelled } from './cancel';
import { baseTypeName, isApex } from './textUtil';
import { lruGet, lruSet } from './caches';

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
}

function makeModel(path: string, uri: string, text: string, index: ApexIndex): FileModel {
    const lineStarts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const typeDecls = index.typeDecls ?? [];
    return {
        path,
        uri,
        text,
        code: blankNonCode(text),
        index,
        typeDecls,
        typeScopes: new Set(typeDecls.map((t) => t.range)),
        lineStarts,
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

function pathOfUri(uri: string): string {
    if (!uri.startsWith('file:')) return uri;
    try {
        return fileURLToPath(uri);
    } catch {
        return uri;
    }
}

/** Parsed closed files (path → mtime + model), shared across requests. */
const MAX_CLOSED_MODELS = 30;
const closedModels = new Map<string, { mtime: number; model: FileModel }>();

/** Release the closed-file model cache (call on shutdown). */
export function clearSearchCaches(): void {
    closedModels.clear();
}

/**
 * Per-request state: the open documents (by fs path), the type graph (built once per
 * request), and parsed file models. Cancellation is checked on every async step.
 */
export class SearchSession {
    readonly openByPath = new Map<string, TextDocument>();
    private graphP: Promise<TypeGraph> | undefined;
    private models = new Map<string, FileModel>();

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

    /** Model of an open document (exact current parse). */
    modelForDoc(doc: TextDocument): FileModel {
        const p = pathOfUri(doc.uri);
        const hit = this.models.get(p);
        if (hit) return hit;
        const m = makeModel(p, doc.uri, doc.getText(), this.ctx.parses.current(doc).index);
        this.models.set(p, m);
        return m;
    }

    /** Model of any Apex file: the open buffer if open, else the file on disk (async read). */
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
            const m = makeModel(path, pathToFileURL(path).href, text, parseApex(text).index);
            lruSet(closedModels, path, { mtime: st.mtimeMs, model: m }, MAX_CLOSED_MODELS);
            this.models.set(path, m);
            return m;
        } catch (e) {
            this.check();
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

/** Receiver of `<recv>.name` ending just before `start` (in blanked code). */
type Receiver = { kind: 'none' } | { kind: 'ident'; name: string } | { kind: 'complex' };

function receiverAt(code: string, start: number): Receiver {
    let i = start - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== '.') return { kind: 'none' };
    i--;
    while (i >= 0 && /\s/.test(code[i])) i--;
    const end = i + 1;
    while (i >= 0 && /\w/.test(code[i])) i--;
    const name = code.slice(i + 1, end);
    if (!/^[A-Za-z_]\w*$/.test(name)) return { kind: 'complex' };
    let j = i;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (code[j] === '.') return { kind: 'complex' }; // a.b.name — chain
    return { kind: 'ident', name };
}

function followedByCall(code: string, end: number): boolean {
    return /^\s*\(/.test(code.slice(end, end + 200));
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

const SCHEMA_SUFFIX = /__(c|r|mdt|e|x|b|share|history|feed|kav|ka|changeevent)$/i;

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

/** First type in [start, ...ancestors] declaring a member `name` of the wanted kind. */
async function findMemberOwner(
    s: SearchSession,
    start: TypeNode,
    name: string,
    want: 'method' | 'field',
): Promise<{ owner: TypeNode; member: ApexMemberDecl } | undefined> {
    const g = await s.graph();
    const lc = name.toLowerCase();
    for (const t of [start, ...g.ancestors(start)]) {
        s.check();
        const m = (await s.membersOf(t)).find(
            (x) => x.name.toLowerCase() === lc && (want === 'method' ? isMethodKind(x.kind) : isFieldKind(x.kind)),
        );
        if (m) return { owner: t, member: m };
    }
    return undefined;
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
    const m = s.modelForDoc(doc);
    const offset = doc.offsetAt(pos);
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
    const call = followedByCall(m.code, end);
    const recv = receiverAt(m.code, start);
    const notWorkspace = (what?: string): Resolution => {
        if (SCHEMA_SUFFIX.test(word) || stubbedObjectNames().has(lc)) return out(undefined, `'${word}' is part of the org schema (SObject/field) and can't be renamed here.`);
        if (stdTypeName(word)) return out(undefined, `'${word}' is a standard Apex type.`);
        return out(undefined, what ?? `'${word}' is not declared in this workspace.`);
    };

    // ── Receiver-qualified: this.x / super.x / var.x / Type.x ──
    if (recv.kind === 'complex') return out(undefined, `Can't resolve the expression before '.${word}'.`);
    if (recv.kind === 'ident') {
        const r = recv.name;
        const rlc = r.toLowerCase();
        const want = call ? 'method' : 'field';
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
                    // Outer.Inner → the inner type.
                    // Outer.Inner → the inner type (unless it's a static method call of that name).
                    const inner = g.resolve(`${tn.qname}.${word}`, m.path);
                    if (inner && (!call || !(await findMemberOwner(s, tn, word, 'method')))) {
                        return out({ kind: 'type', name: inner.header.name, node: inner });
                    }
                    startNodes = [tn];
                } else if (stdTypeName(r) || stdMembersFor(r)) {
                    return out(undefined, `'${r}.${word}' is part of the Apex standard library.`);
                } else {
                    return notWorkspace(`Can't resolve '${r}' to a workspace type.`);
                }
            }
        }
        for (const n of startNodes) {
            const hit = await findMemberOwner(s, n, word, want);
            if (hit) return out({ kind: want, name: hit.member.name, owner: hit.owner, member: hit.member });
        }
        return out(undefined, `'${word}' is not declared in ${startNodes.map((n) => n.qname).join(', ')} or its workspace supertypes.`);
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
        // Constructor declaration `public Foo(…)` → the type.
        for (const t of encl) {
            const ctor = t.members.find((x) => x.kind === 'constructor' && x.nameRange.start.line === sp.line && x.nameRange.start.character === sp.character);
            if (ctor && t.name.toLowerCase() === lc) {
                const n = await nodeOf(s, m, t);
                if (n) return out({ kind: 'type', name: t.name, node: n });
            }
        }
        for (const t of encl) {
            const n = await nodeOf(s, m, t);
            if (!n) continue;
            const hit = await findMemberOwner(s, n, word, 'method');
            if (hit) return out({ kind: 'method', name: hit.member.name, owner: hit.owner, member: hit.member });
        }
        if (stdTypeName(word) || stdMembersFor(word)) return notWorkspace();
        return out(undefined, `Method '${word}' is not declared in this workspace.`);
    }
    // A type: declared in this file (inner types first), else workspace.
    const tn = g.resolve(word, m.path);
    if (tn) return out({ kind: 'type', name: tn.header.name, node: tn });
    // An inherited field used bare inside a subclass.
    for (const t of encl) {
        const n = await nodeOf(s, m, t);
        if (!n) continue;
        const hit = await findMemberOwner(s, n, word, 'field');
        if (hit) return out({ kind: 'field', name: hit.member.name, owner: hit.owner, member: hit.member });
    }
    return notWorkspace();
}

// ─── Occurrence search ──────────────────────────────────────────────────────────

export interface Occurrence {
    path: string;
    uri: string;
    range: Range;
}

export type SearchMode = 'references' | 'rename';

const MAX_SCAN_FILES = 2000;

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

/**
 * Every occurrence of the resolved symbol. Locals: the declaring document only.
 * Members/types: all workspace Apex files (open buffers preferred), capped and
 * cancellable, yielding between files.
 */
export async function findOccurrences(s: SearchSession, sym: ResolvedSymbol, mode: SearchMode): Promise<Occurrence[]> {
    if (sym.kind === 'local') return localOccurrences(sym.model, sym.decl);

    const g = await s.graph();
    const lc = sym.name.toLowerCase();
    let family: Set<TypeNode>;
    if (sym.kind === 'type') family = new Set([sym.node]);
    else if (sym.kind === 'method') family = await methodFamily(s, sym.owner, sym.name);
    else family = new Set([sym.owner, ...g.descendants(sym.owner)]);
    const familyFiles = new Set([...family].map((t) => t.file));
    const familyNames = [...new Set([...family].flatMap((t) => [t.header.name.toLowerCase(), ...(t.header.outer ? [t.header.outer.toLowerCase()] : [])]))];

    // Candidate files: every indexed file + open Apex buffers (deduped), declaring files first.
    const files: string[] = [];
    const seen = new Set<string>();
    for (const f of [...familyFiles, ...s.openByPath.keys(), ...WorkspaceIndex.allFiles()]) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)) {
            if (isIgnoredPath(f)) continue;
        }
        files.push(f);
    }

    const out: Occurrence[] = [];
    let scanned = 0;
    for (const f of files) {
        s.check();
        if (scanned++ >= MAX_SCAN_FILES) break;
        if (scanned % 10 === 0) await new Promise<void>((r) => setImmediate(r));
        const text = await s.textOf(f);
        if (text === undefined) continue;
        const tl = text.toLowerCase();
        if (!tl.includes(lc)) continue; // cheap reject
        // A member can only be reached from a file that declares a family type or names one
        // (a typed receiver / static access) — unless references mode keeps unresolved receivers.
        if (sym.kind !== 'type' && mode === 'rename' && !familyFiles.has(f) && !familyNames.some((n) => tl.includes(n))) continue;
        const m = await s.load(f);
        if (!m) continue;
        for (const r of classifyFile(m, g, sym, family, mode)) out.push({ path: m.path, uri: s.uriOf(m.path), range: r });
    }
    return out;
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
function classifyFile(m: FileModel, g: TypeGraph, sym: Exclude<ResolvedSymbol, { kind: 'local' }>, family: Set<TypeNode>, mode: SearchMode): Range[] {
    const out: Range[] = [];
    const nodeFor = (t: ApexTypeDecl | undefined) => (t ? g.find(m.path, qnameOf(t)) : undefined);
    const inFamily = (n: TypeNode | undefined) => !!n && family.has(n);
    /** Does a receiver identifier denote a family type (typed variable / static type)? undefined = unresolved. */
    const receiverInFamily = (r: string, line: number, ch: number): boolean | undefined => {
        const rlc = r.toLowerCase();
        const encl = enclosingTypes(m, line, ch);
        if (rlc === 'this') return inFamily(nodeFor(encl[0]));
        if (rlc === 'super') {
            const n = nodeFor(encl[0]);
            return !!n && g.supertypes(n).some((x) => family.has(x));
        }
        const v = varAt(m, r, line, ch);
        if (v) {
            const tn = g.resolve(baseTypeName(v.type), m.path);
            return tn ? family.has(tn) : false;
        }
        const tn = g.resolve(r, m.path);
        if (tn) return family.has(tn);
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
                hit = !!node.header.outer && recv.name.toLowerCase() === node.header.outer.toLowerCase();
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
                                t.name.toLowerCase() === sym.name.toLowerCase() &&
                                t.members.some((x) => x.kind === 'constructor' && x.nameRange.start.line === p.line && x.nameRange.start.character === p.character),
                        );
                    } else {
                        // Not a same-named member declaration (method/field names never collide with type refs here).
                        hit = !m.typeDecls.some((t) =>
                            t.members.some((x) => x.kind !== 'constructor' && x.nameRange.start.line === p.line && x.nameRange.start.character === p.character),
                        );
                    }
                }
            }
        } else if (sym.kind === 'method') {
            if (!call || isNew) hit = false;
            else if (recv.kind === 'complex') hit = mode === 'references';
            else if (recv.kind === 'ident') {
                const r = receiverInFamily(recv.name, p.line, p.character);
                hit = r === undefined ? mode === 'references' : r;
            } else {
                // Bare call / declaration: inside a family type (innermost→outer: inner classes may call outer statics).
                hit = enclosingTypes(m, p.line, p.character).some((t) => inFamily(nodeFor(t)));
            }
        } else {
            // field / property
            if (call) hit = false;
            else if (recv.kind === 'complex') hit = mode === 'references';
            else if (recv.kind === 'ident') {
                const r = receiverInFamily(recv.name, p.line, p.character);
                hit = r === undefined ? mode === 'references' : r;
            } else if (isTypePosition(m.code, w.start, w.end)) {
                hit = false;
            } else {
                const v = varAt(m, sym.name, p.line, p.character);
                if (v) {
                    if (!isFieldDecl(m, v)) hit = false; // shadowed by a local/param
                    else {
                        const owner = nodeFor(m.typeDecls.find((t) => t.range === v.scope));
                        hit = owner === sym.owner;
                    }
                } else {
                    // Inherited field used bare inside a subclass.
                    const n = nodeFor(enclosingTypes(m, p.line, p.character)[0]);
                    hit = !!n && n !== sym.owner && family.has(n);
                }
            }
        }
        if (hit) out.push(toRange(m, w.start, w.end));
    }
    return out;
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

export function sameRange(a: Range, b: Range): boolean {
    return a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;
}
