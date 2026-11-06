/**
 * Deploy Metadata panel: pure selection logic.
 *
 * Single source of truth is the set of selected LEAF paths (plus extra git/preset
 * paths that are not in the tree). Folder checkboxes are display-only: they never
 * decide what gets deployed. The minimal path list is always computed against the
 * FULL unfiltered tree, so a filter that hides siblings can never widen a selection.
 *
 * The logic lives in a plain-JS source string (DEPLOY_SELECTION_SOURCE) that is
 * inlined verbatim into the webview script (same pattern as resultsTableScript) and
 * evaluated by the unit tests, so the tests exercise exactly what ships.
 */

export interface TreeNode {
  label?: string;
  path: string;
  children?: TreeNode[];
}

export type FolderState = "checked" | "indeterminate" | "unchecked";

export interface TreeIndex {
  /** normalized folder path -> normalized leaf paths under it (full tree) */
  leavesUnder: Map<string, string[]>;
  /** all normalized leaf paths of the full tree */
  leafSet: Set<string>;
}

export interface DeploySelectionApi {
  dsNorm(p: string): string;
  dsBuildIndex(treeData: TreeNode[]): TreeIndex;
  dsMinimalPaths(treeData: TreeNode[], selected: Iterable<string>): string[];
  dsFolderState(index: TreeIndex, selected: Set<string>, folderPath: string): FolderState;
  dsApplyFolderToggle(selected: Set<string>, visibleLeafPaths: string[], check: boolean): Set<string>;
  dsCountByLeaf(selected: Iterable<string>): string[];
}

export const DEPLOY_SELECTION_SOURCE: string = String.raw`
function dsNorm(p) {
	if (!p) return '';
	var s = String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
	return s.split('/').filter(Boolean).join('/');
}
/** Index the FULL tree: every folder path -> leaves beneath it. Nodes without children are leaves. */
function dsBuildIndex(treeData) {
	var leavesUnder = new Map();
	var leafSet = new Set();
	function walk(node) {
		var np = dsNorm(node.path);
		if (!node.children || node.children.length === 0) {
			if (np) leafSet.add(np);
			return np ? [np] : [];
		}
		var acc = [];
		node.children.forEach(function(c) { walk(c).forEach(function(l) { acc.push(l); }); });
		if (np) leavesUnder.set(np, acc);
		return acc;
	}
	(treeData || []).forEach(function(n) { walk(n); });
	return { leavesUnder: leavesUnder, leafSet: leafSet };
}
/**
 * Minimal deploy paths for a leaf selection, computed against the full tree.
 * A folder is emitted only when EVERY leaf under it is selected; otherwise the
 * individual selected leaves are emitted. Selected paths that are not in the tree
 * (git/preset extras) are emitted as-is. A selected path that is a tree folder is
 * treated as "all leaves under it".
 */
function dsMinimalPaths(treeData, selected) {
	var idx = dsBuildIndex(treeData);
	var sel = new Set();
	var extras = [];
	var seenExtra = new Set();
	Array.from(selected || []).forEach(function(raw) {
		var p = dsNorm(raw);
		if (!p) return;
		if (idx.leafSet.has(p)) { sel.add(p); return; }
		if (idx.leavesUnder.has(p)) { idx.leavesUnder.get(p).forEach(function(l) { sel.add(l); }); return; }
		if (!seenExtra.has(p)) { seenExtra.add(p); extras.push(p); }
	});
	var out = [];
	function walk(node) {
		var np = dsNorm(node.path);
		if (!node.children || node.children.length === 0) {
			if (np && sel.has(np)) out.push(np);
			return;
		}
		var leaves = idx.leavesUnder.get(np) || [];
		if (np && leaves.length > 0 && leaves.every(function(l) { return sel.has(l); })) { out.push(np); return; }
		node.children.forEach(walk);
	}
	(treeData || []).forEach(walk);
	extras.forEach(function(p) { out.push(p); });
	return out;
}
/** Display state of a folder checkbox from the FULL tree (hidden leaves count). */
function dsFolderState(index, selected, folderPath) {
	var leaves = index.leavesUnder.get(dsNorm(folderPath)) || [];
	if (leaves.length === 0) return 'unchecked';
	var c = 0;
	for (var i = 0; i < leaves.length; i++) if (selected.has(leaves[i])) c++;
	if (c === 0) return 'unchecked';
	return c === leaves.length ? 'checked' : 'indeterminate';
}
/** Folder click: add/remove only the leaves currently VISIBLE under the folder. Returns a new set. */
function dsApplyFolderToggle(selected, visibleLeafPaths, check) {
	var next = new Set(selected);
	(visibleLeafPaths || []).forEach(function(p) {
		var np = dsNorm(p);
		if (!np) return;
		if (check) next.add(np); else next.delete(np);
	});
	return next;
}
/** Normalized, de-duplicated leaf list of a selection (used for counts / type summary). */
function dsCountByLeaf(selected) {
	var s = new Set();
	Array.from(selected || []).forEach(function(p) { var n = dsNorm(p); if (n) s.add(n); });
	return Array.from(s);
}
`;

/** Evaluate the shared source (used by tests and any host-side consumer). */
export function loadDeploySelection(): DeploySelectionApi {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(
    DEPLOY_SELECTION_SOURCE +
      "\nreturn { dsNorm: dsNorm, dsBuildIndex: dsBuildIndex, dsMinimalPaths: dsMinimalPaths, dsFolderState: dsFolderState, dsApplyFolderToggle: dsApplyFolderToggle, dsCountByLeaf: dsCountByLeaf };"
  )() as DeploySelectionApi;
}
