import * as assert from "assert";
import { OrgCompInfo, evaluatePreDeploy, orgLookupKey, preDeployPrompt } from "../utils/deployStatusPure";
import { DEFAULT_FILTER, FilterContext, buildIndex, computeFacets, filterIndices } from "../utils/orgBrowser/filter";
import { Comp } from "../utils/orgBrowser/types";

const T0 = Date.parse("2025-06-01T10:00:00Z");
const HOUR = 3600_000;

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
