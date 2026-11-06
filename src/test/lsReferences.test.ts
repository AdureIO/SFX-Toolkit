/**
 * Ground-truth tests for Find References / rename / metadata navigation (language server).
 *
 * The workspace comes from helpers/refWorkspace.ts: every expected reference of every
 * symbol is marked in the fixture (`«SYM:category|text»`), so each query asserts the
 * EXACT reference set — recall 100%, no false positives (comments, strings, same-named
 * members of other types, other overloads, shadowing locals) — across unopened files,
 * an unsaved buffer, triggers, test classes, namespaced / case-different references,
 * SOQL binds, and LWC / Aura / Visualforce / Flow consumers. Also: watched-file updates,
 * the host requests behind LWC/Aura → Apex navigation, rename of metadata references,
 * and latency budgets on a 2000-class workspace.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import { buildRefFixture, writeRefFixture, scoreRefs, RefFixture, ExpLoc } from "./helpers/refWorkspace";
import {
	auraActionAt,
	auraControllerRef,
	blankJs,
	flowApexRefs,
	jsIdentifierUses,
	lwcApexImportAt,
	lwcApexImports,
	typeForNameRefs,
	vfControllerRefs,
	vfExpressionRefs,
	vfNamesForMember,
} from "../utils/sfMetadataRefs";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

interface Server {
	conn: any;
	child: cp.ChildProcess;
	root: string;
	fx: RefFixture;
	warnings: string[];
	opened: Set<string>;
}

async function startServer(fx: RefFixture): Promise<Server> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-refs-")));
	writeRefFixture(root, fx);
	const serverPath = path.join(__dirname, "..", "server.js");
	assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
	const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
	const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
	const warnings: string[] = [];
	conn.onRequest("sfx/objectList", () => ["Account", "Contact"]);
	conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) =>
		sobject === "Account" ? { name: "Account", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }], childRelationships: [] } : null,
	);
	conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => names.map(() => null));
	conn.onRequest("sfx/projectInfo", () => ({ namespace: "myns" }));
	conn.onRequest("sfx/objectInfo", () => ({ description: null }));
	conn.onNotification("textDocument/publishDiagnostics", () => undefined);
	conn.onNotification("window/showMessage", (p: { message: string }) => void warnings.push(p.message));
	conn.listen();
	await conn.sendRequest("initialize", {
		processId: process.pid,
		rootUri: pathToFileURL(root).href,
		capabilities: { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] } } },
		initializationOptions: { apexFeatures: true },
	});
	await conn.sendNotification("initialized", {});
	const s: Server = { conn, child, root, fx, warnings, opened: new Set() };
	for (const [rel, text] of Object.entries(fx.buffers)) await open(s, rel, text);
	return s;
}

function stopServer(s: Server | undefined): void {
	if (!s) return;
	try { s.conn.dispose(); } catch { /* ignore */ }
	try { s.child.kill(); } catch { /* ignore */ }
	try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const uriOf = (s: Server, rel: string) => pathToFileURL(path.join(s.root, rel)).href;
const relOf = (s: Server, uri: string) => path.relative(s.root, fileURLToPath(uri));

async function open(s: Server, rel: string, text?: string): Promise<void> {
	if (s.opened.has(rel)) return;
	s.opened.add(rel);
	await s.conn.sendNotification("textDocument/didOpen", {
		textDocument: { uri: uriOf(s, rel), languageId: "apex", version: 1, text: text ?? s.fx.files[rel] },
	});
}

type Got = { file: string; line: number; character: number; length: number };
const toGot = (s: Server, locs: any[]): Got[] =>
	(locs ?? []).map((l) => ({ file: relOf(s, l.uri), line: l.range.start.line, character: l.range.start.character, length: l.range.end.character - l.range.start.character }));

async function refsAt(s: Server, anchor: string, includeDeclaration = true): Promise<{ got: Got[]; ms: number }> {
	const a = s.fx.anchors.get(anchor);
	assert.ok(a, `anchor ${anchor}`);
	await open(s, a.file);
	const t0 = Date.now();
	const locs = await s.conn.sendRequest("textDocument/references", {
		textDocument: { uri: uriOf(s, a.file) },
		position: { line: a.line, character: a.character + 1 },
		context: { includeDeclaration },
	});
	return { got: toGot(s, locs), ms: Date.now() - t0 };
}

function fmt(l: { file: string; line: number; character: number; cat?: string }): string {
	return `${l.cat ? l.cat + " " : ""}${path.basename(l.file)}:${l.line + 1}:${l.character + 1}`;
}

