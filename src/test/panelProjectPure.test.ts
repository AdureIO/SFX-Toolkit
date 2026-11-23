import * as assert from "assert";
import {
	buildOptions,
	pinAfterPick,
	reconcilePin,
	resolveCurrentDir,
	selectorVisible,
} from "../utils/panelProjectPure";

const A = { dir: "/ws/a", name: "a", kind: "sfdx" as const };
const B = { dir: "/ws/b", name: "b", kind: "mdapi" as const };

describe("panelProjectPure", () => {
	it("follows the active project while not pinned", () => {
		assert.strictEqual(resolveCurrentDir([A, B], "/ws/a", undefined), "/ws/a");
		assert.strictEqual(resolveCurrentDir([A, B], "/ws/b", undefined), "/ws/b");
	});

	it("keeps the pinned project when the active one changes", () => {
		assert.strictEqual(resolveCurrentDir([A, B], "/ws/b", "/ws/a"), "/ws/a");
	});

	it("falls back to the active project when the pinned one vanished", () => {
		assert.strictEqual(resolveCurrentDir([B], "/ws/b", "/ws/a"), "/ws/b");
	});

	it("is undefined with no projects and no active one", () => {
		assert.strictEqual(resolveCurrentDir([], undefined, undefined), undefined);
	});

	it("picking the active project unpins, another one pins", () => {
		assert.strictEqual(pinAfterPick("/ws/a", "/ws/a"), undefined);
		assert.strictEqual(pinAfterPick("/ws/a", "/ws/b"), "/ws/b");
		assert.strictEqual(pinAfterPick(undefined, "/ws/b"), "/ws/b");
	});

	it("drops a pin whose project is gone", () => {
		assert.strictEqual(reconcilePin([A, B], "/ws/b"), "/ws/b");
		assert.strictEqual(reconcilePin([A], "/ws/b"), undefined);
		assert.strictEqual(reconcilePin([A], undefined), undefined);
	});

	it("is visible only with more than one project", () => {
		assert.strictEqual(selectorVisible(0), false);
		assert.strictEqual(selectorVisible(1), false);
		assert.strictEqual(selectorVisible(2), true);
	});

	it("builds options with org label and active flag", () => {
		const opts = buildOptions([A, B], "/ws/b", (d) => (d === "/ws/a" ? "devA" : ""));
		assert.deepStrictEqual(opts, [
			{ dir: "/ws/a", name: "a", kind: "sfdx", defaultOrgLabel: "devA", active: false },
			{ dir: "/ws/b", name: "b", kind: "mdapi", defaultOrgLabel: "", active: true },
		]);
	});
});
