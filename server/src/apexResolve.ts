/**
 * Expression-type resolution for Apex completion (and hover).
 *
 * `receiverExprBefore` extracts the receiver of a member access from the live text by
 * scanning backwards from the `.` over identifiers, dots and balanced `(…)` / `[…]`
 * groups (so `byAcc.get(acc.Id)[0].` yields `byAcc.get(acc.Id)[0]`). `Resolver`
 * then types that expression step by step:
 *
 *   roots     locals/params/fields (scope-aware, latest parse then last error-free
 *             parse), inherited fields, `this`, `super`, same-class method calls,
 *             type names (static access), `new T(…)`, casts, string literals, inline SOQL,
 *             `Trigger`, `SObjectType`
 *   steps     user members (same file + workspace, with inheritance), standard-library
 *             members with generic substitution (`Map<K,V>.get` → V), `[i]` on lists,
 *             `Outer.Inner`, enum values, SObject relationships / child relationships /
 *             fields / SObject methods, `Schema.SObjectType.Account.fields`,
 *             `Account.SObjectType.getDescribe()`
 *
 * It never describes a name that isn't an org object: workspace / same-file types,
 * standard types, primitives and dotted names resolve without the org, and SObject
 * candidates are checked against the org's object list first.
 */
import type { CancellationToken } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'url';
import type { ServerContext } from './context';
import { ApexMember, ApexTypeDecl, ApexIndex, resolveScopedVarType, enclosingClass, visibleVars, VarDecl } from './apexSymbols';
import type { ParseView } from './parseCache';
import { WorkspaceIndex, FileTypes, membersNamed } from './workspaceIndex';
import { stdClass, StdClass, StdMember, ENUM_INSTANCE_MEMBERS, enumStaticMethods, stdNestedTypes } from './apexStdlib';
import type { HostDescribe, HostField } from './schema';
import { throwIfCancelled } from './cancel';
import { hasNamespacePrefix, nameMatchesNsOptional, regexReceiverType } from './textUtil';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type RType =
    | { k: 'user'; ft: FileTypes; decl: ApexTypeDecl; local: boolean }
    | { k: 'std'; cls: StdClass; args: string[]; obj?: string }
    | { k: 'sobject'; name: string }
    | { k: 'sobjectTypes' }
    | { k: 'describe'; obj: string }
    | { k: 'fields'; obj: string }
    | { k: 'trigger'; obj: string };

/** A typed expression value: the type, and whether it denotes the type itself (static access). */
export interface RValue {
    t: RType;
    static: boolean;
}

/** One completable member of a resolved receiver. */
export type MemberEntry =
    | { src: 'user'; owner: string; m: ApexMember; inherited: boolean }
    | { src: 'std'; owner: string; m: StdMember }
    | { src: 'field'; owner: string; f: HostField }
    | { src: 'rel'; owner: string; f: HostField }
    | { src: 'child'; owner: string; name: string; child: string }
    | { src: 'type'; owner: string; name: string; kind: ApexTypeDecl['kind'] | 'std' }
    | { src: 'object'; name: string }
    | { src: 'trigger'; name: string; type: string };

// ─── Text helpers ───────────────────────────────────────────────────────────────

const WORD = /[A-Za-z0-9_]/;
const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c);

function skipWsBack(t: string, i: number): number {
    while (i >= 0 && /\s/.test(t[i])) i--;
    return i;
}

/** Index of the bracket matching the closer at `i` (`)`→`(`, `]`→`[`, `>`→`<`), or -1. */
function matchOpenBack(t: string, i: number): number {
    const close = t[i];
    const open = close === ')' ? '(' : close === ']' ? '[' : '<';
    let depth = 0;
    for (; i >= 0; i--) {
        const c = t[i];
        if (c === "'") {
            i--;
            while (i >= 0 && !(t[i] === "'" && t[i - 1] !== '\\')) i--;
            continue;
        }
        if (c === close) depth++;
        else if (c === open) {
            if (--depth === 0) return i;
        } else if (c === ';' || c === '{' || c === '}') return -1;
    }
    return -1;
}

/**
 * The receiver expression of a member access whose `.` is at `dot`, e.g.
 * `this.items.get(k)[0]` for `this.items.get(k)[0].|`. Undefined when there is none.
 */
