import * as vscode from "vscode";
import { ApexBufferBridge } from "./apexBufferBridge";
import { SoqlInputRouter } from "./soqlInputRouter";
import { getSoqlMarkers } from "../utils/soqlMarkers";

/**
 * Wiring for the Monaco SOQL inputs of form-style panels (Data Export, REST Explorer,
 * Data Migration): Monaco resource roots / URIs / CSP, and a SoqlInputRouter over a
 * SOQL ApexBufferBridge (one virtual buffer per panel — the panels are singletons, so
 * a fixed per-panel path is unique; on disk only in the no-server fallback).
 */

/** Folder the webview may load Monaco's AMD build from (add to localResourceRoots). */
export function monacoResourceRoot(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, "node_modules", "monaco-editor", "min");
}

/** Webview URI of Monaco's `vs` folder (loader.js lives here). */
export function monacoBaseUri(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	return webview.asWebviewUri(vscode.Uri.joinPath(monacoResourceRoot(extensionUri), "vs")).toString();
}

/**
 * CSP for a panel hosting Monaco. Same policy as the SOQL Builder / Workbench: Monaco's
 * loader needs 'unsafe-eval' and blob: workers; 'unsafe-inline' stays because these
 * panels use inline event handlers (onclick=…), which a nonce would block.
 */
export function monacoPanelCsp(cspSource: string): string {
	return `default-src 'none'; script-src ${cspSource} 'unsafe-eval' 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} data:; worker-src blob:; connect-src ${cspSource};`;
}

/** Create the router for a panel's SOQL input. Dispose it with the panel. */
export function createSoqlInputRouter(bufferRelativePath: string, webview: vscode.Webview): SoqlInputRouter {
	return new SoqlInputRouter(
		new ApexBufferBridge(bufferRelativePath, "soql"),
		(m) => webview.postMessage(m),
		(org, text) => getSoqlMarkers(org, text),
	);
}
