/**
 * Semantic highlighting for Apex (and .soql) documents:
 * textDocument/semanticTokens/full, /full/delta and /range.
 *
 * Main goal: tell SObject fields (`acc.Name`, `Account.Name`, SOQL field refs) apart
 * from local variables, and give themes the usual class / method / property /
 * variable / parameter distinctions with declaration/static/readonly/abstract/
 * deprecated/defaultLibrary modifiers.
 *
 * Design — token-level, not parse-tree based:
 *   The shared parse (ctx.parses) keeps no parse tree and lags edits by the
 *   background-parse debounce; forcing `current()` would put a 100ms+ ANTLR parse
 *   on the highlighting path. Instead we scan the CURRENT text with a small Apex
 *   lexer and run two cheap passes over the token stream:
 *     1. structure: brace frames (type body / method body / block / property /
 *        expression initializer), declarations (types, fields, properties, methods,
 *        constructors, enum constants, parameters, locals incl. for/catch/when)
 *        with their modifiers, type-position identifiers, SOQL regions;
 *     2. classification: every identifier resolved against lexical scope (locals
 *        declared before use, then members of the enclosing types), receiver types
 *        (`x.member` on an SObject-typed value ⇒ SObject field), document /
 *        workspace / SObject / standard-library type names, and SOQL field paths.
 *   Positions are always exact for the current version (no stale-parse mapping).
 *   A 3000-line class tokenizes in a few milliseconds (see the report / tests).
 *
 * Schema: never blocks on describes. SObject type names come from the cached object
 * list (ONE host request per org context, then cached here), the generated stub
 * directory and custom-suffix heuristics. A member access on an SObject-typed value
 * is an SObject field syntactically (SObjects have no other non-method members);
 * describes are only needed to walk relationship hops (`c.Account.Name`) and child
 * relationship subqueries. Those come from a small cache here, filled by a bounded,
 * sequential background fetch through ctx.schema.describe (which itself caches and
 * dedupes); when new describes / the object list arrive we send a debounced
 * workspace/semanticTokens/refresh (only if the client supports it).
 *
 * Results are cached per document by version (bounded LRU, dropped on close) and
 * deltas are computed against the previous result id as one prefix/suffix edit.
 */
import type {
    Connection,
    SemanticTokens,
    SemanticTokensDelta,
    SemanticTokensLegend,
    CancellationToken,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { lruGet, lruSet } from './caches';
import { isApex } from './textUtil';
import { stdTypeName } from './apexStdlib';
import { stubbedObjectNames } from './sobjectStub';
import { WorkspaceIndex } from './workspaceIndex';
import type { HostDescribe } from './schema';

// ─── Legend ──────────────────────────────────────────────────────────────────────

export const TOKEN_TYPES = [
    'namespace', 'class', 'interface', 'enum', 'enumMember', 'type', 'method', 'property', 'variable', 'parameter',
];
/** Standard LSP modifiers first, then two custom ones (`sobject`, `sobjectField`). */
export const TOKEN_MODIFIERS = [
    'declaration', 'static', 'readonly', 'abstract', 'deprecated', 'defaultLibrary', 'sobject', 'sobjectField',
];
export const LEGEND: SemanticTokensLegend = { tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS };

const T_NAMESPACE = 0, T_CLASS = 1, T_INTERFACE = 2, T_ENUM = 3, T_ENUM_MEMBER = 4, T_TYPE = 5,
    T_METHOD = 6, T_PROPERTY = 7, T_VARIABLE = 8, T_PARAMETER = 9;
const M_DECL = 1, M_STATIC = 2, M_READONLY = 4, M_ABSTRACT = 8, M_DEPRECATED = 16, M_STDLIB = 32,
    M_SOBJECT = 64, M_SOBJECT_FIELD = 128;

// ─── Lexer ───────────────────────────────────────────────────────────────────────

const K_IDENT = 0, K_PUNCT = 1, K_LIT = 2;

interface Tok {
    k: number;
    /** Identifier/punctuation text ('' for literals). */
    t: string;
    /** Lower-cased identifier text (Apex is case-insensitive). */
    lc: string;
    line: number;
    col: number;
}

function isIdStart(c: number): boolean {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}
function isIdPart(c: number): boolean {
    return isIdStart(c) || (c >= 48 && c <= 57);
}

/** Tokenize Apex: identifiers, single-char punctuation, literals; comments/whitespace dropped. */
function scan(text: string): Tok[] {
    const out: Tok[] = [];
    const n = text.length;
    let i = 0;
    let line = 0;
    let lineStart = 0;
    while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 10) {
            line++;
            i++;
            lineStart = i;
            continue;
        }
        if (c === 32 || c === 9 || c === 13 || c === 12) {
            i++;
            continue;
        }
        if (c === 47 /* / */) {
            const d = text.charCodeAt(i + 1);
            if (d === 47) {
                while (i < n && text.charCodeAt(i) !== 10) i++;
                continue;
            }
            if (d === 42) {
                i += 2;
                while (i < n && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) {
                    if (text.charCodeAt(i) === 10) {
                        line++;
                        lineStart = i + 1;
                    }
                    i++;
                }
                i += 2;
                continue;
            }
        }
        const col = i - lineStart;
        if (c === 39 /* ' */) {
            i++;
            while (i < n) {
                const d = text.charCodeAt(i);
                if (d === 92) {
                    i += 2;
                    continue;
                }
                if (d === 39) {
                    i++;
                    break;
                }
                if (d === 10) break; // unterminated: stop at end of line
                i++;
            }
            out.push({ k: K_LIT, t: '', lc: '', line, col });
            continue;
        }
        if (isIdStart(c)) {
            const s = i;
            i++;
            while (i < n && isIdPart(text.charCodeAt(i))) i++;
            const t = text.slice(s, i);
            out.push({ k: K_IDENT, t, lc: t.toLowerCase(), line, col });
            continue;
        }
        if (c >= 48 && c <= 57) {
            i++;
            while (i < n) {
                const d = text.charCodeAt(i);
                if (isIdPart(d) || (d === 46 && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57)) i++;
                else break;
            }
            out.push({ k: K_LIT, t: '', lc: '', line, col });
            continue;
        }
        const t = text[i];
        out.push({ k: K_PUNCT, t, lc: t, line, col });
        i++;
    }
    return out;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────────

