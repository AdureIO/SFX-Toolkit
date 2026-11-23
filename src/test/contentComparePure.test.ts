import * as assert from "assert";
import * as path from "path";
import {
	compareDigests,
	digestContent,
	groupByComponent,
	hashDigests,
	innerFilesOfEntry,
	needsCompare,
	nextEntry,
	normalizeText,
	orgCopyDirName,
	requestNameOf,
	verifiedSyncAt,
} from "../utils/contentComparePure";
import { buildTypeTable, typeFolderInnerPath } from "../utils/orgBrowser/localIndex";

const table = buildTypeTable();

describe("content compare: normalization", () => {
	it("CRLF → LF, trailing whitespace per line stripped, trailing newlines trimmed", () => {
		assert.strictEqual(normalizeText("a  \r\nb\t\r\n\r\n\r\n"), "a\nb");
		assert.strictEqual(normalizeText("a\nb"), "a\nb");
		assert.strictEqual(normalizeText("  a\n"), "  a"); // leading whitespace is content
	});
	it("equal after normalization → equal digest; real changes differ", () => {
		const d = (s: string) => digestContent(Buffer.from(s));
		assert.strictEqual(d("<a>\r\n  <b/>  \r\n</a>\r\n"), d("<a>\n  <b/>\n</a>"));
		assert.notStrictEqual(d("<a>x</a>"), d("<a>y</a>"));
	});
	it("binary content is compared byte for byte", () => {
		const a = Buffer.from([0, 1, 2, 13, 10]);
		const b = Buffer.from([0, 1, 2, 10]);
		assert.notStrictEqual(digestContent(a), digestContent(b));
		assert.strictEqual(digestContent(a), digestContent(Buffer.from(a)));
	});
});

describe("content compare: comparing the files of a component", () => {
	const m = (o: Record<string, string>) => new Map(Object.entries(o));
	it("same files and digests → same", () => {
		assert.strictEqual(compareDigests(m({ "A.cls": "1", "A.cls-meta.xml": "2" }), m({ "A.cls-meta.xml": "2", "A.cls": "1" })), "same");
	});
	it("a changed file, a local-only extra file or an org-only file of the same component → different", () => {
		assert.strictEqual(compareDigests(m({ a: "1" }), m({ a: "2" })), "different");
		assert.strictEqual(compareDigests(m({ a: "1", b: "1" }), m({ a: "1" })), "different");
		assert.strictEqual(compareDigests(m({ a: "1" }), m({ a: "1", b: "1" })), "different");
	});
	it("the hash does not depend on the order of the files", () => {
		assert.strictEqual(hashDigests(m({ a: "1", b: "2" })), hashDigests(m({ b: "2", a: "1" })));
		assert.notStrictEqual(hashDigests(m({ a: "1", b: "2" })), hashDigests(m({ a: "1", b: "3" })));
	});
});

