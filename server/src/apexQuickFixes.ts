/**
 * Text-level Apex quick-fix computations used by codeActions.ts: hoisting SOQL out of
 * loops (plain hoist or Set/Map bulkification), collecting in-loop DML into one
 * statement after the loop, adding a sharing keyword, removing System.debug calls and
 * inserting a missing ';'.
 *
 * Everything here is pure and works on the CURRENT document text (callers pass the
 * exact-version text), returning offset edits. Analysis runs on a "masked" copy of the
 * text (comments and string-literal contents blanked to spaces, same length), so
 * braces/keywords inside strings or comments never confuse the scanners. Every fix is
 * deliberately conservative: when a pattern is not unambiguous, no fix is offered.
 */

export interface OffsetEdit {
    start: number;
    end: number;
    newText: string;
}
export interface TextFix {
    title: string;
    edits: OffsetEdit[];
    preferred?: boolean;
}

// ─── Text helpers ──────────────────────────────────────────────────────────────────

/** Blank comments and string-literal contents (quotes kept), preserving length and line breaks. */
export function maskCode(text: string): string {
    const out = text.split('');
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n' && text[i] !== '\r') out[i++] = ' ';
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end < 0 ? n : end + 2;
            for (; i < stop; i++) if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
            continue;
        }
        if (c === "'") {
            i++;
            while (i < n && text[i] !== "'" && text[i] !== '\n') {
                if (text[i] === '\\' && i + 1 < n && text[i + 1] !== '\n') out[i++] = ' ';
                out[i++] = ' ';
            }
            i++;
            continue;
        }
        i++;
    }
    return out.join('');
}

/** Index of the bracket closing the one at `open` (same kind), or -1. */
function matchClose(m: string, open: number): number {
    const o = m[open];
    const c = o === '(' ? ')' : o === '[' ? ']' : '}';
    let depth = 0;
    for (let i = open; i < m.length; i++) {
        if (m[i] === o) depth++;
        else if (m[i] === c && --depth === 0) return i;
    }
    return -1;
}

function skipWs(m: string, i: number): number {
    while (i < m.length && /\s/.test(m[i])) i++;
    return i;
}
function prevNonWs(m: string, i: number): number {
    while (i >= 0 && /\s/.test(m[i])) i--;
    return i;
}
function lineStartOf(text: string, off: number): number {
    return text.lastIndexOf('\n', off - 1) + 1;
}
/** Offset of the line break ending the line containing `off` (before a `\r\n`), or text end. */
function lineEndOf(text: string, off: number): number {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return text.length;
    return nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
}
function indentAt(text: string, off: number): string {
    return /^[ \t]*/.exec(text.slice(lineStartOf(text, off)))![0];
}
export function eolOf(text: string): string {
    return text.includes('\r\n') ? '\r\n' : '\n';
}
function escRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function cap(s: string): string {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}
function lowerFirst(s: string): string {
    return s ? s[0].toLowerCase() + s.slice(1) : s;
}
function plural(w: string): string {
    if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
    if (/(?:s|x|ch|sh)$/i.test(w)) return w + 'es';
    return w + 's';
}
/** `acme__My_Object__c` → `myObject`; `Account` → `account`. */
export function identBase(apiName: string): string {
    const parts = apiName.split('__');
    let core = parts.length >= 3 ? parts[1] : parts[0];
    if (!core) core = apiName;
    const words = core.split('_').filter(Boolean);
    return lowerFirst(words.map((w, i) => (i ? cap(w) : w)).join('')) || 'record';
}
/** A name not used as an identifier anywhere in `text` (Apex is case-insensitive) nor reserved. */
function uniqueName(text: string, base: string, reserved: Set<string>): string {
    for (let n = 1; ; n++) {
        const name = n === 1 ? base : `${base}${n}`;
        if (reserved.has(name.toLowerCase())) continue;
        if (new RegExp(`\\b${escRe(name)}\\b`, 'i').test(text)) continue;
        reserved.add(name.toLowerCase());
        return name;
    }
}
/** Re-indent continuation lines of a (multi-line) snippet from `from` to `to` indentation. */
function reindent(snippet: string, from: string, to: string, eol: string): string {
    const lines = snippet.split(/\r?\n/);
    return lines.map((l, i) => (i > 0 && l.startsWith(from) ? to + l.slice(from.length) : l)).join(eol);
}

