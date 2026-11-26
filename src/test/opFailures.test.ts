import * as assert from "assert";
import { failureLine, failuresOfDeploy, failuresOfRetrieve, newOp, retrieveSummary, settleOp, settleSimple, visibleFailures } from "../utils/syncCenterOpPure";

describe("op card: why it failed", () => {
	const running = () => newOp("retrieve", "o1", "Retrieve 1 component", 1000, "running");

	it("a failed retrieve lists its failed components with their messages", () => {
		const f = failuresOfRetrieve([{ type: "CustomField", fullName: "Acme__c.X__c", error: "Conflict" }]);
		assert.deepStrictEqual(f, [{ type: "CustomField", name: "Acme__c.X__c", message: "Conflict" }]);
		const op = settleSimple(running(), "failed", "Retrieved 31 components, 1 failed", 2000, f);
		assert.deepStrictEqual(op.failures, f);
		assert.strictEqual(failureLine(f[0]), "CustomField Acme__c.X__c — Conflict");
	});

	it("no failures: the field stays absent", () => {
		assert.strictEqual(settleSimple(running(), "done", "ok", 2000, []).failures, undefined);
	});

	it("a failed deploy lists the component failures and the tests", () => {
		const api = {
			details: {
				componentFailures: [{ componentType: "CustomField", fullName: "Acme__c.X__c", problem: "Field is referenced" }],
				runTestResult: { failures: [{ name: "FooTest", methodName: "t1", message: "boom" }] },
			},
		};
		const op = settleOp(newOp("deploy", "d1", undefined, 1, "running"), { kind: "failed", apiResult: api as never, stats: { components: 0, componentErrors: 1, testsPassed: 0, testsFailed: 1 } }, 9);
		assert.deepStrictEqual(op.failures, [
			{ type: "CustomField", name: "Acme__c.X__c", message: "Field is referenced" },
			{ type: "ApexClass", name: "FooTest", message: "t1: boom" },
		]);
	});

	it("without per-component messages the CLI error text is shown", () => {
		const op = settleOp(newOp("deploy", "d1", undefined, 1, "running"), { kind: "failed", errorText: "sf: not authorized" }, 9);
		assert.deepStrictEqual(op.failures, [{ message: "sf: not authorized" }]);
		assert.strictEqual(failureLine(op.failures![0]), "sf: not authorized");
	});

	it("a successful deploy has no failures", () => {
		const op = settleOp(newOp("deploy", "d1", undefined, 1, "running"), { kind: "success", stats: { components: 1, componentErrors: 0, testsPassed: 0, testsFailed: 0 } }, 9);
		assert.strictEqual(op.failures, undefined);
	});

	it("5 lines are shown, the rest behind Show all", () => {
		const many = Array.from({ length: 8 }, (_, i) => ({ type: "CustomField", name: `A.F${i}`, message: "x" }));
		assert.deepStrictEqual([visibleFailures(many, false).shown.length, visibleFailures(many, false).more], [5, 3]);
		assert.deepStrictEqual([visibleFailures(many, true).shown.length, visibleFailures(many, true).more], [8, 0]);
		assert.strictEqual(visibleFailures(many.slice(0, 5), false).more, 0);
	});

	it("the retrieve summary counts components and says when the org returned more than was asked for", () => {
		assert.strictEqual(retrieveSummary(1, 1, 0), "Retrieved 1 component");
		assert.match(retrieveSummary(1, 31, 1), /^Retrieved 31 components \(1 requested.*\), 1 failed$/);
	});
});
