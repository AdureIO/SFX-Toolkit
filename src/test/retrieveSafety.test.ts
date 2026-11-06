import * as assert from "assert";
import * as path from "path";
import { affectedFiles, groupByComponent, isSameOrUnder, overwriteMessage, parsePorcelain } from "../utils/retrieveSafetyPure";
import {
	MAX_COMMAND_CHARS,
	chunkComponents,
	chunkPaths,
	cliErrorMessage,
	outcomeFromFiles,
	parseCliJson,
	parseRetrieveJson,
} from "../utils/retrieveEnginePure";
import {
	flushRetrieveLog,
	getLastRetrieve,
	getRetrieveTimes,
	initRetrieveLog,
	recordRetrieved,
	resetRetrieveLogForTests,
	retrieveLogKey,
} from "../utils/retrieveLog";

describe("retrieveSafetyPure: porcelain parsing", () => {
	it("parses modified, added, deleted, untracked and conflicted entries", () => {
		const out = [" M force-app/main/default/classes/Foo.cls", "A  force-app/new.txt", " D gone.txt", "?? untracked/file.js", "UU conflict.cls", ""].join("\n");
		assert.deepStrictEqual(parsePorcelain(out), ["force-app/main/default/classes/Foo.cls", "force-app/new.txt", "gone.txt", "untracked/file.js", "conflict.cls"]);
	});

	it("returns both sides of a rename and ignores the branch header", () => {
		assert.deepStrictEqual(parsePorcelain("## main...origin/main\nR  old/name.cls -> new/name.cls\n"), ["old/name.cls", "new/name.cls"]);
	});

	it("unquotes paths with spaces, escapes and octal-encoded UTF-8", () => {
		assert.deepStrictEqual(parsePorcelain('?? "layouts/Account-Account Layout.layout-meta.xml"\n?? "a\\"b\\\\c\\td"\n?? "caf\\303\\251.txt"\n'), [
			"layouts/Account-Account Layout.layout-meta.xml",
			'a"b\\c\td',
			"café.txt",
		]);
	});

	it("handles CRLF output and empty output", () => {
		assert.deepStrictEqual(parsePorcelain(" M a.txt\r\n M b.txt\r\n"), ["a.txt", "b.txt"]);
		assert.deepStrictEqual(parsePorcelain(""), []);
	});
});

describe("retrieveSafetyPure: path matching", () => {
	const root = path.join(path.sep, "repo");
	const p = (...s: string[]) => path.join(root, ...s);

	it("matches a file, a folder and files under it, but not siblings with a shared prefix", () => {
		assert.ok(isSameOrUnder(p("a", "Foo.cls"), p("a", "Foo.cls")));
		assert.ok(isSameOrUnder(p("lwc", "cmp"), p("lwc", "cmp", "cmp.js")));
		assert.ok(isSameOrUnder(p("lwc", "cmp") + path.sep, p("lwc", "cmp", "x", "y.js")));
		assert.ok(!isSameOrUnder(p("lwc", "cmp"), p("lwc", "cmp2", "cmp2.js")));
		assert.ok(!isSameOrUnder(p("a", "Foo.cls"), p("a", "Foo.cls-meta.xml")));
	});

	it("returns only the dirty files a retrieve of the targets would overwrite (deduplicated)", () => {
		const targets = [p("classes", "Foo.cls"), p("lwc", "cmp")];
		const dirty = [p("classes", "Foo.cls"), p("classes", "Bar.cls"), p("lwc", "cmp", "cmp.js"), p("lwc", "cmp", "cmp.html"), p("lwc", "cmp", "cmp.js"), p("lwc", "other", "o.js")];
		assert.deepStrictEqual(affectedFiles(targets, dirty), [p("classes", "Foo.cls"), p("lwc", "cmp", "cmp.js"), p("lwc", "cmp", "cmp.html")]);
		assert.deepStrictEqual(affectedFiles([], dirty), []);
		assert.deepStrictEqual(affectedFiles(targets, []), []);
	});

	it("builds the confirmation text with counts and the first five component names", () => {
		const few = overwriteMessage("Retrieve", [p("a", "One.cls"), p("a", "Two.cls")]);
		assert.strictEqual(few, "Retrieve will overwrite 2 files in 2 components with local changes: One, Two");
		const many = overwriteMessage("Retrieve", Array.from({ length: 7 }, (_, i) => p("a", `F${i}.cls`)));
		assert.strictEqual(many, "Retrieve will overwrite 7 files in 7 components with local changes: F0, F1, F2, F3, F4…");
		assert.strictEqual(overwriteMessage("Retrieve", [p("a", "One.cls")]), "Retrieve will overwrite 1 file in 1 component with local changes: One");
	});

	it("groups .cls and .cls-meta.xml into one component", () => {
		const files = [p("classes", "Foo.cls"), p("classes", "Foo.cls-meta.xml"), p("classes", "Bar.cls"), p("classes", "Bar.cls-meta.xml"), p("triggers", "T.trigger")];
		assert.deepStrictEqual(groupByComponent(files).map((g) => [g.name, g.files]), [["Foo", 2], ["Bar", 2], ["T", 1]]);
		assert.strictEqual(overwriteMessage("Retrieve", files), "Retrieve will overwrite 5 files in 3 components with local changes: Foo, Bar, T");
	});

	it("groups bundles by folder and names object children Obj.Child", () => {
		const files = [
			p("main", "default", "lwc", "myCmp", "myCmp.js"),
			p("main", "default", "lwc", "myCmp", "myCmp.html"),
			p("main", "default", "objects", "Account", "Account.object-meta.xml"),
			p("main", "default", "objects", "Account", "fields", "Region__c.field-meta.xml"),
		];
		assert.deepStrictEqual(groupByComponent(files).map((g) => [g.name, g.files]), [["myCmp", 2], ["Account", 1], ["Account.Region__c", 1]]);
	});
});

