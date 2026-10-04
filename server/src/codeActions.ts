/**
 * Apex code actions: surround a selection with try/catch, modernize legacy asserts,
 * generate a constructor, implement declared standard interfaces, and generate a
 * sibling test class — plus diagnostic quick fixes (keyed off the stable codes in
 * diagnosticCodes.ts):
 *   unknown custom field   → create the field-meta.xml stub (Text(255))
 *   missing sharing        → add `with sharing` / `inherited sharing`
 *   SOQL in loop           → hoist the query, or bulkify a `:loopVar.Field` bind (Set + Map)
 *   DML in loop            → collect records, one DML after the loop
 *   leftover System.debug  → remove the statement (or all of them)
 *   syntax "missing ';'"   → insert it
 * Text analysis for the fixes lives in apexQuickFixes.ts / fieldStub.ts.
 */
import {
    Connection,
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    CancellationToken,
    ClientCapabilities,
    CreateFile,
    Diagnostic,
    Range,
    TextEdit,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { ServerContext } from './context';
import { braceDepthAt } from './textUtil';
import { orCancelled, raceCancel, throwIfCancelled } from './cancel';
import { resolveVarType } from './apexSymbols';
import { SCHEMA_DIAGNOSTIC_SOURCE } from './apexSemantics';
import {
    CODE_DEBUG,
    CODE_DML_IN_LOOP,
    CODE_MISSING_SHARING,
    CODE_SOQL_IN_LOOP,
    CODE_UNKNOWN_FIELD,
    UnknownFieldData,
    parseUnknownFieldMessage,
} from './diagnosticCodes';
import { TextFix, debugFixes, dmlInLoopFixes, missingSemicolonFix, sharingFixes, soqlInLoopFixes } from './apexQuickFixes';
import { planFieldStub } from './fieldStub';

/** Host command (src/commands/apexQuickFixCommands.ts) that writes a field stub file. */
export const CMD_CREATE_FIELD_STUB = 'adure-sfx-toolkit.apex.createFieldStub';

// Whether the client applies CreateFile resource operations in a WorkspaceEdit. Unknown
// (never told) → assume yes: the only client of this server is the VS Code extension,
// whose language client supports create/rename/delete.
let clientCanCreateFiles: boolean | undefined;

/** Record the client's capabilities (call from `onInitialize`). */
export function noteClientCapabilities(caps: ClientCapabilities | undefined): void {
    const ops = caps?.workspace?.workspaceEdit?.resourceOperations;
    clientCanCreateFiles = !!caps?.workspace?.workspaceEdit?.documentChanges && Array.isArray(ops) && ops.includes('create');
}

// Standard interfaces whose method stubs can be generated when a class declares them.
const IFACE_STUBS: { match: RegExp; key: string; title: string; body: string }[] = [
    {
        match: /Database\.Batchable/i,
        key: 'execute',
        title: 'Database.Batchable',
        body:
            '\tglobal Database.QueryLocator start(Database.BatchableContext bc) {\n' +
            '\t\treturn Database.getQueryLocator([SELECT Id FROM SObject]);\n\t}\n\n' +
            '\tglobal void execute(Database.BatchableContext bc, List<SObject> scope) {\n\t\t\n\t}\n\n' +
            '\tglobal void finish(Database.BatchableContext bc) {\n\t}\n',
    },
    { match: /(?:^|[\s,])Queueable\b/, key: 'execute', title: 'Queueable', body: '\tpublic void execute(QueueableContext context) {\n\t\t\n\t}\n' },
    { match: /(?:^|[\s,])Schedulable\b/, key: 'execute', title: 'Schedulable', body: '\tglobal void execute(SchedulableContext sc) {\n\t\t\n\t}\n' },
    { match: /(?:^|[\s,])Comparable\b/, key: 'compareto', title: 'Comparable', body: '\tpublic Integer compareTo(Object other) {\n\t\treturn 0;\n\t}\n' },
];

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onCodeAction((params, token) =>
        orCancelled<CodeAction[]>([], async () => {
            const actions = editorActions(ctx, params, token);
            const doc = ctx.documents.get(params.textDocument.uri);
            if (!doc || !ctx.settings.apexCompletion || doc.languageId === 'soql') return actions;
            if (!params.context.only || params.context.only.some((k) => k === CodeActionKind.QuickFix || k.startsWith(CodeActionKind.QuickFix + '.'))) {
                actions.unshift(...(await diagnosticFixes(ctx, doc, params, token)));
            }
            return actions;
        }),
    );
}

