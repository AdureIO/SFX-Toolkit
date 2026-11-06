import * as vscode from 'vscode';
import {
	VIRTUAL_BUFFER_SCHEME,
	closeVirtualDocument,
	isLanguageServerAvailable,
	languageServerCapabilities,
	lsRequest,
	refreshLanguageServerSchemaFor,
	setEphemeralBuffers,
	syncVirtualDocument,
} from '../languageClient';
import { clearBufferOrgOverride, setBufferOrgOverride } from '../utils/bufferOrgOverride';
import {
	LspCompletionItemLike,
	RequestGate,
	WireCompletionItem,
	WireCompletionResult,
	WireHover,
	completionItemToWire,
	completionToWire,
	definitionTargets,
	hoverToWire,
	vscodeCompletionItemToLsp,
} from './bufferBridgeCore';

/** What a webview editor sends with a completion / hover / definition request. */
export interface BridgeRequest {
	requestId?: number;
	text: string;
	line: number;
	character: number;
	/** LSP CompletionTriggerKind (1 invoked, 2 trigger character, 3 incomplete re-trigger). */
	triggerKind?: number;
	triggerCharacter?: string;
}

/**
 * Bridges a webview (Monaco) editor to the ASFX language server.
 *
 * Normal path: the editor's text lives in a VIRTUAL document (`asfx-buffer:` scheme,
 * synced with synthetic didOpen/didChange) and completion / hover / definition go
 * straight to our LanguageClient — no `vscode.execute*Provider` fan-out (which also
 * asked the Salesforce Apex/SOQL extensions → duplicate items, slowest provider sets
 * latency) and no disk write per keystroke.
 *
 * The virtual URI's path is the historic buffer file path, so the workbench org
 * override (keyed by fsPath) and default-org / sfdx-project resolution are unchanged.
 * When `persist` is set the text is also saved to that file — only on the debounced
 * contentChanged / blur path (`persist()`), never on completion/hover.
 *
 * Fallback (our server not running, e.g. completion disabled): the old file-backed
 * hidden document + `vscode.execute*Provider`, but without saving on the request path.
 *
 * Every request runs on one serialized chain per bridge; superseded/cancelled
 * requests are dropped before they run (RequestGate).
 */
export class ApexBufferBridge {
	private _doc?: vscode.TextDocument;
	private readonly _gate = new RequestGate(() => new vscode.CancellationTokenSource());
	/** Raw items of the last completion list (for completionItem/resolve). */
	private _lastList: { listId: number; items: LspCompletionItemLike[]; uri: string } | undefined;
	private _listSeq = 0;
	private _ephemeralSent = false;

	/**
	 * @param bufferRelativePath workspace-relative path of the (historic) buffer file
	 * @param languageId 'apex' or 'soql' — the language the server treats the buffer as
	 * @param persist write the text to the buffer file on `persist()` (workbench restores it)
	 */
	constructor(
		private readonly bufferRelativePath: string,
		private readonly languageId: 'apex' | 'soql' = 'apex',
		private readonly persistToDisk = false,
	) {}

