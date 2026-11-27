import * as assert from "assert";
import { virtualWindow } from "../utils/virtualWindowPure";

describe("virtualWindow", () => {
	it("returns an empty range for no lines", () => {
		assert.deepStrictEqual(virtualWindow(0, 400, 16, 0, 100), { first: 0, last: 0 });
	});
	it("clamps overscan at the top", () => {
		assert.deepStrictEqual(virtualWindow(0, 160, 16, 1000, 10), { first: 0, last: 20 });
	});
	it("applies overscan in the middle", () => {
		assert.deepStrictEqual(virtualWindow(1600, 160, 16, 1000, 10), { first: 90, last: 120 });
	});
	it("clamps at the bottom", () => {
		assert.deepStrictEqual(virtualWindow(15900, 160, 16, 1000, 10), { first: 983, last: 1000 });
	});
	it("handles a short list and a scrollTop past the end", () => {
		assert.deepStrictEqual(virtualWindow(0, 800, 16, 5, 100), { first: 0, last: 5 });
		assert.deepStrictEqual(virtualWindow(99999, 160, 16, 50, 5), { first: 50, last: 50 });
	});
	it("guards against a zero line height", () => {
		assert.deepStrictEqual(virtualWindow(0, 400, 0, 100, 10), { first: 0, last: 0 });
	});
});
