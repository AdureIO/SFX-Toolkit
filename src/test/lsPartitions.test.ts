/**
 * Language-server index partitions (multi-project, MP4): the symbol index is partitioned by
 * each project's DEFAULT ORG, as announced by the host in `asfx/projects`.
 *
 * Workspace (one server, root = the temp dir):
 *   projA  org1, namespace nsa   Shared, Dup, Caller (uses both + Type.forName strings)
 *   projB  org2, namespace nsb   Shared, Dup (same names as A!), OnlyB, CallerB
 *   projC  org1 (shares A)       CallerC (uses A's Shared)
 *   projD  no default org        OnlyD  (its own `dir:` partition)
 *   outside/                     Out    (no project → partition `none`)
 *
 * Covers isolation / sharing for completion type names, hover (`findTypeMembers` / hasType),
 * definition (same-named classes), references, rename, namespace per file, workspace symbols
 * (active project) and per-project SObject stubs.
 *
 * Requires `npm run compile` first (out/server.js + out/serverParseWorker.js).
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL, fileURLToPath } from "url";
import * as ts from "typescript";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const SHARED_A = "public class Shared {\n  public static Integer val() { return 1; }\n}\n";
const SHARED_B = "public class Shared {\n  public static Integer val() { return 2; }\n}\n";
const FILES: Record<string, string> = {
	"projA/sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace: "nsa" }),
	"projA/force-app/main/default/classes/Shared.cls": SHARED_A,
	"projA/force-app/main/default/classes/Dup.cls": "public class Dup {\n  public String a;\n}\n",
	"projA/force-app/main/default/classes/Caller.cls": [
		"public class Caller {",
		"  public void run() {",
		"    Dup d = new Dup();",
		"    Integer v = Shared.val();",
		"    Type t = Type.forName('nsa.Dup');",
		"    Type u = Type.forName('nsb.Dup');",
		"    Account acc = null;",
		"  }",
		"}",
		"",
	].join("\n"),
	"projB/sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], namespace: "nsb" }),
	"projB/force-app/main/default/classes/Shared.cls": SHARED_B,
	"projB/force-app/main/default/classes/Dup.cls": "public class Dup {\n  public String b;\n}\n",
	"projB/force-app/main/default/classes/OnlyB.cls": "public class OnlyB {}\n",
	"projB/force-app/main/default/classes/CallerB.cls": [
		"public class CallerB {",
		"  public void run() {",
		"    Dup d = new Dup();",
		"    Integer v = Shared.val();",
		"    Type t = Type.forName('nsb.Shared');",
		"    Account acc = null;",
		"  }",
		"}",
		"",
	].join("\n"),
	"projC/sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
	"projC/force-app/main/default/classes/CallerC.cls": "public class CallerC {\n  public void run() {\n    Integer v = Shared.val();\n  }\n}\n",
	"projD/sfdx-project.json": JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }),
	"projD/force-app/main/default/classes/OnlyD.cls": "public class OnlyD {}\n",
	"outside/Out.cls": "public class Out {\n  public void run() {\n    Integer v = Shared.val();\n  }\n}\n",
};

interface Server {
	conn: any;
	child: cp.ChildProcess;
	root: string;
	projectInfoAsks: string[];
}

const uri = (s: Server, rel: string) => pathToFileURL(path.join(s.root, rel)).href;
const CLS = (proj: string, name: string) => `${proj}/force-app/main/default/classes/${name}.cls`;

function mapFor(root: string, over: Partial<Record<string, unknown>> = {}) {
	const d = (p: string) => path.join(root, p);
	return {
		projects: [
			{ dir: d("projA"), partition: "org:org1@x.com", namespace: "nsa", name: "projA" },
			{ dir: d("projB"), partition: "org:org2@x.com", namespace: "nsb", name: "projB" },
			{ dir: d("projC"), partition: "org:org1@x.com", namespace: null, name: "projC" },
			{ dir: d("projD"), partition: `dir:${d("projD")}`, namespace: null, name: "projD" },
		],
		activeDir: d("projA"),
		buffers: {},
		...over,
	};
}

async function startServer(): Promise<Server> {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-part-")));
	for (const [rel, text] of Object.entries(FILES)) {
		const f = path.join(root, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, text);
	}
	const serverPath = path.join(__dirname, "..", "server.js");
	assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
	const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
	const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
	const s: Server = { conn, child, root, projectInfoAsks: [] };
	conn.onRequest("sfx/objectList", () => ["Account"]);
	conn.onRequest("sfx/describe", ({ sobject }: { sobject: string }) =>
		sobject === "Account" ? { name: "Account", fields: [{ name: "Id", type: "id" }, { name: "Name", type: "string" }], childRelationships: [] } : null,
	);
	conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => names.map(() => null));
	// A deliberately WRONG answer: the server must take namespaces from the project map.
	conn.onRequest("sfx/projectInfo", (p: { uri: string }) => {
		s.projectInfoAsks.push(p.uri);
		return { namespace: "wrongns" };
	});
	conn.onRequest("sfx/objectInfo", () => ({ description: null }));
	conn.onNotification("textDocument/publishDiagnostics", () => undefined);
	conn.onNotification("window/showMessage", () => undefined);
	conn.listen();
	await conn.sendRequest("initialize", {
		processId: process.pid,
		rootUri: pathToFileURL(root).href,
		workspaceFolders: [{ uri: pathToFileURL(root).href, name: "w" }],
		capabilities: { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] } } },
		initializationOptions: { apexFeatures: true },
	});
	await conn.sendNotification("initialized", {});
	await conn.sendNotification("asfx/projects", mapFor(root));
	return s;
}

function stop(s: Server | undefined): void {
	if (!s) return;
	try { s.conn.dispose(); } catch { /* ignore */ }
	try { s.child.kill(); } catch { /* ignore */ }
	try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const opened = new Set<string>();
