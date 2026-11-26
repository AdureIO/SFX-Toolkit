import * as assert from "assert";
import {
	ConflictChoice,
	SC_CONFLICT,
	SC_EQUAL,
	SC_ONLY_LOCAL,
	SC_ONLY_ORG,
	SC_PARTIAL,
	SC_UNKNOWN,
	SYNC_CENTER_VOCAB,
	SYNC_IN_PROJECT,
	syncStatusOptions,
	SYNC_IN_PROJECT_FACET_INDEX,
	SYNC_STATUS_NAMES,
	SyncInputs,
	SyncRow,
	buildSyncRows,
	deployCandidates,
	deleteCandidates,
	retrieveCandidates,
} from "../utils/syncCenterPure";
import { DEFAULT_FILTER, FilterContext, buildIndex, computeFacets, filterIndices, parseQuery, withinWindow } from "../utils/orgBrowser/filter";
import {
	browseFilter,
	buttonState,
	choicesFromJson,
	choicesStoreKey,
	centerFilterKeptOnClear,
	choicesToJson,
	defaultStatusFilter,
	presetModified,
	deploymentSetupPath,
	historyDeployLocalKeys,
	historyRowKeys,
	historyViews,
	choiceTitle,
	conflictPrompt,
	nextChoice,
	retrieveProjectPrompt,
	selectionBannerText,
	selectionSummary,
	selectionSummaryTitle,
	initialGroup,
	initialStatusFilter,
	objectOfChild,
	onlyOrgRefs,
	overwriteLocalKeys,
	partialDeployLocalKeys,
	pruneConflictChoices,
	refOfKey,
	rowKeyOf,
} from "../utils/syncCenterUiPure";
import { OBJECT_CHILD_TYPES } from "../utils/orgBrowser/localIndex";
import { HistoryEntry } from "../utils/historyPure";
import { Comp } from "../utils/orgBrowser/types";

const T0 = Date.parse("2025-06-01T10:00:00Z");
const HOUR = 3600_000;
const comp = (t: string, n: string, lm = T0): Comp => ({ t, n, ns: "", ms: "", by: "Ann", bi: "", lm, cd: 0, id: "", f: "" });
const loc = (type: string, name: string) => ({ type, name, key: `${type}:${name}` });
const inputs = (over: Partial<SyncInputs>): SyncInputs => ({
	localKnown: true,
	local: [],
	org: [],
	listedTypes: new Set(["ApexClass", "CustomObject", "CustomField", "Layout"]),
	localInfo: {},
	contentInfo: {},
	retrieved: {},
	...over,
});

