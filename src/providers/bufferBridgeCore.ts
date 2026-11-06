/**
 * Pure (vscode-free) core of the webview editor ↔ language-server bridge:
 *   • LSP completion / hover / definition results → the plain "wire" shapes the
 *     Monaco webviews consume (1-based ranges, Monaco kind names, insert/replace
 *     ranges, additionalTextEdits, labelDetails, snippets, …) — nothing capped or
 *     re-filtered, `isIncomplete` passed through so Monaco re-requests as you type.
 *   • RequestGate: per-bridge serialization with stale-request dropping and
 *     cancellation, so a burst of keystrokes never runs N completions back to back.
 *
 * Inputs are duck-typed so the same converters accept raw protocol JSON (from our
 * LanguageClient) and VS Code API objects (the fallback `vscode.execute*Provider`
 * path when our server isn't running). Unit-tested in src/test/bufferBridgeCore.test.ts.
 */

// ── wire shapes (host → webview) ────────────────────────────────────────────────

/** Monaco IRange (1-based). */
export interface WireRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

export interface WireCompletionItem {
	label: string | { label: string; detail?: string; description?: string };
	/** Monaco `CompletionItemKind` member name (e.g. "Field"). */
	kind: string;
	insertText: string;
	snippet?: boolean;
	range?: WireRange | { insert: WireRange; replace: WireRange };
	additionalTextEdits?: { range: WireRange; text: string }[];
	command?: { id: string; title: string; arguments?: unknown[] };
	detail?: string;
	documentation?: string | { value: string };
	sortText?: string;
	filterText?: string;
	preselect?: boolean;
	commitCharacters?: string[];
	deprecated?: boolean;
	/** Index into the host's last raw list — present when the server supports resolve. */
	resolveId?: number;
}

export interface WireCompletionResult {
	items: WireCompletionItem[];
	incomplete: boolean;
}

export interface WireHover {
	contents: string[];
	range?: WireRange;
}

// ── loose LSP / VS Code shapes ──────────────────────────────────────────────────

interface PosLike {
	line: number;
	character: number;
}
interface RangeLike {
	start: PosLike;
	end: PosLike;
}
export interface LspCompletionItemLike {
	label: string | { label: string; detail?: string; description?: string };
	labelDetails?: { detail?: string; description?: string };
	kind?: number;
	detail?: string;
	documentation?: unknown;
	sortText?: string;
	filterText?: string;
	preselect?: boolean;
	insertText?: string | { value: string };
	insertTextFormat?: number;
	textEdit?: { range?: RangeLike; insert?: RangeLike; replace?: RangeLike; newText: string };
	textEditText?: string;
	additionalTextEdits?: { range: RangeLike; newText: string }[];
	command?: { command: string; title?: string; arguments?: unknown[] };
	commitCharacters?: string[];
	tags?: number[];
	deprecated?: boolean;
	data?: unknown;
	[k: string]: unknown;
}
interface LspCompletionListLike {
	isIncomplete?: boolean;
	items?: LspCompletionItemLike[];
	itemDefaults?: {
		editRange?: RangeLike | { insert: RangeLike; replace: RangeLike };
		insertTextFormat?: number;
		commitCharacters?: string[];
		data?: unknown;
	};
}

// ── kinds ───────────────────────────────────────────────────────────────────────

/** LSP CompletionItemKind (1-based) → Monaco CompletionItemKind member name. */
const LSP_KIND_NAMES: readonly string[] = [
	"Text", // 0 (unused — LSP is 1-based; treat as Text)
	"Text",
	"Method",
	"Function",
	"Constructor",
	"Field",
	"Variable",
	"Class",
	"Interface",
	"Module",
	"Property",
	"Unit",
	"Value",
	"Enum",
	"Keyword",
	"Snippet",
	"Color",
	"File",
	"Reference",
	"Folder",
	"EnumMember",
	"Constant",
	"Struct",
	"Event",
	"Operator",
	"TypeParameter",
];

export function lspKindToMonacoName(kind: number | undefined): string {
	return typeof kind === "number" && kind >= 1 && kind < LSP_KIND_NAMES.length ? LSP_KIND_NAMES[kind] : "Text";
}

/** VS Code's CompletionItemKind is 0-based (Text = 0); LSP's is 1-based. */
export function vscodeKindToLsp(kind: number | undefined): number | undefined {
	return typeof kind === "number" ? kind + 1 : undefined;
}

// ── ranges ──────────────────────────────────────────────────────────────────────