/** Apex words that can never be an identifier we classify. (`get`/`set`/`trigger` are contextual.) */
const KEYWORDS = new Set([
    'abstract', 'break', 'catch', 'class', 'continue', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for',
    'global', 'if', 'implements', 'instanceof', 'interface', 'new', 'null', 'override', 'private', 'protected',
    'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'transient', 'try', 'virtual', 'void',
    'while', 'true', 'false', 'testmethod', 'webservice', 'insert', 'update', 'upsert', 'delete', 'undelete',
    'merge', 'when', 'with', 'without', 'inherited', 'sharing', 'on',
]);
const MODIFIERS = new Set([
    'public', 'private', 'protected', 'global', 'static', 'final', 'abstract', 'virtual', 'override', 'transient',
    'testmethod', 'webservice', 'with', 'without', 'inherited', 'sharing',
]);
/** Standard namespaces (qualifiers like `System.`, `Schema.`, `ConnectApi.`). */
const STD_NAMESPACES = new Set([
    'system', 'schema', 'connectapi', 'auth', 'cache', 'dom', 'flow', 'kbmanagement', 'messaging', 'process',
    'quickaction', 'reports', 'support', 'territorymgmt', 'txnsecurity', 'userprovisioning', 'visualeditor',
    'wave', 'commercepayments', 'invocable', 'functions', 'datasource', 'metadata', 'sfc', 'site',
]);
/** Standard-library types beyond the completion slice in apexStdlib.ts. */
const EXTRA_STD_TYPES = new Set([
    'assert', 'callable', 'iterable', 'iterator', 'comparable', 'comparator', 'approval', 'eventbus', 'label',
    'continuation', 'jsonparser', 'jsongenerator', 'jsontoken', 'version', 'request', 'quiddity',
    'triggeroperation', 'logginglevel', 'statuscode', 'accesslevel', 'accesstype', 'security',
    'sobjectaccessdecision', 'formula', 'featuremanagement', 'xmlstreamreader', 'xmlstreamwriter', 'blob',
    'saveresult', 'upsertresult', 'deleteresult', 'undeleteresult', 'queryLocator', 'batchablecontext',
    'querylocator', 'queueablecontext', 'schedulablecontext', 'finalizer', 'finalizercontext', 'search',
    'sobjectexception', 'listexception', 'typeexception', 'mathexception', 'stringexception', 'jsonexception',
    'limitexception', 'securityexception', 'noaccessexception', 'invalidparametervalueexception',
    'illegalargumentexception', 'emailexception', 'asyncexception', 'serializationexception',
    'unexpectedexception', 'handledexception', 'domain', 'organization', 'network', 'ideas', 'answers',
    'stubprovider', 'httpcalloutmock', 'webservicemock', 'webservicecallout', 'interval', 'timezone',
    'companionlist', 'restcontext', 'selectoption', 'standardcontroller', 'standardsetcontroller',
    'messaging', 'database',
]);
const SOQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'and', 'or', 'not', 'in', 'includes', 'excludes', 'like', 'limit', 'offset',
    'order', 'by', 'asc', 'desc', 'nulls', 'first', 'last', 'group', 'rollup', 'cube', 'having', 'with',
    'security_enforced', 'user_mode', 'system_mode', 'typeof', 'when', 'then', 'else', 'end', 'using',
    'scope', 'for', 'view', 'reference', 'update', 'tracking', 'viewstat', 'null', 'true', 'false', 'all',
    'rows', 'data', 'category', 'at', 'above', 'below', 'above_or_below', 'fields', 'standard', 'custom',
    'mine', 'everything', 'delegated', 'team', 'my_territory', 'my_team_territory', 'as',
    'today', 'yesterday', 'tomorrow', 'last_week', 'this_week', 'next_week', 'last_month', 'this_month',
    'next_month', 'last_90_days', 'next_90_days', 'this_quarter', 'last_quarter', 'next_quarter',
    'this_year', 'last_year', 'next_year', 'this_fiscal_quarter', 'last_fiscal_quarter',
    'next_fiscal_quarter', 'this_fiscal_year', 'last_fiscal_year', 'next_fiscal_year',
]);
const SOBJECT_SUFFIX = /__(c|mdt|e|x|b|kav|ka|share|history|feed|changeevent|chn)$/i;

// ─── Analysis ────────────────────────────────────────────────────────────────────

/** Compact describe: what highlighting needs (lower-cased names). */
export interface DescribeIndex {
    fields: Set<string>;
    /** Parent relationship name → referenced SObject. */
    rels: Map<string, string>;
    /** Child relationship name → child SObject. */
    children: Map<string, string>;
}

export interface TokenEnv {
    /** Is this (any-case) name an org SObject? */
    isSObject(lc: string): boolean;
    /** Is this a workspace Apex type (other file)? */
    isWorkspaceType(lc: string): boolean;
    /**
     * Cache-only describe lookup; `undefined` = not loaded. With `fetch`, the caller
     * may queue a bounded background fetch (only where a describe is really needed:
     * relationship hops and child-relationship subqueries).
     */
    describe(sobject: string, fetch?: boolean): DescribeIndex | null | undefined;
}

const enum FK {
    Root,
    Type,
    Method,
    Block,
    Prop,
    Expr,
}

interface VarInfo {
    tt: number; // T_VARIABLE | T_PARAMETER
    type: string;
    mods: number;
    decl: number; // token index of the name (-1 = implicit, e.g. setter `value`)
}
interface MemberInfo {
    tt: number;
    mods: number;
    type?: string;
    typeIdx?: number; // nested type
}
interface TypeInfo {
    name: string;
    kind: number; // T_CLASS | T_INTERFACE | T_ENUM
    members: Map<string, MemberInfo>; // fields, properties, enum constants, nested types
    methods: Map<string, MemberInfo>;
}
interface Frame {
    kind: FK;
    parent: number;
    typeIdx: number; // -1 unless kind === Type
    vars: Map<string, VarInfo[]> | null;
    parenBase: number;
}

/** What a receiver expression (`x` in `x.member`) denotes. */
interface Recv {
    k: 'sobj' | 'sobjStatic' | 'user' | 'userStatic' | 'std' | 'stdStatic' | 'ns' | 'value';
    name?: string;
    typeIdx?: number;
}

const PAREN_NONE = 0, PAREN_PARAMS = 1, PAREN_FOR = 2, PAREN_CATCH = 3;