// ─── Loops ─────────────────────────────────────────────────────────────────────────

export interface LoopInfo {
    kw: 'for' | 'while' | 'do';
    kwStart: number;
    headerOpen: number;
    headerClose: number;
    bodyOpen: number;
    bodyClose: number;
    /** Last character of the whole loop statement (`}` or the `;` of a do-while). */
    end: number;
}

/** Every brace-bodied `for` / `while` / `do … while (…);` loop. */
export function findLoops(m: string): LoopInfo[] {
    const loops: LoopInfo[] = [];
    const re = /\b(for|while|do)\b/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(m))) {
        const kw = mm[1] as LoopInfo['kw'];
        const kwStart = mm.index;
        if (kwStart > 0 && m[kwStart - 1] === '.') continue;
        let i = skipWs(m, kwStart + kw.length);
        if (kw === 'do') {
            if (m[i] !== '{') continue;
            const bodyClose = matchClose(m, i);
            if (bodyClose < 0) continue;
            let j = skipWs(m, bodyClose + 1);
            if (!/^while\b/.test(m.slice(j, j + 6))) continue;
            j = skipWs(m, j + 5);
            if (m[j] !== '(') continue;
            const hc = matchClose(m, j);
            if (hc < 0) continue;
            const semi = skipWs(m, hc + 1);
            if (m[semi] !== ';') continue;
            loops.push({ kw, kwStart, headerOpen: j, headerClose: hc, bodyOpen: i, bodyClose, end: semi });
            continue;
        }
        if (m[i] !== '(') continue;
        const hc = matchClose(m, i);
        if (hc < 0) continue;
        const b = skipWs(m, hc + 1);
        if (m[b] !== '{') continue;
        const bodyClose = matchClose(m, b);
        if (bodyClose < 0) continue;
        loops.push({ kw, kwStart, headerOpen: i, headerClose: hc, bodyOpen: b, bodyClose, end: bodyClose });
    }
    return loops;
}

function innermostLoop(loops: LoopInfo[], off: number): LoopInfo | undefined {
    let best: LoopInfo | undefined;
    for (const l of loops) {
        if (off > l.bodyOpen && off < l.bodyClose && (!best || l.bodyOpen > best.bodyOpen)) best = l;
    }
    return best;
}

/** `for (Type v : iterable)` → parts; undefined for classic/while/do loops. */
function forEachHeader(m: string, loop: LoopInfo): { type: string; v: string; iterable: string } | undefined {
    if (loop.kw !== 'for') return undefined;
    const h = m.slice(loop.headerOpen + 1, loop.headerClose);
    if (h.includes(';')) return undefined;
    const r = /^\s*([A-Za-z_][\w.]*(?:\s*<[^:]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_]\w*)\s*:\s*([\s\S]+?)\s*$/.exec(h);
    return r ? { type: r[1].replace(/\s+/g, ''), v: r[2], iterable: r[3] } : undefined;
}

/** Shared setup for inserting statements before / after a loop. Undefined if the layout is unusual. */
function loopLayout(text: string, m: string, loop: LoopInfo): { lineStart: number; indent: string; unit: string } | undefined {
    const lineStart = lineStartOf(text, loop.kwStart);
    if (m.slice(lineStart, loop.kwStart).trim() !== '') return undefined; // `} else for (…)` etc.
    const indent = indentAt(text, loop.kwStart);
    const inner = /\r?\n([ \t]*)\S/.exec(text.slice(loop.bodyOpen + 1, loop.bodyClose));
    let unit = inner && inner[1].startsWith(indent) && inner[1].length > indent.length ? inner[1].slice(indent.length) : '';
    if (!unit) unit = indent.includes('\t') || /^\t/m.test(text) ? '\t' : '    ';
    return { lineStart, indent, unit };
}

