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

/** A variable/param/field declaration with the scope it's visible in (for scope-aware resolution). */
export interface VarDecl {
    name: string;
    type: string;
    /** Line the declaration sits on (0-based). */
    line: number;
    /** The range this declaration is visible in — its enclosing method/constructor (locals/params) or class (fields). */
    scope: Range;
    /** Column (0-based) where the declared name starts on `line` (set by parseApex). */
    character?: number;
}

/** A member declared in a type body, with its modifiers (for hierarchy / rename). */
export interface ApexMemberDecl {
    name: string;
    kind: 'method' | 'field' | 'property' | 'constructor';
    /** The declared name token. */
    nameRange: Range;
    /** The whole declaration. */
    range: Range;
    /** Lower-cased modifiers (`public`, `static`, `abstract`, `virtual`, `override`, `@istest`…). */
    modifiers: string[];
}

/** A class/interface/enum/trigger declaration with its supertypes and members. */
export interface ApexTypeDecl {
    name: string;
    kind: 'class' | 'interface' | 'enum' | 'trigger';
    /** Name of the enclosing type for inner types (Apex allows one level). */
    outer?: string;
    /** Lower-cased modifiers (`abstract`, `virtual`, `public`, `with sharing` → `with`,`sharing`…). */
    modifiers: string[];
    /** `extends` target of a class (generics stripped), e.g. `Base` or `Outer.Base`. */
    extendsType?: string;
    /** `implements` targets of a class / `extends` list of an interface (generics stripped). */
    implementsTypes: string[];
    nameRange: Range;
    range: Range;
    members: ApexMemberDecl[];
}

export interface ApexIndex {
    /** User-defined type name (class/interface/enum) → its members. */
    types: Map<string, ApexMember[]>;
    /** Variable/param/field name → declared type (flat, document-wide; last-wins fallback). */
    varTypes: Map<string, string>;
    /** All declarations, scoped — resolve a variable's type at a position (handles same-name vars in different methods). */
    varDecls: VarDecl[];
    /** Class declarations with their full ranges, for `this` resolution. */
    classRanges: { name: string; range: Range }[];
    /** Symbol name → its declaration's name range (flat; for go-to-definition). */
    decls: Map<string, Range>;
    /** Method name → signature label(s) (overloads; for signature help). */
    methods: Map<string, string[]>;
    /**
     * Every type declaration (top-level and inner) with supertypes, modifiers and member
     * name ranges — for rename / implementation / type hierarchy. Always set by parseApex
     * (optional only so hand-built indexes stay valid).
     */
    typeDecls?: ApexTypeDecl[];
}

/**
 * A `receiver.member` field/property access (NOT a method call). The `chain` is
 * the raw text of the base expression (e.g. `acc`, `acc.Contact__r`); `member`
 * is the accessed name; (`line`, `character`) is where the member token starts
 * (0-based; it spans `member.length` characters). Used by the schema validator to
 * flag members that don't exist on the resolved SObject.
 *
 * Only accesses the validator can act on are kept: a plain identifier chain whose
 * root is a variable declared in the document (anything else it skips anyway).
 * Stored without a Range object — these are the most numerous parse records.
 */
export interface FieldAccess {
    chain: string;
    member: string;
    line: number;
    character: number;
}

/** A plain identifier dot-chain (no calls/indexing/casts) — the only chains the validator resolves. */
const IDENT_CHAIN = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

export interface ApexParseResult {
    symbols: DocumentSymbol[];
    diagnostics: Diagnostic[];
    index: ApexIndex;
    fieldAccesses: FieldAccess[];
}

/**
 * Per-parse string canonicalizer. ANTLR builds token/rule text by per-character
 * concatenation, so every `getText()` returns a fresh (often rope/cons) string, and
 * the same identifier or type is materialized many times per file. Routing every
 * retained string through one map flattens it (map hashing flattens ropes) and makes
 * repeated names/types share a single instance. The map itself is dropped with the
 * listener after the parse.
 */
