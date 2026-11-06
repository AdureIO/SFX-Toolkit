/**
 * Case-insensitive identifier-token index over every workspace Apex file (.cls/.trigger)
 * and every Salesforce metadata file that can refer to Apex by name (LWC / Aura JS and
 * markup, Visualforce, Flows) — the candidate pre-filter for Find References / rename.
 *
 * Apex files are tokenized from their CODE only (comments and string literals blanked),
 * plus the class names inside `Type.forName('…')` strings, stored with a leading `'`
 * (`'accountservice`) so they never satisfy a plain code-token lookup. Metadata files
 * are tokenized from their raw text (the references ARE strings there).
 *
 * Built asynchronously on first use (batched reads, yielding between batches; the type
 * headers of each Apex file are primed from the same read), and kept current by the
 * WorkspaceIndex change events (watched files + saves): a changed file is only marked
 * dirty and re-read on the next lookup. Open (possibly unsaved) Apex buffers are NOT taken
 * from here — callers check open documents' text directly; unsaved metadata buffers
 * come from the MetadataOverlay (`sfx/metadataBuffer`).
 */
import * as fs from 'fs';
import { WorkspaceIndex } from './workspaceIndex';
import { blankNonCode } from '../../src/utils/apexReferences';
import { typeForNameRefs } from '../../src/utils/sfMetadataRefs';
import { throwIfCancelled } from './cancel';
import { MetadataOverlay } from './metadataOverlay';
import type { CancellationToken } from 'vscode-languageserver/node';

const APEX_FILE = /\.(cls|trigger)$/i;
const BATCH = 32;
const TOKEN = /[A-Za-z_]\w*/g;
const MAX_MEMO_KEYS = 8;

/** Tokens of an Apex file: code identifiers + `'name` for Type.forName class strings. */
export function apexTokens(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of blankNonCode(text).matchAll(TOKEN)) out.add(m[0].toLowerCase());
    if (/forName/i.test(text)) for (const r of typeForNameRefs(text)) out.add(`'${r.name.toLowerCase()}`);
    return out;
}

/** Tokens of a metadata file: every identifier-like run in the raw text. */
export function rawTokens(text: string): Set<string> {
    const out = new Set<string>();
    for (const m of text.matchAll(TOKEN)) out.add(m[0].toLowerCase());
    return out;
}

class TokenIndexImpl {
    private ids = new Map<string, number>();
    private paths: string[] = [];
    private fileTokens = new Map<number, string[]>();
    private postings = new Map<string, Set<number>>();
    private dirty = new Set<string>();
    private removed = new Set<string>();
    private built = false;
    private building: Promise<void> | undefined;
    private generation = 0;
    private subscribed = false;
    /** Per-file derived data keyed by a caller-chosen name (e.g. receiver tokens of a member); LRU over keys. */
    private memo = new Map<string, Map<string, unknown>>();

    /** Subscribe to WorkspaceIndex change events (idempotent). */
    attach(): void {
        if (this.subscribed) return;
        this.subscribed = true;
        WorkspaceIndex.onFileChange((file, kind) => {
            if (kind === 'reset') return this.clear();
            if (!this.built && !this.building) return;
            if (kind === 'deleted') {
                this.dirty.delete(file);
                this.removed.add(file);
            } else {
                this.removed.delete(file);
                this.dirty.add(file);
            }
        });
    }

    clear(): void {
        this.generation++;
        this.ids.clear();
        this.paths = [];
        this.fileTokens.clear();
        this.postings.clear();
        this.dirty.clear();
        this.removed.clear();
        this.memo.clear();
        this.built = false;
        this.building = undefined;
    }

    /**
     * Derived per-file data cached next to the tokens (valid until the file changes: any
     * re-index or removal of the file drops it). `undefined` = not computed. Only for
     * on-disk content — open buffers must not be memoized here.
     */
    memoGet<T>(key: string, file: string): T | undefined {
        const m = this.memo.get(key);
        if (!m) return undefined;
        this.memo.delete(key);
        this.memo.set(key, m);
        return m.get(file) as T | undefined;
    }

