import * as vscode from 'vscode';
import {
    getRemoveFinalNewlineEnabled,
    getRemoveFinalNewlineLanguages,
    getRemoveFinalNewlinePatterns,
    getRemoveFinalNewlineRunOnSave
} from './constants';
import { computeTrailingNewlineLength, shouldStripFor } from './removeFinalNewline';
import { Logger } from './outputChannel';

/**
 * Registers the onWillSaveTextDocument listener that strips trailing EOF newlines
 * for documents matching the workspace configuration. The listener is always
 * registered; runtime gating is driven entirely by configuration so users can
 * toggle the feature without restarting the extension.
 */
export function registerRemoveFinalNewlineHook(context: vscode.ExtensionContext): void {
    const subscription = vscode.workspace.onWillSaveTextDocument((event) => {
        try {
            const edits = computeStripEditsForSave(event.document);
            if (edits.length > 0) {
                event.waitUntil(Promise.resolve(edits));
            }
        } catch (error) {
            Logger.error('removeFinalNewline: failed to evaluate save hook', error);
        }
    });

    context.subscriptions.push(subscription);
}

/**
 * Helper function that resolves the document/configuration gates and returns the
 * TextEdit array (empty when no work is required). Exported for potential reuse
 * by a manual command in the future.
 */
export function computeStripEditsForSave(document: vscode.TextDocument): vscode.TextEdit[] {
    if (!getRemoveFinalNewlineEnabled() || !getRemoveFinalNewlineRunOnSave()) {
        return [];
    }

    if (document.uri.scheme !== 'file' || document.isUntitled) {
        return [];
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        return [];
    }

    const relPath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');

    const ok = shouldStripFor({
        enabled: true,
        languageId: document.languageId,
        relPath,
        languages: getRemoveFinalNewlineLanguages(),
        patterns: getRemoveFinalNewlinePatterns()
    });
    if (!ok) {
        return [];
    }

    const text = document.getText();
    const trailing = computeTrailingNewlineLength(text);
    if (trailing === 0) {
        return [];
    }

    const endOffset = text.length;
    const startOffset = endOffset - trailing;
    const range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));

    Logger.info(`removeFinalNewline: stripped ${trailing} trailing newline char(s) from ${relPath}`);
    return [vscode.TextEdit.delete(range)];
}