describe("content compare: file mapping", () => {
	it("inner path = the path inside the type folder", () => {
		assert.strictEqual(typeFolderInnerPath("classes/Foo.cls", table), "Foo.cls");
		assert.strictEqual(typeFolderInnerPath("main/default/classes/Foo.cls-meta.xml", table), "Foo.cls-meta.xml");
		assert.strictEqual(typeFolderInnerPath("objects/Account/fields/X__c.field-meta.xml", table), "Account/fields/X__c.field-meta.xml");
		assert.strictEqual(typeFolderInnerPath("lwc/foo/foo.js", table), "foo/foo.js");
		assert.strictEqual(typeFolderInnerPath("README.md", table), null);
	});

	it("retrieved files of a decomposed object are grouped per component; only each component's own files are in its group", () => {
		const files = [
			"objects/Account/Account.object-meta.xml",
			"objects/Account/fields/Foo__c.field-meta.xml",
			"objects/Account/fields/Bar__c.field-meta.xml",
			"objects/Account/recordTypes/RT.recordType-meta.xml",
			"classes/Foo.cls",
			"classes/Foo.cls-meta.xml",
			"lwc/cmp/cmp.js",
			"lwc/cmp/cmp.html",
			"lwc/cmp/cmp.js-meta.xml",
			"sfdx-project.json",
		].map((rel) => ({ rel }));
		const g = groupByComponent(files, table);
		assert.deepStrictEqual([...g.get("CustomObject:Account")!.keys()], ["Account/Account.object-meta.xml"]);
		assert.deepStrictEqual([...g.get("CustomField:Account.Foo__c")!.keys()], ["Account/fields/Foo__c.field-meta.xml"]);
		assert.deepStrictEqual([...g.get("CustomField:Account.Bar__c")!.keys()], ["Account/fields/Bar__c.field-meta.xml"]);
		assert.deepStrictEqual([...g.get("RecordType:Account.RT")!.keys()], ["Account/recordTypes/RT.recordType-meta.xml"]);
		assert.deepStrictEqual([...g.get("ApexClass:Foo")!.keys()].sort(), ["Foo.cls", "Foo.cls-meta.xml"]);
		assert.deepStrictEqual([...g.get("LightningComponentBundle:cmp")!.keys()].sort(), ["cmp/cmp.html", "cmp/cmp.js", "cmp/cmp.js-meta.xml"]);
		assert.strictEqual(g.size, 6);
	});

	it("percent-encoded file names match their decoded org name", () => {
		const g = groupByComponent([{ rel: "layouts/Account-Account%20Layout.layout-meta.xml" }], table);
		assert.ok(g.has("Layout:Account-Account Layout"));
		assert.strictEqual(requestNameOf("Layout", "Account-Account%20Layout"), "Account-Account Layout");
	});

	it("local entry files get the same inner paths as the retrieved ones", () => {
		const pkg = path.resolve("/p/force-app/main/default");
		const entry = {
			type: "CustomField",
			name: "Account.Foo__c",
			key: "CustomField:Account.Foo__c",
			files: [path.join(pkg, "objects", "Account", "fields", "Foo__c.field-meta.xml")],
			primary: "",
		};
		assert.deepStrictEqual(innerFilesOfEntry(entry, [pkg], table).map((f) => f.inner), ["Account/fields/Foo__c.field-meta.xml"]);
		assert.deepStrictEqual(innerFilesOfEntry(entry, [path.resolve("/other")], table), []);
	});
});

describe("content compare: index", () => {
	it("a component needs a compare when never compared, or its org time or local hash changed", () => {
		const e = nextEntry(undefined, 100, "h1", "same", 1000);
		assert.strictEqual(needsCompare(undefined, 100, "h1"), true);
		assert.strictEqual(needsCompare(e, 100, "h1"), false);
		assert.strictEqual(needsCompare(e, 101, "h1"), true);
		assert.strictEqual(needsCompare(e, 100, "h2"), true);
	});
	it("a same result is the verified sync time; a later different keeps the last same time as baseline", () => {
		const same = nextEntry(undefined, 100, "h1", "same", 1000);
		assert.strictEqual(verifiedSyncAt(same), 1000);
		const diff = nextEntry(same, 200, "h1", "different", 2000);
		assert.strictEqual(diff.result, "different");
		assert.strictEqual(verifiedSyncAt(diff), 1000);
		assert.strictEqual(verifiedSyncAt(nextEntry(undefined, 1, "h", "different", 5)), undefined);
		assert.strictEqual(verifiedSyncAt(nextEntry(diff, 200, "h1", "same", 3000)), 3000);
	});
});

describe("content compare: org copy directory names", () => {
	it("is filesystem-safe: no separators, no reserved characters, bounded", () => {
		const n = orgCopyDirName("Layout:Account-Account Layout");
		assert.ok(/^[A-Za-z0-9._-]+$/.test(n), n);
		const long = orgCopyDirName("ApexClass:" + "x".repeat(300));
		assert.ok(long.length <= 72, String(long.length));
		assert.ok(!orgCopyDirName("Report:Folder/Sub/My: Report?*").match(/[\\/:*?"<>|\s]/));
		assert.ok(!orgCopyDirName("ApexClass:..").startsWith("."));
	});
	it("is collision-free where the readable part collides", () => {
		assert.notStrictEqual(orgCopyDirName("Report:A/B"), orgCopyDirName("Report:A_B"));
		assert.notStrictEqual(orgCopyDirName("ApexClass:Foo"), orgCopyDirName("ApexClass:foo"));
		assert.notStrictEqual(orgCopyDirName("Layout:A B"), orgCopyDirName("Layout:A-B"));
	});
	it("both spellings of a key (percent-encoded local name, org name) are the same copy", () => {
		assert.strictEqual(orgCopyDirName("Layout:Account-Account%20Layout"), orgCopyDirName("Layout:Account-Account Layout"));
	});
});
