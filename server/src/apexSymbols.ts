/**
 * Apex parsing for the language server, built on @apexdevtools/apex-parser (pure
 * JS CST, no JVM). Produces a document outline (DocumentSymbol tree) and syntax
 * diagnostics. The symbol table it builds is also the basis for member completion
 * and go-to-definition in later increments.
 */
import {
    DocumentSymbol,
    SymbolKind,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    Position,
} from 'vscode-languageserver/node';
import {
    ApexParserFactory,
    ApexParseTreeWalker,
    ApexParserBaseListener,
    ApexErrorListener,
} from '@apexdevtools/apex-parser';

export interface ApexMember {
    name: string;
    kind: 'method' | 'field' | 'property' | 'constructor';
    detail?: string;
}

export interface ApexIndex {
    /** User-defined type name (class/interface/enum) → its members. */
    types: Map<string, ApexMember[]>;
    /** Variable/param/field name → declared type (flat, document-wide). */
    varTypes: Map<string, string>;
    /** Class declarations with their full ranges, for `this` resolution. */
    classRanges: { name: string; range: Range }[];
    /** Symbol name → its declaration's name range (flat; for go-to-definition). */
    decls: Map<string, Range>;
    /** Method name → signature label(s) (overloads; for signature help). */
    methods: Map<string, string[]>;
}

/**
 * A `receiver.member` field/property access (NOT a method call). The `chain` is
 * the raw text of the base expression (e.g. `acc`, `acc.Contact__r`); `member`
 * is the accessed name; `range` covers the member token. Used by the schema
 * validator to flag members that don't exist on the resolved SObject.
 */
export interface FieldAccess {
    chain: string;
    member: string;
    range: Range;
}

export interface ApexParseResult {
    symbols: DocumentSymbol[];
    diagnostics: Diagnostic[];
    index: ApexIndex;
    fieldAccesses: FieldAccess[];
}

// antlr tokens: line is 1-based, column 0-based.
function startPos(token: any): Position {
    return Position.create((token?.line ?? 1) - 1, token?.column ?? 0);
}
function endPos(token: any): Position {
    const len = typeof token?.text === 'string' ? token.text.length : 0;
    return Position.create((token?.line ?? 1) - 1, (token?.column ?? 0) + len);
}
function ctxRange(ctx: any): Range {
    return Range.create(startPos(ctx?.start), endPos(ctx?.stop ?? ctx?.start));
}
function nameRange(idCtx: any, fallback: any): Range {
    const t = idCtx?.start ?? fallback?.start;
    return Range.create(startPos(t), endPos(t));
}

class DiagnosticCollector extends ApexErrorListener {
    constructor(public diagnostics: Diagnostic[]) {
        super();
    }
    apexSyntaxError(line: number, column: number, msg: string): void {
        const pos = Position.create(Math.max(0, line - 1), Math.max(0, column));
        this.diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: Range.create(pos, Position.create(pos.line, pos.character + 1)),
            message: msg,
            source: 'asfx-apex',
        });
    }
}

class SymbolListener extends ApexParserBaseListener {
    roots: DocumentSymbol[] = [];
    index: ApexIndex = { types: new Map(), varTypes: new Map(), classRanges: [], decls: new Map(), methods: new Map() };
    fieldAccesses: FieldAccess[] = [];
    private stack: DocumentSymbol[] = [];
    private typeNameStack: string[] = [];

    // `receiver.member` where the RHS is an identifier (field/property/relationship),
    // NOT a method call (`dotMethodCall` alternative). The grammar splits these, so
    // method invocations like `acc.put('x', v)` are naturally excluded.
    enterDotExpression = (ctx: any) => {
        if (ctx.dotMethodCall?.()) return; // method call, not a field access
        const idc = ctx.anyId?.();
        const baseCtx = ctx.expression?.();
        if (!idc || !baseCtx) return;
        const chain = baseCtx.getText?.();
        const member = idc.getText?.();
        if (!chain || !member) return;
        this.fieldAccesses.push({ chain, member, range: nameRange(idc, ctx) });
    };