/** Compute the LSP-encoded semantic tokens for an Apex document. Pure; no I/O. */
export function computeApexTokens(text: string, env: TokenEnv, soqlOnly = false): number[] {
    const T = scan(text);
    const N = T.length;
    const out: number[] = [];
    let prevLine = 0;
    let prevCol = 0;
    const emit = (p: number, tt: number, mods: number): void => {
        const tok = T[p];
        const dl = tok.line - prevLine;
        out.push(dl, dl === 0 ? tok.col - prevCol : tok.col, tok.t.length, tt, mods);
        prevLine = tok.line;
        prevCol = tok.col;
    };

    const isP = (p: number, ch: string): boolean => p < N && p >= 0 && T[p].k === K_PUNCT && T[p].t === ch;
    const isId = (p: number): boolean => p < N && p >= 0 && T[p].k === K_IDENT && !KEYWORDS.has(T[p].lc);

    // SObject-ness, memoized per pass.
    const sobjMemo = new Map<string, boolean>();
    const isSObject = (lc: string): boolean => {
        let v = sobjMemo.get(lc);
        if (v === undefined) {
            v = env.isSObject(lc) || SOBJECT_SUFFIX.test(lc);
            sobjMemo.set(lc, v);
        }
        return v;
    };

    if (soqlOnly) {
        // Whole document is one SOQL statement (no Apex scope; binds stay unclassified).
        soqlRegion(-1, N, T, env, isP, isId, emit, () => undefined);
        return out;
    }

    // ── Pass 1: structure + declarations ──
    const frames: Frame[] = [{ kind: FK.Root, parent: -1, typeIdx: -1, vars: null, parenBase: 0 }];
    const types: TypeInfo[] = [];
    const typesByLc = new Map<string, number>();
    const decls = new Map<number, number>(); // token → (tt << 8) | mods
    const typeRefs = new Map<number, number>(); // token → 1 (last segment) | 2 (qualifier)
    const braceFrame = new Map<number, number>(); // `{` token → frame id
    const soqlEnd = new Map<number, number>(); // `[` token → matching `]`
    const skip = new Set<number>();
    const ctorFields = new Map<number, string>(); // `new Account(Name = …)` field token → SObject (lc)

    const stack: number[] = [0];
    const parens: number[] = [];
    let stmtStart = true;
    let paramStart = false;
    let nextFrame: { kind: FK; typeIdx?: number } | null = null;
    let pendingParams: VarInfo[] | null = null;
    let pendingParamNames: string[] = [];
    let pendingBlock: { vars: VarInfo[]; names: string[] } | null = null;
    let declState: { type: string; mods: number; field: boolean; depth: number } | null = null;

    const cur = (): Frame => frames[stack[stack.length - 1]];
    const parenDepth = (): number => parens.length - cur().parenBase;
    const enclosingType = (): number => {
        for (let i = stack.length - 1; i >= 0; i--) if (frames[stack[i]].typeIdx >= 0) return frames[stack[i]].typeIdx;
        return -1;
    };

    // Type parsing over the token stream; collects type-position identifiers.
    const scratch: number[] = [];
    function parseType(q: number): number {
        if (!(q < N && T[q].k === K_IDENT && (!KEYWORDS.has(T[q].lc) || T[q].lc === 'void'))) return -1;
        scratch.push(q);
        q++;
        while (isP(q, '.') && isId(q + 1)) {
            scratch.push(q + 1);
            q += 2;
        }
        if (isP(q, '<')) {
            const mark = scratch.length;
            const r = parseTypeArgs(q);
            if (r > 0) q = r;
            else scratch.length = mark;
        }
        while (isP(q, '[') && isP(q + 1, ']')) q += 2;
        return q;
    }
    function parseTypeArgs(q: number): number {
        q++;
        for (;;) {
            const r = parseType(q);
            if (r < 0) return -1;
            q = r;
            if (isP(q, ',')) {
                q++;
                continue;
            }
            return isP(q, '>') ? q + 1 : -1;
        }
    }
    /** Commit scratch identifiers (from index `from`) as type references. */
    function commitTypeRefs(from: number): void {
        for (let i = from; i < scratch.length; i++) {
            const p = scratch[i];
            typeRefs.set(p, isP(p + 1, '.') && isId(p + 2) ? 2 : 1);
        }
        scratch.length = from;
    }
    const typeText = (a: number, b: number): string => {
        let s = '';
        for (let i = a; i < b; i++) s += T[i].t;
        return s;
    };
    const addVar = (f: Frame, name: string, v: VarInfo): void => {
        if (!f.vars) f.vars = new Map();
        const arr = f.vars.get(name);
        if (arr) arr.push(v);
        else f.vars.set(name, [v]);
    };
    const addMember = (typeIdx: number, lc: string, m: MemberInfo, method: boolean): void => {
        if (typeIdx < 0) return;
        const map = method ? types[typeIdx].methods : types[typeIdx].members;
        if (!map.has(lc)) map.set(lc, m);
    };
    /** Skip modifiers and annotations from q; returns [next index, modifier bits]. */
    const skipModifiers = (q: number): [number, number] => {
        let mods = 0;
        for (;;) {
            if (isP(q, '@') && q + 1 < N && T[q + 1].k === K_IDENT) {
                if (T[q + 1].lc === 'deprecated') mods |= M_DEPRECATED;
                skip.add(q + 1);
                q += 2;
                if (isP(q, '(')) q = matchClose(q, '(', ')') + 1;
                continue;
            }
            if (q < N && T[q].k === K_IDENT && MODIFIERS.has(T[q].lc)) {
                const lc = T[q].lc;
                if (lc === 'static') mods |= M_STATIC;
                else if (lc === 'final') mods |= M_READONLY;
                else if (lc === 'abstract') mods |= M_ABSTRACT;
                q++;
                continue;
            }
            return [q, mods];
        }
    };
    function matchClose(q: number, open: string, close: string): number {
        let d = 0;
        for (let i = q; i < N; i++) {
            if (T[i].k !== K_PUNCT) continue;
            if (T[i].t === open) d++;
            else if (T[i].t === close && --d === 0) return i;
        }
        return N - 1;
    }
    /** A parameter-ish declaration at q (`[final] [@Ann] Type name`); returns name index or -1. */
    const paramDecl = (q: number): { name: number; type: string; mods: number } | null => {
        const [s, mods] = skipModifiers(q);
        const mark = scratch.length;
        const r = parseType(s);
        if (r > 0 && isId(r) && (isP(r + 1, ',') || isP(r + 1, ')') || isP(r + 1, ':') || isP(r + 1, '=') || isP(r + 1, ';'))) {
            commitTypeRefs(mark);
            return { name: r, type: typeText(s, r), mods };
        }
        scratch.length = mark;
        return null;
    };

    let p = 0;
    // Trigger header: `trigger Name on SObject (before insert, …) {`
    if (N > 3 && T[0].lc === 'trigger' && isId(1) && T[2].lc === 'on' && isId(3)) {
        skip.add(0);
        const ti = types.length;
        types.push({ name: T[1].t, kind: T_CLASS, members: new Map(), methods: new Map() });
        typesByLc.set(T[1].lc, ti);
        decls.set(1, (T_CLASS << 8) | M_DECL);
        typeRefs.set(3, 1);
        p = 4;
        if (isP(p, '(')) {
            const close = matchClose(p, '(', ')');
            for (let i = p + 1; i < close; i++) skip.add(i);
            p = close + 1;
        }
        nextFrame = { kind: FK.Method };
        stmtStart = false;
    }

    while (p < N) {
        const tok = T[p];
        const f = cur();

        // SOQL / SOSL region: `[SELECT …]` / `[FIND …]` — skipped structurally.
        if (isP(p, '[') && p + 1 < N && (T[p + 1].lc === 'select' || T[p + 1].lc === 'find')) {
            const close = matchClose(p, '[', ']');
            soqlEnd.set(p, close);
            p = close + 1;
            stmtStart = false;
            continue;
        }

        // Parameter / for / catch declarations right after `(` or `,`.
        if (paramStart) {
            paramStart = false;
            const kind = parens[parens.length - 1];
            const d = paramDecl(p);
            if (d) {
                const v: VarInfo = { tt: kind === PAREN_PARAMS ? T_PARAMETER : T_VARIABLE, type: d.type, mods: d.mods & M_READONLY, decl: d.name };
                decls.set(d.name, (v.tt << 8) | M_DECL | v.mods);
                if (kind === PAREN_PARAMS) {
                    pendingParams ??= [];
                    pendingParams.push(v);
                    pendingParamNames.push(T[d.name].lc);
                } else {
                    pendingBlock ??= { vars: [], names: [] };
                    pendingBlock.vars.push(v);
                    pendingBlock.names.push(T[d.name].lc);
                }
                p = d.name + 1;
                continue;
            }
        }

        // Declarations at statement start.
        if (stmtStart && f.kind !== FK.Expr && f.kind !== FK.Prop && (tok.k === K_IDENT || isP(p, '@'))) {
            stmtStart = false;
            if (f.kind === FK.Type && types[f.typeIdx].kind === T_ENUM) {
                // Enum body: constants separated by commas.
                let q = p;
                while (q < N && !isP(q, '}') && !isP(q, ';')) {
                    if (isId(q)) {
                        decls.set(q, (T_ENUM_MEMBER << 8) | M_DECL);
                        addMember(f.typeIdx, T[q].lc, { tt: T_ENUM_MEMBER, mods: M_STATIC | M_READONLY }, false);
                    }
                    q++;
                }
                p = q;
                continue;
            }
            const [q, mods] = skipModifiers(p);
            const lcq = q < N ? T[q].lc : '';
            // Type declaration.
            if ((lcq === 'class' || lcq === 'interface' || lcq === 'enum') && isId(q + 1)) {
                const kind = lcq === 'class' ? T_CLASS : lcq === 'interface' ? T_INTERFACE : T_ENUM;
                const ti = types.length;
                const outer = enclosingType();
                types.push({ name: T[q + 1].t, kind, members: new Map(), methods: new Map() });
                if (!typesByLc.has(T[q + 1].lc)) typesByLc.set(T[q + 1].lc, ti);
                addMember(outer, T[q + 1].lc, { tt: kind, mods: 0, typeIdx: ti }, false);
                decls.set(q + 1, (kind << 8) | M_DECL | (mods & (M_ABSTRACT | M_DEPRECATED)));
                // extends / implements clauses
                let r = q + 2;
                while (r < N && !isP(r, '{') && !isP(r, ';')) {
                    if (isId(r) && T[r].lc !== 'extends' && T[r].lc !== 'implements') {
                        const mark = scratch.length;
                        const e = parseType(r);
                        if (e > 0) {
                            commitTypeRefs(mark);
                            r = e;
                            continue;
                        }
                        scratch.length = mark;
                    }
                    r++;
                }
                nextFrame = { kind: FK.Type, typeIdx: ti };
                p = r;
                continue;
            }
            // `when Type name {` (switch on type)
            if (lcq === 'when') {
                if (isId(q + 1)) {
                    const mark = scratch.length;
                    const r = parseType(q + 1);
                    if (r > 0 && isId(r) && isP(r + 1, '{')) {
                        commitTypeRefs(mark);
                        const v: VarInfo = { tt: T_VARIABLE, type: typeText(q + 1, r), mods: 0, decl: r };
                        decls.set(r, (T_VARIABLE << 8) | M_DECL);
                        pendingBlock = { vars: [v], names: [T[r].lc] };
                        p = r + 1;
                        continue;
                    }
                    scratch.length = mark;
                }
                p = q + 1;
                continue;
            }
            // Constructor: `[mods] TypeName(`
            const et = enclosingType();
            if (f.kind === FK.Type && et >= 0 && isId(q) && T[q].lc === types[et].name.toLowerCase() && isP(q + 1, '(')) {
                decls.set(q, (T_CLASS << 8) | M_DECL);
                parens.push(PAREN_PARAMS);
                paramStart = true;
                pendingParams = [];
                pendingParamNames = [];
                nextFrame = { kind: FK.Method };
                p = q + 2;
                continue;
            }
            const mark = scratch.length;
            const r = parseType(q);
            if (r > 0 && isId(r)) {
                const tText = typeText(q, r);
                const name = T[r].lc;
                if (isP(r + 1, '(')) {
                    // Method declaration.
                    commitTypeRefs(mark);
                    let m = mods & (M_STATIC | M_ABSTRACT | M_DEPRECATED);
                    if (f.kind === FK.Type && types[f.typeIdx].kind === T_INTERFACE) m |= M_ABSTRACT;
                    decls.set(r, (T_METHOD << 8) | M_DECL | m);
                    addMember(f.typeIdx, name, { tt: T_METHOD, mods: m, type: tText }, true);
                    parens.push(PAREN_PARAMS);
                    paramStart = true;
                    pendingParams = [];
                    pendingParamNames = [];
                    nextFrame = { kind: FK.Method };
                    p = r + 2;
                    continue;
                }
                if (isP(r + 1, '{') && f.kind === FK.Type) {
                    commitTypeRefs(mark);
                    const m = mods & (M_STATIC | M_DEPRECATED | M_ABSTRACT);
                    decls.set(r, (T_PROPERTY << 8) | M_DECL | m);
                    addMember(f.typeIdx, name, { tt: T_PROPERTY, mods: m, type: tText }, false);
                    nextFrame = { kind: FK.Prop };
                    p = r + 1;
                    continue;
                }
                if (isP(r + 1, '=') || isP(r + 1, ';') || isP(r + 1, ',')) {
                    commitTypeRefs(mark);
                    const field = f.kind === FK.Type;
                    const m = field ? mods & (M_STATIC | M_READONLY | M_DEPRECATED) : mods & M_READONLY;
                    declState = { type: tText, mods: m, field, depth: parenDepth() };
                    declareVar(r, tText, m, field, f);
                    p = r + 1;
                    continue;
                }
            }
            scratch.length = mark;
            // not a declaration: fall through to generic handling of T[p]
        }

        if (tok.k === K_PUNCT) {
            const ch = tok.t;
            if (ch !== '{' && ch !== '}' && ch !== ';') stmtStart = false;
            if (ch === '{') {
                let kind: FK;
                let typeIdx = -1;
                const prev = p > 0 ? T[p - 1] : undefined;
                if (nextFrame) {
                    kind = nextFrame.kind;
                    typeIdx = nextFrame.typeIdx ?? -1;
                } else if (f.kind === FK.Prop) {
                    kind = FK.Method; // get { … } / set { … }
                } else if (prev && prev.k === K_PUNCT && (prev.t === '>' || prev.t === ']')) {
                    kind = FK.Expr; // new List<X>{…} / new X[]{…}
                } else if (f.kind === FK.Expr) {
                    kind = FK.Expr;
                } else {
                    kind = FK.Block;
                }
                const id = frames.length;
                const fr: Frame = { kind, parent: stack[stack.length - 1], typeIdx, vars: null, parenBase: parens.length };
                frames.push(fr);
                braceFrame.set(p, id);
                if (kind === FK.Method && pendingParams) {
                    pendingParams.forEach((v, i) => addVar(fr, pendingParamNames[i], v));
                }
                if (kind === FK.Method && f.kind === FK.Prop && prev && prev.lc === 'set') {
                    addVar(fr, 'value', { tt: T_PARAMETER, type: '', mods: 0, decl: -1 });
                }
                if (pendingBlock && kind !== FK.Method && kind !== FK.Type) {
                    pendingBlock.vars.forEach((v, i) => addVar(fr, pendingBlock!.names[i], v));
                }
                pendingBlock = null;
                pendingParams = null;
                nextFrame = null;
                stack.push(id);
                stmtStart = kind !== FK.Expr;
                if (kind !== FK.Expr) declState = null;
                p++;
                continue;
            }
            if (ch === '}') {
                if (stack.length > 1) {
                    const closed = frames[stack.pop() as number];
                    parens.length = Math.min(parens.length, closed.parenBase);
                    if (closed.kind !== FK.Expr) declState = null;
                }
                stmtStart = cur().kind !== FK.Expr;
                p++;
                continue;
            }
            if (ch === ';') {
                if (parenDepth() <= 0) {
                    stmtStart = true;
                    declState = null;
                    nextFrame = null;
                    pendingParams = null;
                    if (pendingBlock) flushPendingBlock();
                }
                p++;
                continue;
            }
            if (ch === '(') {
                const prevLc = p > 0 ? T[p - 1].lc : '';
                const kind = prevLc === 'for' ? PAREN_FOR : prevLc === 'catch' ? PAREN_CATCH : PAREN_NONE;
                // Cast: `(Type) expr` — only where an expression may start.
                if (kind === PAREN_NONE && isCastContext(p)) {
                    const mark = scratch.length;
                    const r = parseType(p + 1);
                    if (r > 0 && isP(r, ')') && castFollows(r + 1)) commitTypeRefs(mark);
                    else scratch.length = mark;
                }
                parens.push(kind);
                if (kind !== PAREN_NONE) paramStart = true;
                p++;
                continue;
            }
            if (ch === ')') {
                if (parens.length > cur().parenBase) {
                    const kind = parens.pop();
                    if ((kind === PAREN_FOR || kind === PAREN_CATCH) && pendingBlock && !isP(p + 1, '{')) flushPendingBlock();
                }
                p++;
                continue;
            }
            if (ch === ',') {
                const top = parens.length > cur().parenBase ? parens[parens.length - 1] : PAREN_NONE;
                if (top === PAREN_PARAMS || top === PAREN_CATCH) paramStart = true;
                else if (declState && parenDepth() === declState.depth && isId(p + 1) &&
                    (isP(p + 2, '=') || isP(p + 2, ',') || isP(p + 2, ';'))) {
                    declareVar(p + 1, declState.type, declState.mods, declState.field, cur());
                    p += 2;
                    continue;
                }
                p++;
                continue;
            }
            p++;
            continue;
        }

        if (tok.k === K_IDENT) {
            if (tok.lc === 'new' || tok.lc === 'instanceof') {
                const mark = scratch.length;
                const r = parseType(p + 1);
                if (r > 0) {
                    commitTypeRefs(mark);
                    // `new Account(Name = 'x', Industry = y)` — name/value-pair constructor
                    if (tok.lc === 'new' && r === p + 2 && isP(r, '(') && isSObject(T[p + 1].lc)) {
                        const close = matchClose(r, '(', ')');
                        let depth = 0;
                        for (let i = r; i < close; i++) {
                            if (T[i].k === K_PUNCT) {
                                if (T[i].t === '(') depth++;
                                else if (T[i].t === ')') depth--;
                                continue;
                            }
                            if (depth === 1 && T[i].k === K_IDENT && (isP(i - 1, '(') || isP(i - 1, ',')) &&
                                isP(i + 1, '=') && !isP(i + 2, '=')) {
                                ctorFields.set(i, T[p + 1].t);
                            }
                        }
                    }
                    p = r;
                    continue;
                }
                scratch.length = mark;
            }
        }
        p++;
    }

    function flushPendingBlock(): void {
        if (!pendingBlock) return;
        const fr = cur();
        pendingBlock.vars.forEach((v, i) => addVar(fr, pendingBlock!.names[i], v));
        pendingBlock = null;
    }
    function declareVar(nameTok: number, type: string, mods: number, field: boolean, fr: Frame): void {
        const lc = T[nameTok].lc;
        if (field) {
            decls.set(nameTok, (T_PROPERTY << 8) | M_DECL | mods);
            addMember(fr.typeIdx, lc, { tt: T_PROPERTY, mods, type }, false);
        } else {
            decls.set(nameTok, (T_VARIABLE << 8) | M_DECL | mods);
            addVar(fr, lc, { tt: T_VARIABLE, type, mods, decl: nameTok });
        }
    }
    function isCastContext(q: number): boolean {
        if (q === 0) return true;
        const prev = T[q - 1];
        if (prev.k === K_IDENT) return prev.lc === 'return' || prev.lc === 'throw' || prev.lc === 'else';
        if (prev.k === K_LIT) return false;
        return prev.t !== ')' && prev.t !== ']';
    }
    function castFollows(q: number): boolean {
        if (q >= N) return false;
        const t = T[q];
        if (t.k === K_LIT) return true;
        if (t.k === K_IDENT) return !KEYWORDS.has(t.lc) || t.lc === 'this' || t.lc === 'new' || t.lc === 'super';
        return t.t === '(' || t.t === '[';
    }

    // ── Pass 2: classification ──
    const recv = new Map<number, Recv>();
    const typeRecvMemo = new Map<string, Recv | null>();
    const stack2: number[] = [0];

    /** Resolve a type name (bare identifier) to its token + receiver kind. */
    function resolveTypeName(lc: string, orig: string): { tt: number; mods: number; r: Recv } | null {
        const ti = typesByLc.get(lc);
        if (ti !== undefined) return { tt: types[ti].kind, mods: 0, r: { k: 'userStatic', typeIdx: ti, name: types[ti].name } };
        if (STD_NAMESPACES.has(lc)) return { tt: T_NAMESPACE, mods: M_STDLIB, r: { k: 'ns', name: lc } };
        if (stdTypeName(lc) || EXTRA_STD_TYPES.has(lc)) return { tt: T_CLASS, mods: M_STDLIB, r: { k: 'stdStatic', name: lc } };
        if (env.isWorkspaceType(lc)) return { tt: T_CLASS, mods: 0, r: { k: 'value', name: lc } };
        if (isSObject(lc)) return { tt: T_TYPE, mods: M_SOBJECT, r: { k: 'sobjStatic', name: orig } };
        return null;
    }
    /** What a value of declared type `type` is, as a receiver. */
    function valueRecv(type: string): Recv {
        let hit = typeRecvMemo.get(type);
        if (hit !== undefined) return hit ?? { k: 'value' };
        const lc = type.toLowerCase().replace(/\s+/g, '');
        if (lc.endsWith(']') || lc.includes('<')) hit = { k: 'value', name: lc };
        else {
            const base = lc.slice(lc.lastIndexOf('.') + 1);
            const ti = typesByLc.get(base);
            if (ti !== undefined) hit = { k: 'user', typeIdx: ti };
            else if (stdTypeName(base) || EXTRA_STD_TYPES.has(base)) hit = { k: 'std', name: base };
            else if (base !== 'sobject' && isSObject(base)) {
                const o = type.replace(/\s+/g, '');
                hit = { k: 'sobj', name: o.slice(o.lastIndexOf('.') + 1) }; // original case for the host
            }
            else hit = { k: 'value', name: lc };
        }
        typeRecvMemo.set(type, hit);
        return hit;
    }
    /** Element type of a collection type text: `List<X>` / `X[]` → X. */
    function elementType(type: string): string | undefined {
        const t = type.replace(/\s+/g, '');
        if (t.endsWith('[]')) return t.slice(0, -2);
        const m = /^(?:list|set)<(.+)>$/i.exec(t);
        if (m) return m[1];
        const mm = /^map<[^,<>]+,(.+)>$/i.exec(t);
        return mm ? mm[1] : undefined;
    }
    function lookupVar(lc: string, at: number): VarInfo | undefined {
        for (let i = stack2.length - 1; i >= 0; i--) {
            const fr = frames[stack2[i]];
            const arr = fr.vars?.get(lc);
            if (arr) {
                for (let j = arr.length - 1; j >= 0; j--) if (arr[j].decl < at) return arr[j];
            }
        }
        return undefined;
    }
    function lookupMember(lc: string, call: boolean): MemberInfo | undefined {
        for (let i = stack2.length - 1; i >= 0; i--) {
            const ti = frames[stack2[i]].typeIdx;
            if (ti < 0) continue;
            const m = (call ? types[ti].methods : types[ti].members).get(lc);
            if (m) return m;
        }
        return undefined;
    }
    function memberRecv(m: MemberInfo): Recv | undefined {
        if (m.typeIdx !== undefined) return { k: 'userStatic', typeIdx: m.typeIdx };
        if (m.type) return valueRecv(m.type);
        return undefined;
    }
    /** The receiver denoted by the token just before a `.` at q-1 (q = the member). */
    function receiverOf(q: number): Recv | undefined {
        const r = q - 2;
        if (r < 0) return undefined;
        const t = T[r];
        if (t.k === K_IDENT) {
            if (t.lc === 'this') {
                const ti = enclosingType2();
                return ti >= 0 ? { k: 'user', typeIdx: ti } : undefined;
            }
            return recv.get(r);
        }
        if (t.k === K_PUNCT && t.t === ']') {
            // `xs[i].member` → element type of xs
            let d = 0;
            for (let i = r; i >= 0; i--) {
                if (T[i].k !== K_PUNCT) continue;
                if (T[i].t === ']') d++;
                else if (T[i].t === '[' && --d === 0) {
                    const base = i - 1;
                    if (base >= 0 && T[base].k === K_IDENT) {
                        const v = varTypes.get(base);
                        const el = v ? elementType(v) : undefined;
                        return el ? valueRecv(el) : undefined;
                    }
                    return undefined;
                }
            }
        }
        return undefined;
    }
    function enclosingType2(): number {
        for (let i = stack2.length - 1; i >= 0; i--) if (frames[stack2[i]].typeIdx >= 0) return frames[stack2[i]].typeIdx;
        return -1;
    }
    const varTypes = new Map<number, string>(); // identifier token → declared type (for `xs[i].`)

    /** SObject field access `member` on SObject `sobj`; sets the member's receiver for hops. */
    function sobjectMember(q: number, sobj: string, isStatic: boolean): void {
        const lc = T[q].lc;
        const st = isStatic ? M_STATIC : 0;
        if (isStatic && (lc === 'sobjecttype' || lc === 'fields')) {
            emit(q, T_PROPERTY, M_STATIC | M_STDLIB);
            return;
        }
        // A describe is only worth fetching to walk a relationship hop (`c.Account.Name`).
        const d = env.describe(sobj, isP(q + 1, '.'));
        if (d) {
            if (d.fields.has(lc)) {
                emit(q, T_PROPERTY, M_SOBJECT_FIELD | st);
                return;
            }
            const target = d.rels.get(lc);
            if (target) {
                emit(q, T_PROPERTY, M_SOBJECT_FIELD | st);
                if (!isStatic) recv.set(q, { k: 'sobj', name: target });
                return;
            }
            if (d.children.has(lc)) {
                emit(q, T_PROPERTY, M_SOBJECT_FIELD | st);
                return;
            }
            emit(q, T_PROPERTY, st); // not in the describe (diagnostics flag it)
            return;
        }
        emit(q, T_PROPERTY, M_SOBJECT_FIELD | st);
    }

    function classify(q: number): void {
        const t = T[q];
        const prevDot = isP(q - 1, '.');
        const call = isP(q + 1, '(');
        if (!prevDot) {
            const v = lookupVar(t.lc, q);
            if (v) {
                emit(q, v.tt, v.mods);
                if (v.type) {
                    recv.set(q, valueRecv(v.type));
                    varTypes.set(q, v.type);
                }
                return;
            }
            const m = lookupMember(t.lc, call);
            if (m) {
                emit(q, m.tt, m.mods);
                const r = memberRecv(m);
                if (r) recv.set(q, r);
                if (m.type) varTypes.set(q, m.type);
                return;
            }
            if (call) {
                emit(q, T_METHOD, 0);
                return;
            }
            const ty = resolveTypeName(t.lc, t.t);
            if (ty) {
                emit(q, ty.tt, ty.mods);
                recv.set(q, ty.r);
            }
            return;
        }
        // member access `receiver.member`
        const r = receiverOf(q);
        if (!r) return;
        if (call) {
            let mods = 0;
            if (r.k === 'userStatic' || r.k === 'stdStatic' || r.k === 'sobjStatic' || r.k === 'ns') mods |= M_STATIC;
            if (r.k === 'std' || r.k === 'stdStatic' || r.k === 'ns' || r.k === 'sobj' || r.k === 'sobjStatic') mods |= M_STDLIB;
            if ((r.k === 'user' || r.k === 'userStatic') && r.typeIdx !== undefined) {
                const m = types[r.typeIdx].methods.get(t.lc);
                if (m) mods = m.mods;
            }
            emit(q, T_METHOD, mods);
            return;
        }
        switch (r.k) {
            case 'sobj':
                sobjectMember(q, r.name as string, false);
                return;
            case 'sobjStatic':
                sobjectMember(q, r.name as string, true);
                return;
            case 'user':
            case 'userStatic': {
                const m = types[r.typeIdx as number].members.get(t.lc);
                if (m) {
                    emit(q, m.tt, m.mods);
                    const mr = memberRecv(m);
                    if (mr) recv.set(q, mr);
                } else if (r.k === 'user') emit(q, T_PROPERTY, 0);
                return;
            }
            case 'ns': {
                // `System.Url`, `Schema.SObjectType`, `Database.SaveResult` …
                if (stdTypeName(t.lc) || EXTRA_STD_TYPES.has(t.lc) || /^[A-Z]/.test(t.t)) {
                    emit(q, T_CLASS, M_STDLIB);
                    recv.set(q, { k: 'stdStatic', name: t.lc });
                }
                return;
            }
            case 'stdStatic':
                // `Trigger.newMap`, `Schema.SObjectType.Account`, `Database.SaveResult` …
                emit(q, T_PROPERTY, M_STATIC | M_STDLIB);
                recv.set(q, { k: 'value' });
                return;
            case 'std':
            case 'value':
                emit(q, T_PROPERTY, 0);
                return;
        }
    }

    function classifyType(q: number, qualifier: boolean): void {
        const lc = T[q].lc;
        if (isP(q - 1, '.')) {
            // segment after a qualifier
            const r = receiverOf(q);
            if (r && r.k === 'ns') {
                emit(q, T_CLASS, M_STDLIB);
                recv.set(q, { k: 'stdStatic', name: lc });
                return;
            }
            if (r && r.k === 'userStatic' && r.typeIdx !== undefined) {
                const m = types[r.typeIdx].members.get(lc);
                if (m && m.typeIdx !== undefined) {
                    emit(q, m.tt, 0);
                    recv.set(q, { k: 'userStatic', typeIdx: m.typeIdx });
                    return;
                }
            }
            if (r && r.k === 'sobjStatic') {
                emit(q, T_TYPE, M_SOBJECT); // e.g. Schema.Account (rare)
                return;
            }
            if (!qualifier) emit(q, T_CLASS, r && (r.k === 'stdStatic') ? M_STDLIB : 0);
            return;
        }
        if (lc === 'void') return;
        const ty = resolveTypeName(lc, T[q].t);
        if (ty) {
            emit(q, ty.tt, ty.mods);
            recv.set(q, ty.r);
            return;
        }
        if (!qualifier) emit(q, T_CLASS, 0); // syntactically a type (managed package, inherited inner …)
    }

    for (let q = 0; q < N; q++) {
        const t = T[q];
        if (t.k === K_PUNCT) {
            if (t.t === '{') {
                const id = braceFrame.get(q);
                if (id !== undefined) stack2.push(id);
            } else if (t.t === '}') {
                if (stack2.length > 1) stack2.pop();
            } else if (t.t === '[') {
                const end = soqlEnd.get(q);
                if (end !== undefined) {
                    soqlRegion(q, end, T, env, isP, isId, emit, (b) => {
                        if (T[b].k === K_IDENT && !KEYWORDS.has(T[b].lc)) classify(b);
                    });
                    q = end;
                }
            }
            continue;
        }
        if (t.k !== K_IDENT || skip.has(q)) continue;
        if (isP(q - 1, '@')) continue; // annotation name
        const d = decls.get(q);
        if (d !== undefined) {
            emit(q, d >> 8, d & 0xff);
            // declared variables/fields act as receivers within their own initializers
            continue;
        }
        if (KEYWORDS.has(t.lc)) continue;
        const cf = ctorFields.get(q);
        if (cf !== undefined) {
            const dsc = env.describe(cf);
            emit(q, T_PROPERTY, !dsc || dsc.fields.has(t.lc) || dsc.rels.has(t.lc) ? M_SOBJECT_FIELD : 0);
            continue;
        }
        const fr = frames[stack2[stack2.length - 1]];
        if (fr.kind === FK.Prop && (t.lc === 'get' || t.lc === 'set')) continue;
        const tr = typeRefs.get(q);
        if (tr !== undefined) {
            classifyType(q, tr === 2);
            continue;
        }
        classify(q);
    }
    return out;
}