const KEYWORDS = new Set([
    'return', 'new', 'else', 'throw', 'insert', 'update', 'delete', 'upsert', 'undelete', 'merge',
    'when', 'instanceof', 'case', 'if', 'for', 'while', 'do', 'try', 'catch', 'finally', 'final', 'static',
]);

/** Identifiers declared, assigned or incremented inside `body` (conservative over-approximation). */
function loopMutatedNames(maskedBody: string): Set<string> {
    const names = new Set<string>();
    // Ignore inline SOQL (`WHERE Name = :name` is a comparison, not an assignment).
    const body = maskedBody.replace(/\[\s*SELECT\b[^\]]*\]/gi, (q) => ' '.repeat(q.length));
    for (const mm of body.matchAll(/\b([A-Za-z_][\w.]*(?:\s*<[^;{}()=]*>)?(?:\s*\[\s*\])?)\s+([A-Za-z_]\w*)\s*(?=[=;:,)])/g)) {
        if (!KEYWORDS.has(mm[1].toLowerCase())) names.add(mm[2].toLowerCase());
    }
    for (const mm of body.matchAll(/\b([A-Za-z_]\w*)(?:\s*\.\s*[A-Za-z_]\w*)*\s*(?:[-+*/]?=(?!=)|\+\+|--)/g)) names.add(mm[1].toLowerCase());
    for (const mm of body.matchAll(/(?:\+\+|--)\s*([A-Za-z_]\w*)/g)) names.add(mm[1].toLowerCase());
    return names;
}

