/**
 * Applies the configured debug-log highlight rules to native log editors:
 * `.log` files and the in-memory `sf-log` / `sf-anon-log` documents opened by the
 * extension (all registered as the `salesforce-log` language). Uses editor
 * decorations — like the logFileHighlighter extension — so colors come from the
 * user's settings and native search still works.
 */
import * as vscode from "vscode";
import { getHighlightPatterns } from "../utils/apexLogHighlight";

interface CompiledRule {
	type: vscode.TextEditorDecorationType;
	re: RegExp;
	wholeLine: boolean;
}

function isApexLog(doc: vscode.TextDocument): boolean {
	return doc.languageId === "salesforce-log" || doc.uri.path.toLowerCase().endsWith(".log");
}

export class ApexLogDecorator {
	private rules: CompiledRule[] = [];

	constructor() {
		this.rebuild();
	}

	/** (Re)compile decoration types from the current settings. */
	rebuild(): void {
		this.dispose();
		for (const p of getHighlightPatterns()) {
			let re: RegExp;
			try {
				re = new RegExp(p.pattern);
			} catch {
				continue; // skip invalid user regex
			}
			const bold = p.fontStyle === "bold" || p.fontStyle === "bold italic";
			const italic = p.fontStyle === "italic" || p.fontStyle === "bold italic";
			const type = vscode.window.createTextEditorDecorationType({
				color: p.foreground,
				fontWeight: bold ? "bold" : undefined,
				fontStyle: italic ? "italic" : undefined,
				isWholeLine: !!p.highlightEntireLine,
			});
			this.rules.push({ type, re, wholeLine: !!p.highlightEntireLine });
		}
	}

	/** Recompute and apply decorations for one editor. */
	apply(editor: vscode.TextEditor | undefined): void {
		if (!editor || !isApexLog(editor.document)) return;
		const doc = editor.document;
		const lineCount = doc.lineCount;
		const ranges: vscode.Range[][] = this.rules.map(() => []);
		for (let i = 0; i < lineCount; i++) {
			const text = doc.lineAt(i).text;
			for (let r = 0; r < this.rules.length; r++) {
				const rule = this.rules[r];
				rule.re.lastIndex = 0;
				const m = rule.re.exec(text);
				if (!m) continue;
				if (rule.wholeLine) {
					ranges[r].push(doc.lineAt(i).range);
				} else {
					ranges[r].push(new vscode.Range(i, m.index, i, m.index + m[0].length));
				}
				break; // first matching rule wins for this line
			}
		}
		for (let r = 0; r < this.rules.length; r++) {
			editor.setDecorations(this.rules[r].type, ranges[r]);
		}
	}

	applyAll(): void {
		for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
	}

	dispose(): void {
		for (const r of this.rules) r.type.dispose();
		this.rules = [];
	}
}

/** Wire up the decorator: apply to visible log editors and react to config changes. */
export function registerApexLogDecorator(context: vscode.ExtensionContext): void {
	const decorator = new ApexLogDecorator();
	decorator.applyAll();

	context.subscriptions.push(
		{ dispose: () => decorator.dispose() },
		vscode.window.onDidChangeVisibleTextEditors(() => decorator.applyAll()),
		vscode.window.onDidChangeActiveTextEditor((e) => decorator.apply(e)),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("adure-sfx-toolkit.apexLog.highlightPatterns")) {
				decorator.rebuild();
				decorator.applyAll();
			}
		}),
		// Content of sf-log / sf-anon-log virtual docs arrives after the editor opens.
		vscode.workspace.onDidChangeTextDocument((e) => {
			for (const editor of vscode.window.visibleTextEditors) {
				if (editor.document === e.document) decorator.apply(editor);
			}
		}),
	);
}
