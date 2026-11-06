/**
 * Rename (textDocument/prepareRename + textDocument/rename) for workspace Apex symbols:
 * locals/params, fields/properties, methods (with their override/implementation family)
 * and classes/interfaces/enums. Helper for navigation.ts (no handler registration here).
 *
 * Occurrences come from symbolSearch (mode `rename`: only occurrences proven to refer to
 * the symbol) — the same complete engine as Find References. A class rename also renames
 * `Name.cls` + `Name.cls-meta.xml` when the file is named after the class and the client
 * supports resource operations.
 *
 * Salesforce metadata that names the symbol in strings is updated too, where the new text
 * is unambiguous: LWC `@salesforce/apex/Cls.method` specifiers (class / method segment —
 * the import's local binding name is the component's own and stays), Aura `controller=`
 * and `'c.method'`, Visualforce `controller=` / `extensions=` / `{!name}`, Flow
 * `<actionName>` / `<apexClass>`, `Type.forName('Cls')`. A Visualforce getter / setter
 * expression (`{!foo}` for `getFoo()`) is renamed only when the new name keeps the
 * `get` / `set` prefix; otherwise it is skipped and the user is warned (window message).
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
    CancellationToken,
    ErrorCodes,
    Range,
    RenameFile,
    ResponseError,
    ShowMessageNotification,
    MessageType,
    TextDocumentEdit,
    TextEdit,
    WorkspaceEdit,
} from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { throwIfCancelled } from './cancel';
import { isApex } from './textUtil';
import {
    SearchSession,
    resolveAt,
    findOccurrences,
    renameRestriction,
    invalidIdentifierReason,
    ResolvedSymbol,
    Occurrence,
    contentModified,
} from './symbolSearch';

export interface RenameClientSupport {
    /** Client accepts `documentChanges` with RenameFile operations. */
    renameFiles: boolean;
}

function fail(message: string): ResponseError<void> {
    return new ResponseError(ErrorCodes.InvalidRequest, message);
}

type Resolved = { session: SearchSession; sym: ResolvedSymbol; range: Range; word: string };

async function resolveForRename(
    ctx: ServerContext,
    uri: string,
    position: { line: number; character: number },
    token: CancellationToken,
): Promise<Resolved | ResponseError<void> | null> {
    const doc = ctx.documents.get(uri);
    if (!doc || !ctx.settings.apexFeatures || !isApex(doc.uri) || doc.languageId === 'soql') return null;
    const session = new SearchSession(ctx, token);
    const res = await resolveAt(session, doc, position);
    if (!res) return fail('Place the cursor on an identifier to rename.');
    if (res.rejection) return fail(`Can't rename: ${res.rejection.reject}`);
    if (!res.symbol) return fail(`Can't rename '${res.word}'.`);
    const restriction = await renameRestriction(session, res.symbol);
    if (restriction) return fail(`Can't rename: ${restriction}`);
    return { session, sym: res.symbol, range: res.range, word: res.word };
}

export async function prepareRename(
    ctx: ServerContext,
    params: { textDocument: { uri: string }; position: { line: number; character: number } },
    token: CancellationToken,
): Promise<{ range: Range; placeholder: string } | ResponseError<void> | null> {
    const r = await resolveForRename(ctx, params.textDocument.uri, params.position, token);
    if (!r) return null;
    if (r instanceof ResponseError) return r;
    return { range: r.range, placeholder: r.word };
}

