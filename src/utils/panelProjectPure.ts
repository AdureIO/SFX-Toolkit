/**
 * Pure (no vscode) rules of a panel's project selector.
 * A panel follows the active project until the user picks another one in its own selector
 * (it is then "pinned"); picking the active project again unpins it.
 */
import { samePath } from "./projectDiscoveryPure";

export interface PanelProjectInfo {
	dir: string;
	name: string;
	kind: "sfdx" | "mdapi";
}

export interface PanelProjectOption {
	dir: string;
	name: string;
	kind: "sfdx" | "mdapi";
	/** Display label of the project's default org ("" when it has none). */
	defaultOrgLabel: string;
	/** This is the global active project. */
	active: boolean;
}

/** Dir the panel shows: the pinned project while it still exists, else the active one. */
export function resolveCurrentDir(
	projects: readonly { dir: string }[],
	activeDir: string | undefined,
	pinnedDir: string | undefined
): string | undefined {
	if (pinnedDir) {
		const hit = projects.find((p) => samePath(p.dir, pinnedDir));
		if (hit) return hit.dir;
	}
	if (activeDir) {
		const hit = projects.find((p) => samePath(p.dir, activeDir));
		if (hit) return hit.dir;
	}
	return activeDir;
}

/** New pin after the user picked `picked`: picking the active project unpins. */
export function pinAfterPick(activeDir: string | undefined, picked: string): string | undefined {
	return samePath(activeDir, picked) ? undefined : picked;
}

/** The pin, or undefined when that project no longer exists. */
export function reconcilePin(projects: readonly { dir: string }[], pinnedDir: string | undefined): string | undefined {
	if (!pinnedDir) return undefined;
	return projects.some((p) => samePath(p.dir, pinnedDir)) ? pinnedDir : undefined;
}

export function buildOptions(
	projects: readonly PanelProjectInfo[],
	activeDir: string | undefined,
	orgLabelOf: (dir: string) => string
): PanelProjectOption[] {
	return projects.map((p) => ({
		dir: p.dir,
		name: p.name,
		kind: p.kind,
		defaultOrgLabel: orgLabelOf(p.dir),
		active: samePath(p.dir, activeDir),
	}));
}

/** The selector is shown only when there is something to choose. */
export function selectorVisible(projectCount: number): boolean {
	return projectCount > 1;
}