async function open(s: Server, rel: string, text?: string): Promise<void> {
	const key = `${s.root}|${rel}|${text ?? ""}`;
	if (opened.has(key)) return;
	opened.add(key);
	await s.conn.sendNotification("textDocument/didOpen", {
		textDocument: { uri: uri(s, rel), languageId: "apex", version: 1, text: text ?? fs.readFileSync(path.join(s.root, rel), "utf8") },
	});
}

/** Position of `needle` (nth occurrence, 0-based) in the file's text, on the identifier's second char. */
function posOf(s: Server, rel: string, needle: string, nth = 0, text?: string): { line: number; character: number } {
	const t = text ?? fs.readFileSync(path.join(s.root, rel), "utf8");
	let idx = -1;
	for (let i = 0; i <= nth; i++) idx = t.indexOf(needle, idx + 1);
	assert.ok(idx >= 0, `${needle} in ${rel}`);
	const before = t.slice(0, idx);
	const line = before.split("\n").length - 1;
	return { line, character: idx - (before.lastIndexOf("\n") + 1) + 1 };
}

const relOf = (s: Server, u: string) => path.relative(s.root, fileURLToPath(u));

async function refs(s: Server, rel: string, needle: string, nth = 0): Promise<string[]> {
	await open(s, rel);
	const locs = await s.conn.sendRequest("textDocument/references", {
		textDocument: { uri: uri(s, rel) },
		position: posOf(s, rel, needle, nth),
		context: { includeDeclaration: true },
	});
	return [...new Set<string>((locs ?? []).map((l: any) => relOf(s, l.uri)))].sort();
}

async function hoverText(s: Server, rel: string, needle: string, nth = 0): Promise<string> {
	await open(s, rel);
	const h = await s.conn.sendRequest("textDocument/hover", { textDocument: { uri: uri(s, rel) }, position: posOf(s, rel, needle, nth) });
	const c = h?.contents;
	return !c ? "" : typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x.value ?? x).join("\n") : c.value ?? "";
}

async function definition(s: Server, rel: string, needle: string, nth = 0): Promise<string | undefined> {
	await open(s, rel);
	const loc = await s.conn.sendRequest("textDocument/definition", { textDocument: { uri: uri(s, rel) }, position: posOf(s, rel, needle, nth) });
	const l = Array.isArray(loc) ? loc[0] : loc;
	return l ? relOf(s, l.uri) : undefined;
}

