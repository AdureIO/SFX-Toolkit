/** Scheme of the virtual documents backing the workbench editors (see VIRTUAL_BUFFER_SCHEME). */
const VIRTUAL_SCHEME = "asfx-buffer";

/**
 * Whether diagnostics published for `uri` should reach VS Code's Problems panel.
 * Virtual workbench buffers can't be opened by the user, so their diagnostics are
 * dropped (webviews get their markers through getSoqlMarkers, not the LS push).
 */
export function shouldForwardDiagnostics(uri: string): boolean {
	return !uri.toLowerCase().startsWith(`${VIRTUAL_SCHEME}:`);
}