export function receiverExprBefore(t: string, dot: number): string | undefined {
    let i = skipWsBack(t, dot - 1);
    let start = -1;
    while (i >= 0) {
        const c = t[i];
        if (c === ')' || c === ']') {
            const o = matchOpenBack(t, i);
            if (o < 0) return undefined;
            start = o;
            let j = skipWsBack(t, o - 1);
            if (j >= 0 && t[j] === '>' && c === ')') {
                // `new List<Account>()` — generic args before the parens.
                const lt = matchOpenBack(t, j);
                if (lt < 0) break;
                j = skipWsBack(t, lt - 1);
            }
            if (j >= 0 && isWord(t[j])) {
                i = j;
                continue;
            }
            if (j >= 0 && c === ']' && (t[j] === ')' || t[j] === ']')) {
                i = j;
                continue;
            }
            break;
        }
        if (isWord(c)) {
            let s = i;
            while (s > 0 && isWord(t[s - 1])) s--;
            start = s;
            const j = skipWsBack(t, s - 1);
            // A `.` ending an earlier line (`x.⏎    y.`) is an unfinished statement being
            // typed over, not a chain; continuation lines lead with the dot instead.
            if (j >= 0 && t[j] === '.' && !t.slice(j + 1, s).includes('\n')) {
                i = skipWsBack(t, j - 1);
                continue;
            }
            // `new Foo(…)` / `new Outer.Inner(…)`: keep the keyword.
            if (j >= 2 && t.slice(j - 2, j + 1).toLowerCase() === 'new' && !isWord(t[j - 3])) start = j - 2;
            break;
        }
        if (c === "'") {
            let k = i - 1;
            while (k >= 0 && !(t[k] === "'" && t[k - 1] !== '\\')) k--;
            if (k >= 0) start = k;
            break;
        }
        break;
    }
    if (start < 0) return undefined;
    const expr = t.slice(start, dot).trim();
    return expr || undefined;
}

type Seg = { kind: 'member'; name: string; call: boolean } | { kind: 'index' };
type Root =
    | { kind: 'ident'; name: string; call: boolean }
    | { kind: 'new'; type: string }
    | { kind: 'string' }
    | { kind: 'soql'; obj: string | undefined }
    | { kind: 'cast'; type: string }
    | { kind: 'paren'; inner: string };

/** Index just past the bracket group opening at `i` (balanced, string-aware), or -1. */
function skipGroup(t: string, i: number): number {
    const open = t[i];
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
    let depth = 0;
    for (; i < t.length; i++) {
        const c = t[i];
        if (c === "'") {
            i++;
            while (i < t.length && !(t[i] === "'" && t[i - 1] !== '\\')) i++;
            continue;
        }
        if (c === open) depth++;
        else if (c === close && --depth === 0) return i + 1;
    }
    return -1;
}

