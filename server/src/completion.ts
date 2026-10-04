/**
 * Completion: SOQL (in .soql files and SOQL regions inside Apex) and org-aware Apex
 * completion (member access, `new`, constructor named args, annotations, catch types,
 * picklist values, type names, standard library, statement snippets).
 */
import { CancellationToken, Connection, CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { enclosingClass, resolveVarType, ApexMember, ApexIndex } from './apexSymbols';
import { WorkspaceIndex } from './workspaceIndex';
import { STD_TYPES, stdTypeName, stdMembersFor, StdMember } from './apexStdlib';
import { withSchemaDoc, sfxTag, applyNamespace, fieldItem, relItem, fieldSortTier, objectSortTier } from './items';
import { soqlRegionAt, soqlCompletion } from './soql';
import { orCancelled, throwIfCancelled } from './cancel';
import { baseTypeName, regexReceiverType, matchesMemberPrefix, nameMatchesNsOptional } from './textUtil';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onCompletion((params, token) =>
        orCancelled<CompletionItem[]>([], () => complete(ctx, params.textDocument.uri, params.position, token)),
    );
}

/**
 * Completion reads the LAST completed parse (see ParseCache.forRead) for symbol/index
 * info — never forcing a full reparse on the keystroke path — while the token at the
 * cursor always comes from the live document text. Cursor positions are mapped into
 * the parse's coordinates before scope lookups.
 */
async function complete(
    ctx: ServerContext,
    uri: string,
    position: { line: number; character: number },
    token: CancellationToken,
): Promise<CompletionItem[]> {
    throwIfCancelled(token);
    const params = { textDocument: { uri }, position };
    const doc = ctx.documents.get(uri);
    if (!doc) return [];

    let text: string;
    let line: number;
    let column: number;

    if (doc.languageId === 'soql') {
        text = doc.getText();
        // soql-language-server expects 1-based line/column.
        line = params.position.line + 1;
        column = params.position.character + 1;
    } else {
        // Apex: inline [SELECT …] gets SOQL completion; otherwise try type-aware
        // member completion. Member completion runs even when Apex features are
        // gated off — its org-aware SObject field results are additive to the
        // Salesforce extension (which can't resolve org fields for these). Bare
        // (non-member) Apex completion is left to the other provider.
        const offset = doc.offsetAt(params.position);
        const region = soqlRegionAt(doc.getText(), offset);
        if (region) {
            // Apex bind variable inside inline SOQL: `:partial` → in-scope variables.
            const bindLine = doc.getText().slice(doc.getText().lastIndexOf('\n', offset - 1) + 1, offset);
            const bindM = /:\s*(\w*)$/.exec(bindLine);
            if (bindM) {
                const view = ctx.parses.forRead(doc);
                const at = view.toParsePosition(params.position);
                const p = bindM[1].toLowerCase();
                const vars = inScopeVars(view.result.index, at.line, at.character).filter(
                    (v) => !p || v.name.toLowerCase().startsWith(p),
                );
                return sfxTag(
                    vars.map((v) =>
                        withSchemaDoc(
                            { label: v.name, kind: CompletionItemKind.Variable, labelDetails: { detail: ` : ${v.type}` }, sortText: '0_' + v.name },
                            ['`' + v.name + ' : ' + v.type + '` — bind variable'],
                        ),
                    ),
                );
            }
            text = region.snippet;
            line = region.line;
            column = region.column;
        } else {
            if (!ctx.settings.apexCompletion) return [];
            const pick = await apexPicklistValueCompletion(ctx, doc, offset, token);
            if (pick.length) return pick;
            const ann = apexAnnotationCompletion(doc, offset);
            if (ann.length) return ann;
            const cat = apexCatchCompletion(doc, offset);
            if (cat.length) return cat;
            const ctorArgs = await apexConstructorArgCompletion(ctx, doc, offset, token);
            if (ctorArgs.length) return ctorArgs;
            const ctor = await apexNewCompletion(ctx, doc, offset, token);
            if (ctor.length) return ctor;
            const member = await apexMemberCompletion(ctx, doc, offset, params.position, token);
            if (member.length) return member;
            // Bare identifier position: SObject types + workspace user classes +
            // Salesforce standard-library types/namespaces.
            const out: CompletionItem[] = [];
            const seen = new Set<string>();
            for (const it of await apexTypeCompletion(ctx, doc, offset, token)) {
                if (seen.has(String(it.label))) continue;
                seen.add(String(it.label));
                out.push(it);
            }
            for (const it of apexGlobalCompletion(doc, offset)) {
                if (seen.has(String(it.label))) continue;
                seen.add(String(it.label));
                out.push(it);
            }
            return out;
        }
    }

    return soqlCompletion(ctx.schema, params.textDocument.uri, text, line, column, token);
}

