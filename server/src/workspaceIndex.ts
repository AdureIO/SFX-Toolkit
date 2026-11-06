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
import { parseApex, ApexMember, ApexTypeDecl, ApexIndex } from './apexSymbols';
import { blankNonCode } from '../../src/utils/apexReferences';
import { throwIfCancelled } from './cancel';
import { ParseWorker } from './parseWorkerClient';
import { metadataKindOf } from '../../src/utils/sfMetadataRefs';

/** The type index of one Apex file: members per type (simple name) + type declarations. */
export interface FileTypes {
    file: string;
    types: Map<string, ApexMember[]>;
    decls: ApexTypeDecl[];
}

/** A watched-file / save event for an indexed Apex or metadata file (`reset` = whole index dropped). */
export type FileChangeListener = (file: string, kind: 'created' | 'changed' | 'deleted' | 'reset') => void;

/** Supplies the latest parse index of an OPEN document for an fs path (unsaved buffer wins over disk). */
export type OpenDocIndexProvider = (file: string) => Pick<ApexIndex, 'types' | 'typeDecls'> | undefined;

// Generated / tooling dirs never contain user Apex. `.sfdx`/`.sf` hold thousands of
// SObject schema stubs (`.sfdx/tools/sobjects/**/*.cls`) that must never be treated
// as workspace classes (that would e.g. suppress schema validation for `Account`).
const IGNORE_DIRS = new Set(['node_modules', '.git', '.sfdx', '.sf', '.vscode', 'out', 'dist']);
const MAX_FILES = 20000; // basename→path entries are tiny; cap only as a backstop
const MAX_MEMBER_CACHE = 100; // parsed member lists kept for cross-file completion (LRU; ~70 KB for a 3000-line class)
const MAX_HEADER_CACHE = 5000; // type headers kept for the hierarchy (LRU; a few hundred bytes each)
const QUICK_SCAN_AFTER_MS = 25; // wait this long for the exact (worker) parse before answering from the cheap scan
const MAX_PREWARM = 64; // cross-file types pre-loaded per landed parse of an open document
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
    private memberCache = new Map<string, { mtime: number; ft: FileTypes }>();
    /** In-flight off-thread parses of workspace files (deduped). */
    private memberInflight = new Map<string, Promise<FileTypes | undefined>>();
    /** Cheap-scan results served until the exact parse of the file lands. */
    private quickCache = new Map<string, { mtime: number; ft: FileTypes }>();
    /** Open documents' paths that are NOT indexed permanently (outside the roots / not on disk), removed on close. */
    private docOnly = new Set<string>();
    private openDocIndex: OpenDocIndexProvider = () => undefined;
    /** Salesforce metadata files that can refer to Apex by name (LWC / Aura JS + markup, VF, Flows). */
    private meta = new Set<string>();
    private listeners: FileChangeListener[] = [];
    /**
     * Per-file type headers (name, kind, extends/implements, ranges) for the type hierarchy.
     * Filled lazily (cheap regex over the file text, or from a parse done for members) and
     * dropped on any change event for the file — at most one small entry per indexed file.
     */
    private headerCache = new Map<string, TypeHeader[]>();
    private headerScans = new Set<string>();
    private scanned = false;
    private scanning: Promise<void> | undefined;
    /** Bumped on setRoots/dispose so an in-flight scan from an old root set is discarded. */
    private generation = 0;

    setRoots(roots: string[]): void {
        this.roots = roots;
        this.clear();
    }

    /** Be told about every create/change/delete/save of an indexed Apex or metadata file. */
    onFileChange(fn: FileChangeListener): void {
        this.listeners.push(fn);
    }

    private notify(file: string, kind: 'created' | 'changed' | 'deleted' | 'reset'): void {
        for (const fn of this.listeners) {
            try {
                fn(file, kind);
            } catch {
                /* a listener failure must not break indexing */
            }
        }
    }

    /** Let lookups prefer an open document's (possibly unsaved) parse over the file on disk. */
    setOpenDocProvider(fn: OpenDocIndexProvider): void {
        this.openDocIndex = fn;
    }

    private rootPaths(): string[] {
        const out: string[] = [];
        for (const r of this.roots) {
            try {
                out.push(path.resolve(fileURLToPath(r.startsWith('file:') ? r : pathToFileURL(r).href)));
            } catch {
                /* ignore bad root */
            }
        }
        return out;
    }

    private underRoots(file: string): boolean {
        const f = path.resolve(file);
        return this.rootPaths().some((r) => f === r || f.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    }

    /** Drop everything (roots kept) — used on shutdown and when re-rooting. */
    clear(): void {
        this.generation++;
        this.files.clear();
        this.names.clear();
        this.memberCache.clear();
        this.memberInflight.clear();
        this.quickCache.clear();
        this.headerCache.clear();
        this.docOnly.clear();
        this.meta.clear();
        this.scanned = false;
        this.scanning = undefined;
        this.notify('', 'reset');
    }

    /** Whether the initial workspace scan has finished (filename lookups are definitive). */
    get scanComplete(): boolean {
        return this.scanned;
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

    /**
     * Record an open/saved document's type→path mapping (no parse). Files under the
     * workspace roots that exist on disk are indexed for good; anything else (another
     * project's file, an unsaved/virtual path) is tracked only while open — `closeDoc`
     * removes it again, so opening stray files never grows the index forever.
     */
    updateFromDoc(uri: string): void {
        if (!uri.startsWith('file:')) return;
        try {
            const file = fileURLToPath(uri);
            if (!APEX_FILE.test(file) || isIgnoredPath(file)) return;
            const permanent = this.underRoots(file) && fs.existsSync(file);
            if (permanent) this.docOnly.delete(file);
            else if (!this.isIndexed(file)) this.docOnly.add(file);
            this.addFile(file);
            this.memberCache.delete(file); // contents may have changed (save)
            this.headerCache.delete(file);
            if (permanent) this.notify(file, 'changed');
        } catch {
            /* ignore */
        }
    }

    /** A document closed: forget it if it was only indexed because it was open. */
    closeDoc(uri: string): void {
        if (!uri.startsWith('file:')) return;
        let file: string;
        try {
            file = fileURLToPath(uri);
        } catch {
            return;
        }
        this.memberCache.delete(file); // the buffer may have differed from disk
        if (this.docOnly.delete(file)) this.removeFile(file);
    }

    private isIndexed(file: string): boolean {
        const m = APEX_FILE.exec(path.basename(file));
        return !!m && !!this.files.get(m[1].toLowerCase())?.includes(file);
    }

    /** Number of indexed files (diagnostics / tests). */
    get size(): number {
        let n = 0;
        for (const l of this.files.values()) n += l.length;
        return n;
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
        if (isIgnoredPath(file)) return;
        if (!APEX_FILE.test(file)) {
            if (!metadataKindOf(file)) return;
            if (kind === 'deleted') this.meta.delete(file);
            else this.meta.add(file);
            this.notify(file, kind);
            return;
        }
        if (kind === 'deleted') this.removeFile(file);
        else {
            this.addFile(file);
            this.memberCache.delete(file);
            this.headerCache.delete(file);
        }
        this.notify(file, kind);
    }

    /** Every indexed Salesforce metadata file that may refer to Apex by name. */
    metadataFiles(): string[] {
        void this.ready();
        return [...this.meta];
    }

    /** Cache a file's type headers from text already read elsewhere (no-op when cached). */
    primeHeaders(file: string, text: string): void {
        if (!this.headerCache.has(file)) this.setHeaders(file, extractTypeHeaders(text));
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
     * member completion (`MyClass.` or `instanceOfMyClass.`). Synchronous (kept for
     * existing callers): serves an open buffer's parse or the cache, and only parses the
     * file on the calling thread on a cache miss. Completion uses `typeFile` instead.
     */
    findTypeMembers(name: string): ApexMember[] | undefined {
        const file = this.fileFor(name);
        if (!file) return undefined;
        let ft = this.cachedFile(file);
        if (!ft) {
            try {
                const mtime = fs.statSync(file).mtimeMs;
                const index = parseApex(fs.readFileSync(file, 'utf8')).index;
                ft = this.store(file, mtime, index);
            } catch {
                return undefined;
            }
        }
        return membersNamed(ft, name);
    }

    /**
     * The type index of the file declaring workspace type `name` (top-level name, as the
     * file is named). An open document's current buffer wins over disk; disk files are
     * cached by path+mtime (LRU) and parsed OFF the request thread (parse worker).
     */
    typeFile(name: string): Promise<FileTypes | undefined> {
        const file = this.fileFor(name);
        if (!file) return Promise.resolve(undefined);
        return this.typeFileAt(file);
    }

    /**
     * Whether `new Name()` can work for workspace type `name` (a non-abstract class), from
     * what is already known (open buffer / parse cache / type headers); `undefined` when
     * not known yet — the file's headers are then scanned in the background (regex, no
     * parse) so later requests can tell.
     */
    constructableHint(name: string): boolean | undefined {
        const file = this.fileFor(name);
        if (!file) return undefined;
        const ln = name.toLowerCase();
        const fromDecl = (d: { kind: string; modifiers: string[] } | undefined) =>
            d ? d.kind === 'class' && !d.modifiers.includes('abstract') : undefined;
        const ft = this.cachedFile(file);
        const decl = fromDecl(ft?.decls.find((d) => !d.outer && d.name.toLowerCase() === ln));
        if (decl !== undefined) return decl;
        const headers = this.headerCache.get(file);
        const header = fromDecl(headers?.find((h) => !h.outer && h.name.toLowerCase() === ln));
        if (header !== undefined) return header;
        if (!headers && !this.headerScans.has(file)) {
            this.headerScans.add(file);
            fs.promises
                .readFile(file, 'utf8')
                .then((text) => this.setHeaders(file, extractTypeHeaders(text)))
                .catch(() => undefined)
                .finally(() => this.headerScans.delete(file));
        }
        return undefined;
    }

    /** Like `typeFile`, but only what's available without parsing (open buffer / cache). */
    cachedTypeFile(name: string): FileTypes | undefined {
        const file = this.fileFor(name);
        return file ? this.cachedFile(file) : undefined;
    }

    typeFileAt(file: string): Promise<FileTypes | undefined> {
        const hit = this.cachedFile(file);
        if (hit) return Promise.resolve(hit);
        const exact = this.parseOffThread(file);
        const q = this.quickCache.get(file);
        if (q) {
            try {
                if (fs.statSync(file).mtimeMs === q.mtime) return Promise.resolve(q.ft);
            } catch {
                /* fall through */
            }
        }
        // The exact parse usually lands within a few ms; for big files answer from the
        // cheap scan instead of waiting (the exact parse replaces it when it lands).
        let timer: ReturnType<typeof setTimeout> | undefined;
        const quick = new Promise<FileTypes | undefined>((resolve) => {
            timer = setTimeout(() => resolve(this.quickFile(file)), QUICK_SCAN_AFTER_MS);
        });
        return Promise.race([exact.then((r) => r ?? this.quickFile(file)), quick]).finally(() => clearTimeout(timer));
    }

    /** Cheap-scan type index of a file (cached by mtime until the exact parse lands). */
    private async quickFile(file: string): Promise<FileTypes | undefined> {
        const cached = this.cachedFile(file);
        if (cached) return cached;
        try {
            const [st, text] = await Promise.all([fs.promises.stat(file), fs.promises.readFile(file, 'utf8')]);
            const q = this.quickCache.get(file);
            if (q && q.mtime === st.mtimeMs) return q.ft;
            const ix = quickTypeIndex(text);
            const ft: FileTypes = { file, types: ix.types, decls: ix.typeDecls ?? [] };
            this.quickCache.set(file, { mtime: st.mtimeMs, ft });
            while (this.quickCache.size > MAX_MEMBER_CACHE) this.quickCache.delete(this.quickCache.keys().next().value as string);
            return ft;
        } catch {
            return undefined;
        }
    }

    private parseOffThread(file: string): Promise<FileTypes | undefined> {
        let p = this.memberInflight.get(file);
        if (!p) {
            const gen = this.generation;
            const started: Promise<FileTypes | undefined> = ParseWorker.parseFileLite(file).then((r) => {
                if (this.memberInflight.get(file) === started) this.memberInflight.delete(file);
                if (!r || gen !== this.generation) return undefined;
                this.quickCache.delete(file);
                return this.store(file, r.mtime, r.result.index);
            });
            p = started;
            this.memberInflight.set(file, p);
        }
        return p;
    }

    /**
     * Pre-load the type files of workspace types an open document references (and their
     * supertypes), so the first `x.` on a cross-file type needs no parse at all.
     */
    prewarm(names: Iterable<string>): void {
        const seen = new Set<string>();
        const queue: string[] = [];
        for (const n of names) {
            const lc = n.toLowerCase();
            if (seen.has(lc) || !this.files.has(lc)) continue;
            seen.add(lc);
            queue.push(n);
            if (queue.length >= MAX_PREWARM) break;
        }
        const load = (n: string, depth: number): void => {
            void this.typeFile(n).then((ft) => {
                if (!ft || depth >= 4) return;
                for (const d of ft.decls) {
                    for (const sup of [d.extendsType, ...d.implementsTypes]) {
                        if (!sup) continue;
                        const top = sup.split('.')[0];
                        const lc = top.toLowerCase();
                        if (seen.has(lc) || !this.files.has(lc) || seen.size >= MAX_PREWARM) continue;
                        seen.add(lc);
                        load(top, depth + 1);
                    }
                }
            });
        };
        for (const n of queue) load(n, 0);
    }

    private cachedFile(file: string): FileTypes | undefined {
        const open = this.openDocIndex(file);
        if (open) return { file, types: open.types, decls: open.typeDecls ?? [] };
        const cached = this.memberCache.get(file);
        if (!cached) return undefined;
        try {
            if (fs.statSync(file).mtimeMs !== cached.mtime) {
                this.memberCache.delete(file);
                return undefined;
            }
        } catch {
            this.memberCache.delete(file);
            return undefined;
        }
        // Refresh LRU position.
        this.memberCache.delete(file);
        this.memberCache.set(file, cached);
        return cached.ft;
    }

    private store(file: string, mtime: number, index: Pick<ApexIndex, 'types' | 'typeDecls'>): FileTypes {
        const ft: FileTypes = { file, types: index.types, decls: index.typeDecls ?? [] };
        // The parse also gives this file's type headers for free (hierarchy).
        if (index.typeDecls) this.setHeaders(file, headersFromDecls(index.typeDecls));
        this.memberCache.delete(file);
        this.memberCache.set(file, { mtime, ft });
        while (this.memberCache.size > MAX_MEMBER_CACHE) {
            const oldest = this.memberCache.keys().next().value;
            if (oldest === undefined) break;
            this.memberCache.delete(oldest);
        }
        return ft;
    }

    private setHeaders(file: string, headers: TypeHeader[]): void {
        this.headerCache.delete(file);
        this.headerCache.set(file, headers);
        while (this.headerCache.size > MAX_HEADER_CACHE) {
            const oldest = this.headerCache.keys().next().value;
            if (oldest === undefined) break;
            this.headerCache.delete(oldest);
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
                this.setHeaders(file, headers);
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
                } else if (metadataKindOf(full)) {
                    this.meta.add(full);
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

/** Members of the type named `name` (case-insensitive) in a file's index. */
export function membersNamed(ft: FileTypes, name: string): ApexMember[] | undefined {
    const lc = name.toLowerCase();
    for (const [typeName, ms] of ft.types) if (typeName.toLowerCase() === lc) return ms;
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
    return scanTypeHeaders(blankNonCode(text)).map((x) => x.h);
}

/** Headers with their body offsets (`brace` = the opening `{`, `end` = just past the closing `}`). */
function scanTypeHeaders(code: string): { h: TypeHeader; brace: number; end: number }[] {
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
    const out: { h: TypeHeader; brace: number; end: number }[] = [];
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
        out.push({ h, brace, end });
        open.push({ name: m[2], end });
    }
    return out;
}

// ─── Quick (regex) member scan ──────────────────────────────────────────────────
//
// A full ANTLR parse of a 3,000-line class takes ~100 ms even off-thread. For the FIRST
// cross-file lookup of a file we answer from this cheap scan (a few ms) while the
// worker parses; the exact parse replaces it as soon as it lands.

const MEMBER_MODIFIERS = new Set([
    'public', 'private', 'protected', 'global', 'static', 'final', 'abstract', 'virtual', 'override',
    'transient', 'testmethod', 'webservice', 'with', 'without', 'inherited', 'sharing',
]);

const normType = (t: string): string => t.replace(/\s+/g, ' ').replace(/\s*([<>,\[\]])\s*/g, '$1').trim();

/** Split at top-level commas (outside `<>` and `()`). */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
        if (c === '<' || c === '(') depth++;
        else if (c === '>' || c === ')') depth--;
        if (c === ',' && depth === 0) {
            out.push(cur);
            cur = '';
        } else cur += c;
    }
    out.push(cur);
    return out;
}

/** Index of the first top-level `=` (outside `<>`/`()`), or -1. */
function topLevelAssign(s: string): number {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<' || c === '(') depth++;
        else if (c === '>' || c === ')') depth--;
        else if (c === '=' && depth === 0) return i;
    }
    return -1;
}

function memberFlags(mods: string[], inInterface: boolean): Pick<ApexMember, 'static' | 'visibility'> {
    const out: Pick<ApexMember, 'static' | 'visibility'> = {
        visibility: inInterface ? 'public' : mods.includes('global') ? 'global' : mods.includes('public') ? 'public' : mods.includes('protected') ? 'protected' : 'private',
    };
    if (mods.includes('static')) out.static = true;
    return out;
}

/** Leading modifier words of a declaration head, and the rest. */
function splitModifiers(head: string): { mods: string[]; rest: string } {
    const words = head.split(' ');
    const mods: string[] = [];
    let i = 0;
    while (i < words.length && MEMBER_MODIFIERS.has(words[i].toLowerCase())) mods.push(words[i++].toLowerCase());
    return { mods, rest: words.slice(i).join(' ') };
}

function memberFromHead(text: string, terminator: '{' | ';', owner: TypeHeader, out: ApexMember[]): void {
    const t = text.replace(/@\w+(\s*\([^)]*\))?/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t || /^static$/i.test(t) || /(?:^|\s)(?:class|interface|enum)\s/i.test(t + ' ')) return;
    const inInterface = owner.kind === 'interface';
    const call = /^(.*?)([A-Za-z_]\w*)\s*\(([^()]*)\)$/.exec(t);
    if (call) {
        const { mods, rest } = splitModifiers(call[1].trim());
        const ret = normType(rest);
        if (!ret) return; // constructor
        const params = call[3].split(',').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ');
        out.push({ name: call[2], kind: 'method', detail: `(${params}) : ${ret}`, type: ret, params, ...memberFlags(mods, inInterface) });
        return;
    }
    if (terminator === '{') {
        // Property: `Type name { get; set; }`.
        const m = /^(.*\S)\s+([A-Za-z_]\w*)$/.exec(t);
        if (!m) return;
        const { mods, rest } = splitModifiers(m[1]);
        const type = normType(rest);
        if (type) out.push({ name: m[2], kind: 'property', detail: type, type, ...memberFlags(mods, inInterface) });
        return;
    }
    // Field(s): `Type a = …, b;`
    const eq = topLevelAssign(t);
    const declPart = eq >= 0 ? t.slice(0, eq) : t;
    const pieces = splitTop(eq >= 0 ? declPart : t);
    const first = /^(.*\S)\s+([A-Za-z_]\w*)\s*$/.exec(pieces[0].trim());
    if (!first) return;
    const { mods, rest } = splitModifiers(first[1]);
    const type = normType(rest);
    if (!type) return;
    const flags = memberFlags(mods, inInterface);
    out.push({ name: first[2], kind: 'field', detail: type, type, ...flags });
    for (const p of pieces.slice(1)) {
        const n = /^\s*([A-Za-z_]\w*)/.exec(p)?.[1];
        if (n) out.push({ name: n, kind: 'field', detail: type, type, ...flags });
    }
}

/** Members + type declarations of an Apex file by a cheap scan (no parse). */
export function quickTypeIndex(text: string): Pick<ApexIndex, 'types' | 'typeDecls'> {
    const code = blankNonCode(text);
    const scanned = scanTypeHeaders(code);
    const types = new Map<string, ApexMember[]>();
    const typeDecls: ApexTypeDecl[] = [];
    for (const { h, brace, end } of scanned) {
        const members: ApexMember[] = [];
        const bodyEnd = end - 1; // the closing brace
        let i = brace + 1;
        if (h.kind === 'enum') {
            let stop = code.indexOf(';', i);
            if (stop < 0 || stop > bodyEnd) stop = bodyEnd;
            for (const v of code.slice(i, stop).split(',')) {
                const n = v.trim();
                if (/^[A-Za-z_]\w*$/.test(n)) members.push({ name: n, kind: 'enumValue', detail: h.name, type: h.name, static: true, visibility: 'public' });
            }
            i = stop + 1;
        }
        let stmtStart = i;
        while (i < bodyEnd) {
            const c = code[i];
            if (c === '{') {
                const head = code.slice(stmtStart, i);
                // Skip the balanced block.
                let depth = 0;
                let j = i;
                for (; j < bodyEnd; j++) {
                    if (code[j] === '{') depth++;
                    else if (code[j] === '}' && --depth === 0) break;
                }
                if (topLevelAssign(head) >= 0) {
                    // `List<String> l = new List<String>{ … };` — still the same field statement.
                    i = j + 1;
                    continue;
                }
                memberFromHead(head, '{', h, members);
                i = j + 1;
                stmtStart = i;
                continue;
            }
            if (c === ';') {
                memberFromHead(code.slice(stmtStart, i), ';', h, members);
                stmtStart = i + 1;
            }
            i++;
        }
        if (!types.has(h.name)) types.set(h.name, members);
        const decl: ApexTypeDecl = {
            name: h.name,
            kind: h.kind,
            modifiers: h.modifiers,
            implementsTypes: h.implementsTypes,
            nameRange: h.nameRange,
            range: h.range,
            members: [],
        };
        if (h.outer) decl.outer = h.outer;
        if (h.extendsType) decl.extendsType = h.extendsType;
        typeDecls.push(decl);
    }
    return { types, typeDecls };
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
    private byFile = new Map<string, TypeNode[]>();

    constructor(entries: [string, TypeHeader[]][]) {
        for (const [file, headers] of entries) {
            for (const h of headers) {
                const node: TypeNode = { file, header: h, qname: h.outer ? `${h.outer}.${h.name}` : h.name };
                this.nodes.push(node);
                const inFile = this.byFile.get(file);
                if (inFile) inFile.push(node);
                else this.byFile.set(file, [node]);
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
        return this.byFile.get(file)?.find((n) => n.qname.toLowerCase() === lc);
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
