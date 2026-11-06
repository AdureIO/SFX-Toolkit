import * as assert from "assert";
import {
	DEFAULT_FILTER,
	FilterContext,
	FilterState,
	buildIndex,
	computeFacets,
	filterIndices,
	highlightRanges,
	highlightTerms,
	matchPairs,
	parsePastedPairs,
	parseQuery,
	relativeTime,
	sortIndices,
	tokenize,
} from "../utils/orgBrowser/filter";
import { Comp } from "../utils/orgBrowser/types";

const NOW = Date.parse("2025-06-15T12:00:00Z");
const H = 3600_000;

function comp(t: string, n: string, extra: Partial<Comp> = {}): Comp {
	return { t, n, ns: "", ms: "unmanaged", by: "Jane Doe", bi: "005A", lm: NOW - 2 * H, cd: 0, id: "", f: "", ...extra };
}

const SAMPLE: Comp[] = [
	comp("ApexClass", "AccountHandler"),
	comp("ApexClass", "AccountHandlerTest", { by: "John Smith", bi: "005B" }),
	comp("ApexClass", "abc__ManagedThing", { ns: "abc", ms: "installed", lm: NOW - 40 * 24 * H }),
	comp("ApexTrigger", "AccountTrigger", { lm: NOW - 3 * 24 * H }),
	comp("CustomField", "Account.Region__c"),
	comp("Layout", "Account-Account Layout", { lm: 0 }),
	comp("Flow", "Case_Router", { by: "John Smith", bi: "005B", lm: NOW - 20 * H }),
];

const ctx = (extra: Partial<FilterContext> = {}): FilterContext => ({ now: NOW, status: null, ...extra });
const names = (rows: Comp[], state: Partial<FilterState>, c: FilterContext = ctx()) => {
	const idx = buildIndex(rows);
	return filterIndices(idx, { ...DEFAULT_FILTER, ...state }, c).map((i) => rows[i].n);
};

describe("orgBrowser filter: query parsing", () => {
	it("tokenizes quoted phrases", () => {
		assert.deepStrictEqual(tokenize('foo by:"John Smith" "a b"'), ["foo", 'by:"John Smith"', '"a b"']);
	});

	it("ANDs plain tokens over name and type, case-insensitively", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "account handler" }), ["AccountHandler", "AccountHandlerTest"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "ACCOUNT trigger" }), ["AccountTrigger"]); // matches type ApexTrigger
		assert.deepStrictEqual(names(SAMPLE, { query: "flow" }), ["Case_Router"]);
	});

	it("supports a leading - to exclude", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "account -test -trigger -layout -region" }), ["AccountHandler"]);
	});

	it("type: matches the type exactly, ORs repeated type: tokens, and allows wildcards", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "type:apexclass" }), ["AccountHandler", "AccountHandlerTest", "abc__ManagedThing"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "type:ApexTrigger type:Flow" }), ["AccountTrigger", "Case_Router"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "type:Apex*" }).length, 4);
		assert.deepStrictEqual(names(SAMPLE, { query: "type:Apex" }), []); // exact, not substring
		assert.deepStrictEqual(names(SAMPLE, { query: "-type:ApexClass -type:ApexTrigger" }), ["Account.Region__c", "Account-Account Layout", "Case_Router"]);
	});

	it("ns: filters by namespace prefix; ns:none means unmanaged", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "ns:abc" }), ["abc__ManagedThing"]);
		assert.strictEqual(names(SAMPLE, { query: "ns:none" }).length, SAMPLE.length - 1);
		assert.strictEqual(names(SAMPLE, { query: "ns:" }).length, SAMPLE.length - 1);
	});

	it("by: matches the last-modified-by name by substring, quoted for spaces", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "by:smith" }), ["AccountHandlerTest", "Case_Router"]);
		assert.deepStrictEqual(names(SAMPLE, { query: 'by:"john smith" type:flow' }), ["Case_Router"]);
	});

	it("status: uses the local status per row", () => {
		const status = new Uint8Array(SAMPLE.length);
		status[0] = 1;
		status[3] = 2;
		const c = ctx({ status });
		assert.deepStrictEqual(names(SAMPLE, { query: "status:local" }, c), ["AccountHandler"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "status:changed" }, c), ["AccountTrigger"]);
		assert.strictEqual(names(SAMPLE, { query: "status:not-local" }, c).length, SAMPLE.length - 2);
		assert.deepStrictEqual(names(SAMPLE, { query: "status:local status:changed" }, c), ["AccountHandler", "AccountTrigger"]);
		status[1] = 3;
		const cp = ctx({ status });
		assert.deepStrictEqual(names(SAMPLE, { query: "status:partial" }, cp), [SAMPLE[1].n]);
		assert.ok(!names(SAMPLE, { query: "status:local" }, cp).includes(SAMPLE[1].n));
	});

	it("supports * and ? wildcards that must match the whole name", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "Account*Test" }), ["AccountHandlerTest"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "*Trigger" }), ["AccountTrigger"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "Account?andler" }), ["AccountHandler"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "Case*" }), ["Case_Router"]);
	});

	it("Type:Name matches the type exactly and the name by contains / glob", () => {
		assert.deepStrictEqual(names(SAMPLE, { query: "ApexClass:AccountHandler" }), ["AccountHandler", "AccountHandlerTest"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "apexclass:*Test" }), ["AccountHandlerTest"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "CustomField:Account.Region__c" }), ["Account.Region__c"]);
		assert.deepStrictEqual(names(SAMPLE, { query: "Flow:AccountHandler" }), []);
	});

	it("parses the empty query as matching everything", () => {
		assert.strictEqual(names(SAMPLE, { query: "   " }).length, SAMPLE.length);
		assert.strictEqual(parseQuery("").terms.length, 0);
	});
});

