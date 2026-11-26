import * as assert from "assert";
import {
	ConflictChoice,
	SC_CHANGED_IN_ORG,
	SC_CHANGED_LOCALLY,
	SC_CONFLICT,
	SC_EQUAL,
	SC_ONLY_LOCAL,
	SC_ONLY_ORG,
	SC_PARTIAL,
	SC_UNKNOWN,
	SYNC_CENTER_VOCAB,
	SYNC_STATUS_NAMES,
	SyncInputs,
	SyncRow,
	buildSyncRows,
	componentRefs,
	deleteCandidates,
	deployCandidates,
	isDiffable,
	localKeysOf,
	quickActionCounts,
	quickActionKeys,
	retrieveCandidates,
	normalizeMode,
	skippedText,
	takesPart,
	unresolvedText,
} from "../utils/syncCenterPure";
import { DEFAULT_FILTER, FilterContext, buildIndex, filterIndices, parseQuery } from "../utils/orgBrowser/filter";
import { Comp } from "../utils/orgBrowser/types";

const T0 = Date.parse("2025-06-01T10:00:00Z");
const HOUR = 3600_000;

const comp = (t: string, n: string, lm = T0): Comp => ({ t, n, ns: "", ms: "", by: "Ann", bi: "", lm, cd: 0, id: "", f: "" });
const loc = (type: string, name: string) => ({ type, name, key: `${type}:${name}` });

const base = (over: Partial<SyncInputs> = {}): SyncInputs => ({
	localKnown: true,
	local: [],
	org: [],
	listedTypes: new Set(["ApexClass", "Layout", "CustomObject"]),
	localInfo: {},
	contentInfo: {},
	retrieved: {},
	...over,
});

const byKey = (rows: SyncRow[]) => new Map(rows.map((r) => [r.key, r]));

