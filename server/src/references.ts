/**
 * References for Apex symbols.
 *
 * Workspace symbols (locals/params, fields/properties, methods incl. their override
 * family, classes/interfaces/enums) resolve through symbolSearch — the same resolution
 * and occurrence classification rename uses (case-insensitive, receiver-type aware,
 * scope-aware). In `references` mode occurrences behind an unresolvable receiver are
 * kept (inclusive). Anything symbolSearch can't resolve (SObject fields, standard
 * library members…) falls back to a whole-word text search: scope-aware in this file,
 * plus the project's other Apex files.
 */
import { CancellationToken, Connection, Location } from 'vscode-languageserver/node';
import { fileURLToPath, pathToFileURL } from 'url';
import * as fs from 'fs';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { ServerContext } from './context';
import { symbolAt, findReferencesInText } from '../../src/utils/apexReferences';
import { WorkspaceIndex } from './workspaceIndex';
import { isApex } from './textUtil';
import { orCancelled } from './cancel';
import { SearchSession, resolveAt, findOccurrences, declarationOf, sameRange } from './symbolSearch';

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
    const text = doc.getText();
    const ref = symbolAt(text, ctx.parses.current(doc).index, position);
    if (!ref) return [];

    const out: Location[] = findReferencesInText(text, ref.name, ref.scope).map((range) => Location.create(doc.uri, range));

    // A local/param can't be referenced from another file — stop here.
    if (ref.localOnly) return out;

    // Otherwise scan the rest of the project's Apex. Cap the work so a huge org can't hang the
    // editor; the current file's results are already included above. Reads are async and
    // we yield between batches so other requests (completion, hover) stay responsive, and
    // stop as soon as the client cancels.
    const MAX_FILES = 2000;
    const YIELD_EVERY = 25;
    await WorkspaceIndex.ready();
    if (token.isCancellationRequested) return out;
    let thisPath = '';
    try {
        thisPath = fileURLToPath(doc.uri);
    } catch {
        /* non-file buffer — scan everything */
    }
    let scanned = 0;
    for (const file of WorkspaceIndex.allFiles()) {
        if (token.isCancellationRequested) return out;
        if (scanned++ >= MAX_FILES) break;
        if (file === thisPath) continue;
        if (scanned % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        // Prefer the open (possibly unsaved) buffer over the file on disk.
        const fileUri = pathToFileURL(file).toString();
        const open = ctx.documents.get(fileUri);
        let body: string;
        try {
            body = open ? open.getText() : await fs.promises.readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (!body.includes(ref.name)) continue; // cheap reject before the regex pass
        for (const range of findReferencesInText(body, ref.name)) out.push(Location.create(fileUri, range));
    }
    return out;
}
