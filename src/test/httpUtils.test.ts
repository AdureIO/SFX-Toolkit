import * as assert from "assert";
import { EventEmitter } from "events";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require("https");
import { httpsGetEx, httpsDelete, httpsPost, httpsPatch, isRetryableHttpError, isTransientSocketError, wrapNetworkError, clampTimeoutMs, disableTcpKeepAlive } from "../utils/httpUtils";
import { deleteInBatches, collectionResults, CANCELLED_DELETE_MSG } from "../utils/soqlEditPure";

type Step = { error?: { code?: string; message: string }; status?: number; body?: string };

const origRequest = https.request;
let calls: Array<{ method: string; agent: unknown }>;

/** Replace https.request with a scripted sequence of outcomes (last one repeats). */
function script(steps: Step[]): void {
	calls = [];
	https.request = (opts: any, cb: (res: any) => void) => {
		const step = steps[Math.min(calls.length, steps.length - 1)];
		calls.push({ method: opts.method, agent: opts.agent });
		const req: any = new EventEmitter();
		req.write = () => undefined;
		req.destroy = () => undefined;
		req.end = () => {
			setImmediate(() => {
				if (step.error) {
					req.emit("error", Object.assign(new Error(step.error.message), step.error.code ? { code: step.error.code } : {}));
					return;
				}
				const res: any = new EventEmitter();
				res.statusCode = step.status ?? 200;
				res.headers = {};
				res.resume = () => undefined;
				res.destroy = () => undefined;
				cb(res);
				res.emit("data", Buffer.from(step.body ?? ""));
				res.emit("end");
			});
		};
		return req;
	};
}

const URL_ = "https://org.my.salesforce.com/services/data/v60.0/x";

describe("httpUtils — transient socket errors", () => {
	afterEach(() => {
		https.request = origRequest;
	});

	it("GET: read ETIMEDOUT is retried once on a fresh (non-pooled) socket and succeeds", async () => {
		script([{ error: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }, { body: "ok" }]);
		const r = await httpsGetEx(URL_, "tok", { maxRetries: 0 });
		assert.strictEqual(r.body, "ok");
		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[0].agent, undefined, "first attempt uses the default (pooled) agent");
		assert.strictEqual(calls[1].agent, false, "retry uses a fresh connection");
	});

	it("DELETE: read ETIMEDOUT is retried once; ENTITY_IS_DELETED on the retry counts as deleted", async () => {
		const ids = ["001000000000001AAA", "001000000000002AAA"];
		const retryBody = JSON.stringify([
			{ id: ids[0], success: false, errors: [{ statusCode: "ENTITY_IS_DELETED", message: "entity is deleted", fields: [] }] },
			{ id: ids[1], success: true, errors: [] },
		]);
		script([{ error: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }, { body: retryBody }]);
		const body = await httpsDelete(URL_, "tok");
		assert.strictEqual(calls.length, 2);
		assert.strictEqual(calls[1].agent, false);
		assert.deepStrictEqual(collectionResults(ids, body, true), [{ id: ids[0] }, { id: ids[1] }]);
		assert.ok(collectionResults(ids, body, false)[0].error, "outside a delete the same code is an error");
	});

	it("DELETE: a second socket error surfaces wrapped, with the code kept (no endless retry)", async () => {
		script([{ error: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }]);
		await assert.rejects(httpsDelete(URL_, "tok"), (e: any) => {
			assert.strictEqual(e.code, "ETIMEDOUT");
			assert.ok(isRetryableHttpError(e) && isTransientSocketError(e));
			return true;
		});
		assert.strictEqual(calls.length, 2);
	});

	it("POST/PATCH: socket errors are not retried, the message is wrapped and the code preserved", async () => {
		for (const fn of [
			() => httpsPost(URL_, "<x/>", {}),
			() => httpsPatch(URL_, "{}", {}),
		]) {
			script([{ error: { code: "ECONNRESET", message: "read ECONNRESET" } }, { body: "should not be reached" }]);
			await assert.rejects(fn(), (e: any) => {
				assert.strictEqual(e.code, "ECONNRESET");
				assert.match(e.message, /^Network error talking to org\.my\.salesforce\.com \(read ECONNRESET\)/);
				return true;
			});
			assert.strictEqual(calls.length, 1, "non-idempotent requests are sent once");
		}
	});

	it("HTTP status errors are not treated as socket errors and are not retried", async () => {
		script([{ status: 400, body: "bad" }, { body: "ok" }]);
		await assert.rejects(httpsDelete(URL_, "tok"), /HTTP 400/);
		assert.strictEqual(calls.length, 1);
	});
});

describe("wrapNetworkError", () => {
	it("names the host and keeps the original text and code", () => {
		const w = wrapNetworkError(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }), "acme.my.salesforce.com");
		assert.ok(w.message.includes("acme.my.salesforce.com"));
		assert.ok(w.message.includes("read ETIMEDOUT"));
		assert.ok(w.message.includes("the connection stalled; the org may be busy. Try again."));
		assert.strictEqual(w.code, "ETIMEDOUT");
	});
	it("classifies 'socket hang up' as transient", () => {
		assert.ok(isTransientSocketError(new Error("socket hang up")));
		assert.ok(!isTransientSocketError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
	});
});