describe("retrieveEngine: chunking", () => {
	it("keeps every chunk under the character budget and preserves order", () => {
		const comps = Array.from({ length: 1000 }, (_, i) => ({ type: "ApexClass", fullName: `Some_Long_Class_Name_Number_${i}` }));
		const chunks = chunkComponents(comps, 5000);
		assert.ok(chunks.length > 5);
		assert.deepStrictEqual(chunks.flat(), comps);
		for (const c of chunks) {
			const len = c.reduce((n, x) => n + `-m "${x.type}:${x.fullName}" `.length, 0);
			assert.ok(len <= 5000, `chunk of ${len} chars`);
		}
	});

	it("puts a single oversized component alone and returns [] for nothing", () => {
		const big = { type: "X", fullName: "n".repeat(100) };
		assert.deepStrictEqual(chunkComponents([big], 10), [[big]]);
		assert.deepStrictEqual(chunkComponents([]), []);
	});

	it("defaults to a < 30k budget and chunks paths too", () => {
		assert.ok(MAX_COMMAND_CHARS <= 30000);
		const comps = Array.from({ length: 5000 }, (_, i) => ({ type: "ApexClass", fullName: `Class${i}_${"x".repeat(20)}` }));
		const chunks = chunkComponents(comps);
		assert.ok(chunks.length >= 2);
		assert.deepStrictEqual(chunks.flat().length, 5000);
		assert.deepStrictEqual(chunkPaths(["a", "b", "c"], 14), [["a", "b"], ["c"]]);
	});
});