const DML_RE = /\b(?:insert|update|upsert|delete|undelete|merge)\s+[A-Za-z_([]|\bDatabase\s*\.\s*(?:insert|update|upsert|delete|undelete|merge)\w*\s*\(/i;

// ─── SOQL ─────────────────────────────────────────────────────────────────────────

interface SoqlParts {
    /** Query start (`[`) and end (`]`) offsets in the document. */
    start: number;
    end: number;
    object: string;
    aggregate: boolean;
    countOnly: boolean;
    /** Document offset just after the last select item (before whitespace + FROM). */
    selectEnd: number;
    selectItems: string[];
    binds: { expr: string; complex: boolean }[];
}

function parseSoql(m: string, start: number): SoqlParts | undefined {
    if (!/^\[\s*SELECT\b/i.test(m.slice(start, start + 40))) return undefined;
    const end = matchClose(m, start);
    if (end < 0) return undefined;
    const inner = m.slice(start + 1, end);
    let depth = 0;
    let fromIdx = -1;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && /F/i.test(ch) && /^FROM\b/i.test(inner.slice(i, i + 5)) && /\s/.test(inner[i - 1] ?? ' ')) {
            fromIdx = i;
            break;
        }
    }
    if (fromIdx < 0) return undefined;
    const objM = /^FROM\s+([A-Za-z_]\w*)/i.exec(inner.slice(fromIdx));
    if (!objM) return undefined;
    const selStart = /SELECT\s*/i.exec(inner)!;
    const selText = inner.slice(selStart.index + selStart[0].length, fromIdx);
    const selectItems: string[] = [];
    depth = 0;
    let cur = '';
    for (const ch of selText) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) {
            selectItems.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    if (cur.trim()) selectItems.push(cur.trim());
    const binds: SoqlParts['binds'] = [];
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] !== ':') continue;
        if (/\d/.test(inner[i - 1] ?? '')) continue; // a time literal (10:00:00Z)
        const b = /^:\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*([([]?)/.exec(inner.slice(i));
        if (!b) binds.push({ expr: '', complex: true });
        else binds.push({ expr: b[1].replace(/\s+/g, ''), complex: !!b[2] });
    }
    return {
        start,
        end,
        object: objM[1],
        aggregate: /\b(?:COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX)\s*\(/i.test(selText),
        countOnly: /\bCOUNT\s*\(\s*\)/i.test(selText),
        selectEnd: start + 1 + selStart.index + selStart[0].length + selText.trimEnd().length,
        selectItems,
        binds,
    };
}

type QueryContext = { kind: 'list' } | { kind: 'single'; type: string };

/** How the query's value is used, from a whitelist of unambiguous contexts; undefined = unknown. */
function queryContext(m: string, q: SoqlParts, varType: (name: string) => string | undefined): QueryContext | undefined {
    const before = m.slice(Math.max(0, q.start - 400), q.start);
    const after = m.slice(q.end + 1, q.end + 200);
    if (/(?:\bList\s*<[^;{}]*>|[A-Za-z_][\w.]*\s*\[\s*\])\s+[A-Za-z_]\w*\s*=\s*$/i.test(before)) return { kind: 'list' };
    if (/\bfor\s*\([^;(){}]*:\s*$/.test(before)) return { kind: 'list' };
    if (/^\s*(?:\.\s*(?:size|isEmpty)\s*\(|\[)/i.test(after)) return { kind: 'list' };
    if (/^\s*\)/.test(after) && (/\bnew\s+(?:Map|Set|List)\s*<[^;{}]*>\s*\(\s*$/i.test(before) || /\.\s*addAll\s*\(\s*$/i.test(before))) {
        return { kind: 'list' };
    }
    if (!/^\s*;/.test(after)) return undefined;
    const decl = /(?:^|[;{}])\s*(?:final\s+)?([A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*$/.exec(before);
    if (decl && !KEYWORDS.has(decl[1].toLowerCase())) return { kind: 'single', type: decl[1] };
    const asg = /(?:^|[;{}])\s*([A-Za-z_]\w*)\s*=\s*$/.exec(before);
    if (asg) {
        const t = varType(asg[1]);
        if (!t) return undefined;
        if (/^List\s*</i.test(t) || /\[\]$/.test(t)) return { kind: 'list' };
        if (/^[A-Za-z_][\w.]*$/.test(t)) return { kind: 'single', type: t };
    }
    return undefined;
}

export interface SoqlFixDeps {
    /** Declared type of a variable visible at the query (scope-aware), if known. */
    varType: (name: string) => string | undefined;
    /** Whether `sobject.field` is an Id/lookup field (consulted for custom `__c` fields). */
    isIdField: (sobject: string, field: string) => Promise<boolean>;
}

/**
 * Fixes for a SOQL query (starting at `start`, the `[`) inside a loop:
 *   • the WHERE clause doesn't depend on the loop → hoist it into a local before the loop;
 *   • it binds exactly `:loopVar.Field` of a for-each loop over a collection variable →
 *     bulkify (collect the Ids before the loop, query once with `IN`, look up a Map).
 */
export async function soqlInLoopFixes(text: string, start: number, deps: SoqlFixDeps): Promise<TextFix[]> {
    const m = maskCode(text);
    const q = parseSoql(m, start);
    if (!q || q.countOnly) return [];
    const loop = innermostLoop(findLoops(m), start);
    if (!loop) return [];
    const layout = loopLayout(text, m, loop);
    if (!layout) return [];
    const body = m.slice(loop.bodyOpen + 1, loop.bodyClose);
    // DML in the same loop could change what the query returns on later iterations.
    if (DML_RE.test(body)) return [];
    if (q.binds.some((b) => b.complex)) return [];
    const ctx = queryContext(m, q, deps.varType);
    if (!ctx) return [];

    const fe = forEachHeader(m, loop);
    const scoped = loopMutatedNames(body);
    if (fe) scoped.add(fe.v.toLowerCase());
    else for (const id of m.slice(loop.headerOpen + 1, loop.headerClose).match(/[A-Za-z_]\w*/g) ?? []) scoped.add(id.toLowerCase());
    const dependent = q.binds.filter((b) => scoped.has(b.expr.split('.')[0].toLowerCase()));

    const eol = eolOf(text);
    const { lineStart, indent, unit } = layout;
    const queryText = text.slice(q.start, q.end + 1);
    const queryIndent = indentAt(text, q.start);
    const reserved = new Set<string>();

    if (dependent.length === 0) {
        if (ctx.kind !== 'list') return []; // a single-row assignment would throw at a different time
        const elem = q.aggregate ? 'AggregateResult' : q.object;
        const name = uniqueName(text, `${identBase(elem)}Records`, reserved);
        const decl = `${indent}List<${elem}> ${name} = ${reindent(queryText, queryIndent, indent, eol)};${eol}`;
        return [
            {
                title: `Move SOQL query out of the loop (into '${name}')`,
                preferred: true,
                edits: [
                    { start: lineStart, end: lineStart, newText: decl },
                    { start: q.start, end: q.end + 1, newText: name },
                ],
            },
        ];
    }

    // ── Bulkification: exactly one bind, `:v.Field`, v the for-each variable. ──
    if (!fe || q.binds.length !== 1 || q.aggregate) return [];
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(fe.iterable.trim())) return []; // must re-iterate a plain collection
    if (!/^[A-Za-z_]\w*$/.test(fe.type)) return [];
    const parts = q.binds[0].expr.split('.');
    if (parts.length !== 2 || parts[0].toLowerCase() !== fe.v.toLowerCase()) return [];
    const field = parts[1];
    const inner = m.slice(q.start, q.end + 1);
    if (/\b(?:OR|NOT|LIMIT|OFFSET|HAVING)\b|\bGROUP\s+BY\b/i.test(inner)) return [];
    const pred = new RegExp(`(^|[^.\\w])([A-Za-z_]\\w*)\\s*=\\s*:\\s*${escRe(fe.v)}\\s*\\.\\s*${escRe(field)}\\b`, 'i').exec(inner);
    if (!pred) return [];
    const qField = pred[2];
    const isId = /^Id$/i.test(field) || /^[A-Za-z][A-Za-z0-9]*Id$/.test(field) || (/__c$/i.test(field) && (await deps.isIdField(fe.type, field)));
    if (!isId) return [];
    const keyExpr = `${fe.v}.${field}`;
    const iterable = fe.iterable.trim();
    const objBase = identBase(q.object);
    const idsBase = /^Id$/i.test(field) ? `${identBase(fe.type)}Ids` : `${identBase(field.replace(/Id$/, '').replace(/__c$/i, '')) || 'key'}Ids`;
    const ids = uniqueName(text, idsBase, reserved);

    // Rewrite the query: `QField = :v.Field` → `QField IN :ids` (+ select QField for grouping).
    const predStart = q.start + pred.index + pred[1].length;
    const predEnd = q.start + pred.index + pred[0].length;
    const rewrite = (addSelect: boolean): string => {
        const rel = (off: number) => off - q.start;
        let s = queryText.slice(0, rel(predStart)) + `${qField} IN :${ids}` + queryText.slice(rel(predEnd));
        if (addSelect) s = s.slice(0, rel(q.selectEnd)) + `, ${qField}` + s.slice(rel(q.selectEnd));
        return s;
    };
    const lines = (...ls: string[]) => ls.map((l) => indent + l + eol).join('');

    if (ctx.kind === 'single') {
        if (!/^Id$/i.test(qField) || ctx.type.toLowerCase() !== q.object.toLowerCase()) return [];
        const map = uniqueName(text, `${plural(objBase)}ById`, reserved);
        const block = lines(
            `Set<Id> ${ids} = new Set<Id>();`,
            `for (${fe.type} ${fe.v} : ${iterable}) {`,
            `${unit}${ids}.add(${keyExpr});`,
            `}`,
            `Map<Id, ${q.object}> ${map} = new Map<Id, ${q.object}>(${reindent(rewrite(false), queryIndent, indent, eol)});`,
        );
        return [
            {
                title: `Bulkify SOQL: query ${q.object} once before the loop (Map by Id)`,
                preferred: true,
                edits: [
                    { start: lineStart, end: lineStart, newText: block },
                    { start: q.start, end: q.end + 1, newText: `${map}.get(${keyExpr})` },
                ],
            },
        ];
    }

    const selected = q.selectItems.some((s) => s.toLowerCase() === qField.toLowerCase());
    const map = uniqueName(text, `${plural(objBase)}By${cap(identBase(qField))}`, reserved);
    const rec = uniqueName(text, 'rec', reserved);
    const listT = `List<${q.object}>`;
    const block = lines(
        `Set<Id> ${ids} = new Set<Id>();`,
        `Map<Id, ${listT}> ${map} = new Map<Id, ${listT}>();`,
        `for (${fe.type} ${fe.v} : ${iterable}) {`,
        `${unit}${ids}.add(${keyExpr});`,
        `${unit}${map}.put(${keyExpr}, new ${listT}());`,
        `}`,
        `for (${q.object} ${rec} : ${reindent(rewrite(!selected), queryIndent, indent + unit, eol)}) {`,
        `${unit}${map}.get(${rec}.${qField}).add(${rec});`,
        `}`,
    );
    return [
        {
            title: `Bulkify SOQL: query ${q.object} once before the loop (Map by ${qField})`,
            preferred: true,
            edits: [
                { start: lineStart, end: lineStart, newText: block },
                { start: q.start, end: q.end + 1, newText: `${map}.get(${keyExpr})` },
            ],
        },
    ];
}

// ─── DML ──────────────────────────────────────────────────────────────────────────

const NON_SOBJECT_TYPES = /^(?:String|Integer|Long|Decimal|Double|Boolean|Id|Date|Datetime|Time|Blob|Object|List|Set|Map)$/i;

/**
 * `insert|update|delete|upsert x;` (at `start`) inside a loop, x the for-each variable or
 * a single record declared in the loop body → collect into a list, one DML after the loop.
 */
export function dmlInLoopFixes(text: string, start: number): TextFix[] {
    const m = maskCode(text);
    const st = /^(insert|update|delete|upsert)\s+([A-Za-z_]\w*)\s*;/i.exec(m.slice(start, start + 200));
    if (!st) return [];
    const p = prevNonWs(m, start - 1);
    // Must start a statement (`;`/`{`/`}` before it, or an unbraced `if (…)` / `else` body).
    if (p >= 0 && !/[;{})]/.test(m[p]) && !/\belse$/.test(m.slice(Math.max(0, p - 4), p + 1))) return [];
    const loop = innermostLoop(findLoops(m), start);
    if (!loop) return [];
    const layout = loopLayout(text, m, loop);
    if (!layout) return [];
    const body = m.slice(loop.bodyOpen + 1, loop.bodyClose);
    // `return` would skip the deferred DML; try/catch around it would change error handling.
    if (/\b(?:return|try)\b/.test(body)) return [];
    const op = st[1].toLowerCase();
    const x = st[2];
    const stmtEnd = start + st[0].length;
    // Using the record after the DML (e.g. reading x.Id after insert) needs the per-row DML.
    if (new RegExp(`\\b${escRe(x)}\\b`, 'i').test(m.slice(stmtEnd, loop.bodyClose))) return [];

    let type: string | undefined;
    const fe = forEachHeader(m, loop);
    const decl = new RegExp(`(?:^|[;{}])\\s*(?:final\\s+)?([A-Za-z_][\\w.]*)\\s+${escRe(x)}\\s*[=;]`, 'gi');
    const bodyBefore = m.slice(loop.bodyOpen + 1, start);
    let d: RegExpExecArray | null;
    while ((d = decl.exec(bodyBefore))) type = d[1];
    if (!type && fe && fe.v.toLowerCase() === x.toLowerCase()) type = fe.type;
    if (!type || !/^[A-Za-z_]\w*$/.test(type) || NON_SOBJECT_TYPES.test(type)) return [];
    if (op === 'upsert' && /^SObject$/i.test(type)) return []; // upsert needs a concrete list type

    // The deferred DML goes on its own line after the loop's last line.
    const endLineEnd = lineEndOf(text, loop.end);
    if (m.slice(loop.end + 1, endLineEnd).trim() !== '') return [];

    const eol = eolOf(text);
    const { lineStart, indent } = layout;
    const list = uniqueName(text, `${plural(identBase(type))}To${cap(op)}`, new Set());
    return [
        {
            title: `Bulkify DML: collect into '${list}' and ${op} once after the loop`,
            preferred: true,
            edits: [
                { start: lineStart, end: lineStart, newText: `${indent}List<${type}> ${list} = new List<${type}>();${eol}` },
                { start, end: stmtEnd, newText: `${list}.add(${x});` },
                { start: endLineEnd, end: endLineEnd, newText: `${eol}${indent}${op} ${list};` },
            ],
        },
    ];
}

// ─── Sharing ──────────────────────────────────────────────────────────────────────

/** Add a sharing keyword to a top-level (non-test) class declaration starting at `start`. */
export function sharingFixes(text: string, start: number): TextFix[] {
    const m = maskCode(text);
    const decl = /^(?:public|global)\s+((?:(?:virtual|abstract|with|without|inherited|sharing)\s+)*)class\s+[A-Za-z_]\w*/i.exec(m.slice(start, start + 300));
    if (!decl || /sharing/i.test(decl[1])) return [];
    let depth = 0;
    for (let i = 0; i < start; i++) {
        if (m[i] === '{') depth++;
        else if (m[i] === '}') depth--;
    }
    if (depth !== 0) return []; // inner class
    const before = m.slice(0, start);
    const annotations = before.slice(Math.max(before.lastIndexOf('}'), before.lastIndexOf(';')) + 1);
    if (/@IsTest\b/i.test(annotations)) return [];
    const at = start + decl[0].search(/\bclass\s+[A-Za-z_]\w*$/i);
    return [
        { title: "Add 'with sharing'", preferred: true, edits: [{ start: at, end: at, newText: 'with sharing ' }] },
        { title: "Add 'inherited sharing'", edits: [{ start: at, end: at, newText: 'inherited sharing ' }] },
    ];
}

// ─── System.debug ─────────────────────────────────────────────────────────────────

/** The edit deleting the `System.debug(…);` statement at `start` (whole line(s) when alone on them). */
export function debugRemovalEdit(text: string, start: number, m = maskCode(text)): OffsetEdit | undefined {
    const head = /^System\s*\.\s*debug\s*\(/i.exec(m.slice(start, start + 40));
    if (!head) return undefined;
    const close = matchClose(m, start + head[0].length - 1);
    if (close < 0) return undefined;
    const semi = skipWs(m, close + 1);
    if (m[semi] !== ';') return undefined;
    const p = prevNonWs(m, start - 1);
    if (p >= 0 && !/[;{}]/.test(m[p])) return undefined; // e.g. `if (x) System.debug(…);`
    const end = semi + 1;
    const ls = lineStartOf(text, start);
    const le = lineEndOf(text, end);
    if (m.slice(ls, start).trim() === '' && m.slice(end, le).trim() === '') {
        let next = le;
        if (text[next] === '\r') next++;
        if (text[next] === '\n') next++;
        return { start: ls, end: next, newText: '' };
    }
    let e = end;
    while (e < le && (text[e] === ' ' || text[e] === '\t')) e++;
    return { start, end: e, newText: '' };
}

export function debugFixes(text: string, start: number): TextFix[] {
    const m = maskCode(text);
    const one = debugRemovalEdit(text, start, m);
    if (!one) return [];
    const fixes: TextFix[] = [{ title: 'Remove System.debug() statement', preferred: true, edits: [one] }];
    const all: OffsetEdit[] = [];
    for (const mm of m.matchAll(/\bSystem\s*\.\s*debug\s*\(/gi)) {
        const e = debugRemovalEdit(text, mm.index ?? 0, m);
        if (e && (!all.length || e.start >= all[all.length - 1].end)) all.push(e);
    }
    if (all.length > 1) fixes.push({ title: `Remove all System.debug() statements in file (${all.length})`, edits: all });
    return fixes;
}

// ─── Syntax: missing ';' ──────────────────────────────────────────────────────────

/** For a parser "missing ';' at …" error at `off`, insert ';' after the previous code token. */
export function missingSemicolonFix(text: string, off: number): TextFix[] {
    const m = maskCode(text);
    const p = prevNonWs(m, Math.min(off, m.length) - 1);
    if (p < 0 || m[p] === ';' || m[p] === '{' || m[p] === '}') return [];
    return [{ title: "Insert missing ';'", preferred: true, edits: [{ start: p + 1, end: p + 1, newText: ';' }] }];
}
