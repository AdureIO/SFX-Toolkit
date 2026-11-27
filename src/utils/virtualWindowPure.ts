/**
 * Visible window of a fixed-line-height virtual list.
 * NOTE: the Apex Workbench inline webview script (ApexWorkbenchViewProvider.makeViewer)
 * duplicates this formula; keep both in sync.
 * Returns the half-open range [first, last) of line indexes to render.
 */
export function virtualWindow(
	scrollTop: number,
	viewportHeight: number,
	lineHeight: number,
	count: number,
	overscan: number
): { first: number; last: number } {
	if (count <= 0 || lineHeight <= 0) return { first: 0, last: 0 };
	const top = Math.max(0, scrollTop);
	const first = Math.min(count, Math.max(0, Math.floor(top / lineHeight) - overscan));
	const last = Math.min(count, Math.ceil((top + Math.max(0, viewportHeight)) / lineHeight) + overscan);
	return { first, last: Math.max(first, last) };
}
