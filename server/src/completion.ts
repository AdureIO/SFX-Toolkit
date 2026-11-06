/**
 * Completion: SOQL (in .soql files and SOQL regions inside Apex) and org-aware Apex
 * completion (member access on any expression, `new`, constructor named args,
 * annotations, catch types, picklist values, locals/members/keywords/types at bare
 * identifier positions, standard library, statement snippets).
 *
 * Apex items carry no documentation: it's built in completionItem/resolve from the
 * item's small `data` record (see items.ts `lazy`).
 */
import {
    CancellationToken,
    Connection,
    CompletionItem,
    CompletionItemKind,
    CompletionList,
    CompletionParams,
    CompletionTriggerKind,
    InsertTextFormat,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'url';
import type { ServerContext } from './context';
import type { ApexMember, ApexParseResult } from './apexSymbols';
import type { ParseView } from './parseCache';
import { WorkspaceIndex } from './workspaceIndex';
import { STD_TYPES, StdMember, stdClass, stdConstructableTypes, stdNestedTypes } from './apexStdlib';
import {
    withSchemaDoc,
    sfxTag,
    applyNamespace,
    fieldSortTier,
    objectSortTier,
    lazy,
    lazyFieldItem,
    lazyRelItem,
    schemaDoc,
    plainDoc,
    fieldDocBody,
    LazyData,
} from './items';
import * as soql from './soql';
import { orCancelled, throwIfCancelled } from './cancel';
import { isApex, matchesMemberPrefix, nameMatchesNsOptional, stripLeadingNamespace } from './textUtil';
import {
    Resolver,
    MemberEntry,
    RValue,
    receiverExprBefore,
    splitGeneric,
    isObjectName,
    objectNames,
    invalidateObjectNames,
    mergeIndexes,
    findDecl,
} from './apexResolve';

/** Type-name lists (bare identifiers, after `new`) are capped server-side; the client re-asks as you type. */
export const TYPE_LIST_CAP = 200;

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onCompletion((params, token) => {
        // Soft deadline (schema.ts SchemaBudget): describes that outlive it mark the list
        // incomplete instead of blocking; the budget is passed down as the token.
        const budget = ctx.schema.completionBudget(token);
        return orCancelled<CompletionList>({ isIncomplete: false, items: [] }, async () => {
            const res = await complete(ctx, params, budget);
            const items = Array.isArray(res) ? res : res.items;
            return { isIncomplete: budget.incomplete || (!Array.isArray(res) && res.isIncomplete), items };
        });
    });
    connection.onCompletionResolve((item, token) => orCancelled<CompletionItem>(item, () => resolveCompletionItem(ctx, item, token)));

    // Cross-file lookups read open buffers (unsaved edits) instead of disk.
    WorkspaceIndex.setOpenDocProvider((file) => openDocIndex(ctx, file));
    // Pre-load workspace types an open document references once its parse lands.
    ctx.parses.onParsed((uri, result) => prewarmReferencedTypes(result));
    ctx.onSchemaRefresh((objects, info) => {
        // A full refresh or a structural one (objects created/deleted) changes the object list.
        if (!objects || info?.structural) invalidateObjectNames();
    });
}

// ─── Open-buffer index provider / pre-warming ───────────────────────────────────

const uriPathCache = new Map<string, string>();
function uriToPath(uri: string): string | undefined {
    let p = uriPathCache.get(uri);
    if (p !== undefined) return p || undefined;
    try {
        p = uri.startsWith('file:') ? fileURLToPath(uri) : '';
    } catch {
        p = '';
    }
    if (uriPathCache.size > 500) uriPathCache.clear();
    uriPathCache.set(uri, p);
    return p || undefined;
}

function openDocIndex(ctx: ServerContext, file: string): ReturnType<typeof mergeIndexes> | undefined {
    for (const d of ctx.documents.all()) {
        if (!isApex(d.uri) || uriToPath(d.uri) !== file) continue;
        const peek = ctx.parses.peek(d.uri);
        if (!peek) return undefined;
        return peek.good ? mergeIndexes([peek.latest.index, peek.good.index]) : mergeIndexes([peek.latest.index]);
    }
    return undefined;
}

function prewarmReferencedTypes(result: ApexParseResult): void {
    const names = new Set<string>();
    const own = new Set((result.index.typeDecls ?? []).map((d) => d.name.toLowerCase()));
    const add = (t: string | undefined) => {
        if (!t) return;
        for (const m of t.match(/[A-Za-z_]\w*/g) ?? []) if (!own.has(m.toLowerCase())) names.add(m);
    };
    for (const d of result.index.varDecls) add(d.type);
    for (const ms of result.index.types.values()) for (const m of ms) add(m.type);
    for (const d of result.index.typeDecls ?? []) {
        add(d.extendsType);
        for (const i of d.implementsTypes) add(i);
    }
    WorkspaceIndex.prewarm(names);
}

// ─── Entry ──────────────────────────────────────────────────────────────────────

/**
 * Completion reads the LAST completed parse (see ParseCache.forRead) for symbol/index
 * info — never forcing a full reparse on the keystroke path — while the token at the
 * cursor always comes from the live document text. Cursor positions are mapped into
 * the parse's coordinates before scope lookups.
 */
async function complete(ctx: ServerContext, params: CompletionParams, token: CancellationToken): Promise<CompletionItem[] | CompletionList> {
    throwIfCancelled(token);
    const uri = params.textDocument.uri;
    const position = params.position;
    const doc = ctx.documents.get(uri);
    if (!doc) return [];

    if (doc.languageId === 'soql') {
        // soql-language-server expects 1-based line/column.
        return soql.soqlCompletion(ctx.schema, uri, doc.getText(), position.line + 1, position.character + 1, token);
    }

    // Apex: inline [SELECT …] gets SOQL completion; otherwise Apex completion. Member
    // completion runs even when Apex features are gated off — its org-aware SObject
    // field results are additive to the Salesforce extension.
    const full = doc.getText();
    const offset = doc.offsetAt(position);
    const region = soql.soqlRegionAt(full, offset);
    if (region) {
        const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
        const bindPartial = bindVariablePartial(full.slice(lineStart, offset));
        if (bindPartial !== undefined) return bindVariableCompletion(ctx, doc, position, bindPartial);
        return soql.soqlCompletion(ctx.schema, uri, region.snippet, region.line, region.column, token);
    }
    if (!ctx.settings.apexCompletion) return [];

    const c = new ApexCompletion(ctx, doc, position, offset, token, params.context?.triggerKind === CompletionTriggerKind.Invoked || !params.context);
    return c.run();
}

