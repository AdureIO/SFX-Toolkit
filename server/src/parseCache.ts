/**
 * Per-document Apex parse cache with debounced background parsing.
 *
 * A full ANTLR parse of a large class takes ~100ms+, so it must not sit on the
 * keystroke → completion path. Edits schedule a debounced background parse
 * (`scheduleBackground`, driven by documents.onDidChangeContent) which runs in a
 * worker thread (parseWorkerClient.ts) so it never blocks the event loop; interactive,
 * read-only features use the last completed parse (`forRead`) when the current
 * version hasn't been parsed yet, mapping the cursor into that parse's coordinates.
 * Features whose output must line up exactly with the current text (anything that
 * produces edits or ranges into the document: code actions, definition ranges,
 * references, outline, diagnostics) use `current`, which parses synchronously when
 * needed (or `currentAsync`, which waits for the worker instead).
 *
 * Broken code: besides the latest parse, the cache keeps the last parse WITHOUT syntax
 * errors (`forReadGood`). One unbalanced `{` thousands of lines up makes the parser
 * lose most of a class; lookups (members of `this`, locals) can fall back to the
 * error-free snapshot, mapped through the same edit history.
 *
 * Retention: every open document keeps its latest (and last error-free) parse until it
 * closes; at most MAX_CLOSED_ENTRIES entries for documents that are not open are kept
 * (backstop for buffers that never send didClose).
 */
