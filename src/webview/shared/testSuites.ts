/**
 * The test-suite controls of the deploy options (Deploy & Retrieve Metadata): a select of the saved
 * suites, "Save suite" and delete. Selecting a suite checks its classes in the test tree. The suites live in
 * the project (utils/testSuites.ts); the host messages are handled by providers/testSuitesHost.ts.
 * Markup and styles: utils/testSuitesHtml.ts.
 */
import { esc } from "./filterBar";
import { suiteClassNames, type TestSuite } from "../../utils/testSuitesPure";

export type { TestSuite } from "../../utils/testSuitesPure";

export interface TestSuitesOptions {
	/** Post a message to the host. */
	post: (msg: Record<string, unknown>) => void;
	/** The test classes checked in the tree. */
	checked: () => string[];
	/** After a suite was applied to the tree (the caller refreshes its dirty state / counts). */
	onApplied: () => void;
	/** Show a status line (e.g. "Select test classes to save as a suite."). */
	setStatus: (text: string) => void;
	/** Second set of controls on one page: the prefix of the ids (`testSuiteRowHtml(…, idPrefix)`). */
	idPrefix?: string;
	/** The element whose `.test-class` checkboxes a suite applies to (default: the whole document). */
	scope?: () => ParentNode;
}

export interface TestSuites {
	/** The host sent the saved suites (initially, after a save / delete, or when the other panel changed them). */
	setSuites(list: TestSuite[]): void;
	/** Select a suite by name (e.g. when restoring state); does not touch the tree. */
	select(name: string): void;
	/** The selected suite's name, or "". */
	selected(): string;
}

/** Wire the controls of `testSuiteRowHtml` (already in the DOM). */
export function mountTestSuites(opts: TestSuitesOptions): TestSuites {
	const pre = opts.idPrefix ?? "";
	const sel = document.getElementById(pre + "suite-select") as HTMLSelectElement;
	const del = document.getElementById(pre + "btn-delete-suite") as HTMLElement;
	const save = document.getElementById(pre + "btn-save-suite") as HTMLElement;
	let suites: TestSuite[] = [];

	const syncDelete = () => {
		del.style.display = sel.value ? "" : "none";
	};
	const render = () => {
		const cur = sel.value;
		sel.innerHTML = '<option value="">— No suite —</option>' + suites.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.testClassNames.length})</option>`).join("");
		if (cur) sel.value = cur;
		syncDelete();
	};

	sel.onchange = () => {
		syncDelete();
		const names = suiteClassNames(suites, sel.value);
		if (!names) return;
		for (const cb of (opts.scope?.() ?? document).querySelectorAll<HTMLInputElement>(".test-class")) cb.checked = names.includes(cb.value);
		opts.onApplied();
	};
	save.onclick = () => {
		const names = opts.checked();
		if (!names.length) {
			opts.setStatus("Select test classes to save as a suite.");
			return;
		}
		opts.post({ command: "saveTestSuite", suiteName: sel.value || "", testClassNames: names });
	};
	del.onclick = () => {
		if (sel.value) opts.post({ command: "deleteTestSuite", suiteName: sel.value });
	};

	return {
		setSuites(list) {
			suites = (Array.isArray(list) ? list : []).map((s) => ({ name: s.name, testClassNames: Array.isArray(s.testClassNames) ? s.testClassNames : [] }));
			render();
		},
		select(name) {
			sel.value = name;
			syncDelete();
		},
		selected: () => sel.value,
	};
}