export async function rename(
    ctx: ServerContext,
    params: { textDocument: { uri: string }; position: { line: number; character: number }; newName: string },
    token: CancellationToken,
    support: RenameClientSupport,
): Promise<WorkspaceEdit | ResponseError<void> | null> {
    const newName = params.newName.trim();
    const r = await resolveForRename(ctx, params.textDocument.uri, params.position, token);
    if (!r) return null;
    if (r instanceof ResponseError) return r;
    const { session, sym } = r;
    const bad = invalidIdentifierReason(newName, sym.kind === 'type');
    if (bad) return fail(bad);

    if (sym.kind === 'type' && newName.toLowerCase() !== sym.name.toLowerCase()) {
        const g = await session.graph();
        const clash = sym.node.header.outer ? g.resolve(`${sym.node.header.outer}.${newName}`) : g.resolve(newName);
        if (clash) return fail(`A type named '${clash.qname}' already exists in this workspace.`);
    }

    const occ = await findOccurrences(session, sym, 'rename');
    throwIfCancelled(token);
    if (!occ.length) return null;
    // Every edit is a range into the text we searched: refuse if an open document moved on.
    for (const d of session.openByPath.values()) if (ctx.documents.get(d.uri)?.version !== d.version) throw contentModified();

    // Group per document, dedupe; metadata occurrences get their own replacement text.
    const byUri = new Map<string, { path: string; edits: TextEdit[]; seen: Set<string> }>();
    const skipped: Occurrence[] = [];
    for (const o of occ) {
        const text = replacementFor(o, newName);
        if (text === null) continue;
        if (text === undefined) skipped.push(o);
        else add(byUri, o, text);
    }
    if (skipped.length) {
        const files = [...new Set(skipped.map((o) => path.basename(o.path)))].join(', ');
        // A notification (not showMessageRequest): nothing to answer, nothing to reject.
        void ctx.connection.sendNotification(ShowMessageNotification.type, {
            type: MessageType.Warning,
            message:
                `Rename '${sym.name}' → '${newName}': ${skipped.length} Visualforce expression(s) in ${files} were not updated — ` +
                `they reach the ${/^get/i.test(sym.name) ? 'getter' : 'setter'} by its property name, and the new name no longer starts with '${/^get/i.test(sym.name) ? 'get' : 'set'}'.`,
        });
    }

    const fileOps = sym.kind === 'type' && !sym.node.header.outer ? classFileRenames(sym.node.file, sym.name, newName) : [];
    if (fileOps.length && !support.renameFiles) fileOps.length = 0;
    if (fileOps.some((op) => op instanceof ResponseError)) return fileOps.find((op) => op instanceof ResponseError) as ResponseError<void>;

    if (!fileOps.length) {
        const changes: { [uri: string]: TextEdit[] } = {};
        for (const [uri, v] of byUri) changes[uri] = v.edits;
        return { changes };
    }
    // documentChanges: text edits first (against the old URIs), then the file renames.
    const documentChanges: (TextDocumentEdit | RenameFile)[] = [];
    for (const [uri, v] of byUri) {
        const open = session.openByPath.get(v.path);
        documentChanges.push(TextDocumentEdit.create({ uri, version: open && open.uri === uri ? open.version : null }, v.edits));
    }
    for (const op of fileOps) documentChanges.push(op as RenameFile);
    return { documentChanges };
}

/**
 * The text an occurrence becomes: the new name for code and plain metadata references;
 * the derived property name for Visualforce getter / setter expressions (undefined =
 * can't be expressed → skipped with a warning); null = not renamed at all (LWC import
 * bindings are the component's local names; a Flow action names the class, not the
 * invocable method).
 */
function replacementFor(o: Occurrence, newName: string): string | null | undefined {
    switch (o.role) {
        case 'lwc-use':
        case 'flow-invocable':
            return null;
        case 'vf-getter':
        case 'vf-setter': {
            const prefix = o.role === 'vf-getter' ? 'get' : 'set';
            const m = new RegExp(`^${prefix}([A-Za-z_]\\w*)$`, 'i').exec(newName);
            if (!m) return undefined;
            return m[1];
        }
        default:
            return newName;
    }
}

function add(byUri: Map<string, { path: string; edits: TextEdit[]; seen: Set<string> }>, o: Occurrence, newName: string): void {
    let e = byUri.get(o.uri);
    if (!e) byUri.set(o.uri, (e = { path: o.path, edits: [], seen: new Set() }));
    const key = `${o.range.start.line}:${o.range.start.character}`;
    if (e.seen.has(key)) return;
    e.seen.add(key);
    e.edits.push(TextEdit.replace(o.range, newName));
}

/** RenameFile ops for `Old.cls` (+ `Old.cls-meta.xml`) when the file is named after the class. */
function classFileRenames(file: string, oldName: string, newName: string): (RenameFile | ResponseError<void>)[] {
    const base = path.basename(file);
    const m = /^(.*)\.cls$/i.exec(base);
    if (!m || m[1].toLowerCase() !== oldName.toLowerCase() || m[1] === newName) return [];
    const dir = path.dirname(file);
    const target = path.join(dir, `${newName}.cls`);
    const caseOnly = newName.toLowerCase() === m[1].toLowerCase();
    if (!caseOnly && fs.existsSync(target)) return [fail(`A file named ${newName}.cls already exists.`)];
    const ops: RenameFile[] = [RenameFile.create(pathToFileURL(file).href, pathToFileURL(target).href, { overwrite: false })];
    const meta = `${file}-meta.xml`;
    if (fs.existsSync(meta)) {
        ops.push(RenameFile.create(pathToFileURL(meta).href, pathToFileURL(path.join(dir, `${newName}.cls-meta.xml`)).href, { overwrite: false }));
    }
    return ops;
}
