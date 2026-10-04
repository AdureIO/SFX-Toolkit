/**
 * Cross-file Apex type lookup for go-to-definition. Apex requires a top-level
 * class/interface/enum to live in a file named `<TypeName>.cls` (or `.trigger`),
 * so we resolve a type to its file **by filename** — a cheap directory walk that
 * records basename→path, with NO parsing. Only the single target file is parsed
 * (lazily, cached) to find the declaration's exact line. This avoids parsing the
 * whole workspace, which was the main memory/CPU cost.
 *
 * The walk is asynchronous (fs.promises, yielding to the event loop) so a large
 * project never blocks the server, and the index is kept current by file-watcher
 * events (`applyFileChange`) plus open/save of documents (`updateFromDoc`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { Location, Range, SymbolKind, DocumentSymbol } from 'vscode-languageserver/node';
import { parseApex, ApexMember, ApexTypeDecl } from './apexSymbols';
import { blankNonCode } from '../../src/utils/apexReferences';
import { throwIfCancelled } from './cancel';

// Generated / tooling dirs never contain user Apex. `.sfdx`/`.sf` hold thousands of
// SObject schema stubs (`.sfdx/tools/sobjects/**/*.cls`) that must never be treated
// as workspace classes (that would e.g. suppress schema validation for `Account`).
const IGNORE_DIRS = new Set(['node_modules', '.git', '.sfdx', '.sf', '.vscode', 'out', 'dist']);
const MAX_FILES = 20000; // basename→path entries are tiny; cap only as a backstop
const MAX_MEMBER_CACHE = 100; // parsed member lists kept for cross-file completion (LRU; ~70 KB for a 3000-line class)
const YIELD_EVERY = 200; // directory entries between event-loop yields during the scan

const APEX_FILE = /^(.*)\.(cls|trigger)$/i;

/** True when a path lies inside a generated/tooling directory we never index. */
export function isIgnoredPath(file: string): boolean {
    for (const seg of file.split(/[\\/]/)) if (IGNORE_DIRS.has(seg)) return true;
    return false;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class WorkspaceIndexImpl {
    private roots: string[] = [];
    /** lower-cased type name → file paths (usually one; duplicates across packages are possible). */
    private files = new Map<string, string[]>();
    private names = new Map<string, string>(); // lower-cased → original-cased type name
    private memberCache = new Map<string, { mtime: number; members: ApexMember[] | undefined }>();
    /**
     * Per-file type headers (name, kind, extends/implements, ranges) for the type hierarchy.
     * Filled lazily (cheap regex over the file text, or from a parse done for members) and
     * dropped on any change event for the file — at most one small entry per indexed file.
     */
    private headerCache = new Map<string, TypeHeader[]>();
    private scanned = false;
    private scanning: Promise<void> | undefined;
    /** Bumped on setRoots/dispose so an in-flight scan from an old root set is discarded. */
    private generation = 0;

    setRoots(roots: string[]): void {
        this.roots = roots;
        this.clear();
    }

    /** Drop everything (roots kept) — used on shutdown and when re-rooting. */
    clear(): void {
        this.generation++;
        this.files.clear();
        this.names.clear();
        this.memberCache.clear();
        this.headerCache.clear();
        this.scanned = false;
        this.scanning = undefined;
    }

    /** Start (once) the background scan; resolves when the index is populated. */
    ready(): Promise<void> {
        if (this.scanned) return Promise.resolve();
        if (!this.scanning) {
            const gen = this.generation;
            this.scanning = this.scan(gen).then(
                () => {
                    if (gen === this.generation) this.scanned = true;
                },
                () => {
                    if (gen === this.generation) this.scanned = true;
                },
            );
        }
        return this.scanning;
    }

    private addFile(file: string): void {
        const m = APEX_FILE.exec(path.basename(file));
        if (!m) return;
        const key = m[1].toLowerCase();
        const list = this.files.get(key);
        if (!list) this.files.set(key, [file]);
        else if (!list.includes(file)) list.push(file);
        this.names.set(key, m[1]);
    }

    private removeFile(file: string): void {
        this.memberCache.delete(file);
        this.headerCache.delete(file);
        const m = APEX_FILE.exec(path.basename(file));
        if (!m) return;
        const key = m[1].toLowerCase();
        const list = this.files.get(key);
        if (!list) return;
        const rest = list.filter((f) => f !== file);
        if (rest.length) {
            this.files.set(key, rest);
        } else {
            this.files.delete(key);
            this.names.delete(key);
        }
    }

    /** Record an open/saved document's type→path mapping (no parse). */
    updateFromDoc(uri: string): void {
        if (!uri.startsWith('file:')) return;
        try {
            const file = fileURLToPath(uri);
            if (!APEX_FILE.test(file) || isIgnoredPath(file)) return;
            this.addFile(file);
            this.memberCache.delete(file); // contents may have changed (save)
            this.headerCache.delete(file);
        } catch {
            /* ignore */
        }
    }

    /** Apply a file-watcher event (created/changed/deleted). */
    applyFileChange(uri: string, kind: 'created' | 'changed' | 'deleted'): void {
        if (!uri.startsWith('file:')) return;
        let file: string;
        try {
            file = fileURLToPath(uri);
        } catch {
            return;
        }
        if (!APEX_FILE.test(file) || isIgnoredPath(file)) return;
        if (kind === 'deleted') this.removeFile(file);
        else {
            this.addFile(file);
            this.memberCache.delete(file);
            this.headerCache.delete(file);
        }
    }

    /** Every indexed Apex file path — used for workspace-wide reference search. */
    allFiles(): string[] {
        void this.ready();
        const out: string[] = [];
        for (const list of this.files.values()) out.push(...list);
        return out;
    }

    /** All known top-level Apex type (class/trigger) names, original-cased. */
    allTypeNames(): string[] {
        void this.ready();
        return [...this.names.values()];
    }

    /**
     * Cheap check (filename scan only, no parse) whether a name is a workspace Apex type.
     * Before the initial scan finishes this only knows open/saved documents; callers that
     * need a definitive answer should `await ready()` first.
     */
    hasType(name: string): boolean {
        void this.ready();
        return this.files.has(name.toLowerCase());
    }

    /** The file declaring a workspace type (filename lookup only). */
    fileFor(name: string): string | undefined {
        void this.ready();
        return this.files.get(name.toLowerCase())?.[0];
    }

    /**
     * Members (methods/fields/properties) of a workspace type, for cross-file
     * member completion (`MyClass.` or `instanceOfMyClass.`). Parses only the one
     * file, cached by path+mtime (LRU-bounded) so repeated completions don't re-parse.
     */
    findTypeMembers(name: string): ApexMember[] | undefined {
        const file = this.fileFor(name);
        if (!file) return undefined;
        try {
            const mtime = fs.statSync(file).mtimeMs;
            const cached = this.memberCache.get(file);
            if (cached && cached.mtime === mtime) {
                // Refresh LRU position.
                this.memberCache.delete(file);
                this.memberCache.set(file, cached);
                return cached.members;
            }
            const index = parseApex(fs.readFileSync(file, 'utf8')).index;
            // The parse also gives this file's type headers for free (hierarchy).
            if (index.typeDecls) this.headerCache.set(file, headersFromDecls(index.typeDecls));
            // Match the top-level type by name (case-insensitive).
            let members: ApexMember[] | undefined;
            for (const [typeName, ms] of index.types) {
                if (typeName.toLowerCase() === name.toLowerCase()) {
                    members = ms;
                    break;
                }
            }
            this.memberCache.delete(file);
            this.memberCache.set(file, { mtime, members });
            while (this.memberCache.size > MAX_MEMBER_CACHE) {
                const oldest = this.memberCache.keys().next().value;
                if (oldest === undefined) break;
                this.memberCache.delete(oldest);
            }
            return members;
        } catch {
            return undefined;
        }
    }

    /** Location of a type's declaration — parses only that one file to land on the name. */
    findType(name: string): Location | undefined {
        const file = this.fileFor(name);
        if (!file) return undefined;
        return { uri: pathToFileURL(file).href, range: declarationRange(file, name) };
    }

    /**
     * The workspace type hierarchy (extends/implements of every class/interface/enum).
     * Disk files use cached headers (regex extraction, no parse; recomputed only after a
     * change event); `openTexts` (fs path → current buffer text) overrides disk content for
     * open documents and may add open files outside the index. Async, yields while reading.
     */
    async typeGraph(
        openTexts: Map<string, string> = new Map(),
        token?: { isCancellationRequested: boolean },
    ): Promise<TypeGraph> {
        await this.ready();
        throwIfCancelled(token as any);
        const entries: [string, TypeHeader[]][] = [];
        const seen = new Set<string>();
        let n = 0;
        for (const file of [...this.allFiles(), ...openTexts.keys()]) {
            if (seen.has(file)) continue;
            seen.add(file);
            if (!APEX_FILE.test(file) || isIgnoredPath(file)) continue;
            const open = openTexts.get(file);
            if (open !== undefined) {
                entries.push([file, extractTypeHeaders(open)]);
                continue;
            }
            let headers = this.headerCache.get(file);
            if (!headers) {
                if (++n % 25 === 0) {
                    await yieldToLoop();
                    throwIfCancelled(token as any);
                }
                try {
                    headers = extractTypeHeaders(await fs.promises.readFile(file, 'utf8'));
                } catch {
                    headers = [];
                }
                this.headerCache.set(file, headers);
            }
            entries.push([file, headers]);
        }
        return new TypeGraph(entries);
    }

    private async scan(gen: number): Promise<void> {
        let count = 0;
        let steps = 0;
        const walk = async (dir: string): Promise<void> => {
            if (count >= MAX_FILES || gen !== this.generation) return;
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (count >= MAX_FILES || gen !== this.generation) return;
                if (++steps % YIELD_EVERY === 0) await yieldToLoop();
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (!IGNORE_DIRS.has(e.name)) await walk(full);
                } else if (APEX_FILE.test(e.name)) {
                    this.addFile(full);
                    count++;
                }
            }
        };
        for (const root of this.roots) {
            try {
                await walk(fileURLToPath(root.startsWith('file:') ? root : pathToFileURL(root).href));
            } catch {
                /* ignore bad root */
            }
        }
    }
}

/** The declaration's name range in `file` (falls back to the file start). */
export function declarationRange(file: string, name: string): Range {
    try {
        const found = findTypeRange(parseApex(fs.readFileSync(file, 'utf8')).symbols, name);
        if (found) return found;
    } catch {
        /* fall back to file start */
    }
    return Range.create(0, 0, 0, 0);
}

function findTypeRange(syms: DocumentSymbol[], name: string): Range | undefined {
    for (const s of syms) {
        if (
            (s.kind === SymbolKind.Class || s.kind === SymbolKind.Interface || s.kind === SymbolKind.Enum) &&
            s.name.toLowerCase() === name.toLowerCase()
        ) {
            return s.selectionRange;
        }
        if (s.children) {
            const inner = findTypeRange(s.children, name);
            if (inner) return inner;
        }
    }
    return undefined;
}

export const WorkspaceIndex = new WorkspaceIndexImpl();

// ─── Type hierarchy ─────────────────────────────────────────────────────────────

/** Header of a type declaration: just what the hierarchy needs (no members). */
export interface TypeHeader {
    name: string;
    kind: 'class' | 'interface' | 'enum';
    /** Enclosing type name for inner types. */
    outer?: string;
    /** Lower-cased modifiers (`abstract`, `virtual`, `public`…). */
    modifiers: string[];
    /** Class `extends` target (generics stripped). */
    extendsType?: string;
    /** Class `implements` / interface `extends` targets (generics stripped). */
    implementsTypes: string[];
    nameRange: Range;
    range: Range;
}

/** Headers from a parse (triggers have no hierarchy and are skipped). */
export function headersFromDecls(decls: ApexTypeDecl[]): TypeHeader[] {
    const out: TypeHeader[] = [];
    for (const d of decls) {
        if (d.kind === 'trigger') continue;
        const h: TypeHeader = {
            name: d.name,
            kind: d.kind,
            modifiers: d.modifiers.filter((m) => !m.startsWith('@')),
            implementsTypes: d.implementsTypes,
            nameRange: d.nameRange,
            range: d.range,
        };
        if (d.outer) h.outer = d.outer;
        if (d.extendsType) h.extendsType = d.extendsType;
        out.push(h);
    }
    return out;
}

const TYPE_HEADER = /(?<![\w.])(class|interface|enum)\s+([A-Za-z_]\w*)\s*([^{;()]*)\{/gi;
const MODIFIER_WORDS = new Set([
    'public', 'private', 'protected', 'global', 'abstract', 'virtual', 'static', 'final',
    'with', 'without', 'inherited', 'sharing', 'transient', 'testmethod', 'webservice',
]);

/** Split `A, B<X, Y>, C` at top-level commas and strip generics/arrays. */
function splitTypeList(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
        if (c === '<') depth++;
        else if (c === '>') depth--;
        if (c === ',' && depth === 0) {
            out.push(cur);
            cur = '';
        } else cur += c;
    }
    out.push(cur);
    return out
        .map((t) => t.replace(/<[\s\S]*$/, '').replace(/\[\s*\]$/, '').replace(/\s+/g, ''))
        .filter((t) => /^[A-Za-z_][\w.]*$/.test(t));
}

/**
 * Type headers by a cheap scan (no parse): `class|interface|enum Name [extends …] [implements …] {`
 * over the text with comments/strings blanked, brace-matched for the body range and nesting.
 */
export function extractTypeHeaders(text: string): TypeHeader[] {
    const code = blankNonCode(text);
    const lineStarts = [0];
    for (let i = code.indexOf('\n'); i !== -1; i = code.indexOf('\n', i + 1)) lineStarts.push(i + 1);
    const pos = (o: number) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= o) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo, character: o - lineStarts[lo] };
    };
    const out: TypeHeader[] = [];
    const open: { name: string; end: number }[] = [];
    TYPE_HEADER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TYPE_HEADER.exec(code)) !== null) {
        const kind = m[1].toLowerCase() as TypeHeader['kind'];
        const clause = m[3].trim();
        if (clause && (kind === 'enum' || !/^(extends|implements)\b/i.test(clause))) continue;
        const brace = m.index + m[0].length - 1;
        // Body end by brace matching.
        let depth = 0;
        let end = code.length;
        for (let i = brace; i < code.length; i++) {
            const c = code[i];
            if (c === '{') depth++;
            else if (c === '}' && --depth === 0) {
                end = i + 1;
                break;
            }
        }
        // Modifiers: the words between the previous statement boundary and `class`.
        let b = m.index;
        while (b > 0 && !/[;{}]/.test(code[b - 1])) b--;
        const modifiers = code
            .slice(b, m.index)
            .replace(/@\w+(\s*\([^)]*\))?/g, ' ')
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => MODIFIER_WORDS.has(w));
        let extendsType: string | undefined;
        const implementsTypes: string[] = [];
        const ext = /\bextends\s+([\s\S]*?)(?=\bimplements\b|$)/i.exec(clause);
        const imp = /\bimplements\s+([\s\S]*?)(?=\bextends\b|$)/i.exec(clause);
        if (ext) {
            const list = splitTypeList(ext[1]);
            if (kind === 'interface') implementsTypes.push(...list);
            else extendsType = list[0];
        }
        if (imp) implementsTypes.push(...splitTypeList(imp[1]));
        while (open.length && open[open.length - 1].end <= m.index) open.pop();
        const nameStart = m.index + m[0].indexOf(m[2], m[1].length);
        const h: TypeHeader = {
            name: m[2],
            kind,
            modifiers,
            implementsTypes,
            nameRange: { start: pos(nameStart), end: pos(nameStart + m[2].length) },
            range: { start: pos(b + (code.slice(b, m.index).length - code.slice(b, m.index).trimStart().length)), end: pos(end) },
        };
        if (open.length) h.outer = open[open.length - 1].name;
        if (extendsType) h.extendsType = extendsType;
        out.push(h);
        open.push({ name: m[2], end });
    }
    return out;
}

/** A type in the workspace hierarchy. */
export interface TypeNode {
    /** fs path of the declaring file. */
    file: string;
    header: TypeHeader;
    /** `Name` or `Outer.Name`. */
    qname: string;
}

/**
 * Immutable snapshot of the workspace type hierarchy, built per request from the cached
 * headers. Supertype references resolve like Apex does: an unqualified name is an inner
 * type of the same file first, then a top-level type; `Outer.Inner` is an inner type of
 * top-level `Outer`. References to non-workspace types (e.g. `Database.Batchable`) are
 * simply not edges.
 */
export class TypeGraph {
    readonly nodes: TypeNode[] = [];
    private top = new Map<string, TypeNode[]>();
    private inner = new Map<string, Map<string, TypeNode>>();
    private subs = new Map<TypeNode, TypeNode[]>();
    private supers = new Map<TypeNode, TypeNode[]>();

    constructor(entries: [string, TypeHeader[]][]) {
        for (const [file, headers] of entries) {
            for (const h of headers) {
                const node: TypeNode = { file, header: h, qname: h.outer ? `${h.outer}.${h.name}` : h.name };
                this.nodes.push(node);
                const lc = h.name.toLowerCase();
                if (h.outer) {
                    let m = this.inner.get(file);
                    if (!m) this.inner.set(file, (m = new Map()));
                    if (!m.has(lc)) m.set(lc, node);
                } else {
                    const list = this.top.get(lc);
                    if (list) list.push(node);
                    else this.top.set(lc, [node]);
                }
            }
        }
        for (const n of this.nodes) {
            const refs = [...(n.header.extendsType ? [n.header.extendsType] : []), ...n.header.implementsTypes];
            const sup: TypeNode[] = [];
            for (const r of refs) {
                const t = this.resolve(r, n.file);
                if (!t || t === n || sup.includes(t)) continue;
                sup.push(t);
                const list = this.subs.get(t);
                if (list) list.push(n);
                else this.subs.set(t, [n]);
            }
            this.supers.set(n, sup);
        }
    }

    /** Resolve a type reference as written in `fromFile` (case-insensitive). */
    resolve(ref: string, fromFile?: string): TypeNode | undefined {
        const segs = ref.replace(/<[\s\S]*$/, '').split('.').map((x) => x.trim().toLowerCase());
        if (segs.length === 1) {
            if (fromFile) {
                const local = this.inner.get(fromFile)?.get(segs[0]);
                if (local) return local;
            }
            const tops = this.top.get(segs[0]);
            if (!tops) return undefined;
            return tops.find((t) => t.file === fromFile) ?? tops[0];
        }
        if (segs.length === 2) {
            const outer = this.top.get(segs[0])?.[0];
            if (outer) return this.inner.get(outer.file)?.get(segs[1]);
        }
        return undefined;
    }

    /** The node for `qname` (`Name` / `Outer.Name`) declared in `file`. */
    find(file: string, qname: string): TypeNode | undefined {
        const lc = qname.toLowerCase();
        return this.nodes.find((n) => n.file === file && n.qname.toLowerCase() === lc);
    }

    supertypes(n: TypeNode): TypeNode[] {
        return this.supers.get(n) ?? [];
    }

    subtypes(n: TypeNode): TypeNode[] {
        return this.subs.get(n) ?? [];
    }

    /** All transitive subtypes (cycle-safe, breadth-first). */
    descendants(n: TypeNode): TypeNode[] {
        return this.walk(n, (x) => this.subtypes(x));
    }

    /** All transitive supertypes in the workspace (cycle-safe, nearest first). */
    ancestors(n: TypeNode): TypeNode[] {
        return this.walk(n, (x) => this.supertypes(x));
    }

    private walk(n: TypeNode, next: (x: TypeNode) => TypeNode[]): TypeNode[] {
        const seen = new Set<TypeNode>([n]);
        const out: TypeNode[] = [];
        const queue = [n];
        while (queue.length) {
            const cur = queue.shift()!;
            for (const s of next(cur)) {
                if (seen.has(s)) continue;
                seen.add(s);
                out.push(s);
                queue.push(s);
            }
        }
        return out;
    }
}
