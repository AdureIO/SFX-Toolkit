import * as assert from "assert";
import { ServerSettingsRestarter, TimerApi, affectsServerRestart, serverWanted, Throttle, ServerSettingsSnapshot } from "../utils/serverSettingsRestart";

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

const evt = (...keys: string[]) => ({
	affectsConfiguration: (s: string) => keys.some((k) => s === k || k.startsWith(s + ".")),
});

function setup(initial: Partial<ServerSettingsSnapshot> = {}) {
	const timers = new FakeTimers();
	const calls: string[] = [];
	const cfg: ServerSettingsSnapshot = { mode: "on", soqlCompletion: true, apexCompletion: true, ...initial };
	const r = new ServerSettingsRestarter({
		debounceMs: 500,
		snapshot: () => cfg,
		restart: async () => void calls.push("restart"),
		stop: async () => void calls.push("stop"),
		timers,
	});
	return { r, timers, calls, cfg };
}

describe("ServerSettingsRestarter", () => {
	it("a relevant key restarts exactly once after the debounce", () => {
		const { r, timers, calls } = setup();
		r.onConfigChange(evt("adure-sfx-toolkit.apex.semanticHighlighting"));
		timers.advance(499);
		assert.deepStrictEqual(calls, []);
		timers.advance(1);
		assert.deepStrictEqual(calls, ["restart"]);
		timers.advance(5000);
		assert.deepStrictEqual(calls, ["restart"]);
	});

	it("every key read at start is relevant", () => {
		for (const k of ["apex.languageServer", "apex.enableCompletion", "apex.validateSemantics", "apex.semanticHighlighting", "apex.languageServerMaxMemoryMB", "apex.languageServerParseWorkers", "soql.enableCompletion"]) {
			assert.ok(affectsServerRestart(evt(`adure-sfx-toolkit.${k}`)), k);
		}
	});

	it("an irrelevant key does nothing", () => {
		const { r, timers, calls } = setup();
		r.onConfigChange(evt("adure-sfx-toolkit.cache.ttl"));
		r.onConfigChange(evt("editor.fontSize"));
		timers.advance(10000);
		assert.deepStrictEqual(calls, []);
	});

	it("two quick changes trigger one restart", () => {
		const { r, timers, calls } = setup();
		r.onConfigChange(evt("adure-sfx-toolkit.apex.enableCompletion"));
		timers.advance(300);
		r.onConfigChange(evt("adure-sfx-toolkit.apex.languageServerMaxMemoryMB"));
		timers.advance(300);
		assert.deepStrictEqual(calls, []);
		timers.advance(200);
		assert.deepStrictEqual(calls, ["restart"]);
	});

	it('"off" stops instead of restarting', () => {
		const { r, timers, calls, cfg } = setup({ soqlCompletion: false, apexCompletion: false });
		cfg.mode = "off";
		r.onConfigChange(evt("adure-sfx-toolkit.apex.languageServer"));
		timers.advance(500);
		assert.deepStrictEqual(calls, ["stop"]);
	});

	it('"off" keeps the process while completion still needs it', () => {
		assert.strictEqual(serverWanted({ mode: "off", soqlCompletion: true, apexCompletion: false }), true);
		assert.strictEqual(serverWanted({ mode: "off", soqlCompletion: false, apexCompletion: false }), false);
		assert.strictEqual(serverWanted({ mode: "auto", soqlCompletion: false, apexCompletion: false }), true);
	});

	it("dispose cancels a pending restart", () => {
		const { r, timers, calls } = setup();
		r.onConfigChange(evt("adure-sfx-toolkit.apex.languageServer"));
		r.dispose();
		timers.advance(1000);
		assert.deepStrictEqual(calls, []);
	});
});

describe("Throttle", () => {
	it("allows one notice per gap", () => {
		let t = 1000;
		const th = new Throttle(10000, () => t);
		assert.ok(th.allow());
		t += 5000;
		assert.ok(!th.allow());
		t += 5000;
		assert.ok(th.allow());
	});
});
