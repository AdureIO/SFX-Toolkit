/**
 * The test-class tree of the deploy options (Deploy panel, Deploy & Retrieve Center): folders of the
 * project's test classes with checkboxes (`.test-class`, `.test-folder-check`), a search filter and the
 * expand / collapse toggles. One tree per webview: the elements are found by the ids the caller passes.
 */
import { esc } from "./filterBar";

export interface TestNode {
	label: string;
	path: string;
	children?: TestNode[];
}

/** Inline folders with 0 or 1 child into their parent, then collapse single-child chains. */
function mergeFewChildFoldersIntoParent(nodes: TestNode[]): TestNode[] {
	return nodes.map((node) => {
		if (!node.children || node.children.length === 0) return node;
		const children = mergeFewChildFoldersIntoParent(node.children);
		const out: TestNode[] = [];
		for (const c of children) {
			if (!c.children) out.push(c);
			else if (c.children.length === 0) continue;
			else if (c.children.length === 1) out.push(c.children[0]);
			else out.push(c);
		}
		return { label: node.label, path: node.path, children: out };
	});
}

function collapseSingleChildInTree(nodes: TestNode[]): TestNode[] {
	return nodes.map((node) => {
		if (!node.children || node.children.length === 0) return node;
		if (node.children.length !== 1) return { label: node.label, path: node.path, children: collapseSingleChildInTree(node.children) };
		const only = node.children[0];
		if (!only.children || only.children.length === 0) return { label: node.label, path: node.path, children: node.children };
		const collapsed = collapseSingleChildInTree([only])[0];
		return { label: node.label + "/" + collapsed.label, path: collapsed.path, children: collapsed.children || [] };
	});
}

interface TestObjNode {
	children: Record<string, TestObjNode>;
	leaf?: boolean;
	label?: string;
	path?: string;
}

export function buildTestTree(items: { label: string; description: string }[]): TestNode[] {
	const root: TestObjNode = { children: {} };
	for (const t of items) {
		const path = (t.description || t.label || "").replace(/\\/g, "/").split("/").filter(Boolean);
		let curr = root;
		for (let i = 0; i < path.length; i++) {
			const seg = path[i];
			if (i === path.length - 1) {
				curr.children[seg] = { children: {}, leaf: true, label: t.label, path: path.join("/") };
			} else {
				if (!curr.children[seg] || curr.children[seg].leaf) curr.children[seg] = { children: {} };
				curr = curr.children[seg];
			}
		}
	}
	const convert = (o: TestObjNode, segment: string, pathSoFar: string): TestNode => {
		const path = pathSoFar ? pathSoFar + "/" + segment : segment;
		if (o.leaf) return { label: o.label!, path: o.path! };
		return { label: segment, path, children: Object.keys(o.children).sort().map((k) => convert(o.children[k], k, path)) };
	};
	const arr = Object.keys(root.children).sort().map((k) => convert(root.children[k], k, ""));
	return collapseSingleChildInTree(mergeFewChildFoldersIntoParent(arr));
}

