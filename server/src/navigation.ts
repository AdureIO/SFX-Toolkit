/**
 * Navigation/refactoring feature module: rename (+ prepareRename), go to implementation,
 * and type hierarchy (prepare / supertypes / subtypes) for workspace Apex symbols.
 * Logic lives in rename.ts / hierarchy.ts on top of symbolSearch.ts.
 */
import type { ClientCapabilities, Connection } from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { orCancelled } from './cancel';
import { prepareRename, rename } from './rename';
import { implementations, prepareTypeHierarchy, supertypes, subtypes } from './hierarchy';
import { clearSearchCaches } from './symbolSearch';

/** Server capabilities this module serves (spread into capabilitiesFor). */
export function capabilities(apexFeatures: boolean) {
    return apexFeatures
        ? { renameProvider: { prepareProvider: true }, implementationProvider: true, typeHierarchyProvider: true }
        : {};
}

export function register(connection: Connection, ctx: ServerContext): void {
    // The client's capabilities aren't kept on the context; capture the workspace-edit
    // support we need (RenameFile in documentChanges) when the library hands them to the
    // `workspace` remote during `initialize` (that runs after every register() call).
    let renameFiles = false;
    const ws = connection.workspace as unknown as { initialize?: (c: ClientCapabilities) => void };
    const orig = ws.initialize;
    ws.initialize = function (this: unknown, caps: ClientCapabilities) {
        const we = caps?.workspace?.workspaceEdit;
        renameFiles = !!(we?.documentChanges && we.resourceOperations?.includes('rename'));
        return orig?.call(this, caps);
    };

    connection.onPrepareRename((params, token) => orCancelled(null, () => prepareRename(ctx, params, token)));
    connection.onRenameRequest((params, token) => orCancelled(null, () => rename(ctx, params, token, { renameFiles })));
    connection.onImplementation((params, token) => orCancelled(null, () => implementations(ctx, params, token)));
    connection.languages.typeHierarchy.onPrepare((params, token) => orCancelled(null, () => prepareTypeHierarchy(ctx, params, token)));
    connection.languages.typeHierarchy.onSupertypes((params, token) => orCancelled(null, () => supertypes(ctx, params.item, token)));
    connection.languages.typeHierarchy.onSubtypes((params, token) => orCancelled(null, () => subtypes(ctx, params.item, token)));
    ctx.onRelease(clearSearchCaches);
}