const TYPE_AT = /^[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*/;

/** Parse a receiver expression into its root and member/index steps. */
export function parseChain(expr: string): { root: Root; segs: Seg[] } | undefined {
    const t = expr;
    let p = 0;
    const ws = () => {
        while (p < t.length && /\s/.test(t[p])) p++;
    };
    ws();
    let root: Root | undefined;
    if (/^new\s/i.test(t.slice(p))) {
        p += 3;
        ws();
        const m = TYPE_AT.exec(t.slice(p));
        if (!m) return undefined;
        let type = m[0].replace(/\s+/g, '');
        p += m[0].length;
        ws();
        if (t[p] === '<') {
            const e = skipGroup(t, p);
            if (e < 0) return undefined;
            type += t.slice(p, e).replace(/\s+/g, '');
            p = e;
            ws();
        }
        if (t[p] === '[') {
            const e = skipGroup(t, p);
            if (e < 0) return undefined;
            type = `List<${type}>`;
            p = e;
            ws();
            if (t[p] === '{') p = skipGroup(t, p);
        } else if (t[p] === '(') {
            p = skipGroup(t, p);
        } else if (t[p] === '{') {
            p = skipGroup(t, p);
        }
        if (p < 0) return undefined;
        root = { kind: 'new', type };
    } else if (t[p] === "'") {
        let q = p + 1;
        while (q < t.length && !(t[q] === "'" && t[q - 1] !== '\\')) q++;
        p = q + 1;
        root = { kind: 'string' };
    } else if (t[p] === '[') {
        const e = skipGroup(t, p);
        if (e < 0) return undefined;
        const body = t.slice(p + 1, e - 1);
        if (!/^\s*select\b/i.test(body)) return undefined;
        root = { kind: 'soql', obj: soqlFromObject(body) };
        p = e;
    } else if (t[p] === '(') {
        const e = skipGroup(t, p);
        if (e < 0) return undefined;
        const inner = t.slice(p + 1, e - 1).trim();
        const cast = /^\(\s*([A-Za-z_][\w.]*(?:\s*<[^()]*>)?(?:\s*\[\s*\])?)\s*\)\s*[\w('[]/.exec(inner);
        root = cast ? { kind: 'cast', type: cast[1].replace(/\s+/g, '') } : { kind: 'paren', inner };
        p = e;
    } else {
        const m = /^[A-Za-z_]\w*/.exec(t.slice(p));
        if (!m) return undefined;
        p += m[0].length;
        ws();
        let call = false;
        if (t[p] === '(') {
            const e = skipGroup(t, p);
            if (e < 0) return undefined;
            p = e;
            call = true;
        }
        root = { kind: 'ident', name: m[0], call };
    }
    const segs: Seg[] = [];
    for (;;) {
        ws();
        if (p >= t.length) break;
        if (t[p] === '[') {
            const e = skipGroup(t, p);
            if (e < 0) return undefined;
            segs.push({ kind: 'index' });
            p = e;
            continue;
        }
        if (t[p] !== '.') return undefined;
        p++;
        ws();
        const m = /^[A-Za-z_]\w*/.exec(t.slice(p));
        if (!m) return undefined;
        p += m[0].length;
        ws();
        let call = false;
        if (t[p] === '(') {
            const e = skipGroup(t, p);
            if (e < 0) return undefined;
            p = e;
            call = true;
        }
        segs.push({ kind: 'member', name: m[0], call });
    }
    return { root, segs };
}

/** The main object of a SOQL query body (`SELECT … FROM Account …`), ignoring subqueries. */
function soqlFromObject(body: string): string | undefined {
    let depth = 0;
    const re = /[()]|\bfrom\s+([A-Za-z_]\w*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        if (m[0] === '(') depth++;
        else if (m[0] === ')') depth--;
        else if (depth === 0) return m[1];
    }
    return undefined;
}

/** `List<Map<Id, X>>` → { base: 'List', args: ['Map<Id,X>'] }; `X[]` → List<X>. */
export function splitGeneric(type: string): { base: string; args: string[] } {
    let t = type.replace(/\s+/g, '');
    if (t.endsWith('[]')) t = `List<${t.slice(0, -2)}>`;
    const lt = t.indexOf('<');
    if (lt < 0 || !t.endsWith('>')) return { base: t, args: [] };
    const base = t.slice(0, lt);
    const inner = t.slice(lt + 1, -1);
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of inner) {
        if (c === '<') depth++;
        else if (c === '>') depth--;
        if (c === ',' && depth === 0) {
            args.push(cur);
            cur = '';
        } else cur += c;
    }
    if (cur) args.push(cur);
    return { base, args };
}

/** Substitute a standard class's type parameters (`T`, `K`, `V`) in a signature fragment. */
export function substitute(s: string, cls: StdClass, args: string[]): string {
    if (!cls.typeParams || !args.length) return s;
    let out = s;
    cls.typeParams.forEach((p, i) => {
        const a = args[i];
        if (a) out = out.replace(new RegExp(`\\b${p}\\b`, 'g'), a);
    });
    return out;
}

/** Apex type of an SObject field from its describe type. */
export function apexTypeOfField(f: HostField): string {
    switch ((f.type || '').toLowerCase()) {
        case 'id':
        case 'reference':
            return 'Id';
        case 'boolean':
            return 'Boolean';
        case 'int':
        case 'integer':
            return 'Integer';
        case 'long':
            return 'Long';
        case 'double':
        case 'currency':
        case 'percent':
            return 'Decimal';
        case 'date':
            return 'Date';
        case 'datetime':
            return 'Datetime';
        case 'time':
            return 'Time';
        case 'base64':
            return 'Blob';
        case 'address':
            return 'Address';
        case 'location':
            return 'Location';
        default:
            return 'String';
    }
}

export function typeLabel(t: RType): string {
    switch (t.k) {
        case 'user':
            return t.decl.outer ? `${t.decl.outer}.${t.decl.name}` : t.decl.name;
        case 'std':
            return t.args.length ? `${t.cls.name}<${t.args.join(', ')}>` : t.cls.name;
        case 'sobject':
            return t.name;
        case 'sobjectTypes':
            return 'Schema.SObjectType';
        case 'describe':
            return 'Schema.DescribeSObjectResult';
        case 'fields':
            return `${t.obj}.fields`;
        case 'trigger':
            return 'Trigger';
    }
}

// ─── Object-name gate (local fallback until SchemaService.isObjectName exists) ──

const OBJECT_LIST_TTL_MS = 5 * 60_000;
const objectListCache = new Map<string, { at: number; names: Set<string>; list: string[] }>();

/** Drop the cached object lists (schema structure changed). */
export function invalidateObjectNames(): void {
    objectListCache.clear();
}

async function cachedObjectList(ctx: ServerContext, uri: string, token?: CancellationToken): Promise<{ names: Set<string>; list: string[] } | undefined> {
    const key = ctx.schema.orgContext(uri);
    const hit = objectListCache.get(key);
    if (hit && Date.now() - hit.at < OBJECT_LIST_TTL_MS) return hit;
    const svc = ctx.schema as unknown as { objectNames?: (u: string, tk?: CancellationToken) => Promise<string[]> };
    const list = svc.objectNames ? await svc.objectNames(uri, token) : await ctx.schema.objectList(uri, token);
    if (!list.length) return undefined; // host not ready: don't cache an empty answer
    const entry = { at: Date.now(), names: new Set(list.map((n) => n.toLowerCase())), list };
    objectListCache.set(key, entry);
    while (objectListCache.size > 20) objectListCache.delete(objectListCache.keys().next().value as string);
    return entry;
}

/** The org's object names (cached), for type completion. */
export async function objectNames(ctx: ServerContext, uri: string, token?: CancellationToken): Promise<string[]> {
    return (await cachedObjectList(ctx, uri, token))?.list ?? [];
}

const SOBJECT_LIKE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Whether `name` is an org object (namespace-optional). Uses `ctx.schema.isObjectName`
 * when the schema service provides it; otherwise the cached object list. With no list
 * available (host not ready) only custom-suffixed names qualify.
 */
export async function isObjectName(ctx: ServerContext, uri: string, name: string, token?: CancellationToken): Promise<boolean> {
    if (!SOBJECT_LIKE.test(name)) return false;
    const svc = ctx.schema as unknown as { isObjectName?: (n: string, u: string, tk?: CancellationToken) => Promise<boolean> };
    // The token carries the request's soft deadline (SchemaBudget): without it an unreachable
    // org would hold the completion for the full host timeout at every gate.
    if (svc.isObjectName) return svc.isObjectName(name, uri, token);
    const entry = await cachedObjectList(ctx, uri, token);
    const lc = name.toLowerCase();
    if (!entry) return /__(c|mdt|e|b|x)$/i.test(name);
    if (entry.names.has(lc)) return true;
    const ns = await ctx.schema.projectNamespace(uri, token);
    return !!ns && !hasNamespacePrefix(name, ns) && entry.names.has(`${ns.toLowerCase()}__${lc}`);
}

// ─── Resolver ───────────────────────────────────────────────────────────────────

const TRIGGER_MEMBERS = (obj: string): { name: string; type: string }[] => [
    { name: 'new', type: `List<${obj}>` },
    { name: 'old', type: `List<${obj}>` },
    { name: 'newMap', type: `Map<Id,${obj}>` },
    { name: 'oldMap', type: `Map<Id,${obj}>` },
    { name: 'size', type: 'Integer' },
    { name: 'operationType', type: 'TriggerOperation' },
    { name: 'isExecuting', type: 'Boolean' },
    { name: 'isBefore', type: 'Boolean' },
    { name: 'isAfter', type: 'Boolean' },
    { name: 'isInsert', type: 'Boolean' },
    { name: 'isUpdate', type: 'Boolean' },
    { name: 'isDelete', type: 'Boolean' },
    { name: 'isUndelete', type: 'Boolean' },
];

export function triggerMemberList(obj: string): { name: string; type: string }[] {
    return TRIGGER_MEMBERS(obj);
}

function triggerObjectName(full: string): string {
    return /\btrigger\s+\w+\s+on\s+([A-Za-z_]\w*)/i.exec(full)?.[1] ?? 'SObject';
}

const memberKey = (m: ApexMember): string => `${m.kind === 'method' ? 'm' : 'f'}:${m.name.toLowerCase()}${m.kind === 'method' ? '(' + (m.params ?? '').replace(/\s+\w+(,|$)/g, '$1').toLowerCase() + ')' : ''}`;

/** Union of two member lists (first wins), keyed by kind + name (+ parameter types). */
function unionMembers(a: ApexMember[], b: ApexMember[] | undefined): ApexMember[] {
    if (!b || !b.length) return a;
    const seen = new Set(a.map(memberKey));
    const out = a.slice();
    for (const m of b) if (!seen.has(memberKey(m))) out.push(m);
    return out;
}

/** Union of several parses' type indexes (first wins) — latest parse + last error-free parse. */
export function mergeIndexes(list: Pick<ApexIndex, 'types' | 'typeDecls'>[]): { types: Map<string, ApexMember[]>; typeDecls: ApexTypeDecl[] } {
    if (list.length === 1) return { types: list[0].types, typeDecls: list[0].typeDecls ?? [] };
    const types = new Map<string, ApexMember[]>();
    const typeDecls: ApexTypeDecl[] = [];
    const declNames = new Set<string>();
    for (const ix of list) {
        for (const [name, ms] of ix.types) types.set(name, unionMembers(types.get(name) ?? [], ms));
        for (const d of ix.typeDecls ?? []) {
            const key = `${d.outer ?? ''}.${d.name}`.toLowerCase();
            if (declNames.has(key)) continue;
            declNames.add(key);
            typeDecls.push(d);
        }
    }
    return { types, typeDecls };
}

const INDEX_WAIT_MS = 500;

/** Wait (bounded) for the initial workspace scan, so a type isn't mistaken for an SObject right after start. */
function waitForIndex(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, INDEX_WAIT_MS)));
    return Promise.race([WorkspaceIndex.ready(), timeout]).finally(() => clearTimeout(timer));
}

