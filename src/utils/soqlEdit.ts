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
	/** Exact-case API name (the map is keyed lower-case). */
	name?: string;
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
			name: String(f.name),
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
export interface RecordResult { id: string; error?: string }

/** sObject Collections take at most 200 records per request. */
const COLLECTION_BATCH = 200;

function errorText(e: any): string {
	let msg = e?.message ?? String(e);
	const m = /HTTP \d+: (.+)$/s.exec(msg);
	if (m) { try { const j = JSON.parse(m[1]); msg = Array.isArray(j) ? j.map((x) => x.message).join("; ") : (j.message || m[1]); } catch { msg = m[1]; } }
	return msg;
}

/** Map a Collections response (array of {id, success, errors}) back onto the requested ids, in order. */
function collectionResults(ids: string[], body: string): RecordResult[] {
	let rows: any[] = [];
	try { rows = JSON.parse(body); } catch { /* fall through: treat as all ok */ }
	return ids.map((id, i) => {
		const r = Array.isArray(rows) ? rows[i] : undefined;
		if (!r || r.success !== false) return { id };
		const err = (r.errors ?? []).map((x: any) => (x.fields?.length ? `${x.message} (${x.fields.join(", ")})` : x.message)).join("; ");
		return { id, error: err || "Failed." };
	});
}

/**
 * Apply field updates via the sObject Collections API (allOrNone=false, 200 per request) —
 * one round-trip per 200 rows instead of one per record, so bulk edits stay fast.
 */
export async function saveRecords(org: string | null, changes: RecordChange[]): Promise<RecordResult[]> {
	const version = getToolingApiVersion();
	const results: RecordResult[] = [];
	for (let i = 0; i < changes.length; i += COLLECTION_BATCH) {
		const batch = changes.slice(i, i + COLLECTION_BATCH);
		const ids = batch.map((c) => c.id);
		try {
			const body = await AuthInfo.patch(
				org,
				(a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/composite/sobjects`,
				{ allOrNone: false, records: batch.map((c) => ({ attributes: { type: c.sobjectType }, id: c.id, ...c.fields })) }
			);
			results.push(...collectionResults(ids, body));
		} catch (e: any) {
			const msg = errorText(e);
			results.push(...ids.map((id) => ({ id, error: msg })));
		}
	}
	return results;
}

/** Delete records by id via the sObject Collections API (allOrNone=false, 200 per request). */
export async function deleteRecords(org: string | null, ids: string[]): Promise<RecordResult[]> {
	const version = getToolingApiVersion();
	const valid = ids.filter((id) => /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id));
	const results: RecordResult[] = ids.filter((id) => !valid.includes(id)).map((id) => ({ id, error: "Invalid record id." }));
	for (let i = 0; i < valid.length; i += COLLECTION_BATCH) {
		const batch = valid.slice(i, i + COLLECTION_BATCH);
		try {
			const body = await AuthInfo.deleteWithBody(
				org,
				(a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/composite/sobjects?allOrNone=false&ids=${batch.join(",")}`
			);
			results.push(...collectionResults(batch, body));
		} catch (e: any) {
			const msg = errorText(e);
			results.push(...batch.map((id) => ({ id, error: msg })));
		}
	}
	return results;
}

/** Object-level permissions for the bulk actions (from the cached describe). */
export async function objectMetaFor(org: string | null, sobject: string): Promise<{ deletable: boolean; updateable: boolean }> {
	const raw = await DescribeStore.getRaw(org, sobject);
	return { deletable: !!raw?.deletable, updateable: !!raw?.updateable };
}
