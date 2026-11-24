/** Markup and styles of the test-suite controls (mounted by webview/shared/testSuites.ts), shared by the Deploy panel and the Center. */

export const TEST_SUITE_CSS = `
.suite-row { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
.suite-row .suite-select { flex: 1; min-width: 0; }
.btn-suite { display: inline-flex; align-items: center; justify-content: center; padding: 4px 9px; font-size: 11px; cursor: pointer; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-family: inherit; white-space: nowrap; flex-shrink: 0; }
.btn-suite:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); border-color: var(--vscode-focusBorder); }
.btn-suite-delete { color: var(--vscode-errorForeground); }
`;

/** The row of controls (ids: suite-select, btn-save-suite, btn-delete-suite; `idPrefix` prefixes them for a second set on one page). */
export function testSuiteRowHtml(selectClass = "", idPrefix = ""): string {
	return (
		`<div class="suite-row">` +
		`<select id="${idPrefix}suite-select" class="${selectClass} suite-select" aria-label="Test suite"></select>` +
		`<button type="button" id="${idPrefix}btn-save-suite" class="btn-suite" title="Save selected tests as a named suite">Save suite</button>` +
		`<button type="button" id="${idPrefix}btn-delete-suite" class="btn-suite btn-suite-delete" title="Delete this suite" style="display:none;">🗑</button>` +
		`</div>`
	);
}