export class Resolver {
    /** The current document's types: latest parse merged with the last error-free one. */
    readonly local: FileTypes;
    private readonly positions: { index: ApexIndex; line: number; character: number }[];
    private enclosingCache: RValue | null | undefined;
    private ancestorsCache: Set<string> | undefined;
    private describes = new Map<string, Promise<HostDescribe | null>>();
    readonly fullText: string;

    constructor(
        readonly ctx: ServerContext,
        readonly doc: TextDocument,
        pos: { line: number; character: number },
        views: ParseView[],
        readonly token?: CancellationToken,
    ) {
        this.fullText = doc.getText();
        this.positions = views.map((v) => {
            const at = v.toParsePosition(pos);
            return { index: v.result.index, line: at.line, character: at.character };
        });
        const { types, typeDecls: decls } = mergeIndexes(views.map((v) => v.result.index));
        let file = doc.uri;
        try {
            if (doc.uri.startsWith('file:')) file = fileURLToPath(doc.uri);
        } catch {
            /* keep uri */
        }
        this.local = { file, types, decls };
    }

    /** Positions of the cursor in each view (latest first). */
    get views(): { index: ApexIndex; line: number; character: number }[] {
        return this.positions;
    }

    // ── object gate + describe (memoized per request) ──
    isObject(name: string): Promise<boolean> {
        return isObjectName(this.ctx, this.doc.uri, name, this.token);
    }

