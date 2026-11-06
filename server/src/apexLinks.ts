/**
 * Host → server requests that let the extension's LWC / Aura / Visualforce providers
 * navigate into Apex with the server's workspace model (unopened files, unsaved Apex
 * buffers, case-insensitive names, namespaces, overloads):
 *
 *   sfx/apexDefinition  { className, member?, prefer? } → Location | null
 *       The class's name, or the member's declaration (`prefer: 'aura'` picks the
 *       @AuraEnabled overload, `'invocable'` the @InvocableMethod).
 *   sfx/apexReferences  { className, member?, prefer?, includeDeclaration? } → Location[]
 *       The same complete list Find References on the Apex declaration returns (Apex
 *       call sites + LWC / Aura / Visualforce / Flow references).
 *
 * Served regardless of the `apexFeatures` gate: the metadata side (JS / markup) is not
 * covered by the Salesforce Apex language server.
 */
import { Connection, Location } from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { orCancelled } from './cancel';
import { REQ_APEX_DEFINITION, REQ_APEX_REFERENCES } from './protocol';
import { SearchSession, resolveByName, findOccurrences, declarationOf, sameRange } from './symbolSearch';

interface ByName {
    className: string;
    member?: string;
    prefer?: 'aura' | 'invocable';
    includeDeclaration?: boolean;
}

function valid(p: ByName | undefined): p is ByName {
    return !!p && typeof p.className === 'string' && /^[A-Za-z_]\w*$/.test(p.className) && (p.member === undefined || /^[A-Za-z_]\w*$/.test(p.member));
}

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onRequest(REQ_APEX_DEFINITION, (params: ByName, token) =>
        orCancelled<Location | null>(null, async () => {
            if (!valid(params)) return null;
            const s = new SearchSession(ctx, token);
            const sym = await resolveByName(s, params.className, params.member, params.prefer);
            const d = sym && declarationOf(s, sym);
            return d ? Location.create(d.uri, d.range) : null;
        }),
    );
    connection.onRequest(REQ_APEX_REFERENCES, (params: ByName, token) =>
        orCancelled<Location[]>([], async () => {
            if (!valid(params)) return [];
            const s = new SearchSession(ctx, token);
            const sym = await resolveByName(s, params.className, params.member, params.prefer);
            if (!sym) return [];
            const occ = await findOccurrences(s, sym, 'references');
            const decl = params.includeDeclaration === false ? declarationOf(s, sym) : undefined;
            return occ.filter((o) => !decl || o.path !== decl.path || !sameRange(o.range, decl.range)).map((o) => Location.create(o.uri, o.range));
        }),
    );
}
