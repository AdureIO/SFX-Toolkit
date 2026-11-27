/**
 * Diff of a component's local files against the org copy kept by the content compare service (Deploy &
 * Retrieve Center). The org side opens through a read-only content provider (`asfx-org-copy:`) over the copy
 * in globalStorage, so it cannot be edited or saved by accident.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { ContentCompareService } from "./contentCompare";
import type { CompareLease } from "./contentCompareHost";
import { digestContent } from "./contentComparePure";
import { PAIR_STATE_LABELS, DiffPair, DiffSide, diffTitle, planDiffPairs } from "./syncDiffPure";

export const ORG_COPY_SCHEME = "asfx-org-copy";

/** What the diff needs of a row (a `CompareTarget` fits). */
export interface DiffRow {
	/** Row key (either spelling of the name). */
	key: string;
	type: string;
	name: string;
	/** The component's local files; empty for an only-in-org row. */
	files: { inner: string; abs: string }[];
}

/** Roots the provider may read from: the org copy directories of the services it was used with. */
const allowedRoots = new Set<string>();
let registration: vscode.Disposable | undefined;

class OrgCopyProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri): string {
		const abs = path.resolve(uri.query);
		const ok = [...allowedRoots].some((r) => abs === r || abs.startsWith(r + path.sep));
		if (!ok) return "";
		try {
			return fs.readFileSync(abs, "utf8");
		} catch {
			return "";
		}
	}
}

function ensureProvider(): void {
	if (!registration) registration = vscode.workspace.registerTextDocumentContentProvider(ORG_COPY_SCHEME, new OrgCopyProvider());
}

/** Register the read-only provider (call once on activation; `openComponentDiff` also does it lazily). */
export function initSyncDiff(context: vscode.ExtensionContext): void {
	ensureProvider();
	context.subscriptions.push({
		dispose: () => {
			registration?.dispose();
			registration = undefined;
		},
	});
}

/** The read-only URI of an org copy file. The path part carries the inner path so the editor picks the language. */
export function orgCopyUri(row: Pick<DiffRow, "name">, inner: string, abs: string): vscode.Uri {
	return vscode.Uri.from({ scheme: ORG_COPY_SCHEME, path: `/${row.name.replace(/[\\/:*?"<>|]+/g, "_")}/${inner}`, query: abs });
}

async function digestsOf(files: ReadonlyMap<string, string>): Promise<Map<string, DiffSide>> {
	const out = new Map<string, DiffSide>();
	for (const [inner, abs] of files) {
		try {
			out.set(inner, { abs, digest: digestContent(await fs.promises.readFile(abs)) });
		} catch {
			/* vanished meanwhile */
		}
	}
	return out;
}

async function emptyDoc(): Promise<vscode.Uri> {
	return (await vscode.workspace.openTextDocument({ content: "" })).uri;
}

async function openPair(row: DiffRow, p: DiffPair, single: boolean): Promise<void> {
	const left = p.org ? orgCopyUri(row, p.inner, p.org) : await emptyDoc();
	const right = p.local ? vscode.Uri.file(p.local) : await emptyDoc();
	await vscode.commands.executeCommand("vscode.diff", left, right, diffTitle(row.name, single ? undefined : p.inner));
}

/**
 * Open the diff of a component: org copy (left, read-only) against the local file (right).
 * The copy kept by the last compare is used; without one it is retrieved on demand (`fetchOrgCopy`).
 * One file pair opens at once; several files show a quick pick (differing ones first). A file present on only
 * one side is diffed against an empty document.
 */
export async function openComponentDiff(source: ContentCompareService | Pick<CompareLease, "service">, row: DiffRow, projectDir: string): Promise<void> {
	const service = source instanceof ContentCompareService ? source : source.service;
	ensureProvider();
	allowedRoots.add(path.resolve(service.orgCopyRoot()));

	let orgFiles = service.orgCopyFiles(row.key);
	if (!orgFiles) {
		try {
			orgFiles = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Retrieving ${row.name} from the org…` },
				() => service.fetchOrgCopy({ type: row.type, name: row.name })
			);
		} catch (e) {
			void vscode.window.showErrorMessage(`Could not get the org's copy of ${row.type}:${row.name}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
			return;
		}
	}
	const localFiles = new Map<string, string>();
	for (const f of row.files) if (fs.existsSync(f.abs)) localFiles.set(f.inner, f.abs);

	const pairs = planDiffPairs(await digestsOf(localFiles), await digestsOf(orgFiles));
	if (pairs.length === 0) {
		void vscode.window.showInformationMessage(`${row.name}: there are no files to compare.`);
		return;
	}
	if (pairs.length === 1) {
		await openPair(row, pairs[0], true);
		return;
	}
	const items = pairs.map((p) => ({
		label: p.inner,
		description: PAIR_STATE_LABELS[p.state],
		detail: p.local ? path.relative(projectDir, p.local) : undefined,
		pair: p,
	}));
	const pick = await vscode.window.showQuickPick(items, { title: `${row.name}: choose a file to compare`, placeHolder: "Files that differ come first; equal files are last" });
	if (pick) await openPair(row, pick.pair, false);
}
