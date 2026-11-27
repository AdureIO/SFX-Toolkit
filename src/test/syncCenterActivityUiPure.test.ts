import * as assert from "assert";
import type { DeployListItem } from "../utils/deployListPure";
import {
	canCancelOp,
	componentErrorWhere,
	countsText,
	deployRowView,
	detailsAreEmpty,
	errorPercent,
	formatDuration,
	opActions,
	opElapsedText,
	opJustFinished,
	opTitle,
	phaseLabel,
	progressPercent,
	testErrorName,
} from "../utils/syncCenterActivityUiPure";

describe("Center activity UI: operation card", () => {
	it("title, phase label, cancel rules", () => {
		assert.strictEqual(opTitle({ kind: "validate" }), "Validate");
		assert.strictEqual(opTitle({ kind: "deploy", label: " Sprint 42 " }), "Deploy · Sprint 42");
		assert.strictEqual(phaseLabel("cancelled"), "Cancelled");
		assert.strictEqual(canCancelOp({ kind: "deploy", phase: "queued" }), true);
		assert.strictEqual(canCancelOp({ kind: "delete", phase: "running" }), true);
		assert.strictEqual(canCancelOp({ kind: "retrieve", phase: "running" }), false);
		assert.strictEqual(canCancelOp({ kind: "deploy", phase: "done" }), false);
	});
	it("durations", () => {
		assert.strictEqual(formatDuration(-5), "0 s");
		assert.strictEqual(formatDuration(42_900), "42 s");
		assert.strictEqual(formatDuration(185_000), "3 m 05 s");
		assert.strictEqual(formatDuration(3_720_000), "1 h 02 m");
		assert.strictEqual(opElapsedText({ startedAt: 1000, endedAt: 6000 }, 99_000), "5 s");
		assert.strictEqual(opElapsedText({ startedAt: 1000 }, 66_000), "1 m 05 s");
	});
	it("progress numbers", () => {
		assert.strictEqual(progressPercent({ done: 3, total: 10 }), 30);
		assert.strictEqual(progressPercent({ done: 3, total: 0 }), 0);
		assert.strictEqual(progressPercent(undefined), 0);
		assert.strictEqual(progressPercent({ done: 12, total: 10 }), 100);
		assert.strictEqual(errorPercent({ total: 10, errors: 2 }), 20);
		assert.strictEqual(countsText({ done: 1200, total: 2000, errors: 0 }), "1,200/2,000");
		assert.strictEqual(countsText({ done: 3, total: 10, errors: 1 }), "3/10 · 1 error");
		assert.strictEqual(countsText({ done: 3, total: 10, errors: 2 }, "failure"), "3/10 · 2 failures");
		assert.strictEqual(countsText({ done: 0, total: 0, errors: 0 }), "");
		assert.strictEqual(countsText(undefined), "");
	});
	it("actions of a finished op and the finish transition", () => {
		assert.deepStrictEqual(opActions({ kind: "deploy", phase: "done", deployId: "0Af000000000001AAA" }), { details: true, setup: true });
		assert.deepStrictEqual(opActions({ kind: "deploy", phase: "running" }), { details: false, setup: false });
		assert.deepStrictEqual(opActions({ kind: "retrieve", phase: "done" }), { details: false, setup: false });
		assert.strictEqual(opJustFinished({ phase: "running" }, { phase: "done" }), true);
		assert.strictEqual(opJustFinished({ phase: "queued" }, { phase: "failed" }), true);
		assert.strictEqual(opJustFinished({ phase: "done" }, { phase: "done" }), false);
		assert.strictEqual(opJustFinished({ phase: "running" }, { phase: "running" }), false);
		assert.strictEqual(opJustFinished(undefined, { phase: "done" }), false);
	});
});

describe("Center activity UI: deploy rows", () => {
	const base: DeployListItem = { id: "0Af000000000001AAA", deployId: "0Af000000000001AAA", kind: "validate", status: "Failed", ok: false, org: "dev", startedAt: 1_000_000, durationMs: 65_000, source: "both", componentKeys: ["ApexClass:Foo"] };
	const now = 1_000_000 + 5 * 60_000;
	it("a failed validate", () => {
		const v = deployRowView({ ...base, label: "Hotfix", createdBy: "Ann", components: { done: 8, total: 10, errors: 2 }, tests: { done: 5, total: 5, errors: 1 } }, now);
		assert.strictEqual(v.state, "bad");
		assert.strictEqual(v.title, "Hotfix");
		assert.strictEqual(v.kindLabel, "Validate");
		assert.strictEqual(v.createdBy, "Ann");
		assert.strictEqual(v.when, "5 min ago");
		assert.strictEqual(v.duration, "1 m 05 s");
		assert.strictEqual(v.componentsText, "8/10 · 2 errors");
		assert.strictEqual(v.testsText, "5/5 · 1 failure");
		assert.strictEqual(v.sourceLabel, "both");
		assert.strictEqual(v.statusText, "Failed");
		assert.ok(v.canSetup && v.canSelect && v.hasDetails);
	});
	it("a running local-less row, a local retrieve", () => {
		const run = deployRowView({ ...base, status: "InProgress", ok: null, durationMs: undefined, componentKeys: undefined, kind: "deploy" }, now);
		assert.strictEqual(run.state, "run");
		assert.strictEqual(run.title, "Deploy");
		assert.strictEqual(run.duration, "");
		assert.strictEqual(run.canSelect, false);
		const ret = deployRowView({ ...base, id: "h1", deployId: undefined, kind: "retrieve", status: "Succeeded", ok: true, source: "local" }, now);
		assert.strictEqual(ret.state, "ok");
		assert.strictEqual(ret.canSetup, false);
		assert.strictEqual(ret.hasDetails, false);
	});
});

describe("Center activity UI: deploy details", () => {
	it("names and locations", () => {
		assert.strictEqual(testErrorName({ className: "FooTest", methodName: "bar", message: "x" }), "FooTest.bar");
		assert.strictEqual(testErrorName({ className: "FooTest", message: "x" }), "FooTest");
		assert.strictEqual(testErrorName({ message: "x" }), "Test");
		assert.deepStrictEqual(componentErrorWhere({ type: "ApexClass", name: "Foo", line: 3, column: 7, message: "m" }), { who: "ApexClass Foo", loc: "3:7" });
		assert.deepStrictEqual(componentErrorWhere({ fileName: "x.cls", line: 3, message: "m" }), { who: "x.cls", loc: "3" });
		assert.deepStrictEqual(componentErrorWhere({ message: "m" }), { who: "", loc: "" });
	});
	it("empty details", () => {
		assert.strictEqual(detailsAreEmpty({ componentErrors: [], testErrors: [] }), true);
		assert.strictEqual(detailsAreEmpty({ componentErrors: [], testErrors: [], codeCoverageWarnings: ["w"] }), false);
	});
});
