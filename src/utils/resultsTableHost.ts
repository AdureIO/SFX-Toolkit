/**
 * Host side of the shared results-table component: answers its three messages
 * (column metadata, lookup search, save) using the soqlEdit backend. Both SOQL
 * surfaces call this from their webview message handler.
 */
import { fieldMetaFor, lookupSearch, saveRecords, type FieldMeta, type RecordChange } from "./soqlEdit";

type Post = (msg: Record<string, unknown>) => void;

/** Handle an `rt:*` message. Returns true if it was one of ours. */
export async function handleResultsTableMessage(msg: any, post: Post): Promise<boolean> {
	if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("rt:")) return false;
	const org = (typeof msg.org === "string" && msg.org) ? msg.org : null;

	if (msg.type === "rt:colMeta") {
		const meta: Record<string, Record<string, FieldMeta>> = {};
		for (const t of (msg.sobjects as string[]) ?? []) meta[t] = await fieldMetaFor(org, t);
		post({ type: "rt:colMeta", meta });
		return true;
	}
	if (msg.type === "rt:lookup") {
		post({ type: "rt:lookupResult", requestId: msg.requestId, hits: await lookupSearch(org, msg.refObject, msg.query || "") });
		return true;
	}
	if (msg.type === "rt:save") {
		post({ type: "rt:saveDone", results: await saveRecords(org, (msg.changes as RecordChange[]) ?? []) });
		return true;
	}
	return false;
}