describe("sync center ui rules", () => {
	describe("keys", () => {
		it("refOfKey splits at the first colon", () => {
			assert.deepStrictEqual(refOfKey("Layout:Account-Account Layout"), { type: "Layout", fullName: "Account-Account Layout" });
			assert.deepStrictEqual(refOfKey("Flow:a:b"), { type: "Flow", fullName: "a:b" });
		});
		it("rowKeyOf decodes percent-encoded local names like the org lists them", () => {
			assert.strictEqual(rowKeyOf("Layout:Account-Account%20Layout"), "Layout:Account-Account Layout");
			assert.strictEqual(rowKeyOf("ApexClass:A"), "ApexClass:A");
		});
	});

	describe("partial objects", () => {
		const locals = [loc("CustomField", "Account.Foo__c"), loc("CustomField", "Account.Bar__c"), loc("CustomField", "Contact.Baz__c"), loc("ApexClass", "Account.Handler"), loc("RecordType", "Account.Big")];

		it("objectOfChild only knows child types", () => {
			assert.strictEqual(objectOfChild("CustomField", "Account.Foo__c", OBJECT_CHILD_TYPES), "Account");
			assert.strictEqual(objectOfChild("ApexClass", "Account.Handler", OBJECT_CHILD_TYPES), undefined);
			assert.strictEqual(objectOfChild("CustomField", "NoDot", OBJECT_CHILD_TYPES), undefined);
		});

		it("partialDeployLocalKeys: the children of the object that are local", () => {
			assert.deepStrictEqual(partialDeployLocalKeys("Account", locals, OBJECT_CHILD_TYPES), ["CustomField:Account.Foo__c", "CustomField:Account.Bar__c", "RecordType:Account.Big"]);
			assert.deepStrictEqual(partialDeployLocalKeys("Opportunity", locals, OBJECT_CHILD_TYPES), []);
		});

	});

	describe("overwrite local keys", () => {
		it("overwriteLocalKeys: the entry of each ref, and an object's local children", () => {
			const locals = [loc("CustomObject", "Account"), loc("CustomField", "Account.Foo__c"), loc("CustomField", "Contact.X__c"), loc("ApexClass", "A")];
			assert.deepStrictEqual(overwriteLocalKeys([{ type: "CustomObject", fullName: "Account" }, { type: "ApexClass", fullName: "A" }], locals, OBJECT_CHILD_TYPES), [
				"CustomObject:Account",
				"CustomField:Account.Foo__c",
				"ApexClass:A",
			]);
			assert.deepStrictEqual(overwriteLocalKeys([{ type: "CustomField", fullName: "Account.Foo__c" }], locals, OBJECT_CHILD_TYPES), ["CustomField:Account.Foo__c"]);
		});

		it("overwriteLocalKeys finds a percent-encoded local entry by its org name", () => {
			const locals = [loc("Layout", "Account-Account%20Layout")];
			assert.deepStrictEqual(overwriteLocalKeys([{ type: "Layout", fullName: "Account-Account Layout" }], locals, OBJECT_CHILD_TYPES), ["Layout:Account-Account%20Layout"]);
		});
	});

	describe("conflict choices", () => {
		const conflictRows = (): SyncRow[] =>
			buildSyncRows(
				inputs({
					local: [loc("ApexClass", "A"), loc("ApexClass", "B")],
					org: [comp("ApexClass", "A", T0), comp("ApexClass", "B", T0)],
					localInfo: { "ApexClass:A": [T0 + HOUR, 1], "ApexClass:B": [T0 + HOUR, 1] },
					retrieved: { "ApexClass:A": T0 - HOUR, "ApexClass:B": T0 - HOUR },
				})
			);

		it("keeps the choice of a row that is still a conflict", () => {
			const rows = conflictRows();
			assert.ok(rows.every((r) => r.status === "conflict"));
			const kept = pruneConflictChoices(new Map<string, ConflictChoice>([["ApexClass:A", "local"], ["ApexClass:B", "org"]]), rows);
			assert.deepStrictEqual([...kept], [["ApexClass:A", "local"], ["ApexClass:B", "org"]]);
		});

		it("drops the choice of a row that is no longer a conflict or no longer exists", () => {
			const rows = buildSyncRows(
				inputs({
					local: [loc("ApexClass", "A"), loc("ApexClass", "B")],
					org: [comp("ApexClass", "A", T0), comp("ApexClass", "B", T0)],
					localInfo: { "ApexClass:A": [T0 + HOUR, 1], "ApexClass:B": [T0 - 3 * HOUR, 0] },
					retrieved: { "ApexClass:A": T0 - HOUR, "ApexClass:B": T0 },
				})
			);
			assert.strictEqual(rows.find((r) => r.key === "ApexClass:B")!.status, "equal");
			const kept = pruneConflictChoices(new Map<string, ConflictChoice>([["ApexClass:A", "local"], ["ApexClass:B", "org"], ["ApexClass:Gone", "org"]]), rows);
			assert.deepStrictEqual([...kept], [["ApexClass:A", "local"]]);
		});

		it("round-trips through the stored form and ignores junk", () => {
			const m = new Map<string, ConflictChoice>([["ApexClass:A", "local"], ["ApexClass:B", "org"]]);
			assert.deepStrictEqual([...choicesFromJson(choicesToJson(m))], [...m]);
			assert.deepStrictEqual([...choicesFromJson({ a: "local", b: "both", c: 3 })], [["a", "local"]]);
			assert.strictEqual(choicesFromJson(null).size, 0);
			assert.strictEqual(choicesFromJson("x").size, 0);
		});

		it("the store key is per project and org", () => {
			assert.notStrictEqual(choicesStoreKey("/p1", "a@x"), choicesStoreKey("/p2", "a@x"));
			assert.notStrictEqual(choicesStoreKey("/p1", "a@x"), choicesStoreKey("/p1", "b@x"));
		});
	});

	describe("buttonState", () => {
		const rows = buildSyncRows(
			inputs({
				local: [loc("ApexClass", "L1"), loc("ApexClass", "E1"), loc("ApexClass", "C1")],
				org: [comp("ApexClass", "O1"), comp("ApexClass", "O2"), comp("ApexClass", "E1"), comp("ApexClass", "C1")],
				localInfo: { "ApexClass:E1": [T0 - HOUR, 0], "ApexClass:C1": [T0 + HOUR, 1] },
				retrieved: { "ApexClass:E1": T0, "ApexClass:C1": T0 - HOUR },
			})
		);
		const sel = (...k: string[]) => new Set(k);
		const input = (cands: ReturnType<typeof deployCandidates>, over = {}) => ({ verb: "Deploy", cands, busy: false, selected: 1, hint: "Deploy the selection", ...over });

		it("counts and lists what was skipped in the tooltip", () => {
			const c = deployCandidates(rows, sel("ApexClass:L1", "ApexClass:O1", "ApexClass:O2"), new Map(), true);
			const s = buttonState(input(c, { selected: 3 }));
			assert.strictEqual(s.label, "Deploy (1)");
			assert.strictEqual(s.disabled, false);
			assert.ok(s.title.includes("2 only in org skipped"), s.title);
		});

		it("conflicts without a choice never disable Deploy or Retrieve; they count", () => {
			const c = deployCandidates(rows, sel("ApexClass:L1", "ApexClass:C1"), new Map(), true);
			const s = buttonState(input(c, { selected: 2 }));
			assert.strictEqual(s.disabled, false);
			assert.strictEqual(s.label, "Deploy (2)");
			const r = retrieveCandidates(rows, sel("ApexClass:O1", "ApexClass:C1"), new Map(), true);
			const rs = buttonState({ ...input(r), verb: "Retrieve" });
			assert.strictEqual(rs.disabled, false);
			assert.strictEqual(rs.label, "Retrieve (2)");
		});

		it("an explicit choice pointing the other way excludes the conflict", () => {
			const c = deployCandidates(rows, sel("ApexClass:C1"), new Map<string, ConflictChoice>([["ApexClass:C1", "org"]]), true);
			assert.strictEqual(buttonState(input(c)).label, "Deploy (0)");
			const k = deployCandidates(rows, sel("ApexClass:C1"), new Map<string, ConflictChoice>([["ApexClass:C1", "local"]]), true);
			assert.strictEqual(buttonState(input(k)).label, "Deploy (1)");
			assert.strictEqual(k.overwriteCount, 0);
		});

		it("a changed-in-org row deploys (button enabled) and is flagged for the confirmation", () => {
			const c = deployCandidates(rows, sel("ApexClass:E1", "ApexClass:O1"), new Map(), true);
			// E1 is equal (skipped), O1 only in org (skipped): nothing. Now a changed-in-org row:
			assert.strictEqual(buttonState(input(c, { selected: 2 })).disabled, true);
			const co = [{ ...rows.find((r) => r.key === "ApexClass:E1")!, status: "changed-in-org" as const, code: 3 }, rows.find((r) => r.key === "ApexClass:E1")!];
			const d = deployCandidates([co[0]], sel("ApexClass:E1"), new Map(), true);
			assert.strictEqual(buttonState(input(d)).label, "Deploy (1)");
			assert.strictEqual(buttonState(input(d)).disabled, false);
			assert.deepStrictEqual(d.overwriteKeys, ["ApexClass:E1"]);
		});

		it("selectionSummary: hidden with nothing selected, link text and tooltip", () => {
			assert.strictEqual(selectionSummary("deploy", 0, 0, false), "");
			assert.strictEqual(selectionSummary("deploy", 0, 0, true), "0 selected · 0 to deploy · 0 skipped — show all");
			assert.strictEqual(selectionSummary("deploy", 2, 0, false), "2 selected · 0 to deploy · 2 skipped");
			assert.strictEqual(selectionSummary("deploy", 5, 3, false, 2), "5 selected (2 hidden) · 3 to deploy · 2 skipped");
			assert.strictEqual(selectionSummary("retrieve", 2, 1, true), "2 selected · 1 to retrieve · 1 skipped — show all");
			assert.ok(selectionSummaryTitle([{ reason: "equal", count: 1 }], false).startsWith("1 equal (Skip equal components is on)"));
			assert.strictEqual(selectionSummaryTitle([], true), "Click to show all components");
		});

		it("conflictPrompt lists up to 10 names, then +n more", () => {
			const one = conflictPrompt("deploy", ["ApexClass:A"]);
			assert.strictEqual(one.action, "Overwrite org");
			assert.ok(one.detail.includes("ApexClass:A"));
			const keys = Array.from({ length: 13 }, (_, i) => `ApexClass:C${i}`);
			const p = conflictPrompt("retrieve", keys);
			assert.strictEqual(p.action, "Overwrite local");
			assert.ok(p.detail.includes("ApexClass:C9") && !p.detail.includes("ApexClass:C10"));
			assert.ok(p.detail.includes("+3 more"), p.detail);
		});

		it("nothing selected, nothing applicable, busy and blocked explain themselves", () => {
			const none = deployCandidates(rows, sel(), new Map(), true);
			assert.strictEqual(buttonState(input(none, { selected: 0 })).title, "Select components first");
			const onlyOrg = deployCandidates(rows, sel("ApexClass:O1"), new Map(), true);
			const s = buttonState(input(onlyOrg));
			assert.strictEqual(s.disabled, true);
			assert.ok(s.title.includes("1 only in org skipped"), s.title);
			assert.strictEqual(buttonState(input(none, { busy: true })).title, "An operation is running");
			assert.strictEqual(buttonState(input(onlyOrg, { blocked: "No org" })).title, "No org");
		});

		it("Delete: conflicts never block, equal rows are skipped", () => {
			const c = deleteCandidates(rows, sel("ApexClass:O1", "ApexClass:C1"));
			const s = buttonState({ verb: "Delete from org", cands: c, busy: false, selected: 2, hint: "Delete" });
			assert.strictEqual(s.label, "Delete from org (1)");
			assert.strictEqual(s.disabled, false);
			assert.ok(s.title.includes("skipped"), s.title);
		});
	});

	describe("history", () => {
		const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
			id: "h1",
			kind: "deploy",
			org: "me@org.com",
			at: T0,
			durationMs: 1200,
			components: ["ApexClass:A", "Layout:Account-Account%20Layout", "ApexClass:Gone"],
			componentCount: 3,
			ok: false,
			errors: [{ component: "ApexClass:A", message: "bad" }],
			deployId: "0AfXX0000000001",
			testLevel: "RunLocalTests",
			source: "center",
			...over,
		});

		it("formats the list rows", () => {
			const [v] = historyViews([entry()], T0 + 3 * HOUR, (o) => (o === "me@org.com" ? "Prod" : o));
			assert.strictEqual(v.kindLabel, "Deploy");
			assert.strictEqual(v.org, "Prod");
			assert.strictEqual(v.when, "3 h ago");
			assert.strictEqual(v.countText, "3 components");
			assert.strictEqual(v.statusText, "failed");
			assert.strictEqual(v.deployId, "0AfXX0000000001");
			assert.deepStrictEqual(v.errors, [{ component: "ApexClass:A", message: "bad" }]);
		});

		it("uses the real count when the stored components are capped", () => {
			const [v] = historyViews([entry({ components: ["ApexClass:A"], componentCount: 1500 })], T0);
			assert.strictEqual(v.countText, "1,500 components");
			const [one] = historyViews([entry({ components: ["ApexClass:A"], componentCount: 1, ok: true })], T0);
			assert.strictEqual(one.countText, "1 component");
			assert.strictEqual(one.statusText, "ok");
		});

		it("labels every kind", () => {
			const kinds = (["deploy", "validate", "retrieve", "delete"] as const).map((k) => historyViews([entry({ kind: k })], T0)[0].kindLabel);
			assert.deepStrictEqual(kinds, ["Deploy", "Validate", "Retrieve", "Delete"]);
		});

		it("selects the components that are rows, in either name form, and counts the rest", () => {
			const rows = buildSyncRows(inputs({ org: [comp("ApexClass", "A"), comp("Layout", "Account-Account Layout")] }));
			const r = historyRowKeys(entry(), rows);
			assert.deepStrictEqual(r.keys, ["ApexClass:A", "Layout:Account-Account Layout"]);
			assert.strictEqual(r.missing, 1);
		});

		it("a re-run deploys the local entries of the components, an object's local children, and counts the rest", () => {
			const locals = [loc("ApexClass", "A"), loc("Layout", "Account-Account%20Layout"), loc("CustomField", "Account.Foo__c"), loc("CustomField", "Account.Bar__c")];
			const r = historyDeployLocalKeys(["ApexClass:A", "Layout:Account-Account Layout", "CustomObject:Account", "ApexClass:Gone", "CustomObject:Nothing"], locals, OBJECT_CHILD_TYPES);
			assert.deepStrictEqual(r.keys, ["ApexClass:A", "Layout:Account-Account%20Layout", "CustomField:Account.Foo__c", "CustomField:Account.Bar__c"]);
			assert.strictEqual(r.missing, 2);
		});

		it("the Setup path of a deployment", () => {
			assert.strictEqual(
				deploymentSetupPath("0AfXX0000000001"),
				"/lightning/setup/DeployStatus/page?address=%2Fchangemgmt%2FmonitorDeploymentsDetails.apexp%3FasyncId%3D0AfXX0000000001"
			);
		});
	});

	describe("onlyOrgRefs", () => {
		const keys = new Set(["ApexClass:A", "CustomObject:Account", "Layout:Account-Account Layout"]);
		it("drops refs that exist locally and keeps the rest", () => {
			const refs = [
				{ type: "ApexClass", fullName: "A" },
				{ type: "ApexClass", fullName: "B" },
				{ type: "CustomObject", fullName: "Account" },
				{ type: "Layout", fullName: "Account-Account Layout" },
			];
			const r = onlyOrgRefs(refs, keys);
			assert.deepStrictEqual(r.keep, [{ type: "ApexClass", fullName: "B" }]);
			assert.deepStrictEqual(r.dropped.map((x) => x.fullName), ["A", "Account", "Account-Account Layout"]);
		});
		it("keeps everything when nothing is local, and handles empty input", () => {
			assert.strictEqual(onlyOrgRefs([{ type: "ApexClass", fullName: "Z" }], new Set()).keep.length, 1);
			assert.deepStrictEqual(onlyOrgRefs([], keys), { keep: [], dropped: [] });
		});
		it("matches type and name, not the name alone", () => {
			assert.strictEqual(onlyOrgRefs([{ type: "ApexTrigger", fullName: "A" }], keys).keep.length, 1);
		});
	});
});

