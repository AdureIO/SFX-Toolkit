/**
 * A stored preset as a webview sees it (Deploy & Retrieve Metadata): its components, whatever the
 * file stored. Pure (no `vscode`).
 */
import { RelComponent, presetComponents } from "./deployComponentsPure";
import { DeployPreset, DeployTypeKey } from "./presetsPure";

export interface WebPreset {
	name: string;
	/** `Type:fullName` keys (an old path-only preset is mapped through the local index). */
	components: string[];
	deployType: DeployTypeKey;
	testClassNames: string[];
	targetOrg?: string;
	validateOnly?: boolean;
	/** Paths of an old preset that matched no component. */
	unmatched: number;
}

export function toWebPreset(p: DeployPreset & { validateOnly?: boolean }, rel: readonly RelComponent[]): WebPreset {
	const r = presetComponents(p, rel);
	return {
		name: p.name,
		components: r.keys,
		deployType: p.deployType,
		testClassNames: Array.isArray(p.testClassNames) ? p.testClassNames : [],
		targetOrg: p.targetOrg,
		validateOnly: p.validateOnly,
		unmatched: r.unmatched.length,
	};
}