    describe(name: string): Promise<HostDescribe | null> {
        const lc = name.toLowerCase();
        let p = this.describes.get(lc);
        if (!p) {
            p = this.ctx.schema.describe(this.doc.uri, name, this.token);
            this.describes.set(lc, p);
        }
        return p;
    }

    // ── types by name ──
    /** Resolve a type as written in `from` (the file whose code mentions it; default: this document). */
    async typeByName(written: string, from: FileTypes = this.local): Promise<RType | undefined> {
        throwIfCancelled(this.token);
        const { base, args } = splitGeneric(written);
        if (!base) return undefined;
        const lc = base.toLowerCase();
        if (base.includes('.')) {
            const dot = base.indexOf('.');
            const outer = base.slice(0, dot);
            const innerName = base.slice(dot + 1);
            const o = innerName.includes('.') ? undefined : await this.typeByName(outer, from);
            if (o && o.k === 'user') {
                const inner = findDecl(o.ft, innerName, o.decl.name);
                if (inner) return { k: 'user', ft: o.ft, decl: inner, local: o.local };
            }
            const std = stdClass(base);
            if (std) return { k: 'std', cls: std, args };
            return undefined; // never describe dotted names
        }
        const own = findDecl(from, base);
        if (own) return { k: 'user', ft: from, decl: own, local: from === this.local };
        if (!WorkspaceIndex.hasType(base) && !WorkspaceIndex.scanComplete) await waitForIndex();
        if (WorkspaceIndex.hasType(base)) {
            const ft = await WorkspaceIndex.typeFile(base);
            throwIfCancelled(this.token);
            const decl = ft && findDecl(ft, base, undefined, true);
            if (ft && decl) return { k: 'user', ft, decl, local: false };
        }
        const std = stdClass(base);
        if (std) return { k: 'std', cls: std, args };
        if (lc === 'sobject') return undefined;
        if (await this.isObject(base)) return { k: 'sobject', name: base };
        return undefined;
    }

    // ── enclosing class ──
    async enclosing(): Promise<RValue | undefined> {
        if (this.enclosingCache !== undefined) return this.enclosingCache ?? undefined;
        let name: string | undefined;
        // The error-free parse (when present) knows the class ranges of broken code best.
        for (const p of [...this.positions].reverse()) {
            name = enclosingClass(p.index, p.line, p.character);
            if (name) break;
        }
        const decl = name ? this.local.decls.find((d) => d.name === name && d.kind !== 'trigger') ?? this.local.decls.find((d) => d.name === name) : undefined;
        this.enclosingCache = decl ? { t: { k: 'user', ft: this.local, decl, local: true }, static: false } : null;
        return this.enclosingCache ?? undefined;
    }

    /** Lower-cased names of the enclosing class and all its supertypes (for `protected`). */
    private async enclosingAncestors(): Promise<Set<string>> {
        if (this.ancestorsCache) return this.ancestorsCache;
        const out = new Set<string>();
        const enc = await this.enclosing();
        let t: RType | undefined = enc?.t;
        for (let i = 0; t && t.k === 'user' && i < 8; i++) {
            out.add(t.decl.name.toLowerCase());
            t = t.decl.extendsType ? await this.typeByName(t.decl.extendsType, t.ft) : undefined;
        }
        this.ancestorsCache = out;
        return out;
    }

    /** Whether the cursor sits in a static method of the enclosing class. */
    inStaticContext(): boolean {
        for (const p of this.positions) {
            for (const d of p.index.typeDecls ?? []) {
                for (const m of d.members) {
                    if (m.kind !== 'method' && m.kind !== 'constructor') continue;
                    const r = m.range;
                    const inside =
                        (p.line > r.start.line || (p.line === r.start.line && p.character >= r.start.character)) &&
                        (p.line < r.end.line || (p.line === r.end.line && p.character <= r.end.character));
                    if (inside) return m.modifiers.includes('static');
                }
            }
        }
        return false;
    }

    // ── variables ──
    /** Declared type of a variable visible at the cursor (scope-aware, latest parse first). */
    varType(name: string): string | undefined {
        for (const p of this.positions) {
            const t = resolveScopedVarType(p.index, name, p.line, p.character);
            if (t) return t;
        }
        for (const p of this.positions) {
            const t = p.index.varTypes.get(name);
            if (t) return t;
        }
        return regexReceiverType(this.fullText, name);
    }

