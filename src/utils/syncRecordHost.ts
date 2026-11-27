/**
 * Writes the sync record (see `syncRecordPure`) right after a successful deploy or retrieve: hashes the local
 * files of the components just operated on, the same way the content compare hashes them. Called from every
 * entry point (the Deploy & Retrieve panel, the right-click commands, the retrieve engine). No `vscode`; never
 * throws (a missing record only means the cheap layers cannot decide that component).
 */
import * as fs from "fs";
import * as path from "path";
import { digestContent, hashDigests, innerFilesOfEntry, lookupKeyOf } from "./contentComparePure";
import { LocalEntry, buildTypeTable, readPackageDirectories, scanProject } from "./orgBrowser/localIndex";
import { TypeInfo } from "./orgBrowser/types";
import { SyncItem, recordSync } from "./retrieveLog";
import { SyncKind, metaHashOf } from "./syncRecordPure";

export interface RecordSyncOptions {
	/** The org (`--target-org` form; null = the default org). */
	org: string | null;
	projectDir: string;
	kind: SyncKind;
	/** The components the operation succeeded for. `lm`: the org's lastModifiedDate afterwards, when known (else pending until the next listing). */
	refs: { type: string; fullName: string; lm?: number }[];
	/** The org's metadata types (file mapping); the built-in table when omitted. */
	types?: readonly TypeInfo[];
	/** The project's local index when the caller has a current one (saves the scan). */
	entries?: Iterable<LocalEntry>;
	/** When the operation completed (default now). */
	at?: Date;
}

/** Hash the local files of `refs` and record them. Returns how many components were recorded. */
export async function recordSyncAfter(o: RecordSyncOptions): Promise<number> {
	if (o.refs.length === 0) return 0;
	try {
		const dirs = readPackageDirectories(o.projectDir);
		const pkgs = (dirs.length > 0 ? dirs : ["force-app"]).map((d) => path.resolve(o.projectDir, d));
		const table = buildTypeTable([...(o.types ?? [])]);
		const entries = o.entries ?? (await scanProject(o.projectDir, dirs.length > 0 ? dirs : ["force-app"], table)).entries.values();
		const wanted = new Map<string, { type: string; fullName: string; lm?: number }>();
		for (const r of o.refs) wanted.set(lookupKeyOf(r.type, r.fullName), r);
		const items: SyncItem[] = [];
		for (const e of entries) {
			const r = wanted.get(lookupKeyOf(e.type, e.name));
			if (!r) continue;
			const digests = new Map<string, string>();
			for (const f of innerFilesOfEntry(e, pkgs, table)) {
				try {
					digests.set(f.inner, digestContent(await fs.promises.readFile(f.abs)));
				} catch {
					/* gone meanwhile */
				}
			}
			if (digests.size === 0) continue;
			items.push({ type: r.type, fullName: r.fullName, hash: hashDigests(digests), meta: metaHashOf(digests), ...(r.lm !== undefined ? { lm: r.lm } : {}) });
		}
		recordSync(o.org, items, o.kind, o.at);
		return items.length;
	} catch {
		return 0;
	}
}