describe("status filter: In project", () => {
	const names = ["only-local", "equal", "changed-locally", "changed-in-org", "conflict", "partial", "unknown", "only-org"];
	const codes = Uint8Array.from([SC_ONLY_LOCAL, SC_EQUAL, 2, 3, SC_CONFLICT, SC_PARTIAL, SC_UNKNOWN, SC_ONLY_ORG]);
	const comps = names.map((n) => comp("ApexClass", n));
	const idx = buildIndex(comps);
	const ctx: FilterContext = { now: T0, status: codes, vocab: SYNC_CENTER_VOCAB };
	const run = (over: Partial<typeof DEFAULT_FILTER>) => filterIndices(idx, { ...DEFAULT_FILTER, ...over }, ctx).map((i) => names[i]);

	it("is every row that exists locally: everything except only-org", () => {
		assert.deepStrictEqual(run({ status: [SYNC_IN_PROJECT] }), names.filter((n) => n !== "only-org"));
	});

	it("combines with the other status options like the group does (OR)", () => {
		assert.deepStrictEqual(run({ status: [SYNC_IN_PROJECT, "only-org"] }), names);
		assert.deepStrictEqual(run({ status: [SYNC_IN_PROJECT, "conflict"] }), names.filter((n) => n !== "only-org"));
		assert.deepStrictEqual(run({ status: ["only-org"] }), ["only-org"]);
	});

	it("query aliases status:project, status:in-project and status:inproject", () => {
		for (const q of ["status:project", "status:in-project", "status:inproject", "status:IN-PROJECT"]) {
			assert.deepStrictEqual(run({ query: q }), names.filter((n) => n !== "only-org"), q);
		}
		// a negated alias is the rows that are not local
		assert.deepStrictEqual(run({ query: "-status:project" }), ["only-org"]);
		// the old "compared or partial" meaning is gone: only-local counts now
		assert.ok(parseQuery("status:project", SYNC_CENTER_VOCAB).status[0].value(SC_ONLY_LOCAL));
	});

	it("the filter options read the facet slot of their own status (not a neighbour's)", () => {
		// One row per status: every option's count must equal the number of rows with that status.
		const f = computeFacets(idx, DEFAULT_FILTER, ctx);
		for (const o of syncStatusOptions()) {
			const expected = o.value === SYNC_IN_PROJECT ? names.length - 1 : names.filter((n) => n === o.value).length;
			assert.strictEqual(f.status[o.facetIndex], expected, o.value);
		}
	});

	it("is counted as a facet after the names; the other facets are unchanged", () => {
		const f = computeFacets(idx, DEFAULT_FILTER, ctx);
		assert.strictEqual(f.status.length, SYNC_STATUS_NAMES.length + 1);
		assert.strictEqual(f.status[SYNC_IN_PROJECT_FACET_INDEX], names.length - 1);
		assert.strictEqual(f.status[SC_ONLY_ORG], 1);
		assert.strictEqual(f.status[SC_EQUAL], 1);
	});

	it("is the default; a store from before the default gets it once, a cleared filter stays cleared", () => {
		assert.deepStrictEqual(defaultStatusFilter(), [SYNC_IN_PROJECT]);
		assert.deepStrictEqual(initialStatusFilter(undefined, false), [SYNC_IN_PROJECT]);
		assert.deepStrictEqual(initialStatusFilter([], false), [SYNC_IN_PROJECT]);
		assert.deepStrictEqual(initialStatusFilter([], true), []);
		assert.deepStrictEqual(initialStatusFilter(["conflict", "bogus", "conflict", 3], true), ["conflict"]);
		assert.deepStrictEqual(initialStatusFilter(["only-org", SYNC_IN_PROJECT], false), ["only-org", SYNC_IN_PROJECT]);
	});

	it("browsing the org clears the status group and 'only selected'; types are replaced only when given, other facets stay", () => {
		const f = { ...DEFAULT_FILTER, query: "foo", types: ["ApexClass"], status: [SYNC_IN_PROJECT], onlySelected: true, mine: true };
		const all = browseFilter(f, []);
		assert.deepStrictEqual(all.status, []);
		assert.strictEqual(all.onlySelected, false);
		assert.deepStrictEqual(all.types, ["ApexClass"]);
		assert.strictEqual(all.query, "foo");
		assert.strictEqual(all.mine, true);
		assert.deepStrictEqual(browseFilter(f, ["Flow", "CustomObject"]).types, ["Flow", "CustomObject"]);
		assert.deepStrictEqual(f.status, [SYNC_IN_PROJECT], "the input is not modified");
	});

	it("Group by type is on by default; a store from before the default gets it once, the user's choice is kept after", () => {
		assert.strictEqual(initialGroup(undefined, false), true);
		assert.strictEqual(initialGroup(false, false), true);
		assert.strictEqual(initialGroup(true, false), true);
		assert.strictEqual(initialGroup(false, true), false);
		assert.strictEqual(initialGroup(true, true), true);
		assert.strictEqual(initialGroup(undefined, true), true);
		assert.strictEqual(initialGroup("yes", true), true);
	});

	it("Clear all filters keeps In project on and the only-selected toggle as it was", () => {
		assert.deepStrictEqual(centerFilterKeptOnClear(false), { status: [SYNC_IN_PROJECT], onlySelected: false });
		assert.deepStrictEqual(centerFilterKeptOnClear(true), { status: [SYNC_IN_PROJECT], onlySelected: true });
	});
});