/** Assert the exact expected set for `sym`. */
function assertExact(fx: RefFixture, sym: string, got: Got[], label: string): void {
	const { missing, extra } = scoreRefs(fx, sym, got);
	assert.deepStrictEqual(
		{ missing: missing.map(fmt), extra: extra.map(fmt) },
		{ missing: [], extra: [] },
		`${label}: references of ${sym} differ from the ground truth`,
	);
	const keys = got.map((g) => `${g.file}:${g.line}:${g.character}`);
	assert.strictEqual(new Set(keys).size, keys.length, `${label}: duplicate locations`);
}

const sameLoc = (l: any, e: ExpLoc, s: Server) =>
	relOf(s, l.uri) === e.file && l.range.start.line === e.line && l.range.start.character === e.character && l.range.end.character === e.character + e.length;

// ─── pure scanners ──────────────────────────────────────────────────────────────

describe("sfMetadataRefs scanners", () => {
	it("blankJs keeps template expressions as code and blanks comments/strings", () => {
		const t = "const a = `x ${getAccounts()} y`; // getAccounts\nconst b = 'getAccounts';";
		const code = blankJs(t);
		assert.strictEqual(code.length, t.length);
		assert.strictEqual(jsIdentifierUses(t, "getAccounts", code).length, 1);
	});

	it("jsIdentifierUses skips member access and object keys but keeps ternaries", () => {
		const t = "f(getX); this.getX = 1; o = { getX: 2 }; c ? getX : y;";
		assert.strictEqual(jsIdentifierUses(t, "getX").length, 2);
	});

	it("parses default, mixed and namespaced @salesforce/apex imports", () => {
		const t = "import a, { b } from '@salesforce/apex/Cls.m1';\nimport c from \"@salesforce/apex/ns.Cls.m2\";\nimport { x } from 'lwc';";
		const imps = lwcApexImports(t);
		assert.deepStrictEqual(imps.map((i) => [i.local?.name, i.ns, i.cls.name, i.method.name]), [["a", undefined, "Cls", "m1"], ["c", "ns", "Cls", "m2"]]);
		assert.strictEqual(t.slice(imps[1].method.start, imps[1].method.end), "m2");
		assert.strictEqual(t.slice(imps[1].cls.start, imps[1].cls.end), "Cls");
		assert.strictEqual(lwcApexImportAt(t, t.indexOf("m2"))?.on, "spec");
	});

	it("Aura controller + action strings, VF controllers + expressions, Flow, Type.forName", () => {
		const cmp = '<aura:component controller="ns.Ctl" implements="x">';
		const r = auraControllerRef(cmp)!;
		assert.deepStrictEqual([r.name, r.ns, cmp.slice(r.start, r.end)], ["Ctl", "ns", "Ctl"]);
		const js = "({ a: function(c) { c.get('c.load'); /* 'c.load' */ c.get(\"c.save\"); } })";
		assert.deepStrictEqual(auraActionAt(js, js.indexOf("load"))?.name, "load");
		assert.strictEqual(auraActionAt(js, js.lastIndexOf("load")), undefined, "inside a comment");
		const page = '<apex:page controller="A" extensions="B, ns.C"><!-- {!x} -->{!x} {!r.x} {!$Label.x} {!IF(x, 1, 2)}</apex:page>';
		assert.deepStrictEqual(vfControllerRefs(page).map((x) => x.name), ["A", "B", "C"]);
		assert.strictEqual(vfExpressionRefs(page, ["x"]).length, 2);
		assert.deepStrictEqual(vfNamesForMember("getRecent", "method", 0), ["Recent"]);
		assert.deepStrictEqual(vfNamesForMember("setRecent", "method", 1), ["Recent"]);
		assert.deepStrictEqual(vfNamesForMember("save", "method", 0), ["save"]);
		const flow = "<actionCalls><actionName>ns__Inv</actionName><actionType>apex</actionType></actionCalls><actionCalls><actionName>Inv</actionName><actionType>flow</actionType></actionCalls><apexClass>Shape</apexClass>";
		assert.deepStrictEqual(flowApexRefs(flow).map((x) => [x.tag, x.ns, x.name]), [["actionName", "ns", "Inv"], ["apexClass", undefined, "Shape"]]);
		const apex = "Type t = Type.forName('A'); Type u = Type.forName('ns', 'B'); Type v = type.FORNAME('ns.C');";
		assert.deepStrictEqual(typeForNameRefs(apex).map((x) => x.name), ["A", "B", "C"]);
	});
});