/**
 * `:partial` bind variable inside inline SOQL → the partial, else undefined. Date
 * literals with a colon (`LAST_N_DAYS:5`, `NEXT_N_WEEKS:2`, `N_DAYS_AGO:3`) are not binds.
 */
export function bindVariablePartial(lineUpToCursor: string): string | undefined {
    const m = /:\s*(\w*)$/.exec(lineUpToCursor);
    if (!m) return undefined;
    const before = lineUpToCursor.slice(0, m.index);
    if (/(?:^|[^\w])(?:\w+_)?N_\w+$/i.test(before)) return undefined;
    return m[1];
}

async function bindVariableCompletion(
    ctx: ServerContext,
    doc: TextDocument,
    position: { line: number; character: number },
    partial: string,
): Promise<CompletionItem[]> {
    const r = new Resolver(ctx, doc, position, readViews(ctx, doc));
    const p = partial.toLowerCase();
    return r
        .visibleVars()
        .filter((v) => !p || v.name.toLowerCase().startsWith(p))
        .map((v) =>
            lazy(
                { label: v.name, kind: CompletionItemKind.Variable, labelDetails: { detail: ` : ${v.type}` }, sortText: '0_' + v.name },
                { k: 'v', x: 'bind variable' },
            ),
        );
}

function readViews(ctx: ServerContext, doc: TextDocument): ParseView[] {
    const latest = ctx.parses.forRead(doc);
    const good = ctx.parses.forReadGood(doc);
    return good ? [latest, good] : [latest];
}

// ─── Request-context ids (resolve needs the document for org-schema docs) ───────

const contextUris = new Map<number, string>();
let contextSeq = 0;
let lastContext: { uri: string; id: number } | undefined;
function contextId(uri: string): number {
    if (lastContext && lastContext.uri === uri && contextUris.get(lastContext.id) === uri) return lastContext.id;
    const id = ++contextSeq;
    contextUris.set(id, uri);
    while (contextUris.size > 64) contextUris.delete(contextUris.keys().next().value as number);
    lastContext = { uri, id };
    return id;
}

// ─── Apex completion ────────────────────────────────────────────────────────────

/** Apex primitives / value types that have no meaningful `new X()` constructor. */
const NON_CONSTRUCTABLE = new Set([
    'string', 'integer', 'long', 'decimal', 'double', 'boolean', 'id', 'blob', 'date', 'datetime', 'time', 'object', 'void', 'sobject',
]);

/** Keywords after which an identifier is NOT a newly declared name (so completion applies). */
const EXPRESSION_KEYWORDS = new Set([
    'return', 'new', 'else', 'throw', 'instanceof', 'extends', 'implements', 'when', 'static', 'final', 'public', 'private',
    'protected', 'global', 'override', 'virtual', 'abstract', 'transient', 'testmethod', 'webservice', 'do', 'try', 'finally',
    'insert', 'update', 'upsert', 'delete', 'undelete', 'merge', 'on', 'sharing', 'and', 'or', 'not', 'in', 'case',
]);

interface KeywordDef {
    label: string;
    insert?: string;
    detail: string;
}
const APEX_KEYWORDS: KeywordDef[] = [
    { label: 'if', insert: 'if (${1:condition}) {\n\t$0\n}', detail: 'if statement' },
    { label: 'else', detail: 'else branch' },
    { label: 'for', insert: 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}', detail: 'for-each loop' },
    { label: 'while', insert: 'while (${1:condition}) {\n\t$0\n}', detail: 'while loop' },
    { label: 'do', insert: 'do {\n\t$0\n} while (${1:condition});', detail: 'do / while loop' },
    { label: 'return', detail: 'return statement' },
    { label: 'try', insert: 'try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}', detail: 'try / catch' },
    { label: 'catch', detail: 'catch clause' },
    { label: 'finally', detail: 'finally clause' },
    { label: 'throw', detail: 'throw statement' },
    { label: 'switch', insert: 'switch on ${1:value} {\n\twhen ${2:value} {\n\t\t$0\n\t}\n\twhen else {\n\t}\n}', detail: 'switch on' },
    { label: 'when', detail: 'switch arm' },
    { label: 'new', detail: 'constructor call' },
    { label: 'insert', detail: 'DML insert' },
    { label: 'update', detail: 'DML update' },
    { label: 'upsert', detail: 'DML upsert' },
    { label: 'delete', detail: 'DML delete' },
    { label: 'undelete', detail: 'DML undelete' },
    { label: 'merge', detail: 'DML merge' },
    { label: 'break', detail: 'break' },
    { label: 'continue', detail: 'continue' },
    { label: 'this', detail: 'current instance' },
    { label: 'super', detail: 'superclass' },
    { label: 'null', detail: 'null literal' },
    { label: 'true', detail: 'Boolean literal' },
    { label: 'false', detail: 'Boolean literal' },
    { label: 'instanceof', detail: 'type test' },
    { label: 'public', detail: 'modifier' },
    { label: 'private', detail: 'modifier' },
    { label: 'protected', detail: 'modifier' },
    { label: 'global', detail: 'modifier' },
    { label: 'static', detail: 'modifier' },
    { label: 'final', detail: 'modifier' },
    { label: 'override', detail: 'modifier' },
    { label: 'virtual', detail: 'modifier' },
    { label: 'abstract', detail: 'modifier' },
    { label: 'transient', detail: 'modifier' },
    { label: 'with sharing', detail: 'sharing modifier' },
    { label: 'without sharing', detail: 'sharing modifier' },
    { label: 'inherited sharing', detail: 'sharing modifier' },
    { label: 'class', detail: 'class declaration' },
    { label: 'interface', detail: 'interface declaration' },
    { label: 'enum', detail: 'enum declaration' },
    { label: 'extends', detail: 'superclass' },
    { label: 'implements', detail: 'interfaces' },
    { label: 'void', detail: 'no return value' },
];

