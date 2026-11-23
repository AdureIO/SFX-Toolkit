import * as assert from "assert";
import {
	DEFAULT_FILTER,
	FilterContext,
	FilterState,
	ORG_BROWSER_VOCAB,
	StatusVocab,
	buildIndex,
	computeFacets,
	filterIndices,
	parseQuery,
	statusTest,
} from "../utils/orgBrowser/filter";
import { Comp } from "../utils/orgBrowser/types";

const NOW = Date.parse("2025-06-15T12:00:00Z");

function comp(t: string, n: string): Comp {
	return { t, n, ns: "", ms: "", by: "", bi: "", lm: 0, cd: 0, id: "", f: "" };
}

/** A flags vocabulary like the Deploy panel's (several statuses per row). */
const A = 1;
const B = 2;
const C = 4;
const FLAGS: StatusVocab = {
	names: ["alpha", "beta", "gamma"],
	flags: true,
	aliases: { a: "alpha", b: "beta" },
	shorthands: { both: (v) => (v & (A | C)) === (A | C) },
};

const ROWS = [comp("ApexClass", "R0"), comp("ApexClass", "R1"), comp("ApexClass", "R2"), comp("ApexClass", "R3"), comp("Flow", "R4")];
const VALUES = Uint8Array.from([0, A, A | C, B, B | C]);

const run = (state: Partial<FilterState>, ctx: Partial<FilterContext> = {}) => {
	const idx = buildIndex(ROWS);
	const c: FilterContext = { now: NOW, status: VALUES, vocab: FLAGS, ...ctx };
	return filterIndices(idx, { ...DEFAULT_FILTER, ...state }, c).map((i) => ROWS[i].n);
};

describe("filter: status vocabulary", () => {
	it("keeps the Org Browser vocabulary as the default", () => {
		const q = parseQuery("status:changed status:bogus");
		assert.strictEqual(q.status.length, 1);
		assert.strictEqual(q.status[0].value(2), true);
		assert.strictEqual(q.status[0].value(1), false);
		assert.deepStrictEqual(ORG_BROWSER_VOCAB.names, ["not-local", "local", "changed", "partial"]);
	});

	it("statusTest: a code vocabulary compares the code, a flags vocabulary tests the bit", () => {
		assert.strictEqual(statusTest(ORG_BROWSER_VOCAB, "local")(1), true);
		assert.strictEqual(statusTest(ORG_BROWSER_VOCAB, "local")(3), false);
		assert.strictEqual(statusTest(FLAGS, "gamma")(A | C), true);
		assert.strictEqual(statusTest(FLAGS, "gamma")(A), false);
		assert.strictEqual(statusTest(FLAGS, "nope")(7), false);
	});

	it("status: in a flags vocabulary matches every row carrying the flag; tokens are ORed", () => {
		assert.deepStrictEqual(run({ query: "status:gamma" }), ["R2", "R4"]);
		assert.deepStrictEqual(run({ query: "status:alpha status:beta" }), ["R1", "R2", "R3", "R4"]);
		assert.deepStrictEqual(run({ query: "status:a" }, {}), ["R1", "R2"]); // alias
		assert.deepStrictEqual(run({ query: "-status:gamma" }), ["R0", "R1", "R3"]);
	});

	it("status: shorthands can be an AND over flags", () => {
		assert.deepStrictEqual(run({ query: "status:both" }), ["R2"]);
		assert.deepStrictEqual(run({ query: "status:both type:ApexClass" }), ["R2"]);
	});

	it("the status facet filter uses the vocabulary and ORs its values", () => {
		assert.deepStrictEqual(run({ status: ["gamma"] }), ["R2", "R4"]);
		assert.deepStrictEqual(run({ status: ["alpha", "beta"] }), ["R1", "R2", "R3", "R4"]);
		assert.deepStrictEqual(run({ status: ["unknown-name"] }), []);
	});

	it("facet counts count a row once per flag it carries; a missing status array counts as none", () => {
		const idx = buildIndex(ROWS);
		const f = computeFacets(idx, { ...DEFAULT_FILTER }, { now: NOW, status: VALUES, vocab: FLAGS });
		assert.deepStrictEqual(f.status, [2, 2, 2]);
		const none = computeFacets(idx, { ...DEFAULT_FILTER }, { now: NOW, status: null, vocab: FLAGS });
		assert.deepStrictEqual(none.status, [0, 0, 0]);
		// Org Browser default vocabulary: one code per row.
		const org = computeFacets(idx, { ...DEFAULT_FILTER }, { now: NOW, status: Uint8Array.from([0, 1, 1, 2, 3]) });
		assert.deepStrictEqual(org.status, [1, 2, 1, 1]);
	});

	it("the status facet ignores its own filter only", () => {
		const idx = buildIndex(ROWS);
		const f = computeFacets(idx, { ...DEFAULT_FILTER, status: ["gamma"], types: ["Flow"] }, { now: NOW, status: VALUES, vocab: FLAGS });
		assert.deepStrictEqual(f.status, [0, 1, 1]); // only the Flow row (R4 = beta+gamma), whatever the status filter
	});
});
