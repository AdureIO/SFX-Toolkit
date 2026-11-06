/**
 * References for Apex symbols.
 *
 * Workspace symbols (locals/params, fields/properties/enum values, methods incl. their
 * override family, classes/interfaces/enums) resolve through symbolSearch — the same
 * resolution and occurrence engine rename uses (case-insensitive, receiver-type aware via
 * the expression resolver, scope-aware, overload-aware, workspace-wide through the token
 * index, plus LWC / Aura / Visualforce / Flow metadata references). In `references` mode
 * occurrences behind a receiver that can't be typed at all are kept (inclusive).
 * Anything symbolSearch can't resolve (SObject fields, standard library members…) falls
 * back to a whole-word text search: scope-aware in this file, plus the project's other
 * Apex files that contain the word (token index).
 */
import { CancellationToken, Connection, Location } from 'vscode-languageserver/node';
import { fileURLToPath, pathToFileURL } from 'url';
import * as fs from 'fs';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { symbolAt, findReferencesInText } from '../../src/utils/apexReferences';
import { isApex } from './textUtil';
import { orCancelled } from './cancel';
import { TokenIndex } from './tokenIndex';
import { SearchSession, resolveAt, findOccurrences, declarationOf, sameRange, contentModified } from './symbolSearch';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onReferences((params, token) =>
        orCancelled<Location[]>([], async () => {
            const doc = ctx.documents.get(params.textDocument.uri);
            if (!doc || !ctx.settings.apexFeatures || !isApex(doc.uri)) return [];
            const session = new SearchSession(ctx, token);
            const res = await resolveAt(session, doc, params.position);
            if (res?.symbol) {
                const occ = await findOccurrences(session, res.symbol, 'references');
                const decl = params.context?.includeDeclaration === false ? declarationOf(session, res.symbol) : undefined;
                return occ
                    .filter((o) => !decl || o.path !== decl.path || !sameRange(o.range, decl.range))
                    .map((o) => Location.create(o.uri, o.range));
            }
            return textReferences(ctx, doc, params.position, token);
        }),
    );
}

/** Fallback: whole-word text search (scope-aware for locals in this file). */
async function textReferences(
    ctx: ServerContext,
    doc: TextDocument,
    position: { line: number; character: number },
    token: CancellationToken,
): Promise<Location[]> {
    const version = doc.version;
    const text = doc.getText();
    const parse = await ctx.parses.currentAsync(doc);
    if (doc.version !== version) throw contentModified();
    const ref = symbolAt(text, parse.index, position);
    if (!ref) return [];

    const out: Location[] = findReferencesInText(text, ref.name, ref.scope).map((range) => Location.create(doc.uri, range));

    // A local/param can't be referenced from another file — stop here.
    if (ref.localOnly) return out;

    // Otherwise the project's other Apex files that contain the word (token index; open
    // buffers by their unsaved text). Reads are async and we yield between files.
    await TokenIndex.ensure(token);
    let thisPath = '';
    try {
        thisPath = fileURLToPath(doc.uri);
    } catch {
        /* non-file buffer */
    }
    const lc = ref.name.toLowerCase();
    const files = new Set(TokenIndex.lookup(lc).filter((f) => /\.(cls|trigger)$/i.test(f)));
    for (const d of ctx.documents.all()) {
        if (!isApex(d.uri) || !d.uri.startsWith('file:')) continue;
        try {
            const p = fileURLToPath(d.uri);
            if (d.getText().toLowerCase().includes(lc)) files.add(p);
            else files.delete(p);
        } catch {
            /* ignore */
        }
    }
    let n = 0;
    for (const file of files) {
        if (token.isCancellationRequested) return out;
        if (file === thisPath) continue;
        if (++n % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        const fileUri = pathToFileURL(file).toString();
        const open = ctx.documents.get(fileUri);
        let body: string;
        try {
            body = open ? open.getText() : await fs.promises.readFile(file, 'utf8');
        } catch {
            continue;
        }
        for (const range of findReferencesInText(body, ref.name)) out.push(Location.create(fileUri, range));
    }
    return out;
}
