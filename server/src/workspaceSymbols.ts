/**
 * Apex workspace symbols — jump to any class/trigger in the project.
 * Runs on every keystroke in the symbol picker, so it only consults the filename index
 * (no file reads/parses); the declaration's exact range is filled in by the resolve
 * request below, for the one symbol the user actually picks.
 */
import { Connection, SymbolKind, WorkspaceSymbol } from 'vscode-languageserver/node';
import { pathToFileURL } from 'url';
import type { ServerContext } from './context';
import { WorkspaceIndex, declarationRange } from './workspaceIndex';

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onWorkspaceSymbol(async (params, token): Promise<WorkspaceSymbol[]> => {
        if (!ctx.settings.apexFeatures) return [];
        await WorkspaceIndex.ready();
        const q = (params.query ?? '').toLowerCase();
        const out: WorkspaceSymbol[] = [];
        for (const name of WorkspaceIndex.allTypeNames()) {
            if (token.isCancellationRequested) return [];
            if (q && !name.toLowerCase().includes(q)) continue;
            const file = WorkspaceIndex.fileFor(name);
            if (!file) continue;
            out.push({ name, kind: SymbolKind.Class, location: { uri: pathToFileURL(file).href }, data: { file, name } });
            if (out.length >= 200) break;
        }
        return out;
    });

    connection.onWorkspaceSymbolResolve((symbol): WorkspaceSymbol => {
        const data = symbol.data as { file?: string; name?: string } | undefined;
        if (!data?.file || !data.name) return symbol;
        return { ...symbol, location: { uri: pathToFileURL(data.file).href, range: declarationRange(data.file, data.name) } };
    });
}
