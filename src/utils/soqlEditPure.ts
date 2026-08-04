/**
 * Pure helpers for SOQL inline editing (no vscode/network imports) so they can be
 * unit-tested standalone. Re-exported by soqlEdit.ts.
 */

/** The object's display Name field per the describe (`nameField`), else "Name". */
export function nameFieldOf(rawDescribe: any): string {
	const f = (rawDescribe?.fields ?? []).find((x: any) => x.nameField);
	return f ? f.name : "Name";
}

/** Escape a value for a SOQL string literal. */
export function soqlEscape(s: string): string {
	return s.replace(/[\\'%_]/g, (m) => "\\" + m);
}

/** Build the lookup-search query. */
export function buildLookupSoql(refObject: string, nameField: string, query: string, limit: number): string {
	return (
		`SELECT Id, ${nameField} FROM ${refObject} ` +
		`WHERE ${nameField} LIKE '%${soqlEscape(query)}%' ORDER BY ${nameField} LIMIT ${Math.max(1, Math.min(50, limit))}`
	);
}