function countNodes(n: TestNode): number {
	if (!n.children || n.children.length === 0) return 1;
	return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

function testNodeHtml(node: TestNode): string {
	if (!node.children || node.children.length === 0) {
		return `<label class="tree-node file-node" data-search-text="${esc((node.path || "").toLowerCase())}"><input type="checkbox" class="test-class" value="${esc(node.label)}"><span class="file-icon" aria-hidden="true">📄</span><span class="label-text">${esc(node.label)}</span></label>`;
	}
	const count = countNodes(node);
	return (
		`<div class="tree-node folder-node" data-search-text="${esc((node.path || node.label || "").toLowerCase())}">` +
		`<div class="folder-row"><label class="row-label"><input type="checkbox" class="test-folder-check" aria-label="Select all in folder"><span class="folder-icon" aria-hidden="true">📁</span><span class="label-text">${esc(node.label)} (${count})</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>` +
		`<div class="node-children">${node.children.map(testNodeHtml).join("")}</div></div>`
	);
}

export function testTreeHtml(data: TestNode[]): string {
	if (!data.length) return "<p>No test classes found.</p>";
	let html = "";
	for (const pkg of data) {
		const children = pkg.children ?? [];
		if (children.length === 0) {
			html += testNodeHtml(pkg);
			continue;
		}
		const count = countNodes(pkg);
		html +=
			`<div class="tree-node package-node" data-search-text="${esc((pkg.path || pkg.label || "").toLowerCase())}">` +
			`<div class="package-row"><label class="row-label"><input type="checkbox" class="test-folder-check" aria-label="Select all in folder"><span class="folder-icon" aria-hidden="true">📂</span><span class="label-text">${esc(pkg.label)} (${count})</span></label><button type="button" class="btn-toggle" title="Expand/Collapse">▼</button></div>` +
			`<div class="package-children">${children.map(testNodeHtml).join("")}</div></div>`;
	}
	return html;
}

export function filterTestList(list: HTMLElement, searchText: string): void {
	const search = searchText.trim().toLowerCase();
	const nodes = list.querySelectorAll<HTMLElement>(".tree-node");
	if (!search) {
		nodes.forEach((n) => (n.style.display = ""));
		return;
	}
	nodes.forEach((n) => (n.style.display = "none"));
	const showAncestors = (start: HTMLElement | null) => {
		let el: HTMLElement | null = start;
		while (el) {
			el.style.display = "";
			el = el.parentElement ? el.parentElement.closest<HTMLElement>(".tree-node") : null;
		}
	};
	list.querySelectorAll<HTMLElement>(".tree-node.file-node[data-search-text]").forEach((n) => {
		if ((n.getAttribute("data-search-text") || "").includes(search)) showAncestors(n);
	});
	list.querySelectorAll<HTMLElement>(".tree-node.folder-node[data-search-text]").forEach((n) => {
		if ((n.getAttribute("data-search-text") || "").includes(search)) {
			showAncestors(n);
			n.style.display = "";
			n.querySelectorAll<HTMLElement>(".tree-node").forEach((d) => (d.style.display = ""));
		}
	});
}

/** Render the tree into `list` and wire its toggles; `onChange` runs after a checkbox changed. */
export function mountTestTree(list: HTMLElement, items: { label: string; description: string }[], onChange: () => void): void {
	if (!items.length) {
		list.innerHTML = "<p>No test classes found.</p>";
		return;
	}
	list.innerHTML = testTreeHtml(buildTestTree(items));
	list.querySelectorAll<HTMLElement>(".btn-toggle").forEach((btn) => {
		btn.onclick = () => {
			const node = btn.closest(".package-row, .folder-row")?.closest(".tree-node");
			const children = node && (node.querySelector<HTMLElement>(".package-children") || node.querySelector<HTMLElement>(".node-children"));
			if (!children) return;
			const hidden = children.style.display === "none";
			children.style.display = hidden ? "block" : "none";
			btn.textContent = hidden ? "▼" : "▶";
		};
	});
	list.querySelectorAll<HTMLElement>(".package-row .row-label, .folder-row .row-label").forEach((lbl) => {
		lbl.onclick = (e) => {
			if ((e.target as HTMLInputElement).type === "checkbox") return;
			e.preventDefault();
			e.stopPropagation();
			lbl.closest(".package-row, .folder-row")?.querySelector<HTMLElement>(".btn-toggle")?.click();
		};
	});
	list.querySelectorAll<HTMLInputElement>(".test-folder-check").forEach((cb) => {
		cb.onchange = () => {
			const folder = cb.closest(".folder-node, .package-node");
			folder?.querySelectorAll<HTMLInputElement>(".test-class").forEach((c) => (c.checked = cb.checked));
			onChange();
		};
	});
	list.querySelectorAll<HTMLInputElement>(".test-class").forEach((cb) => {
		cb.onchange = onChange;
	});
}