describe("deleteInBatches", () => {
	const mk = (n: number) => Array.from({ length: n }, (_, i) => "001" + String(i).padStart(12, "0"));
	const okBody = (b: string[]) => JSON.stringify(b.map((id) => ({ id, success: true, errors: [] })));

	it("reports progress per batch and returns all ids as deleted", async () => {
		const seen: Array<[number, number]> = [];
		const res = await deleteInBatches(mk(450), async (b) => okBody(b), { onProgress: (d, t) => seen.push([d, t]) });
		assert.strictEqual(res.length, 450);
		assert.ok(res.every((r) => !r.error));
		assert.deepStrictEqual(seen, [[0, 450], [200, 450], [400, 450], [450, 450]]);
	});

	it("cancellation stops after the current batch; remaining ids come back as 'Cancelled — not deleted.'", async () => {
		let cancelled = false;
		let batches = 0;
		const res = await deleteInBatches(
			mk(450),
			async (b) => {
				batches++;
				cancelled = true; // user cancels while the first batch is in flight
				return okBody(b);
			},
			{ isCancelled: () => cancelled }
		);
		assert.strictEqual(batches, 1);
		assert.strictEqual(res.filter((r) => !r.error).length, 200);
		const rest = res.filter((r) => r.error === CANCELLED_DELETE_MSG);
		assert.strictEqual(rest.length, 250);
		assert.strictEqual(CANCELLED_DELETE_MSG, "Cancelled — not deleted.");
	});

	it("a failed batch does not stop the following batches", async () => {
		let n = 0;
		const res = await deleteInBatches(mk(400), async (b) => {
			if (n++ === 0) throw Object.assign(new Error("Network error talking to x (read ETIMEDOUT) — stalled"), { code: "ETIMEDOUT" });
			return okBody(b);
		});
		assert.strictEqual(res.filter((r) => r.error).length, 200);
		assert.strictEqual(res.filter((r) => !r.error).length, 200);
	});
});

describe("non-idempotent wording and timeouts", () => {
	afterEach(() => {
		https.request = origRequest;
	});

	it("POST/PATCH socket errors say the request may still have completed, never 'Try again'", async () => {
		for (const fn of [() => httpsPost(URL_, "<x/>", {}), () => httpsPatch(URL_, "{}", {})]) {
			script([{ error: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }]);
			await assert.rejects(fn(), (e: any) => {
				assert.match(e.message, /may still have completed on the server; check the result before re-running\./);
				assert.ok(!/Try again/.test(e.message));
				assert.strictEqual(e.code, "ETIMEDOUT");
				assert.strictEqual(e.networkError, true);
				return true;
			});
		}
	});

	it("GET/DELETE keep the 'Try again' wording", async () => {
		script([{ error: { code: "ETIMEDOUT", message: "read ETIMEDOUT" } }]);
		await assert.rejects(httpsDelete(URL_, "tok"), /Try again\./);
		assert.ok(/Try again\./.test(wrapNetworkError(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }), "h").message));
	});

	it("clampTimeoutMs: default 600000 when unset, minimum 30000 enforced", () => {
		assert.strictEqual(clampTimeoutMs(undefined, 600000, 30000), 600000);
		assert.strictEqual(clampTimeoutMs(1000, 600000, 30000), 30000);
		assert.strictEqual(clampTimeoutMs(120000, 600000, 30000), 120000);
	});
});

describe("httpUtils TCP keepalive", () => {
	it("disableTcpKeepAlive turns keepalive off and tolerates odd sockets", () => {
		const seen: any[][] = [];
		disableTcpKeepAlive({ setKeepAlive: (...a: any[]) => { seen.push(a); return undefined; } });
		assert.deepStrictEqual(seen, [[false]]);
		assert.doesNotThrow(() => disableTcpKeepAlive(undefined));
		assert.doesNotThrow(() => disableTcpKeepAlive({}));
		assert.doesNotThrow(() => disableTcpKeepAlive({ setKeepAlive: () => { throw new Error("destroyed"); } }));
	});

	it("every request registers the helper on 'socket' (reused sockets re-armed by the Agent are disabled again)", async () => {
		const reqs: any[] = [];
		https.request = (_opts: any, cb: (res: any) => void) => {
			const req: any = new EventEmitter();
			req.write = () => undefined;
			req.destroy = () => undefined;
			req.end = () => {
				const res: any = new EventEmitter();
				res.statusCode = 200;
				res.headers = {};
				res.resume = () => undefined;
				const keepAliveCalls: any[][] = [];
				const sock = { setKeepAlive: (...a: any[]) => { keepAliveCalls.push(a); } };
				req.keepAliveCalls = keepAliveCalls;
				req.emit("socket", sock);
				cb(res);
				res.emit("data", Buffer.from("ok"));
				res.emit("end");
			};
			reqs.push(req);
			return req;
		};
		try {
			await httpsPost("https://example.my.salesforce.com/x", "<a/>", {});
			await httpsPatch("https://example.my.salesforce.com/x", "{}", {});
			await httpsDelete("https://example.my.salesforce.com/x", "tok");
			await httpsGetEx("https://example.my.salesforce.com/x", "tok");
			assert.strictEqual(reqs.length, 4);
			for (const r of reqs) assert.deepStrictEqual(r.keepAliveCalls, [[false]]);
		} finally {
			https.request = origRequest;
		}
	});
});
