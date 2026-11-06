/**
 * Parse-free outline of an Apex file, computed from its blanked code (comments and string
 * contents replaced by spaces, offsets preserved — `blankCode` in symbolSearch.ts):
 *
 *   members — every field / property / method (name + declared type text) at type level.
 *             Producer detection for Find References only needs "does this file declare a
 *             member whose type mentions the target family", which is answered here in a
 *             few hundred microseconds instead of an ANTLR parse (~1 ms per KB).
 *   bodies  — the `{ … }` span of every method / constructor body, with the offset where
 *             its header (annotations, modifiers, signature) starts. A reference search
 *             parses a file with the bodies that provably hold no hit blanked out
 *             (whitespace, newlines kept), which preserves every offset and range.
 *
 * It is a heuristic scanner, not a parser: whenever the brace structure is not the shape
 * it understands (a `trigger`, unbalanced braces, an unexpected header) `ok` is false and
 * callers fall back to the full parse. The member list is deliberately a SUPERSET of what
 * the parser reports for producer detection (extra names only cost an extra check).
 */

export interface OutlineMember {
    name: string;
    /** Declared type as written (field / property type, method return type). */
    type: string;
}

export interface OutlineBody {
    /** Offset of the header's first character (after the previous statement). */
    head: number;
    /** Offset of the opening `{`. */
    open: number;
    /** Offset of the matching `}`. */
    close: number;
}

export interface Outline {
    ok: boolean;
    members: OutlineMember[];
    bodies: OutlineBody[];
}

const MODIFIERS = new Set([
    'public', 'private', 'protected', 'global', 'static', 'final', 'abstract', 'virtual', 'override',
    'testmethod', 'webservice', 'transient', 'with', 'without', 'inherited', 'sharing',
]);

/** Matching `}` for the `{` at `open` (code has no braces in strings / comments); -1 if unbalanced. */
function matchClose(code: string, open: number): number {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const c = code.charCodeAt(i);
        if (c === 123) depth++;
        else if (c === 125 && --depth === 0) return i;
    }
    return -1;
}

/** `@Annotation(args)` removed (blanked to spaces so offsets in the header stay put). */
function stripAnnotations(h: string): string {
    return h.replace(/@\s*[A-Za-z_][\w.]*(?:\s*\([^()]*\))?/g, (m) => ' '.repeat(m.length));
}

/** Split on commas outside `<>` / `()` / `[]`. */
function splitTop(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '<' || c === '(' || c === '[') depth++;
        else if (c === '>' || c === ')' || c === ']') depth--;
        else if (c === ',' && depth === 0) {
            out.push(s.slice(from, i));
            from = i + 1;
        }
    }
    out.push(s.slice(from));
    return out;
}

/** Members declared by a type-level statement header (`public static Foo<Bar> a, b`), or []. */
function membersOfHeader(header: string): OutlineMember[] {
    let h = stripAnnotations(header);
    const eq = h.indexOf('=');
    const par = h.indexOf('(');
    const cut = eq >= 0 && par >= 0 ? Math.min(eq, par) : Math.max(eq, par);
    if (cut >= 0) h = h.slice(0, cut);
    h = h.replace(/\s+/g, ' ').trim();
    if (!h) return [];
    const parts = splitTop(h);
    const m = /^(.*?)([A-Za-z_]\w*)$/.exec(parts[0].trim());
    if (!m) return [];
    // Leading modifiers are not part of the type.
    const toks = m[1].trim().split(' ');
    let k = 0;
    while (k < toks.length && MODIFIERS.has(toks[k].toLowerCase())) k++;
    const type = toks.slice(k).join(' ').trim();
    if (!type) return []; // constructor (or malformed) — not a producer
    const out: OutlineMember[] = [{ name: m[2], type }];
    for (const extra of parts.slice(1)) {
        const n = /^\s*([A-Za-z_]\w*)\s*$/.exec(extra);
        if (n) out.push({ name: n[1], type });
    }
    return out;
}

const TYPE_HEADER = /(?:^|[\s)])(class|interface|enum)\s+[A-Za-z_]/i;

export function outlineOf(code: string): Outline {
    const members: OutlineMember[] = [];
    const bodies: OutlineBody[] = [];
    const fail = (): Outline => ({ ok: false, members, bodies });
    // Depth of type bodies we are directly inside (0 = file top level).
    let types = 0;
    let stmt = 0;
    const n = code.length;
    for (let i = 0; i < n; i++) {
        const c = code.charCodeAt(i);
        if (c === 59 /* ; */) {
            if (types > 0) for (const mem of membersOfHeader(code.slice(stmt, i))) members.push(mem);
            stmt = i + 1;
        } else if (c === 125 /* } */) {
            if (types === 0) return fail();
            types--;
            stmt = i + 1;
        } else if (c === 123 /* { */) {
            const header = stripAnnotations(code.slice(stmt, i));
            const par = header.indexOf('(');
            const ty = TYPE_HEADER.exec(header);
            if (ty && (par < 0 || ty.index < par)) {
                types++;
                stmt = i + 1;
                continue;
            }
            if (types === 0) return fail(); // trigger / anonymous / unknown top-level block
            const close = matchClose(code, i);
            if (close < 0) return fail();
            const trimmed = header.trimEnd();
            if (par >= 0 && trimmed.endsWith(')') && header.indexOf('=') < 0) {
                for (const mem of membersOfHeader(header)) members.push(mem);
                bodies.push({ head: stmt, open: i, close });
                stmt = close + 1;
            } else if (header.indexOf('=') >= 0) {
                // `List<X> a = new List<X>{…};` — the statement continues to its `;`.
                void 0;
            } else {
                // Property (`Foo name { get; set; }`) or an initializer block.
                for (const mem of membersOfHeader(header)) members.push(mem);
                stmt = close + 1;
            }
            i = close;
        }
    }
    if (types !== 0) return fail();
    return { ok: true, members, bodies };
}

/**
 * `text` with the interior of the given bodies replaced by spaces (newlines kept), so
 * every other offset, line and column is unchanged and the result still parses.
 */
export function elideBodies(text: string, bodies: readonly OutlineBody[]): string {
    if (!bodies.length) return text;
    const sorted = [...bodies].sort((a, b) => a.open - b.open);
    const parts: string[] = [];
    let at = 0;
    for (const b of sorted) {
        parts.push(text.slice(at, b.open + 1));
        parts.push(text.slice(b.open + 1, b.close).replace(/[^\r\n]/g, ' '));
        at = b.close;
    }
    parts.push(text.slice(at));
    return parts.join('');
}
