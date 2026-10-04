/**
 * Go to implementation + type hierarchy over the workspace type graph
 * (WorkspaceIndex.typeGraph: extends/implements of every class/interface/enum).
 * Helper for navigation.ts (no handler registration here).
 *
 *   implementation  type → transitive subclasses / implementing classes;
 *                   method → overriding / implementing methods in subtypes.
 *   typeHierarchy   prepare at a type name; supertypes / subtypes (direct, workspace only).
 */
import { CancellationToken, Location, SymbolKind, TypeHierarchyItem } from 'vscode-languageserver/node';
import * as path from 'path';
import type { ServerContext } from './context';
import { isApex } from './textUtil';
import type { TypeNode } from './workspaceIndex';
import { SearchSession, resolveAt, methodImplementations } from './symbolSearch';

type Pos = { textDocument: { uri: string }; position: { line: number; character: number } };

function docFor(ctx: ServerContext, uri: string) {
    const doc = ctx.documents.get(uri);
    if (!doc || !ctx.settings.apexFeatures || !isApex(doc.uri) || doc.languageId === 'soql') return undefined;
    return doc;
}

export async function implementations(ctx: ServerContext, params: Pos, token: CancellationToken): Promise<Location[] | null> {
    const doc = docFor(ctx, params.textDocument.uri);
    if (!doc) return null;
    const s = new SearchSession(ctx, token);
    const res = await resolveAt(s, doc, params.position);
    const sym = res?.symbol;
    if (!sym) return null;
    const g = await s.graph();
    if (sym.kind === 'type') {
        return g
            .descendants(sym.node)
            .filter((n) => n.header.kind === 'class')
            .map((n) => Location.create(s.uriOf(n.file), n.header.nameRange));
    }
    if (sym.kind === 'method') {
        const impls = await methodImplementations(s, sym.owner, sym.name);
        return impls.map((i) => Location.create(s.uriOf(i.node.file), i.member.nameRange));
    }
    return null;
}

interface ItemData {
    file: string;
    qname: string;
}

function itemFor(s: SearchSession, n: TypeNode): TypeHierarchyItem {
    const h = n.header;
    const kind = h.kind === 'interface' ? SymbolKind.Interface : h.kind === 'enum' ? SymbolKind.Enum : SymbolKind.Class;
    const mods = h.modifiers.filter((m) => m === 'abstract' || m === 'virtual');
    const detail = [h.outer ? `${h.outer}.${h.name}` : undefined, mods.join(' ') || undefined, path.basename(n.file)]
        .filter(Boolean)
        .join(' · ');
    const data: ItemData = { file: n.file, qname: n.qname };
    return { name: h.name, kind, detail, uri: s.uriOf(n.file), range: h.range, selectionRange: h.nameRange, data };
}

export async function prepareTypeHierarchy(ctx: ServerContext, params: Pos, token: CancellationToken): Promise<TypeHierarchyItem[] | null> {
    const doc = docFor(ctx, params.textDocument.uri);
    if (!doc) return null;
    const s = new SearchSession(ctx, token);
    const res = await resolveAt(s, doc, params.position);
    const sym = res?.symbol;
    if (!sym) return null;
    if (sym.kind === 'type') return [itemFor(s, sym.node)];
    // On a member: offer the owner's hierarchy (handy from inside a method).
    if (sym.kind === 'method' || sym.kind === 'field') return [itemFor(s, sym.owner)];
    return null;
}

async function related(
    ctx: ServerContext,
    item: TypeHierarchyItem,
    token: CancellationToken,
    dir: 'super' | 'sub',
): Promise<TypeHierarchyItem[] | null> {
    if (!ctx.settings.apexFeatures) return null;
    const data = item.data as ItemData | undefined;
    if (!data?.file || !data.qname) return null;
    const s = new SearchSession(ctx, token);
    const g = await s.graph();
    const n = g.find(data.file, data.qname);
    if (!n) return null;
    return (dir === 'super' ? g.supertypes(n) : g.subtypes(n)).map((x) => itemFor(s, x));
}

export function supertypes(ctx: ServerContext, item: TypeHierarchyItem, token: CancellationToken) {
    return related(ctx, item, token, 'super');
}

export function subtypes(ctx: ServerContext, item: TypeHierarchyItem, token: CancellationToken) {
    return related(ctx, item, token, 'sub');
}
