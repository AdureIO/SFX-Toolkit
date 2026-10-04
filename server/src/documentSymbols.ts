/**
 * Document outline (DocumentSymbol tree) for Apex (gated by apexFeatures).
 */
import type { Connection } from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { isApex } from './textUtil';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onDocumentSymbol((params) => {
        if (!ctx.settings.apexFeatures) return [];
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !isApex(doc.uri)) return [];
        return ctx.parses.current(doc).symbols;
    });
}