/** Labels of the completion list at the end of `text` (opened as `rel`). */
async function completeLabels(s: Server, rel: string, text: string): Promise<string[]> {
	await open(s, rel, text);
	const lines = text.split("\n");
	const res = await s.conn.sendRequest("textDocument/completion", {
		textDocument: { uri: uri(s, rel) },
		position: { line: lines.length - 1, character: lines[lines.length - 1].length },
		context: { triggerKind: 1 },
	});
	const items = Array.isArray(res) ? res : res?.items ?? [];
	return items.map((i: any) => i.label);
}

const A = (n: string) => CLS("projA", n);
const B = (n: string) => CLS("projB", n);
const C = (n: string) => CLS("projC", n);

describe("language server: index partitions by default org", function () {
	this.timeout(60000);
	let s: Server;
	before(async () => {
		s = await startServer();
		await s.conn.sendRequest("workspace/symbol", { query: "" }); // resolves once the initial scan is done
	});
	after(() => stop(s));

	describe("type names (completion) and hasType (hover)", () => {
		const ctxText = (cls: string) => `public class ${cls}X {\n  void m() {\n    Object o = new `;

		it("a project sees its own classes", async () => {
			const labels = await completeLabels(s, B("CallerBX"), ctxText("CallerB"));
			assert.ok(labels.includes("OnlyB"), "B sees OnlyB");
			assert.ok(labels.includes("Shared") && labels.includes("Dup"));
		});

		it("projects with different orgs are isolated", async () => {
			const b = await completeLabels(s, B("CallerBY"), ctxText("CallerB"));
			assert.ok(!b.includes("OnlyD") && !b.includes("Caller") && !b.includes("CallerC"), "B sees nothing of A / C / D");
			const a = await completeLabels(s, A("CallerY"), ctxText("Caller"));
			assert.ok(!a.includes("OnlyB") && !a.includes("CallerB"), "A sees nothing of B");
		});

		it("projects with the same org share types", async () => {
			const c = await completeLabels(s, C("CallerCX"), ctxText("CallerC"));
			assert.ok(c.includes("Caller") && c.includes("Dup"), "C sees A's classes");
			assert.ok(!c.includes("OnlyB"), "…but not B's");
			const a = await completeLabels(s, A("CallerZ"), ctxText("Caller"));
			assert.ok(a.includes("CallerC"), "A sees C's classes");
		});

		it("a project without a default org is its own partition", async () => {
			const d = await completeLabels(s, "projD/force-app/main/default/classes/OnlyDX.cls", ctxText("OnlyD"));
			assert.ok(d.includes("OnlyD"));
			assert.ok(!d.includes("Shared") && !d.includes("OnlyB") && !d.includes("Caller"), "D sees only itself");
			const a = await completeLabels(s, A("CallerW"), ctxText("Caller"));
			assert.ok(!a.includes("OnlyD"), "nobody else sees D");
		});

		it("a file outside any project sees no project's classes", async () => {
			const o = await completeLabels(s, "outside/OutX.cls", ctxText("Out"));
			assert.ok(!o.some((l) => ["Shared", "Dup", "OnlyB", "OnlyD", "Caller"].includes(l)), `got ${o.filter((l) => /^[A-Z]/.test(l)).slice(0, 8)}`);
		});

		it("hover (hasType / member lookup) follows the partition", async () => {
			assert.match(await hoverText(s, C("CallerC"), "Shared"), /class Shared/, "shared org: C resolves A's Shared");
			assert.doesNotMatch(await hoverText(s, "outside/Out.cls", "Shared"), /class Shared/, "outside: unresolved");
			assert.match(await hoverText(s, B("CallerB"), "Shared"), /class Shared/, "B resolves its own Shared");
		});
	});

	describe("same-named classes", () => {
		it("each project resolves its own class", async () => {
			assert.strictEqual(await definition(s, A("Caller"), "Dup", 1), A("Dup"));
			assert.strictEqual(await definition(s, B("CallerB"), "Dup", 1), B("Dup"));
			assert.strictEqual(await definition(s, A("Caller"), "Shared"), A("Shared"));
			assert.strictEqual(await definition(s, B("CallerB"), "Shared"), B("Shared"));
		});

		it("a project of the same org resolves to the shared definition, and an outside file to none", async () => {
			assert.strictEqual(await definition(s, C("CallerC"), "Shared"), A("Shared"));
			assert.strictEqual(await definition(s, "outside/Out.cls", "Shared"), undefined);
		});
	});

	describe("references", () => {
		it("stay within the partition: shared org spans A and C, never B", async () => {
			assert.deepStrictEqual(await refs(s, A("Shared"), "Shared"), [A("Caller"), A("Shared"), C("CallerC")].sort());
		});

		it("same-named class of another org is a different symbol", async () => {
			assert.deepStrictEqual(await refs(s, B("Shared"), "Shared"), [B("CallerB"), B("Shared")].sort());
			assert.deepStrictEqual(await refs(s, A("Dup"), "Dup"), [A("Caller"), A("Dup")].sort());
			assert.deepStrictEqual(await refs(s, B("Dup"), "Dup"), [B("CallerB"), B("Dup")].sort());
		});

		it("an isolated project's reference search never reaches other projects", async () => {
			assert.deepStrictEqual(await refs(s, "projD/force-app/main/default/classes/OnlyD.cls", "OnlyD"), ["projD/force-app/main/default/classes/OnlyD.cls"]);
		});
	});

	describe("namespace per file", () => {
		it("Type.forName uses the namespace of the target class's project (map), not the first open document's", async () => {
			const asks0 = s.projectInfoAsks.length;
			// A (nsa): 'nsa.Dup' is the class, 'nsb.Dup' is not. Search it from A.
			const locs = await s.conn.sendRequest("textDocument/references", {
				textDocument: { uri: uri(s, A("Dup")) },
				position: posOf(s, A("Dup"), "Dup"),
				context: { includeDeclaration: false },
			});
			const lines = (locs as any[]).filter((l) => relOf(s, l.uri) === A("Caller")).map((l) => l.range.start.line);
			assert.ok(lines.includes(4), "forName('nsa.Dup') is a reference");
			assert.ok(!lines.includes(5), "forName('nsb.Dup') is not (foreign namespace)");
			// B (nsb): 'nsb.Shared' is its class.
			const bl = await s.conn.sendRequest("textDocument/references", {
				textDocument: { uri: uri(s, B("Shared")) },
				position: posOf(s, B("Shared"), "Shared"),
				context: { includeDeclaration: false },
			});
			assert.ok((bl as any[]).some((l) => relOf(s, l.uri) === B("CallerB") && l.range.start.line === 4), "forName('nsb.Shared') in B");
			assert.strictEqual(s.projectInfoAsks.length, asks0, "the host was not asked: the project map carries the namespaces");
		});
	});

	describe("rename", () => {
		it("renames only the partition's occurrences (shared org: A + C; not B)", async () => {
			await open(s, A("Shared"));
			const edit = await s.conn.sendRequest("textDocument/rename", {
				textDocument: { uri: uri(s, A("Shared")) },
				position: posOf(s, A("Shared"), "Shared"),
				newName: "Common",
			});
			const files = new Set<string>();
			for (const dc of edit?.documentChanges ?? []) {
				if (dc.textDocument) files.add(relOf(s, dc.textDocument.uri));
				else if (dc.oldUri) files.add(relOf(s, dc.oldUri));
			}
			for (const u of Object.keys(edit?.changes ?? {})) files.add(relOf(s, u));
			assert.ok(files.has(A("Caller")) && files.has(C("CallerC")) && files.has(A("Shared")), `A + C edited: ${[...files]}`);
			assert.ok(![...files].some((f) => f.startsWith("projB")), "B untouched");
			assert.ok(![...files].some((f) => f.startsWith("outside") || f.startsWith("projD")));
		});
	});

	describe("workspace symbols (active project)", () => {
		const symbols = async (q = "") => ((await s.conn.sendRequest("workspace/symbol", { query: q })) as any[]) ?? [];

		it("lists the active project's partition, with the project name as container when several exist", async () => {
			const syms = await symbols();
			const names = syms.map((x) => x.name);
			assert.ok(names.includes("Caller") && names.includes("CallerC"), "active A: A + C (same org)");
			assert.ok(!names.includes("OnlyB") && !names.includes("OnlyD"));
			const shared = syms.filter((x) => x.name === "Shared");
			assert.strictEqual(shared.length, 1, "one Shared (A's), not B's");
			assert.strictEqual(shared[0].containerName, "projA");
			assert.strictEqual(syms.find((x) => x.name === "CallerC").containerName, "projC");
		});

		it("follows the active project without a restart", async () => {
			await s.conn.sendNotification("asfx/projects", mapFor(s.root, { activeDir: path.join(s.root, "projB") }));
			const names = (await symbols()).map((x) => x.name);
			assert.ok(names.includes("OnlyB") && names.includes("CallerB"));
			assert.ok(!names.includes("Caller"), "A is invisible while B is active");
			await s.conn.sendNotification("asfx/projects", mapFor(s.root));
		});
	});

	describe("default-org change (live, no restart)", () => {
		it("moving a project to another org re-partitions it immediately", async () => {
			// C leaves org1 → its own org3: it no longer sees A, and A no longer sees CallerC.
			const base = mapFor(s.root) as any;
			const moved = { ...base, projects: base.projects.map((p: any) => (p.name === "projC" ? { ...p, partition: "org:org3@x.com" } : p)) };
			await s.conn.sendNotification("asfx/projects", moved);
			assert.doesNotMatch(await hoverText(s, C("CallerC"), "Shared"), /class Shared/);
			assert.deepStrictEqual(await refs(s, A("Dup"), "Dup"), [A("Caller"), A("Dup")].sort());
			assert.deepStrictEqual(await refs(s, A("Shared"), "Shared"), [A("Caller"), A("Shared")].sort(), "C no longer in A's partition");
			// …and back.
			await s.conn.sendNotification("asfx/projects", base);
			assert.match(await hoverText(s, C("CallerC"), "Shared"), /class Shared/);
		});
	});

	describe("pinned buffers", () => {
		it("a document the host pinned to an org partition sees that org's classes", async () => {
			const bufUri = "asfx-buffer:///" + path.join(s.root, "scratch.apex").replace(/^\//, "");
			await s.conn.sendNotification("asfx/projects", mapFor(s.root, { buffers: { [bufUri]: "org:org2@x.com" } }));
			const text = "Object o = new ";
			await s.conn.sendNotification("textDocument/didOpen", { textDocument: { uri: bufUri, languageId: "apex", version: 1, text } });
			const res = await s.conn.sendRequest("textDocument/completion", {
				textDocument: { uri: bufUri },
				position: { line: 0, character: text.length },
				context: { triggerKind: 1 },
			});
			const labels = ((Array.isArray(res) ? res : res?.items ?? []) as any[]).map((i) => i.label);
			assert.ok(labels.includes("OnlyB") && !labels.includes("Caller"), "pinned to org2 → B's classes");
			await s.conn.sendNotification("asfx/projects", mapFor(s.root));
		});
	});

	describe("stubs per project", () => {
		const stub = (proj: string) => path.join(s.root, proj, ".sfdx", "tools", "sobjects", "standardObjects", "Account.cls");

		it("go-to-definition on an SObject writes and reads the stub of the document's own project", async () => {
			assert.strictEqual(await definition(s, A("Caller"), "Account"), path.relative(s.root, stub("projA")));
			assert.strictEqual(await definition(s, B("CallerB"), "Account"), path.relative(s.root, stub("projB")));
			assert.ok(fs.existsSync(stub("projA")) && fs.existsSync(stub("projB")));
			assert.ok(!fs.existsSync(path.join(s.root, ".sfdx")), "nothing written at the workspace root");
			assert.ok(!fs.existsSync(stub("projC")), "C never navigated: no stub of its own");
		});
	});
});

describe("partitions module (unit)", () => {
	let tmp: string;
	let P: any;

	before(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-partmod-")));
		for (const f of ["partitions", "caches"]) {
			const src = path.join(__dirname, "..", "..", "server", "src", `${f}.ts`);
			const out = ts.transpileModule(fs.readFileSync(src, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
			fs.writeFileSync(path.join(tmp, `${f}.js`), out.outputText);
		}
		P = require(path.join(tmp, "partitions.js")).Partitions;
	});
	after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	beforeEach(() => P.clear());

	const mk = (rel: string, text = "{}") => {
		const f = path.join(tmp, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, text);
	};
	const map = (projects: { dir: string; partition: string }[], activeDir?: string, buffers: Record<string, string> = {}) => ({
		projects: projects.map((p) => ({ ...p, namespace: null })),
		activeDir: activeDir ?? null,
		buffers,
	});

	it("an active-dir change alone is silent: no change signal, no listener, no schema refresh", () => {
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		const projects = [{ dir: a, partition: "org:1" }, { dir: b, partition: "org:2" }];
		let fired = 0;
		P.onChange(() => fired++);
		assert.strictEqual(P.set(map(projects, a)), true);
		assert.strictEqual(fired, 1);
		assert.strictEqual(P.set(map(projects, b)), false, "active switch → not a change");
		assert.strictEqual(fired, 1);
		assert.strictEqual(P.activePartition(), "org:2", "workspace symbols read the active partition live");
		assert.strictEqual(P.set(map(projects.slice(0, 1), b)), true, "a project-set change still signals");
	});

	it("a nested project keeps its partition once mapped, whether or not its documents are open", () => {
		const outer = path.join(tmp, "outer");
		const nested = path.join(outer, "deep", "deeper", "nested");
		mk("outer/sfdx-project.json");
		mk("outer/deep/deeper/nested/sfdx-project.json");
		const file = path.join(nested, "force-app", "classes", "X.cls");
		// Not mapped yet: the mapped ancestor wins (host maps nested dirs as soon as it sees them).
		P.set(map([{ dir: outer, partition: "org:1" }]));
		assert.strictEqual(P.partitionOfPath(file), "org:1");
		// The host maps it (and keeps it mapped after the document closes): its own org applies.
		P.set(map([{ dir: outer, partition: "org:1" }, { dir: nested, partition: "org:2" }]));
		assert.strictEqual(P.partitionOfPath(file), "org:2");
		assert.strictEqual(P.projectDirOf(file), nested);
		// Nothing about open documents is involved: the same answer on every later lookup.
		assert.strictEqual(P.partitionOfPath(file), "org:2");
		assert.strictEqual(P.partitionOfPath(path.join(outer, "force-app", "Y.cls")), "org:1");
	});

	it("MDAPI src/package.xml inside an SFDX project is not a project root", () => {
		mk("sfdxp/sfdx-project.json");
		mk("sfdxp/legacy/src/package.xml", "<Package/>");
		mk("mdapi/src/package.xml", "<Package/>");
		assert.strictEqual(P.partitionOfPath(path.join(tmp, "sfdxp", "legacy", "src", "classes", "A.cls")), `dir:${path.join(tmp, "sfdxp")}`);
		assert.strictEqual(P.partitionOfPath(path.join(tmp, "mdapi", "src", "classes", "A.cls")), `dir:${path.join(tmp, "mdapi")}`);
	});

	it("checks mapped ancestors before touching the disk, and caches every visited ancestor", () => {
		const proj = path.join(tmp, "nodisk", "proj");
		P.set(map([{ dir: proj, partition: "org:z" }]));
		const orig = fs.existsSync;
		let calls = 0;
		(fs as any).existsSync = (...a: any[]) => { calls++; return (orig as any)(...a); };
		try {
			assert.strictEqual(P.partitionOfPath(path.join(proj, "a", "b", "c", "X.cls")), "org:z");
			assert.strictEqual(calls, 0, "mapped ancestor: no disk probe");
			assert.strictEqual(P.partitionOfPath(path.join(proj, "a", "b", "Y.cls")), "org:z");
			assert.strictEqual(calls, 0);
		} finally {
			(fs as any).existsSync = orig;
		}
	});
});
