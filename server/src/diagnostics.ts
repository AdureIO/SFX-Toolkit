/**
 * Apex diagnostics: syntax errors (from the parse), heuristic lints (SOQL/DML in
 * loops, hardcoded IDs, leftover debug, missing sharing) and the org-aware schema
 * validation pass.
 *
 * Diagnostics are intentionally NOT recomputed on every keystroke (to avoid
 * per-edit parsing). We publish them when a document opens or is saved, and refresh
 * on push/pull/org change (via NOTE_REFRESH). Syntax diagnostics go out immediately;
 * the org-aware schema pass (async describe calls) runs debounced and re-publishes
 * the merged set.
 */
import { Connection, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { resolveVarType } from './apexSymbols';
import { validateFieldAccesses } from './apexSemantics';
import { WorkspaceIndex } from './workspaceIndex';
import { stubbedObjectNames } from './sobjectStub';
import { stdTypeName } from './apexStdlib';
import { isApex, braceDepthAt } from './textUtil';
import {
    CODE_DEBUG,
    CODE_HARDCODED_ID,
    CODE_SOQL_IN_LOOP,
    CODE_DML_IN_LOOP,
    CODE_MISSING_SHARING,
    CODE_UNKNOWN_FIELD,
    parseUnknownFieldMessage,
} from './diagnosticCodes';

export function register(connection: Connection, ctx: ServerContext): void {
    const { documents } = ctx;

    // Debounced, per-document schema validation. Coalesces bursts (open+save) and
    // drops stale runs when the document changes underneath us.
    const schemaTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const scheduleSchemaValidation = (uri: string): void => {
        const prev = schemaTimers.get(uri);
        if (prev) clearTimeout(prev);
        schemaTimers.set(
            uri,
            setTimeout(() => {
                schemaTimers.delete(uri);
                void runSchemaValidation(ctx, uri);
            }, 300),
        );
    };

    const publish = (doc: TextDocument): void => {
        if (!ctx.settings.apexFeatures || doc.languageId === 'soql' || !isApex(doc.uri)) return;
        const parse = ctx.parses.current(doc);
        connection.sendDiagnostics({ uri: doc.uri, diagnostics: [...parse.diagnostics, ...lintApex(doc)] });
        if (ctx.settings.apexValidateSchema) scheduleSchemaValidation(doc.uri);
    };

    documents.onDidOpen((e) => publish(e.document));
    documents.onDidSave((e) => publish(e.document));
    documents.onDidClose((e) => {
        const uri = e.document.uri;
        const t = schemaTimers.get(uri);
        if (t) {
            clearTimeout(t);
            schemaTimers.delete(uri);
        }
        connection.sendDiagnostics({ uri, diagnostics: [] });
    });

    // Re-publish Apex diagnostics for open documents after a push/pull/refresh.
    ctx.onSchemaRefresh(() => {
        for (const doc of documents.all()) publish(doc);
    });

    ctx.onRelease(() => {
        for (const t of schemaTimers.values()) clearTimeout(t);
        schemaTimers.clear();
    });
}

/** Body spans `{…}` of every `for`/`while`/`do` loop, for the SOQL/DML-in-loop lint. */
function loopBodies(text: string): { start: number; end: number }[] {
    const bodies: { start: number; end: number }[] = [];
    const re = /\b(for|while)\s*\(|\bdo\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        let i = re.lastIndex;
        if (m[1]) {
            let depth = 1; // skip the (…) condition
            while (i < text.length && depth > 0) {
                const ch = text[i++];
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
        }
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === '{') {
            let depth = 1;
            const start = ++i;
            while (i < text.length && depth > 0) {
                const ch = text[i++];
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            bodies.push({ start, end: i - 1 });
        }
    }
    return bodies;
}

/**
 * Lightweight, heuristic Apex lints published alongside syntax/schema diagnostics:
 * SOQL/DML in loops, hardcoded IDs, leftover System.debug, and classes missing a
 * sharing declaration. Text-based (no parse) so it stays cheap; source `asfx-apex-lint`.
 */
function lintApex(doc: TextDocument): Diagnostic[] {
    const text = doc.getText();
    const diags: Diagnostic[] = [];
    // `code` is a stable id (diagnosticCodes.ts) the quick fixes in codeActions.ts key off.
    const add = (off: number, len: number, message: string, severity: DiagnosticSeverity, code: string) =>
        diags.push({
            range: { start: doc.positionAt(off), end: doc.positionAt(off + len) },
            message,
            severity,
            source: 'asfx-apex-lint',
            code,
        });

    for (const m of text.matchAll(/\bSystem\.debug\s*\(/g)) {
        add(m.index ?? 0, 12, 'Leftover System.debug() — remove before deploying.', DiagnosticSeverity.Information, CODE_DEBUG);
    }
    for (const m of text.matchAll(/'(?:[A-Za-z0-9]{18}|[A-Za-z0-9]{15})'/g)) {
        add(m.index ?? 0, m[0].length, 'Possible hardcoded Salesforce ID — avoid hardcoding record IDs.', DiagnosticSeverity.Warning, CODE_HARDCODED_ID);
    }

    const bodies = loopBodies(text);
    if (bodies.length) {
        const inLoop = (off: number) => bodies.some((b) => off >= b.start && off < b.end);
        for (const m of text.matchAll(/\[\s*SELECT\b/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].length, 'SOQL query inside a loop — move it out to avoid governor limits.', DiagnosticSeverity.Warning, CODE_SOQL_IN_LOOP);
        }
        for (const m of text.matchAll(/\b(?:insert|update|upsert|delete|undelete)\b\s+[A-Za-z_([]/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].trimEnd().length, 'DML inside a loop — bulkify (collect records, DML once).', DiagnosticSeverity.Warning, CODE_DML_IN_LOOP);
        }
        for (const m of text.matchAll(/\bDatabase\.(?:insert|update|upsert|delete|undelete)\s*\(/gi)) {
            if (inLoop(m.index ?? 0)) add(m.index ?? 0, m[0].length, 'DML inside a loop — bulkify (collect records, DML once).', DiagnosticSeverity.Warning, CODE_DML_IN_LOOP);
        }
    }

    for (const m of text.matchAll(/\b(?:public|global)\s+((?:(?:virtual|abstract|with|without|inherited|sharing)\s+)*)class\s+(\w+)/gi)) {
        if (/sharing/i.test(m[1]) || braceDepthAt(text, m.index ?? 0) !== 0) continue;
        add(m.index ?? 0, m[0].length, `Class ${m[2]} declares no sharing (with / without / inherited sharing).`, DiagnosticSeverity.Information, CODE_MISSING_SHARING);
    }

    return diags;
}

/** Suffixes that make a name a custom SObject: object, big object, platform event, custom metadata, external object. */
const CUSTOM_SOBJECT_SUFFIX = /__(c|b|e|mdt|x)$/i;

/**
 * Common standard objects declared as Apex variable types. Not exhaustive — custom
 * SObjects are recognized by their suffix, and a standard object missing here simply
 * isn't validated (conservative, no false positive). Local/workspace types shadow these.
 */
const STANDARD_SOBJECTS = new Set([
    'account', 'accountcontactrelation', 'asset', 'attachment', 'businesshours', 'campaign', 'campaignmember',
    'case', 'casecomment', 'contact', 'contentdocument', 'contentdocumentlink', 'contentnote', 'contentversion',
    'contract', 'dashboard', 'document', 'emailmessage', 'entitlement', 'event', 'eventrelation', 'feedcomment',
    'feeditem', 'group', 'groupmember', 'holiday', 'idea', 'individual', 'lead', 'note', 'opportunity',
    'opportunitycontactrole', 'opportunitylineitem', 'opportunityteammember', 'order', 'orderitem', 'organization',
    'period', 'permissionset', 'permissionsetassignment', 'pricebook2', 'pricebookentry', 'processinstance',
    'product2', 'profile', 'quote', 'quotelineitem', 'recordtype', 'report', 'serviceappointment', 'servicecontract',
    'site', 'solution', 'task', 'territory2', 'topic', 'user', 'userrole', 'workorder', 'workorderlineitem',
]);

/**
 * A name that is obviously NOT an org SObject and must never be resolved via the
 * describe API: generics/arrays/qualified names, the abstract `SObject`, Apex system
 * types, and any class/trigger defined in the workspace.
 */
function isNonSObjectName(name: string): boolean {
    if (!name || /[<>[\]\s.,()]/.test(name)) return true; // generics, arrays, qualified, calls
    if (name.toLowerCase() === 'sobject') return true;    // the abstract base type
    if (stdTypeName(name)) return true;                   // System/Database/… and value types
    if (WorkspaceIndex.hasType(name)) return true;        // a class/trigger defined in this project
    return false;
}

async function runSchemaValidation(ctx: ServerContext, uri: string): Promise<void> {
    const { documents, settings } = ctx;
    let doc = documents.get(uri);
    if (!doc || !settings.apexFeatures || !settings.apexValidateSchema || ctx.ephemeralDocs.has(uri) || doc.languageId === 'soql' || !isApex(uri)) return;
    // The workspace-class check below must see the full index, or a project class named
    // like a standard object would be validated as that SObject.
    await WorkspaceIndex.ready();
    doc = documents.get(uri);
    if (!doc) return;
    const atStart = doc.version;
    const parse = ctx.parses.current(doc);
    try {
        // Decide if a receiver type is an SObject with no API probing — easy logic:
        //   • a type declared in this file (class/enum/inner class), a workspace class,
        //     a generic/system type → NOT an SObject (a local `Event` beats the SObject).
        //   • a custom suffix (__c/__b/__e/__mdt/__x) → a custom SObject.
        //   • a name we've generated an org stub for → a real SObject (covers standard
        //     objects the org actually uses, beyond the built-in list).
        //   • otherwise, a known standard object from the built-in list.
        const localTypes = new Set([...parse.index.types.keys()].map((t) => t.toLowerCase()));
        const stubbed = stubbedObjectNames();
        const shouldDescribe = (s: string): boolean => {
            const l = s.toLowerCase();
            if (isNonSObjectName(s) || localTypes.has(l)) return false;
            return CUSTOM_SOBJECT_SUFFIX.test(s) || stubbed.has(l) || STANDARD_SOBJECTS.has(l);
        };

        const schema = await validateFieldAccesses(parse.fieldAccesses, {
            varTypeAt: (name, line, character) => resolveVarType(parse.index, name, line, character),
            describe: (s) => (shouldDescribe(s) ? ctx.schema.describe(uri, s) : Promise.resolve(null)),
            resolveRelTarget: (base, hops) => ctx.schema.resolveRelationshipTarget(uri, base, hops),
        });
        // Drop the result if the document changed while we were awaiting describes;
        // a newer edit will have scheduled its own run.
        const live = documents.get(uri);
        if (!live || live.version !== atStart) return;
        // Tag unknown-field findings with a code + { object, field } for the quick fixes.
        for (const d of schema) {
            const data = parseUnknownFieldMessage(d.message);
            if (data) {
                d.code = CODE_UNKNOWN_FIELD;
                d.data = data;
            }
        }
        ctx.connection.sendDiagnostics({ uri, diagnostics: [...ctx.parses.current(live).diagnostics, ...lintApex(live), ...schema] });
    } catch {
        // Keep the already-published syntax diagnostics; schema pass is best-effort.
    }
}
