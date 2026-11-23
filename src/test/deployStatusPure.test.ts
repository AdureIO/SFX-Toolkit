import * as assert from "assert";
import {
	DS_CHANGED_IN_ORG,
	DS_CHANGED_LOCALLY,
	DS_CONFLICT,
	DS_EQUAL,
	DS_NEW,
	DS_UNKNOWN,
	DEPLOY_STATUS_NAMES,
	DEPLOY_VOCAB,
	OrgCompInfo,
	deployStatus,
	evaluatePreDeploy,
	orgLookupKey,
	preDeployPrompt,
} from "../utils/deployStatusPure";
import { DEFAULT_FILTER, FilterContext, buildIndex, computeFacets, filterIndices } from "../utils/orgBrowser/filter";
import { Comp } from "../utils/orgBrowser/types";

const T0 = Date.parse("2025-06-01T10:00:00Z");
const HOUR = 3600_000;

describe("deploy status: codes", () => {
	const base = { orgKnown: true, inOrg: true, orgLm: T0, syncedAt: T0, local: { localT: T0 - HOUR, dirty: false } };

	it("new: local, but not in the org listing of its type", () => {
		assert.deepStrictEqual(deployStatus({ ...base, inOrg: false, orgLm: 0 }), { code: DS_NEW, provisional: false });
	});

	it("unknown: the org listing of the type is missing, or the local info is not read yet", () => {
		assert.deepStrictEqual(deployStatus({ ...base, orgKnown: false, inOrg: false }), { code: DS_UNKNOWN, provisional: true, why: "org" });
		assert.deepStrictEqual(deployStatus({ ...base, local: undefined }), { code: DS_UNKNOWN, provisional: true, why: "local" });
	});

	it("equal / changed locally / changed in org / conflict from dates (provisional)", () => {
		assert.deepStrictEqual(deployStatus(base), { code: DS_EQUAL, provisional: true });
		assert.strictEqual(deployStatus({ ...base, local: { localT: T0 + HOUR, dirty: false } }).code, DS_CHANGED_LOCALLY);
		assert.strictEqual(deployStatus({ ...base, local: { localT: T0 - HOUR, dirty: true } }).code, DS_CHANGED_LOCALLY);
		assert.strictEqual(deployStatus({ ...base, orgLm: T0 + HOUR }).code, DS_CHANGED_IN_ORG);
		assert.strictEqual(deployStatus({ ...base, orgLm: T0 + HOUR, local: { localT: T0 - HOUR, dirty: true } }).code, DS_CONFLICT);
	});

	it("a verified content result wins over dates", () => {
		const same = deployStatus({ ...base, orgLm: T0 + HOUR, local: { localT: T0, dirty: true }, content: "same" });
		assert.deepStrictEqual(same, { code: DS_EQUAL, provisional: false });
		const diff = deployStatus({ ...base, content: "different" });
		assert.strictEqual(diff.provisional, false);
	});

	it("verified equal does not need the local info", () => {
		assert.strictEqual(deployStatus({ ...base, local: undefined, content: "same" }).code, DS_EQUAL);
	});

	it("looks a component up by its decoded name (source files percent-encode some characters)", () => {
		assert.strictEqual(orgLookupKey("Layout", "Account-Account%20Layout"), "Layout:Account-Account Layout");
		assert.strictEqual(orgLookupKey("ApexClass", "Foo"), "ApexClass:Foo");
		assert.strictEqual(orgLookupKey("Layout", "100%"), "Layout:100%"); // not decodable: kept
	});
});