// ─── Apex member completion ─────────────────────────────────────────────────────

const APEX_MEMBER_KIND: Record<ApexMember['kind'], CompletionItemKind> = {
    method: CompletionItemKind.Method,
    field: CompletionItemKind.Field,
    property: CompletionItemKind.Property,
    constructor: CompletionItemKind.Constructor,
};

function memberItem(owner: string, m: ApexMember): CompletionItem {
    return withSchemaDoc(
        {
            label: m.name,
            kind: APEX_MEMBER_KIND[m.kind],
            labelDetails: { detail: m.detail ? ` : ${m.detail}` : undefined, description: owner },
            sortText: m.name,
        },
        [`\`${owner}.${m.name}\`${m.detail ? ' : ' + m.detail : ''} _(${m.kind})_`],
    );
}

// A constructor item for `new <Type>(…)`.
function newTypeItem(typeName: string, tier: string): CompletionItem {
    return withSchemaDoc(
        {
            label: typeName,
            kind: CompletionItemKind.Constructor,
            insertText: `${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            labelDetails: { detail: '()' },
            sortText: tier + '_' + typeName,
        },
        ['new `' + typeName + '()`'],
    );
}

/** Apex primitives / value types that have no meaningful `new X()` constructor. */
const NON_CONSTRUCTABLE = new Set(
    ['string', 'integer', 'long', 'decimal', 'double', 'boolean', 'id', 'blob', 'date', 'datetime', 'time', 'object', 'void', 'sobject'],
);

/** A full `new Type()` expression item — includes the `new ` keyword (for the pre-`new` assignment position). */
function newExprItem(typeName: string, tier: string): CompletionItem {
    return withSchemaDoc(
        {
            label: `new ${typeName}()`,
            kind: CompletionItemKind.Constructor,
            insertText: `new ${typeName}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
            filterText: `new ${typeName}`,
            labelDetails: { detail: '', description: 'construct' },
            sortText: tier + '_' + typeName,
        },
        ['`new ' + typeName + '()`'],
    );
}

/** Capture the declared/known type on an assignment LHS. `requireNew` matches after `new ` is typed. */
function expectedAssignType(ctx: ServerContext, doc: TextDocument, lineUpToCursor: string, requireNew: boolean): string | undefined {
    const tail = requireNew ? 'new\\s+[\\w.<>]*' : '(?:new\\s+[\\w.<>]*)?';
    // `Type name = [new …]` — Type may carry (possibly nested) generics: List<String>, Map<Id, List<X>>.
    const declared = new RegExp(`(?:^|[\\s({;,])([A-Za-z_][\\w.]*(?:\\s*<.*>)?)\\s+[A-Za-z_]\\w*\\s*=\\s*${tail}$`).exec(lineUpToCursor);
    if (declared) return declared[1].trim();
    // `existingVar = [new …]` — resolve the variable's type from the index.
    const reassign = new RegExp(`(?:^|[\\s({;,])([A-Za-z_]\\w*)\\s*=\\s*${tail}$`).exec(lineUpToCursor);
    if (reassign) return ctx.parses.forRead(doc).result.index.varTypes.get(reassign[1]);
    return undefined;
}

/**
 * Suggest constructor expressions in Apex. Two positions:
 *  1. Right after an assignment `Type a = |` (before `new` is typed) → offers `new Type()`
 *     first, with declared generics preserved (`List<String> a = ` → `new List<String>()`).
 *  2. After `new ` → the assigned type first, then constructable SObjects.
 * Returns [] when not in either position.
 */