describe("history views: label", () => {
	it("carries the Deploy name", () => {
		const e: HistoryEntry = { id: "1", kind: "deploy", org: "o", at: T0, durationMs: 1, components: ["ApexClass:A"], componentCount: 1, ok: true, source: "center", label: "Sprint 42" };
		const [v] = historyViews([e], T0 + HOUR);
		assert.strictEqual(v.label, "Sprint 42");
		const [w] = historyViews([{ ...e, label: undefined }], T0 + HOUR);
		assert.ok(!("label" in w));
	});
});

describe("sync center: override toggle", () => {
	it("cycles unset, keep local, take org, unset", () => {
		assert.strictEqual(nextChoice(undefined), "local");
		assert.strictEqual(nextChoice("local"), "org");
		assert.strictEqual(nextChoice("org"), undefined);
		assert.ok(choiceTitle("local").startsWith("Keep local"));
		assert.ok(choiceTitle(undefined).startsWith("No override"));
	});
});

describe("sync center: Modified window uses the org date or the local change time", () => {
	const NOW = Date.UTC(2026, 5, 15, 12);
	const DAY = 86400_000;
	const mk = (n: string, lm: number) => ({ t: "ApexClass", n, ns: "", ms: "", by: "", bi: "", lm, cd: 0, id: "", f: "" });
	// 0 org old / local old, 1 org recent, 2 local recent only (org old), 3 only-local recent (no org date), 4 only-org old
	const comps = [mk("OldBoth", NOW - 90 * DAY), mk("OrgRecent", NOW - DAY), mk("LocalRecent", NOW - 90 * DAY), mk("OnlyLocal", 0), mk("OnlyOrgOld", NOW - 90 * DAY)];
	const localTimes = [NOW - 80 * DAY, 0, NOW - 2 * DAY, NOW - 3 * DAY, 0];
	const idx = buildIndex(comps);
	const ctx = (lt: ArrayLike<number> | undefined): FilterContext => ({ now: NOW, status: null, localTimes: lt });
	const names = (lt: ArrayLike<number> | undefined, within: "7d" | "any" = "7d") => filterIndices(idx, { ...DEFAULT_FILTER, within }, ctx(lt)).map((i) => comps[i].n);

	it("withinWindow: either date inside the window passes; 0 means unknown", () => {
		assert.strictEqual(withinWindow(0, 0, 1, 10), false);
		assert.strictEqual(withinWindow(5, 0, 1, 10), true);
		assert.strictEqual(withinWindow(50, 5, 1, 10), true);
		assert.strictEqual(withinWindow(50, 0, 1, 10), false);
	});

	it("a row passes when its org date or its local change time is in the last 7 days", () => {
		assert.deepStrictEqual(names(localTimes), ["OrgRecent", "LocalRecent", "OnlyLocal"]);
		// without local times only the org date counts (the old behaviour)
		assert.deepStrictEqual(names(undefined), ["OrgRecent"]);
		assert.strictEqual(names(localTimes, "any").length, 5);
	});

	it("the facet counts use the same predicate", () => {
		const f = computeFacets(idx, { ...DEFAULT_FILTER, within: "7d" }, ctx(localTimes));
		assert.strictEqual([...f.types.values()].reduce((a, b) => a + b, 0), 3);
	});
});