describe("deploy status: filter vocabulary", () => {
	const comp = (t: string, n: string): Comp => ({ t, n, ns: "", ms: "", by: "", bi: "", lm: 0, cd: 0, id: "", f: "" });
	const rows = [comp("ApexClass", "NewOne"), comp("ApexClass", "Plain"), comp("ApexClass", "Edited"), comp("ApexClass", "OrgSide"), comp("ApexClass", "Clash"), comp("Flow", "Mystery")];
	const status = Uint8Array.from([DS_NEW, DS_EQUAL, DS_CHANGED_LOCALLY, DS_CHANGED_IN_ORG, DS_CONFLICT, DS_UNKNOWN]);
	const ctx: FilterContext = { now: 0, status, vocab: DEPLOY_VOCAB };
	const q = (query: string) => filterIndices(buildIndex(rows), { ...DEFAULT_FILTER, query }, ctx).map((i) => rows[i].n);

	it("status: new | equal | changed-locally | changed-in-org | conflict | unknown", () => {
		assert.deepStrictEqual(q("status:new"), ["NewOne"]);
		assert.deepStrictEqual(q("status:equal"), ["Plain"]);
		assert.deepStrictEqual(q("status:changed-locally"), ["Edited"]);
		assert.deepStrictEqual(q("status:changed-in-org"), ["OrgSide"]);
		assert.deepStrictEqual(q("status:conflict"), ["Clash"]);
		assert.deepStrictEqual(q("status:unknown"), ["Mystery"]);
	});

	it("keeps the old aliases working", () => {
		assert.deepStrictEqual(q("status:changed"), ["OrgSide"]);
		for (const a of ["modified", "local", "dirty", "modified-locally"]) assert.deepStrictEqual(q(`status:${a}`), ["Edited"], a);
		assert.deepStrictEqual(q("status:not-in-org"), ["NewOne"]);
	});

	it("status:inorg is any of equal / changed-* / conflict", () => {
		assert.deepStrictEqual(q("status:inorg"), ["Plain", "Edited", "OrgSide", "Clash"]);
		assert.deepStrictEqual(q("status:in-org"), ["Plain", "Edited", "OrgSide", "Clash"]);
		assert.deepStrictEqual(q("-status:inorg type:ApexClass"), ["NewOne"]);
	});

	it("combines with the rest of the grammar and with the facet filter", () => {
		assert.deepStrictEqual(q("status:changed-locally edit"), ["Edited"]);
		const idx = buildIndex(rows);
		const f = filterIndices(idx, { ...DEFAULT_FILTER, status: ["new", "unknown"] }, ctx).map((i) => rows[i].n);
		assert.deepStrictEqual(f, ["NewOne", "Mystery"]);
		const facets = computeFacets(idx, DEFAULT_FILTER, ctx);
		assert.deepStrictEqual(facets.status, [1, 1, 1, 1, 1, 1]);
		assert.strictEqual(facets.status.length, DEPLOY_STATUS_NAMES.length);
	});
});