describe("sync center rows", () => {
	it("merges local and org by compKey; local-only and org-only rows are the rest", () => {
		const rows = buildSyncRows(
			base({
				local: [loc("ApexClass", "A"), loc("ApexClass", "OnlyLocal")],
				org: [comp("ApexClass", "A"), comp("ApexClass", "OnlyOrg")],
				localInfo: { "ApexClass:A": [T0 - HOUR, 0] },
				retrieved: { "ApexClass:A": T0 },
			})
		);
		const m = byKey(rows);
		assert.strictEqual(rows.length, 3);
		assert.strictEqual(m.get("ApexClass:A")!.status, "equal");
		assert.strictEqual(m.get("ApexClass:A")!.provisional, true);
		assert.strictEqual(m.get("ApexClass:A")!.local && m.get("ApexClass:A")!.inOrg, true);
		assert.strictEqual(m.get("ApexClass:OnlyLocal")!.code, SC_ONLY_LOCAL);
		assert.strictEqual(m.get("ApexClass:OnlyOrg")!.code, SC_ONLY_ORG);
		assert.strictEqual(m.get("ApexClass:OnlyOrg")!.comp?.by, "Ann");
	});

	it("percent-decodes local names like orgLookupKey; the row remembers the local key", () => {
		const rows = buildSyncRows(
			base({
				local: [loc("Layout", "Account-Account%20Layout")],
				org: [comp("Layout", "Account-Account Layout")],
				localInfo: { "Layout:Account-Account%20Layout": [T0, 0] },
				contentInfo: { "Layout:Account-Account%20Layout": [1, T0, T0] },
			})
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].key, "Layout:Account-Account Layout");
		assert.strictEqual(rows[0].localKey, "Layout:Account-Account%20Layout");
		assert.strictEqual(rows[0].status, "equal");
		assert.strictEqual(rows[0].provisional, false);
	});

	it("a local-only row with a decoded name keeps the org-style name", () => {
		const rows = buildSyncRows(base({ local: [loc("Layout", "Account-My%20Layout")], org: [] }));
		assert.strictEqual(rows[0].name, "Account-My Layout");
		assert.strictEqual(rows[0].status, "only-local");
		assert.deepStrictEqual(localKeysOf(rows, [rows[0].key]), ["Layout:Account-My%20Layout"]);
		assert.deepStrictEqual(componentRefs(rows, [rows[0].key]), [{ type: "Layout", fullName: "Account-My Layout" }]);
	});

	it("uses the compare engine for changed-locally / changed-in-org / conflict", () => {
		const rows = buildSyncRows(
			base({
				local: [loc("ApexClass", "L"), loc("ApexClass", "O"), loc("ApexClass", "C")],
				org: [comp("ApexClass", "L"), comp("ApexClass", "O", T0 + HOUR), comp("ApexClass", "C", T0 + HOUR)],
				localInfo: { "ApexClass:L": [T0, 1], "ApexClass:O": [T0 - HOUR, 0], "ApexClass:C": [T0, 1] },
				retrieved: { "ApexClass:L": T0, "ApexClass:O": T0, "ApexClass:C": T0 },
			})
		);
		const m = byKey(rows);
		assert.strictEqual(m.get("ApexClass:L")!.code, SC_CHANGED_LOCALLY);
		assert.strictEqual(m.get("ApexClass:O")!.code, SC_CHANGED_IN_ORG);
		assert.strictEqual(m.get("ApexClass:C")!.code, SC_CONFLICT);
	});

	it("a verified same result is final and needs no local info; a verified different is not provisional", () => {
		const rows = buildSyncRows(
			base({
				local: [loc("ApexClass", "S"), loc("ApexClass", "D")],
				org: [comp("ApexClass", "S", T0 + HOUR), comp("ApexClass", "D", T0 + HOUR)],
				localInfo: { "ApexClass:D": [T0, 1] },
				contentInfo: { "ApexClass:S": [1, T0, T0], "ApexClass:D": [2, T0, 0] },
				retrieved: { "ApexClass:D": T0 },
			})
		);
		const m = byKey(rows);
		assert.deepStrictEqual([m.get("ApexClass:S")!.code, m.get("ApexClass:S")!.provisional], [SC_EQUAL, false]);
		assert.strictEqual(m.get("ApexClass:D")!.code, SC_CONFLICT);
		assert.strictEqual(m.get("ApexClass:D")!.provisional, false);
	});

	it("unknown: no local info yet (why local), no listing for the type (why org), project not scanned", () => {
		const rows = buildSyncRows(
			base({
				local: [loc("ApexClass", "NoInfo"), loc("Flow", "NoListing")],
				org: [comp("ApexClass", "NoInfo")],
				localInfo: undefined,
			})
		);
		const m = byKey(rows);
		assert.deepStrictEqual([m.get("ApexClass:NoInfo")!.code, m.get("ApexClass:NoInfo")!.why], [SC_UNKNOWN, "local"]);
		assert.deepStrictEqual([m.get("Flow:NoListing")!.code, m.get("Flow:NoListing")!.why], [SC_UNKNOWN, "org"]);
		assert.strictEqual(m.get("Flow:NoListing")!.provisional, true);

		const notScanned = buildSyncRows(base({ localKnown: false, local: [], org: [comp("ApexClass", "X")] }));
		assert.strictEqual(notScanned[0].code, SC_UNKNOWN);
	});

	it("partial: an org object missing locally whose children exist locally", () => {
		const rows = buildSyncRows(base({ local: [loc("CustomField", "Account.F__c")], org: [comp("CustomObject", "Account")], partialKeys: ["CustomObject:Account"] }));
		const m = byKey(rows);
		assert.strictEqual(m.get("CustomObject:Account")!.code, SC_PARTIAL);
		assert.strictEqual(m.get("CustomObject:Account")!.local, false);
	});

	it("looks the retrieve log up under the local key and the org key", () => {
		const common = {
			local: [loc("Layout", "A-B%20C")],
			org: [comp("Layout", "A-B C", T0 + 5 * HOUR)],
			localInfo: { "Layout:A-B%20C": [T0 - HOUR, 0] as [number, number] },
		};
		const viaOrgKey = buildSyncRows(base({ ...common, retrieved: { "Layout:A-B C": T0 + 5 * HOUR } }));
		assert.strictEqual(viaOrgKey[0].status, "equal");
		const never = buildSyncRows(base({ ...common }));
		assert.strictEqual(never[0].status, "changed-in-org");
	});
});