	/** The buffer file URI (persistence + org-override key). */
	getBufferUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, this.bufferRelativePath) : undefined;
	}

	/** The virtual document URI the language server sees. */
	getVirtualUri(): string | undefined {
		const file = this.getBufferUri();
		return file ? file.with({ scheme: VIRTUAL_BUFFER_SCHEME }).toString() : undefined;
	}

	/** Every URI this buffer may be known under (virtual + file fallback). */
	getDocumentUris(): string[] {
		const file = this.getBufferUri();
		const virt = this.getVirtualUri();
		return [virt, file?.toString()].filter((u): u is string => !!u);
	}

	/**
	 * Point this buffer's IntelliSense at `org` (null = default org). Registers the
	 * buffer as ephemeral (never write SObject stubs for it). Only when the effective
	 * org actually changed does the server get a TARGETED schema refresh for this
	 * buffer — not a full refresh that would clear every open document.
	 */
	setOrg(org: string | null): boolean {
		const file = this.getBufferUri();
		if (!file) return false;
		if (!this._ephemeralSent) {
			this._ephemeralSent = true;
			setEphemeralBuffers(this.getDocumentUris());
		}
		const changed = setBufferOrgOverride(file.fsPath, org);
		if (changed) refreshLanguageServerSchemaFor(this.getDocumentUris());
		return changed;
	}

	async readBuffer(): Promise<string> {
		const uri = this.getBufferUri();
		if (!uri) return '';
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
		} catch {
			return '';
		}
	}

	/**
	 * Sync the language server's view of the buffer to `text` (no disk write).
	 * Returns the URI requests should target, or undefined if nothing is available.
	 */
	private async _sync(text: string): Promise<{ uri: string; virtual: boolean } | undefined> {
		const virt = this.getVirtualUri();
		if (virt && isLanguageServerAvailable() && (await syncVirtualDocument(virt, this.languageId, text))) {
			return { uri: virt, virtual: true };
		}
		const doc = await this._fallbackDoc(text);
		return doc ? { uri: doc.uri.toString(), virtual: false } : undefined;
	}

	/** Fallback: the file-backed hidden document, edited in memory (not saved here). */
	private async _fallbackDoc(text: string): Promise<vscode.TextDocument | undefined> {
		const uri = this.getBufferUri();
		if (!uri) return undefined;
		if (!this._doc || this._doc.isClosed) {
			try {
				try {
					await vscode.workspace.fs.stat(uri);
				} catch {
					await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
					await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(''));
				}
				this._doc = await vscode.workspace.openTextDocument(uri);
				if (this.languageId === 'soql' && this._doc.languageId !== 'soql') {
					try { this._doc = await vscode.languages.setTextDocumentLanguage(this._doc, 'soql'); } catch { /* ignore */ }
				}
			} catch {
				return undefined;
			}
		}
		const doc = this._doc;
		if (doc.getText() !== text) {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
			try { await vscode.workspace.applyEdit(edit); } catch { /* ignore */ }
		}
		return doc;
	}

	/**
	 * The webview's (debounced / blur) content-changed notification: sync the server
	 * and, for persisting buffers, save the text to the buffer file. This is the only
	 * place the file is written.
	 */
	async persist(text: string): Promise<void> {
		await this._gate.run('sync', undefined, async () => {
			const target = await this._sync(text);
			if (!this.persistToDisk) return;
			const uri = this.getBufferUri();
			if (!uri) return;
			try {
				if (this._doc && !this._doc.isClosed) {
					// The fallback document is open and owns the file — save through it (a rival
					// fs write would produce "the content of the file is newer" conflicts).
					if (target?.virtual) await this._fallbackDoc(text);
					if (this._doc.isDirty) await this._doc.save();
				} else {
					const cur = await this.readBuffer();
					if (cur === text) return;
					await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
					await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
				}
			} catch { /* ignore */ }
		});
	}

	/** Webview cancelled a request (Monaco's token fired). */
	cancel(requestId: number): void {
		this._gate.cancel(requestId);
	}

	/**
	 * Completion. Resolves null when the request was dropped (superseded/cancelled);
	 * otherwise the server's full list (no cap) + its `isIncomplete` flag.
	 */
	async completions(req: BridgeRequest): Promise<(WireCompletionResult & { listId: number }) | null> {
		const r = await this._gate.run('completion', req.requestId, async (cts) => {
			const target = await this._sync(req.text);
			if (!target || cts.token.isCancellationRequested) return null;
			const position = { line: req.line, character: req.character };
			if (target.virtual) {
				const context = req.triggerKind
					? { triggerKind: req.triggerKind, ...(req.triggerKind === 2 && req.triggerCharacter ? { triggerCharacter: req.triggerCharacter } : {}) }
					: { triggerKind: 1 };
				const res = await lsRequest<any>('textDocument/completion', { textDocument: { uri: target.uri }, position, context }, cts.token);
				if (cts.token.isCancellationRequested) return null;
				const withResolveIds = !!languageServerCapabilities()?.completionProvider?.resolveProvider;
				const conv = completionToWire(res, { position, withResolveIds });
				const listId = ++this._listSeq;
				this._lastList = withResolveIds ? { listId, items: conv.raw, uri: target.uri } : undefined;
				return { items: conv.items, incomplete: conv.incomplete, listId };
			}
			// Fallback: our server isn't running — ask VS Code's providers.
			const list = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider', vscode.Uri.parse(target.uri), new vscode.Position(req.line, req.character),
				req.triggerKind === 2 ? req.triggerCharacter : undefined,
			);
			const conv = completionToWire(
				{ isIncomplete: !!list?.isIncomplete, items: (list?.items ?? []).map(vscodeCompletionItemToLsp) },
				{ position },
			);
			this._lastList = undefined;
			return { items: conv.items, incomplete: conv.incomplete, listId: ++this._listSeq };
		}).catch(() => ({ dropped: false as const, value: null }));
		return r.dropped ? null : r.value;
	}

	/**
	 * Lazily resolve one item of the last list (documentation, detail, edits) when the
	 * server advertises `resolveProvider`. Null when there's nothing to resolve.
	 */
	async resolveCompletion(listId: number, resolveId: number, requestId?: number): Promise<WireCompletionItem | null> {
		const r = await this._gate.run('resolve', requestId, async (cts) => {
			const last = this._lastList;
			if (!last || last.listId !== listId) return null;
			const raw = last.items[resolveId];
			if (!raw) return null;
			const res = await lsRequest<LspCompletionItemLike>('completionItem/resolve', raw, cts.token);
			if (!res || cts.token.isCancellationRequested) return null;
			// Resolve is position-independent for the fields we merge (doc/detail/edits).
			return completionItemToWire(res, { line: Number.MAX_SAFE_INTEGER, character: 0 }, resolveId);
		}).catch(() => ({ dropped: false as const, value: null }));
		return r.dropped ? null : r.value;
	}

	async hover(req: BridgeRequest): Promise<WireHover | null> {
		const r = await this._gate.run('hover', req.requestId, async (cts) => {
			const target = await this._sync(req.text);
			if (!target || cts.token.isCancellationRequested) return null;
			const position = { line: req.line, character: req.character };
			if (target.virtual) {
				return hoverToWire(await lsRequest<unknown>('textDocument/hover', { textDocument: { uri: target.uri }, position }, cts.token));
			}
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider', vscode.Uri.parse(target.uri), new vscode.Position(req.line, req.character),
			);
			return hoverToWire(hovers ?? []);
		}).catch(() => ({ dropped: false as const, value: null }));
		return r.dropped ? null : r.value;
	}

	/**
	 * Resolve go-to-definition for the cursor. A definition in another file opens a real
	 * editor tab. A definition INSIDE the buffer (a method/inner class declared in the same
	 * anonymous block) can't open the hidden doc — return its position so the caller can move
	 * the webview editor's own cursor there. Returns null when there's nothing to navigate to.
	 */
	async gotoDefinition(req: BridgeRequest): Promise<{ line: number; character: number } | null> {
		const r = await this._gate.run('definition', req.requestId, async (cts) => {
			const target = await this._sync(req.text);
			if (!target) return null;
			const position = { line: req.line, character: req.character };
			const res = target.virtual
				? await lsRequest<unknown>('textDocument/definition', { textDocument: { uri: target.uri }, position }, cts.token)
				: await vscode.commands.executeCommand<unknown>(
					'vscode.executeDefinitionProvider', vscode.Uri.parse(target.uri), new vscode.Position(req.line, req.character),
				);
			const first = definitionTargets(res)[0];
			if (!first) return null;
			const uriStr = String(first.uri);
			if (this.getDocumentUris().includes(uriStr) || uriStr === target.uri) {
				return { line: first.range.start.line, character: first.range.start.character };
			}
			const uri = typeof first.uri === 'string' ? vscode.Uri.parse(first.uri) : (first.uri as vscode.Uri);
			const sel = new vscode.Range(first.range.start.line, first.range.start.character, first.range.end.line, first.range.end.character);
			await vscode.window.showTextDocument(uri, { selection: sel, preview: false });
			return null;
		}).catch(() => ({ dropped: false as const, value: null }));
		return r.dropped ? null : r.value;
	}

	/** Panel disposed: close the virtual document and drop the org override. */
	dispose(): void {
		const virt = this.getVirtualUri();
		if (virt) closeVirtualDocument(virt);
		const file = this.getBufferUri();
		if (file) clearBufferOrgOverride(file.fsPath);
		this._lastList = undefined;
	}
}