    /** Every variable visible at the cursor, merged across views. */
    visibleVars(): VarDecl[] {
        const out = new Map<string, VarDecl>();
        for (const p of this.positions) for (const v of visibleVars(p.index, p.line, p.character)) if (!out.has(v.name.toLowerCase())) out.set(v.name.toLowerCase(), v);
        return [...out.values()];
    }

    // ── expressions ──
    async exprValue(expr: string): Promise<RValue | undefined> {
        const chain = parseChain(expr);
        if (!chain) return undefined;
        let v = await this.rootValue(chain.root);
        for (const s of chain.segs) {
            if (!v) return undefined;
            v = s.kind === 'index' ? await this.indexValue(v) : await this.memberValue(v, s.name, s.call);
        }
        return v;
    }

    private async instanceOf(type: string, from?: FileTypes): Promise<RValue | undefined> {
        const t = await this.typeByName(type, from);
        return t ? { t, static: false } : undefined;
    }

    private async rootValue(r: Root): Promise<RValue | undefined> {
        switch (r.kind) {
            case 'new':
            case 'cast':
                return this.instanceOf(r.type);
            case 'string':
                return this.instanceOf('String');
            case 'soql':
                return r.obj ? this.instanceOf(`List<${r.obj}>`) : this.instanceOf('List<SObject>');
            case 'paren':
                return this.exprValue(r.inner);
            case 'ident':
                break;
        }
        const name = r.name;
        const lc = name.toLowerCase();
        if (r.call) {
            const enc = await this.enclosing();
            return enc ? this.memberValue({ t: enc.t, static: false }, name, true, true) : undefined;
        }
        if (lc === 'this') return this.enclosing();
        if (lc === 'super') {
            const enc = await this.enclosing();
            if (!enc || enc.t.k !== 'user' || !enc.t.decl.extendsType) return undefined;
            return this.instanceOf(enc.t.decl.extendsType, enc.t.ft);
        }
        const vt = this.varType(name);
        if (vt) return this.instanceOf(vt);
        // A field inherited from a superclass of the enclosing class.
        const enc = await this.enclosing();
        if (enc) {
            const inh = await this.memberValue({ t: enc.t, static: false }, name, false, true);
            if (inh) return inh;
        }
        if (lc === 'trigger') return { t: { k: 'trigger', obj: triggerObjectName(this.fullText) }, static: true };
        if (lc === 'sobjecttype') return { t: { k: 'sobjectTypes' }, static: true };
        const t = await this.typeByName(name);
        return t ? { t, static: true } : undefined;
    }

    private async indexValue(v: RValue): Promise<RValue | undefined> {
        if (v.static) return undefined;
        if (v.t.k === 'std' && v.t.cls.name === 'List' && v.t.args[0]) return this.instanceOf(v.t.args[0]);
        return undefined;
    }

    /** Find a user member (with inheritance) by name; returns the member and the file it's declared in. */
    private async findUserMember(
        t: Extract<RType, { k: 'user' }>,
        name: string,
        call: boolean,
        depth = 0,
    ): Promise<{ m: ApexMember; ft: FileTypes } | undefined> {
        const lc = name.toLowerCase();
        const own = membersNamed(t.ft, t.decl.name) ?? [];
        const hit = own.find((m) => m.name.toLowerCase() === lc && (call ? m.kind === 'method' : m.kind !== 'method' && m.kind !== 'constructor'));
        if (hit) return { m: hit, ft: t.ft };
        if (depth > 6) return undefined;
        for (const sup of [t.decl.extendsType, ...t.decl.implementsTypes]) {
            if (!sup) continue;
            const st = await this.typeByName(sup, t.ft);
            if (st && st.k === 'user') {
                const r = await this.findUserMember(st, name, call, depth + 1);
                if (r) return r;
            }
        }
        return undefined;
    }