describe("sync center: Retrieve project prompt", () => {
	it("names count, project and org, and lists up to 10 locally changed components", () => {
		const changed = Array.from({ length: 12 }, (_, i) => `ApexClass:C${i}`);
		const p = retrieveProjectPrompt(120, "MyProj", "dev-org", changed);
		assert.strictEqual(p.message, "Retrieve 120 components of project MyProj from dev-org? Local files will be overwritten.");
		assert.ok(p.detail.includes("ApexClass:C9") && !p.detail.includes("ApexClass:C10") && p.detail.includes("+2 more"));
		assert.ok(!retrieveProjectPrompt(1, "P", "o", []).detail.includes("Changed locally"));
	});
});

describe("sync center: selection banner text", () => {
	it("uses the summary of the current mode, with the hidden part when relevant", () => {
		assert.strictEqual(selectionBannerText("deploy", 5, 3), "Showing your selection: 5 selected · 3 to deploy · 2 skipped");
		assert.strictEqual(selectionBannerText("retrieve", 5, 3, 2), "Showing your selection: 5 selected (2 hidden) · 3 to retrieve · 2 skipped");
		assert.strictEqual(selectionBannerText("deploy", 0, 0), "Showing your selection: 0 selected");
	});
});

describe("presetModified", () => {
	it("is false when the selection equals the preset's keys", () => {
		assert.strictEqual(presetModified(["ApexClass:A", "CustomObject:Account"], ["ApexClass:A", "CustomObject:Account"]), false);
	});

	it("ignores order", () => {
		assert.strictEqual(presetModified(["ApexClass:A", "CustomObject:Account"], ["CustomObject:Account", "ApexClass:A"]), false);
	});

	it("is true when a key is added to the selection", () => {
		assert.strictEqual(presetModified(["ApexClass:A"], ["ApexClass:A", "ApexClass:B"]), true);
	});

	it("is true when a key is removed from the selection", () => {
		assert.strictEqual(presetModified(["ApexClass:A", "ApexClass:B"], ["ApexClass:A"]), true);
	});

	it("is true when a key is swapped for another of the same size", () => {
		assert.strictEqual(presetModified(["ApexClass:A", "ApexClass:B"], ["ApexClass:A", "ApexClass:C"]), true);
	});

	it("treats two empty sets as equal and an empty selection against a non-empty preset as modified", () => {
		assert.strictEqual(presetModified([], []), false);
		assert.strictEqual(presetModified(["ApexClass:A"], []), true);
	});

	it("accepts any iterable for the selection (a Set)", () => {
		assert.strictEqual(presetModified(["ApexClass:A"], new Set(["ApexClass:A"])), false);
		assert.strictEqual(presetModified(["ApexClass:A"], new Set(["ApexClass:B"])), true);
	});
});