describe("sync center vocabulary", () => {
	const q = (s: string) => parseQuery(s, SYNC_CENTER_VOCAB).status.map((x) => SYNC_STATUS_NAMES.filter((_, i) => x.value(i)));

	it("names, local / new = only-local, org / not-local = only-org, plus the other panels' aliases", () => {
		assert.deepStrictEqual(q("status:local"), [["only-local"]]);
		assert.deepStrictEqual(q("status:new"), [["only-local"]]);
		assert.deepStrictEqual(q("status:org"), [["only-org"]]);
		assert.deepStrictEqual(q("status:not-local"), [["only-org"]]);
		assert.deepStrictEqual(q("status:modified"), [["changed-locally"]]);
		assert.deepStrictEqual(q("status:changed"), [["changed-in-org"]]);
		assert.deepStrictEqual(q("status:same"), [["equal"]]);
		assert.deepStrictEqual(q("status:partial"), [["partial"]]);
		assert.deepStrictEqual(q("status:conflict"), [["conflict"]]);
		assert.deepStrictEqual(q("status:unknown"), [["unknown"]]);
		assert.deepStrictEqual(q("status:inorg"), [["equal", "changed-locally", "changed-in-org", "conflict"]]);
	});

	it("filters rows by their status code", () => {
		const names = ["a", "b", "c", "d"];
		const comps = names.map((n) => comp("ApexClass", n));
		const codes = Uint8Array.from([SC_ONLY_LOCAL, SC_ONLY_ORG, SC_CONFLICT, SC_EQUAL]);
		const ctx: FilterContext = { now: T0, status: codes, vocab: SYNC_CENTER_VOCAB };
		const run = (query: string) => filterIndices(buildIndex(comps), { ...DEFAULT_FILTER, query }, ctx).map((i) => names[i]);
		assert.deepStrictEqual(run("status:local"), ["a"]);
		assert.deepStrictEqual(run("status:org status:conflict"), ["b", "c"]);
	});
});

function row(key: string, status: SyncRow["status"], over: Partial<SyncRow> = {}): SyncRow {
	const [type, name] = key.split(":");
	const local = status !== "only-org" && status !== "partial";
	const inOrg = status !== "only-local";
	return { key, type, name, local, inOrg, status, code: SYNC_STATUS_NAMES.indexOf(status), provisional: false, ...(local ? { localKey: key } : {}), ...over };
}

const ROWS: SyncRow[] = [
	row("ApexClass:OL", "only-local"),
	row("ApexClass:OO", "only-org"),
	row("ApexClass:EQ", "equal"),
	row("ApexClass:CL", "changed-locally"),
	row("ApexClass:CO", "changed-in-org"),
	row("ApexClass:CF1", "conflict"),
	row("ApexClass:CF2", "conflict"),
	row("CustomObject:PA", "partial"),
	row("ApexClass:UN", "unknown", { why: "local" }),
];
const all = new Set(ROWS.map((r) => r.key));
const none = new Map<string, ConflictChoice>();

describe("sync center candidates", () => {
	it("deploy: local-side rows count; equal only when not skipped; conflicts need Keep local", () => {
		const r = deployCandidates(ROWS, all, new Map([["ApexClass:CF1", "local" as const]]), true);
		assert.deepStrictEqual(r.keys, ["ApexClass:OL", "ApexClass:CL", "ApexClass:CF1", "CustomObject:PA", "ApexClass:UN"]);
		assert.strictEqual(r.unresolvedConflicts, 1);
		assert.deepStrictEqual(r.unresolvedKeys, ["ApexClass:CF2"]);
		assert.deepStrictEqual(Object.fromEntries(r.skipped.map((s) => [s.reason, s.count])), { "only in org": 1, equal: 1, "changed in org": 1 });
		const noSkip = deployCandidates(ROWS, all, new Map([["ApexClass:CF1", "local" as const], ["ApexClass:CF2", "local" as const]]), false);
		assert.ok(noSkip.keys.includes("ApexClass:EQ"));
		assert.strictEqual(noSkip.unresolvedConflicts, 0);
	});

	it("deploy: a conflict set to Take org is skipped, not unresolved", () => {
		const r = deployCandidates(ROWS, new Set(["ApexClass:CF1"]), new Map([["ApexClass:CF1", "org" as const]]), true);
		assert.deepStrictEqual(r.keys, []);
		assert.deepStrictEqual(r.skipped, [{ reason: "conflict set to Take org", count: 1 }]);
		assert.strictEqual(r.unresolvedConflicts, 0);
	});

	it("retrieve: org-side rows count; conflicts need Take org", () => {
		const r = retrieveCandidates(ROWS, all, new Map([["ApexClass:CF2", "org" as const]]), true);
		assert.deepStrictEqual(r.keys, ["ApexClass:OO", "ApexClass:CO", "ApexClass:CF2", "CustomObject:PA", "ApexClass:UN"]);
		assert.strictEqual(r.unresolvedConflicts, 1);
		assert.deepStrictEqual(Object.fromEntries(r.skipped.map((s) => [s.reason, s.count])), { "only local": 1, equal: 1, "changed locally": 1 });
	});

	it("an unknown row counts for the side it is known to be on only", () => {
		const orgOnly = row("ApexClass:UO", "unknown", { local: false, inOrg: true, why: "local" });
		const localOnly = row("Flow:UL", "unknown", { local: true, inOrg: false, why: "org" });
		const rows = [orgOnly, localOnly];
		const sel = new Set(rows.map((r) => r.key));
		assert.deepStrictEqual(deployCandidates(rows, sel, none, true).keys, ["Flow:UL"]);
		assert.deepStrictEqual(retrieveCandidates(rows, sel, none, true).keys, ["ApexClass:UO"]);
	});

	it("only selected rows count; keys that are no row any more are ignored", () => {
		const r = deployCandidates(ROWS, new Set(["ApexClass:CL", "ApexClass:Gone"]), none, true);
		assert.deepStrictEqual(r.keys, ["ApexClass:CL"]);
		assert.deepStrictEqual(r.skipped, []);
	});

	it("delete: only only-org rows; the rest of the selection is skipped with a reason", () => {
		const r = deleteCandidates(ROWS, all, none, true);
		assert.deepStrictEqual(r.keys, ["ApexClass:OO"]);
		assert.strictEqual(r.unresolvedConflicts, 0);
		const reasons = Object.fromEntries(r.skipped.map((s) => [s.reason, s.count]));
		assert.strictEqual(reasons["only local"], 1);
		assert.strictEqual(reasons["partly local"], 1);
		assert.strictEqual(reasons["also in the project"], 6); // equal, changed x2, conflict x2, unknown local
	});

	it("tooltip texts", () => {
		const r = deployCandidates(ROWS, all, none, true);
		assert.strictEqual(unresolvedText(r), "2 conflicts need a choice");
		assert.strictEqual(unresolvedText({ unresolvedConflicts: 1 }), "1 conflict needs a choice");
		assert.strictEqual(unresolvedText({ unresolvedConflicts: 0 }), "");
		assert.ok(skippedText(r).includes("1 only in org skipped"));
		assert.strictEqual(skippedText({ skipped: [] }), "");
	});
});