// ─── ground truth ───────────────────────────────────────────────────────────────

describe("references: ground truth (300-class workspace)", function () {
	this.timeout(60000);
	let s: Server;
	before(async function () {
		this.timeout(60000);
		s = await startServer(buildRefFixture({ fillers: 300 }));
	});
	after(() => stopServer(s));

	it("finds the class from its declaration while every other file is still closed", async () => {
		// Only AccountService.cls (and the unsaved Draft buffer) are open at this point.
		const { got } = await refsAt(s, "C");
		assertExact(s.fx, "C", got, "C");
		const files = new Set(got.map((g) => path.basename(g.file)));
		for (const f of ["Consumer.cls", "AccountTrigger.trigger", "AccountServiceTest.cls", "accountList.js", "accountList.cmp", "AccountsPage.page", "Account_Flow.flow-meta.xml", "Draft.cls"]) {
			assert.ok(files.has(f), `closed/unsaved file ${f} is found`);
		}
	});

	const apexAnchors = () => [...s.fx.anchors.keys()].filter((k) => /\.(cls|trigger)$/.test(s.fx.anchors.get(k)!.file));
	it("every Apex query returns exactly the expected set (all categories)", async () => {
		const failures: string[] = [];
		for (const anchor of apexAnchors()) {
			const sym = anchor.split(".")[0];
			const { got } = await refsAt(s, anchor);
			try {
				assertExact(s.fx, sym, got, anchor);
			} catch (e: any) {
				failures.push(e.message + "\n" + JSON.stringify(e.actual));
			}
		}
		assert.deepStrictEqual(failures, []);
	});

	it("an override and its base method are one symbol (same set from either)", async () => {
		const a = (await refsAt(s, "DS")).got.map(fmt).sort();
		const b = (await refsAt(s, "DS.override")).got.map(fmt).sort();
		assert.deepStrictEqual(a, b);
		const c = (await refsAt(s, "HM")).got.map(fmt).sort();
		const d = (await refsAt(s, "HM.override")).got.map(fmt).sort();
		assert.deepStrictEqual(c, d);
	});

	it("honors includeDeclaration: false", async () => {
		const { got } = await refsAt(s, "GA", false);
		const decl = s.fx.anchors.get("GA")!;
		assert.ok(!got.some((g) => g.file === decl.file && g.line === decl.line && g.character === decl.character));
		assert.strictEqual(got.length, s.fx.expected.get("GA")!.length - 1);
	});

	it("unsaved buffer text wins over disk", async () => {
		const { got } = await refsAt(s, "GA");
		assert.ok(!got.some((g) => g.file.endsWith("Draft.cls")), "the call only on disk is not reported");
		const ds = (await refsAt(s, "DS")).got;
		assert.ok(ds.some((g) => g.file.endsWith("Draft.cls")), "the call only in the buffer is reported");
	});

	it("follows watched-file creates and deletes", async () => {
		const rel = "force-app/main/default/classes/LateUser.cls";
		const full = path.join(s.root, rel);
		fs.writeFileSync(full, "public class LateUser {\n    void go() { AccountService.getAccounts(3); }\n}\n");
		await s.conn.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(full).href, type: 1 }] });
		let got = (await refsAt(s, "GA")).got;
		assert.ok(got.some((g) => g.file === rel && g.line === 1 && g.character === 31), "new file found");
		fs.rmSync(full);
		await s.conn.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(full).href, type: 3 }] });
		got = (await refsAt(s, "GA")).got;
		assert.ok(!got.some((g) => g.file === rel), "deleted file gone");
	});

	it("LWC → Apex: definition from spec / binding / @wire / call, namespaced and case-different", async () => {
		const ga = s.fx.anchors.get("GA")!;
		for (const anchor of ["GA.lwc.spec", "GA.lwc.binding", "GA.lwc.wire", "GA.lwc.call", "GA.lwc.ns", "GA.lwc.ns.call", "GA.lwc.case"]) {
			const a = s.fx.anchors.get(anchor)!;
			const text = s.fx.files[a.file];
			const lines = text.split("\n");
			const offset = lines.slice(0, a.line).reduce((n, l) => n + l.length + 1, 0) + a.character + 1;
			const hit = lwcApexImportAt(text, offset);
			assert.ok(hit, `${anchor}: import resolved`);
			const loc = await s.conn.sendRequest("sfx/apexDefinition", { className: hit.imp.cls.name, member: hit.imp.method.name, prefer: "aura" });
			assert.ok(loc && sameLoc(loc, ga, s), `${anchor}: lands on the @AuraEnabled getAccounts(Integer), got ${JSON.stringify(loc)}`);
		}
		// Not the member access `this.getAccounts`.
		const m = s.fx.negatives.get("GA")!.find((n) => n.cat === "lwc-member")!;
		const text = s.fx.files[m.file];
		const offset = text.split("\n").slice(0, m.line).reduce((n, l) => n + l.length + 1, 0) + m.character + 1;
		assert.strictEqual(lwcApexImportAt(text, offset), undefined);
	});

	it("LWC: Find References on an imported Apex function = the full Apex + metadata list", async () => {
		const locs: any[] = await s.conn.sendRequest("sfx/apexReferences", { className: "AccountService", member: "getAccounts", prefer: "aura" });
		assertExact(s.fx, "GA", toGot(s, locs), "sfx/apexReferences");
	});

	it("Aura → Apex: c.method and controller= resolve to the declarations", async () => {
		const a = s.fx.anchors.get("AUR.aura")!;
		const js = s.fx.files[a.file];
		const offset = js.split("\n").slice(0, a.line).reduce((n, l) => n + l.length + 1, 0) + a.character + 1;
		const action = auraActionAt(js, offset)!;
		const ctrl = auraControllerRef(s.fx.files[path.join(path.dirname(a.file), "accountList.cmp")])!;
		const loc = await s.conn.sendRequest("sfx/apexDefinition", { className: ctrl.name, member: action.name, prefer: "aura" });
		assert.ok(loc && sameLoc(loc, s.fx.anchors.get("AUR")!, s));
		const cls = await s.conn.sendRequest("sfx/apexDefinition", { className: ctrl.name });
		assert.ok(cls && sameLoc(cls, s.fx.anchors.get("C")!, s));
	});

	describe("rename uses the same engine and updates metadata where safe", () => {
		const editsOf = (edit: any): { file: string; line: number; character: number; length: number; newText: string }[] => {
			const out: any[] = [];
			const push = (uri: string, edits: any[]) => {
				for (const e of edits) out.push({ file: relOf(s, uri), line: e.range.start.line, character: e.range.start.character, length: e.range.end.character - e.range.start.character, newText: e.newText });
			};
			if (edit?.changes) for (const uri of Object.keys(edit.changes)) push(uri, edit.changes[uri]);
			if (edit?.documentChanges) for (const dc of edit.documentChanges) if (dc.edits) push(dc.textDocument.uri, dc.edits);
			return out;
		};
		const renameAt = async (anchor: string, newName: string) => {
			const a = s.fx.anchors.get(anchor)!;
			await open(s, a.file);
			return s.conn.sendRequest("textDocument/rename", { textDocument: { uri: uriOf(s, a.file) }, position: { line: a.line, character: a.character + 1 }, newName });
		};

		it("@AuraEnabled method: Apex calls, LWC specifiers and Aura actions — not LWC bindings, not other types", async () => {
			const edits = editsOf(await renameAt("GA", "fetchAccounts"));
			const expected = s.fx.expected.get("GA")!.filter((e) => !["lwc-binding", "lwc-wire", "lwc-call"].includes(e.cat));
			const key = (x: { file: string; line: number; character: number; length: number }) => `${x.file}:${x.line}:${x.character}:${x.length}`;
			assert.deepStrictEqual(edits.map(key).sort(), expected.map(key).sort());
			assert.ok(edits.every((e) => e.newText === "fetchAccounts"));
		});

		it("overloads by parameter type: rename touches only the proven calls (never an undeterminable argument)", async () => {
			const key = (x: { file: string; line: number; character: number; length: number }) => `${x.file}:${x.line}:${x.character}:${x.length}`;
			for (const sym of ["OVS", "OVI", "OVA", "GLS", "GLI", "GMA", "GMS", "GQA", "GQC"]) {
				const edits = editsOf(await renameAt(sym, "transform"));
				const expected = s.fx.expected.get(sym)!.filter((e) => e.cat !== "undetermined");
				assert.deepStrictEqual(edits.map(key).sort(), expected.map(key).sort(), `rename ${sym}`);
			}
		});

		it("class: VF extensions, the constructor and files are renamed", async () => {
			const edit: any = await renameAt("EXT", "AccountExtension");
			const edits = editsOf(edit);
			assert.deepStrictEqual(edits.map((e) => path.basename(e.file)).sort(), ["AccountExt.cls", "AccountExt.cls", "AccountPage.page"]);
			assert.ok(edit.documentChanges.some((d: any) => d.kind === "rename"));
		});

		it("VF getter: renamed with the get prefix, skipped (with a warning) without it", async () => {
			let edits = editsOf(await renameAt("REC", "getLatest"));
			const vf = edits.find((e) => e.file.endsWith(".page"));
			assert.strictEqual(vf?.newText, "Latest");
			s.warnings.length = 0;
			edits = editsOf(await renameAt("REC", "loadRecent"));
			assert.ok(!edits.some((e) => e.file.endsWith(".page")));
			for (let i = 0; i < 20 && !s.warnings.length; i++) await new Promise((r) => setTimeout(r, 25));
			assert.match(s.warnings.join("\n"), /Visualforce/);
		});

		it("@InvocableMethod: the Flow action (it names the class) is not touched by a method rename", async () => {
			const edits = editsOf(await renameAt("RUN", "execute2"));
			assert.ok(!edits.some((e) => e.file.endsWith(".flow-meta.xml")));
			const cls = editsOf(await renameAt("INV", "AccountInvocable2"));
			assert.ok(cls.some((e) => e.file.endsWith(".flow-meta.xml")));
		});
	});
});

