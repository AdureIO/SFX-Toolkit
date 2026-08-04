/**
 * Shared backend for type-aware inline editing of SOQL results — used by both the
 * SOQL Workbench and the workbench SOQL tab (one implementation, wired twice).
 *
 * Provides per-field metadata (type, editability, picklist values, lookup target,
 * the object's actual Name field) and a debounced lookup search, all from the
 * shared DescribeStore cache. The Name field is taken from the describe
 * (`nameField`), never hardcoded — Account→Name, Case→CaseNumber, etc.
 */
import { DescribeStore } from "./describeStore";
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { nameFieldOf, buildLookupSoql } from "./soqlEditPure";

export { nameFieldOf, buildLookupSoql } from "./soqlEditPure";

export interface FieldMeta {
	type: string; // string|boolean|int|double|currency|percent|date|datetime|picklist|multipicklist|reference|...
	updateable: boolean;
	picklistValues?: string[];
	referenceTo?: string[]; // for reference (lookup) fields
}

/** Per-field editing metadata for an object, keyed by lowercased field API name. */
export async function fieldMetaFor(org: string | null, sobject: string): Promise<Record<string, FieldMeta>> {
	const raw = await DescribeStore.getRaw(org, sobject);
	if (!raw) return {};
	const out: Record<string, FieldMeta> = {};
	for (const f of raw.fields ?? []) {
		out[String(f.name).toLowerCase()] = {
			type: f.type || "string",
			updateable: !!f.updateable && !f.calculated,
			picklistValues: Array.isArray(f.picklistValues)
				? f.picklistValues.filter((p: any) => p && p.active !== false && p.value).map((p: any) => p.value as string)
				: undefined,
			referenceTo: Array.isArray(f.referenceTo) && f.referenceTo.length ? (f.referenceTo as string[]) : undefined,
		};
	}
	return out;
}

export interface LookupHit { id: string; name: string }

/** Search a referenced object by its Name field (debounce on the caller side). */
export async function lookupSearch(org: string | null, refObject: string, query: string, limit = 15): Promise<LookupHit[]> {
	const version = getToolingApiVersion();
	const raw = await DescribeStore.getRaw(org, refObject);
	const nameField = nameFieldOf(raw);
	const soql = buildLookupSoql(refObject, nameField, query, limit);
	try {
		const { body } = await AuthInfo.get(org, (a) =>
			`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/query?q=${encodeURIComponent(soql)}`
		);
		const records: any[] = JSON.parse(body).records ?? [];
		return records.map((r) => ({ id: r.Id as string, name: (r[nameField] as string) ?? r.Id }));
	} catch (e: any) {
		outputChannel.appendLine(`soqlEdit: lookupSearch ${refObject} failed: ${e?.message ?? e}`);
		return [];
	}
}

/** Resolve the Name (real name field) of lookup/MD records by Id, for display. */
export async function resolveNames(org: string | null, refObject: string, ids: string[]): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const unique = Array.from(new Set((ids || []).filter(Boolean)));
	if (!unique.length) return out;
	const version = getToolingApiVersion();
	const raw = await DescribeStore.getRaw(org, refObject);
	const nameField = nameFieldOf(raw);
	for (let i = 0; i < unique.length; i += 200) {
		const chunk = unique.slice(i, i + 200);
		const inList = chunk.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
		const soql = `SELECT Id, ${nameField} FROM ${refObject} WHERE Id IN (${inList})`;
		try {
			const { body } = await AuthInfo.get(org, (a) =>
				`${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/query?q=${encodeURIComponent(soql)}`
			);
			for (const r of (JSON.parse(body).records ?? []) as any[]) {
				if (r.Id) out[r.Id] = (r[nameField] as string) ?? r.Id;
			}
		} catch (e: any) {
			outputChannel.appendLine(`soqlEdit: resolveNames ${refObject} failed: ${e?.message ?? e}`);
		}
	}
	return out;
}

export interface RecordChange { id: string; sobjectType: string; fields: Record<string, unknown> }

/** Apply field updates to records via the REST API. Returns per-record errors. */
export async function saveRecords(org: string | null, changes: RecordChange[]): Promise<{ id: string; error?: string }[]> {
	const version = getToolingApiVersion();
	const results: { id: string; error?: string }[] = [];
	for (const ch of changes) {
		try {
			await AuthInfo.post(
				org,
				(a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/${ch.sobjectType}/${ch.id}?_HttpMethod=PATCH`,
				ch.fields
			);
			results.push({ id: ch.id });
		} catch (e: any) {
			let msg = e?.message ?? String(e);
			const m = /HTTP \d+: (.+)$/s.exec(msg);
			if (m) { try { const j = JSON.parse(m[1]); msg = Array.isArray(j) ? j.map((x) => x.message).join("; ") : (j.message || m[1]); } catch { msg = m[1]; } }
			results.push({ id: ch.id, error: msg });
		}
	}
	return results;
}