async function apexNewCompletion(ctx: ServerContext, doc: TextDocument, offset: number, token: CancellationToken): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);

    const afterNew = /(?:^|[\s({,=])new\s+[A-Za-z_0-9.<>]*$/.test(lineUpToCursor);
    // Assignment RHS just opened (`… = |`), but not a comparison/compound op (`==`, `<=`, `+=`, …).
    const assignOpen = /(?:^|[^=!<>+\-*/%&|^])=\s*$/.test(lineUpToCursor);

    if (!afterNew && assignOpen) {
        const expected = expectedAssignType(ctx, doc, lineUpToCursor, false);
        if (!expected || NON_CONSTRUCTABLE.has(baseTypeName(expected).toLowerCase())) return [];
        return sfxTag(applyNamespace([newExprItem(expected, '0')], await ctx.schema.projectNamespace(doc.uri, token)));
    }

    if (!afterNew) return [];

    // After `new `: the assigned type first, then collection snippets, then SObjects.
    const expected = expectedAssignType(ctx, doc, lineUpToCursor, true);
    const items: CompletionItem[] = [];
    if (expected) items.push(newTypeItem(expected, '0'));

    // Generic collection constructors as snippets (`new List<Account>()`, Map, Set).
    const collections: { label: string; insert: string; key: string }[] = [
        { label: 'List<…>()', insert: 'List<${1:SObject}>()', key: 'List' },
        { label: 'Map<…, …>()', insert: 'Map<${1:Id}, ${2:SObject}>()', key: 'Map' },
        { label: 'Set<…>()', insert: 'Set<${1:Id}>()', key: 'Set' },
    ];
    for (const c of collections) {
        items.push(
            withSchemaDoc(
                {
                    label: c.label,
                    kind: CompletionItemKind.Snippet,
                    insertText: c.insert,
                    insertTextFormat: InsertTextFormat.Snippet,
                    filterText: c.key,
                    detail: 'collection',
                    sortText: '0a_' + c.key,
                },
                ['`new ' + c.label + '`'],
            ),
        );
    }

    const expectedBase = expected ? baseTypeName(expected) : '';
    for (const name of await ctx.schema.objectList(doc.uri, token)) {
        if (name === expectedBase) continue;
        items.push(newTypeItem(name, objectSortTier(name) === '0' ? '1' : '2'));
    }
    return sfxTag(applyNamespace(items, await ctx.schema.projectNamespace(doc.uri, token)));
}

/**
 * Org-aware named-argument completion inside an SObject constructor —
 * `new Account(|)` / `new Account(Name = 'x', |)` — offers the object's fields as
 * `Field = ` from live schema (fields already supplied are filtered out). Only fires
 * for SObject types; user-class constructors fall through to other completion.
 */
async function apexConstructorArgCompletion(
    ctx: ServerContext,
    doc: TextDocument,
    offset: number,
    token: CancellationToken,
): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    // `new Type(` with the cursor still inside the (unclosed) parens, no intervening generics.
    const m = /\bnew\s+([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const typeName = m[1];
    const argsSoFar = m[2];
    const lastSeg = argsSoFar.split(',').pop() ?? '';
    if (lastSeg.includes('=')) return []; // typing a value, not a field name
    const partial = (/([A-Za-z_]\w*)?$/.exec(lastSeg)?.[1] ?? '').toLowerCase();

    const d = await ctx.schema.describe(doc.uri, baseTypeName(typeName), token);
    if (!d) return [];
    const used = new Set(
        argsSoFar
            .split(',')
            .map((s) => s.split('=')[0].trim().toLowerCase())
            .filter(Boolean),
    );
    const items = d.fields
        .filter((f) => !used.has(f.name.toLowerCase()))
        .filter((f) => !partial || matchesMemberPrefix(f.name.toLowerCase(), partial))
        .map((f) => {
            const item: CompletionItem = {
                label: f.name,
                kind: CompletionItemKind.Field,
                insertText: `${f.name} = `,
                labelDetails: { detail: ` : ${f.type}`, description: typeName },
                sortText: fieldSortTier(f.name) + '_' + f.name,
            };
            return withSchemaDoc(item, ['```apex\n' + `${typeName}.${f.name} : ${f.type}` + '\n```', '_constructor argument_']);
        });
    return sfxTag(applyNamespace(items, await ctx.schema.projectNamespace(doc.uri, token)));
}

/**
 * Complete `receiver.partial` in Apex: resolve the receiver's type from the
 * document index (locals/params/fields, `this`) and list its members — either a
 * user type's members or, failing that, an SObject's fields from the org schema.
 */
async function apexMemberCompletion(
    ctx: ServerContext,
    doc: TextDocument,
    offset: number,
    pos: { line: number; character: number },
    token: CancellationToken,
): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)\s*\.\s*(\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const receiver = m[1];
    const partial = m[2].toLowerCase();

    // Trigger context variables (`Trigger.new`, `Trigger.isInsert`, …), typed to the object.
    if (receiver === 'Trigger') return triggerMembers(full, partial);

    const view = ctx.parses.forRead(doc);
    const { index } = view.result;
    const at = view.toParsePosition(pos);

    // Resolve the receiver to a type name. Fall back to a text scan when the parse
    // index doesn't have it (common while mid-typing the member access).
    let typeName: string | undefined;
    const scopedType = resolveVarType(index, receiver, at.line, at.character);
    if (receiver === 'this') {
        typeName = enclosingClass(index, at.line, at.character);
    } else if (scopedType) {
        typeName = scopedType; // scope-aware: the declaration in *this* method wins
    } else if (index.types.has(receiver)) {
        typeName = receiver; // static-ish access on a known type
    } else {
        typeName = regexReceiverType(full, receiver) ?? receiver; // text fallback, else maybe an SObject name
    }
    if (!typeName) return [];
    const base = baseTypeName(typeName);

    let items: CompletionItem[] = [];
    const userMembers = index.types.get(base);
    const stdMembers = stdMembersFor(base);
    // Cross-file user type defined in another workspace file (the common case in
    // the Execute Apex panel and when referencing other classes).
    const wsMembers = userMembers && userMembers.length ? undefined : WorkspaceIndex.findTypeMembers(base);
    if (userMembers && userMembers.length) {
        items = userMembers.map((mm) => memberItem(base, mm));
    } else if (wsMembers && wsMembers.length) {
        items = wsMembers.map((mm) => memberItem(base, mm));
    } else if (stdMembers) {
        // Static members of a Salesforce built-in namespace/type (System.debug…).
        items = stdMembers.map((mm) => stdMemberItem(stdTypeName(base) ?? base, mm));
    } else {
        // An SObject instance (namespace resolved inside describe): offer its fields
        // AND its parent relationships (`X__r`), same as the SOQL builder.
        const d = await ctx.schema.describe(doc.uri, base, token);
        if (d) {
            for (const f of d.fields) {
                items.push(fieldItem(base, f));
                if (f.relationshipName) items.push(relItem(base, f));
            }
        }
    }

    // Namespace-optional prefix filter: a member typed `datasource__c` matches
    // `sfy24__Datasource__c`, and typing the namespaced form matches too.
    const filtered = partial ? items.filter((i) => matchesMemberPrefix(String(i.label), partial)) : items;
    return sfxTag(applyNamespace(filtered, await ctx.schema.projectNamespace(doc.uri, token)));
}

/**
 * SObject type-name completion in Apex type positions (variable declarations,
 * generics, casts, `return`, `instanceof`). This is what gives namespace-optional
 * matching for types in Apex — typing `Widget__c` matches the namespaced
 * object via filterText. Conservative: only fires with a >=2 char prefix and in a
 * plausible type position, and items are deprioritized so locals stay on top.
 */
async function apexTypeCompletion(ctx: ServerContext, doc: TextDocument, offset: number, token: CancellationToken): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);

    // Plausible type positions ending in the partial type name being typed.
    const typePos =
        /(?:^\s*|[<(,]\s*|\breturn\s+|\binstanceof\s+)([A-Za-z_]\w*)$/.exec(lineUpToCursor);
    if (!typePos) return [];
    const partial = typePos[1];
    if (partial.length < 2) return [];

    const ns = await ctx.schema.projectNamespace(doc.uri, token);
    const objs = await ctx.schema.objectList(doc.uri, token);
    const items: CompletionItem[] = objs.map((name) =>
        withSchemaDoc(
            {
                label: name,
                kind: CompletionItemKind.Class,
                labelDetails: { description: 'SObject' },
                // Deprioritized (tier 5/6) so they never outrank locals/keywords.
                sortText: (objectSortTier(name) === '0' ? '5_' : '6_') + name,
            },
            ['`' + name + '` — SObject'],
        ),
    );
    return sfxTag(applyNamespace(items, ns));
}

