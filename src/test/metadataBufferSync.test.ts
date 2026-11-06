import * as assert from "assert";
import { MetadataBufferSync, isMetadataBufferPath } from "../utils/metadataBufferSync";
import type { TimerApi } from "../utils/serverSettingsRestart";

class FakeTimers implements TimerApi {
	now = 0;
	private next = 1;
	private tasks = new Map<number, { at: number; fn: () => void }>();
	set(fn: () => void, ms: number): unknown {
		const id = this.next++;
		this.tasks.set(id, { at: this.now + ms, fn });
		return id;
	}
	clear(h: unknown): void {
		this.tasks.delete(h as number);
	}
	advance(ms: number): void {
		this.now += ms;
		for (const [id, t] of [...this.tasks]) {
			if (t.at <= this.now) {
				this.tasks.delete(id);
				t.fn();
			}
		}
	}
}

function setup() {
	const timers = new FakeTimers();
	const sent: [string, string | null][] = [];
	const sync = new MetadataBufferSync((u, t) => void sent.push([u, t]), 300, timers);
	return { timers, sent, sync };
}

describe("isMetadataBufferPath", () => {
	it("matches the metadata globs only", () => {
		for (const p of [
			"/w/force-app/main/default/lwc/a/a.js",
			"/w/force-app/main/default/lwc/a/a.html",
			"/w/force-app/main/default/aura/c/cController.js",
			"/w/force-app/main/default/aura/c/c.cmp",
			"/w/force-app/main/default/aura/c/c.app",
			"/w/force-app/main/default/aura/c/c.evt",
			"/w/force-app/main/default/pages/P.page",
			"/w/force-app/main/default/pages/P.component",
			"/w/force-app/main/default/flows/F.flow-meta.xml",
		]) assert.ok(isMetadataBufferPath(p), p);
		for (const p of [
			"/w/classes/A.cls",
			"/w/lib/util.js",
			"/w/force-app/main/default/lwc/a/a.css",
			"/w/node_modules/x/lwc/a/a.js",
			"/w/.sfdx/lwc/a/a.js",
		]) assert.ok(!isMetadataBufferPath(p), p);
	});
});

describe("MetadataBufferSync", () => {
	it("debounces per URI and sends the latest text once", () => {
		const { timers, sent, sync } = setup();
		let text = "a";
		sync.changed("file:///a.js", () => text);
		timers.advance(200);
		text = "ab";
		sync.changed("file:///a.js", () => text);
		timers.advance(299);
		assert.deepStrictEqual(sent, []);
		timers.advance(1);
		assert.deepStrictEqual(sent, [["file:///a.js", "ab"]]);
		timers.advance(5000);
		assert.strictEqual(sent.length, 1);
	});

	it("keeps separate timers per URI", () => {
		const { timers, sent, sync } = setup();
		sync.changed("file:///a.js", () => "a");
		timers.advance(200);
		sync.changed("file:///b.js", () => "b");
		timers.advance(100);
		assert.deepStrictEqual(sent, [["file:///a.js", "a"]]);
		timers.advance(200);
		assert.deepStrictEqual(sent, [["file:///a.js", "a"], ["file:///b.js", "b"]]);
	});

	it("save / close sends null once, and only when something was sent", () => {
		const { timers, sent, sync } = setup();
		sync.released("file:///a.js");
		assert.deepStrictEqual(sent, []);
		sync.changed("file:///a.js", () => "x");
		timers.advance(300);
		sync.released("file:///a.js");
		sync.released("file:///a.js");
		assert.deepStrictEqual(sent, [["file:///a.js", "x"], ["file:///a.js", null]]);
	});

	it("a save before the debounce fires cancels the pending send", () => {
		const { timers, sent, sync } = setup();
		sync.changed("file:///a.js", () => "x");
		sync.released("file:///a.js");
		timers.advance(1000);
		assert.deepStrictEqual(sent, []);
	});

	it("resendAll re-sends every dirty document after a restart", () => {
		const { timers, sent, sync } = setup();
		sync.changed("file:///a.js", () => "old");
		timers.advance(300);
		sent.length = 0;
		sync.resendAll([{ uri: "file:///a.js", text: () => "new" }, { uri: "file:///b.cmp", text: () => "<c/>" }]);
		assert.deepStrictEqual(sent, [["file:///a.js", "new"], ["file:///b.cmp", "<c/>"]]);
		sync.released("file:///b.cmp");
		assert.deepStrictEqual(sent[2], ["file:///b.cmp", null]);
	});
});