    private recordDecl(name: string | undefined, idCtx: any, fallback: any): void {
        if (name) this.index.decls.set(name, nameRange(idCtx, fallback));
    }

    private container(): DocumentSymbol[] {
        const top = this.stack[this.stack.length - 1];
        return top ? (top.children ??= []) : this.roots;
    }
    private currentMembers(): ApexMember[] | undefined {
        const name = this.typeNameStack[this.typeNameStack.length - 1];
        return name ? this.index.types.get(name) : undefined;
    }

    private pushType(ctx: any, kind: SymbolKind): void {
        const name = ctx.id?.()?.getText() ?? '<anonymous>';
        const range = ctxRange(ctx);
        const sym = makeSymbol(name, kind, range, nameRange(ctx.id?.(), ctx));
        sym.children = [];
        this.container().push(sym);
        this.stack.push(sym);
        this.typeNameStack.push(name);
        if (!this.index.types.has(name)) this.index.types.set(name, []);
        if (kind === SymbolKind.Class) this.index.classRanges.push({ name, range });
        this.recordDecl(name, ctx.id?.(), ctx);
    }
    private popType(): void {
        this.stack.pop();
        this.typeNameStack.pop();
    }

    enterClassDeclaration = (ctx: any) => this.pushType(ctx, SymbolKind.Class);
    exitClassDeclaration = () => this.popType();
    enterInterfaceDeclaration = (ctx: any) => this.pushType(ctx, SymbolKind.Interface);
    exitInterfaceDeclaration = () => this.popType();
    enterEnumDeclaration = (ctx: any) => this.pushType(ctx, SymbolKind.Enum);
    exitEnumDeclaration = () => this.popType();
    enterTriggerUnit = (ctx: any) => this.pushType(ctx, SymbolKind.Class);
    exitTriggerUnit = () => this.popType();

    enterMethodDeclaration = (ctx: any) => {
        const ret = ctx.typeRef?.()?.getText?.() ?? 'void';
        const name = ctx.id?.()?.getText() ?? '<method>';
        const params = formalParams(ctx);
        const sig = `${name}(${params.join(', ')}) : ${ret}`;
        const sym = makeSymbol(name, SymbolKind.Method, ctxRange(ctx), nameRange(ctx.id?.(), ctx));
        sym.detail = `(${params.join(', ')}) : ${ret}`;
        this.container().push(sym);
        this.currentMembers()?.push({ name, kind: 'method', detail: sym.detail });
        this.recordDecl(name, ctx.id?.(), ctx);
        const sigs = this.index.methods.get(name) ?? [];
        sigs.push(sig);
        this.index.methods.set(name, sigs);
    };
    enterConstructorDeclaration = (ctx: any) => {
        const name = ctx.qualifiedName?.()?.getText?.() ?? ctx.id?.()?.getText?.() ?? '<ctor>';
        this.container().push(makeSymbol(name, SymbolKind.Constructor, ctxRange(ctx), nameRange(ctx.qualifiedName?.() ?? ctx.id?.(), ctx)));
    };
    enterFieldDeclaration = (ctx: any) => {
        const type = ctx.typeRef?.()?.getText?.() ?? '';
        const vds = ctx.variableDeclarators?.();
        // apex-parser v5 (antlr4 target) exposes repeated rules via `<rule>_list()`.
        const list: any[] = vds?.variableDeclarator_list?.() ?? [];
        for (const d of list) {
            const id = d?.id?.();
            if (!id) continue;
            const name = id.getText();
            const sym = makeSymbol(name, SymbolKind.Field, ctxRange(d), nameRange(id, d));
            sym.detail = type;
            this.container().push(sym);
            this.currentMembers()?.push({ name, kind: 'field', detail: type });
            if (type) this.index.varTypes.set(name, type);
            this.recordDecl(name, id, d);
        }
    };
    enterPropertyDeclaration = (ctx: any) => {
        const type = ctx.typeRef?.()?.getText?.() ?? '';
        const name = ctx.id?.()?.getText?.() ?? '<prop>';
        const sym = makeSymbol(name, SymbolKind.Property, ctxRange(ctx), nameRange(ctx.id?.(), ctx));
        sym.detail = type;
        this.container().push(sym);
        this.currentMembers()?.push({ name, kind: 'property', detail: type });
        if (type) this.index.varTypes.set(name, type);
        this.recordDecl(name, ctx.id?.(), ctx);
    };

