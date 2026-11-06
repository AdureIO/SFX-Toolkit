/**
 * Signature help for user methods declared in the current file (gated by apexFeatures).
 */
import { Connection, ParameterInformation, SignatureHelp, SignatureInformation } from 'vscode-languageserver/node';
import type { ServerContext } from './context';
import { isApex } from './textUtil';

function parseParamsFromLabel(label: string): ParameterInformation[] {
    const open = label.indexOf('(');
    const close = label.lastIndexOf(')');
    if (open < 0 || close <= open) return [];
    const inner = label.slice(open + 1, close).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => ParameterInformation.create(p.trim()));
}

export function register(connection: Connection, ctx: ServerContext): void {
    connection.onSignatureHelp((params, token): SignatureHelp | null => {
        if (!ctx.settings.apexFeatures || token.isCancellationRequested) return null;
        const doc = ctx.documents.get(params.textDocument.uri);
        if (!doc || !isApex(doc.uri)) return null;
        const text = doc.getText();
        const offset = doc.offsetAt(params.position);
        const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
        const lineUpToCursor = text.slice(lineStart, offset);

        // Innermost open call: methodName( …args-so-far
        const m = /([A-Za-z_]\w*)\s*\(([^()]*)$/.exec(lineUpToCursor);
        if (!m) return null;
        const name = m[1];
        const argsSoFar = m[2];
        const activeParameter = argsSoFar.length ? (argsSoFar.match(/,/g)?.length ?? 0) : 0;

        // Read-only lookup by method name: the last completed parse is fine (no reparse per keystroke).
        const { index } = ctx.parses.forRead(doc).result;
        if (token.isCancellationRequested) return null;
        const sigs = index.methods.get(name);
        if (!sigs || !sigs.length) return null;

        const signatures: SignatureInformation[] = sigs.map((label) => ({
            label,
            parameters: parseParamsFromLabel(label),
        }));
        return { signatures, activeSignature: 0, activeParameter };
    });
}
