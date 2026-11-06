/**
 * Salesforce metadata references to Apex (string forms), for Find References / rename:
 *
 *   class    LWC `@salesforce/apex/[ns.]Cls.m` (class segment), Aura `controller="Cls"`,
 *            Visualforce `controller=` / `extensions=`, Flow `<actionName>` (apex actions)
 *            and `<apexClass>`.
 *   method   LWC import (method segment) + the import's local binding and its uses
 *            (`@wire(binding, …)`, `binding({…})`); Aura `'c.method'` in the controller /
 *            helper JS of components whose controller is the class; Visualforce `{!name}`
 *            on pages whose controller / extension is the class (or a subclass), with
 *            getter / setter mapping (`getFoo()` ↔ `{!foo}`); Flow `<actionName>` for an
 *            `@InvocableMethod` (the action names the class).
 *   field    Visualforce `{!name}` (properties / public fields of the controller).
 *
 * Candidate files come from the token index (metadata files are tokenized raw), so only
 * files that mention the class (and member) by name are read. Overloads: LWC / Aura only
 * reach the `@AuraEnabled` overload, so another overload never lists them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { Range } from 'vscode-languageserver/node';
import { WorkspaceIndex, TypeNode } from './workspaceIndex';
import { TokenIndex } from './tokenIndex';
import type { Occurrence, OccurrenceRole, ResolvedSymbol, SearchSession } from './symbolSearch';
import {
    auraActionRefs,
    auraControllerRef,
    classNameMatches,
    flowApexRefs,
    lineStartsOf,
    lwcApexImports,
    jsIdentifierUses,
    blankJs,
    metadataKindOf,
    MetadataKind,
    positionAtOffset,
    vfControllerRefs,
    vfExpressionRefs,
    vfNamesForMember,
    Span,
} from '../../src/utils/sfMetadataRefs';

type MemberSym = Extract<ResolvedSymbol, { kind: 'method' | 'field' }>;

async function read(file: string): Promise<string | undefined> {
    try {
        return await fs.promises.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** Indexed metadata files of a kind containing every token. */
function filesWith(kind: MetadataKind | MetadataKind[], ...tokens: string[]): string[] {
    const kinds = Array.isArray(kind) ? kind : [kind];
    if (!tokens.length) return [];
    let set = new Set(TokenIndex.lookup(tokens[0]));
    for (const t of tokens.slice(1)) {
        const next = new Set(TokenIndex.lookup(t));
        set = new Set([...set].filter((f) => next.has(f)));
    }
    return [...set].filter((f) => {
        const k = metadataKindOf(f);
        return !!k && kinds.includes(k);
    });
}

class Collector {
    readonly out: Occurrence[] = [];
    private ls = new Map<string, number[]>();
    add(file: string, text: string, span: Span, role: OccurrenceRole): void {
        let starts = this.ls.get(file);
        if (!starts) this.ls.set(file, (starts = lineStartsOf(text)));
        const s = positionAtOffset(starts, span.start);
        const range: Range = { start: s, end: { line: s.line, character: s.character + (span.end - span.start) } };
        this.out.push({ path: file, uri: pathToFileURL(file).href, range, role });
    }
}

/** Metadata occurrences of a resolved Apex symbol (empty for locals / inner types). */
export async function metadataOccurrences(s: SearchSession, sym: ResolvedSymbol, family: Set<TypeNode>): Promise<Occurrence[]> {
    if (sym.kind === 'local') return [];
    await TokenIndex.ensure(s.token);
    s.check();
    const ns = await s.namespace();
    const c = new Collector();
    if (sym.kind === 'type') {
        if (sym.node.header.outer) return [];
        await classRefs(s, sym.name, ns, c);
    } else {
        await memberRefs(s, sym, family, ns, c);
    }
    return c.out;
}

async function classRefs(s: SearchSession, cls: string, ns: string | null, c: Collector): Promise<void> {
    const lc = cls.toLowerCase();
    for (const f of filesWith(['lwc', 'auraCmp', 'vf', 'flow'], lc)) {
        s.check();
        const text = await read(f);
        if (text === undefined) continue;
        switch (metadataKindOf(f)) {
            case 'lwc':
                for (const imp of lwcApexImports(text)) {
                    if (classNameMatches(imp.cls.name, imp.ns, cls, ns)) c.add(f, text, imp.cls, 'lwc-class');
                }
                break;
            case 'auraCmp': {
                const r = auraControllerRef(text);
                if (r && classNameMatches(r.name, r.ns, cls, ns)) c.add(f, text, r, 'aura-controller');
                break;
            }
            case 'vf':
                for (const r of vfControllerRefs(text)) if (classNameMatches(r.name, r.ns, cls, ns)) c.add(f, text, r, 'vf-controller');
                break;
            case 'flow':
                for (const r of flowApexRefs(text)) if (classNameMatches(r.name, r.ns, cls, ns)) c.add(f, text, r, 'flow-class');
                break;
        }
    }
}