    /** Type of `v.name` / `v.name(…)`. `quiet`: no SObject/std fallbacks for implicit-this lookups. */
    async memberValue(v: RValue, name: string, call: boolean, quiet = false): Promise<RValue | undefined> {
        const lc = name.toLowerCase();
        const t = v.t;
        switch (t.k) {
            case 'user': {
                if (v.static && !call) {
                    const inner = findDecl(t.ft, name, t.decl.name);
                    if (inner) return { t: { k: 'user', ft: t.ft, decl: inner, local: t.local }, static: true };
                }
                if (t.decl.kind === 'enum') {
                    if (v.static && !call && (membersNamed(t.ft, t.decl.name) ?? []).some((m) => m.kind === 'enumValue' && m.name.toLowerCase() === lc)) {
                        return { t, static: false };
                    }
                    if (call) {
                        const sm = (v.static ? enumStaticMethods(t.decl.name) : ENUM_INSTANCE_MEMBERS).find((m) => m.name.toLowerCase() === lc);
                        if (sm?.returns) return this.instanceOf(sm.returns, t.ft);
                    }
                }
                const found = await this.findUserMember(t, name, call);
                if (found?.m.type) return this.instanceOf(found.m.type, found.ft);
                return undefined;
            }
            case 'std': {
                if (quiet) return undefined;
                const cls = t.cls;
                if (cls.name === 'Schema' && v.static && lc === 'sobjecttype' && !call) return { t: { k: 'sobjectTypes' }, static: true };
                if (cls.name === 'Schema.SObjectType' && t.obj && lc === 'getdescribe' && call) return { t: { k: 'describe', obj: t.obj }, static: false };
                if (v.static && cls.namespace && !call) {
                    const nested = stdClass(`${cls.name}.${name}`);
                    if (nested) return { t: { k: 'std', cls: nested, args: [] }, static: true };
                }
                const list = v.static ? cls.statics : cls.instance;
                const m = list.find((x) => x.name.toLowerCase() === lc && (call ? x.kind === 'method' : x.kind === 'field'));
                if (!m?.returns || m.returns === 'void') return undefined;
                const ret = substitute(m.returns, cls, t.args);
                if (cls.isEnum && v.static && !call) return this.instanceOf(ret); // enum value
                return this.instanceOf(ret);
            }
            case 'sobject': {
                if (quiet) return undefined;
                if (v.static) {
                    if (lc === 'sobjecttype' && !call) {
                        const st = stdClass('Schema.SObjectType');
                        return st ? { t: { k: 'std', cls: st, args: [], obj: t.name }, static: false } : undefined;
                    }
                    if (!call) {
                        const sf = stdClass('Schema.SObjectField');
                        return sf ? { t: { k: 'std', cls: sf, args: [] }, static: false } : undefined;
                    }
                    return undefined;
                }
                if (call) {
                    if (lc === 'getsobjecttype') {
                        const st = stdClass('Schema.SObjectType');
                        return st ? { t: { k: 'std', cls: st, args: [], obj: t.name }, static: false } : undefined;
                    }
                    if (lc === 'clone') return { t, static: false };
                    const so = stdClass('SObject');
                    const m = so?.instance.find((x) => x.name.toLowerCase() === lc);
                    return m?.returns && m.returns !== 'void' ? this.instanceOf(m.returns) : undefined;
                }
                const d = await this.describe(t.name);
                if (!d) return undefined;
                const rel = d.fields.find((f) => f.relationshipName && nameMatchesNsOptional(f.relationshipName, name) && f.referenceTo?.length);
                if (rel?.referenceTo) return { t: { k: 'sobject', name: rel.referenceTo[0] }, static: false };
                const child = (d.childRelationships ?? []).find((c) => c.name && nameMatchesNsOptional(c.name, name));
                if (child) return this.instanceOf(`List<${child.childSObject}>`);
                const f = d.fields.find((x) => nameMatchesNsOptional(x.name, name));
                return f ? this.instanceOf(apexTypeOfField(f)) : undefined;
            }
            case 'sobjectTypes':
                return call ? undefined : { t: { k: 'describe', obj: name }, static: false };
            case 'describe': {
                if (lc === 'fields' && !call) return { t: { k: 'fields', obj: t.obj }, static: false };
                const cls = stdClass('Schema.DescribeSObjectResult');
                const m = cls?.instance.find((x) => x.name.toLowerCase() === lc);
                if (lc === 'getsobjecttype' && call) {
                    const st = stdClass('Schema.SObjectType');
                    return st ? { t: { k: 'std', cls: st, args: [], obj: t.obj }, static: false } : undefined;
                }
                return m?.returns && m.returns !== 'void' ? this.instanceOf(m.returns) : undefined;
            }
            case 'fields':
                if (call && lc === 'getmap') return this.instanceOf('Map<String,Schema.SObjectField>');
                return call ? undefined : this.instanceOf('Schema.DescribeFieldResult');
            case 'trigger': {
                const m = TRIGGER_MEMBERS(t.obj).find((x) => x.name.toLowerCase() === lc);
                return m && !call ? this.instanceOf(m.type) : undefined;
            }
        }
    }