describe("deploy status: pre-deploy check decision", () => {
	const sel = (key: string) => ({ key, type: key.split(":")[0], name: key.split(":")[1] });
	const org = (entries: [string, OrgCompInfo][]) => new Map(entries);

	it("proceeds without asking when nothing selected changed in the org", () => {
		const d = evaluatePreDeploy({
			selected: [sel("ApexClass:A"), sel("ApexClass:B")],
			orgComps: org([
				["ApexClass:A", { lm: T0, by: "Jane" }],
				["ApexClass:B", { lm: T0 - HOUR, by: "Joe" }],
			]),
			listedTypes: new Set(["ApexClass"]),
			failedTypes: new Map(),
			syncedAt: { "ApexClass:A": T0, "ApexClass:B": T0 },
		});
		assert.deepStrictEqual(d.changed, []);
		assert.strictEqual(d.needsConfirmation, false);
	});

	it("lists every selected component that is newer in the org than its last retrieve / deploy, newest first", () => {
		const d = evaluatePreDeploy({
			selected: [sel("ApexClass:A"), sel("ApexClass:B"), sel("ApexClass:C"), sel("Flow:F")],
			orgComps: org([
				["ApexClass:A", { lm: T0 + HOUR, by: "Jane" }],
				["ApexClass:B", { lm: T0 + 3 * HOUR, by: "Joe" }],
				["ApexClass:C", { lm: T0, by: "Jim" }],
				["Flow:F", { lm: T0 + 2 * HOUR, by: "Jan" }],
			]),
			listedTypes: new Set(["ApexClass", "Flow"]),
			failedTypes: new Map(),
			syncedAt: { "ApexClass:A": T0, "ApexClass:B": T0, "ApexClass:C": T0, "Flow:F": T0 },
		});
		assert.deepStrictEqual(d.changed.map((c) => [c.key, c.by]), [["ApexClass:B", "Joe"], ["Flow:F", "Jan"], ["ApexClass:A", "Jane"]]);
		assert.strictEqual(d.needsConfirmation, true);
	});

	it("ignores components that are new in the org, never synced, or not selected", () => {
		const d = evaluatePreDeploy({
			selected: [sel("ApexClass:Brand"), sel("ApexClass:NeverSynced")],
			orgComps: org([
				["ApexClass:NeverSynced", { lm: T0 + HOUR, by: "x" }],
				["ApexClass:Other", { lm: T0 + HOUR, by: "x" }],
			]),
			listedTypes: new Set(["ApexClass"]),
			failedTypes: new Map(),
			syncedAt: { "ApexClass:Other": T0 },
		});
		assert.deepStrictEqual(d.changed, []);
	});

	it("a type that could not be listed does not block: its components are reported unverified", () => {
		const d = evaluatePreDeploy({
			selected: [sel("ApexClass:A"), sel("Flow:F"), sel("Report:R")],
			orgComps: org([["ApexClass:A", { lm: T0, by: "Jane" }]]),
			listedTypes: new Set(["ApexClass"]),
			failedTypes: new Map([["Flow", "HTTP 503"]]),
			syncedAt: { "ApexClass:A": T0, "Flow:F": T0 },
		});
		assert.strictEqual(d.needsConfirmation, false);
		assert.deepStrictEqual(d.unverified, [
			{ key: "Flow:F", reason: "HTTP 503" },
			{ key: "Report:R", reason: "type not listed" },
		]);
	});

	it("matches Layouts by their decoded name", () => {
		const d = evaluatePreDeploy({
			selected: [sel("Layout:Account-Account%20Layout")],
			orgComps: org([["Layout:Account-Account Layout", { lm: T0 + HOUR, by: "Jane" }]]),
			listedTypes: new Set(["Layout"]),
			failedTypes: new Map(),
			syncedAt: { "Layout:Account-Account%20Layout": T0 },
		});
		assert.strictEqual(d.changed.length, 1);
	});

	it("a component verified equal never warns, one that is not still does", () => {
		const input = {
			selected: [sel("ApexClass:A"), sel("ApexClass:B")],
			orgComps: org([
				["ApexClass:A", { lm: T0 + HOUR, by: "Jane" }],
				["ApexClass:B", { lm: T0 + HOUR, by: "Joe" }],
			]),
			listedTypes: new Set(["ApexClass"]),
			failedTypes: new Map<string, string>(),
			syncedAt: { "ApexClass:A": T0, "ApexClass:B": T0 },
		};
		const d = evaluatePreDeploy({ ...input, verifiedEqual: new Set(["ApexClass:A"]) });
		assert.deepStrictEqual(d.changed.map((c) => c.key), ["ApexClass:B"]);
		assert.strictEqual(evaluatePreDeploy({ ...input, verifiedEqual: new Set(["ApexClass:A", "ApexClass:B"]) }).needsConfirmation, false);
	});

	it("the modal text lists component, modifier and time, and caps the list", () => {
		const changed = Array.from({ length: 12 }, (_, i) => ({ key: `ApexClass:C${i}`, type: "ApexClass", name: `C${i}`, by: i === 0 ? "" : "Jane", lm: T0 + i, syncedAt: T0 }));
		const p = preDeployPrompt(changed, false, (ms) => `@${ms - T0}`);
		assert.strictEqual(p.message, "12 components changed in the org since your last retrieve or deploy");
		assert.ok(p.detail.includes("ApexClass:C0 — last modified by unknown, @0"));
		assert.ok(p.detail.includes("ApexClass:C9 — last modified by Jane, @9"));
		assert.ok(!p.detail.includes("ApexClass:C10"));
		assert.ok(p.detail.endsWith("… and 2 more"));
		assert.strictEqual(preDeployPrompt(changed.slice(0, 1), true, () => "x").message, "1 component changed in the org since your last retrieve or deploy");
	});
});