    memoSet(key: string, file: string, value: unknown): void {
        let m = this.memo.get(key);
        if (!m) {
            m = new Map();
            this.memo.set(key, m);
            while (this.memo.size > MAX_MEMO_KEYS) this.memo.delete(this.memo.keys().next().value as string);
        }
        m.set(file, value);
    }

    private forgetMemo(file: string): void {
        for (const m of this.memo.values()) m.delete(file);
    }

    /** Whether the initial build has completed. */
    get isBuilt(): boolean {
        return this.built;
    }

    /** Number of indexed files (tests / diagnostics). */
    get size(): number {
        return this.fileTokens.size;
    }

    /** Build (once) and apply pending changes. Resolves when lookups are current. */
    async ensure(token?: CancellationToken): Promise<void> {
        this.attach();
        if (!this.built) {
            if (!this.building) {
                const gen = this.generation;
                this.building = this.build(gen).then(
                    () => {
                        if (gen === this.generation) this.built = true;
                    },
                    () => {
                        if (gen === this.generation) this.building = undefined;
                    },
                );
            }
            const b = this.building;
            await b;
            throwIfCancelled(token);
            if (!this.built) return;
        }
        for (const f of [...this.removed]) {
            this.removed.delete(f);
            this.drop(f);
        }
        if (this.dirty.size) {
            const files = [...this.dirty];
            this.dirty.clear();
            await this.indexFiles(files, this.generation);
        }
    }

    /** Files containing `token` (lower-cased identifier, or `'name` for Type.forName strings). */
    lookup(token: string): string[] {
        const set = this.postings.get(token.toLowerCase());
        if (!set) return [];
        const out: string[] = [];
        for (const id of set) out.push(this.paths[id]);
        return out;
    }

    /** Whether a file contains `token` per the index (undefined = file not indexed). */
    has(file: string, token: string): boolean | undefined {
        const id = this.ids.get(file);
        if (id === undefined || !this.fileTokens.has(id)) return undefined;
        return !!this.postings.get(token.toLowerCase())?.has(id);
    }

    private async build(gen: number): Promise<void> {
        await WorkspaceIndex.ready();
        if (gen !== this.generation) return;
        const files = [...WorkspaceIndex.allFiles(), ...WorkspaceIndex.metadataFiles()];
        await this.indexFiles(files, gen);
    }

    private async indexFiles(files: string[], gen: number): Promise<void> {
        for (let i = 0; i < files.length; i += BATCH) {
            if (gen !== this.generation) return;
            const batch = files.slice(i, i + BATCH);
            const texts = await Promise.all(batch.map((f) => MetadataOverlay.get(f) ?? fs.promises.readFile(f, 'utf8').catch(() => undefined)));
            if (gen !== this.generation) return;
            for (let k = 0; k < batch.length; k++) {
                const f = batch[k];
                const text = texts[k];
                if (text === undefined) {
                    this.drop(f);
                    continue;
                }
                const apex = APEX_FILE.test(f);
                if (apex) WorkspaceIndex.primeHeaders(f, text);
                this.put(f, apex ? apexTokens(text) : rawTokens(text));
            }
            await new Promise<void>((r) => setImmediate(r));
        }
    }

    private put(file: string, tokens: Set<string>): void {
        this.forgetMemo(file);
        let id = this.ids.get(file);
        if (id === undefined) {
            id = this.paths.length;
            this.paths.push(file);
            this.ids.set(file, id);
        } else {
            this.unpost(id);
        }
        const list = [...tokens];
        this.fileTokens.set(id, list);
        for (const t of list) {
            let s = this.postings.get(t);
            if (!s) this.postings.set(t, (s = new Set()));
            s.add(id);
        }
    }

    private drop(file: string): void {
        this.forgetMemo(file);
        const id = this.ids.get(file);
        if (id === undefined) return;
        this.unpost(id);
        this.fileTokens.delete(id);
    }

    private unpost(id: number): void {
        for (const t of this.fileTokens.get(id) ?? []) {
            const s = this.postings.get(t);
            if (!s) continue;
            s.delete(id);
            if (!s.size) this.postings.delete(t);
        }
    }
}

export const TokenIndex = new TokenIndexImpl();