describe("references: latency (2000-class workspace)", function () {
	this.timeout(120000);
	let s: Server;
	before(async function () {
		this.timeout(120000);
		s = await startServer(buildRefFixture({ fillers: 2000 }));
	});
	after(() => stopServer(s));

	it("cold < 2 s, warm < 500 ms — and still exact", async () => {
		const cold = await refsAt(s, "DS");
		assertExact(s.fx, "DS", cold.got, "cold DS");
		assert.ok(cold.ms < 2000, `cold references took ${cold.ms} ms`);
		for (const anchor of ["DS", "GA", "C", "HM", "ST"]) {
			const sym = anchor.split(".")[0];
			await refsAt(s, anchor);
			const warm = await refsAt(s, anchor);
			assertExact(s.fx, sym, warm.got, `warm ${anchor}`);
			assert.ok(warm.ms < 500, `warm ${anchor} took ${warm.ms} ms`);
		}
	});
});

// ─── unsaved metadata buffers (sfx/metadataBuffer) ──────────────────────────────

describe("references: unsaved LWC buffers (sfx/metadataBuffer)", function () {
	this.timeout(60000);
	let s: Server;
	const LWC_REL = "force-app/main/default/lwc/otherList/otherList.js";
	const OVERLAY_TEXT =
		"import { LightningElement } from 'lwc';\n" +
		"import fetchIt from '@salesforce/apex/AccountService.getAccounts';\n" +
		"export default class OtherList extends LightningElement {\n" +
		"    go() { return fetchIt({ max: 1 }); }\n" +
		"}\n";
	const note = (rel: string, text: string | null) => s.conn.sendNotification("sfx/metadataBuffer", { uri: uriOf(s, rel), text });
	const inLwc = async () => (await refsAt(s, "GA")).got.filter((g) => g.file === LWC_REL);

	before(async () => {
		s = await startServer(buildRefFixture());
	});
	after(() => stopServer(s));

	it("an unsaved call to an @AuraEnabled method is a reference; null brings the disk version back", async () => {
		assert.strictEqual((await inLwc()).length, 0, "the disk version does not use AccountService");
		await note(LWC_REL, OVERLAY_TEXT);
		const hits = await inLwc();
		assert.deepStrictEqual(
			hits.map((h) => [h.line, h.length]).sort(),
			[[1, "fetchIt".length], [1, "getAccounts".length], [3, "fetchIt".length]].sort(),
			"import binding + specifier + the call through the binding",
		);
		await note(LWC_REL, null);
		assert.strictEqual((await inLwc()).length, 0, "back to disk");
	});

	it("the overlay is bounded: oldest entries are evicted and oversized text is ignored", async () => {
		await note(LWC_REL, OVERLAY_TEXT);
		assert.strictEqual((await inLwc()).length, 3);
		// 200 newer entries push the first one out (max 200).
		for (let i = 0; i < 200; i++) await note(`force-app/main/default/lwc/filler${i}/filler${i}.js`, `// filler ${i}\n`);
		assert.strictEqual((await inLwc()).length, 0, "evicted entry falls back to disk");
		// > 2 MB is not kept.
		await note(LWC_REL, OVERLAY_TEXT + "// " + "x".repeat(2 * 1024 * 1024 + 10));
		assert.strictEqual((await inLwc()).length, 0, "oversized buffer ignored");
		await note(LWC_REL, OVERLAY_TEXT);
		assert.strictEqual((await inLwc()).length, 3, "a normal one still works afterwards");
	});
});
