/**
 * Per-document Apex parse cache with debounced background parsing.
 *
 * A full ANTLR parse of a large class takes ~100ms+, so it must not sit on the
 * keystroke → completion path. Edits schedule a debounced background parse
 * (`scheduleBackground`, driven by documents.onDidChangeContent); interactive,
 * read-only features use the last completed parse (`forRead`) when the current
 * version hasn't been parsed yet, mapping the cursor into that parse's coordinates.
 * Features whose output must line up exactly with the current text (anything that
 * produces edits or ranges into the document: code actions, definition ranges,
 * references, outline, diagnostics) use `current`, which parses synchronously when
 * needed.
 *
 * Retention: every open document keeps its latest parse until it closes; at most
 * MAX_CLOSED_ENTRIES entries for documents that are not open are kept (backstop for
 * buffers that never send didClose).
 */
import type { Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { parseApex, ApexParseResult } from './apexSymbols';

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

export class ParseCache {
    private cache = new Map<string, Snapshot>();
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Per document: the last text seen by noteChange and the edits made since the cached
     * parse (oldest first). Each didChange is normally one contiguous edit, so mapping
     * positions back through this chain is exact even across several separate edits.
     * `edits: null` = unknown history → fall back to a direct diff of the two texts.
     */
    private history = new Map<string, { version: number; text: string; edits: EditSpan[] | null }>();

    constructor(private readonly getDoc: (uri: string) => TextDocument | undefined) {}

    /** The parse of the document's CURRENT version (parses synchronously if needed). */
    current(doc: TextDocument): ApexParseResult {
        const cached = this.cache.get(doc.uri);
        if (cached && cached.version === doc.version) return cached.result;
        return this.parseNow(doc).result;
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
        if (!this.timers.has(doc.uri)) this.scheduleBackground(doc);
        const oldText = snap.text;
        const newText = doc.getText();
        const h = this.history.get(doc.uri);
        const edits = h && h.version === doc.version && h.edits ? h.edits.slice() : null;
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

    /**
     * Record a content change (call from documents.onDidChangeContent, before
     * scheduling the background parse) so stale-parse positions can be mapped exactly.
     */
    noteChange(doc: TextDocument): void {
        const text = doc.getText();
        const prev = this.history.get(doc.uri);
        const snap = this.cache.get(doc.uri);
        if (!snap || snap.version === doc.version) {
            this.history.set(doc.uri, { version: doc.version, text, edits: [] });
            return;
        }
        let edits: EditSpan[] | null = null;
        if (prev && prev.edits && prev.edits.length < MAX_TRACKED_EDITS && (prev.version === snap.version || prev.edits.length)) {
            edits = prev.edits;
            edits.push(diffSpan(prev.text, text));
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
                this.parseNow(live);
            }, delayMs),
        );
    }

    /** Whether the cache holds a parse of the document's current version. */
    isCurrent(doc: TextDocument): boolean {
        return this.cache.get(doc.uri)?.version === doc.version;
    }

    drop(uri: string): void {
        this.cache.delete(uri);
        this.history.delete(uri);
        const t = this.timers.get(uri);
        if (t) {
            clearTimeout(t);
            this.timers.delete(uri);
        }
    }

    clear(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.cache.clear();
        this.history.clear();
    }

    private parseNow(doc: TextDocument): Snapshot {
        const text = doc.getText();
        const snap: Snapshot = { version: doc.version, text, result: parseApex(text) };
        this.cache.delete(doc.uri); // re-insert = most recent
        this.cache.set(doc.uri, snap);
        this.history.set(doc.uri, { version: doc.version, text, edits: [] });
        this.evictClosed();
        return snap;
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
            closed--;
        }
    }
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