function isRange(r: unknown): r is RangeLike {
	const x = r as RangeLike | undefined;
	return !!x && typeof x === "object" && !!x.start && !!x.end && typeof x.start.line === "number" && typeof x.end.line === "number";
}

export function toWireRange(r: RangeLike): WireRange {
	return {
		startLineNumber: r.start.line + 1,
		startColumn: r.start.character + 1,
		endLineNumber: r.end.line + 1,
		endColumn: r.end.character + 1,
	};
}

/**
 * Monaco drops a suggestion whose edit range spans lines or is not on the cursor's
 * line ("INVALID range"). Such a range is replaced by Monaco's default word range.
 */
function validEditRange(r: RangeLike, pos: PosLike): boolean {
	return r.start.line === pos.line && r.end.line === pos.line && r.start.character <= pos.character;
}

// ── documentation / markdown ────────────────────────────────────────────────────

function markedToMarkdown(c: unknown): string {
	if (typeof c === "string") return c;
	if (c && typeof c === "object") {
		const o = c as { language?: string; value?: string; kind?: string };
		if (typeof o.value !== "string") return "";
		if (typeof o.language === "string") return "```" + o.language + "\n" + o.value + "\n```";
		return o.value; // MarkupContent (markdown|plaintext) or vscode.MarkdownString
	}
	return "";
}

function toWireDoc(d: unknown): string | { value: string } | undefined {
	if (d === undefined || d === null) return undefined;
	if (typeof d === "string") return d || undefined;
	const o = d as { kind?: string; value?: string };
	if (typeof o.value !== "string" || !o.value) return undefined;
	return o.kind === "plaintext" ? o.value : { value: o.value };
}

// ── completion ──────────────────────────────────────────────────────────────────

/** Commands Monaco itself can run inside the webview (others are dropped). */
const MONACO_COMMANDS = new Set(["editor.action.triggerSuggest", "editor.action.triggerParameterHints"]);

export interface CompletionConvertOptions {
	/** 0-based cursor position the completion was requested at. */
	position: PosLike;
	/** Attach `resolveId` (the item's index in the returned `raw` list). */
	withResolveIds?: boolean;
}

/** Apply CompletionList.itemDefaults (LSP 3.17) to one item. */
function applyDefaults(it: LspCompletionItemLike, defs: LspCompletionListLike["itemDefaults"]): LspCompletionItemLike {
	if (!defs) return it;
	const out: LspCompletionItemLike = { ...it };
	if (defs.editRange && !out.textEdit) {
		const newText = out.textEditText ?? (typeof out.insertText === "string" ? out.insertText : undefined) ?? labelText(out);
		out.textEdit = isRange(defs.editRange)
			? { range: defs.editRange, newText }
			: { insert: (defs.editRange as { insert: RangeLike }).insert, replace: (defs.editRange as { replace: RangeLike }).replace, newText };
	}
	if (defs.insertTextFormat !== undefined && out.insertTextFormat === undefined) out.insertTextFormat = defs.insertTextFormat;
	if (defs.commitCharacters && !out.commitCharacters) out.commitCharacters = defs.commitCharacters;
	if (defs.data !== undefined && out.data === undefined) out.data = defs.data;
	return out;
}

function labelText(it: LspCompletionItemLike): string {
	return typeof it.label === "string" ? it.label : it.label?.label ?? "";
}

