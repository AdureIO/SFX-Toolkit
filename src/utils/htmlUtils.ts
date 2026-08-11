/**
 * Tiny, dependency-free HTML helpers shared by the extension's webview providers (host side) and
 * the bundled webview scripts (browser side). No `vscode` import, so both esbuild targets can use it.
 */

/** A 32-char nonce for a webview Content-Security-Policy `script-src 'nonce-…'`. */
export function getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

/** Escape a value for safe interpolation into HTML text or a double/single-quoted attribute. */
export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
