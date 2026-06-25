import * as vscode from 'vscode';

/**
 * Bridges a webview Apex editor to VS Code's real language features. It keeps a
 * single hidden buffer document (a real `.apex` file) in sync with the webview's
 * text and resolves completion / hover / definition against it via the
 * `vscode.execute*Provider` commands — so the webview gets the same org-aware
 * IntelliSense as a normal editor. Shared by the Execute panel and the workbench.
 *
 * The open document is the ONLY writer of the file (apply + save), never a rival
 * fs write — doing both produced "the content of the file is newer" conflicts.
 */
export class ApexBufferBridge {
	private _doc?: vscode.TextDocument;

	/**
	 * @param languageId force the backing document's language (e.g. 'soql') so the
	 *   server uses the right completion path regardless of file-association quirks.
	 */
	constructor(private readonly bufferRelativePath: string, private readonly languageId?: string) {}

	getBufferUri(): vscode.Uri | undefined {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		return root ? vscode.Uri.joinPath(root, this.bufferRelativePath) : undefined;
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

	/** Open (creating once if needed) the backing document and sync it to `text`. */
	async update(text: string): Promise<vscode.TextDocument | undefined> {
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
				// Force the language so the server picks the right (SOQL vs Apex) path.
				if (this.languageId && this._doc.languageId !== this.languageId) {
					try { this._doc = await vscode.languages.setTextDocumentLanguage(this._doc, this.languageId); } catch { /* ignore */ }
				}
			} catch {
				return undefined;
			}
		}
		const doc = this._doc;
		if (doc.getText() !== text) {
			const edit = new vscode.WorkspaceEdit();
			const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
			edit.replace(uri, full, text);
			try {
				await vscode.workspace.applyEdit(edit);
				await doc.save();
			} catch {
				/* ignore */
			}
		}
		return doc;
	}

	/** The identifier prefix immediately before the cursor (for client-side filtering). */
	private static prefixAt(text: string, line: number, character: number): string {
		const lineText = text.split('\n')[line] ?? '';
		const m = /([A-Za-z0-9_]+)$/.exec(lineText.slice(0, character));
		return (m ? m[1] : '').toLowerCase();
	}

	async completions(text: string, line: number, character: number): Promise<unknown[]> {
		const doc = await this.update(text);
		if (!doc) return [];
		try {
			const list = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				doc.uri,
				new vscode.Position(line, character),
			);
			let items = list?.items ?? [];
			// executeCompletionItemProvider returns raw, unfiltered provider output
			// (the whole org for type completion). Filter by the typed prefix before
			// capping, honoring the namespace-optional filterText.
			const prefix = ApexBufferBridge.prefixAt(text, line, character);
			if (prefix) {
				const matches = (s?: string) => !!s && s.toLowerCase().startsWith(prefix);
				items = items.filter((it) => {
					const label = typeof it.label === 'string' ? it.label : it.label.label;
					return matches(it.filterText) || matches(label) || (it.filterText ?? '').toLowerCase().includes(prefix);
				});
			}
			return items.slice(0, 200).map((it) => {
				const label = typeof it.label === 'string' ? it.label : it.label.label;
				const isSnippet = it.insertText instanceof vscode.SnippetString;
				const insert = typeof it.insertText === 'string' ? it.insertText : (it.insertText as vscode.SnippetString | undefined)?.value ?? label;
				const doc2 = typeof it.documentation === 'string' ? it.documentation : (it.documentation as vscode.MarkdownString | undefined)?.value;
				return {
					label, insertText: insert, isSnippet,
					kind: typeof it.kind === 'number' ? it.kind : 0,
					detail: it.detail, documentation: doc2,
					sortText: it.sortText, filterText: it.filterText,
				};
			});
		} catch {
			return [];
		}
	}

	async hover(text: string, line: number, character: number): Promise<{ contents: string[] } | null> {
		const doc = await this.update(text);
		if (!doc) return null;
		try {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider', doc.uri, new vscode.Position(line, character),
			);
			const contents: string[] = [];
			for (const h of hovers ?? []) {
				for (const c of h.contents) {
					const value = typeof c === 'string' ? c : (c as vscode.MarkdownString).value;
					if (value && value.trim()) contents.push(value);
				}
			}
			return contents.length ? { contents } : null;
		} catch {
			return null;
		}
	}

	async gotoDefinition(text: string, line: number, character: number): Promise<void> {
		const doc = await this.update(text);
		if (!doc) return;
		try {
			const res = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
				'vscode.executeDefinitionProvider', doc.uri, new vscode.Position(line, character),
			);
			const first = (res ?? [])[0];
			if (!first) return;
			const uri = 'targetUri' in first ? first.targetUri : first.uri;
			const range = 'targetUri' in first ? (first.targetSelectionRange ?? first.targetRange) : first.range;
			if (uri.toString() === doc.uri.toString()) return; // self-ref into the hidden buffer
			await vscode.window.showTextDocument(uri, { selection: range, preview: false });
		} catch {
			/* no definition */
		}
	}

	/** Open the backing document as a normal editor tab. */
	async openInEditor(text: string): Promise<void> {
		const doc = await this.update(text);
		if (!doc) return;
		try {
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch {
			await vscode.commands.executeCommand('vscode.open', doc.uri);
		}
	}
}
