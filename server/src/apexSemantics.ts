/**
 * Offline, metadata-driven Apex schema validation (Tier 1).
 *
 * Given the field-access sites collected by the parser and the document's flat
 * variable-type map, flag `receiver.member` accesses whose member is not a field
 * or relationship of the resolved SObject. Purely heuristic and deliberately
 * CONSERVATIVE — it only reports when it can *confidently* resolve the receiver
 * to a known SObject (a declared variable whose type describes to an SObject).
 * Anything it cannot resolve (user classes, collections, casts, method chains,
 * generics, an object whose describe hasn't loaded) is skipped, never flagged.
 *
 * Pure logic with injected async lookups, so it's unit-testable without a live
 * org or the language-server runtime.
 */
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { FieldAccess } from './apexSymbols';

/** Minimal describe shape this validator needs (a subset of the host describe). */
export interface DescribeLite {
    fields: { name: string; relationshipName?: string }[];
    /** Parent object's child relationships — `parent.ChildRel__r` is valid Apex too.
     *  The host exposes the relationship name as `name`. */
    childRelationships?: { name?: string }[];
}

export interface SemanticDeps {
    /** Resolve a variable's declared type at a position (scope-aware). */
    varTypeAt: (name: string, line: number, character: number) => string | undefined;
    /** Resolve an SObject describe, or null if unknown / not an SObject / not loaded. */
    describe: (sobject: string) => Promise<DescribeLite | null>;
    /** Walk parent-relationship hops from a base SObject; null if any hop is unresolved. */
    resolveRelTarget: (base: string, hops: string[]) => Promise<string | null>;
}

export const SCHEMA_DIAGNOSTIC_SOURCE = 'asfx-apex-schema';

/** A base expression we can safely resolve: a plain identifier dot-chain, no calls/indexing. */
const IDENT_CHAIN = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/**
 * Drop a leading managed-package namespace (`ns__Name__c` → `Name__c`). A custom
 * API name has a `__c`/`__r`/… suffix, so 3+ `__`-separated parts ⇒ the first is
 * the namespace. Lets in-namespace code reference fields without the prefix.
 */
function stripNamespace(api: string): string {
    const parts = api.split('__');
    return parts.length >= 3 ? parts.slice(1).join('__') : api;
}

/** Namespace-optional, case-insensitive equality (both directions). */
function nameMatches(a: string, b: string): boolean {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la === lb || stripNamespace(la) === stripNamespace(lb);
}

function memberExists(d: DescribeLite, member: string): boolean {
    for (const f of d.fields) {
        if (nameMatches(f.name, member)) return true;
        if (f.relationshipName && nameMatches(f.relationshipName, member)) return true;
    }
    for (const c of d.childRelationships ?? []) {
        if (c.name && nameMatches(c.name, member)) return true;
    }
    return false;
}

/**
 * Validate a document's field-access sites against org metadata.
 * Returns one Warning diagnostic per member that provably doesn't exist on its
 * (confidently resolved) SObject.
 */
export async function validateFieldAccesses(
    accesses: FieldAccess[],
    deps: SemanticDeps
): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    // Per-run memo so repeated receivers/hops don't re-hit the describe bridge.
    const memo = new Map<string, DescribeLite | null>();
    const desc = async (s: string): Promise<DescribeLite | null> => {
        if (memo.has(s)) return memo.get(s) ?? null;
        const d = await deps.describe(s);
        memo.set(s, d);
        return d;
    };

    for (const a of accesses) {
        if (!IDENT_CHAIN.test(a.chain)) continue; // has a call/index/cast → can't safely resolve
        const segs = a.chain.split('.');
        const root = segs[0];
        const hops = segs.slice(1);

        // Root must be a declared variable, resolved at THIS access's position (so a
        // same-name variable in another method doesn't leak in). We deliberately do NOT
        // treat a bare SObject *type* name as a receiver here (that'd flag static access).
        const rootType = deps.varTypeAt(root, a.range.start.line, a.range.start.character);
        if (!rootType) continue;

        // The root's type must itself describe to a real SObject; otherwise it's a
        // user class / collection / primitive / not-yet-loaded → skip (no false flag).
        if (!(await desc(rootType))) continue;

        const base = hops.length ? await deps.resolveRelTarget(rootType, hops) : rootType;
        if (!base) continue; // a hop couldn't be resolved → stay silent

        const d = await desc(base);
        if (!d) continue; // describe missing → can't judge

        if (!memberExists(d, a.member)) {
            out.push({
                severity: DiagnosticSeverity.Warning,
                range: a.range,
                message: `'${a.member}' is not a field or relationship of ${base}.`,
                source: SCHEMA_DIAGNOSTIC_SOURCE,
            });
        }
    }
    return out;
}