/**
 * Classify a SOQL region: tokens (a, b) exclusive (a = `[` or -1, b = `]` or N).
 * `bind(q)` classifies an Apex bind identifier (`:var`).
 */
function soqlRegion(
    a: number,
    b: number,
    T: Tok[],
    env: TokenEnv,
    isP: (p: number, ch: string) => boolean,
    isId: (p: number) => boolean,
    emit: (p: number, tt: number, mods: number) => void,
    bind: (q: number) => void,
): void {
    if (a + 1 < b && T[a + 1].lc === 'find') {
        // SOSL: only bind expressions are classified.
        for (let q = a + 1; q < b; q++) if (isP(q, ':') && q + 1 < b) bind(q + 1);
        return;
    }
    interface QFrame {
        obj: string | null; // resolved SObject (lower-case) the field paths are relative to
        alias: string | null;
        depth: number;
        fromIdx: number; // index of this query's FROM object token
        aliasIdx: number;
        afterFrom: boolean;
        childRel: boolean;
    }
    const frames: QFrame[] = [];
    let depth = 0;

    const findFrom = (start: number): number => {
        let d = 0;
        for (let q = start; q < b; q++) {
            const t = T[q];
            if (t.k === K_PUNCT) {
                if (t.t === '(') d++;
                else if (t.t === ')') {
                    if (--d < 0) return -1;
                }
                continue;
            }
            if (d === 0 && t.k === K_IDENT && t.lc === 'from') return q + 1 < b && T[q + 1].k === K_IDENT ? q + 1 : -1;
        }
        return -1;
    };
    const describeOf = (sobj: string | null): DescribeIndex | null | undefined => (sobj ? env.describe(sobj, true) : null);
    const pushFrame = (selectIdx: number, outer: QFrame | undefined): void => {
        const fromIdx = findFrom(selectIdx + 1);
        let obj: string | null = null;
        let childRel = false;
        let aliasIdx = -1;
        if (fromIdx >= 0) {
            const name = T[fromIdx].lc;
            if (outer && !outer.afterFrom) {
                // SELECT-list subquery: FROM <child relationship>
                childRel = true;
                const d = describeOf(outer.obj);
                obj = d ? d.children.get(name) ?? null : null;
            } else {
                obj = T[fromIdx].t;
            }
            const al = fromIdx + 1;
            if (al < b && isId(al) && !SOQL_KEYWORDS.has(T[al].lc)) aliasIdx = al;
        }
        frames.push({
            obj,
            alias: aliasIdx >= 0 ? T[aliasIdx].lc : null,
            depth,
            fromIdx,
            aliasIdx,
            afterFrom: false,
            childRel,
        });
    };

    for (let q = a + 1; q < b; q++) {
        const t = T[q];
        if (t.k === K_PUNCT) {
            if (t.t === '(') {
                depth++;
                if (q + 1 < b && T[q + 1].lc === 'select') {
                    pushFrame(q + 1, frames[frames.length - 1]);
                    q++;
                }
            } else if (t.t === ')') {
                depth--;
                while (frames.length && frames[frames.length - 1].depth > depth) frames.pop();
            } else if (t.t === ':') {
                // Apex bind: `:var`, `:obj.Field`, `:xs.size()`
                let r = q + 1;
                while (r < b && T[r].k === K_IDENT) {
                    bind(r);
                    if (isP(r + 1, '.') && r + 2 < b && T[r + 2].k === K_IDENT) r += 2;
                    else break;
                }
                q = r;
            }
            continue;
        }
        if (t.k !== K_IDENT) continue;
        if (!frames.length) {
            if (t.lc === 'select') pushFrame(q, undefined);
            continue;
        }
        const fr = frames[frames.length - 1];
        if (q === fr.fromIdx) {
            fr.afterFrom = true;
            emit(q, fr.childRel ? T_PROPERTY : T_TYPE, fr.childRel ? M_SOBJECT_FIELD : M_SOBJECT);
            continue;
        }
        if (q === fr.aliasIdx) continue;
        if (t.lc === 'from') continue;
        if (SOQL_KEYWORDS.has(t.lc)) continue;
        if (isP(q + 1, '(') || isP(q + 1, ':')) continue; // function / date literal with N
        if (isP(q - 1, ')')) continue; // aggregate alias: COUNT(Id) cnt
        // Field path: seg(.seg)*
        let cur: string | null = fr.obj;
        let r = q;
        let first = true;
        for (;;) {
            const seg = T[r].lc;
            const more = isP(r + 1, '.') && r + 2 < b && T[r + 2].k === K_IDENT;
            if (first && more && (seg === fr.alias || (cur !== null && seg === cur.toLowerCase()))) {
                // leading alias / object name qualifier
                if (seg !== fr.alias) emit(r, T_TYPE, M_SOBJECT);
            } else if (more) {
                emit(r, T_PROPERTY, M_SOBJECT_FIELD);
                const d = describeOf(cur);
                cur = d ? d.rels.get(seg) ?? null : null;
            } else {
                emit(r, T_PROPERTY, M_SOBJECT_FIELD);
            }
            first = false;
            if (!more) break;
            r += 2;
        }
        q = r;
    }
}

