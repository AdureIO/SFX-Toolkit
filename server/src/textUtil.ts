/**
 * Pure text helpers shared by the feature modules (no LSP / connection state).
 */

export function isApex(uri: string): boolean {
    return /\.(cls|trigger)$/i.test(uri) || /\.apex$/i.test(uri);
}

export function hasNamespacePrefix(name: string, ns: string): boolean {
    return name.toLowerCase().startsWith(ns.toLowerCase() + '__');
}

/** Strip a leading managed-package namespace: `ns__Name__r` → `name__r` (lower-cased). */
export function stripLeadingNamespace(name: string): string {
    const p = name.toLowerCase().split('__');
    return p.length >= 3 ? p.slice(1).join('__') : name.toLowerCase();
}

/** Namespace-optional, case-insensitive match (e.g. `DataSource__r` ≈ `sfy24__DataSource__r`). */
export function nameMatchesNsOptional(apiName: string, typed: string): boolean {
    const a = apiName.toLowerCase();
    const b = typed.toLowerCase();
    return a === b || stripLeadingNamespace(a) === stripLeadingNamespace(b);
}

/** Namespace-optional prefix match for member completion: `datasource__c` matches `sfy24__Datasource__c`. */
export function matchesMemberPrefix(label: string, partial: string): boolean {
    const l = label.toLowerCase();
    return l.startsWith(partial) || stripLeadingNamespace(l).startsWith(partial);
}

/** Strip generic args / array suffix: `List<Account>` → `List`, `Account[]` → `Account`. */
export function baseTypeName(type: string): string {
    return type.replace(/<.*$/, '').replace(/\[\]$/, '').trim();
}

const APEX_DECL_KEYWORDS = new Set([
    'return', 'new', 'else', 'final', 'public', 'private', 'protected', 'global', 'static',
    'void', 'if', 'for', 'while', 'do', 'try', 'catch', 'throw', 'this', 'super', 'instanceof',
]);

/**
 * Resolve a receiver's declared type by scanning the document text, as a fallback
 * when the parse index misses it (e.g. mid-edit, when the current line `emp.N`
 * makes the method body temporarily unparseable). Handles `Type receiver` and
 * `receiver = new Type(...)`.
 */
export function regexReceiverType(text: string, receiver: string): string | undefined {
    const assign = new RegExp(`\\b${receiver}\\s*=\\s*new\\s+([A-Za-z_][\\w.]*)`).exec(text);
    if (assign) return assign[1];
    const decl = new RegExp(`\\b([A-Za-z_][\\w.]*(?:<[^>]*>)?)\\s+${receiver}\\b`).exec(text);
    if (decl && !APEX_DECL_KEYWORDS.has(decl[1].toLowerCase())) return decl[1];
    return undefined;
}

/** Word boundaries around an offset: returns [start, end, word] or null. */
export function wordSpanAt(text: string, offset: number): [number, number, string] | null {
    let start = offset;
    let end = offset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    const word = text.slice(start, end);
    return /^[A-Za-z_]\w*$/.test(word) ? [start, end, word] : null;
}

/** Identifier immediately before a `.` that precedes `wordStart`, or null. */
export function receiverBefore(text: string, wordStart: number): string | null {
    let i = wordStart - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (text[i] !== '.') return null;
    i--;
    while (i >= 0 && /\s/.test(text[i])) i--;
    let end = i + 1;
    let start = end;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    const recv = text.slice(start, end);
    return /^[A-Za-z_]\w*$/.test(recv) ? recv : null;
}

/** Brace nesting depth at an offset (0 = top level), used to limit lints to top-level classes. */
export function braceDepthAt(text: string, off: number): number {
    let d = 0;
    for (let i = 0; i < off && i < text.length; i++) {
        const c = text[i];
        if (c === '{') d++;
        else if (c === '}') d--;
    }
    return d;
}
