/**
 * Pure decision + wording for the one-time "save RAM" recommendation about the
 * Salesforce extensions. No vscode import.
 */

export const JORJE_EXTENSION_ID = "salesforce.salesforcedx-vscode-apex";
export const TS_APEX_EXTENSION_ID = "salesforce.apex-language-server-extension";
export const JORJE_MEMORY_SECTION = "salesforcedx-vscode-apex";
export const JORJE_MEMORY_KEY = "java.memory";
export const JORJE_MEMORY_LIMIT_MB = 1024;
export const MEMORY_TIP_SHOWN_KEY = "adure-sfx-toolkit.memoryTipShown";

export interface MemoryTipInputs {
	jorjeInstalled: boolean;
	/** Current value of `salesforcedx-vscode-apex.java.memory` (null/undefined = unset). */
	jorjeMemory: unknown;
	/** TS Apex server extension installed and enabled. */
	tsServerEnabled: boolean;
	/** Already shown on this machine. */
	alreadyShown: boolean;
	/** Invoked from the command: ignore `alreadyShown`. */
	force: boolean;
}

export interface MemoryTipPlan {
	show: boolean;
	offerLimitJorje: boolean;
	offerShowTsServer: boolean;
}

/** `java.memory` counts as set only when it is a finite number. */
export function isJorjeMemorySet(v: unknown): boolean {
	return typeof v === "number" && Number.isFinite(v);
}

export function planMemoryTip(i: MemoryTipInputs): MemoryTipPlan {
	const offerLimitJorje = i.jorjeInstalled && !isJorjeMemorySet(i.jorjeMemory);
	const offerShowTsServer = i.tsServerEnabled;
	const eligible = offerLimitJorje || offerShowTsServer;
	const show = eligible && (i.force || !i.alreadyShown);
	return { show, offerLimitJorje: show && offerLimitJorje, offerShowTsServer: show && offerShowTsServer };
}

export function memoryTipMessage(p: Pick<MemoryTipPlan, "offerLimitJorje" | "offerShowTsServer">): string {
	const parts = ["ASFX Toolkit already answers Apex completion, hover, definition and references, so the Salesforce extensions can be slimmed down to save RAM."];
	if (p.offerLimitJorje) {
		parts.push("The Salesforce Apex language server (Java) has no memory cap and often uses 1 to 2.4 GB per window.");
	}
	if (p.offerShowTsServer) {
		parts.push(
			"The Apex Language Server (TypeScript) extension uses about 1.7 GB per window and only provides the outline. Note: it provides Apex syntax highlighting together with the Salesforce Apex extension, so do not disable it if you remove that extension.",
		);
	}
	return parts.join(" ");
}