    // Locals and parameters feed the (flat) variable-type map for member completion
    // and the declaration map for go-to-definition.
    enterLocalVariableDeclaration = (ctx: any) => {
        const type = ctx.typeRef?.()?.getText?.() ?? '';
        if (!type) return;
        const list: any[] = ctx.variableDeclarators?.()?.variableDeclarator_list?.() ?? [];
        for (const d of list) {
            const id = d?.id?.();
            const name = id?.getText?.();
            if (name) {
                this.index.varTypes.set(name, type);
                this.recordDecl(name, id, d);
            }
        }
    };
    enterFormalParameter = (ctx: any) => {
        const type = ctx.typeRef?.()?.getText?.();
        const id = ctx.id?.();
        const name = id?.getText?.();
        if (type && name) {
            this.index.varTypes.set(name, type);
            this.recordDecl(name, id, ctx);
        }
    };
}

/** Extract `Type name` strings for a method's formal parameters. */
function formalParams(methodCtx: any): string[] {
    const list: any[] =
        methodCtx?.formalParameters?.()?.formalParameterList?.()?.formalParameter_list?.() ?? [];
    return list.map((p) => {
        const t = p?.typeRef?.()?.getText?.() ?? '';
        const n = p?.id?.()?.getText?.() ?? '';
        return `${t} ${n}`.trim();
    });
}

function makeSymbol(name: string, kind: SymbolKind, range: Range, selectionRange: Range): DocumentSymbol {
    // selectionRange must be contained in range; fall back to range if not.
    const sel = isContained(range, selectionRange) ? selectionRange : range;
    return { name, kind, range, selectionRange: sel };
}
function isContained(outer: Range, inner: Range): boolean {
    return (
        (inner.start.line > outer.start.line ||
            (inner.start.line === outer.start.line && inner.start.character >= outer.start.character)) &&
        (inner.end.line < outer.end.line ||
            (inner.end.line === outer.end.line && inner.end.character <= outer.end.character))
    );
}

export function parseApex(text: string): ApexParseResult {
    const diagnostics: Diagnostic[] = [];
    let symbols: DocumentSymbol[] = [];
    let index: ApexIndex = { types: new Map(), varTypes: new Map(), classRanges: [], decls: new Map(), methods: new Map() };
    let fieldAccesses: FieldAccess[] = [];
    try {
        const parser = ApexParserFactory.createParser(text);
        parser.removeErrorListeners();
        parser.addErrorListener(new DiagnosticCollector(diagnostics));
        const tree = parser.compilationUnit();
        const listener = new SymbolListener();
        ApexParseTreeWalker.DEFAULT.walk(listener, tree);
        symbols = listener.roots;
        index = listener.index;
        fieldAccesses = listener.fieldAccesses;
    } catch {
        // Parsing failed hard; keep whatever diagnostics we collected.
    }
    return { symbols, diagnostics, index, fieldAccesses };
}

/** Innermost class name whose range contains the position, for `this` resolution. */
export function enclosingClass(index: ApexIndex, line: number, character: number): string | undefined {
    let best: { name: string; size: number } | undefined;
    for (const c of index.classRanges) {
        const r = c.range;
        const inside =
            (line > r.start.line || (line === r.start.line && character >= r.start.character)) &&
            (line < r.end.line || (line === r.end.line && character <= r.end.character));
        if (!inside) continue;
        const size = (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
        if (!best || size < best.size) best = { name: c.name, size };
    }
    return best?.name;
}