// Common Apex statement snippets, triggered by typing their prefix (label).
const APEX_SNIPPETS: { label: string; insert: string; detail: string }[] = [
    { label: 'sysdebug', insert: 'System.debug(${1:msg});', detail: 'System.debug(…)' },
    { label: 'soqlfor', insert: 'for (${1:SObject} ${2:record} : [SELECT ${3:Id} FROM ${1:SObject}${4: WHERE }]) {\n\t$0\n}', detail: 'SOQL for-loop' },
    { label: 'forlist', insert: 'for (${1:Type} ${2:item} : ${3:items}) {\n\t$0\n}', detail: 'for-each loop' },
    { label: 'ifelse', insert: 'if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}', detail: 'if / else' },
    { label: 'trycatch', insert: 'try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}', detail: 'try / catch' },
    { label: 'testmethod', insert: '@IsTest\nstatic void ${1:testName}() {\n\t$0\n}', detail: 'test method' },
    { label: 'auramethod', insert: "@AuraEnabled(cacheable=true)\npublic static ${1:Object} ${2:name}(${3}) {\n\t$0\n}", detail: 'cacheable AuraEnabled method' },
    { label: 'assertequals', insert: "Assert.areEqual(${1:expected}, ${2:actual}, '${3:message}');", detail: 'Assert.areEqual(…)' },
    { label: 'systemassert', insert: 'System.assertEquals(${1:expected}, ${2:actual});', detail: 'System.assertEquals(…)' },
    { label: 'insertdml', insert: 'insert ${1:records};', detail: 'insert DML' },
    { label: 'dbinsert', insert: 'Database.insert(${1:records}, ${2:false});', detail: 'Database.insert(…)' },
    { label: 'batchable', insert: 'global Database.QueryLocator start(Database.BatchableContext bc) {\n\treturn Database.getQueryLocator([SELECT Id FROM ${1:SObject}]);\n}\n\nglobal void execute(Database.BatchableContext bc, List<${1:SObject}> scope) {\n\t$0\n}\n\nglobal void finish(Database.BatchableContext bc) {\n}', detail: 'Batchable methods — add: implements Database.Batchable<SObject>' },
    { label: 'queueable', insert: 'public void execute(QueueableContext context) {\n\t$0\n}', detail: 'Queueable execute — add: implements Queueable' },
    { label: 'schedulable', insert: 'global void execute(SchedulableContext sc) {\n\t$0\n}', detail: 'Schedulable execute — add: implements Schedulable' },
    { label: 'trigger', insert: 'trigger ${1:Name} on ${2:SObject} (${3:before insert, after insert}) {\n\t$0\n}', detail: 'trigger declaration' },
    { label: 'triggerhandler', insert: 'switch on Trigger.operationType {\n\twhen BEFORE_INSERT {\n\t\t$1\n\t}\n\twhen AFTER_INSERT {\n\t\t$2\n\t}\n\twhen BEFORE_UPDATE {\n\t\t$3\n\t}\n\twhen AFTER_UPDATE {\n\t\t$0\n\t}\n}', detail: 'trigger context routing' },
];

// Standard Apex exception types, offered inside `catch (…)`.
const APEX_EXCEPTIONS = [
    'Exception', 'DmlException', 'QueryException', 'CalloutException', 'NullPointerException',
    'ListException', 'SObjectException', 'StringException', 'TypeException', 'MathException',
    'JSONException', 'NoAccessException', 'NoDataFoundException', 'LimitException', 'AsyncException',
    'SecurityException', 'InvalidParameterValueException', 'EmailException', 'SearchException', 'HandledException',
];

// Apex annotations offered after `@`. `snippet` (when present) fills in the common
// arguments as tabstops; otherwise the bare annotation is inserted.
interface AnnotationDef {
    name: string;
    snippet?: string;
    detail: string;
    doc: string;
}
const APEX_ANNOTATIONS: AnnotationDef[] = [
    { name: 'IsTest', detail: 'Test class / method', doc: 'Marks a class or method as a test.' },
    { name: "IsTest(SeeAllData=true)", snippet: 'IsTest(SeeAllData=true)', detail: 'Test with org data', doc: 'Test that can see existing org data.' },
    { name: 'TestSetup', detail: 'Test setup', doc: 'Creates records once for every test in the class.' },
    { name: 'TestVisible', detail: 'Expose to tests', doc: 'Makes a private/protected member visible to test methods.' },
    { name: 'AuraEnabled', detail: 'Expose to LWC / Aura', doc: 'Exposes a method or property to Lightning components.' },
    { name: 'AuraEnabled(cacheable=true)', snippet: 'AuraEnabled(cacheable=true)', detail: 'Cacheable (@wire)', doc: 'Read-only, cacheable method usable with @wire.' },
    { name: 'Future', detail: 'Async method', doc: 'Runs the static method asynchronously.' },
    { name: 'Future(callout=true)', snippet: 'Future(callout=true)', detail: 'Async + callouts', doc: 'Async method allowed to make callouts.' },
    { name: 'InvocableMethod', snippet: "InvocableMethod(label='${1:Label}' description='${2:Description}')", detail: 'Flow / REST action', doc: 'Exposes the method as an invocable action for Flow/REST.' },
    { name: 'InvocableVariable', snippet: "InvocableVariable(label='${1:Label}' description='${2:Description}' required=${3:false})", detail: 'Invocable variable', doc: 'Marks a field as input/output of an invocable method.' },
    { name: 'RemoteAction', detail: 'Visualforce remoting', doc: 'Exposes a static method to Visualforce JS remoting.' },
    { name: 'ReadOnly', detail: 'Read-only context', doc: 'Relaxes query row limits for read-only requests.' },
    { name: 'Deprecated', detail: 'Deprecated', doc: 'Marks the member deprecated for subscribers of a managed package.' },
    { name: 'SuppressWarnings', snippet: "SuppressWarnings('${1:PMD}')", detail: 'Suppress warnings', doc: 'Suppresses analyzer warnings on the element.' },
    { name: 'NamespaceAccessible', detail: 'Cross-package access', doc: 'Makes the member accessible to other packages that extend your namespace.' },
    { name: 'JsonAccess', snippet: "JsonAccess(serializable='${1:always}' deserializable='${2:always}')", detail: 'JSON (de)serialization', doc: 'Controls serialization/deserialization of the class across namespaces.' },
    { name: 'RestResource', snippet: "RestResource(urlMapping='/${1:resource}')", detail: 'REST resource', doc: 'Exposes an Apex class as a REST resource at a URL.' },
    { name: 'HttpGet', detail: 'REST GET', doc: 'Handles REST GET on the enclosing @RestResource.' },
    { name: 'HttpPost', detail: 'REST POST', doc: 'Handles REST POST on the enclosing @RestResource.' },
    { name: 'HttpPut', detail: 'REST PUT', doc: 'Handles REST PUT on the enclosing @RestResource.' },
    { name: 'HttpPatch', detail: 'REST PATCH', doc: 'Handles REST PATCH on the enclosing @RestResource.' },
    { name: 'HttpDelete', detail: 'REST DELETE', doc: 'Handles REST DELETE on the enclosing @RestResource.' },
];

