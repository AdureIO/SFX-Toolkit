import * as assert from "assert";
import { hiddenSelectionPrompt, hiddenTypeLines, splitByVisibility, summarizeByType } from "../utils/orgBrowser/selection";

const keys = (type: string, n: number) => Array.from({ length: n }, (_, i) => `${type}:${type}${i}`);

describe("orgBrowser selection helpers", () => {
	it("splits a selection into visible and hidden, keeping order", () => {
		const r = splitByVisibility(["A:1", "B:2", "A:3"], new Set(["B:2"]));
		assert.deepStrictEqual(r, { visible: ["B:2"], hidden: ["A:1", "A:3"] });
	});

	it("summarises per type, largest first then by name", () => {
		const s = summarizeByType([...keys("ApexTrigger", 9), ...keys("ApexClass", 98), ...keys("Flow", 9)]);
		assert.deepStrictEqual(s, [
			{ type: "ApexClass", count: 98 },
			{ type: "ApexTrigger", count: 9 },
			{ type: "Flow", count: 9 },
		]);
	});

	it("keeps names containing colons intact (only the first colon splits)", () => {
		assert.deepStrictEqual(summarizeByType(["Layout:Account-Account Layout:v2"]), [{ type: "Layout", count: 1 }]);
	});

	it("limits the modal to five lines and folds the rest", () => {
		const hidden = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"].flatMap((t, i) => keys(t, 10 - i));
		const lines = hiddenTypeLines(hidden);
		assert.strictEqual(lines.length, 5);
		assert.deepStrictEqual(lines.slice(0, 4), ["10 T1", "9 T2", "8 T3", "7 T4"]);
		assert.strictEqual(lines[4], "15 in 3 other types");
		assert.deepStrictEqual(hiddenTypeLines(keys("ApexClass", 2)), ["2 ApexClass"]);
	});

	it("builds the modal text", () => {
		const p = hiddenSelectionPrompt(113, [...keys("ApexClass", 98), ...keys("ApexTrigger", 9)]);
		assert.strictEqual(p.message, "Retrieve 113 components?");
		assert.strictEqual(p.detail, "107 of them are hidden by the current filter:\n98 ApexClass\n9 ApexTrigger");
		assert.strictEqual(hiddenSelectionPrompt(2, ["Flow:F"]).detail, "1 of them is hidden by the current filter:\n1 Flow");
	});
});