class Interner {
    private map = new Map<string, string>();
    s(x: string): string;
    s(x: string | undefined): string | undefined;
    s(x: string | undefined): string | undefined {
        if (x === undefined) return undefined;
        const hit = this.map.get(x);
        if (hit !== undefined) return hit;
        // Long strings from ANTLR are ropes of per-character pieces; copy them into one
        // flat string so the pieces can be collected. (Short ones are already flat.)
        const flat = x.length >= 13 ? (JSON.parse(JSON.stringify(x)) as string) : x;
        this.map.set(flat, flat);
        return flat;
    }
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
    constructor(public diagnostics: Diagnostic[], private readonly strings: Interner) {
        super();
    }
    apexSyntaxError(line: number, column: number, msg: string): void {
        const pos = Position.create(Math.max(0, line - 1), Math.max(0, column));
        this.diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: Range.create(pos, Position.create(pos.line, pos.character + 1)),
            message: this.strings.s(msg),
            source: 'asfx-apex',
        });
    }
}

class SymbolListener extends ApexParserBaseListener {
    constructor(private readonly strings: Interner) {
        super();
    }
    roots: DocumentSymbol[] = [];
    index: ApexIndex = { types: new Map(), varTypes: new Map(), varDecls: [], classRanges: [], decls: new Map(), methods: new Map(), typeDecls: [] };
    fieldAccesses: FieldAccess[] = [];
    private stack: DocumentSymbol[] = [];
    private typeNameStack: string[] = [];
    private typeDeclStack: ApexTypeDecl[] = [];
    private methodScope: Range[] = []; // enclosing method/constructor ranges (for local/param scope)
    private classScope: Range[] = [];  // enclosing class/interface/enum ranges (for field/property scope)

