/**
 * Shared retrieve engine: `sf project retrieve start --json` for a set of components and/or
 * source paths, with command-line chunking, per-component results, schema-cache invalidation and
 * the last-retrieve log. Used by the Org Browser and the right-click retrieve.
 */
import type * as vscode from "vscode";
import { runCommandArgs } from "./commandRunner";
import { Logger } from "./outputChannel";
import { OrgMetadataCache } from "./orgMetadataCache";
import { schemaObjectFromPath } from "./deployStatusMap";
import { recordRetrieved } from "./retrieveLog";
import {
	chunkComponents,
	chunkPaths,
	cliErrorMessage,
	parseCliJson,
	parseRetrieveJson,
	type ComponentRef,
	type FailedComponent,
	type RetrievedComponent,
} from "./retrieveEnginePure";

export { chunkComponents, parseRetrieveJson } from "./retrieveEnginePure";

export interface RetrieveOptions {
	/** `--target-org` value (alias or username); null = the CLI default org. */
	org: string | null;
	components?: { type: string; fullName: string }[];
	sourcePaths?: string[];
	/** Working directory: the SFDX project root. */
	projectDir: string;
	token?: vscode.CancellationToken;
	/** Called after each command-line chunk with how many components/paths are done. */
	onProgress?: (done: number, total: number) => void;
}

export interface RetrieveResult {
	retrieved: { type: string; fullName: string; filePath: string }[];
	failed: { type: string; fullName: string; error: string }[];
}

/** One `sf` run; resolves with the CLI's stdout even when it exits non-zero (partial failures). */
async function runOnce(args: string[], opts: RetrieveOptions): Promise<{ stdout: string; error?: string }> {
	try {
		const stdout = await runCommandArgs("sf", args, opts.projectDir, undefined, false, undefined, opts.token);
		return { stdout };
	} catch (e: any) {
		if (e?.cancelled) throw e;
		const stdout = typeof e?.stdout === "string" ? e.stdout : "";
		const parsed = parseCliJson(stdout);
		return { stdout, error: cliErrorMessage(parsed, String(e?.message ?? e)) };
	}
}

function baseArgs(org: string | null): string[] {
	const args = ["project", "retrieve", "start", "--json"];
	if (org) args.push("--target-org", org);
	return args;
}

/** Refresh describe caches for retrieved object / field files, like `retrieveCurrentFile` does. */
function invalidateSchemaCaches(org: string | null, filePaths: string[]): void {
	const objects = new Set<string>();
	let structural = false;
	for (const fp of filePaths) {
		const s = schemaObjectFromPath(fp);
		if (!s) continue;
		objects.add(s.object);
		if (s.structural) structural = true;
	}
	if (objects.size === 0) return;
	OrgMetadataCache.invalidateSObjects(org, [...objects], structural);
	if (structural) OrgMetadataCache.warmOrg(org);
}

/**
 * Retrieve components (`-m Type:Name`) and/or source paths (`-d <path>`) into the project.
 * Never throws for a component-level failure (it lands in `failed`); throws only on cancellation
 * (`error.cancelled === true`). Components retrieved before a cancel are still logged.
 */
export async function retrieveComponents(opts: RetrieveOptions): Promise<RetrieveResult> {
	const retrieved: RetrievedComponent[] = [];
	const failed: FailedComponent[] = [];
	const components = opts.components ?? [];
	const sourcePaths = opts.sourcePaths ?? [];
	const total = components.length + sourcePaths.length;
	let done = 0;

	const finish = () => {
		if (retrieved.length > 0) {
			recordRetrieved(opts.org, retrieved);
			invalidateSchemaCaches(opts.org, retrieved.map((r) => r.filePath));
		}
	};

	try {
		for (const chunk of chunkComponents(components)) {
			const args = baseArgs(opts.org);
			for (const c of chunk) args.push("-m", `${c.type}:${c.fullName}`);
			const { stdout, error } = await runOnce(args, opts);
			const outcome = parseRetrieveJson(stdout, chunk);
			if (outcome) {
				retrieved.push(...outcome.retrieved);
				failed.push(...outcome.failed);
			} else {
				const msg = error ?? "Retrieve returned no result.";
				Logger.error("Retrieve failed", msg);
				for (const c of chunk) failed.push({ type: c.type, fullName: c.fullName, error: msg });
			}
			done += chunk.length;
			opts.onProgress?.(done, total);
		}

		for (const chunk of chunkPaths(sourcePaths)) {
			const args = baseArgs(opts.org);
			for (const p of chunk) args.push("-d", p);
			const { stdout, error } = await runOnce(args, opts);
			const outcome = parseRetrieveJson(stdout);
			if (outcome) {
				retrieved.push(...outcome.retrieved);
				failed.push(...outcome.failed);
			} else {
				const msg = error ?? "Retrieve returned no result.";
				Logger.error("Retrieve failed", msg);
				for (const p of chunk) failed.push({ type: "Path", fullName: p, error: msg });
			}
			done += chunk.length;
			opts.onProgress?.(done, total);
		}
	} finally {
		finish();
	}
	return { retrieved, failed };
}

export type { ComponentRef };