/** Convert one LSP completion item to the wire shape. */
export function completionItemToWire(raw: LspCompletionItemLike, pos: PosLike, resolveId?: number): WireCompletionItem {
	const label = labelText(raw);
	const out: WireCompletionItem = {
		label: raw.labelDetails && (raw.labelDetails.detail || raw.labelDetails.description)
			? { label, detail: raw.labelDetails.detail, description: raw.labelDetails.description }
			: typeof raw.label === "object" && raw.label
				? { label, detail: raw.label.detail, description: raw.label.description }
				: label,
		kind: lspKindToMonacoName(raw.kind),
		insertText: label,
	};
	let snippet = raw.insertTextFormat === 2;
	if (raw.insertText !== undefined) {
		if (typeof raw.insertText === "string") out.insertText = raw.insertText;
		else if (raw.insertText && typeof raw.insertText.value === "string") {
			out.insertText = raw.insertText.value; // vscode.SnippetString
			snippet = true;
		}
	}
	const te = raw.textEdit;
	if (te) {
		out.insertText = te.newText;
		if (isRange(te.range)) {
			if (validEditRange(te.range, pos)) out.range = toWireRange(te.range);
		} else if (isRange(te.insert) && isRange(te.replace)) {
			if (validEditRange(te.insert, pos) && validEditRange(te.replace, pos)) {
				out.range = { insert: toWireRange(te.insert), replace: toWireRange(te.replace) };
			}
		}
	}
	if (snippet) out.snippet = true;
	if (raw.additionalTextEdits?.length) {
		out.additionalTextEdits = raw.additionalTextEdits
			.filter((e) => isRange(e.range))
			.map((e) => ({ range: toWireRange(e.range), text: e.newText ?? "" }));
	}
	if (raw.command && MONACO_COMMANDS.has(raw.command.command)) {
		out.command = { id: raw.command.command, title: raw.command.title ?? "", arguments: raw.command.arguments };
	}
	if (raw.detail) out.detail = raw.detail;
	const doc = toWireDoc(raw.documentation);
	if (doc !== undefined) out.documentation = doc;
	if (raw.sortText !== undefined) out.sortText = raw.sortText;
	if (raw.filterText !== undefined) out.filterText = raw.filterText;
	if (raw.preselect) out.preselect = true;
	if (raw.commitCharacters?.length) out.commitCharacters = raw.commitCharacters;
	if (raw.deprecated || raw.tags?.includes(1)) out.deprecated = true;
	if (resolveId !== undefined) out.resolveId = resolveId;
	return out;
}

/**
 * Convert a `textDocument/completion` result. Everything the server sent is kept —
 * no client-side cap or re-filter (Monaco filters/ranks against the typed word and
 * `filterText`/`sortText`); `incomplete` tells Monaco to re-request as you type.
 * Exact duplicates (same label/kind/insertText/detail) are collapsed.
 * `raw` is the normalized item list (defaults applied) to resolve against later.
 */
export function completionToWire(
	result: LspCompletionItemLike[] | LspCompletionListLike | null | undefined,
	opts: CompletionConvertOptions,
): WireCompletionResult & { raw: LspCompletionItemLike[] } {
	if (!result) return { items: [], incomplete: false, raw: [] };
	const list: LspCompletionListLike = Array.isArray(result) ? { items: result, isIncomplete: false } : result;
	const raw = (list.items ?? []).map((it) => applyDefaults(it, list.itemDefaults));
	const items: WireCompletionItem[] = [];
	const kept: LspCompletionItemLike[] = [];
	const seen = new Set<string>();
	for (const it of raw) {
		const w = completionItemToWire(it, opts.position, opts.withResolveIds ? kept.length : undefined);
		const key = JSON.stringify([w.label, w.kind, w.insertText, w.detail ?? ""]);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(it);
		items.push(w);
	}
	return { items, incomplete: !!list.isIncomplete, raw: kept };
}

/**
 * Normalize a VS Code `CompletionItem` (fallback path) to the LSP-like shape so the
 * same converter handles it. Duck-typed — no vscode import.
 */
export function vscodeCompletionItemToLsp(it: any): LspCompletionItemLike {
	const label = typeof it.label === "string" ? it.label : it.label?.label ?? "";
	const out: LspCompletionItemLike = { label, kind: vscodeKindToLsp(it.kind) };
	if (typeof it.label === "object" && it.label && (it.label.detail || it.label.description)) {
		out.labelDetails = { detail: it.label.detail, description: it.label.description };
	}
	const insert = it.insertText;
	let newText: string = label;
	if (typeof insert === "string") newText = insert;
	else if (insert && typeof insert.value === "string") {
		newText = insert.value;
		out.insertTextFormat = 2;
	}
	out.insertText = newText;
	const r = it.range;
	if (isRange(r)) out.textEdit = { range: r, newText };
	else if (r && isRange(r.inserting) && isRange(r.replacing)) out.textEdit = { insert: r.inserting, replace: r.replacing, newText };
	if (Array.isArray(it.additionalTextEdits)) {
		out.additionalTextEdits = it.additionalTextEdits
			.filter((e: any) => e && isRange(e.range))
			.map((e: any) => ({ range: e.range, newText: e.newText ?? "" }));
	}
	if (it.command && typeof it.command.command === "string") out.command = it.command;
	for (const k of ["detail", "sortText", "filterText", "preselect", "commitCharacters", "tags"] as const) {
		if (it[k] !== undefined) (out as any)[k] = it[k];
	}
	if (it.documentation !== undefined) out.documentation = it.documentation;
	return out;
}

