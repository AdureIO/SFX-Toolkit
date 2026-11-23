import * as assert from "assert";
import { applyShared, joinQuery, sameSharedFilter, sanitizeSharedFilter, sharedFilterKey, sharedPart, splitQuery } from "../utils/sharedFilterPure";

describe("shared metadata filter", () => {
	it("is keyed per project", () => {
		assert.strictEqual(sharedFilterKey("/work/proj-a"), "asfx.metadataFilter./work/proj-a");
		assert.notStrictEqual(sharedFilterKey("/work/a"), sharedFilterKey("/work/b"));
	});

	it("keeps status: tokens (each panel's own vocabulary) out of what is shared", () => {
		assert.deepStrictEqual(splitQuery('foo type:ApexClass status:conflict -status:new by:"Jo Do"'), {
			shared: 'foo type:ApexClass by:"Jo Do"',
			status: ["status:conflict", "-status:new"],
		});
		assert.deepStrictEqual(splitQuery(""), { shared: "", status: [] });
		assert.strictEqual(sharedPart({ query: "acc status:changed", types: ["Flow"] }).query, "acc");
	});

	it("a received query keeps the panel's own status: tokens and replaces the rest", () => {
		assert.deepStrictEqual(applyShared("old status:conflict", { query: "acc*", types: ["ApexClass", "Flow"] }), { query: "acc* status:conflict", types: ["ApexClass", "Flow"] });
		assert.deepStrictEqual(applyShared("only text", { query: "", types: [] }), { query: "", types: [] });
		assert.strictEqual(joinQuery("a b", []), "a b");
	});

	it("applying what a panel itself shares is a fixed point (no echo between the panels)", () => {
		const a = sharedPart({ query: "foo  bar status:x", types: ["Flow"] });
		const b = applyShared("status:y", a);
		assert.ok(sameSharedFilter(sharedPart({ query: b.query, types: b.types }), a));
	});

	it("sanitizes stored values", () => {
		assert.deepStrictEqual(sanitizeSharedFilter({ query: "x", types: ["A", "A", "", 3] }), { query: "x", types: ["A"] });
		assert.strictEqual(sanitizeSharedFilter(null), null);
		assert.strictEqual(sanitizeSharedFilter({ query: 1, types: [] }), null);
		assert.strictEqual(sanitizeSharedFilter({ query: "x" }), null);
	});

	it("compares values", () => {
		assert.ok(sameSharedFilter({ query: "a", types: ["x", "y"] }, { query: "a", types: ["x", "y"] }));
		assert.ok(!sameSharedFilter({ query: "a", types: ["x"] }, { query: "a", types: ["y"] }));
		assert.ok(!sameSharedFilter({ query: "a", types: [] }, null));
		assert.ok(sameSharedFilter(null, null));
	});
});
