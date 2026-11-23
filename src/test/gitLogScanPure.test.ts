import * as assert from "assert";
import { GitLogScan, LineSplitter, normalizeLogPath } from "../utils/gitLogScanPure";

const commit = (secs: number, ...paths: string[]) => ["\x00" + secs, "", ...paths];
const feed = (scan: GitLogScan, lines: string[]) => {
	for (const l of lines) if (scan.feedLine(l)) break;
};

describe("git log scan accumulator", () => {
	it("stops as soon as every needed path is found and keeps the newest time", () => {
		const scan = new GitLogScan(["a.cls", "b.cls"]);
		assert.strictEqual(scan.feedLine("\x00300"), false);
		scan.feedLine("");
		assert.strictEqual(scan.feedLine("a.cls"), false);
		scan.feedLine("\x00200");
		scan.feedLine("");
		scan.feedLine("a.cls");
		assert.strictEqual(scan.feedLine("b.cls"), true);
		assert.ok(scan.done);
		const r = scan.result();
		assert.strictEqual(r.times.get("a.cls"), 300_000);
		assert.strictEqual(r.times.get("b.cls"), 200_000);
		assert.strictEqual(r.boundary, 200_000);
		assert.strictEqual(r.commits, 2);
	});
	it("ignores paths that are not needed", () => {
		const scan = new GitLogScan(["a.cls"]);
		feed(scan, [...commit(300, "x.cls", "a.cls")]);
		assert.deepStrictEqual([...scan.result().times], [["a.cls", 300_000]]);
	});
	it("reports the oldest commit as boundary when the log ends before a path is found", () => {
		const scan = new GitLogScan(["a.cls", "gone.cls"]);
		feed(scan, [...commit(300, "a.cls"), ...commit(100, "z.cls")]);
		assert.ok(!scan.done);
		const r = scan.result();
		assert.strictEqual(r.boundary, 100_000);
		assert.ok(!r.times.has("gone.cls"));
	});
	it("stops at the commit cap and sets the boundary to the oldest commit read", () => {
		const scan = new GitLogScan(["never.cls"], 3);
		for (let i = 0; i < 10; i++) {
			if (scan.feedLine("\x00" + (1000 - i * 10))) break;
			scan.feedLine("");
			scan.feedLine("other" + i + ".cls");
		}
		assert.ok(scan.done);
		const r = scan.result();
		assert.strictEqual(r.commits, 3);
		assert.strictEqual(r.capped, true);
		assert.strictEqual(r.boundary, 980_000);
	});
	it("handles paths with spaces and Windows separators", () => {
		const scan = new GitLogScan(["force-app/main/My Class.cls", "force-app/main/sub/b.cls"]);
		feed(scan, commit(500, "force-app\\main\\My Class.cls\r", "force-app/main/sub/b.cls\r"));
		assert.strictEqual(scan.result().times.get("force-app/main/My Class.cls"), 500_000);
		assert.ok(scan.done);
		assert.strictEqual(normalizeLogPath("a\\b c\\d.cls\r"), "a/b c/d.cls");
	});
	it("handles merge commits with no names", () => {
		const scan = new GitLogScan(["a.cls"]);
		feed(scan, [...commit(400), ...commit(300, "a.cls")]);
		const r = scan.result();
		assert.strictEqual(r.times.get("a.cls"), 300_000);
		assert.strictEqual(r.commits, 2);
		assert.ok(scan.done);
	});
	it("records every path when there is no needed set (range scan) and is done at once for an empty set", () => {
		const scan = new GitLogScan(null);
		feed(scan, [...commit(300, "a.cls"), ...commit(200, "a.cls", "b.cls")]);
		assert.ok(!scan.done);
		assert.strictEqual(scan.result().times.get("a.cls"), 300_000);
		assert.strictEqual(scan.result().times.get("b.cls"), 200_000);
		assert.ok(new GitLogScan([]).done);
		assert.strictEqual(new GitLogScan(["a"]).result().boundary, null);
	});
	it("splits streamed chunks into lines across chunk boundaries", () => {
		const s = new LineSplitter();
		assert.deepStrictEqual(s.push("ab\ncd"), ["ab"]);
		assert.deepStrictEqual(s.push("e\nf"), ["cde"]);
		assert.deepStrictEqual(s.flush(), ["f"]);
	});
});
