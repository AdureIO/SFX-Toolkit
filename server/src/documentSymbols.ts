/**
 * Document outline (DocumentSymbol tree) for Apex (gated by apexFeatures).
 */
import type { Connection } from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { isApex } from './textUtil';

export function register(connection: Connection, ctx: ServerContext): void {
    // Parsed in the worker (currentAsync): opening a large class never blocks the event loop.
    connection.onDocumentSymbol(async (params) => {
        if (!ctx.settings.apexFeatures) return [];
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !isApex(doc.uri)) return [];
        return (await ctx.parses.currentAsync(doc)).symbols;
    });
}