/**
 * Typed-text filter for server-side filtered lists: a (namespace-optional) prefix, or a
 * match starting at a word boundary (camelCase / `_`) followed by the rest as a
 * subsequence — a superset of what the client's fuzzy matcher shows.
 */
export function matchesTyped(label: string, partial: string): boolean {
    if (!partial) return true;
    const l = label.toLowerCase();
    const p = partial.toLowerCase();
    if (l.startsWith(p) || stripLeadingNamespace(l).startsWith(p)) return true;
    for (let b = 1; b < label.length; b++) {
        const c = label[b];
        const prev = label[b - 1];
        const boundary = prev === '_' || (c >= 'A' && c <= 'Z' && !(prev >= 'A' && prev <= 'Z'));
        if (!boundary || l[b] !== p[0]) continue;
        let j = 1;
        for (let k = b + 1; k < l.length && j < p.length; k++) if (l[k] === p[j]) j++;
        if (j === p.length) return true;
    }
    return false;
}

/** Line-local check: is the cursor inside a `//` comment or a string literal? */
function inCommentOrString(lineUpToCursor: string): boolean {
    let inStr = false;
    for (let i = 0; i < lineUpToCursor.length; i++) {
        const ch = lineUpToCursor[i];
        if (inStr) {
            if (ch === '\\') i++;
            else if (ch === "'") inStr = false;
        } else if (ch === "'") inStr = true;
        else if (ch === '/' && lineUpToCursor[i + 1] === '/') return true;
    }
    return inStr;
}

const KIND_OF: Record<ApexMember['kind'], CompletionItemKind> = {
    method: CompletionItemKind.Method,
    field: CompletionItemKind.Field,
    property: CompletionItemKind.Property,
    constructor: CompletionItemKind.Constructor,
    enumValue: CompletionItemKind.EnumMember,
};

/** A call item: `name($0)` (or `name()` without parameters), signature inline, return type right. */
function callItem(name: string, params: string | undefined, returns: string | undefined, sortTier: string, data: LazyData): CompletionItem {
    const hasParams = !!params && params.trim().length > 0;
    return lazy(
        {
            label: name,
            kind: CompletionItemKind.Method,
            insertText: hasParams ? `${name}($0)` : `${name}()`,
            insertTextFormat: hasParams ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
            labelDetails: { detail: `(${params ?? ''})`, description: returns || 'void' },
            sortText: sortTier + '_' + name,
        },
        data,
    );
}

function userMemberItem(owner: string, m: ApexMember): CompletionItem {
    if (m.kind === 'method') return callItem(m.name, m.params, m.type, '3', { k: 'am', o: owner, x: 'method' });
    return lazy(
        {
            label: m.name,
            kind: KIND_OF[m.kind],
            labelDetails: m.kind === 'enumValue' ? { description: owner } : { detail: m.type ? ` : ${m.type}` : undefined, description: owner },
            sortText: '0_' + m.name,
        },
        { k: 'am', o: owner, x: m.kind },
    );
}

function stdMemberItem(owner: string, m: StdMember): CompletionItem {
    if (m.kind === 'method') return callItem(m.name, m.params, m.returns, '3', { k: 'sm', o: owner });
    const enumValue = m.static && m.returns === owner;
    return lazy(
        {
            label: m.name,
            kind: enumValue ? CompletionItemKind.EnumMember : CompletionItemKind.Field,
            labelDetails: enumValue ? { description: owner } : { detail: m.returns ? ` : ${m.returns}` : undefined, description: owner },
            sortText: '0_' + m.name,
        },
        { k: 'sm', o: owner },
    );
}

function typeItem(name: string, description: string, sortTier: string, kind: CompletionItemKind = CompletionItemKind.Class): CompletionItem {
    return lazy({ label: name, kind, labelDetails: { description }, sortText: sortTier + '_' + name }, { k: 'ty', x: description });
}

