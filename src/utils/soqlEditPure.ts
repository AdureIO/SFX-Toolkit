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

export interface RecordResult { id: string; error?: string }

/** sObject Collections take at most 200 records per request. */
export const COLLECTION_BATCH = 200;

/** Error text for a not-attempted id after the user cancelled a bulk delete. */
export const CANCELLED_DELETE_MSG = "Cancelled — not deleted.";

/** Readable text from a thrown error; unwraps `HTTP <status>: <json body>` to the API's own message. */
export function errorText(e: any): string {
	let msg = e?.message ?? String(e);
	const m = /HTTP \d+: (.+)$/s.exec(msg);
	if (m) { try { const j = JSON.parse(m[1]); msg = Array.isArray(j) ? j.map((x) => x.message).join("; ") : (j.message || m[1]); } catch { msg = m[1]; } }
	return msg;
}

/**
 * Map a Collections response (array of {id, success, errors}) back onto the requested ids, in order.
 * With `deleting`, ENTITY_IS_DELETED counts as success: a retried delete whose first attempt actually
 * went through reports the record as already deleted.
 */
export function collectionResults(ids: string[], body: string, deleting = false): RecordResult[] {
	let rows: any[] = [];
	try { rows = JSON.parse(body); } catch { /* fall through: treat as all ok */ }
	return ids.map((id, i) => {
		const r = Array.isArray(rows) ? rows[i] : undefined;
		if (!r || r.success !== false) return { id };
		const errs: any[] = r.errors ?? [];
		if (deleting && errs.length && errs.every((x) => x?.statusCode === "ENTITY_IS_DELETED")) return { id };
		const err = errs.map((x: any) => (x.fields?.length ? `${x.message} (${x.fields.join(", ")})` : x.message)).join("; ");
		return { id, error: err || "Failed." };
	});
}

export interface DeleteOptions {
	/** Called after each batch (and once up front) with ids processed so far and the total. */
	onProgress?: (done: number, total: number) => void;
	/** Checked before each batch; when true the remaining ids are returned as cancelled. */
	isCancelled?: () => boolean;
}

/**
 * Delete ids in sequential batches via `deleteBatch` (returns the Collections response body).
 * A batch that throws (after the HTTP layer's own retry) marks only its ids failed and the
 * next batches still run. Invalid ids fail up front; cancellation stops after the current batch.
 */
export async function deleteInBatches(
	ids: string[],
	deleteBatch: (batch: string[]) => Promise<string>,
	opts: DeleteOptions = {}
): Promise<RecordResult[]> {
	const valid = ids.filter((id) => /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(id));
	const results: RecordResult[] = ids.filter((id) => !valid.includes(id)).map((id) => ({ id, error: "Invalid record id." }));
	let done = results.length;
	opts.onProgress?.(done, ids.length);
	for (let i = 0; i < valid.length; i += COLLECTION_BATCH) {
		if (opts.isCancelled?.()) {
			results.push(...valid.slice(i).map((id) => ({ id, error: CANCELLED_DELETE_MSG })));
			break;
		}
		const batch = valid.slice(i, i + COLLECTION_BATCH);
		try {
			results.push(...collectionResults(batch, await deleteBatch(batch), true));
		} catch (e: any) {
			const msg = errorText(e);
			results.push(...batch.map((id) => ({ id, error: msg })));
		}
		done += batch.length;
		opts.onProgress?.(done, ids.length);
	}
	return results;
}