describe("orgBrowser filter: facets and state filters", () => {
	it("filters by selected types", () => {
		assert.deepStrictEqual(names(SAMPLE, { types: ["Flow", "Layout"] }), ["Account-Account Layout", "Case_Router"]);
	});

	it("namespace modes: all / unmanaged / specific", () => {
		assert.strictEqual(names(SAMPLE, { nsMode: "all" }).length, SAMPLE.length);
		assert.deepStrictEqual(names(SAMPLE, { nsMode: "specific", namespaces: ["ABC"] }), ["abc__ManagedThing"]);
		assert.ok(!names(SAMPLE, { nsMode: "unmanaged" }).includes("abc__ManagedThing"));
		assert.strictEqual(names(SAMPLE, { nsMode: "unmanaged" }).length, SAMPLE.length - 1);
	});

	it("manageable state filter", () => {
		assert.deepStrictEqual(names(SAMPLE, { states: ["installed"] }), ["abc__ManagedThing"]);
	});

	it("modified by me matches by id or by name", () => {
		assert.deepStrictEqual(names(SAMPLE, { mine: true }, ctx({ meIds: ["005B"] })), ["AccountHandlerTest", "Case_Router"]);
		assert.deepStrictEqual(names(SAMPLE, { mine: true }, ctx({ meName: "john smith" })), ["AccountHandlerTest", "Case_Router"]);
		assert.deepStrictEqual(names(SAMPLE, { mine: true }, ctx()), []);
	});

	it("date windows: 24h, 7d, 30d and custom; unknown dates never match a window", () => {
		assert.deepStrictEqual(names(SAMPLE, { within: "24h" }), ["AccountHandler", "AccountHandlerTest", "Account.Region__c", "Case_Router"]);
		assert.ok(names(SAMPLE, { within: "7d" }).includes("AccountTrigger"));
		assert.ok(!names(SAMPLE, { within: "30d" }).includes("abc__ManagedThing"));
		assert.ok(!names(SAMPLE, { within: "30d" }).includes("Account-Account Layout"));
		assert.deepStrictEqual(names(SAMPLE, { within: "custom", from: NOW - 4 * 24 * H, to: NOW - 2 * 24 * H }), ["AccountTrigger"]);
	});

	it("only-selected shows just the selected keys", () => {
		const sel = new Set(["Flow:Case_Router", "ApexClass:AccountHandler"]);
		assert.deepStrictEqual(names(SAMPLE, { onlySelected: true }, ctx({ selected: sel })), ["AccountHandler", "Case_Router"]);
	});

	it("facet counts ignore their own filter only", () => {
		const idx = buildIndex(SAMPLE);
		const state: FilterState = { ...DEFAULT_FILTER, types: ["ApexTrigger"], query: "account" };
		const f = computeFacets(idx, state, ctx());
		// Type facet: all types matching "account" (the type filter itself is ignored).
		assert.strictEqual(f.types.get("ApexClass"), 2);
		assert.strictEqual(f.types.get("ApexTrigger"), 1);
		assert.strictEqual(f.types.get("CustomField"), 1);
		// Namespace facet respects the type filter.
		assert.strictEqual(f.namespaces.get(""), 1);
		assert.deepStrictEqual(f.status, [1, 0, 0, 0]);
	});
});