    // ── member listing ──
    async members(v: RValue): Promise<MemberEntry[]> {
        const t = v.t;
        switch (t.k) {
            case 'user':
                return this.userMembers(t, v.static);
            case 'std': {
                const owner = t.cls.name;
                const list = v.static ? t.cls.statics : t.cls.instance;
                const out: MemberEntry[] = list.map((m) => ({ src: 'std', owner, m: substMember(m, t.cls, t.args) }));
                if (v.static && t.cls.namespace) {
                    for (const n of stdNestedTypes(t.cls.name)) out.push({ src: 'type', owner, name: n.name.slice(owner.length + 1), kind: 'std' });
                    if (t.cls.name === 'Schema') out.push({ src: 'type', owner, name: 'SObjectType', kind: 'std' });
                }
                return out;
            }
            case 'sobject': {
                const d = await this.describe(t.name);
                const out: MemberEntry[] = [];
                if (v.static) {
                    out.push({ src: 'std', owner: t.name, m: { name: 'SObjectType', kind: 'field', detail: 'Schema.SObjectType SObjectType', returns: 'Schema.SObjectType', static: true } });
                    for (const f of d?.fields ?? []) out.push({ src: 'field', owner: t.name, f });
                    return out;
                }
                for (const f of d?.fields ?? []) {
                    out.push({ src: 'field', owner: t.name, f });
                    if (f.relationshipName) out.push({ src: 'rel', owner: t.name, f });
                }
                for (const c of d?.childRelationships ?? []) if (c.name) out.push({ src: 'child', owner: t.name, name: c.name, child: c.childSObject });
                for (const m of stdClass('SObject')?.instance ?? []) out.push({ src: 'std', owner: 'SObject', m });
                return out;
            }
            case 'sobjectTypes':
                return (await objectNames(this.ctx, this.doc.uri, this.token)).map((name) => ({ src: 'object', name }));
            case 'describe': {
                const out: MemberEntry[] = [{ src: 'std', owner: 'DescribeSObjectResult', m: { name: 'fields', kind: 'field', detail: `${t.obj}.fields`, returns: 'fields' } }];
                for (const m of stdClass('Schema.DescribeSObjectResult')?.instance ?? []) out.push({ src: 'std', owner: 'DescribeSObjectResult', m });
                return out;
            }
            case 'fields': {
                const d = await this.describe(t.obj);
                const out: MemberEntry[] = (d?.fields ?? []).map((f) => ({ src: 'field', owner: t.obj, f }));
                out.push({ src: 'std', owner: `${t.obj}.fields`, m: { name: 'getMap', kind: 'method', detail: 'Map<String,Schema.SObjectField> getMap()', returns: 'Map<String,Schema.SObjectField>', params: '' } });
                return out;
            }
            case 'trigger':
                return TRIGGER_MEMBERS(t.obj).map((m) => ({ src: 'trigger', name: m.name, type: m.type }));
        }
    }

    /** Members of a user type: own + inherited (supertypes in any file), filtered by static/visibility. */
    async userMembers(t: Extract<RType, { k: 'user' }>, isStatic: boolean, opts: { all?: boolean } = {}): Promise<MemberEntry[]> {
        const out: MemberEntry[] = [];
        const seen = new Set<string>();
        const ancestors = t.local ? undefined : await this.enclosingAncestors();
        const visit = async (u: Extract<RType, { k: 'user' }>, inherited: boolean, depth: number): Promise<void> => {
            const owner = u.decl.name;
            const isEnum = u.decl.kind === 'enum';
            const own = membersNamed(u.ft, owner) ?? [];
            const visible = (m: ApexMember): boolean => {
                if (u.local) return !(inherited && m.visibility === 'private' && u.ft !== this.local);
                if (m.visibility === 'private') return false;
                if (m.visibility === 'protected') return !!ancestors?.has(owner.toLowerCase());
                return true;
            };
            for (const m of own) {
                if (m.kind === 'constructor') continue;
                const st = !!m.static || m.kind === 'enumValue';
                if (!opts.all && st !== isStatic) continue;
                if (!visible(m)) continue;
                const k = memberKey(m);
                if (seen.has(k)) continue;
                seen.add(k);
                out.push({ src: 'user', owner, m, inherited });
            }
            if (!inherited && (isStatic || opts.all)) {
                for (const d of u.ft.decls) if (d.outer === owner) out.push({ src: 'type', owner, name: d.name, kind: d.kind });
            }
            if (!inherited && isEnum) {
                const extra = isStatic ? enumStaticMethods(owner) : ENUM_INSTANCE_MEMBERS;
                for (const m of extra) out.push({ src: 'std', owner, m });
            }
            if (depth > 6) return;
            for (const sup of [u.decl.extendsType, ...u.decl.implementsTypes]) {
                if (!sup) continue;
                const st = await this.typeByName(sup, u.ft);
                if (st && st.k === 'user') await visit(st, true, depth + 1);
            }
        };
        await visit(t, false, 0);
        return out;
    }
}

function substMember(m: StdMember, cls: StdClass, args: string[]): StdMember {
    if (!cls.typeParams || !args.length) return m;
    return {
        ...m,
        detail: substitute(m.detail, cls, args),
        returns: m.returns && substitute(m.returns, cls, args),
        params: m.params && substitute(m.params, cls, args),
    };
}

/**
 * A type declaration in a file by simple name. `outer` restricts to inner types of that
 * class; `topLevel` to top-level types. Otherwise any (top-level preferred).
 */
export function findDecl(ft: FileTypes, name: string, outer?: string, topLevel = false): ApexTypeDecl | undefined {
    const lc = name.toLowerCase();
    let fallback: ApexTypeDecl | undefined;
    for (const d of ft.decls) {
        if (d.name.toLowerCase() !== lc) continue;
        if (outer !== undefined) {
            if (d.outer && d.outer.toLowerCase() === outer.toLowerCase()) return d;
            continue;
        }
        if (!d.outer) return d;
        if (!topLevel) fallback ??= d;
    }
    return fallback;
}