// ─── Encoding helpers ────────────────────────────────────────────────────────────

/** Re-encode the tokens of `data` whose line lies in [startLine, endLine]. */
export function sliceLines(data: number[], startLine: number, endLine: number): number[] {
    const out: number[] = [];
    let line = 0;
    let col = 0;
    let pl = 0;
    let pc = 0;
    for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        col = data[i] === 0 ? col + data[i + 1] : data[i + 1];
        if (line < startLine) continue;
        if (line > endLine) break;
        const dl = line - pl;
        out.push(dl, dl === 0 ? col - pc : col, data[i + 2], data[i + 3], data[i + 4]);
        pl = line;
        pc = col;
    }
    return out;
}

/** One prefix/suffix edit turning `prev` into `next` (on whole 5-int tokens). */
export function diffTokens(prev: number[], next: number[]): { start: number; deleteCount: number; data: number[] }[] {
    let s = 0;
    const max = Math.min(prev.length, next.length);
    while (s < max && prev[s] === next[s]) s++;
    s -= s % 5;
    let e = 0;
    while (e < max - s && prev[prev.length - 1 - e] === next[next.length - 1 - e]) e++;
    e -= e % 5;
    if (s === prev.length && s === next.length) return [];
    return [{ start: s, deleteCount: prev.length - s - e, data: next.slice(s, next.length - e) }];
}

