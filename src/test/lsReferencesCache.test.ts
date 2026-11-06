/**
 * Find References: the per-file-version caches behind candidate selection (language server).
 *
 * A file that merely mentions the target class is only scanned (no parse) for "producer"
 * members — members whose declared type mentions the class — and that scan is cached per
 * file version. These tests pin the invalidation rules: editing such a file on disk (watched
 * file change) refreshes it, and an unsaved editor buffer overrides the disk copy.
 */
import * as assert from "assert";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { pathToFileURL, fileURLToPath } from "url";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");

const CLS = "force-app/main/default/classes";

const SVC = `public class Svc {
    public void run() {}
}
`;

const caller = (extra = "") => `public class Caller {
    void go() {
        Svc s = new Svc();
        s.run();${extra}
    }
}
`;

/** Mentions Svc (so it is scanned), producing Svc only when `producesSvc`. */
const maker = (producesSvc: boolean) => `public class Maker {
    public Svc keep;
    public ${producesSvc ? "Svc" : "Other"} make() { return null; }
}
`;

/** Reaches Svc.run only through Maker.make(). */
const USES = `public class UsesMake {
    void go() {
        new Maker().make().run();
    }
}
`;

const OTHER = `public class Other {
    public void run() {}
}
`;

interface Server {
    conn: any;
    child: cp.ChildProcess;
    root: string;
}

const uriOf = (s: Server, rel: string) => pathToFileURL(path.join(s.root, rel)).href;

async function start(files: Record<string, string>): Promise<Server> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sfx-refcache-")));
    for (const [rel, text] of Object.entries(files)) {
        const full = path.join(root, CLS, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
        fs.writeFileSync(full.replace(/\.cls$/, ".cls-meta.xml"), '<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>');
    }
    const serverPath = path.join(__dirname, "..", "server.js");
    assert.ok(fs.existsSync(serverPath), "server.js must be built next to the test output");
    const child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
    const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
    conn.onRequest("sfx/objectList", () => []);
    conn.onRequest("sfx/describe", () => null);
    conn.onRequest("sfx/describeMany", ({ names }: { names: string[] }) => names.map(() => null));
    conn.onRequest("sfx/projectInfo", () => ({ namespace: null }));
    conn.onRequest("sfx/objectInfo", () => ({ description: null }));
    conn.onNotification("textDocument/publishDiagnostics", () => undefined);
    conn.onNotification("window/showMessage", () => undefined);
    conn.listen();
    await conn.sendRequest("initialize", { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions: { apexFeatures: true } });
    await conn.sendNotification("initialized", {});
    return { conn, child, root };
}

function stop(s: Server | undefined): void {
    if (!s) return;
    try { s.conn.dispose(); } catch { /* ignore */ }
    try { s.child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(s.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** References of Svc.run, as `File:line` strings (declaration excluded), sorted. */
async function runRefs(s: Server): Promise<string[]> {
    const rel = `${CLS}/Svc.cls`;
    const uri = uriOf(s, rel);
    await s.conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: SVC } });
    try {
        const locs: any[] = await s.conn.sendRequest("textDocument/references", {
            textDocument: { uri },
            position: { line: 1, character: SVC.split("\n")[1].indexOf("run") + 1 },
            context: { includeDeclaration: false },
        });
        return (locs ?? []).map((l) => `${path.basename(fileURLToPath(l.uri), ".cls")}:${l.range.start.line}`).sort();
    } finally {
        await s.conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
    }
}

async function editOnDisk(s: Server, name: string, text: string): Promise<void> {
    const full = path.join(s.root, CLS, name);
    fs.writeFileSync(full, text);
    const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000));
    fs.utimesSync(full, later, later); // a distinct mtime, whatever the filesystem's resolution
    await s.conn.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(full).href, type: 2 }] });
}

describe("references: per-file-version caches (producer scan of mention files)", function () {
	this.timeout(30000);
	let s: Server | undefined;

	afterEach(() => {
		stop(s);
		s = undefined;
	});

	it("editing a mention file on disk refreshes what it produces", async () => {
		s = await start({ "Svc.cls": SVC, "Caller.cls": caller(), "Maker.cls": maker(false), "UsesMake.cls": USES, "Other.cls": OTHER });
		// Maker.make() returns Other: UsesMake.run() is not a reference (and Maker's scan is now cached).
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"], "warm: same answer");
		await editOnDisk(s, "Maker.cls", maker(true));
		assert.deepStrictEqual(await runRefs(s), ["Caller:3", "UsesMake:2"], "the edited Maker now produces Svc");
		await editOnDisk(s, "Maker.cls", maker(false));
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"], "and stops again");
	});

	it("an unsaved buffer overrides the disk copy of a mention file", async () => {
		s = await start({ "Svc.cls": SVC, "Caller.cls": caller(), "Maker.cls": maker(false), "UsesMake.cls": USES, "Other.cls": OTHER });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
		const uri = uriOf(s, `${CLS}/Maker.cls`);
		await s.conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "apex", version: 1, text: maker(true) } });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3", "UsesMake:2"], "buffer says Svc");
		await s.conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: maker(false) }] });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"], "next buffer version says Other");
		await s.conn.sendNotification("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: maker(true) }] });
		await s.conn.sendNotification("textDocument/didClose", { textDocument: { uri } });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"], "closed again: the disk copy (Other) wins");
	});

	it("a file reaching Svc only through a producer is re-judged after it changes (memoized receiver tokens)", async () => {
		const plain = "public class UsesMake {\n    void go() {\n        Integer make = 1;\n        Other o = null;\n        o.run();\n    }\n}\n";
		s = await start({ "Svc.cls": SVC, "Caller.cls": caller(), "Maker.cls": maker(true), "UsesMake.cls": plain, "Other.cls": OTHER });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"], "warm");
		await editOnDisk(s, "UsesMake.cls", USES);
		assert.deepStrictEqual(await runRefs(s), ["Caller:3", "UsesMake:2"]);
		await editOnDisk(s, "UsesMake.cls", plain);
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
	});

	it("a method body edited on disk is re-read (partial parses are keyed by file version)", async () => {
		s = await start({ "Svc.cls": SVC, "Caller.cls": caller(), "Other.cls": OTHER });
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
		await editOnDisk(s, "Caller.cls", caller("\n        Other o = new Other();\n        o.run();\n        s.run();"));
		assert.deepStrictEqual(await runRefs(s), ["Caller:3", "Caller:6"], "the new s.run() is found, o.run() is not");
		await editOnDisk(s, "Caller.cls", caller());
		assert.deepStrictEqual(await runRefs(s), ["Caller:3"]);
	});
});