describe("orgBrowser filter: sort, paste, highlight, time", () => {
	it("sorts by name, modified date and type", () => {
		const idx = buildIndex(SAMPLE);
		const all = SAMPLE.map((_, i) => i);
		const byName = sortIndices(idx, [...all], "name", 1, null).map((i) => SAMPLE[i].n);
		assert.strictEqual(byName[0], "abc__ManagedThing"); // lower-cased compare: "abc…" < "account…"
		const byMod = sortIndices(idx, [...all], "modified", -1, null).map((i) => SAMPLE[i].n);
		assert.strictEqual(byMod[byMod.length - 1], "Account-Account Layout"); // lm = 0
		const byType = sortIndices(idx, [...all], "type", 1, null).map((i) => SAMPLE[i].t);
		assert.deepStrictEqual(byType, [...byType].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
	});

	it("parses pasted Type:Name lines only when every line fits", () => {
		const known = new Set(["ApexClass", "Flow"]);
		assert.deepStrictEqual(parsePastedPairs("ApexClass:Foo\r\nFlow:Bar Baz\n\n", known), [
			{ type: "ApexClass", name: "Foo" },
			{ type: "Flow", name: "Bar Baz" },
		]);
		assert.strictEqual(parsePastedPairs("ApexClass:Foo\njust some text", known), null);
		assert.strictEqual(parsePastedPairs("Nope:Foo", known), null);
		assert.strictEqual(parsePastedPairs("   ", known), null);
	});

	it("matches pasted pairs exactly and reports the missing ones", () => {
		const idx = buildIndex(SAMPLE);
		const { indices, missing } = matchPairs(idx, [
			{ type: "apexclass", name: "accounthandler" },
			{ type: "Flow", name: "Case_Router" },
			{ type: "Flow", name: "Gone" },
		]);
		assert.deepStrictEqual(indices.map((i) => SAMPLE[i].n), ["AccountHandler", "Case_Router"]);
		assert.deepStrictEqual(missing, [{ type: "Flow", name: "Gone" }]);
	});

	it("highlights literal fragments of plain, Type:Name and wildcard terms", () => {
		assert.deepStrictEqual(highlightTerms("acc -test type:ApexClass"), ["acc"]);
		assert.deepStrictEqual(highlightTerms("Acc*Handler"), ["acc", "handler"]);
		assert.deepStrictEqual(highlightTerms("ApexClass:Foo"), ["foo"]);
		assert.deepStrictEqual(highlightRanges("AccountHandler", ["acc", "handler"]), [[0, 3], [7, 14]]);
		assert.deepStrictEqual(highlightRanges("aaa", ["aa"]), [[0, 2]]);
		assert.deepStrictEqual(highlightRanges("abcabc", ["abc", "bca"]), [[0, 6]]); // overlapping fragments merge
	});

	it("formats relative times", () => {
		assert.strictEqual(relativeTime(0, NOW), "");
		assert.strictEqual(relativeTime(NOW - 10_000, NOW), "just now");
		assert.strictEqual(relativeTime(NOW - 5 * 60_000, NOW), "5 min ago");
		assert.strictEqual(relativeTime(NOW - 3 * H, NOW), "3 h ago");
		assert.strictEqual(relativeTime(NOW - 10 * 24 * H, NOW), "10 d ago");
		assert.strictEqual(relativeTime(Date.parse("2020-01-02T00:00:00Z"), NOW), "2020-01-02");
	});
});

describe("orgBrowser filter: performance", () => {
	const N = 50_000;
	const types = ["ApexClass", "ApexTrigger", "CustomField", "Flow", "Layout", "LightningComponentBundle", "PermissionSet", "Report"];
	const big: Comp[] = Array.from({ length: N }, (_, i) =>
		comp(types[i % types.length], `${i % 7 === 0 ? "ns" + (i % 5) + "__" : ""}Thing${i}Handler${i % 13 === 0 ? "Test" : ""}`, {
			ns: i % 7 === 0 ? "ns" + (i % 5) : "",
			by: i % 3 === 0 ? "John Smith" : "Jane Doe",
			lm: NOW - (i % 90) * 24 * H,
		})
	);
	const idx = buildIndex(big);
	const status = new Uint8Array(N);
	for (let i = 0; i < N; i += 11) status[i] = 1;

	it("filters 50k rows in < 100 ms (search + facets + type + date)", () => {
		const c = ctx({ status });
		const state: FilterState = { ...DEFAULT_FILTER, query: "thing1* handler type:ApexClass -test by:john", types: [], within: "30d" };
		filterIndices(idx, state, c); // warm up JIT
		const t0 = Date.now();
		const res = filterIndices(idx, state, c);
		const t1 = Date.now();
		computeFacets(idx, { ...DEFAULT_FILTER, query: "handler" }, c);
		const t2 = Date.now();
		assert.ok(Array.isArray(res));
		assert.ok(t1 - t0 < 100, `filter took ${t1 - t0} ms`);
		assert.ok(t2 - t1 < 100, `facets took ${t2 - t1} ms`);
	});

	it("filters a plain substring over 50k rows in < 100 ms", () => {
		const t0 = Date.now();
		const res = filterIndices(idx, { ...DEFAULT_FILTER, query: "thing77" }, ctx());
		const dt = Date.now() - t0;
		assert.ok(res.length > 0);
		assert.ok(dt < 100, `took ${dt} ms`);
	});
});