// A static member of a Salesforce built-in (e.g. `System.debug`).
function stdMemberItem(owner: string, m: StdMember): CompletionItem {
    const isMethod = m.kind === 'method';
    return withSchemaDoc(
        {
            label: m.name,
            kind: isMethod ? CompletionItemKind.Method : CompletionItemKind.Field,
            insertText: isMethod ? `${m.name}($0)` : m.name,
            insertTextFormat: isMethod ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
            labelDetails: { detail: m.detail.replace(/^\S+\s+\S+/, '').trim() || undefined, description: owner },
            sortText: '0_' + m.name,
        },
        ['`' + owner + '.' + m.detail + '`'],
    );
}

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

/** Completion after `@` — Apex annotations, with argument snippets where useful. */
function apexAnnotationCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /@(\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
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

/** Completion inside `catch (…)` — standard Apex exception types. */
function apexCatchCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /\bcatch\s*\(\s*([A-Za-z_]\w*)?$/.exec(lineUpToCursor);
    if (!m) return [];
    const partial = (m[1] ?? '').toLowerCase();
    return sfxTag(
        APEX_EXCEPTIONS.filter((e) => !partial || e.toLowerCase().startsWith(partial)).map((e) =>
            withSchemaDoc(
                { label: e, kind: CompletionItemKind.Class, labelDetails: { description: 'exception' }, sortText: '0_' + e },
                ['`' + e + '` — Apex exception type'],
            ),
        ),
    );
}

/** Statement-snippet items for the bare-identifier position (filtered by the typed prefix). */
function apexSnippetCompletion(partial: string): CompletionItem[] {
    return APEX_SNIPPETS.filter((s) => !partial || s.label.startsWith(partial)).map((s) =>
        withSchemaDoc(
            {
                label: s.label,
                kind: CompletionItemKind.Snippet,
                insertText: s.insert,
                insertTextFormat: InsertTextFormat.Snippet,
                detail: s.detail,
                sortText: '5_' + s.label,
            },
            ['`' + s.detail + '` — snippet'],
        ),
    );
}

/** In-scope Apex variables/params/fields visible at a position (for SOQL bind completion). */
function inScopeVars(index: ApexIndex, line: number, character: number): { name: string; type: string }[] {
    const out: { name: string; type: string }[] = [];
    const seen = new Set<string>();
    for (const d of index.varDecls) {
        const s = d.scope;
        const within =
            (line > s.start.line || (line === s.start.line && character >= s.start.character)) &&
            (line < s.end.line || (line === s.end.line && character <= s.end.character));
        if (!within || d.line > line) continue;
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        out.push({ name: d.name, type: d.type });
    }
    return out;
}

/** The SObject a trigger fires on, from `trigger X on Object (...)`. */
function triggerObjectName(full: string): string {
    return /\btrigger\s+\w+\s+on\s+([A-Za-z_]\w*)/i.exec(full)?.[1] ?? 'SObject';
}

/** `Trigger.` context members, typed to the trigger's SObject. */
function triggerMembers(full: string, partial: string): CompletionItem[] {
    const obj = triggerObjectName(full);
    const members: { name: string; type: string }[] = [
        { name: 'new', type: `List<${obj}>` },
        { name: 'old', type: `List<${obj}>` },
        { name: 'newMap', type: `Map<Id, ${obj}>` },
        { name: 'oldMap', type: `Map<Id, ${obj}>` },
        { name: 'size', type: 'Integer' },
        { name: 'operationType', type: 'System.TriggerOperation' },
        { name: 'isExecuting', type: 'Boolean' },
        { name: 'isBefore', type: 'Boolean' },
        { name: 'isAfter', type: 'Boolean' },
        { name: 'isInsert', type: 'Boolean' },
        { name: 'isUpdate', type: 'Boolean' },
        { name: 'isDelete', type: 'Boolean' },
        { name: 'isUndelete', type: 'Boolean' },
    ];
    return sfxTag(
        members
            .filter((mm) => !partial || mm.name.toLowerCase().startsWith(partial))
            .map((mm) =>
                withSchemaDoc(
                    {
                        label: mm.name,
                        kind: CompletionItemKind.Field,
                        labelDetails: { detail: ` : ${mm.type}`, description: 'Trigger' },
                        sortText: '0_' + mm.name,
                    },
                    ['```apex\n' + `Trigger.${mm.name} : ${mm.type}` + '\n```'],
                ),
            ),
    );
}

/** Picklist value completion inside a string literal RHS: `acc.Industry = '|'`. */
async function apexPicklistValueCompletion(
    ctx: ServerContext,
    doc: TextDocument,
    offset: number,
    token: CancellationToken,
): Promise<CompletionItem[]> {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const luc = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*(?:__c)?)\s*(?:=|==|!=|<>)\s*'([^']*)$/.exec(luc);
    if (!m) return [];
    const receiver = m[1];
    const field = m[2];
    const partial = m[3].toLowerCase();
    const view = ctx.parses.forRead(doc);
    const pos = view.toParsePosition(doc.positionAt(offset));
    const typeName = resolveVarType(view.result.index, receiver, pos.line, pos.character) ?? regexReceiverType(full, receiver) ?? receiver;
    const d = await ctx.schema.describe(doc.uri, baseTypeName(typeName), token);
    if (!d) return [];
    const f = d.fields.find((x) => x.name.toLowerCase() === field.toLowerCase() || nameMatchesNsOptional(x.name, field));
    if (!f || !f.picklistValues || !f.picklistValues.length) return [];
    return sfxTag(
        f.picklistValues
            .filter((v) => !partial || v.toLowerCase().startsWith(partial))
            .map((v) =>
                withSchemaDoc(
                    { label: v, kind: CompletionItemKind.EnumMember, insertText: v, detail: `${baseTypeName(typeName)}.${f.name}`, sortText: '0_' + v },
                    ['`' + v + '` — picklist value'],
                ),
            ),
    );
}

