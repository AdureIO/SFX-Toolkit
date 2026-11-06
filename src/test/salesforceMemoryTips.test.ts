import * as assert from "assert";
import { planMemoryTip, isJorjeMemorySet, memoryTipMessage, MemoryTipInputs } from "../utils/salesforceMemoryTips";

const base: MemoryTipInputs = { jorjeInstalled: true, jorjeMemory: null, tsServerEnabled: false, alreadyShown: false, force: false };

describe("isJorjeMemorySet", () => {
	it("only finite numbers count", () => {
		assert.strictEqual(isJorjeMemorySet(1024), true);
		assert.strictEqual(isJorjeMemorySet(null), false);
		assert.strictEqual(isJorjeMemorySet(undefined), false);
		assert.strictEqual(isJorjeMemorySet("2048"), false);
		assert.strictEqual(isJorjeMemorySet(NaN), false);
	});
});

describe("planMemoryTip", () => {
	it("offers the Jorje limit when installed and unset", () => {
		assert.deepStrictEqual(planMemoryTip(base), { show: true, offerLimitJorje: true, offerShowTsServer: false });
	});
	it("does not show when Jorje memory is already set and TS server absent", () => {
		assert.strictEqual(planMemoryTip({ ...base, jorjeMemory: 2048 }).show, false);
	});
	it("does not show when Jorje is absent and TS server absent", () => {
		assert.strictEqual(planMemoryTip({ ...base, jorjeInstalled: false }).show, false);
	});
	it("offers the TS server alone when enabled", () => {
		assert.deepStrictEqual(planMemoryTip({ ...base, jorjeInstalled: false, tsServerEnabled: true }), {
			show: true,
			offerLimitJorje: false,
			offerShowTsServer: true,
		});
	});
	it("offers both", () => {
		const p = planMemoryTip({ ...base, tsServerEnabled: true });
		assert.ok(p.show && p.offerLimitJorje && p.offerShowTsServer);
	});
	it("shows only once per machine unless forced", () => {
		assert.strictEqual(planMemoryTip({ ...base, alreadyShown: true }).show, false);
		assert.strictEqual(planMemoryTip({ ...base, alreadyShown: true, force: true }).show, true);
	});
	it("force does not show when nothing is eligible", () => {
		assert.strictEqual(planMemoryTip({ ...base, jorjeInstalled: false, force: true }).show, false);
	});
});

describe("memoryTipMessage", () => {
	it("warns about syntax highlighting when the TS server is mentioned", () => {
		assert.match(memoryTipMessage({ offerLimitJorje: false, offerShowTsServer: true }), /syntax highlighting/);
		assert.doesNotMatch(memoryTipMessage({ offerLimitJorje: true, offerShowTsServer: false }), /TypeScript/);
	});
});