import type { Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { parseApex, ApexParseResult } from './apexSymbols';
import { ParseWorker } from './parseWorkerClient';

const MAX_CLOSED_ENTRIES = 20;
export const BACKGROUND_PARSE_DELAY_MS = 200;

interface Snapshot {
    version: number;
    /** The text that was parsed (the same string the document held then — no copy while current). */
    text: string;
    result: ApexParseResult;
}

/** One text edit as seen between two consecutive versions: common prefix/suffix lengths. */
interface EditSpan {
    prefix: number;
    suffix: number;
    oldLen: number;
    newLen: number;
}

/** An edit turning version `from` into version `to`. */
interface EditRec {
    from: number;
    to: number;
    span: EditSpan;
}

/** Past this many un-parsed edits we stop tracking them and diff the texts directly. */
const MAX_TRACKED_EDITS = 256;

/** A parse to read from, plus a mapper from current-document positions into its coordinates. */
export interface ParseView {
    result: ApexParseResult;
    /** True when the parse is of an older version than the document's current one. */
    stale: boolean;
    /** Map a position in the CURRENT document to the equivalent position in the parsed text. */
    toParsePosition(pos: Position): Position;
}

/** True when a parse reported syntax errors. */
export function hasSyntaxErrors(r: ApexParseResult): boolean {
    return r.diagnostics.length > 0;
}

export class ParseCache {
    private cache = new Map<string, Snapshot>();
    /** Last error-free snapshot per document, kept only while the latest parse has errors. */
    private good = new Map<string, Snapshot>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Background parses in flight: uri → version being parsed. */
    private inflight = new Map<string, number>();
    /** Waiters for a parse of a specific version (currentAsync). */
    private waiters = new Map<string, { version: number; resolve: (r: ApexParseResult) => void }[]>();
    /** Called after any parse of an open document lands (pre-warming cross-file lookups). */
    private listeners: ((uri: string, result: ApexParseResult) => void)[] = [];
    /**
     * Per document: the last text seen by noteChange and the edits made since the oldest
     * snapshot we keep (oldest first). Each didChange is normally one contiguous edit, so
     * mapping positions back through this chain is exact even across several separate
     * edits. `edits: null` = unknown history → fall back to a direct diff of the two texts.
     */
    private history = new Map<string, { version: number; text: string; edits: EditRec[] | null }>();

    constructor(private readonly getDoc: (uri: string) => TextDocument | undefined) {}

    /** The parse of the document's CURRENT version (parses synchronously if needed). */
    current(doc: TextDocument): ApexParseResult {
        const cached = this.cache.get(doc.uri);
        if (cached && cached.version === doc.version) return cached.result;
        return this.parseNow(doc).result;
    }

    /** The parse of the document's current version without blocking the event loop (worker). */
    currentAsync(doc: TextDocument): Promise<ApexParseResult> {
        const cached = this.cache.get(doc.uri);
        if (cached && cached.version === doc.version) return Promise.resolve(cached.result);
        return new Promise((resolve) => {
            const list = this.waiters.get(doc.uri) ?? [];
            list.push({ version: doc.version, resolve });
            this.waiters.set(doc.uri, list);
            this.startParse(doc);
        });
    }

    /**
     * The best parse for a read-only interactive feature: the current version's parse
     * if available, else the last completed parse of an older version (a background
     * parse is pending). Parses synchronously only when the document was never parsed.
     */
    forRead(doc: TextDocument): ParseView {
        const snap = this.cache.get(doc.uri);
        if (!snap || snap.version === doc.version) {
            const result = snap ? snap.result : this.parseNow(doc).result;
            return { result, stale: false, toParsePosition: (p) => p };
        }
        // Stale: make sure a background parse will catch up, then map positions.
        if (!this.timers.has(doc.uri) && !this.inflight.has(doc.uri)) this.scheduleBackground(doc);
        return this.viewOf(doc, snap);
    }

    /**
     * The last error-free parse when the latest parse has syntax errors (else undefined),
     * mapped into the current document. Use together with `forRead` for lookups that
     * should survive broken code elsewhere in the file.
     */
    forReadGood(doc: TextDocument): ParseView | undefined {
        const g = this.good.get(doc.uri);
        if (!g) return undefined;
        const latest = this.cache.get(doc.uri);
        if (latest === g) return undefined;
        return this.viewOf(doc, g);
    }

    /** The latest completed parse (and the last error-free one, if older) — never parses. */
    peek(uri: string): { latest: ApexParseResult; good?: ApexParseResult } | undefined {
        const latest = this.cache.get(uri);
        if (!latest) return undefined;
        const g = this.good.get(uri);
        return g && g !== latest ? { latest: latest.result, good: g.result } : { latest: latest.result };
    }

    /** Register a callback for every landed parse of an open document. */
    onParsed(fn: (uri: string, result: ApexParseResult) => void): void {
        this.listeners.push(fn);
    }

    /** Warm the parser JIT (main thread: tiny parse) and start the worker. */
    warm(): void {
        ParseWorker.warm();
        try {
            parseApex('public class Warm { Integer f; void m(List<Account> a) { for (Account x : a) { f = 1; } } }');
        } catch {
            /* ignore */
        }
    }

    /**
     * Record a content change (call from documents.onDidChangeContent, before
     * scheduling the background parse) so stale-parse positions can be mapped exactly.
     */
    noteChange(doc: TextDocument): void {
        const text = doc.getText();
        const prev = this.history.get(doc.uri);
        if (!this.cache.has(doc.uri) || !prev) {
            this.history.set(doc.uri, { version: doc.version, text, edits: [] });
            return;
        }
        if (prev.version === doc.version) {
            prev.text = text;
            return;
        }
        let edits = prev.edits;
        if (edits) {
            edits.push({ from: prev.version, to: doc.version, span: diffSpan(prev.text, text) });
            if (edits.length > MAX_TRACKED_EDITS) edits = null;
        }
        this.history.set(doc.uri, { version: doc.version, text, edits });
    }

    /** Debounced background parse of the document's latest version. */
    scheduleBackground(doc: TextDocument, delayMs = BACKGROUND_PARSE_DELAY_MS): void {
        const uri = doc.uri;
        const prev = this.timers.get(uri);
        if (prev) clearTimeout(prev);
        this.timers.set(
            uri,
            setTimeout(() => {
                this.timers.delete(uri);
                const live = this.getDoc(uri);
                if (!live) return;
                const cached = this.cache.get(uri);
                if (cached && cached.version === live.version) return;
                this.startParse(live);
            }, delayMs),
        );
    }

    /** Whether the cache holds a parse of the document's current version. */
    isCurrent(doc: TextDocument): boolean {
        return this.cache.get(doc.uri)?.version === doc.version;
    }

    drop(uri: string): void {
        this.cache.delete(uri);
        this.good.delete(uri);
        this.history.delete(uri);
        this.inflight.delete(uri);
        this.waiters.delete(uri);
        const t = this.timers.get(uri);
        if (t) {
            clearTimeout(t);
            this.timers.delete(uri);
        }
    }

    /** Drop everything and stop the parse worker (release/shutdown). */
    clear(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.cache.clear();
        this.good.clear();
        this.history.clear();
        this.inflight.clear();
        this.waiters.clear();
        ParseWorker.terminate();
    }

    /** Off-thread parse of the document's current version (one in flight per document). */
    private startParse(doc: TextDocument): void {
        const uri = doc.uri;
        if (this.inflight.get(uri) === doc.version) return;
        if (this.inflight.has(uri)) {
            // An older version is being parsed; when it lands we re-check and parse again.
            return;
        }
        const version = doc.version;
        const text = doc.getText();
        this.inflight.set(uri, version);
        ParseWorker.parseText(text).then(
            (result) => {
                if (this.inflight.get(uri) === version) this.inflight.delete(uri);
                const live = this.getDoc(uri);
                if (!live) return;
                const cached = this.cache.get(uri);
                if (!cached || cached.version < version) this.adopt(uri, { version, text, result });
                // The document moved on while we parsed: catch up (debounced again by edits).
                if (live.version !== version && !this.timers.has(uri)) this.startParse(live);
            },
            () => {
                if (this.inflight.get(uri) === version) this.inflight.delete(uri);
            },
        );
    }

    private parseNow(doc: TextDocument): Snapshot {
        const text = doc.getText();
        const snap: Snapshot = { version: doc.version, text, result: parseApex(text) };
        this.adopt(doc.uri, snap);
        return snap;
    }

    /** Make `snap` the latest parse of `uri`; keep/drop the error-free fallback; prune history. */
    private adopt(uri: string, snap: Snapshot): void {
        this.cache.delete(uri); // re-insert = most recent
        this.cache.set(uri, snap);
        if (!hasSyntaxErrors(snap.result)) this.good.set(uri, snap);
        const h = this.history.get(uri);
        // Keep the edits newer than the oldest snapshot we still map from (latest or good).
        const keepFrom = Math.min(snap.version, this.good.get(uri)?.version ?? snap.version);
        if (!h) this.history.set(uri, { version: snap.version, text: snap.text, edits: [] });
        else if (h.edits) h.edits = h.edits.filter((e) => e.to > keepFrom);
        else if (h.version === snap.version && keepFrom === snap.version) h.edits = [];
        const w = this.waiters.get(uri);
        if (w) {
            const rest = w.filter((x) => {
                if (x.version > snap.version) return true;
                x.resolve(snap.result);
                return false;
            });
            if (rest.length) this.waiters.set(uri, rest);
            else this.waiters.delete(uri);
        }
        if (this.getDoc(uri)) {
            for (const fn of this.listeners) {
                try {
                    fn(uri, snap.result);
                } catch {
                    /* a listener failure must not break parsing */
                }
            }
        }
        this.evictClosed();
    }

    private viewOf(doc: TextDocument, snap: Snapshot): ParseView {
        if (snap.version === doc.version) return { result: snap.result, stale: false, toParsePosition: (p) => p };
        const oldText = snap.text;
        const newText = doc.getText();
        const h = this.history.get(doc.uri);
        const edits = h && h.version === doc.version && h.edits ? chainFrom(h.edits, snap.version, doc.version) : null;
        let mapper: ((o: number) => number) | undefined;
        return {
            result: snap.result,
            stale: true,
            toParsePosition: (p) => {
                mapper ??= edits ? chainMapper(edits) : spanMapper(diffSpan(oldText, newText));
                return positionAt(oldText, mapper(doc.offsetAt(p)));
            },
        };
    }

    /** Keep every open document's parse; cap the ones for documents that aren't open. */
    private evictClosed(): void {
        let closed = 0;
        for (const uri of this.cache.keys()) if (!this.getDoc(uri)) closed++;
        if (closed <= MAX_CLOSED_ENTRIES) return;
        for (const uri of [...this.cache.keys()]) {
            if (closed <= MAX_CLOSED_ENTRIES) break;
            if (this.getDoc(uri)) continue;
            this.cache.delete(uri); // oldest first (Map insertion order)
            this.good.delete(uri);
            this.history.delete(uri);
            closed--;
        }
    }
}

/** The contiguous edit chain from version `from` to version `to`, or null when there's a gap. */
function chainFrom(all: EditRec[], from: number, to: number): EditSpan[] | null {
    const out: EditSpan[] = [];
    let v = from;
    for (const e of all) {
        if (e.to <= from) continue;
        if (e.from !== v) return null;
        out.push(e.span);
        v = e.to;
    }
    return v === to ? out : null;
}

/** The single contiguous edit turning `oldText` into `newText` (common prefix/suffix). */
function diffSpan(oldText: string, newText: string): EditSpan {
    const max = Math.min(oldText.length, newText.length);
    let prefix = 0;
    while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (
        suffix < max - prefix &&
        oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
    ) {
        suffix++;
    }
    return { prefix, suffix, oldLen: oldText.length, newLen: newText.length };
}

/**
 * Offset mapper new-text → old-text for one edit: offsets before the edited span are
 * unchanged, offsets after it shift by the length delta, and offsets inside it map to
 * the start of the edit in the old text.
 */
function spanMapper(e: EditSpan): (offset: number) => number {
    const delta = e.newLen - e.oldLen;
    return (o) => (o <= e.prefix ? o : o >= e.newLen - e.suffix ? o - delta : e.prefix);
}

/** Map back through a chain of edits (oldest first), newest edit first. */
function chainMapper(edits: EditSpan[]): (offset: number) => number {
    const maps = edits.map(spanMapper).reverse();
    return (o) => maps.reduce((acc, m) => m(acc), o);
}

function positionAt(text: string, offset: number): Position {
    const o = Math.max(0, Math.min(offset, text.length));
    let line = 0;
    let lineStart = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < o; i = text.indexOf('\n', i + 1)) {
        line++;
        lineStart = i + 1;
    }
    return { line, character: o - lineStart };
}
