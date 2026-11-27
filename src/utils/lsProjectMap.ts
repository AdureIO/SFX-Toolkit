/**
 * The project map the host sends the language server (`asfx/projects`). The server's symbol
 * index is partitioned by the project's DEFAULT ORG, so every project goes out with the
 * partition key it belongs to:
 *
 *   - `org:<username>` when its default org resolves (projects sharing an org share a partition),
 *   - `dir:<projectDir>` when it has no resolvable default org (its own partition).
 *
 * Pure (everything injected) so it is unit-testable without VS Code. Wiring lives in languageClient.ts.
 */
import * as fs from "fs";
import * as path from "path";

export const NOTE_PROJECTS = "asfx/projects";
const DEFAULT_KEY = "__default__";

export interface LsProjectEntry {
	dir: string;
	partition: string;
	namespace: string | null;
	name?: string;
}

export interface LsProjectMap {
	projects: LsProjectEntry[];
	activeDir: string | null;
	/** Pinned document partitions (workbench buffers): uri → partition. */
	buffers: Record<string, string>;
}

export interface ProjectMapInputs {
	/** Registered projects (MP1 registry). */
	projects: { dir: string; kind: "sfdx" | "mdapi"; name: string }[];
	activeDir?: string;
	/** Extra SFDX project dirs the host knows (nested deeper than discovery looks), e.g. from open documents. */
	extraDirs?: string[];
	/** The canonical org key (username, or `__default__`) of a project's default org. */
	orgKeyOf: (projectDir: string) => string;
	/** `sfdx-project.json` namespace of a project dir (null = none). */
	namespaceOf?: (projectDir: string) => string | null;
	/** Ephemeral (workbench) buffers: document URI + its explicit org override (canonical key), if any. */
	buffers?: { uri: string; overrideOrgKey?: string | null }[];
}

export function partitionKey(orgKey: string, dir: string): string {
	return !orgKey || orgKey === DEFAULT_KEY ? `dir:${dir}` : `org:${orgKey}`;
}

/** Read the namespace from a project's sfdx-project.json (null when absent / unreadable). */
export function readProjectNamespace(projectDir: string): string | null {
	try {
		const ns = JSON.parse(fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8")).namespace;
		return typeof ns === "string" && ns.trim() ? ns.trim() : null;
	} catch {
		return null;
	}
}

export function buildProjectMap(i: ProjectMapInputs): LsProjectMap {
	const byDir = new Map<string, LsProjectEntry>();
	const add = (dir: string, kind: "sfdx" | "mdapi", name?: string) => {
		if (byDir.has(dir)) return;
		byDir.set(dir, {
			dir,
			partition: partitionKey(i.orgKeyOf(dir), dir),
			namespace: kind === "sfdx" ? (i.namespaceOf ?? readProjectNamespace)(dir) : null,
			name: name ?? path.basename(dir),
		});
	};
	for (const p of i.projects) add(p.dir, p.kind, p.name);
	for (const d of i.extraDirs ?? []) add(d, "sfdx");

	// A workbench buffer pins to its explicit org override; without one it follows the active project.
	const active = i.activeDir ? byDir.get(i.activeDir) : undefined;
	const buffers: Record<string, string> = {};
	for (const b of i.buffers ?? []) {
		if (b.overrideOrgKey && b.overrideOrgKey !== DEFAULT_KEY) buffers[b.uri] = `org:${b.overrideOrgKey}`;
		else if (active) buffers[b.uri] = active.partition;
	}
	return { projects: [...byDir.values()], activeDir: i.activeDir ?? null, buffers };
}