// ── hover ───────────────────────────────────────────────────────────────────────

/** LSP `Hover` (or VS Code Hover[] on the fallback path) → markdown strings. */
export function hoverToWire(hover: unknown): WireHover | null {
	const hovers = Array.isArray(hover) && hover.length && (hover[0] as any)?.contents !== undefined ? hover : [hover];
	const contents: string[] = [];
	let range: WireRange | undefined;
	for (const h of hovers as any[]) {
		if (!h || h.contents === undefined) continue;
		const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
		for (const c of parts) {
			const md = markedToMarkdown(c);
			if (md && md.trim()) contents.push(md);
		}
		if (!range && isRange(h.range)) range = toWireRange(h.range);
	}
	if (!contents.length) return null;
	return range ? { contents, range } : { contents };
}

// ── definition ──────────────────────────────────────────────────────────────────

export interface DefinitionTarget {
	/** String URI (protocol) or a VS Code Uri object (fallback path). */
	uri: unknown;
	range: RangeLike;
}

/** Location | Location[] | LocationLink[] → first-class targets (protocol or VS Code shapes). */
export function definitionTargets(res: unknown): DefinitionTarget[] {
	if (!res) return [];
	const arr = Array.isArray(res) ? res : [res];
	const out: DefinitionTarget[] = [];
	for (const l of arr as any[]) {
		if (!l) continue;
		if (l.targetUri !== undefined) {
			const range = isRange(l.targetSelectionRange) ? l.targetSelectionRange : l.targetRange;
			if (isRange(range)) out.push({ uri: l.targetUri, range });
		} else if (l.uri !== undefined && isRange(l.range)) {
			out.push({ uri: l.uri, range: l.range });
		}
	}
	return out;
}

// ── request gate ────────────────────────────────────────────────────────────────

export interface CancelSourceLike {
	cancel(): void;
	dispose(): void;
}

export type GateResult<T> = { dropped: true } | { dropped: false; value: T };

/**
 * Serializes a bridge's work (buffer sync → LS request) on one promise chain, and
 * drops stale work: a request whose `requestId` was superseded by a newer request of
 * the same kind before its turn came — or that the webview cancelled — never runs.
 * A newer request also cancels an older same-kind request that is already running
 * (its token fires, so the LS request is cancelled too).
 *
 * Request ids must increase per bridge (the webviews use one counter per page).
 * Work without a request id (plain buffer syncs) is never dropped.
 */
export class RequestGate<S extends CancelSourceLike> {
	private chain: Promise<unknown> = Promise.resolve();
	private readonly newest = new Map<string, number>();
	private readonly running = new Map<number, { kind: string; source: S }>();
	private readonly cancelled = new Set<number>();

	constructor(private readonly createSource: () => S) {}

	run<T>(kind: string, requestId: number | undefined, task: (source: S) => Promise<T>): Promise<GateResult<T>> {
		if (requestId !== undefined) {
			const prev = this.newest.get(kind);
			if (prev === undefined || requestId > prev) this.newest.set(kind, requestId);
			// Supersede: cancel older same-kind work that's already in flight.
			for (const [id, r] of this.running) if (r.kind === kind && id < requestId) r.source.cancel();
		}
		const exec = async (): Promise<GateResult<T>> => {
			if (requestId !== undefined) {
				const newest = this.newest.get(kind) ?? requestId;
				if (requestId < newest || this.cancelled.has(requestId)) {
					this.cancelled.delete(requestId);
					return { dropped: true };
				}
			}
			const source = this.createSource();
			if (requestId !== undefined) this.running.set(requestId, { kind, source });
			try {
				return { dropped: false, value: await task(source) };
			} finally {
				if (requestId !== undefined) {
					this.running.delete(requestId);
					this.cancelled.delete(requestId);
				}
				source.dispose();
			}
		};
		const p = this.chain.then(exec, exec);
		this.chain = p.catch(() => undefined);
		return p;
	}

	/** Webview cancelled `requestId`: drop it if queued, cancel its token if running. */
	cancel(requestId: number): void {
		const r = this.running.get(requestId);
		if (r) r.source.cancel();
		else this.cancelled.add(requestId);
		// Bound the set: ids only grow, very old cancels are irrelevant.
		if (this.cancelled.size > 256) {
			const min = requestId - 256;
			for (const id of this.cancelled) if (id < min) this.cancelled.delete(id);
		}
	}
}
