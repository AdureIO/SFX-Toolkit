"use strict";
/**
 * Find references to an Apex symbol.
 *
 * Scope-aware rather than a plain text search: a local variable or parameter only matches inside
 * the method that declares it, so two methods each with an `acc` don't bleed into one another.
 * Fields, methods and types are searched across the file (and, by the caller, the workspace).
 *
 * Pure — no LSP connection or filesystem — so it can be unit-tested against real Apex snippets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.__internals = void 0;
exports.blankNonCode = blankNonCode;
exports.identifierAt = identifierAt;
exports.symbolAt = symbolAt;
exports.findReferencesInText = findReferencesInText;
exports.referencesInDocument = referencesInDocument;
const node_1 = require("vscode-languageserver/node");
const IDENTIFIER = /[A-Za-z_]\w*/g;
/** Blank comments and string literals so matches inside them don't count (offsets preserved). */
function blankNonCode(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
        .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length));
}
function offsetAt(lines, pos) {
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++)
        offset += lines[i].length + 1;
    return offset + pos.character;
}
function positionAt(lines, offset) {
    let remaining = offset;
    for (let line = 0; line < lines.length; line++) {
        const len = lines[line].length + 1;
        if (remaining < len)
            return node_1.Position.create(line, remaining);
        remaining -= len;
    }
    return node_1.Position.create(Math.max(0, lines.length - 1), 0);
}
function inRange(range, line) {
    return line >= range.start.line && line <= range.end.line;
}
/** The identifier under `position`, or undefined when the cursor isn't on one. */
function identifierAt(text, position) {
    const line = text.split('\n')[position.line];
    if (line === undefined)
        return undefined;
    IDENTIFIER.lastIndex = 0;
    let m;
    while ((m = IDENTIFIER.exec(line)) !== null) {
        if (position.character >= m.index && position.character <= m.index + m[0].length)
            return m[0];
    }
    return undefined;
}
/**
 * Resolve what the cursor is on. A declaration whose scope contains the position wins, which is
 * what confines a local/param to its own method.
 */
function symbolAt(text, index, position) {
    const name = identifierAt(text, position);
    if (!name)
        return undefined;
    // Narrowest enclosing declaration with this name.
    const candidates = index.varDecls.filter((d) => d.name === name && inRange(d.scope, position.line));
    if (candidates.length) {
        const narrowest = candidates.reduce((a, b) => b.scope.end.line - b.scope.start.line < a.scope.end.line - a.scope.start.line ? b : a);
        // A class-wide scope means a field — visible to other files through an instance.
        const isField = index.classRanges.some((c) => c.range.start.line === narrowest.scope.start.line && c.range.end.line === narrowest.scope.end.line);
        return { name, scope: narrowest.scope, localOnly: !isField };
    }
    return { name, localOnly: false };
}
/** Every whole-word occurrence of `name` in `text`, optionally confined to a line range. */
function findReferencesInText(text, name, scope) {
    if (!name)
        return [];
    const lines = text.split('\n');
    const code = blankNonCode(text);
    const out = [];
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let m;
    while ((m = re.exec(code)) !== null) {
        const start = positionAt(lines, m.index);
        if (scope && !inRange(scope, start.line))
            continue;
        out.push(node_1.Range.create(start, node_1.Position.create(start.line, start.character + name.length)));
    }
    return out;
}
/** Convenience: resolve the symbol at a position and return its references within this document. */
function referencesInDocument(text, index, position) {
    const ref = symbolAt(text, index, position);
    if (!ref)
        return undefined;
    return { ref, ranges: findReferencesInText(text, ref.name, ref.scope) };
}
// Keep the offset helper exported for callers that need it (kept last: implementation detail).
exports.__internals = { offsetAt, positionAt };
//# sourceMappingURL=apexReferences.js.map