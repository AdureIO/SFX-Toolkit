/**
 * Completion-item builders and sort/namespace helpers shared by SOQL and Apex completion.
 */
import { CompletionItem, CompletionItemKind, MarkupKind } from 'vscode-languageserver/node';
import type { HostDescribe, HostField } from './schema';

// Provenance footers shown in each item's documentation popup. The visible
// label slots (labelDetails.detail/description) carry type/owner info instead.
const ASFX_SCHEMA_FOOTER = '_— ASFX Toolkit · org schema_';
const ASFX_PLAIN_FOOTER = '_— ASFX Toolkit_';

export function md(value: string): { kind: typeof MarkupKind.Markdown; value: string } {
    return { kind: MarkupKind.Markdown, value };
}

/** Attach a schema-item documentation popup (body lines + provenance footer). */
export function withSchemaDoc(item: CompletionItem, body: string[]): CompletionItem {
    item.documentation = md([...body, ASFX_SCHEMA_FOOTER].join('\n\n'));
    return item;
}

/**
 * Ensure every returned item carries ASFX provenance in its documentation popup,
 * without consuming the visible label slots. Items we built already have a richer
 * schema doc; pass-through items (SOQL keywords) get a plain footer.
 */
export function sfxTag(items: CompletionItem[]): CompletionItem[] {
    for (const i of items) {
        if (!i.documentation) i.documentation = md(ASFX_PLAIN_FOOTER);
    }
    return items;
}

/**
 * In a namespaced project, the org returns API names with the namespace prefix
 * (`ns__Widget__c`) but it's optional to type. Set filterText to the
 * unprefixed name so typing `Prod` matches; label/insertText keep the namespace.
 */
export function applyNamespace(items: CompletionItem[], ns: string | null): CompletionItem[] {
    if (!ns) return items;
    const prefix = ns.toLowerCase() + '__';
    for (const i of items) {
        if (typeof i.label === 'string' && i.label.toLowerCase().startsWith(prefix)) {
            i.filterText = i.label.slice(prefix.length);
        }
    }
    return items;
}

// Standard audit/system fields are rarely the ones you want first.
const AUDIT_FIELDS = new Set([
    'createdbyid', 'createddate', 'lastmodifiedbyid', 'lastmodifieddate', 'systemmodstamp',
    'isdeleted', 'lastvieweddate', 'lastreferenceddate', 'lastactivitydate',
]);

/** Field sort tier (lower = higher): 0 business field, 2 audit/system field. */
export function fieldSortTier(name: string): string {
    return AUDIT_FIELDS.has(name.toLowerCase()) ? '2' : '0';
}

export function fieldItem(owner: string, f: HostField): CompletionItem {
    const sizeSuffix = f.length ? ` (${f.length})` : '';
    const item: CompletionItem = {
        label: f.name,
        kind: CompletionItemKind.Field,
        labelDetails: { detail: ` : ${f.type}`, description: owner },
        sortText: fieldSortTier(f.name) + '_' + f.name,
    };
    const body = ['```apex\n' + `${owner}.${f.name} : ${f.type}${sizeSuffix}` + '\n```'];
    if (f.label && f.label !== f.name) body.push(`**${f.label}**`);
    if (f.helpText) body.push(f.helpText);
    if (f.picklistValues && f.picklistValues.length) {
        const shown = f.picklistValues.slice(0, 12).join(', ');
        const more = f.picklistValues.length > 12 ? `, … (+${f.picklistValues.length - 12})` : '';
        body.push(`_Values:_ ${shown}${more}`);
    }
    if (f.nillable === false) body.push('_Required_');
    return withSchemaDoc(item, body);
}

/**
 * Sort tier for an SObject in completion (lower = higher in the list):
 *  0 = business objects (standard + custom `__c`),
 *  1 = metadata/platform-event/big/external objects (`__mdt`/`__e`/`__b`/`__x`),
 *  2 = auxiliary system objects (History / Share / Feed / ChangeEvent / Tag).
 * These are infrequently queried, so they sort below the rest.
 */
export function objectSortTier(name: string): string {
    const n = name.toLowerCase();
    if (/(?:__)?(?:history|share|feed|changeevent|tag)$/.test(n)) return '2';
    if (/__(?:mdt|e|b|x)$/.test(n)) return '1';
    return '0';
}

function passesFlags(f: HostField, c: any): boolean {
    if (!c) return true;
    if (c.onlySortable && f.sortable === false) return false;
    if (c.onlyAggregatable && f.aggregatable === false) return false;
    if (c.onlyGroupable && f.groupable === false) return false;
    if (c.onlyNillable && f.nillable === false) return false;
    if (Array.isArray(c.onlyTypes) && c.onlyTypes.length && !c.onlyTypes.includes(f.type)) return false;
    return true;
}

// A relationship-traversal item, e.g. `Account` / `Owner` that you can dot into.
export function relItem(owner: string, f: HostField): CompletionItem {
    // Lookups can be polymorphic (WhatId → Account | Opportunity | …); show every target,
    // and type it like a field so the details panel isn't blank for relationships.
    const targets = f.referenceTo && f.referenceTo.length ? f.referenceTo : [];
    const typeStr = targets.length ? targets.join(' | ') : '(relationship)';
    const item: CompletionItem = {
        label: f.relationshipName as string,
        kind: CompletionItemKind.Class,
        detail: `${typeStr} ${owner}.${f.relationshipName}`,
        // An arrow, not a colon: a relationship is a traversal to another object, not a value of
        // that type. Child relationships and the doc popup already read that way.
        labelDetails: { detail: ` → ${typeStr}`, description: owner },
        // Sort relationships just after their owning fields.
        sortText: '1_' + f.relationshipName,
    };
    return withSchemaDoc(item, [`\`${owner}.${f.relationshipName}\` → **${typeStr}**`]);
}

// Scalar fields (flag-filtered) plus, unless suppressed, relationship names to traverse.
export function fieldsAndRels(owner: string, d: HostDescribe, c: any): CompletionItem[] {
    const out = d.fields.filter((f) => passesFlags(f, c)).map((f) => fieldItem(owner, f));
    if (!c?.dontShowRelationshipField) {
        for (const f of d.fields) {
            if (f.relationshipName) out.push(relItem(owner, f));
        }
    }
    return out;
}
