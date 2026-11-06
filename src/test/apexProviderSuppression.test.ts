import * as assert from "assert";
import {
	MiddlewareSuppressor,
	keysToSuppress,
	apexFeaturesEnabled,
	COMPLETION_KEYS,
	NAVIGATION_KEYS,
	SuppressionInputs,
} from "../utils/apexProviderSuppression";

const base: SuppressionInputs = {
	jorjeClientAvailable: true,
	ownServerRunning: true,
	preferOwnProviders: true,
	apexFeatures: true,
	apexCompletion: true,
};

describe("apexFeaturesEnabled", () => {
	it("treats auto like on and only off disables", () => {
		assert.strictEqual(apexFeaturesEnabled("on"), true);
		assert.strictEqual(apexFeaturesEnabled("auto"), true);
		assert.strictEqual(apexFeaturesEnabled("off"), false);
		assert.strictEqual(apexFeaturesEnabled(undefined), false);
	});
});

describe("keysToSuppress", () => {
	it("covers every combination of the five inputs", () => {
		for (let m = 0; m < 32; m++) {
			const i: SuppressionInputs = {
				jorjeClientAvailable: !!(m & 1),
				ownServerRunning: !!(m & 2),
				preferOwnProviders: !!(m & 4),
				apexFeatures: !!(m & 8),
				apexCompletion: !!(m & 16),
			};
			const got = keysToSuppress(i);
			const gate = i.jorjeClientAvailable && i.ownServerRunning && i.preferOwnProviders;
			const expected = gate
				? [...(i.apexCompletion ? COMPLETION_KEYS : []), ...(i.apexFeatures ? NAVIGATION_KEYS : [])]
				: [];
			assert.deepStrictEqual(got, expected, JSON.stringify(i));
		}
	});
	it("never includes rename, codeLens, codeAction or diagnostics", () => {
		const all = keysToSuppress(base) as string[];
		for (const k of ["provideRenameEdits", "prepareRename", "provideCodeLenses", "provideCodeActions", "handleDiagnostics", "provideDocumentSymbols"]) {
			assert.ok(!all.includes(k), k);
		}
	});
});

describe("MiddlewareSuppressor", () => {
	const orig = { hover: () => "jorje-hover", lens: () => "lens" };

	it("applies stubs that return null and leaves other keys alone", () => {
		const mw: Record<string, any> = { provideHover: orig.hover, provideCodeLenses: orig.lens, extra: 1 };
		const s = new MiddlewareSuppressor();
		assert.strictEqual(s.apply(mw, ["provideHover", "provideDefinition"]), true);
		assert.strictEqual(mw.provideHover(), null);
		assert.strictEqual(mw.provideDefinition(), null);
		assert.strictEqual(mw.provideCodeLenses, orig.lens);
		assert.strictEqual(mw.extra, 1);
		assert.deepStrictEqual(Object.keys(mw).sort(), ["extra", "provideCodeLenses", "provideDefinition", "provideHover"]);
	});

	it("resolveCompletionItem returns the item unchanged", () => {
		const mw: Record<string, any> = {};
		new MiddlewareSuppressor().apply(mw, ["resolveCompletionItem"]);
		const item = { label: "x" };
		assert.strictEqual(mw.resolveCompletionItem(item), item);
	});

	it("restores originals exactly, deleting keys that did not exist", () => {
		const mw: Record<string, any> = { provideHover: orig.hover, provideCodeLenses: orig.lens };
		const before = { ...mw };
		const s = new MiddlewareSuppressor();
		s.apply(mw, ["provideHover", "provideReferences"]);
		assert.strictEqual(s.restore(), true);
		assert.deepStrictEqual(mw, before);
		assert.strictEqual(mw.provideHover, orig.hover);
		assert.ok(!("provideReferences" in mw));
		assert.strictEqual(s.restore(), false);
	});

	it("is idempotent: applying twice keeps the first originals", () => {
		const mw: Record<string, any> = { provideHover: orig.hover };
		const s = new MiddlewareSuppressor();
		assert.strictEqual(s.apply(mw, ["provideHover"]), true);
		const stub = mw.provideHover;
		assert.strictEqual(s.apply(mw, ["provideHover"]), false);
		assert.strictEqual(mw.provideHover, stub);
		s.restore();
		assert.strictEqual(mw.provideHover, orig.hover);
	});

	it("restores keys that are no longer wanted and suppresses new ones", () => {
		const mw: Record<string, any> = { provideHover: orig.hover };
		const s = new MiddlewareSuppressor();
		s.apply(mw, ["provideHover", "provideDefinition"]);
		s.apply(mw, ["provideDefinition", "provideReferences"]);
		assert.strictEqual(mw.provideHover, orig.hover);
		assert.deepStrictEqual(s.active().sort(), ["provideDefinition", "provideReferences"]);
		s.apply(mw, []);
		assert.deepStrictEqual(Object.keys(mw), ["provideHover"]);
	});

	it("rebinds to a new middleware object (Jorje restart) without touching the old one", () => {
		const a: Record<string, any> = { provideHover: orig.hover };
		const b: Record<string, any> = { provideHover: orig.hover };
		const s = new MiddlewareSuppressor();
		s.apply(a, ["provideHover"]);
		assert.strictEqual(s.isBoundTo(a), true);
		s.apply(b, ["provideHover"]);
		assert.strictEqual(s.isBoundTo(b), true);
		assert.strictEqual(b.provideHover(), null);
		s.restore();
		assert.strictEqual(b.provideHover, orig.hover);
	});

	it("does not clobber a function installed over our stub when restoring", () => {
		const mw: Record<string, any> = { provideHover: orig.hover };
		const s = new MiddlewareSuppressor();
		s.apply(mw, ["provideHover"]);
		const theirs = () => "theirs";
		mw.provideHover = theirs;
		s.restore();
		assert.strictEqual(mw.provideHover, theirs);
	});

	it("adopts a replaced function as the new original on re-apply", () => {
		const mw: Record<string, any> = { provideHover: orig.hover };
		const s = new MiddlewareSuppressor();
		s.apply(mw, ["provideHover"]);
		const theirs = () => "theirs";
		mw.provideHover = theirs;
		assert.strictEqual(s.apply(mw, ["provideHover"]), true);
		assert.strictEqual(mw.provideHover(), null);
		s.restore();
		assert.strictEqual(mw.provideHover, theirs);
	});
});