// ─── LSP wiring ──────────────────────────────────────────────────────────────────

const MAX_DOC_CACHE = 30;
const MAX_DESCRIBE_INDEX = 300;
const MAX_OBJECT_LISTS = 20;
/** Background describes started per tokenization pass (bounded — never a burst). */
const MAX_FETCH_PER_PASS = 5;
/** Queue cap across all documents. */
const MAX_FETCH_QUEUE = 20;
const REFRESH_DEBOUNCE_MS = 400;
const OBJECT_LIST_WAIT_MS = 300;

interface DocEntry {
    version: number;
    gen: number;
    resultId: string;
    data: number[];
}

function toIndex(d: HostDescribe): DescribeIndex {
    const fields = new Set<string>();
    const rels = new Map<string, string>();
    const children = new Map<string, string>();
    for (const f of d.fields ?? []) {
        fields.add(f.name.toLowerCase());
        if (f.relationshipName && f.referenceTo && f.referenceTo.length) rels.set(f.relationshipName.toLowerCase(), f.referenceTo[0]);
    }
    for (const c of d.childRelationships ?? []) if (c.name) children.set(c.name.toLowerCase(), c.childSObject);
    // namespace-optional aliases (`Amount__c` ≈ `ns__Amount__c`)
    for (const s of [fields]) {
        for (const n of [...s]) {
            const p = n.split('__');
            if (p.length >= 3) s.add(p.slice(1).join('__'));
        }
    }
    for (const m of [rels, children]) {
        for (const [n, v] of [...m]) {
            const p = n.split('__');
            if (p.length >= 3) m.set(p.slice(1).join('__'), v);
        }
    }
    return { fields, rels, children };
}

