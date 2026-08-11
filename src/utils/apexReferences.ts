/**
 * Find references to an Apex symbol.
 *
 * Scope-aware rather than a plain text search: a local variable or parameter only matches inside
 * the method that declares it, so two methods each with an `acc` don't bleed into one another.
 * Fields, methods and types are searched across the file (and, by the caller, the workspace).
 *
 * Pure — no LSP connection or filesystem — so it can be unit-tested against real Apex snippets.
 */

import { Range, Position } from 'vscode-languageserver/node';

/** The slice of the Apex parse index this module needs (structurally compatible with ApexIndex). */
export interface ApexIndexLike {
    varDecls: { name: string; scope: Range }[];
    classRanges: { name: string; range: Range }[];
}

/** What the cursor is on, and how far its references can reach. */
export interface ApexSymbolRef {
    name: string;
    /** Set for locals/params: references are confined to this range. Absent = whole file/workspace. */
    scope?: Range;
    /** True when the symbol is a local/param (never worth searching other files for). */
    localOnly: boolean;
}

const IDENTIFIER = /[A-Za-z_]\w*/g;

/** Blank comments and string literals so matches inside them don't count (offsets preserved). */
export function blankNonCode(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
        .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length));
}

function offsetAt(lines: string[], pos: Position): number {
    let offset = 0;
    for (let i = 0; i < pos.line && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + pos.character;
}

function positionAt(lines: string[], offset: number): Position {
    let remaining = offset;
    for (let line = 0; line < lines.length; line++) {
        const len = lines[line].length + 1;
        if (remaining < len) return Position.create(line, remaining);
        remaining -= len;
    }
    return Position.create(Math.max(0, lines.length - 1), 0);
}

function inRange(range: Range, line: number): boolean {
    return line >= range.start.line && line <= range.end.line;
}

/** The identifier under `position`, or undefined when the cursor isn't on one. */
export function identifierAt(text: string, position: Position): string | undefined {
    const line = text.split('\n')[position.line];
    if (line === undefined) return undefined;
    IDENTIFIER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENTIFIER.exec(line)) !== null) {
        if (position.character >= m.index && position.character <= m.index + m[0].length) return m[0];
    }
    return undefined;
}

/**
 * Resolve what the cursor is on. A declaration whose scope contains the position wins, which is
 * what confines a local/param to its own method.
 */
export function symbolAt(text: string, index: ApexIndexLike, position: Position): ApexSymbolRef | undefined {
    const name = identifierAt(text, position);
    if (!name) return undefined;

    // Narrowest enclosing declaration with this name.
    const candidates = index.varDecls.filter((d) => d.name === name && inRange(d.scope, position.line));
    if (candidates.length) {
        const narrowest = candidates.reduce((a, b) =>
            b.scope.end.line - b.scope.start.line < a.scope.end.line - a.scope.start.line ? b : a
        );
        // A class-wide scope means a field — visible to other files through an instance.
        const isField = index.classRanges.some(
            (c) => c.range.start.line === narrowest.scope.start.line && c.range.end.line === narrowest.scope.end.line
        );
        return { name, scope: narrowest.scope, localOnly: !isField };
    }
    return { name, localOnly: false };
}

/** Every whole-word occurrence of `name` in `text`, optionally confined to a line range. */
export function findReferencesInText(text: string, name: string, scope?: Range): Range[] {
    if (!name) return [];
    const lines = text.split('\n');
    const code = blankNonCode(text);
    const out: Range[] = [];
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
        const start = positionAt(lines, m.index);
        if (scope && !inRange(scope, start.line)) continue;
        out.push(Range.create(start, Position.create(start.line, start.character + name.length)));
    }
    return out;
}

/** Convenience: resolve the symbol at a position and return its references within this document. */
export function referencesInDocument(text: string, index: ApexIndexLike, position: Position): { ref: ApexSymbolRef; ranges: Range[] } | undefined {
    const ref = symbolAt(text, index, position);
    if (!ref) return undefined;
    return { ref, ranges: findReferencesInText(text, ref.name, ref.scope) };
}

// Keep the offset helper exported for callers that need it (kept last: implementation detail).
export const __internals = { offsetAt, positionAt };
