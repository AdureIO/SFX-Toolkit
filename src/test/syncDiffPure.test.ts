import * as assert from "assert";
import { diffTitle, planDiffPairs } from "../utils/syncDiffPure";

const side = (abs: string, digest: string) => ({ abs, digest });

describe("sync diff pairing", () => {
	it("pairs by inner path: differing files first, then one-sided, equal last", () => {
		const local = new Map([
			["a.js", side("/l/a.js", "t:1")],
			["b.html", side("/l/b.html", "t:2")],
			["only-local.css", side("/l/c.css", "t:3")],
		]);
		const org = new Map([
			["a.js", side("/o/a.js", "t:1")],
			["b.html", side("/o/b.html", "t:X")],
			["only-org.xml", side("/o/d.xml", "t:4")],
		]);
		const pairs = planDiffPairs(local, org);
		assert.deepStrictEqual(pairs.map((p) => [p.inner, p.state]), [
			["b.html", "different"],
			["only-local.css", "local-only"],
			["only-org.xml", "org-only"],
			["a.js", "equal"],
		]);
		assert.deepStrictEqual(pairs[0], { inner: "b.html", state: "different", local: "/l/b.html", org: "/o/b.html" });
		assert.strictEqual(pairs[1].org, undefined);
		assert.strictEqual(pairs[2].local, undefined);
	});

	it("a single pair, and nothing on either side", () => {
		const one = planDiffPairs(new Map([["A.cls", side("/l", "x")]]), new Map([["A.cls", side("/o", "y")]]));
		assert.strictEqual(one.length, 1);
		assert.deepStrictEqual(planDiffPairs(new Map(), new Map()), []);
	});

	it("the editor title: Name (org ↔ local), with the file for several", () => {
		assert.strictEqual(diffTitle("MyClass", undefined), "MyClass (org ↔ local)");
		assert.strictEqual(diffTitle("myCmp", "myCmp/myCmp.js"), "myCmp: myCmp/myCmp.js (org ↔ local)");
	});
});
