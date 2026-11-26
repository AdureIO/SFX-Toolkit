/**
 * Wiring of the content compare service (extension host): one shared service per (project, org), the
 * `sf project retrieve` runner with its cancellation, and the `compare.verifyContents` setting.
 */
import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ContentCompareService, RetrieveReply, RetrieveRequest } from "./contentCompare";
import { retrieveComponents } from "./retrieveEngine";
import { TypeInfo } from "./orgBrowser/types";
import { buildTypeTable } from "./orgBrowser/localIndex";

let ctx: vscode.ExtensionContext | undefined;
let types: TypeInfo[] = [];

interface Shared {
	service: ContentCompareService;
	refs: number;
}
const shared = new Map<string, Shared>();

export function initContentCompare(context: vscode.ExtensionContext): void {
	ctx = context;
}

/** `adure-sfx-toolkit.compare.verifyContents`: `auto` starts a content compare once the org listing is available; the default `manual` waits for the Compare contents button. */
export function compareMode(): "auto" | "manual" {
	return vscode.workspace.getConfiguration("adure-sfx-toolkit").get<string>("compare.verifyContents", "manual") === "auto" ? "auto" : "manual";
}

async function retrieveCopy(orgArg: string | null, req: RetrieveRequest): Promise<RetrieveReply> {
	const res = await retrieveComponents({
		org: orgArg,
		components: req.components,
		projectDir: req.cwd,
		outputDir: req.outputDir,
		record: false,
		ignoreConflicts: true,
		token: req.token as unknown as vscode.CancellationToken,
	});
	return { retrieved: res.retrieved.map((r) => ({ type: r.type, fullName: r.fullName })), failed: res.failed };
}

export interface CompareLease {
	service: ContentCompareService;
	/** Tell the shared service which metadata types the org has (directory / suffix table of the file mapping). */
	setTypes(t: TypeInfo[]): void;
	/** Give the service back; the last one to do so stops it (cancels a running retrieve). */
	release(): void;
}

/** The shared service of (project, org) for a panel. Every acquire needs its release. */
export function acquireCompare(projectDir: string, orgKey: string, orgArg: string | null): CompareLease {
	if (!ctx) throw new Error("Content compare is not initialised");
	const id = `${projectDir}|${orgKey}`;
	let s = shared.get(id);
	if (!s) {
		const safeOrg = orgKey.replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 80);
		const hash = crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 12);
		const service = new ContentCompareService({
			cacheRoot: path.join(ctx.globalStorageUri.fsPath, "content-compare", safeOrg, hash),
			projectDir,
			retrieve: (req) => retrieveCopy(orgArg, req),
			table: () => buildTypeTable(types),
		});
		s = { service, refs: 0 };
		shared.set(id, s);
	}
	s.refs++;
	const mine = s;
	let released = false;
	return {
		service: mine.service,
		setTypes: (t) => {
			if (t.length > 0) types = t;
		},
		release: () => {
			if (released) return;
			released = true;
			if (--mine.refs <= 0) {
				shared.delete(id);
				void mine.service.dispose();
			}
		},
	};
}
