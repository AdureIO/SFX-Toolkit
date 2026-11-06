import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	FOLDER_TYPES,
	ListCancelled,
	ListingCache,
	batchQueries,
	buildEnvelope,
	cacheFilePath,
	expandTypes,
	faultMessage,
	listOperation,
	listOrgMetadata,
	loadListingCache,
	mergeTypeRefresh,
	parseDescribe,
	parseListResponse,
	saveListingCache,
} from "../utils/orgBrowser/metadataLister";
import { setupTarget } from "../utils/orgBrowser/setupUrl";
import { Comp } from "../utils/orgBrowser/types";

const envelope = (inner: string) =>
	`<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;

const obj = (xmlName: string, dir: string, suffix: string, o: { inFolder?: boolean; metaFile?: boolean; children?: string[] } = {}) =>
	`<metadataObjects>${(o.children ?? []).map((c) => `<childXmlNames>${c}</childXmlNames>`).join("")}<directoryName>${dir}</directoryName><inFolder>${!!o.inFolder}</inFolder><metaFile>${!!o.metaFile}</metaFile>${suffix ? `<suffix>${suffix}</suffix>` : ""}<xmlName>${xmlName}</xmlName></metadataObjects>`;

const DESCRIBE_XML = envelope(
	`<describeMetadataResponse><result>` +
		obj("ApexClass", "classes", "cls", { metaFile: true }) +
		obj("CustomObject", "objects", "object", { children: ["CustomField", "ValidationRule", "RecordType"] }) +
		obj("Flow", "flows", "flow") +
		obj("Report", "reports", "report", { inFolder: true }) +
		obj("EmailTemplate", "email", "email", { inFolder: true, metaFile: true }) +
		obj("Broken", "broken", "brk") +
		`<organizationNamespace></organizationNamespace><partialSaveAllowed>true</partialSaveAllowed><testRequired>false</testRequired></result></describeMetadataResponse>`
);

const item = (type: string, fullName: string, extra: Record<string, string> = {}) => {
	const f: Record<string, string> = {
		createdById: "005000000000001AAA",
		createdByName: "Creator",
		createdDate: "2024-01-01T00:00:00.000Z",
		fileName: `x/${fullName}`,
		fullName,
		id: "01p000000000001AAA",
		lastModifiedById: "005000000000002AAA",
		lastModifiedByName: "Jane Doe",
		lastModifiedDate: "2024-03-02T10:30:00.000Z",
		manageableState: "unmanaged",
		namespacePrefix: "",
		type,
		...extra,
	};
	return `<result>${Object.entries(f)
		.map(([k, v]) => (v === "" ? `<${k} xsi:nil="true"/>` : `<${k}>${v}</${k}>`))
		.join("")}</result>`;
};

/** Fake org: serves describe + listMetadata from a per-key table; records every call. */
class FakeOrg {
	calls: { queries: { type: string; folder?: string }[] }[] = [];
	describeCalls = 0;
	data = new Map<string, string[]>(); // "Type" or "Type|folder" -> <result> items
	failing = new Set<string>(); // Types whose query faults
	fatal: Error | null = null;

	call = async (op: string): Promise<string> => {
		if (op.includes("<met:describeMetadata>")) {
			this.describeCalls++;
			return DESCRIBE_XML;
		}
		const queries = [...op.matchAll(/<met:queries>([\s\S]*?)<\/met:queries>/g)].map((m) => ({
			type: /<met:type>([^<]*)<\/met:type>/.exec(m[1])![1],
			folder: /<met:folder>([^<]*)<\/met:folder>/.exec(m[1])?.[1].replace(/&amp;/g, "&"),
		}));
		this.calls.push({ queries });
		if (this.fatal) throw this.fatal;
		const bad = queries.find((q) => this.failing.has(q.type));
		if (bad) throw new Error(`HTTP 500: INVALID_TYPE: Cannot use: ${bad.type} in this version`);
		const out: string[] = [];
		for (const q of queries) out.push(...(this.data.get(q.folder !== undefined ? `${q.type}|${q.folder}` : q.type) ?? []));
		return envelope(`<listMetadataResponse>${out.join("")}</listMetadataResponse>`);
	};
}

function fakeWithData(): FakeOrg {
	const o = new FakeOrg();
	o.data.set("ApexClass", [item("ApexClass", "Alpha"), item("ApexClass", "Beta", { namespacePrefix: "abc", manageableState: "installed" })]);
	o.data.set("CustomObject", [item("CustomObject", "Account"), item("CustomObject", "Foo__c")]);
	o.data.set("CustomField", [item("CustomField", "Account.Region__c", { id: "00N000000000001AAA" })]);
	o.data.set("Flow", [item("Flow", "Case_Router")]);
	o.data.set("ReportFolder", [item("ReportFolder", "Sales"), item("ReportFolder", "Ops")]);
	o.data.set("Report|Sales", [item("Report", "Sales/Pipeline")]);
	o.data.set("Report|Ops", [item("Report", "Ops/Backlog"), item("Report", "Ops/Cases")]);
	o.data.set("Report|unfiled$public", [item("Report", "unfiled$public/Misc")]);
	o.data.set("EmailFolder", [item("EmailFolder", "Welcome")]);
	o.data.set("EmailTemplate|Welcome", [item("EmailTemplate", "Welcome/Hello")]);
	return o;
}

describe("orgBrowser lister: XML", () => {
	it("builds an envelope with the session header and escapes it", () => {
		const xml = buildEnvelope("abc<&>", "<met:x/>");
		assert.ok(xml.includes("<met:sessionId>abc&lt;&amp;&gt;</met:sessionId>"));
		assert.ok(xml.includes("<soapenv:Body><met:x/></soapenv:Body>"));
	});

	it("parses describeMetadata incl. childXmlNames, inFolder, metaFile", () => {
		const types = parseDescribe(DESCRIBE_XML);
		assert.deepStrictEqual(types.map((t) => t.name), ["ApexClass", "CustomObject", "Flow", "Report", "EmailTemplate", "Broken"]);
		const co = types.find((t) => t.name === "CustomObject")!;
		assert.deepStrictEqual(co.children, ["CustomField", "ValidationRule", "RecordType"]);
		assert.strictEqual(co.dir, "objects");
		assert.strictEqual(co.suffix, "object");
		assert.strictEqual(types.find((t) => t.name === "Report")!.inFolder, true);
		assert.strictEqual(types.find((t) => t.name === "ApexClass")!.metaFile, true);
	});

	it("expands child types as listable types with their parent", () => {
		const all = expandTypes(parseDescribe(DESCRIBE_XML));
		const cf = all.find((t) => t.name === "CustomField")!;
		assert.strictEqual(cf.parent, "CustomObject");
		assert.strictEqual(all.filter((t) => t.name === "CustomField").length, 1);
	});

	it("parses listMetadata results into compact components", () => {
		const comps = parseListResponse(envelope(`<listMetadataResponse>${item("ApexClass", "Beta", { namespacePrefix: "abc", manageableState: "installed" })}${item("Flow", "123")}</listMetadataResponse>`));
		assert.strictEqual(comps.length, 2);
		assert.deepStrictEqual(comps[0], {
			t: "ApexClass",
			n: "Beta",
			ns: "abc",
			ms: "installed",
			by: "Jane Doe",
			bi: "005000000000002AAA",
			lm: Date.parse("2024-03-02T10:30:00.000Z"),
			cd: Date.parse("2024-01-01T00:00:00.000Z"),
			id: "01p000000000001AAA",
			f: "x/Beta",
		});
		assert.strictEqual(comps[1].n, "123"); // numeric-looking names stay strings
		assert.strictEqual(comps[1].ns, "");
	});

	it("returns [] for an empty listMetadata response and decodes entities", () => {
		assert.deepStrictEqual(parseListResponse(envelope("<listMetadataResponse/>")), []);
		const c = parseListResponse(envelope(`<listMetadataResponse>${item("Layout", "Account-Account &amp; Co")}</listMetadataResponse>`));
		assert.strictEqual(c[0].n, "Account-Account & Co");
	});

	it("extracts SOAP faults, also from truncated bodies", () => {
		const fault = `<soapenv:Fault><faultcode>sf:INVALID_TYPE</faultcode><faultstring>INVALID_TYPE: Cannot use: X</faultstring></soapenv:Fault>`;
		assert.strictEqual(faultMessage(fault), "INVALID_TYPE: Cannot use: X");
		assert.strictEqual(faultMessage("HTTP 500: <faultstring>INVALID_SESSION_ID: Invalid Session ID fo"), "INVALID_SESSION_ID: Invalid Session ID fo");
		assert.strictEqual(faultMessage("<ok/>"), null);
		assert.throws(() => parseListResponse(envelope(fault)), /INVALID_TYPE/);
	});

	it("batches queries by 3 and builds the listMetadata operation", () => {
		assert.deepStrictEqual(batchQueries([1, 2, 3, 4, 5, 6, 7]), [[1, 2, 3], [4, 5, 6], [7]]);
		const op = listOperation([{ type: "Report", folder: "A&B" }, { type: "Flow" }], "67.0");
		assert.ok(op.includes("<met:folder>A&amp;B</met:folder><met:type>Report</met:type>"));
		assert.ok(op.includes("<met:asOfVersion>67.0</met:asOfVersion>"));
	});
});

describe("orgBrowser lister: listing", () => {
	it("lists everything in <=3-query calls and streams batches with progress", async () => {
		const org = fakeWithData();
		const seen: { n: number; done: number; total: number }[] = [];
		const res = await listOrgMetadata({
			call: org.call,
			apiVersion: "67.0",
			onBatch: (comps, p) => seen.push({ n: comps.length, done: p.done, total: p.total }),
		});
		assert.ok(org.calls.length > 0);
		assert.ok(org.calls.every((c) => c.queries.length >= 1 && c.queries.length <= 3), "every call has 1..3 queries");
		assert.strictEqual(org.describeCalls, 1);
		const keys = res.comps.map((c) => `${c.t}:${c.n}`).sort();
		assert.deepStrictEqual(keys, [
			"ApexClass:Alpha",
			"ApexClass:Beta",
			"CustomField:Account.Region__c",
			"CustomObject:Account",
			"CustomObject:Foo__c",
			"EmailFolder:Welcome",
			"EmailTemplate:Welcome/Hello",
			"Flow:Case_Router",
			"Report:Ops/Backlog",
			"Report:Ops/Cases",
			"Report:Sales/Pipeline",
			"Report:unfiled$public/Misc",
			"ReportFolder:Ops",
			"ReportFolder:Sales",
		]);
		// Progress ends at total and total counts types (not folder queries).
		const last = seen[seen.length - 1];
		assert.strictEqual(last.done, last.total);
		assert.ok(last.total >= 8); // ApexClass, CustomObject, CustomField, ValidationRule, RecordType, Flow, Report, EmailTemplate, Broken
		assert.ok(seen.every((s) => s.done <= s.total));
		assert.deepStrictEqual(res.failures, []);
	});

	it("expands folder types: lists folders first, then content per folder (+ unfiled$public)", async () => {
		const org = fakeWithData();
		await listOrgMetadata({ call: org.call, apiVersion: "67.0" });
		const flat = org.calls.flatMap((c) => c.queries);
		const idxFolderList = flat.findIndex((q) => q.type === "ReportFolder");
		const contentQueries = flat.filter((q) => q.type === "Report");
		assert.ok(idxFolderList >= 0);
		assert.deepStrictEqual(contentQueries.map((q) => q.folder).sort(), ["Ops", "Sales", "unfiled$public"]);
		assert.ok(flat.findIndex((q) => q.type === "Report") > idxFolderList, "content is queried after the folder list");
		// EmailTemplate also gets unfiled$public; folders of types without it do not.
		assert.deepStrictEqual(flat.filter((q) => q.type === "EmailTemplate").map((q) => q.folder).sort(), ["Welcome", "unfiled$public"]);
		assert.strictEqual(FOLDER_TYPES.Dashboard.unfiled, undefined);
	});

	it("one failing type is reported and does not fail the rest (batch is isolated)", async () => {
		const org = fakeWithData();
		org.failing.add("Broken");
		org.failing.add("ValidationRule");
		const failures: string[] = [];
		const res = await listOrgMetadata({ call: org.call, apiVersion: "67.0", onFailure: (f) => failures.push(f.type) });
		assert.deepStrictEqual(res.failures.map((f) => f.type).sort(), ["Broken", "ValidationRule"]);
		assert.deepStrictEqual(failures.sort(), ["Broken", "ValidationRule"]);
		assert.match(res.failures[0].error, /INVALID_TYPE/);
		assert.ok(res.comps.some((c) => c.t === "ApexClass"));
		assert.ok(res.comps.some((c) => c.t === "CustomField"));
		assert.ok(res.comps.some((c) => c.t === "Report"));
		// The retry listed the bad type's batch-mates one by one.
		assert.ok(org.calls.some((c) => c.queries.length === 1 && c.queries[0].type === "Broken"));
	});

	it("aborts on fatal (auth) errors instead of recording a failure per type", async () => {
		const org = fakeWithData();
		const err = Object.assign(new Error("HTTP 401: INVALID_SESSION_ID"), { fatal: true });
		org.fatal = err;
		await assert.rejects(listOrgMetadata({ call: org.call, apiVersion: "67.0" }), /INVALID_SESSION_ID/);
	});

	it("re-lists only the requested types with known types (no describe), folders follow their content type", async () => {
		const org = fakeWithData();
		const full = await listOrgMetadata({ call: org.call, apiVersion: "67.0" });
		org.calls = [];
		org.describeCalls = 0;
		const part = await listOrgMetadata({ call: org.call, apiVersion: "67.0", knownTypes: full.types, only: ["Flow", "Report"] });
		assert.strictEqual(org.describeCalls, 0);
		const typesQueried = new Set(org.calls.flatMap((c) => c.queries.map((q) => q.type)));
		assert.deepStrictEqual([...typesQueried].sort(), ["Flow", "Report", "ReportFolder"]);
		assert.strictEqual(part.comps.filter((c) => c.t === "Flow").length, 1);
	});

	it("honours cancellation", async () => {
		const org = fakeWithData();
		let n = 0;
		await assert.rejects(listOrgMetadata({ call: org.call, apiVersion: "67.0", concurrency: 1, isCancelled: () => ++n > 3 }), (e) => e instanceof ListCancelled);
	});

	it("runs calls with the configured concurrency", async () => {
		const org = fakeWithData();
		let inFlight = 0;
		let peak = 0;
		const call = async (op: string) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			try {
				return await org.call(op);
			} finally {
				inFlight--;
			}
		};
		await listOrgMetadata({ call, apiVersion: "67.0", concurrency: 4 });
		assert.ok(peak > 1 && peak <= 4, `peak concurrency ${peak}`);
	});
});

describe("orgBrowser lister: cache", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "orgbrowser-cache-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const sample = (): ListingCache => ({
		v: 1,
		orgKey: "me@example.com.dev",
		apiVersion: "67.0",
		listedAt: 1_700_000_000_000,
		types: [{ name: "ApexClass", dir: "classes", suffix: "cls", inFolder: false, metaFile: true, children: [] }],
		comps: [
			{ t: "ApexClass", n: "Alpha", ns: "", ms: "unmanaged", by: "Jane", bi: "005", lm: 1, cd: 2, id: "01p", f: "classes/Alpha.cls" },
			{ t: "Flow", n: "F", ns: "", ms: "", by: "", bi: "", lm: 0, cd: 0, id: "", f: "" },
		],
		failures: [{ type: "Broken", error: "nope" }],
	});

	it("round-trips through gzip JSON on disk", async () => {
		const c = sample();
		await saveListingCache(dir, c);
		assert.ok(fs.existsSync(cacheFilePath(dir, c.orgKey)));
		assert.deepStrictEqual(await loadListingCache(dir, c.orgKey), c);
	});

	it("returns null for a missing, corrupt or foreign-version cache", async () => {
		assert.strictEqual(await loadListingCache(dir, "nobody"), null);
		fs.writeFileSync(cacheFilePath(dir, "bad"), "not gzip");
		assert.strictEqual(await loadListingCache(dir, "bad"), null);
		await saveListingCache(dir, { ...sample(), v: 2 as unknown as 1 });
		assert.strictEqual(await loadListingCache(dir, sample().orgKey), null);
	});

	it("merges a per-type refresh over the cached rows and failures", () => {
		const base = sample();
		const fresh = {
			types: base.types,
			comps: [{ t: "ApexClass", n: "Gamma", ns: "", ms: "", by: "", bi: "", lm: 5, cd: 5, id: "", f: "" }] as Comp[],
			failures: [],
		};
		const merged = mergeTypeRefresh({ ...base, failures: [...base.failures, { type: "ApexClass", error: "old" }] }, ["ApexClass"], fresh, 99);
		assert.deepStrictEqual(merged.comps.map((c) => c.n).sort(), ["F", "Gamma"]);
		assert.deepStrictEqual(merged.failures, [{ type: "Broken", error: "nope" }]);
		assert.strictEqual(merged.typeListedAt!.ApexClass, 99);
		assert.strictEqual(merged.listedAt, base.listedAt);
	});

	it("sanitizes the org key into a file name", () => {
		assert.ok(path.basename(cacheFilePath(dir, "a/b:c@d.e")).startsWith("a_b_c@d.e"));
	});
});

describe("orgBrowser setup urls", () => {
	it("uses component pages when an id is known", () => {
		assert.strictEqual(setupTarget("ApexClass", "Foo", "01p000000000001AAA").path, "/lightning/setup/ApexClasses/page?address=%2F01p000000000001AAA");
		assert.strictEqual(setupTarget("ApexTrigger", "T", "01q000000000001AAA").path, "/01q000000000001AAA");
		assert.strictEqual(setupTarget("CustomObject", "Foo__c", "").path, "/lightning/setup/ObjectManager/Foo__c/Details/view");
		assert.strictEqual(setupTarget("CustomField", "Account.Region__c", "00N000000000001AAA").path, "/lightning/setup/ObjectManager/Account/FieldsAndRelationships/00N000000000001AAA/view");
		assert.strictEqual(setupTarget("Flow", "F", "301000000000001AAA").path, "/builder_platform_interaction/flowBuilder.app?flowId=301000000000001AAA");
		assert.strictEqual(setupTarget("PermissionSet", "P", "0PS000000000001AAA").path, "/lightning/setup/PermSets/page?address=%2F0PS000000000001AAA");
		assert.strictEqual(setupTarget("Profile", "Admin", "00e000000000001AAA").path, "/lightning/setup/EnhancedProfiles/page?address=%2F00e000000000001AAA");
		assert.strictEqual(setupTarget("Layout", "Account-Account Layout", "00h000000000001AAA").path, "/lightning/setup/ObjectManager/Account/PageLayouts/00h000000000001AAA/view");
	});

	it("falls back to list pages / Quick Find without an id", () => {
		assert.deepStrictEqual(setupTarget("ApexClass", "Foo", ""), { path: "/lightning/setup/ApexClasses/home", quickFind: true });
		assert.deepStrictEqual(setupTarget("LightningComponentBundle", "c", "0Rd000000000001AAA"), { path: "/lightning/setup/LightningComponentBundles/home", quickFind: true });
		assert.deepStrictEqual(setupTarget("Whatever", "x", ""), { path: "/lightning/setup/SetupOneHome/home", quickFind: true });
	});
});