describe("sync center quick actions", () => {
	it("select by status with counts; all changes = changed locally + changed in org + conflict", () => {
		assert.deepStrictEqual(quickActionKeys(ROWS, "changedLocally"), ["ApexClass:CL"]);
		assert.deepStrictEqual(quickActionKeys(ROWS, "changedInOrg"), ["ApexClass:CO"]);
		assert.deepStrictEqual(quickActionKeys(ROWS, "allChanges"), ["ApexClass:CL", "ApexClass:CO", "ApexClass:CF1", "ApexClass:CF2"]);
		assert.deepStrictEqual(quickActionKeys(ROWS, "onlyLocal"), ["ApexClass:OL"]);
		assert.deepStrictEqual(quickActionCounts(ROWS), { changedLocally: 1, changedInOrg: 1, allChanges: 4, onlyLocal: 1 });
	});

	it("a visible-keys set limits the selection (the filter)", () => {
		const visible = new Set(["ApexClass:CL", "ApexClass:CF1"]);
		assert.deepStrictEqual(quickActionKeys(ROWS, "allChanges", visible), ["ApexClass:CL", "ApexClass:CF1"]);
		assert.strictEqual(quickActionCounts(ROWS, visible).allChanges, 2);
	});

	it("which rows can be diffed", () => {
		assert.deepStrictEqual(ROWS.filter(isDiffable).map((r) => r.key), ["ApexClass:EQ", "ApexClass:CL", "ApexClass:CO", "ApexClass:CF1", "ApexClass:CF2"]);
	});
});

describe("sync center action modes", () => {
	const row = (local: boolean, inOrg: boolean, status: string) => ({ local, inOrg, status: status as SyncRow["status"] });
	it("deploy needs local files, retrieve needs the org copy, delete only takes only-org rows", () => {
		assert.strictEqual(takesPart("deploy", row(true, false, "only-local")), true);
		assert.strictEqual(takesPart("deploy", row(false, true, "only-org")), false);
		assert.strictEqual(takesPart("retrieve", row(true, false, "only-local")), false);
		assert.strictEqual(takesPart("retrieve", row(true, true, "equal")), true);
		assert.strictEqual(takesPart("delete", row(false, true, "only-org")), true);
		assert.strictEqual(takesPart("delete", row(true, true, "changed-locally")), false);
	});
	it("an unknown stored mode is deploy", () => {
		assert.strictEqual(normalizeMode(undefined), "deploy");
		assert.strictEqual(normalizeMode("delete"), "delete");
		assert.strictEqual(normalizeMode("x"), "deploy");
	});
});