/** The context-free editor actions (selection / class level). */
function editorActions(ctx: ServerContext, params: CodeActionParams, token: CancellationToken): CodeAction[] {
    {
        if (!ctx.settings.apexCompletion || token.isCancellationRequested) return [];
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || doc.languageId === 'soql') return [];
        const uri = params.textDocument.uri;
        const range = params.range;
        const actions: CodeAction[] = [];

        // 1. Surround selection with try/catch.
        const selected = doc.getText(range);
        if (selected.trim().length > 0) {
            const inner = selected
                .split('\n')
                .map((l) => '\t' + l)
                .join('\n');
            const wrapped = 'try {\n' + inner + '\n} catch (Exception e) {\n\t\n}';
            actions.push({
                title: 'Surround with try/catch',
                kind: CodeActionKind.RefactorRewrite,
                edit: { changes: { [uri]: [TextEdit.replace(range, wrapped)] } },
            });
        }

        // 2. Convert legacy System.assert* → Assert.* on the touched lines.
        const full = doc.getText();
        const lines = full.split('\n');
        const conversions: { re: RegExp; to: string }[] = [
            { re: /System\.assertEquals\(/g, to: 'Assert.areEqual(' },
            { re: /System\.assertNotEquals\(/g, to: 'Assert.areNotEqual(' },
            { re: /System\.assert\(/g, to: 'Assert.isTrue(' },
        ];
        const edits: TextEdit[] = [];
        for (let ln = range.start.line; ln <= range.end.line && ln < lines.length; ln++) {
            const lineText = lines[ln];
            for (const { re, to } of conversions) {
                re.lastIndex = 0;
                let mm: RegExpExecArray | null;
                while ((mm = re.exec(lineText))) {
                    edits.push(TextEdit.replace(Range.create(ln, mm.index, ln, mm.index + mm[0].length), to));
                }
            }
        }
        if (edits.length) {
            actions.push({
                title: 'Convert System.assert* → Assert.*',
                kind: CodeActionKind.QuickFix,
                edit: { changes: { [uri]: edits } },
            });
        }

        // 3. Class-level: generate a constructor and implement declared standard interfaces.
        // Edits must line up with the CURRENT text: always the exact-version parse, never a stale one.
        const index = ctx.parses.current(doc).index;
        if (token.isCancellationRequested) return [];
        let cls: { name: string; range: Range } | undefined;
        let best = Infinity;
        for (const c of index.classRanges) {
            const r = c.range;
            const inside =
                (range.start.line > r.start.line || (range.start.line === r.start.line && range.start.character >= r.start.character)) &&
                (range.start.line < r.end.line || (range.start.line === r.end.line && range.start.character <= r.end.character));
            if (!inside) continue;
            const size = r.end.line - r.start.line;
            if (size < best) {
                best = size;
                cls = c;
            }
        }
        if (cls) {
            const members = index.types.get(cls.name) ?? [];
            const at = { line: range.start.line, character: 0 };

            const fields = members.filter((m) => m.kind === 'field' || m.kind === 'property');
            if (fields.length) {
                const paramList = fields.map((f) => `${f.detail ?? 'Object'} ${f.name}`).join(', ');
                const assigns = fields.map((f) => `\t\tthis.${f.name} = ${f.name};`).join('\n');
                const ctor = `\tpublic ${cls.name}(${paramList}) {\n${assigns}\n\t}\n\n`;
                actions.push({
                    title: `Generate constructor (${fields.length} field${fields.length === 1 ? '' : 's'})`,
                    kind: CodeActionKind.RefactorRewrite,
                    edit: { changes: { [uri]: [TextEdit.insert(at, ctor)] } },
                });
            }

            const headerStart = doc.offsetAt(cls.range.start);
            const braceIdx = full.indexOf('{', headerStart);
            const header = full.slice(headerStart, braceIdx >= 0 ? braceIdx : headerStart + 200);
            const memberNames = new Set(members.map((m) => m.name.toLowerCase()));
            for (const s of IFACE_STUBS) {
                if (!s.match.test(header) || memberNames.has(s.key)) continue;
                actions.push({
                    title: `Implement ${s.title} methods`,
                    kind: CodeActionKind.QuickFix,
                    edit: { changes: { [uri]: [TextEdit.insert(at, s.body + '\n')] } },
                });
            }

            // Generate a sibling test class (new file + meta.xml) for a non-test top-level class.
            if (!/@IsTest/i.test(header) && braceDepthAt(full, headerStart) === 0) {
                const dir = uri.slice(0, uri.lastIndexOf('/'));
                const testUri = `${dir}/${cls.name}Test.cls`;
                const metaUri = `${testUri}-meta.xml`;
                const testBody =
                    `@IsTest\nprivate class ${cls.name}Test {\n` +
                    `\t@IsTest\n\tstatic void test${cls.name}() {\n` +
                    `\t\t// TODO: arrange, act, assert\n\t\tAssert.isTrue(true);\n\t}\n}\n`;
                const metaBody =
                    '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
                    '\t<apiVersion>61.0</apiVersion>\n\t<status>Active</status>\n</ApexClass>\n';
                actions.push({
                    title: `Generate test class ${cls.name}Test`,
                    kind: CodeActionKind.RefactorRewrite,
                    edit: {
                        documentChanges: [
                            CreateFile.create(testUri, { ignoreIfExists: true }),
                            { textDocument: { uri: testUri, version: null }, edits: [TextEdit.insert({ line: 0, character: 0 }, testBody)] },
                            CreateFile.create(metaUri, { ignoreIfExists: true }),
                            { textDocument: { uri: metaUri, version: null }, edits: [TextEdit.insert({ line: 0, character: 0 }, metaBody)] },
                        ],
                    },
                });
            }
        }

        return actions;
    }
}

// ─── Diagnostic quick fixes ─────────────────────────────────────────────────────────

function textFixToAction(uri: string, doc: TextDocument, fix: TextFix, diag: Diagnostic): CodeAction {
    return {
        title: fix.title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        isPreferred: fix.preferred,
        edit: {
            changes: {
                [uri]: fix.edits.map((e) => TextEdit.replace(Range.create(doc.positionAt(e.start), doc.positionAt(e.end)), e.newText)),
            },
        },
    };
}

/**
 * Quick fixes for the diagnostics in the request context. Every edit is computed on the
 * document's CURRENT text (diagnostics may have been published for an older version, so
 * each fix re-validates the code at the diagnostic's position and offers nothing when it
 * no longer matches) — applying a fix removes its diagnostic, so fixes are idempotent.
 */
async function diagnosticFixes(ctx: ServerContext, doc: TextDocument, params: CodeActionParams, token: CancellationToken): Promise<CodeAction[]> {
    const uri = doc.uri;
    const out: CodeAction[] = [];
    const version = doc.version;
    const text = doc.getText();
    for (const diag of params.context.diagnostics) {
        throwIfCancelled(token);
        const start = doc.offsetAt(diag.range.start);
        let fixes: TextFix[] = [];
        if (diag.source === 'asfx-apex-lint') {
            if (diag.code === CODE_SOQL_IN_LOOP) {
                const index = ctx.parses.current(doc).index; // exact version — edits must line up
                const pos = diag.range.start;
                fixes = await soqlInLoopFixes(text, start, {
                    varType: (name) => resolveVarType(index, name, pos.line, pos.character),
                    isIdField: async (sobject, field) => {
                        const d = await raceCancel(ctx.schema.describe(uri, sobject, token), token);
                        const f = d?.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
                        return !!f && (f.type === 'reference' || f.type === 'id');
                    },
                });
            } else if (diag.code === CODE_DML_IN_LOOP) fixes = dmlInLoopFixes(text, start);
            else if (diag.code === CODE_MISSING_SHARING) fixes = sharingFixes(text, start);
            else if (diag.code === CODE_DEBUG) fixes = debugFixes(text, start);
        } else if (diag.source === 'asfx-apex' && /^missing ';' at /i.test(diag.message)) {
            fixes = missingSemicolonFix(text, start);
        } else if (diag.source === SCHEMA_DIAGNOSTIC_SOURCE) {
            const stub = await fieldStubAction(ctx, doc, diag, token);
            if (stub) out.push(stub);
        }
        // An awaited describe may have raced an edit: never hand out edits for an old version.
        if (ctx.documents.get(uri)?.version !== version) return [];
        for (const f of fixes) out.push(textFixToAction(uri, doc, f, diag));
    }
    return out;
}

/** "Create field <Object>.<Field>" for an unknown custom field on an org/workspace SObject. */
async function fieldStubAction(ctx: ServerContext, doc: TextDocument, diag: Diagnostic, token: CancellationToken): Promise<CodeAction | undefined> {
    const data =
        diag.code === CODE_UNKNOWN_FIELD && diag.data && typeof (diag.data as UnknownFieldData).field === 'string'
            ? (diag.data as UnknownFieldData)
            : parseUnknownFieldMessage(diag.message);
    if (!data || !/__c$/i.test(data.field)) return undefined; // standard fields can't be created
    let docPath: string;
    try {
        docPath = fileURLToPath(doc.uri);
    } catch {
        return undefined;
    }
    // The member must still be what the diagnostic flagged (the document may have moved on).
    const at = doc.offsetAt(diag.range.start);
    if (doc.getText().slice(at, at + data.field.length).toLowerCase() !== data.field.toLowerCase()) return undefined;
    const [ns, describe] = await Promise.all([
        ctx.schema.projectNamespace(doc.uri, token),
        raceCancel(ctx.schema.describe(doc.uri, data.object, token), token),
    ]);
    const plan = planFieldStub(docPath, describe?.name ?? data.object, data.field, ns);
    if (!plan) return undefined;
    // Only for objects that exist in the org (describe) or in the workspace source.
    if (!describe && !fs.existsSync(path.dirname(path.dirname(plan.filePath)))) return undefined;
    const title = `Create field ${plan.object}.${plan.field} (Text(255))`;
    const fileUri = pathToFileURL(plan.filePath).href;
    if (clientCanCreateFiles !== false) {
        return {
            title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diag],
            isPreferred: true,
            edit: {
                documentChanges: [
                    CreateFile.create(fileUri, { overwrite: false, ignoreIfExists: false }),
                    { textDocument: { uri: fileUri, version: null }, edits: [TextEdit.insert({ line: 0, character: 0 }, plan.content)] },
                ],
            },
        };
    }
    return {
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [diag],
        isPreferred: true,
        command: { title, command: CMD_CREATE_FIELD_STUB, arguments: [{ path: plan.filePath, content: plan.content }] },
    };
}
