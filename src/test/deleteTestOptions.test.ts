import * as assert from "assert";
import { DELETE_TEST_LEVELS, checkDeleteTestOptions, deleteTestHint } from "../utils/deployTestArgsPure";

describe("delete from org: test options", () => {
	it("offers the four levels", () => {
		assert.deepStrictEqual([...DELETE_TEST_LEVELS], ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"]);
	});

	it("production cannot use NoTestRun", () => {
		assert.ok(checkDeleteTestOptions("NoTestRun", [], ["Layout"], true).error);
		assert.ok(checkDeleteTestOptions("NoTestRun", [], ["ApexClass"], true).error);
		assert.deepStrictEqual(checkDeleteTestOptions("RunLocalTests", [], ["ApexClass"], true), {});
		assert.deepStrictEqual(checkDeleteTestOptions("RunAllTestsInOrg", [], ["ApexClass"], true), {});
	});

	it("non-production: NoTestRun is allowed, with a hint when Apex classes or triggers go", () => {
		assert.deepStrictEqual(checkDeleteTestOptions("NoTestRun", [], ["Layout", "CustomField"], false), {});
		for (const t of ["ApexClass", "ApexTrigger"]) {
			const r = checkDeleteTestOptions("NoTestRun", [], ["Layout", t], false);
			assert.strictEqual(r.error, undefined);
			assert.ok(r.hint);
		}
		assert.deepStrictEqual(checkDeleteTestOptions("RunLocalTests", [], ["ApexClass"], false), {});
	});

	it("RunSpecifiedTests needs a test; unknown levels are refused", () => {
		assert.ok(checkDeleteTestOptions("RunSpecifiedTests", [], ["Layout"], false).error);
		assert.ok(checkDeleteTestOptions("RunSpecifiedTests", ["  "], ["Layout"], false).error);
		assert.deepStrictEqual(checkDeleteTestOptions("RunSpecifiedTests", ["MyTest"], ["Layout"], true), {});
		assert.ok(checkDeleteTestOptions("Bogus", [], [], false).error);
	});

	it("the webview hint: only NoTestRun with Apex among the types", () => {
		assert.ok(deleteTestHint("NoTestRun", ["ApexTrigger"]));
		assert.strictEqual(deleteTestHint("NoTestRun", ["Layout"]), "");
		assert.strictEqual(deleteTestHint("RunLocalTests", ["ApexClass"]), "");
	});
});
