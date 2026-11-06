/**
 * Host side of the shared results-table component: answers its three messages
 * (column metadata, lookup search, save) using the soqlEdit backend. Both SOQL
 * surfaces call this from their webview message handler.
 */
import * as vscode from "vscode";
import { fieldMetaFor, objectMetaFor, lookupSearch, resolveNames, saveRecords, deleteRecords, type FieldMeta, type RecordChange } from "./soqlEdit";
import { confirmProductionOrgOperation } from "./orgSafety";
import { Telemetry } from "./telemetry";

type Post = (msg: Record<string, unknown>) => void;

/** Saves touching this many records (typically a bulk "set field") ask for confirmation first. */
const BULK_CONFIRM_AT = 10;

/** Handle an `rt:*` message. Returns true if it was one of ours. */
export async function handleResultsTableMessage(msg: any, post: Post): Promise<boolean> {
	if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("rt:")) return false;
	const org = (typeof msg.org === "string" && msg.org) ? msg.org : null;

	if (msg.type === "rt:colMeta") {
		const meta: Record<string, Record<string, FieldMeta>> = {};
		const objMeta: Record<string, { deletable: boolean; updateable: boolean }> = {};
		for (const t of (msg.sobjects as string[]) ?? []) {
			meta[t] = await fieldMetaFor(org, t);
			objMeta[t] = await objectMetaFor(org, t);
		}
		post({ type: "rt:colMeta", meta, objMeta });
		return true;
	}
	if (msg.type === "rt:lookup") {
		post({ type: "rt:lookupResult", requestId: msg.requestId, hits: await lookupSearch(org, msg.refObject, msg.query || "") });
		return true;
	}
	if (msg.type === "rt:resolveNames") {
		post({ type: "rt:names", refObject: msg.refObject, names: await resolveNames(org, msg.refObject, (msg.ids as string[]) ?? []) });
		return true;
	}
	if (msg.type === "rt:save") {
		const changes = (msg.changes as RecordChange[]) ?? [];
		Telemetry.event("recordsSave", undefined, { count: changes.length });
		// A bulk "set field" can touch hundreds of rows — confirm larger saves (incl. the production check).
		const records = new Set(changes.map((c) => c.id)).size;
		if (records >= BULK_CONFIRM_AT && !(await confirmRecords(`Save changes to ${records} records`, org))) {
			post({ type: "rt:saveDone", results: [], cancelled: true });
			return true;
		}
		post({ type: "rt:saveDone", results: await saveRecords(org, changes) });
		return true;
	}
	if (msg.type === "rt:delete") {
		const ids = ((msg.ids as string[]) ?? []).filter((x) => typeof x === "string");
		const label = `${ids.length} ${msg.sobjectType || "record"}${ids.length === 1 ? "" : "s"}`;
		if (!ids.length || !(await confirmRecords(`Delete ${label}`, org, "Delete"))) {
			post({ type: "rt:deleteDone", results: [], cancelled: true });
			return true;
		}
		Telemetry.event("recordsDelete", undefined, { count: ids.length });
		const results = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Deleting ${label}…` },
			() => deleteRecords(org, ids)
		);
		const failed = results.filter((r) => r.error).length;
		if (failed) vscode.window.showWarningMessage(`Deleted ${results.length - failed} of ${ids.length}; ${failed} failed (see the results table).`);
		else vscode.window.showInformationMessage(`Deleted ${label}.`);
		post({ type: "rt:deleteDone", results });
		return true;
	}
	return false;
}

/** Modal confirmation for bulk record operations; production orgs get the standard extra warning. */
async function confirmRecords(action: string, org: string | null, button = "Continue"): Promise<boolean> {
	if (!(await confirmProductionOrgOperation(action.charAt(0).toLowerCase() + action.slice(1) + " in", org))) return false;
	const pick = await vscode.window.showWarningMessage(`${action}${org ? ` in ${org}` : " in the default org"}?`, { modal: true }, button);
	return pick === button;
}