export function register(connection: Connection, ctx: ServerContext): void {
    const docCache = new Map<string, DocEntry>();
    // Schema knowledge, per org context.
    const describeIdx = new Map<string, DescribeIndex | null>(); // `${orgCtx}|${lc}`
    const objectLists = new Map<string, Set<string>>(); // orgCtx → lower-cased names
    const objectListInflight = new Map<string, Promise<void>>();
    const fetchQueue: { uri: string; sobject: string; key: string }[] = [];
    const queued = new Set<string>();
    let fetching = false;
    let gen = 0; // bumped whenever schema knowledge changes → cached tokens are stale
    let resultSeq = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let wsReadyHooked = false;

    const enabled = (): boolean => ctx.settings.apexSemanticHighlighting !== false;

    const scheduleRefresh = (): void => {
        gen++;
        if (!ctx.settings.semanticTokensRefreshSupport) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            // Only when something the client holds was computed with older knowledge.
            let stale = false;
            for (const e of docCache.values()) if (e.gen !== gen) stale = true;
            if (!stale) return;
            // Typed `void` in vscode-languageserver 9, but it is a request: swallow a rejection.
            const sent: unknown = connection.languages.semanticTokens.refresh();
            (sent as Promise<void> | undefined)?.catch?.(() => undefined);
        }, REFRESH_DEBOUNCE_MS);
    };

    const pump = async (): Promise<void> => {
        if (fetching) return;
        fetching = true;
        let changed = false;
        try {
            while (fetchQueue.length) {
                const job = fetchQueue.shift()!;
                queued.delete(job.key);
                let d: HostDescribe | null = null;
                try {
                    d = await ctx.schema.describe(job.uri, job.sobject);
                } catch {
                    d = null;
                }
                lruSet(describeIdx, job.key, d ? toIndex(d) : null, MAX_DESCRIBE_INDEX);
                if (d) changed = true;
            }
        } finally {
            fetching = false;
        }
        if (changed) scheduleRefresh();
    };

    const ensureObjectList = (uri: string, orgCtx: string): Promise<void> => {
        if (objectLists.has(orgCtx)) return Promise.resolve();
        let p = objectListInflight.get(orgCtx);
        if (!p) {
            p = ctx.schema
                .objectList(uri)
                .then(
                    (list) => {
                        lruSet(objectLists, orgCtx, new Set(list.map((s) => s.toLowerCase())), MAX_OBJECT_LISTS);
                        if (list.length) scheduleRefresh();
                    },
                    () => undefined,
                )
                .finally(() => objectListInflight.delete(orgCtx));
            objectListInflight.set(orgCtx, p);
        }
        return p;
    };

    const compute = (doc: TextDocument): number[] => {
        const uri = doc.uri;
        const orgCtx = ctx.schema.orgContext(uri);
        const list = objectLists.get(orgCtx);
        const stubs = stubbedObjectNames();
        let started = 0;
        const env: TokenEnv = {
            isSObject: (lc) => !!list?.has(lc) || stubs.has(lc),
            isWorkspaceType: (lc) => WorkspaceIndex.hasType(lc),
            describe: (sobject, fetch) => {
                const key = `${orgCtx}|${sobject.toLowerCase()}`;
                const hit = lruGet(describeIdx, key);
                if (hit !== undefined) return hit;
                if (fetch && !queued.has(key) && started < MAX_FETCH_PER_PASS && fetchQueue.length < MAX_FETCH_QUEUE) {
                    started++;
                    queued.add(key);
                    fetchQueue.push({ uri, sobject, key });
                }
                return undefined;
            },
        };
        const soqlOnly = doc.languageId === 'soql' || /\.soql$/i.test(uri);
        const data = computeApexTokens(doc.getText(), env, soqlOnly);
        if (fetchQueue.length) void pump();
        return data;
    };

    const isTarget = (doc: TextDocument): boolean =>
        doc.languageId === 'soql' || /\.soql$/i.test(doc.uri) || isApex(doc.uri) || doc.languageId === 'apex' || doc.languageId === 'apex-anon';

    /** Tokens for the document's current version (cached), waiting briefly for the object list once. */
    const tokensFor = async (doc: TextDocument, token?: CancellationToken): Promise<DocEntry | null> => {
        if (!wsReadyHooked) {
            wsReadyHooked = true;
            // Workspace type names arrive with the initial scan → recolor once it's done.
            void WorkspaceIndex.ready().then(() => scheduleRefresh(), () => undefined);
        }
        const orgCtx = ctx.schema.orgContext(doc.uri);
        if (!objectLists.has(orgCtx)) {
            await Promise.race([
                ensureObjectList(doc.uri, orgCtx),
                new Promise<void>((r) => setTimeout(r, OBJECT_LIST_WAIT_MS)),
            ]);
        }
        if (token?.isCancellationRequested) return null;
        const live = ctx.documents.get(doc.uri) ?? doc;
        const hit = lruGet(docCache, live.uri);
        if (hit && hit.version === live.version && hit.gen === gen) return hit;
        const entry: DocEntry = { version: live.version, gen, resultId: String(++resultSeq), data: compute(live) };
        lruSet(docCache, live.uri, entry, MAX_DOC_CACHE);
        return entry;
    };

    const EMPTY: SemanticTokens = { data: [] };

    connection.languages.semanticTokens.on(async (params, token) => {
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !enabled() || !isTarget(doc)) return EMPTY;
        const e = await tokensFor(doc, token);
        return e ? { resultId: e.resultId, data: e.data } : EMPTY;
    });

    connection.languages.semanticTokens.onDelta(async (params, token): Promise<SemanticTokens | SemanticTokensDelta> => {
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !enabled() || !isTarget(doc)) return EMPTY;
        const prev = docCache.get(doc.uri);
        const e = await tokensFor(doc, token);
        if (!e) return EMPTY;
        if (prev && prev.resultId === params.previousResultId) {
            if (prev === e) return { resultId: e.resultId, edits: [] };
            return { resultId: e.resultId, edits: diffTokens(prev.data, e.data) };
        }
        return { resultId: e.resultId, data: e.data };
    });

    connection.languages.semanticTokens.onRange(async (params, token) => {
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !enabled() || !isTarget(doc)) return EMPTY;
        const e = await tokensFor(doc, token);
        // Range results carry no resultId (they are not a base for deltas).
        return e ? { data: sliceLines(e.data, params.range.start.line, params.range.end.line) } : EMPTY;
    });

    ctx.documents.onDidClose((ev) => docCache.delete(ev.document.uri));

    ctx.onSchemaRefresh((objects) => {
        if (objects) {
            const lower = new Set(objects.map((o) => o.toLowerCase()));
            for (const k of [...describeIdx.keys()]) {
                const name = k.slice(k.lastIndexOf('|') + 1);
                const p = name.split('__');
                if (lower.has(name) || (p.length >= 3 && lower.has(p.slice(1).join('__')))) describeIdx.delete(k);
            }
            // created/deleted objects → re-fetch the object lists lazily
            objectLists.clear();
        } else {
            describeIdx.clear();
            objectLists.clear();
        }
        scheduleRefresh();
    });

    ctx.onRelease(() => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = undefined;
        docCache.clear();
        describeIdx.clear();
        objectLists.clear();
        objectListInflight.clear();
        fetchQueue.length = 0;
        queued.clear();
    });
}