// A constructor item for `new <Type>(…)`.
function newTypeItem(typeName: string, tier: string, description?: string): CompletionItem {
    return lazy(
        {
            label: typeName,
            kind: CompletionItemKind.Constructor,
            insertText: `${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            labelDetails: description ? { detail: '()', description } : { detail: '()' },
            sortText: tier + '_' + typeName,
        },
        { k: 'ty', x: 'constructor' },
    );
}

/** A full `new Type()` expression item — includes the `new ` keyword (for the pre-`new` assignment position). */
function newExprItem(typeName: string, tier: string): CompletionItem {
    return lazy(
        {
            label: `new ${typeName}()`,
            kind: CompletionItemKind.Constructor,
            insertText: `new ${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            filterText: `new ${typeName}`,
            labelDetails: { detail: '', description: 'construct' },
            sortText: tier + '_' + typeName,
        },
        { k: 'ty', x: 'constructor' },
    );
}

class ApexCompletion {
    private readonly full: string;
    private readonly lineUpToCursor: string;
    private resolverInst: Resolver | undefined;
    private nsPromise: Promise<string | null> | undefined;

    constructor(
        private readonly ctx: ServerContext,
        private readonly doc: TextDocument,
        private readonly position: { line: number; character: number },
        private readonly offset: number,
        private readonly token: CancellationToken,
        /** Explicitly invoked (Ctrl+Space / typing a word) vs. a trigger character. */
        private readonly invoked: boolean,
    ) {
        this.full = doc.getText();
        const lineStart = this.full.lastIndexOf('\n', offset - 1) + 1;
        this.lineUpToCursor = this.full.slice(lineStart, offset);
    }

    private get resolver(): Resolver {
        this.resolverInst ??= new Resolver(this.ctx, this.doc, this.position, readViews(this.ctx, this.doc), this.token);
        return this.resolverInst;
    }

    private ns(): Promise<string | null> {
        this.nsPromise ??= this.ctx.schema.projectNamespace(this.doc.uri, this.token);
        return this.nsPromise;
    }

    private async finish(items: CompletionItem[], isIncomplete = false): Promise<CompletionItem[] | CompletionList> {
        applyNamespace(items, await this.ns());
        return isIncomplete ? { isIncomplete: true, items } : items;
    }

    async run(): Promise<CompletionItem[] | CompletionList> {
        const luc = this.lineUpToCursor;
        // Trivial positions (space/newline/comma after nothing interesting) answer fast.
        const pick = await this.picklistValues();
        if (pick) return pick;
        if (inCommentOrString(luc)) return [];
        const ann = this.annotations();
        if (ann) return ann;
        const cat = this.catchTypes();
        if (cat) return cat;
        const ctorArgs = await this.constructorArgs();
        if (ctorArgs) return ctorArgs;
        const ctor = await this.newCompletion();
        if (ctor) return ctor;
        const member = await this.memberCompletion();
        if (member) return member;
        return this.bareCompletion();
    }

    // ── `acc.Industry = '|'` ──
    private async picklistValues(): Promise<CompletionItem[] | undefined> {
        const m = /\.\s*([A-Za-z_]\w*)\s*(?:=|==|!=|<>)\s*'([^']*)$/.exec(this.lineUpToCursor);
        if (!m) return undefined;
        const dot = this.offset - this.lineUpToCursor.length + m.index;
        const expr = receiverExprBefore(this.full, dot);
        if (!expr) return [];
        const v = await this.resolver.exprValue(expr);
        if (!v || v.static || v.t.k !== 'sobject') return [];
        const owner = v.t.name;
        const d = await this.resolver.describe(owner);
        const f = d?.fields.find((x) => nameMatchesNsOptional(x.name, m[1]));
        if (!f || !f.picklistValues || !f.picklistValues.length) return [];
        const partial = m[2].toLowerCase();
        return f.picklistValues
            .filter((val) => !partial || val.toLowerCase().startsWith(partial))
            .map((val) =>
                lazy(
                    { label: val, kind: CompletionItemKind.EnumMember, insertText: val, detail: `${owner}.${f.name}`, sortText: '0_' + val },
                    { k: 'ev', x: 'picklist value' },
                ),
            );
    }

    // ── `@Annotation` ──
    private annotations(): CompletionItem[] | undefined {
        const m = /@(\w*)$/.exec(this.lineUpToCursor);
        if (!m) return undefined;
        const partial = m[1].toLowerCase();
        const items = APEX_ANNOTATIONS.filter((a) => !partial || a.name.toLowerCase().startsWith(partial)).map((a) => {
            const snippet = a.snippet !== undefined;
            // `@` is already typed and isn't a word char, so insert without it.
            const item: CompletionItem = {
                label: '@' + a.name,
                kind: CompletionItemKind.Keyword,
                insertText: a.snippet ?? a.name,
                insertTextFormat: snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
                filterText: a.name.replace(/[^\w].*$/, ''), // match the typed word after `@`
                detail: a.detail,
                sortText: '0_' + a.name,
            };
            return withSchemaDoc(item, [a.doc]);
        });
        return sfxTag(items);
    }

    // ── `catch (…)` ──
    private catchTypes(): CompletionItem[] | undefined {
        const m = /\bcatch\s*\(\s*([A-Za-z_]\w*)?$/.exec(this.lineUpToCursor);
        if (!m) return undefined;
        const partial = (m[1] ?? '').toLowerCase();
        return APEX_EXCEPTIONS.filter((e) => !partial || e.toLowerCase().startsWith(partial)).map((e) => typeItem(e, 'exception', '0'));
    }

    // ── `new Account(Name = 'x', |)` ──
    private async constructorArgs(): Promise<CompletionItem[] | CompletionList | undefined> {
        // `new Type(` with the cursor still inside the (unclosed) parens, no intervening generics.
        const m = /\bnew\s+([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(this.lineUpToCursor);
        if (!m) return undefined;
        const typeName = m[1];
        const argsSoFar = m[2];
        const lastSeg = argsSoFar.split(',').pop() ?? '';
        if (lastSeg.includes('=')) return undefined; // typing a value, not a field name
        // Only SObjects take `Field = value` arguments; user classes / std types never describe.
        if (findDecl(this.resolver.local, typeName) || WorkspaceIndex.hasType(typeName) || stdClass(typeName)) return undefined;
        if (!(await isObjectName(this.ctx, this.doc.uri, typeName, this.token))) return undefined;
        const d = await this.resolver.describe(typeName);
        if (!d) return undefined;
        const partial = (/([A-Za-z_]\w*)?$/.exec(lastSeg)?.[1] ?? '').toLowerCase();
        const used = new Set(
            argsSoFar
                .split(',')
                .map((s) => s.split('=')[0].trim().toLowerCase())
                .filter(Boolean),
        );
        const c = contextId(this.doc.uri);
        const items = d.fields
            .filter((f) => !used.has(f.name.toLowerCase()))
            .filter((f) => !partial || matchesMemberPrefix(f.name.toLowerCase(), partial))
            .map((f) =>
                lazy(
                    {
                        label: f.name,
                        kind: CompletionItemKind.Field,
                        insertText: `${f.name} = `,
                        labelDetails: { detail: ` : ${f.type}`, description: typeName },
                        sortText: fieldSortTier(f.name) + '_' + f.name,
                    },
                    { k: 'sf', o: typeName, c, x: 'constructor argument' },
                ),
            );
        return this.finish(items);
    }

    // ── `Type a = |` and `new |` ──
    private expectedAssignType(requireNew: boolean): string | undefined {
        const tail = requireNew ? 'new\\s+[\\w.<>]*' : '(?:new\\s+[\\w.<>]*)?';
        // `Type name = [new …]` — Type may carry (possibly nested) generics: List<String>, Map<Id, List<X>>.
        const declared = new RegExp(`(?:^|[\\s({;,])([A-Za-z_][\\w.]*(?:\\s*<.*>)?(?:\\[\\])?)\\s+[A-Za-z_]\\w*\\s*=\\s*${tail}$`).exec(this.lineUpToCursor);
        if (declared && !EXPRESSION_KEYWORDS.has(declared[1].toLowerCase())) return declared[1].trim();
        // `existingVar = [new …]` — resolve the variable's type.
        const reassign = new RegExp(`(?:^|[\\s({;,])([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)?)\\s*=\\s*${tail}$`).exec(this.lineUpToCursor);
        if (reassign) {
            const name = reassign[1];
            if (name.startsWith('this.')) {
                const field = name.slice(5);
                for (const ms of this.resolver.local.types.values()) {
                    const f = ms.find((x) => x.name.toLowerCase() === field.toLowerCase() && x.kind !== 'method');
                    if (f?.type) return f.type;
                }
                return undefined;
            }
            if (name.includes('.')) return undefined;
            return this.resolver.varType(name);
        }
        return undefined;
    }

    /** Whether `new <type>()` makes sense for a written type. */
    private async constructable(type: string): Promise<boolean> {
        const { base } = splitGeneric(type);
        if (NON_CONSTRUCTABLE.has(base.toLowerCase())) return false;
        const t = await this.resolver.typeByName(type);
        if (!t) return false;
        if (t.k === 'user') return t.decl.kind === 'class' && !t.decl.modifiers.includes('abstract');
        if (t.k === 'std') return !!t.cls.constructable;
        return t.k === 'sobject';
    }

    private async newCompletion(): Promise<CompletionItem[] | CompletionList | undefined> {
        const luc = this.lineUpToCursor;
        const afterNew = /(?:^|[^\w.])new\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.?)?$/i.exec(luc);
        // Assignment RHS just opened (`… = |`), but not a comparison/compound op (`==`, `<=`, `+=`, …).
        const assignOpen = /(?:^|[^=!<>+\-*/%&|^])=\s*$/.test(luc);

        if (!afterNew && assignOpen) {
            // Only when the LHS type is known AND constructable — never a popup for every `x = `.
            const expected = this.expectedAssignType(false);
            if (!expected || !(await this.constructable(expected))) return [];
            return this.finish([newExprItem(expected, '0')]);
        }
        if (!afterNew) return undefined;

        const typed = afterNew[1] ?? '';
        if (typed.includes('.')) return this.newQualified(typed);
        const partial = typed;
        const expected = this.expectedAssignType(true);
        const items: CompletionItem[] = [];
        const seen = new Set<string>();
        const push = (it: CompletionItem) => {
            const k = String(it.label).toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            items.push(it);
        };
        if (expected && !NON_CONSTRUCTABLE.has(splitGeneric(expected).base.toLowerCase())) push(newTypeItem(expected, '0'));

        // Generic collection constructors as snippets (`new List<Account>()`, Map, Set).
        const collections: { label: string; insert: string; key: string }[] = [
            { label: 'List<…>()', insert: 'List<${1:SObject}>()', key: 'List' },
            { label: 'Map<…, …>()', insert: 'Map<${1:Id}, ${2:SObject}>()', key: 'Map' },
            { label: 'Set<…>()', insert: 'Set<${1:Id}>()', key: 'Set' },
        ];
        for (const c of collections) {
            if (!matchesTyped(c.key, partial)) continue;
            push(
                lazy(
                    {
                        label: c.label,
                        kind: CompletionItemKind.Snippet,
                        insertText: c.insert,
                        insertTextFormat: InsertTextFormat.Snippet,
                        filterText: c.key,
                        detail: 'collection',
                        sortText: '0a_' + c.key,
                    },
                    { k: 'kw', x: 'collection constructor' },
                ),
            );
        }
        seen.add('list');
        seen.add('map');
        seen.add('set');

        const candidates: CompletionItem[] = [];
        // Same-file classes (not interfaces/enums/abstract).
        for (const d of this.resolver.local.decls) {
            if (d.kind !== 'class' || d.modifiers.includes('abstract')) continue;
            const label = d.outer && !this.resolver.local.decls.some((x) => x.name === d.outer && !x.outer) ? `${d.outer}.${d.name}` : d.name;
            if (matchesTyped(label, partial)) candidates.push(newTypeItem(label, '1', 'Apex class'));
        }
        for (const name of WorkspaceIndex.allTypeNames()) if (matchesTyped(name, partial)) candidates.push(newTypeItem(name, '2', 'Apex class'));
        for (const name of stdConstructableTypes()) {
            if (name.includes('.') || name === 'List' || name === 'Map' || name === 'Set') continue;
            if (matchesTyped(name, partial)) candidates.push(newTypeItem(name, '3', 'System'));
        }
        const expectedBase = expected ? splitGeneric(expected).base.toLowerCase() : '';
        for (const name of await objectNames(this.ctx, this.doc.uri, this.token)) {
            if (name.toLowerCase() === expectedBase || !matchesTyped(name, partial)) continue;
            candidates.push(newTypeItem(name, objectSortTier(name) === '0' ? '4' : '5', 'SObject'));
        }
        return this.capped(items, candidates, push);
    }

    /** `new Outer.|` / `new Database.|` → constructable nested types. */
    private async newQualified(typed: string): Promise<CompletionItem[] | CompletionList> {
        const dot = typed.lastIndexOf('.');
        const outer = typed.slice(0, dot);
        const items: CompletionItem[] = [];
        const t = await this.resolver.typeByName(outer);
        if (t && t.k === 'user') {
            for (const d of t.ft.decls) if (d.outer === t.decl.name && d.kind === 'class' && !d.modifiers.includes('abstract')) items.push(newTypeItem(d.name, '0', t.decl.name));
        } else {
            for (const c of stdNestedTypes(outer)) if (c.constructable) items.push(newTypeItem(c.name.slice(outer.length + 1), '0', outer));
        }
        return this.finish(items);
    }

    /** Append prefix-filtered type candidates, capped (sorted by tier) — isIncomplete when capped. */
    private async capped(items: CompletionItem[], candidates: CompletionItem[], push: (it: CompletionItem) => void): Promise<CompletionItem[] | CompletionList> {
        let incomplete = false;
        if (candidates.length > TYPE_LIST_CAP) {
            candidates.sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''));
            candidates.length = TYPE_LIST_CAP;
            incomplete = true;
        }
        for (const c of candidates) push(c);
        return this.finish(items, incomplete);
    }

    // ── `receiver.partial` ──
    private async memberCompletion(): Promise<CompletionItem[] | CompletionList | undefined> {
        const m = /\.\s*(\w*)$/.exec(this.lineUpToCursor);
        if (!m) return undefined;
        const dot = this.offset - this.lineUpToCursor.length + m.index;
        if (/\d/.test(this.full[dot - 1] ?? '') && /(?:^|[^\w])\d+$/.test(this.full.slice(Math.max(0, dot - 20), dot))) return []; // `1.5`
        const expr = receiverExprBefore(this.full, dot);
        if (!expr) return [];
        const v = await this.resolver.exprValue(expr);
        if (!v) return [];
        const entries = await this.resolver.members(v);
        throwIfCancelled(this.token);
        const partial = m[1];
        const items: CompletionItem[] = [];
        const c = contextId(this.doc.uri);
        let objects = 0;
        let incomplete = false;
        for (const e of entries) {
            if (e.src === 'object') {
                // Schema.SObjectType.<object>: the org's whole object list — filter + cap.
                if (!matchesTyped(e.name, partial)) continue;
                if (++objects > TYPE_LIST_CAP) {
                    incomplete = true;
                    continue;
                }
            }
            items.push(this.entryItem(e, c));
        }
        // Whole member list (small): the client's fuzzy matcher filters (`acc.city` → BillingCity).
        return this.finish(items, incomplete);
    }

    private entryItem(e: MemberEntry, c: number): CompletionItem {
        switch (e.src) {
            case 'user':
                return userMemberItem(e.owner, e.m);
            case 'std':
                return stdMemberItem(e.owner, e.m);
            case 'field':
                return lazyFieldItem(e.owner, e.f, c);
            case 'rel':
                return lazyRelItem(e.owner, e.f);
            case 'child':
                return lazy(
                    {
                        label: e.name,
                        kind: CompletionItemKind.Field,
                        labelDetails: { detail: ` → List<${e.child}>`, description: e.owner },
                        sortText: '1_' + e.name,
                    },
                    { k: 'sc', o: e.owner, x: e.child },
                );
            case 'type': {
                const kind = e.kind === 'enum' ? CompletionItemKind.Enum : e.kind === 'interface' ? CompletionItemKind.Interface : CompletionItemKind.Class;
                const it = typeItem(e.name, e.owner, '4', kind);
                it.commitCharacters = ['.'];
                return it;
            }
            case 'object': {
                const it = typeItem(e.name, 'SObject', objectSortTier(e.name) === '0' ? '0' : '1');
                it.commitCharacters = ['.'];
                return it;
            }
            case 'trigger':
                return lazy(
                    { label: e.name, kind: CompletionItemKind.Field, labelDetails: { detail: ` : ${e.type}`, description: 'Trigger' }, sortText: '0_' + e.name },
                    { k: 'ev', o: 'Trigger', x: e.type },
                );
        }
    }

    // ── bare identifier: locals, members, keywords, types ──
    private async bareCompletion(): Promise<CompletionItem[] | CompletionList> {
        const luc = this.lineUpToCursor;
        const wm = /([A-Za-z_]\w*)?$/.exec(luc);
        const partial = wm?.[1] ?? '';
        const before = luc.slice(0, luc.length - partial.length);
        if (/\.\s*$/.test(before)) return [];
        // A trigger character (space, `(`, `,`, newline) with nothing typed: stay quiet.
        if (!partial && !this.invoked) return [];
        if (/\d$/.test(before)) return [];
        // Declaring a name (`Integer fo|`, `List<X> fo|`, `void fo|`): nothing to complete.
        const prevTok = /([A-Za-z_]\w*|>|\])\s+$/.exec(before);
        if (prevTok && (prevTok[1] === '>' || prevTok[1] === ']' || !EXPRESSION_KEYWORDS.has(prevTok[1].toLowerCase()))) return [];

        const r = this.resolver;
        const items: CompletionItem[] = [];
        const seen = new Set<string>();
        const push = (it: CompletionItem) => {
            const k = String(it.label).toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            items.push(it);
        };

        // 0: locals / params.
        const enc = await r.enclosing();
        const staticCtx = r.inStaticContext();
        const memberEntries = enc && enc.t.k === 'user' ? await r.userMembers(enc.t, staticCtx, { all: !staticCtx }) : [];
        const memberNames = new Set(memberEntries.filter((e) => e.src === 'user').map((e) => (e as { m: ApexMember }).m.name.toLowerCase()));
        for (const v of r.visibleVars()) {
            if (memberNames.has(v.name.toLowerCase()) || !matchesTyped(v.name, partial)) continue;
            push(lazy({ label: v.name, kind: CompletionItemKind.Variable, labelDetails: { detail: ` : ${v.type}` }, sortText: '0_' + v.name }, { k: 'v', x: 'local' }));
        }
        // 1: members of the enclosing class (statics only in a static method).
        const typeEntries: MemberEntry[] = [];
        for (const e of memberEntries) {
            if (e.src === 'type') {
                typeEntries.push(e);
                continue;
            }
            if (e.src !== 'user' && e.src !== 'std') continue;
            const label = e.m.name;
            if (!matchesTyped(label, partial)) continue;
            const it = e.src === 'user' ? userMemberItem(e.owner, e.m) : stdMemberItem(e.owner, e.m);
            it.sortText = '1' + (it.sortText ?? '').slice(1);
            push(it);
        }
        // 2: keywords + statement snippets.
        for (const k of APEX_KEYWORDS) {
            if (!matchesTyped(k.label, partial)) continue;
            push(
                lazy(
                    k.insert
                        ? { label: k.label, kind: CompletionItemKind.Keyword, insertText: k.insert, insertTextFormat: InsertTextFormat.Snippet, detail: k.detail, sortText: '2_' + k.label }
                        : { label: k.label, kind: CompletionItemKind.Keyword, detail: k.detail, sortText: '2_' + k.label },
                    { k: 'kw' },
                ),
            );
        }
        for (const s of APEX_SNIPPETS) {
            if (partial && !s.label.startsWith(partial.toLowerCase())) continue;
            push(lazy({ label: s.label, kind: CompletionItemKind.Snippet, insertText: s.insert, insertTextFormat: InsertTextFormat.Snippet, detail: s.detail, sortText: '2_' + s.label }, { k: 'kw', x: 'snippet' }));
        }
        // 3+: types — same-file, workspace, standard library, SObjects (filtered + capped).
        const candidates: CompletionItem[] = [];
        for (const d of r.local.decls) {
            if (d.kind === 'trigger' || !matchesTyped(d.name, partial)) continue;
            const kind = d.kind === 'enum' ? CompletionItemKind.Enum : d.kind === 'interface' ? CompletionItemKind.Interface : CompletionItemKind.Class;
            candidates.push(typeItem(d.name, d.outer ? `${d.outer}.${d.name}` : 'Apex class', '3', kind));
        }
        for (const e of typeEntries) if (e.src === 'type' && matchesTyped(e.name, partial)) candidates.push(typeItem(e.name, e.owner, '3'));
        for (const name of WorkspaceIndex.allTypeNames()) if (matchesTyped(name, partial)) candidates.push(typeItem(name, 'Apex class', '3'));
        for (const name of STD_TYPES) if (matchesTyped(name, partial)) candidates.push(typeItem(name, 'System', '4'));
        for (const name of await objectNames(this.ctx, this.doc.uri, this.token)) {
            if (!matchesTyped(name, partial)) continue;
            // Deprioritized (tier 5/6) so they never outrank locals/keywords.
            candidates.push(typeItem(name, 'SObject', objectSortTier(name) === '0' ? '5' : '6'));
        }
        return this.capped(items, candidates, push);
    }
}

