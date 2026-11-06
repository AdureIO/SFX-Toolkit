/**
 * Pure helpers for LWC `@salesforce/*` import completion (vscode-free, unit-tested in
 * src/test/lwcImportItems.test.ts): parsing the import being typed and building the
 * exact text each kind of module specifier needs.
 */

export interface SalesforceImportContext {
	/** apex | label | resourceUrl | messageChannel | schema | … */
	kind: string;
	/** Everything typed after `@salesforce/<kind>/` up to the cursor. */
	partial: string;
}

/** The `@salesforce/<kind>/<partial>` import specifier ending at the cursor, if any. */
export function parseSalesforceImport(lineBeforeCursor: string): SalesforceImportContext | null {
	const m = /@salesforce\/(\w+)\/([\w.]*)$/.exec(lineBeforeCursor);
	return m ? { kind: m[1], partial: m[2] } : null;
}

/**
 * Custom label: the module is `@salesforce/label/c.<Name>` (or `<ns>.<Name>`). The item
 * replaces the whole partial so picking right after `label/` yields `c.MyLabel`, not
 * `MyLabel`, and picking after `label/c.` doesn't double the prefix.
 */
export function labelInsert(name: string, partial: string): { insertText: string; filterText: string; replaceLength: number } {
	const insertText = `c.${name}`;
	// Filter against what's typed: with `c.` typed match the full text, otherwise the bare name.
	const filterText = /^c\./i.test(partial) || partial.toLowerCase() === "c" ? insertText : name;
	return { insertText, filterText, replaceLength: partial.length };
}

/** Lightning message channel modules carry the `__c` suffix: `@salesforce/messageChannel/Foo__c`. */
export function messageChannelInsert(name: string): string {
	return /__c$/i.test(name) ? name : `${name}__c`;
}

/** File base name for a message-channel module reference (`Foo__c` → `Foo`). */
export function messageChannelFileBase(ref: string): string {
	return ref.replace(/__c$/i, "");
}

export interface SchemaPath {
	/** Object API name, when a `.` was typed after it. */
	object?: string;
	/** Relationship hops between the object and the field being typed. */
	relationships: string[];
	/** The (possibly empty) segment being typed. */
	prefix: string;
}

/** `Account` → object list; `Account.Na` → fields of Account; `Account.Owner.Na` → fields of Owner's target. */
export function parseSchemaPath(partial: string): SchemaPath {
	const parts = partial.split(".");
	const prefix = parts.pop() ?? "";
	if (!parts.length) return { relationships: [], prefix };
	return { object: parts[0], relationships: parts.slice(1), prefix };
}

export interface SchemaFieldLike {
	name: string;
	type?: string;
	label?: string;
	relationshipName?: string;
	referenceTo?: string[];
}

export interface SchemaEntry {
	name: string;
	isRelationship: boolean;
	detail: string;
	/** Relationship target object (first of a polymorphic list). */
	target?: string;
}

/** Fields of a describe plus their parent relationships (for spanning `Account.Owner.Name`). */
export function schemaEntries(fields: SchemaFieldLike[]): SchemaEntry[] {
	const out: SchemaEntry[] = [];
	const seen = new Set<string>();
	for (const f of fields) {
		if (!f?.name || seen.has(f.name.toLowerCase())) continue;
		seen.add(f.name.toLowerCase());
		out.push({ name: f.name, isRelationship: false, detail: `${f.label ? f.label + " · " : ""}${f.type ?? "field"}` });
	}
	for (const f of fields) {
		const rel = f?.relationshipName;
		if (!rel || seen.has(rel.toLowerCase())) continue;
		seen.add(rel.toLowerCase());
		const target = f.referenceTo?.[0];
		out.push({ name: rel, isRelationship: true, detail: `→ ${(f.referenceTo ?? []).join(" | ") || "relationship"}`, target });
	}
	return out;
}

/** Resolve a relationship hop on a describe's fields (case-insensitive) to its target object. */
export function relationshipTarget(fields: SchemaFieldLike[], rel: string): string | null {
	const r = rel.toLowerCase();
	const f = fields.find((x) => x.relationshipName?.toLowerCase() === r);
	return f?.referenceTo?.[0] ?? null;
}

/** Module names declared in a `.d.ts` (`declare module "…"`) — TypeScript already completes these. */
export function ambientModuleNames(dts: string): string[] {
	const out: string[] = [];
	for (const m of dts.matchAll(/declare\s+module\s+["']([^"'*]+)["']/g)) out.push(m[1]);
	return out;
}