describe("retrieveEngine: result parsing", () => {
	const ok = (type: string, fullName: string, filePath: string, state = "Changed") => ({ type, fullName, filePath, state });

	it("collects retrieved components once per component, preferring the content file", () => {
		const out = parseRetrieveJson(
			JSON.stringify({
				status: 0,
				result: {
					files: [ok("ApexClass", "Foo", "force-app/classes/Foo.cls-meta.xml", "Created"), ok("ApexClass", "Foo", "force-app/classes/Foo.cls", "Created"), ok("Flow", "F", "force-app/flows/F.flow-meta.xml", "Unchanged")],
				},
			}),
			[{ type: "ApexClass", fullName: "Foo" }, { type: "Flow", fullName: "F" }]
		)!;
		assert.deepStrictEqual(out.retrieved, [
			{ type: "ApexClass", fullName: "Foo", filePath: "force-app/classes/Foo.cls" },
			{ type: "Flow", fullName: "F", filePath: "force-app/flows/F.flow-meta.xml" },
		]);
		assert.deepStrictEqual(out.failed, []);
	});

	it("reports partial failures with their error, and a component with a failed file as failed", () => {
		const out = parseRetrieveJson(
			JSON.stringify({
				status: 1,
				result: {
					files: [
						ok("ApexClass", "Good", "classes/Good.cls"),
						{ type: "ApexClass", fullName: "Bad", state: "Failed", error: "Entity of type 'ApexClass' named 'Bad' cannot be found", problemType: "Error" },
						ok("CustomObject", "Half", "objects/Half/Half.object-meta.xml"),
						{ type: "CustomObject", fullName: "Half", state: "Failed", error: "partial" },
					],
				},
			})
		)!;
		assert.deepStrictEqual(out.retrieved.map((r) => r.fullName), ["Good"]);
		assert.deepStrictEqual(out.failed, [
			{ type: "ApexClass", fullName: "Bad", error: "Entity of type 'ApexClass' named 'Bad' cannot be found" },
			{ type: "CustomObject", fullName: "Half", error: "partial" },
		]);
	});

	it("surfaces a managed component that cannot be retrieved with the API error", () => {
		const msg = "You can't retrieve this component because it belongs to a managed package (abc).";
		const out = parseRetrieveJson(JSON.stringify({ status: 1, result: { files: [{ type: "ApexClass", fullName: "abc__Locked", state: "Failed", error: msg, problemType: "Error" }] } }))!;
		assert.strictEqual(out.retrieved.length, 0);
		assert.strictEqual(out.failed[0].error, msg);
	});

	it("marks requested components the org did not return, but not wildcards", () => {
		const out = parseRetrieveJson(JSON.stringify({ result: { files: [ok("Flow", "A", "flows/A.flow-meta.xml")] } }), [
			{ type: "Flow", fullName: "A" },
			{ type: "Flow", fullName: "Missing" },
			{ type: "ApexClass", fullName: "*" },
		])!;
		assert.deepStrictEqual(out.failed.map((f) => f.fullName), ["Missing"]);
		assert.match(out.failed[0].error, /Not returned/);
	});

	it("tolerates shell noise around the JSON and returns null for unparsable output", () => {
		const noisy = `Welcome to zsh\n${JSON.stringify({ result: { files: [ok("Flow", "A", "a")] } })}\nbye`;
		assert.strictEqual(parseRetrieveJson(noisy)!.retrieved.length, 1);
		assert.strictEqual(parseRetrieveJson("not json"), null);
		assert.strictEqual(parseRetrieveJson(JSON.stringify({ status: 1, message: "boom" })), null);
		assert.strictEqual(parseRetrieveJson(""), null);
	});

	it("extracts the CLI's error message", () => {
		assert.strictEqual(cliErrorMessage(parseCliJson('{"status":1,"message":" No org "}'), "raw"), "No org");
		assert.strictEqual(cliErrorMessage(null, "  raw text "), "raw text");
		assert.strictEqual(cliErrorMessage(null, ""), "Retrieve failed");
		assert.deepStrictEqual(outcomeFromFiles([]), { retrieved: [], failed: [] });
	});
});

describe("retrieveLog", () => {
	class Memento {
		store = new Map<string, unknown>();
		updates = 0;
		get<T>(k: string, d: T): T {
			return (this.store.has(k) ? this.store.get(k) : d) as T;
		}
		update(k: string, v: unknown) {
			this.updates++;
			this.store.set(k, JSON.parse(JSON.stringify(v)));
		}
	}
	const keyOf = (org: string | null) => (org ?? "__default__").toLowerCase();
	afterEach(() => resetRetrieveLogForTests());

	it("keys by canonical org + type:fullName and stores ISO times", () => {
		const m = new Memento();
		initRetrieveLog(m, keyOf);
		assert.strictEqual(retrieveLogKey("Me@X.com", "ApexClass", "Foo"), "me@x.com|ApexClass:Foo");
		const at = new Date("2025-05-05T05:05:05.000Z");
		recordRetrieved("Me@X.com", [{ type: "ApexClass", fullName: "Foo" }], at);
		assert.strictEqual(getLastRetrieve("me@x.com", "ApexClass", "Foo"), at.toISOString());
		assert.strictEqual(getLastRetrieve("other@x.com", "ApexClass", "Foo"), undefined);
		flushRetrieveLog();
		assert.deepStrictEqual(m.store.get("adure-sfx-toolkit.retrieveLog"), { "me@x.com|ApexClass:Foo": at.toISOString() });
	});

	it("returns per-org times as epoch ms and survives a restart", () => {
		const m = new Memento();
		initRetrieveLog(m, keyOf);
		recordRetrieved("a", [{ type: "Flow", fullName: "F" }, { type: "Layout", fullName: "Account-Account Layout" }], new Date(1000));
		recordRetrieved("b", [{ type: "Flow", fullName: "F" }], new Date(2000));
		flushRetrieveLog();
		resetRetrieveLogForTests();
		initRetrieveLog(m, keyOf);
		assert.deepStrictEqual(getRetrieveTimes("a"), { "Flow:F": 1000, "Layout:Account-Account Layout": 1000 });
		assert.deepStrictEqual(getRetrieveTimes("b"), { "Flow:F": 2000 });
		assert.deepStrictEqual(getRetrieveTimes("c"), {});
	});

	it("is a no-op for an empty list", () => {
		const m = new Memento();
		initRetrieveLog(m, keyOf);
		recordRetrieved("a", []);
		flushRetrieveLog();
		assert.deepStrictEqual(m.store.get("adure-sfx-toolkit.retrieveLog"), {});
	});
});
