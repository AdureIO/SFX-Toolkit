import * as assert from "assert";
import { cleanNames, parseSuites, removeSuite, resolveRunTests, saveTarget, suiteClassNames, upsertSuite } from "../utils/testSuitesPure";

describe("testSuitesPure", () => {
	const a = { name: "A", testClassNames: ["T1", "T2"] };
	const b = { name: "B", testClassNames: ["T3"] };

	it("parseSuites keeps valid suites and drops malformed ones", () => {
		const raw = { suites: [a, { name: "", testClassNames: [] }, { testClassNames: ["x"] }, { name: "C", testClassNames: "no" }, null, { name: "D", testClassNames: ["x", 1, " x ", ""] }] };
		assert.deepStrictEqual(parseSuites(raw), [a, { name: "C", testClassNames: [] }, { name: "D", testClassNames: ["x"] }]);
		assert.deepStrictEqual(parseSuites(null), []);
		assert.deepStrictEqual(parseSuites({ suites: "x" }), []);
	});

	it("cleanNames trims, dedupes and keeps order", () => {
		assert.deepStrictEqual(cleanNames([" B ", "A", "B", 3, ""]), ["B", "A"]);
		assert.deepStrictEqual(cleanNames(undefined), []);
	});

	it("upsertSuite replaces by name or appends, without mutating", () => {
		const list = [a, b];
		const out = upsertSuite(list, { name: "A", testClassNames: ["Z"] });
		assert.deepStrictEqual(out, [{ name: "A", testClassNames: ["Z"] }, b]);
		assert.deepStrictEqual(list, [a, b]);
		assert.deepStrictEqual(upsertSuite(list, { name: "C", testClassNames: [] }).map((s) => s.name), ["A", "B", "C"]);
	});

	it("removeSuite", () => {
		assert.deepStrictEqual(removeSuite([a, b], "A"), [b]);
		assert.deepStrictEqual(removeSuite([a, b], "X"), [a, b]);
	});

	it("saveTarget: the selected suite is overwritten, none asks for a name", () => {
		assert.strictEqual(saveTarget(" A "), "A");
		assert.strictEqual(saveTarget(""), null);
		assert.strictEqual(saveTarget(undefined), null);
	});

	it("suiteClassNames", () => {
		assert.deepStrictEqual(suiteClassNames([a, b], "B"), ["T3"]);
		assert.strictEqual(suiteClassNames([a, b], ""), null);
		assert.strictEqual(suiteClassNames([a, b], "X"), null);
	});

	it("resolveRunTests: recorded tests win, else the checked classes", () => {
		assert.deepStrictEqual(resolveRunTests(["R1"], ["C1"]), ["R1"]);
		assert.deepStrictEqual(resolveRunTests([], ["C1", "C1", "C2"]), ["C1", "C2"]);
		assert.deepStrictEqual(resolveRunTests(undefined, []), []);
	});
});
