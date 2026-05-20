import * as vscode from 'vscode';
import {
    parseContext,
    getStaticItems,
    sobjectItems,
    fieldItems,
    CompletionKind,
    RawCompletionItem,
} from '../utils/apexCompletions';
import { OrgMetadataCache } from '../utils/orgMetadataCache';

const KIND_MAP: Record<number, vscode.CompletionItemKind> = {
    [CompletionKind.Keyword]:  vscode.CompletionItemKind.Keyword,
    [CompletionKind.Class]:    vscode.CompletionItemKind.Class,
    [CompletionKind.Method]:   vscode.CompletionItemKind.Method,
    [CompletionKind.Field]:    vscode.CompletionItemKind.Field,
    [CompletionKind.Variable]: vscode.CompletionItemKind.Variable,
    [CompletionKind.Text]:     vscode.CompletionItemKind.Text,
};

function toVsCodeItem(raw: RawCompletionItem): vscode.CompletionItem {
    const item = new vscode.CompletionItem(raw.label, KIND_MAP[raw.kind] ?? vscode.CompletionItemKind.Text);
    if (raw.detail) item.detail = raw.detail;
    if (raw.documentation) item.documentation = raw.documentation;
    if (raw.insertText) item.insertText = raw.insertText;
    if (raw.sortText) item.sortText = raw.sortText;
    return item;
}

/**
 * Resolves completions for both the VS Code CompletionItemProvider and the
 * Execute Apex webview panel (which calls getItems() directly via the message handler).
 */
export class ApexCompletionProvider implements vscode.CompletionItemProvider {

    /**
     * Core async completion resolver — returns plain objects so it can be
     * called from both the VS Code API and the webview message handler.
     *
     * @param textUpToCursor  Current line text up to the cursor position.
     * @param surroundingText Multi-line window around the cursor (for SOQL FROM detection).
     * @param org             Org username or null for default org.
     */
    static async getItems(
        textUpToCursor: string,
        surroundingText: string,
        org: string | null
    ): Promise<RawCompletionItem[]> {
        const ctx = parseContext(textUpToCursor, surroundingText);
        const staticItems = getStaticItems(ctx);

        if (ctx.type === 'soqlFrom' || (ctx.type === 'bare' && ctx.prefix.length >= 2)) {
            // Add SObject names from cache
            const names = await OrgMetadataCache.getObjectList(org);
            return [...staticItems, ...sobjectItems(names, ctx.prefix)];
        }

        if (ctx.type === 'soqlField' && ctx.sobjectName) {
            const fields = await OrgMetadataCache.getFieldNames(org, ctx.sobjectName);
            return [...staticItems, ...fieldItems(fields, ctx.prefix)];
        }

        if (ctx.type === 'member' && ctx.objectName) {
            // If the stdlib didn't match, try it as an SObject type name for field completion
            if (staticItems.length === 0) {
                const fields = await OrgMetadataCache.getFieldNames(org, ctx.objectName);
                return fieldItems(fields, ctx.prefix);
            }
        }

        return staticItems;
    }

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[]> {
        const lineText = document.lineAt(position).text;
        const textUpToCursor = lineText.substring(0, position.character);

        // Build a surrounding-text window (±5 lines) for SOQL FROM detection
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const windowLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            windowLines.push(document.lineAt(i).text);
        }
        const surroundingText = windowLines.join('\n');

        try {
            const raw = await ApexCompletionProvider.getItems(textUpToCursor, surroundingText, null);
            return raw.map(toVsCodeItem);
        } catch {
            return [];
        }
    }
}