/**
 * Bare-identifier completion in Apex statement positions: workspace user classes
 * (so `MyService` completes) and Salesforce standard-library types/namespaces
 * (`System`, `Database`, `Math`, …). Skipped after a `.` (member access) and after
 * `new ` (handled by the constructor path). Deprioritized below locals/keywords.
 */
function apexGlobalCompletion(doc: TextDocument, offset: number): CompletionItem[] {
    const full = doc.getText();
    const lineStart = full.lastIndexOf('\n', offset - 1) + 1;
    const lineUpToCursor = full.slice(lineStart, offset);
    const m = /([A-Za-z_]\w*)$/.exec(lineUpToCursor);
    if (!m) return [];
    const before = lineUpToCursor.slice(0, m.index).trimEnd();
    if (before.endsWith('.') || /\bnew$/.test(before)) return [];
    const partial = m[1].toLowerCase();

    const items: CompletionItem[] = [];

    // Workspace user classes/triggers.
    for (const name of WorkspaceIndex.allTypeNames()) {
        if (partial && !name.toLowerCase().startsWith(partial)) continue;
        items.push(
            withSchemaDoc(
                {
                    label: name,
                    kind: CompletionItemKind.Class,
                    labelDetails: { description: 'Apex class' },
                    sortText: '3_' + name,
                },
                ['`' + name + '` — Apex class'],
            ),
        );
    }

    // Salesforce standard library types & namespaces.
    for (const name of STD_TYPES) {
        if (partial && !name.toLowerCase().startsWith(partial)) continue;
        items.push(
            withSchemaDoc(
                {
                    label: name,
                    kind: CompletionItemKind.Class,
                    labelDetails: { description: 'System' },
                    sortText: '4_' + name,
                },
                ['`' + name + '` — Salesforce system type'],
            ),
        );
    }

    // Common Apex statement snippets (sysdebug, soqlfor, testmethod, …).
    items.push(...apexSnippetCompletion(partial));

    return sfxTag(items);
}
