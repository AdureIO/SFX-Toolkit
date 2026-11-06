/**
 * Parse-free Apex outline (server/src/apexOutline.ts), loaded like parseWorkerPool.test.ts
 * (the server sources are outside the tsc project). It feeds producer detection for Find
 * References and the partial parses, so it must (a) report every member the parser would,
 * (b) find every method / constructor body, and (c) refuse files it does not understand.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";

let dir: string;
let mod: { outlineOf(code: string): any; elideBodies(text: string, bodies: any[]): string };

/** Comments / string contents blanked, offsets preserved (what the server feeds the outline). */
const blank = (t: string) =>
	t
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
		.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
		.replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${" ".repeat(m.length - 2)}'`);

const members = (t: string) => mod.outlineOf(blank(t)).members.map((m: any) => `${m.name}:${m.type.replace(/\s+/g, "")}`);

describe("apex outline", () => {
	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-outline-"));
		const src = path.join(__dirname, "..", "..", "server", "src", "apexOutline.ts");
		const out = ts.transpileModule(fs.readFileSync(src, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
		fs.writeFileSync(path.join(dir, "apexOutline.js"), out.outputText);
		mod = require(path.join(dir, "apexOutline.js"));
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reads fields, properties and methods with their declared types", () => {
		const t = `@IsTest(SeeAllData=true)
public with sharing class Outer {
    private static final Map<String, List<Svc>> CACHE = new Map<String, List<Svc>>{ 'a' => new List<Svc>() };
    public Svc svc { get; set; }
    @AuraEnabled(cacheable=true) public static List<Svc> items() { return null; }
    Svc a, b;
    public Outer(Integer i) { this.svc = null; }
    abstract Svc make();
    public class Inner { public Svc deep; public Svc get() { return null; } }
    public enum Level { LOW, HIGH }
    static { Integer x = 1; }
    // Svc ghost;
    String s = 'Svc fake;';
}`;
		assert.deepStrictEqual(members(t).sort(), [
			"CACHE:Map<String,List<Svc>>",
			"a:Svc",
			"b:Svc",
			"deep:Svc",
			"get:Svc",
			"items:List<Svc>",
			"make:Svc",
			"s:String",
			"svc:Svc",
		]);
	});

	it("finds method and constructor bodies (not property accessors or initializers)", () => {
		const t = `public class A {
    public Integer p { get { return 1; } set; }
    public A() { }
    public void m(Integer x) { if (x > 0) { x++; } }
    public List<String> l = new List<String>{ 'x' };
    public class B { void n() { } }
}`;
		const o = mod.outlineOf(blank(t));
		assert.ok(o.ok);
		assert.deepStrictEqual(o.bodies.map((b: any) => t.slice(b.head, b.open).trim().replace(/\s+/g, " ")), ["public A()", "public void m(Integer x)", "void n()"]);
		for (const b of o.bodies) {
			assert.strictEqual(t[b.open], "{");
			assert.strictEqual(t[b.close], "}");
		}
	});

	it("refuses what it does not understand (triggers, unbalanced braces)", () => {
		assert.strictEqual(mod.outlineOf(blank("trigger T on Account (before insert) { Integer i = 1; }")).ok, false);
		assert.strictEqual(mod.outlineOf(blank("public class A { void m() { ")).ok, false);
		assert.strictEqual(mod.outlineOf(blank("public class A { } }")).ok, false);
	});

	it("elideBodies blanks the interior only: same length, same line breaks", () => {
		const t = "public class A {\n    void m() {\n        Svc s;\n        s.run();\n    }\n    void n() { }\n}\n";
		const o = mod.outlineOf(blank(t));
		const e = mod.elideBodies(t, [o.bodies[0]]);
		assert.strictEqual(e.length, t.length);
		assert.strictEqual(e.split("\n").length, t.split("\n").length);
		assert.ok(!e.includes("s.run"));
		assert.ok(e.includes("void m() {") && e.includes("void n() { }"));
		assert.strictEqual(mod.elideBodies(t, []), t);
	});
});
