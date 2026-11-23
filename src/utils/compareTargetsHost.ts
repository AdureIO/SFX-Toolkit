/**
 * Compare targets of a panel that lists the org (Org Browser, Deploy & Retrieve Center): the local components
 * that exist in the org listing, ready for the content compare service, and the result maps the service keys by
 * the local index key.
 */
import * as path from "path";
import { CompareTarget } from "./contentCompare";
import { innerFilesOfEntry } from "./contentComparePure";
import { orgLookupKey } from "./deployStatusPure";
import { LocalEntry, buildTypeTable, readPackageDirectories } from "./orgBrowser/localIndex";
import { Comp, TypeInfo } from "./orgBrowser/types";

/**
 * Local entries that are in the listing as targets. `entries`: the local components to consider (all, or the
 * ones of some rows); `orgListing` is looked up by the key the org lists them under (`orgLookupKey`).
 */
export function compareTargetsFor(projectDir: string, types: TypeInfo[], entries: Iterable<LocalEntry>, orgListing: ReadonlyMap<string, Comp>): CompareTarget[] {
	const dirs = readPackageDirectories(projectDir);
	const pkgAbs = (dirs.length > 0 ? dirs : ["force-app"]).map((d) => path.resolve(projectDir, d));
	const table = buildTypeTable(types);
	const out: CompareTarget[] = [];
	for (const e of entries) {
		const c = orgListing.get(orgLookupKey(e.type, e.name));
		if (!c) continue;
		out.push({ key: e.key, type: e.type, name: e.name, orgLm: c.lm, files: innerFilesOfEntry(e, pkgAbs, table) });
	}
	return out;
}

/** The component's local files with their inner paths (what the diff opener takes). */
export function localFilesOf(projectDir: string, types: TypeInfo[], entry: LocalEntry): { inner: string; abs: string }[] {
	const dirs = readPackageDirectories(projectDir);
	const pkgAbs = (dirs.length > 0 ? dirs : ["force-app"]).map((d) => path.resolve(projectDir, d));
	return innerFilesOfEntry(entry, pkgAbs, buildTypeTable(types));
}
