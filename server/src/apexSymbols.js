"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseApex = parseApex;
exports.enclosingClass = enclosingClass;
exports.resolveVarType = resolveVarType;
/**
 * Apex parsing for the language server, built on @apexdevtools/apex-parser (pure
 * JS CST, no JVM). Produces a document outline (DocumentSymbol tree) and syntax
 * diagnostics. The symbol table it builds is also the basis for member completion
 * and go-to-definition in later increments.
 */
const node_1 = require("vscode-languageserver/node");
const apex_parser_1 = require("@apexdevtools/apex-parser");
// antlr tokens: line is 1-based, column 0-based.
function startPos(token) {
    return node_1.Position.create((token?.line ?? 1) - 1, token?.column ?? 0);
}
function endPos(token) {
    const len = typeof token?.text === 'string' ? token.text.length : 0;
    return node_1.Position.create((token?.line ?? 1) - 1, (token?.column ?? 0) + len);
}
function ctxRange(ctx) {
    return node_1.Range.create(startPos(ctx?.start), endPos(ctx?.stop ?? ctx?.start));
}
function nameRange(idCtx, fallback) {
    const t = idCtx?.start ?? fallback?.start;
    return node_1.Range.create(startPos(t), endPos(t));
}
class DiagnosticCollector extends apex_parser_1.ApexErrorListener {
    constructor(diagnostics) {
        super();
        this.diagnostics = diagnostics;
    }
    apexSyntaxError(line, column, msg) {
        const pos = node_1.Position.create(Math.max(0, line - 1), Math.max(0, column));
        this.diagnostics.push({
            severity: node_1.DiagnosticSeverity.Error,
            range: node_1.Range.create(pos, node_1.Position.create(pos.line, pos.character + 1)),
            message: msg,
            source: 'asfx-apex',
        });
    }
}
class SymbolListener extends apex_parser_1.ApexParserBaseListener {
    constructor() {
        super(...arguments);
        this.roots = [];
        this.index = { types: new Map(), varTypes: new Map(), varDecls: [], classRanges: [], decls: new Map(), methods: new Map() };
        this.fieldAccesses = [];
        this.stack = [];
        this.typeNameStack = [];
        this.methodScope = []; // enclosing method/constructor ranges (for local/param scope)
        this.classScope = []; // enclosing class/interface/enum ranges (for field/property scope)
        // `receiver.member` where the RHS is an identifier (field/property/relationship),
        // NOT a method call (`dotMethodCall` alternative). The grammar splits these, so
        // method invocations like `acc.put('x', v)` are naturally excluded.
        this.enterDotExpression = (ctx) => {
            if (ctx.dotMethodCall?.())
                return; // method call, not a field access
            const idc = ctx.anyId?.();
            const baseCtx = ctx.expression?.();
            if (!idc || !baseCtx)
                return;
            const chain = baseCtx.getText?.();
            const member = idc.getText?.();
            if (!chain || !member)
                return;
            this.fieldAccesses.push({ chain, member, range: nameRange(idc, ctx) });
        };
        this.enterClassDeclaration = (ctx) => this.pushType(ctx, node_1.SymbolKind.Class);
        this.exitClassDeclaration = () => this.popType();
        this.enterInterfaceDeclaration = (ctx) => this.pushType(ctx, node_1.SymbolKind.Interface);
        this.exitInterfaceDeclaration = () => this.popType();
        this.enterEnumDeclaration = (ctx) => this.pushType(ctx, node_1.SymbolKind.Enum);
        this.exitEnumDeclaration = () => this.popType();
        this.enterTriggerUnit = (ctx) => this.pushType(ctx, node_1.SymbolKind.Class);
        this.exitTriggerUnit = () => this.popType();
        this.enterMethodDeclaration = (ctx) => {
            const ret = ctx.typeRef?.()?.getText?.() ?? 'void';
            const name = ctx.id?.()?.getText() ?? '<method>';
            const params = formalParams(ctx);
            const sig = `${name}(${params.join(', ')}) : ${ret}`;
            const sym = makeSymbol(name, node_1.SymbolKind.Method, ctxRange(ctx), nameRange(ctx.id?.(), ctx));
            sym.detail = `(${params.join(', ')}) : ${ret}`;
            this.container().push(sym);
            this.currentMembers()?.push({ name, kind: 'method', detail: sym.detail });
            this.recordDecl(name, ctx.id?.(), ctx);
            const sigs = this.index.methods.get(name) ?? [];
            sigs.push(sig);
            this.index.methods.set(name, sigs);
            this.methodScope.push(ctxRange(ctx));
        };
        this.exitMethodDeclaration = () => { this.methodScope.pop(); };
        this.enterConstructorDeclaration = (ctx) => {
            const name = ctx.qualifiedName?.()?.getText?.() ?? ctx.id?.()?.getText?.() ?? '<ctor>';
            this.container().push(makeSymbol(name, node_1.SymbolKind.Constructor, ctxRange(ctx), nameRange(ctx.qualifiedName?.() ?? ctx.id?.(), ctx)));
            this.methodScope.push(ctxRange(ctx));
        };
        this.exitConstructorDeclaration = () => { this.methodScope.pop(); };
        this.enterFieldDeclaration = (ctx) => {
            const type = ctx.typeRef?.()?.getText?.() ?? '';
            const vds = ctx.variableDeclarators?.();
            // apex-parser v5 (antlr4 target) exposes repeated rules via `<rule>_list()`.
            const list = vds?.variableDeclarator_list?.() ?? [];
            for (const d of list) {
                const id = d?.id?.();
                if (!id)
                    continue;
                const name = id.getText();
                const sym = makeSymbol(name, node_1.SymbolKind.Field, ctxRange(d), nameRange(id, d));
                sym.detail = type;
                this.container().push(sym);
                this.currentMembers()?.push({ name, kind: 'field', detail: type });
                this.addVar(name, type, id, 'member');
                this.recordDecl(name, id, d);
            }
        };
        this.enterPropertyDeclaration = (ctx) => {
            const type = ctx.typeRef?.()?.getText?.() ?? '';
            const name = ctx.id?.()?.getText?.() ?? '<prop>';
            const sym = makeSymbol(name, node_1.SymbolKind.Property, ctxRange(ctx), nameRange(ctx.id?.(), ctx));
            sym.detail = type;
            this.container().push(sym);
            this.currentMembers()?.push({ name, kind: 'property', detail: type });
            this.addVar(name, type, ctx.id?.(), 'member');
            this.recordDecl(name, ctx.id?.(), ctx);
        };
        // Locals and parameters feed the (flat) variable-type map for member completion
        // and the declaration map for go-to-definition.
        this.enterLocalVariableDeclaration = (ctx) => {
            const type = ctx.typeRef?.()?.getText?.() ?? '';
            if (!type)
                return;
            const list = ctx.variableDeclarators?.()?.variableDeclarator_list?.() ?? [];
            for (const d of list) {
                const id = d?.id?.();
                const name = id?.getText?.();
                if (name) {
                    this.addVar(name, type, id, 'local');
                    this.recordDecl(name, id, d);
                }
            }
        };
        this.enterFormalParameter = (ctx) => {
            const type = ctx.typeRef?.()?.getText?.();
            const id = ctx.id?.();
            const name = id?.getText?.();
            if (type && name) {
                this.addVar(name, type, id, 'local');
                this.recordDecl(name, id, ctx);
            }
        };
    }
    /** Scope a declaration is visible in: its method (locals/params) or class (members). */
    scopeFor(kind) {
        if (kind === 'local' && this.methodScope.length)
            return this.methodScope[this.methodScope.length - 1];
        if (this.classScope.length)
            return this.classScope[this.classScope.length - 1];
        return node_1.Range.create(0, 0, 1000000, 0); // whole document fallback
    }
    addVar(name, type, idCtx, kind) {
        if (!name || !type)
            return;
        this.index.varTypes.set(name, type); // flat, last-wins fallback
        this.index.varDecls.push({ name, type, line: (idCtx?.start?.line ?? 1) - 1, scope: this.scopeFor(kind) });
    }
    recordDecl(name, idCtx, fallback) {
        if (name)
            this.index.decls.set(name, nameRange(idCtx, fallback));
    }
    container() {
        const top = this.stack[this.stack.length - 1];
        return top ? (top.children ?? (top.children = [])) : this.roots;
    }
    currentMembers() {
        const name = this.typeNameStack[this.typeNameStack.length - 1];
        return name ? this.index.types.get(name) : undefined;
    }
    pushType(ctx, kind) {
        const name = ctx.id?.()?.getText() ?? '<anonymous>';
        const range = ctxRange(ctx);
        const sym = makeSymbol(name, kind, range, nameRange(ctx.id?.(), ctx));
        sym.children = [];
        this.container().push(sym);
        this.stack.push(sym);
        this.typeNameStack.push(name);
        if (!this.index.types.has(name))
            this.index.types.set(name, []);
        if (kind === node_1.SymbolKind.Class)
            this.index.classRanges.push({ name, range });
        this.classScope.push(range);
        this.recordDecl(name, ctx.id?.(), ctx);
    }
    popType() {
        this.stack.pop();
        this.typeNameStack.pop();
        this.classScope.pop();
    }
}
/** Extract `Type name` strings for a method's formal parameters. */
function formalParams(methodCtx) {
    const list = methodCtx?.formalParameters?.()?.formalParameterList?.()?.formalParameter_list?.() ?? [];
    return list.map((p) => {
        const t = p?.typeRef?.()?.getText?.() ?? '';
        const n = p?.id?.()?.getText?.() ?? '';
        return `${t} ${n}`.trim();
    });
}
function makeSymbol(name, kind, range, selectionRange) {
    // selectionRange must be contained in range; fall back to range if not.
    const sel = isContained(range, selectionRange) ? selectionRange : range;
    return { name, kind, range, selectionRange: sel };
}
function isContained(outer, inner) {
    return ((inner.start.line > outer.start.line ||
        (inner.start.line === outer.start.line && inner.start.character >= outer.start.character)) &&
        (inner.end.line < outer.end.line ||
            (inner.end.line === outer.end.line && inner.end.character <= outer.end.character)));
}
function parseApex(text) {
    const diagnostics = [];
    let symbols = [];
    let index = { types: new Map(), varTypes: new Map(), varDecls: [], classRanges: [], decls: new Map(), methods: new Map() };
    let fieldAccesses = [];
    try {
        const parser = apex_parser_1.ApexParserFactory.createParser(text);
        parser.removeErrorListeners();
        parser.addErrorListener(new DiagnosticCollector(diagnostics));
        const tree = parser.compilationUnit();
        const listener = new SymbolListener();
        apex_parser_1.ApexParseTreeWalker.DEFAULT.walk(listener, tree);
        symbols = listener.roots;
        index = listener.index;
        fieldAccesses = listener.fieldAccesses;
    }
    catch {
        // Parsing failed hard; keep whatever diagnostics we collected.
    }
    return { symbols, diagnostics, index, fieldAccesses };
}
/** Innermost class name whose range contains the position, for `this` resolution. */
function enclosingClass(index, line, character) {
    let best;
    for (const c of index.classRanges) {
        const r = c.range;
        const inside = (line > r.start.line || (line === r.start.line && character >= r.start.character)) &&
            (line < r.end.line || (line === r.end.line && character <= r.end.character));
        if (!inside)
            continue;
        const size = (r.end.line - r.start.line) * 10000 + (r.end.character - r.start.character);
        if (!best || size < best.size)
            best = { name: c.name, size };
    }
    return best?.name;
}
function rangeContains(r, line, character) {
    const afterStart = line > r.start.line || (line === r.start.line && character >= r.start.character);
    const beforeEnd = line < r.end.line || (line === r.end.line && character <= r.end.character);
    return afterStart && beforeEnd;
}
function rangeSize(r) {
    return (r.end.line - r.start.line) * 100000 + (r.end.character - r.start.character);
}
/**
 * Resolve a variable's declared type at a position: the nearest in-scope declaration
 * that precedes it (innermost scope wins, then latest declaration). Fixes same-name
 * variables declared with different types in different methods, which the flat
 * `varTypes` map (last-wins) gets wrong. Falls back to the flat map when unscoped.
 */
function resolveVarType(index, name, line, character) {
    const lc = name.toLowerCase();
    let best;
    for (const d of index.varDecls) {
        if (d.name.toLowerCase() !== lc)
            continue;
        if (d.line > line)
            continue; // declared after the cursor
        if (!rangeContains(d.scope, line, character))
            continue;
        if (!best) {
            best = d;
            continue;
        }
        const dSize = rangeSize(d.scope);
        const bSize = rangeSize(best.scope);
        if (dSize < bSize || (dSize === bSize && d.line >= best.line))
            best = d;
    }
    return best?.type ?? index.varTypes.get(name);
}
//# sourceMappingURL=apexSymbols.js.map