// ─── completionItem/resolve ─────────────────────────────────────────────────────

type SoqlResolver = (item: CompletionItem) => CompletionItem | Promise<CompletionItem>;
const SOQL_RESOLVE_EXPORT: string = ['resolve', 'SoqlItem'].join('');

/** Build the documentation popup of a lazily-documented item. */
export async function resolveCompletionItem(ctx: ServerContext, item: CompletionItem, token?: CancellationToken): Promise<CompletionItem> {
    if (item.documentation) return item;
    const d = item.data as LazyData | undefined;
    const label = String(item.label);
    if (!d || typeof d !== 'object' || typeof d.k !== 'string') return sfxTag([item])[0];
    const ld = item.labelDetails;
    switch (d.k) {
        case 'soql': {
            // SOQL items (soql.ts) may resolve lazily too; plug in its resolver when present.
            // Looked up dynamically: the export may not exist yet (team SOQL adds it).
            const fn = (soql as unknown as Record<string, unknown>)[SOQL_RESOLVE_EXPORT] as SoqlResolver | undefined;
            if (typeof fn === 'function') return fn(item);
            break;
        }
        case 'sf': {
            const uri = d.c !== undefined ? contextUris.get(d.c) : undefined;
            const owner = d.o ?? '';
            const desc = uri ? await ctx.schema.describe(uri, owner, token) : null;
            const f = desc?.fields.find((x) => x.name === label);
            const body = f ? fieldDocBody(owner, f) : ['```apex\n' + `${owner}.${label}${ld?.detail ?? ''}` + '\n```'];
            if (d.x) body.push(`_${d.x}_`);
            item.documentation = schemaDoc(body);
            return item;
        }
        case 'sr':
            item.documentation = schemaDoc([`\`${d.o}.${label}\` ${(ld?.detail ?? '').replace(/^\s*→\s*/, '→ **')}**`]);
            return item;
        case 'sc':
            item.documentation = schemaDoc([`\`${d.o}.${label}\` → **List<${d.x}>** _(child relationship)_`]);
            return item;
        case 'am':
        case 'sm': {
            const owner = d.o ? d.o + '.' : '';
            const sig =
                item.kind === CompletionItemKind.Method
                    ? `${ld?.description ?? 'void'} ${owner}${label}${ld?.detail ?? '()'}`
                    : `${owner}${label}${ld?.detail ?? ''}`;
            const what = d.k === 'am' ? (d.x === 'enumValue' ? 'enum value' : d.x ?? 'member') : 'Salesforce standard library';
            item.documentation = schemaDoc(['```apex\n' + sig + '\n```', `_(${what})_`]);
            return item;
        }
        case 'ty':
            item.documentation = schemaDoc([`\`${label}\` — ${d.x ?? 'type'}`]);
            return item;
        case 'v':
            item.documentation = schemaDoc(['`' + label + (ld?.detail ?? '') + '`' + (d.x ? ` — ${d.x}` : '')]);
            return item;
        case 'ev':
            item.documentation = schemaDoc([`\`${d.o ? d.o + '.' : ''}${label}${d.x && d.o ? ' : ' + d.x : ''}\`${d.x && !d.o ? ' — ' + d.x : ''}`]);
            return item;
        case 'kw':
            item.documentation = plainDoc([item.detail ? `\`${item.detail}\` — ${d.x ?? 'keyword'}` : `\`${label}\``]);
            return item;
    }
    return sfxTag([item])[0];
}

/** Exposed for tests: the value type of a receiver expression at a position. */
export async function receiverTypeAt(ctx: ServerContext, doc: TextDocument, position: { line: number; character: number }, expr: string): Promise<RValue | undefined> {
    return new Resolver(ctx, doc, position, readViews(ctx, doc)).exprValue(expr);
}
