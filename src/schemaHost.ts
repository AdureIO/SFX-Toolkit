/**
 * Host side of the language server's schema bridge: answers `sfx/objectList`,
 * `sfx/describe`, `sfx/describeMany`, `sfx/objectInfo` and `sfx/projectInfo`. Split out
 * of languageClient.ts so it can be tested against the real server without a
 * LanguageClient.
 */
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
// The jsonrpc class that vscode-languageclient re-exports, loaded without pulling in the
// `vscode` module so this file stays testable under plain mocha.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ResponseError } = require("vscode-jsonrpc") as { ResponseError: typeof import("vscode-languageclient/node").ResponseError };
import { SoqlSchemaProvider } from "./utils/soqlSchemaProvider";
import { findSfdxProjectDir } from "./utils/projectUtils";
import { canonicalOrgKey, orgArgForKey } from "./utils/orgKey";
import { SchemaUnavailableError } from "./utils/describeStore";
import { getBufferOrgOverride } from "./utils/bufferOrgOverride";
import { outputChannel } from "./utils/outputChannel";

export const REQ_OBJECT_LIST = "sfx/objectList";
export const REQ_DESCRIBE = "sfx/describe";
export const REQ_DESCRIBE_MANY = "sfx/describeMany";
export const REQ_PROJECT_INFO = "sfx/projectInfo";
export const REQ_OBJECT_INFO = "sfx/objectInfo";

/** The slice of LanguageClient the handlers need. */
export interface RequestRegistrar {
	onRequest(method: string, handler: (params: any) => any): unknown;
}

export interface SchemaHost {
	orgForUri(uri?: string): string | null;
	clearProjectDirCache(): void;
}

export function registerSchemaHostHandlers(lc: RequestRegistrar): SchemaHost {
	// Resolve which org a request's document belongs to, as the CANONICAL org key
	// (username) — the same key the warm-up, push/pull invalidation and every host
	// cache use. Walks up to the nearest sfdx-project.json so nested sub-projects
	// (e.g. billing/force-app/...) use their own default org. Null = no org resolvable
	// (the CLI's global default).
	const projectDirCache = new Map<string, string | null>();
	const orgForUri = (uri?: string): string | null => {
		try {
			if (!uri) return orgArgForKey(canonicalOrgKey(null));
			const fsPath = vscode.Uri.parse(uri).fsPath;
			// A webview buffer (ASFX Workbench) may pin its IntelliSense to a chosen org.
			const ov = getBufferOrgOverride(fsPath);
			if (ov.has) return orgArgForKey(canonicalOrgKey(ov.org));
			const dir = path.dirname(fsPath);
			let projectDir = projectDirCache.get(dir);
			if (projectDir === undefined) {
				projectDir = findSfdxProjectDir(fsPath);
				if (projectDirCache.size > 2000) projectDirCache.clear();
				projectDirCache.set(dir, projectDir);
			}
			return orgArgForKey(canonicalOrgKey(null, projectDir ?? undefined));
		} catch {
			return null;
		}
	};

	/** Transient host failures reject the request (the server must not negative-cache them). */
	const unavailable = (e: unknown) =>
		new ResponseError(-32803 /* RequestFailed */, `schema unavailable: ${(e as any)?.message ?? e}`);

	// An object list the org could not deliver REJECTS (-32803) instead of answering `[]`: the
	// server caches a real answer, and an empty one would gate every SObject completion off.
	lc.onRequest(REQ_OBJECT_LIST, async (params: { uri?: string }) => {
		try {
			return await SoqlSchemaProvider.getObjectListStrict(orgForUri(params?.uri));
		} catch (e: any) {
			if (e instanceof SchemaUnavailableError) throw unavailable(e);
			outputChannel.appendLine(`languageClient: objectList failed: ${e?.message ?? e}`);
			throw unavailable(e);
		}
	});

	lc.onRequest(REQ_DESCRIBE, async (params: { uri?: string; sobject: string }) => {
		try {
			return await SoqlSchemaProvider.getDescribeStrict(orgForUri(params?.uri), params?.sobject);
		} catch (e: any) {
			if (e instanceof SchemaUnavailableError) throw unavailable(e);
			outputChannel.appendLine(`languageClient: describe failed: ${e?.message ?? e}`);
			return null;
		}
	});

	// Batched describes (contract 3): same Describe shape as REQ_DESCRIBE, same order as
	// `names`, null = not an SObject. Misses go out as REST composite/batch (<=25 each)
	// through the shared DescribeStore cache. Rejects when the org can't answer.
	lc.onRequest(REQ_DESCRIBE_MANY, async (params: { names?: string[]; uri?: string }) => {
		const names = Array.isArray(params?.names) ? params.names.slice(0, 500) : [];
		try {
			return await SoqlSchemaProvider.getDescribeMany(orgForUri(params?.uri), names, { strict: true });
		} catch (e: any) {
			if (e instanceof SchemaUnavailableError) throw unavailable(e);
			outputChannel.appendLine(`languageClient: describeMany failed: ${e?.message ?? e}`);
			return names.map(() => null);
		}
	});

	// Object-level admin Description (Tooling API; not in the standard describe).
	lc.onRequest(REQ_OBJECT_INFO, async (params: { uri?: string; sobject: string }) => {
		try {
			const description = await SoqlSchemaProvider.getObjectDescription(orgForUri(params?.uri), params?.sobject);
			return { description };
		} catch {
			return { description: null };
		}
	});

	// Project namespace (from sfdx-project.json) for the document's sub-project.
	// Lets the server match/resolve names with the namespace optional.
	const nsCache = new Map<string, string | null>();
	lc.onRequest(REQ_PROJECT_INFO, (params: { uri?: string }) => {
		try {
			if (!params?.uri) return { namespace: null };
			const fsPath = vscode.Uri.parse(params.uri).fsPath;
			const projectDir = findSfdxProjectDir(fsPath);
			if (!projectDir) return { namespace: null };
			if (nsCache.has(projectDir)) return { namespace: nsCache.get(projectDir) ?? null };
			let namespace: string | null = null;
			try {
				const raw = fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8");
				const ns = JSON.parse(raw).namespace;
				namespace = typeof ns === "string" && ns.trim() ? ns.trim() : null;
			} catch {
				namespace = null;
			}
			nsCache.set(projectDir, namespace);
			return { namespace };
		} catch {
			return { namespace: null };
		}
	});

	return { orgForUri, clearProjectDirCache: () => projectDirCache.clear() };
}
