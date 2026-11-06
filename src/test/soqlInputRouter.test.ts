import * as assert from "assert";
import { SoqlInputRouter, SoqlBufferBridgeLike, bridgeRequestFrom } from "../providers/soqlInputRouter";
import { SOQL_INPUT_MSG } from "../webview/monacoSoqlInput";

/** Fake bridge recording calls; completion/hover resolve when the test says so. */
function fakeBridge() {
	const log: string[] = [];
	const waiting: (() => void)[] = [];
	const gate = () => new Promise<void>((r) => waiting.push(r));
	const b: SoqlBufferBridgeLike & { holdCompletion: boolean } = {
		holdCompletion: false,
		async completions(req) {
			log.push(`completion:${req.text}@${req.line}:${req.character}#${req.requestId}`);
			if (b.holdCompletion) await gate();
			return req.text === "drop" ? null : { items: [{ label: "Name", kind: "Field" } as any], incomplete: true, listId: 3 };
		},
		async hover(req) { log.push(`hover:${req.text}`); return { contents: ["**Name**"] } as any; },
		async resolveCompletion(listId, resolveId, requestId) { log.push(`resolve:${listId}/${resolveId}#${requestId}`); return { label: "Name", kind: "Field", detail: "string" } as any; },
		cancel(id) { log.push(`cancel:${id}`); },
		setOrg(org) { log.push(`org:${org}`); return true; },
		dispose() { log.push("dispose"); },
	};
	return { b, log, release: () => waiting.splice(0).forEach((r) => r()) };
}

function setup(markers?: (org: string | null, text: string) => Promise<any[]>) {
	const f = fakeBridge();
	const posted: any[] = [];
	const router = new SoqlInputRouter(f.b, (m) => posted.push(m), markers);
	return { ...f, posted, router };
}

describe("SoqlInputRouter (host side of the Monaco SOQL inputs)", () => {
	it("starts the buffer at the default org (registers it ephemeral)", () => {
		const { log } = setup();
		assert.deepStrictEqual(log, ["org:null"]);
	});

	it("ignores foreign messages", async () => {
		const { router, posted } = setup();
		assert.strictEqual(await router.handle({ command: "export", query: "x" }), false);
		assert.strictEqual(await router.handle(undefined), false);
		assert.strictEqual(await router.handle("soqlLsCompletions"), false);
		assert.deepStrictEqual(posted, []);
	});

	it("pins the request's org, then answers completion with the full list", async () => {
		const { router, posted, log } = setup();
		assert.strictEqual(await router.handle({ command: SOQL_INPUT_MSG.completion, requestId: 7, text: "SELECT Na", line: 0, character: 9, triggerKind: 1, org: "src@x.com" }), true);
		assert.deepStrictEqual(log.slice(1), ["org:src@x.com", "completion:SELECT Na@0:9#7"]);
		assert.deepStrictEqual(posted, [{ command: SOQL_INPUT_MSG.completion, requestId: 7, items: [{ label: "Name", kind: "Field" }], incomplete: true, listId: 3 }]);
	});

	it("'' org means the default org; a missing org leaves the override alone", async () => {
		const { router, log } = setup();
		await router.handle({ command: SOQL_INPUT_MSG.hover, requestId: 1, text: "a", line: 0, character: 0, org: "" });
		await router.handle({ command: SOQL_INPUT_MSG.hover, requestId: 2, text: "b", line: 0, character: 0 });
		assert.deepStrictEqual(log.slice(1), ["org:null", "hover:a", "hover:b"]);
	});

	it("reports a superseded completion as dropped", async () => {
		const { router, posted } = setup();
		await router.handle({ command: SOQL_INPUT_MSG.completion, requestId: 4, text: "drop" });
		assert.deepStrictEqual(posted, [{ command: SOQL_INPUT_MSG.completion, requestId: 4, dropped: true }]);
	});

	it("routes resolve, cancel and explicit org changes", async () => {
		const { router, posted, log } = setup();
		await router.handle({ command: SOQL_INPUT_MSG.resolve, requestId: 9, listId: 3, resolveId: 0, org: "ignored" });
		await router.handle({ command: SOQL_INPUT_MSG.cancel, requestId: 9 });
		await router.handle({ command: SOQL_INPUT_MSG.setOrg, org: "tgt@x.com" });
		assert.deepStrictEqual(log.slice(1), ["resolve:3/0#9", "cancel:9", "org:tgt@x.com"]);
		assert.deepStrictEqual(posted, [{ command: SOQL_INPUT_MSG.resolve, requestId: 9, item: { label: "Name", kind: "Field", detail: "string" } }]);
	});

	it("validates against the given org and echoes input + text", async () => {
		const seen: any[] = [];
		const { router, posted } = setup(async (org, text) => { seen.push([org, text]); return [{ line: 0, startCol: 7, endCol: 10, message: "No such column" }]; });
		await router.handle({ command: SOQL_INPUT_MSG.validate, input: "exp-query-editor", org: "a@x", text: "SELECT Foo FROM Account" });
		assert.deepStrictEqual(seen, [["a@x", "SELECT Foo FROM Account"]]);
		assert.deepStrictEqual(posted, [{ command: SOQL_INPUT_MSG.markers, input: "exp-query-editor", text: "SELECT Foo FROM Account", markers: [{ line: 0, startCol: 7, endCol: 10, message: "No such column" }] }]);
	});

	it("a failing request still answers (dropped) so the webview doesn't hang", async () => {
		const { b, router, posted } = setup();
		b.hover = async () => { throw new Error("boom"); };
		await router.handle({ command: SOQL_INPUT_MSG.hover, requestId: 5, text: "x" });
		assert.deepStrictEqual(posted, [{ command: SOQL_INPUT_MSG.hover, requestId: 5, dropped: true }]);
	});

	it("dispose cancels in-flight work, disposes again once it finishes, and goes quiet", async () => {
		const { b, router, posted, log, release } = setup();
		b.holdCompletion = true;
		const p = router.handle({ command: SOQL_INPUT_MSG.completion, requestId: 11, text: "SELECT" });
		await Promise.resolve();
		router.dispose();
		router.dispose(); // idempotent
		assert.deepStrictEqual(log.slice(1), ["completion:SELECT@0:0#11", "cancel:11", "dispose"]);
		release();
		await p;
		// The late request may have re-synced the virtual doc: cleaned up again, nothing posted.
		assert.deepStrictEqual(log.slice(4), ["dispose"]);
		assert.deepStrictEqual(posted, []);
		// After dispose nothing reaches the bridge (no org override re-created).
		await router.handle({ command: SOQL_INPUT_MSG.setOrg, org: "x" });
		await router.handle({ command: SOQL_INPUT_MSG.completion, requestId: 12, text: "a", org: "x" });
		assert.strictEqual(log.length, 5);
		assert.strictEqual(router.disposed, true);
	});

	it("bridgeRequestFrom normalises payloads", () => {
		assert.deepStrictEqual(bridgeRequestFrom({ requestId: "1", text: 5, line: "2" }), { requestId: undefined, text: "", line: 0, character: 0, triggerKind: undefined, triggerCharacter: undefined });
		assert.deepStrictEqual(bridgeRequestFrom({ requestId: 1, text: "a", line: 2, character: 3, triggerKind: 2, triggerCharacter: "." }), { requestId: 1, text: "a", line: 2, character: 3, triggerKind: 2, triggerCharacter: "." });
	});
});
