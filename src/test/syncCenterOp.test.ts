import * as assert from "assert";
import { DeployLiveStatus } from "../utils/deployStatusMap";
import { OpMessage, applyLive, applyRetrieveProgress, isFinished, newOp, progressOfLive, sameOpState, settleOp, settleSimple, testsDone } from "../utils/syncCenterOpPure";

const live = (o: Partial<DeployLiveStatus> = {}): DeployLiveStatus => ({
	status: "InProgress",
	componentsDeployed: 0,
	componentsTotal: 0,
	componentErrors: 0,
	testsCompleted: 0,
	testsTotal: 0,
	testErrors: 0,
	done: false,
	...o,
});

describe("Center op state: live progress mapping", () => {
	it("a pending deploy is queued, an in-progress one is running with the component numbers", () => {
		assert.deepStrictEqual(progressOfLive(live({ status: "Pending" })), { phase: "queued", message: "Waiting in the org's deploy queue" });
		const p = progressOfLive(live({ componentsDeployed: 3, componentsTotal: 10, componentErrors: 1 }));
		assert.strictEqual(p.phase, "running");
		assert.deepStrictEqual(p.components, { done: 3, total: 10, errors: 1 });
		assert.strictEqual(p.message, "Deploying components");
		assert.strictEqual(p.tests, undefined);
	});

	it("reports the tests while they run, counting failed ones as processed like the notification does", () => {
		const p = progressOfLive(live({ componentsDeployed: 10, componentsTotal: 10, testsCompleted: 4, testErrors: 2, testsTotal: 20 }));
		assert.deepStrictEqual(p.tests, { done: 6, total: 20, errors: 2 });
		assert.strictEqual(p.message, "Running tests");
		assert.strictEqual(testsDone(19, 5, 20), 20, "never more than the total");
	});

	it("shows the org's own state detail and a canceling deploy", () => {
		assert.strictEqual(progressOfLive(live({ stateDetail: "Processing Type: ApexClass" })).message, "Processing Type: ApexClass");
		const c = progressOfLive(live({ status: "Canceling" }));
		assert.strictEqual(c.phase, "running");
		assert.strictEqual(c.message, "Canceling…");
	});

	it("applies a snapshot to an op and never moves a finished op back", () => {
		const op = newOp("deploy", "op1", "Deploy 3 components", 1000);
		assert.strictEqual(op.phase, "queued");
		assert.strictEqual(op.startedAt, 1000);
		const running = applyLive(op, live({ componentsDeployed: 1, componentsTotal: 3 }));
		assert.strictEqual(running.phase, "running");
		assert.deepStrictEqual(running.components, { done: 1, total: 3, errors: 0 });
		assert.strictEqual(running.label, "Deploy 3 components");
		const pending = applyLive(running, live({ status: "Pending" }));
		assert.strictEqual(pending.phase, "queued");
		const done = settleSimple(running, "done", undefined, 2000);
		assert.strictEqual(applyLive(done, live()), done);
	});

	it("tracks a retrieve as running with done/total", () => {
		const op = newOp("retrieve", "r1", "Retrieve 4 components", 5, "running");
		const p = applyRetrieveProgress(op, 2, 4);
		assert.deepStrictEqual(p.components, { done: 2, total: 4, errors: 0 });
		assert.strictEqual(p.phase, "running");
	});

	it("only sends a message when something visible changed", () => {
		const op = newOp("deploy", "o", "x", 1);
		const a = applyLive(op, live({ componentsDeployed: 1, componentsTotal: 3 }));
		assert.ok(!sameOpState(undefined, a));
		assert.ok(sameOpState(a, applyLive(a, live({ componentsDeployed: 1, componentsTotal: 3 }))), "the 100 ms ticker repeats the same numbers");
		assert.ok(!sameOpState(a, applyLive(a, live({ componentsDeployed: 2, componentsTotal: 3 }))));
		assert.ok(!sameOpState(a, applyLive(a, live({ componentsDeployed: 1, componentsTotal: 3, testsTotal: 5 }))));
	});
});

describe("Center op state: settling", () => {
	const running = (): OpMessage => applyLive(newOp("deploy", "o", "Deploy", 1000), live({ componentsDeployed: 2, componentsTotal: 5, testsCompleted: 3, testsTotal: 8 }));

	it("a successful run is done with everything processed, the deploy id and an end time", () => {
		const s = settleOp(running(), { kind: "success", deployId: "0Af000000000001AAA", stats: { components: 5, componentErrors: 0, testsPassed: 8, testsFailed: 0 } }, 9000);
		assert.strictEqual(s.phase, "done");
		assert.strictEqual(s.deployId, "0Af000000000001AAA");
		assert.strictEqual(s.endedAt, 9000);
		assert.strictEqual(s.startedAt, 1000);
		assert.deepStrictEqual(s.components, { done: 5, total: 5, errors: 0 });
		assert.deepStrictEqual(s.tests, { done: 8, total: 8, errors: 0 });
		assert.strictEqual(s.message, undefined);
		assert.ok(isFinished(s.phase));
	});

	it("a failed run carries the org's reason, else the counts", () => {
		const base = newOp("validate", "v", "Validate", 1);
		const a = settleOp(base, { kind: "failed", apiResult: { errorMessage: "Dependent class is invalid" }, stats: { components: 1, componentErrors: 2, testsPassed: 0, testsFailed: 0 } }, 5);
		assert.strictEqual(a.phase, "failed");
		assert.strictEqual(a.message, "Dependent class is invalid");
		assert.deepStrictEqual(a.components, { done: 1, total: 3, errors: 2 });
		const b = settleOp(base, { kind: "failed", stats: { components: 4, componentErrors: 1, testsPassed: 3, testsFailed: 2 } }, 5);
		assert.strictEqual(b.message, "1 component error, 2 test failures");
		const c = settleOp(base, { kind: "failed", errorText: "sf: command\n  not found" }, 5);
		assert.strictEqual(c.message, "sf: command not found");
		assert.strictEqual(settleOp(base, { kind: "failed" }, 5).message, "Failed");
	});

	it("a cancelled run is cancelled", () => {
		const s = settleOp(running(), { kind: "cancelled" }, 7);
		assert.strictEqual(s.phase, "cancelled");
		assert.strictEqual(s.message, "Cancelled");
		assert.strictEqual(s.endedAt, 7);
	});

	it("settles without an outcome (retrieve, error before the run)", () => {
		const op = newOp("retrieve", "r", "Retrieve 2", 1, "running");
		const d = settleSimple(op, "done", "Retrieved 2", 4);
		assert.deepStrictEqual([d.phase, d.message, d.endedAt], ["done", "Retrieved 2", 4]);
		const f = settleSimple(op, "failed", "  x\ny ", 4);
		assert.strictEqual(f.message, "x y");
		assert.strictEqual(settleSimple({ ...op, message: "old" }, "done", undefined, 4).message, undefined);
	});
});
