import * as vscode from 'vscode';
import {
    parseContext,
    getStaticItems,
    sobjectItems,
    fieldAndRelationItems,
    APEX_KEYWORDS,
    CompletionKind,
    RawCompletionItem,
    FieldOrRelation,
    ASFX_FOOTER,
} from '../utils/apexCompletions';
import { OrgMetadataCache } from '../utils/orgMetadataCache';
import { SoqlSchemaProvider } from '../utils/soqlSchemaProvider';
import { Telemetry } from '../utils/telemetry';

const KIND_MAP: Record<number, vscode.CompletionItemKind> = {
    [CompletionKind.Keyword]:  vscode.CompletionItemKind.Keyword,
    [CompletionKind.Class]:    vscode.CompletionItemKind.Class,
    [CompletionKind.Method]:   vscode.CompletionItemKind.Method,
    [CompletionKind.Field]:    vscode.CompletionItemKind.Field,
    [CompletionKind.Variable]: vscode.CompletionItemKind.Variable,
    [CompletionKind.Text]:     vscode.CompletionItemKind.Text,
    [CompletionKind.Snippet]:  vscode.CompletionItemKind.Snippet,
    [CompletionKind.Value]:    vscode.CompletionItemKind.Value,
};

function toVsCodeItem(raw: RawCompletionItem): vscode.CompletionItem {
    const item = new vscode.CompletionItem(raw.label, KIND_MAP[raw.kind] ?? vscode.CompletionItemKind.Text);
    if (raw.detail) item.detail = raw.detail;
    if (raw.documentation) item.documentation = raw.docIsMarkdown ? new vscode.MarkdownString(raw.documentation) : raw.documentation;
    if (raw.insertText) item.insertText = raw.isSnippet ? new vscode.SnippetString(raw.insertText) : raw.insertText;
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
        org: string | null,
        beforeCursor?: string,
        fullText?: string,
        afterText?: string
    ): Promise<RawCompletionItem[]> {
        const ctx = parseContext(textUpToCursor, surroundingText, beforeCursor, afterText);
        const staticItems = getStaticItems(ctx);

        if (ctx.type === 'soqlFrom' || (ctx.type === 'bare' && ctx.prefix.length >= 2)) {
            // Add SObject names from cache
            const names = await OrgMetadataCache.getObjectList(org);
            return [...staticItems, ...sobjectItems(names, ctx.prefix)];
        }

        if (ctx.type === 'soqlField' && ctx.sobjectName) {
            // Walk any parent-relationship hops (Account__r.Owner.…) to the target
            // SObject, then offer its fields AND relationships — same as the SOQL builder.
            let target: string | null = ctx.sobjectName;
            for (const rel of ctx.relPath ?? []) {
                target = await OrgMetadataCache.getRelationshipTarget(org, target, rel);
                if (!target) return staticItems; // relationship not in schema → suggest nothing
            }
            const entries = await OrgMetadataCache.getFieldsAndRelations(org, target);
            return [...staticItems, ...fieldAndRelationItems(entries, ctx.prefix)];
        }

        if (ctx.type === 'apexPicklist' && ctx.objectName && ctx.pickField) {
            // Resolve the receiver to an SObject, walk any relationship hops, then offer the
            // field's picklist values (the schema provider carries them; the lighter cache doesn't).
            const root = await ApexCompletionProvider.resolveRootSObject(ctx.objectName, org, fullText);
            if (!root) return [];
            let sobject: string | null = root.sobject;
            for (const rel of ctx.relPath ?? []) {
                sobject = await OrgMetadataCache.getRelationshipTarget(org, sobject, rel);
                if (!sobject) return [];
            }
            const describe = await SoqlSchemaProvider.getDescribe(org, sobject);
            const field = describe?.fields?.find((f) => f.name?.toLowerCase() === ctx.pickField!.toLowerCase());
            const values = field?.picklistValues ?? [];
            const lp = ctx.prefix.toLowerCase();
            return values
                .filter((v) => v.toLowerCase().startsWith(lp))
                .map((v) => ({
                    label: v,
                    detail: 'picklist value',
                    documentation: `Picklist value of \`${sobject}.${ctx.pickField}\`\n\n${ASFX_FOOTER}`,
                    docIsMarkdown: true,
                    kind: CompletionKind.Value,
                    insertText: v, // the editor auto-pairs the closing quote already
                    sortText: v
                }));
        }

        if (ctx.type === 'member' && ctx.objectName) {
            // stdlib / Trigger matched — return those.
            if (staticItems.length > 0) return staticItems;

            // Otherwise treat the root as an SObject instance (a declared variable)
            // or an SObject type name, then drill through any parent-relationship
            // hops (account.Contact.<field>) — same schema-driven walk as SOQL.
            const root = await ApexCompletionProvider.resolveRootSObject(ctx.objectName, org, fullText);
            if (!root) return [];

            const hops = ctx.relPath ?? [];
            if (hops.length === 0) {
                return fieldAndRelationItems(root.entries, ctx.prefix);
            }
            let target: string | null = root.sobject;
            for (const rel of hops) {
                target = await OrgMetadataCache.getRelationshipTarget(org, target, rel);
                if (!target) return []; // relationship not in schema → suggest nothing
            }
            const entries = await OrgMetadataCache.getFieldsAndRelations(org, target);
            return fieldAndRelationItems(entries, ctx.prefix);
        }

        return staticItems;
    }

    /**
     * Resolve the SObject a member-access root refers to.
     * Tries, in order: the declared type of a local variable named `root`
     * (scanned from the file text), then `root` itself as an SObject API name.
     * Returns the resolved name plus its fields+relations, or null if neither describes.
     */
    private static async resolveRootSObject(
        root: string,
        org: string | null,
        fullText?: string
    ): Promise<{ sobject: string; entries: FieldOrRelation[] } | null> {
        const candidates: string[] = [];
        if (fullText) {
            // Match `SomeType root` declarations: `Account acc`, `Contact c =`,
            // `for (Lead ld :`, `(Opportunity o)`. The type must be a bare identifier
            // (optionally __c), not a member expression, and not an Apex keyword.
            const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const declRe = new RegExp(`(?:^|[^\\w.])([A-Za-z_]\\w*(?:__[cCrR])?)\\s+${esc}\\b`, 'g');
            const keywords = new Set(APEX_KEYWORDS);
            let m: RegExpExecArray | null;
            while ((m = declRe.exec(fullText)) !== null) {
                const t = m[1];
                if (!keywords.has(t.toLowerCase()) && t.toLowerCase() !== root.toLowerCase()) {
                    candidates.push(t);
                }
            }
        }
        candidates.push(root); // the token itself may be an SObject type name

        for (const c of candidates) {
            const entries = await OrgMetadataCache.getFieldsAndRelations(org, c);
            if (entries.length > 0) return { sobject: c, entries };
        }
        return null;
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
        const beforeLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            windowLines.push(document.lineAt(i).text);
        }
        // Text from the top of the window up to the cursor — lets a SELECT (and
        // relationship path) that began on an earlier line be detected.
        for (let i = startLine; i < position.line; i++) {
            beforeLines.push(document.lineAt(i).text);
        }
        beforeLines.push(textUpToCursor);
        const surroundingText = windowLines.join('\n');
        const beforeCursor = beforeLines.join('\n');
        // Text from the cursor onward (rest of line + a few lines) — lets us tell whether an
        // annotation being typed sits above a class or a method.
        const afterParts: string[] = [lineText.substring(position.character)];
        for (let i = position.line + 1; i <= Math.min(document.lineCount - 1, position.line + 4); i++) {
            afterParts.push(document.lineAt(i).text);
        }
        const afterText = afterParts.join('\n');

        try {
            const raw = await ApexCompletionProvider.getItems(textUpToCursor, surroundingText, null, beforeCursor, document.getText(), afterText);
            // Fires on every keystroke → throttle to a coarse "completion is used" signal.
            if (raw.length) Telemetry.throttledEvent("completion", 5 * 60 * 1000, { surface: "apex" });
            return raw.map(toVsCodeItem);
        } catch {
            return [];
        }
    }
}