    /** Scope a declaration is visible in: its method (locals/params) or class (members). */
    private scopeFor(kind: 'local' | 'member'): Range {
        if (kind === 'local' && this.methodScope.length) return this.methodScope[this.methodScope.length - 1];
        if (this.classScope.length) return this.classScope[this.classScope.length - 1];
        return Range.create(0, 0, 1_000_000, 0); // whole document fallback
    }
    /** Interned text of a parse-tree node (see Interner). */
    private text(node: any): string | undefined {
        const t = node?.getText?.();
        return typeof t === 'string' ? this.strings.s(t) : undefined;
    }
    private addVar(name: string | undefined, type: string, idCtx: any, kind: 'local' | 'member'): void {
        if (!name || !type) return;
        this.index.varTypes.set(name, type); // flat, last-wins fallback
        this.index.varDecls.push({
            name,
            type,
            line: (idCtx?.start?.line ?? 1) - 1,
            scope: this.scopeFor(kind),
            character: idCtx?.start?.column ?? 0,
        });
    }

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
        if (!chain || !member || !IDENT_CHAIN.test(chain)) return; // the validator skips non-plain chains
        const t = idc.start ?? ctx.start;
        this.fieldAccesses.push({
            chain: this.strings.s(chain),
            member: this.strings.s(member),
            line: (t?.line ?? 1) - 1,
            character: t?.column ?? 0,
        });
    };

    /** Record a declaration; reuses `range` (the symbol's own name range object) when given. */
    private recordDecl(name: string | undefined, idCtx: any, fallback: any, range?: Range): void {
        if (name) this.index.decls.set(name, range ?? nameRange(idCtx, fallback));
    }

    /** Drop field accesses whose root isn't a declared variable — the validator can't resolve them. */
    finish(): void {
        const declared = new Set(this.index.varDecls.map((d) => d.name.toLowerCase()));
        for (const k of this.index.varTypes.keys()) declared.add(k.toLowerCase());
        this.fieldAccesses = this.fieldAccesses.filter((a) => {
            const dot = a.chain.indexOf('.');
            return declared.has((dot === -1 ? a.chain : a.chain.slice(0, dot)).toLowerCase());
        });
    }

    private container(): DocumentSymbol[] {
        const top = this.stack[this.stack.length - 1];
        return top ? (top.children ??= []) : this.roots;
    }
    private currentMembers(): ApexMember[] | undefined {
        const name = this.typeNameStack[this.typeNameStack.length - 1];
        return name ? this.index.types.get(name) : undefined;
    }

    /** Lower-cased modifiers of a declaration (from its own list or its classBodyDeclaration / typeDeclaration). */
    private modifiersOf(ctx: any): string[] {
        let list: any[] | undefined = ctx?.modifier_list?.();
        if (!list || !list.length) {
            let p = ctx?.parentCtx;
            // methodDeclaration → memberDeclaration → classBodyDeclaration; classDeclaration → typeDeclaration
            for (let i = 0; i < 2 && p && !(p.modifier_list?.()?.length); i++) p = p.parentCtx;
            list = p?.modifier_list?.() ?? [];
        }
        const out: string[] = [];
        for (const m of list ?? []) {
            const t = m?.getText?.();
            if (typeof t !== 'string') continue;
            const lc = t.toLowerCase();
            // `withsharing` etc. come out concatenated (getText drops whitespace) — split known pairs.
            const pair = /^(with|without|inherited)sharing$/.exec(lc);
            if (pair) out.push(this.strings.s(pair[1]), 'sharing');
            else out.push(this.strings.s(lc.startsWith('@') ? lc.replace(/\(.*$/, '') : lc));
        }
        return out;
    }
    private currentTypeDecl(): ApexTypeDecl | undefined {
        return this.typeDeclStack[this.typeDeclStack.length - 1];
    }
    private addMemberDecl(name: string, kind: ApexMemberDecl['kind'], nameR: Range, range: Range, modCtx: any): void {
        this.currentTypeDecl()?.members.push({ name, kind, nameRange: nameR, range, modifiers: this.modifiersOf(modCtx) });
    }
    private stripGenerics(t: string | undefined): string | undefined {
        if (!t) return undefined;
        const s = t.replace(/<.*$/s, '').replace(/\[\]$/, '').trim();
        return s ? this.strings.s(s) : undefined;
    }

    private pushType(ctx: any, kind: SymbolKind): void {
        const name = this.text(ctx.id?.()) ?? '<anonymous>';
        const range = ctxRange(ctx);
        const sel = nameRange(ctx.id?.(), ctx);
        {
            const outer = this.typeDeclStack.length ? this.typeDeclStack[this.typeDeclStack.length - 1].name : undefined;
            const k: ApexTypeDecl['kind'] =
                kind === SymbolKind.Interface ? 'interface' : kind === SymbolKind.Enum ? 'enum' : ctx.TRIGGER ? 'trigger' : 'class';
            let extendsType: string | undefined;
            const implementsTypes: string[] = [];
            const listTypes = (tl: any): string[] =>
                ((tl?.typeRef_list?.() ?? []) as any[]).map((t) => this.stripGenerics(this.text(t))).filter((x): x is string => !!x);
            if (k === 'class') {
                extendsType = ctx.EXTENDS?.() ? this.stripGenerics(this.text(ctx.typeRef?.())) : undefined;
                if (ctx.IMPLEMENTS?.()) implementsTypes.push(...listTypes(ctx.typeList?.()));
            } else if (k === 'interface' && ctx.EXTENDS?.()) {
                implementsTypes.push(...listTypes(ctx.typeList?.()));
            }
            const decl: ApexTypeDecl = {
                name,
                kind: k,
                outer,
                modifiers: k === 'trigger' ? [] : this.modifiersOf(ctx),
                extendsType,
                implementsTypes,
                nameRange: sel,
                range,
                members: [],
            };
            if (!outer) delete decl.outer;
            if (!extendsType) delete decl.extendsType;
            this.index.typeDecls!.push(decl);
            this.typeDeclStack.push(decl);
        }
        const sym = makeSymbol(name, kind, range, sel);
        sym.children = [];
        this.container().push(sym);
        this.stack.push(sym);
        this.typeNameStack.push(name);
        if (!this.index.types.has(name)) this.index.types.set(name, []);
        if (kind === SymbolKind.Class) this.index.classRanges.push({ name, range });
        this.classScope.push(range);
        this.recordDecl(name, ctx.id?.(), ctx, sel);
    }
    private popType(): void {
        this.typeDeclStack.pop();
        this.stack.pop();
        this.typeNameStack.pop();
        this.classScope.pop();
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
        const ret = this.text(ctx.typeRef?.()) ?? 'void';
        const name = this.text(ctx.id?.()) ?? '<method>';
        const params = formalParams(ctx);
        const sig = this.strings.s(`${name}(${params.join(', ')}) : ${ret}`);
        const range = ctxRange(ctx);
        const sel = nameRange(ctx.id?.(), ctx);
        const sym = makeSymbol(name, SymbolKind.Method, range, sel);
        sym.detail = this.strings.s(`(${params.join(', ')}) : ${ret}`);
        this.container().push(sym);
        this.currentMembers()?.push({ name, kind: 'method', detail: sym.detail });
        this.addMemberDecl(name, 'method', sel, range, ctx);
        this.recordDecl(name, ctx.id?.(), ctx, sel);
        const sigs = this.index.methods.get(name) ?? [];
        sigs.push(sig);
        this.index.methods.set(name, sigs);
        this.methodScope.push(range);
    };
    exitMethodDeclaration = () => { this.methodScope.pop(); };
    // Interface methods (`Integer area();`) are a separate grammar rule; record them like
    // methods (outline, members, signatures) and give their parameters a method scope.
    enterInterfaceMethodDeclaration = (ctx: any) => {
        const ret = this.text(ctx.typeRef?.()) ?? 'void';
        const name = this.text(ctx.id?.()) ?? '<method>';
        const params = formalParams(ctx);
        const range = ctxRange(ctx);
        const sel = nameRange(ctx.id?.(), ctx);
        const sym = makeSymbol(name, SymbolKind.Method, range, sel);
        sym.detail = this.strings.s(`(${params.join(', ')}) : ${ret}`);
        this.container().push(sym);
        this.currentMembers()?.push({ name, kind: 'method', detail: sym.detail });
        this.addMemberDecl(name, 'method', sel, range, ctx);
        this.recordDecl(name, ctx.id?.(), ctx, sel);
        const sigs = this.index.methods.get(name) ?? [];
        sigs.push(this.strings.s(`${name}(${params.join(', ')}) : ${ret}`));
        this.index.methods.set(name, sigs);
        this.methodScope.push(range);
    };
    exitInterfaceMethodDeclaration = () => { this.methodScope.pop(); };
    enterConstructorDeclaration = (ctx: any) => {
        const name = this.text(ctx.qualifiedName?.()) ?? this.text(ctx.id?.()) ?? '<ctor>';
        const range = ctxRange(ctx);
        const sel = nameRange(ctx.qualifiedName?.() ?? ctx.id?.(), ctx);
        this.container().push(makeSymbol(name, SymbolKind.Constructor, range, sel));
        this.addMemberDecl(name, 'constructor', sel, range, ctx);
        this.methodScope.push(range);
    };
    exitConstructorDeclaration = () => { this.methodScope.pop(); };
    enterFieldDeclaration = (ctx: any) => {
        const type = this.text(ctx.typeRef?.()) ?? '';
        const vds = ctx.variableDeclarators?.();
        // apex-parser v5 (antlr4 target) exposes repeated rules via `<rule>_list()`.
        const list: any[] = vds?.variableDeclarator_list?.() ?? [];
        for (const d of list) {
            const id = d?.id?.();
            if (!id) continue;
            const name = this.text(id) as string;
            const sel = nameRange(id, d);
            const sym = makeSymbol(name, SymbolKind.Field, ctxRange(d), sel);
            sym.detail = type;
            this.container().push(sym);
            this.currentMembers()?.push({ name, kind: 'field', detail: type });
            this.addMemberDecl(name, 'field', sel, ctxRange(d), ctx);
            this.addVar(name, type, id, 'member');
            this.recordDecl(name, id, d, sel);
        }
    };
    enterPropertyDeclaration = (ctx: any) => {
        const type = this.text(ctx.typeRef?.()) ?? '';
        const name = this.text(ctx.id?.()) ?? '<prop>';
        const sel = nameRange(ctx.id?.(), ctx);
        const sym = makeSymbol(name, SymbolKind.Property, ctxRange(ctx), sel);
        sym.detail = type;
        this.container().push(sym);
        this.currentMembers()?.push({ name, kind: 'property', detail: type });
        this.addMemberDecl(name, 'property', sel, ctxRange(ctx), ctx);
        this.addVar(name, type, ctx.id?.(), 'member');
        this.recordDecl(name, ctx.id?.(), ctx, sel);
    };

    // Locals and parameters feed the (flat) variable-type map for member completion
    // and the declaration map for go-to-definition.
    enterLocalVariableDeclaration = (ctx: any) => {
        const type = this.text(ctx.typeRef?.()) ?? '';
        if (!type) return;
        const list: any[] = ctx.variableDeclarators?.()?.variableDeclarator_list?.() ?? [];
        for (const d of list) {
            const id = d?.id?.();
            const name = this.text(id);
            if (name) {
                this.addVar(name, type, id, 'local');
                this.recordDecl(name, id, d);
            }
        }
    };
    // `for (Account a : accs)` and `catch (DmlException e)` declare locals too.
    enterEnhancedForControl = (ctx: any) => {
        const type = this.text(ctx.typeRef?.());
        const id = ctx.id?.();
        const name = this.text(id);
        if (type && name) {
            this.addVar(name, type, id, 'local');
            this.recordDecl(name, id, ctx);
        }
    };
    enterCatchClause = (ctx: any) => {
        const type = this.text(ctx.qualifiedName?.());
        const id = ctx.id?.();
        const name = this.text(id);
        if (type && name) {
            this.addVar(name, type, id, 'local');
            this.recordDecl(name, id, ctx);
        }
    };
    enterFormalParameter = (ctx: any) => {
        const type = this.text(ctx.typeRef?.());
        const id = ctx.id?.();
        const name = this.text(id);
        if (type && name) {
            this.addVar(name, type, id, 'local');
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
    let index: ApexIndex = { types: new Map(), varTypes: new Map(), varDecls: [], classRanges: [], decls: new Map(), methods: new Map(), typeDecls: [] };
    let fieldAccesses: FieldAccess[] = [];
    try {
        // Nothing below may keep a reference to the parser, token stream or parse tree:
        // only plain objects (symbols, ranges, interned strings) leave this function.
        const strings = new Interner();
        const parser = ApexParserFactory.createParser(text);
        parser.removeErrorListeners();
        parser.addErrorListener(new DiagnosticCollector(diagnostics, strings));
        const tree = parser.compilationUnit();
        const listener = new SymbolListener(strings);
        ApexParseTreeWalker.DEFAULT.walk(listener, tree);
        listener.finish();
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

function rangeContains(r: Range, line: number, character: number): boolean {
    const afterStart = line > r.start.line || (line === r.start.line && character >= r.start.character);
    const beforeEnd = line < r.end.line || (line === r.end.line && character <= r.end.character);
    return afterStart && beforeEnd;
}
function rangeSize(r: Range): number {
    return (r.end.line - r.start.line) * 100_000 + (r.end.character - r.start.character);
}

/**
 * Resolve a variable's declared type at a position: the nearest in-scope declaration
 * that precedes it (innermost scope wins, then latest declaration). Fixes same-name
 * variables declared with different types in different methods, which the flat
 * `varTypes` map (last-wins) gets wrong. Falls back to the flat map when unscoped.
 */
export function resolveVarType(index: ApexIndex, name: string, line: number, character: number): string | undefined {
    const lc = name.toLowerCase();
    let best: VarDecl | undefined;
    for (const d of index.varDecls) {
        if (d.name.toLowerCase() !== lc) continue;
        if (d.line > line) continue; // declared after the cursor
        if (!rangeContains(d.scope, line, character)) continue;
        if (!best) { best = d; continue; }
        const dSize = rangeSize(d.scope);
        const bSize = rangeSize(best.scope);
        if (dSize < bSize || (dSize === bSize && d.line >= best.line)) best = d;
    }
    return best?.type ?? index.varTypes.get(name);
}