async function memberRefs(s: SearchSession, sym: MemberSym, family: Set<TypeNode>, ns: string | null, c: Collector): Promise<void> {
    const lc = sym.name.toLowerCase();
    const isMethod = sym.kind === 'method';
    const mods = sym.member.modifiers;
    // LWC / Aura / Flow call static methods of the declaring (top-level) class directly; they
    // only reach the @AuraEnabled overload, so another overload of the name lists none of them.
    if (isMethod && !sym.owner.header.outer) {
        const cls = sym.owner.header.name;
        const same = (await s.membersOf(sym.owner)).filter((x) => x.kind === 'method' && x.name.toLowerCase() === lc);
        const auraOk = !same.some((x) => x.modifiers.includes('@auraenabled')) || mods.includes('@auraenabled');
        {
            // LWC imports + uses of the binding.
            for (const f of auraOk ? filesWith('lwc', cls.toLowerCase(), lc) : []) {
                s.check();
                const text = await read(f);
                if (text === undefined) continue;
                let code: string | undefined;
                for (const imp of lwcApexImports(text)) {
                    if (!classNameMatches(imp.cls.name, imp.ns, cls, ns) || imp.method.name.toLowerCase() !== lc) continue;
                    c.add(f, text, imp.method, 'lwc-spec');
                    if (imp.local) {
                        code ??= blankJs(text);
                        for (const u of jsIdentifierUses(text, imp.local.name, code)) c.add(f, text, u, 'lwc-use');
                    }
                }
            }
            // Aura: components whose controller is the class → their JS action strings.
            for (const cmp of auraOk ? filesWith('auraCmp', cls.toLowerCase()) : []) {
                s.check();
                const text = await read(cmp);
                const r = text === undefined ? undefined : auraControllerRef(text);
                if (!r || !classNameMatches(r.name, r.ns, cls, ns)) continue;
                const dir = path.dirname(cmp);
                for (const js of WorkspaceIndex.metadataFiles()) {
                    if (path.dirname(js) !== dir || metadataKindOf(js) !== 'auraJs' || TokenIndex.has(js, lc) === false) continue;
                    const jsText = await read(js);
                    if (jsText === undefined) continue;
                    for (const a of auraActionRefs(jsText, sym.name)) c.add(js, jsText, a, 'aura-action');
                }
            }
            // Flow: an @InvocableMethod is reached through its class's apex action.
            if (mods.includes('@invocablemethod')) {
                for (const f of filesWith('flow', cls.toLowerCase())) {
                    const text = await read(f);
                    if (text === undefined) continue;
                    for (const r of flowApexRefs(text)) {
                        if (r.tag === 'actionName' && classNameMatches(r.name, r.ns, cls, ns)) c.add(f, text, r, 'flow-invocable');
                    }
                }
            }
        }
    }

    // Visualforce: pages whose controller / extension is a family type (inherited getters too).
    const names = vfNamesForMember(sym.name, isMethod ? 'method' : sym.member.kind === 'property' ? 'property' : 'field', sym.member.arity);
    const role: OccurrenceRole = isMethod && names[0].toLowerCase() !== lc ? (/^get/i.test(sym.name) ? 'vf-getter' : 'vf-setter') : 'vf';
    const famNames = [...family].filter((t) => !t.header.outer).map((t) => t.header.name);
    const pages = new Set<string>();
    for (const n of famNames) for (const f of filesWith('vf', n.toLowerCase(), names[0].toLowerCase())) pages.add(f);
    for (const f of pages) {
        s.check();
        const text = await read(f);
        if (text === undefined) continue;
        const ctrl = vfControllerRefs(text);
        if (!ctrl.some((r) => famNames.some((n) => classNameMatches(r.name, r.ns, n, ns)))) continue;
        for (const r of vfExpressionRefs(text, names)) c.add(f, text, r, role);
    }
}
