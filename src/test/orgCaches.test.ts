import { setWorkspaceFolders } from "./helpers/vscodeStub";
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canonicalOrgKey, invalidateOrgKeyCache, setAliasFileForTests, DEFAULT_ORG_KEY } from "../utils/orgKey";
import {
	DescribeStore,
	DescribeTransport,
	SchemaUnavailableError,
	trimDescribe,
	BATCH_SIZE,
	DESCRIBE_TTL_MS,
	NEGATIVE_TTL_MS,
	PROBE_INTERVAL_MS,
} from "../utils/describeStore";
import { DescribeDiskCache } from "../utils/describeDiskCache";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { AuthInfo, AUTH_CLI_TIMEOUT_MS } from "../utils/authInfo";
import { classifySchemaError, backoffMs } from "../utils/schemaHealth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const commandRunner = require("../utils/commandRunner");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpUtils = require("../utils/httpUtils");

const USER = "me@example.com";
const OTHER = "other@example.com";

let root: string;
let nested: string;

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data));
}

function setDefault(projectDir: string, target: string): void {
	writeJson(path.join(projectDir, ".sfdx", "sfdx-config.json"), { "target-org": target });
}

/** Controllable clock for TTL / back-off tests. */
const realNow = Date.now;
let clock = realNow();
function useFakeClock(): void {
	clock = realNow();
	Date.now = () => clock;
}
function advance(ms: number): void {
	clock += ms;
}

const tick = () => new Promise((r) => setImmediate(r));

function rawDescribe(name: string, extraFields: any[] = []): any {
	return {
		name,
		label: name,
		labelPlural: name + "s",
		keyPrefix: "001",
		custom: false,
		queryable: true,
		createable: true,
		updateable: true,
		deletable: true,
		urls: { big: "x".repeat(200) },
		recordTypeInfos: [{ name: "Master" }],
		fields: [
			{
				name: "Name",
				type: "string",
				label: "Name",
				length: 255,
				sortable: true,
				aggregatable: true,
				groupable: true,
				nillable: false,
				nameField: true,
				updateable: true,
				createable: true,
				calculated: false,
				soapType: "xsd:string",
				digits: 0,
				precision: 0,
			},
			{
				name: "Status__c",
				type: "picklist",
				picklistValues: [
					{ value: "A", label: "A", active: true, validFor: "xx" },
					{ value: "B", label: "B", active: false },
				],
			},
			...extraFields,
		],
		childRelationships: [
			{ childSObject: "Contact", field: "AccountId", relationshipName: "Contacts", cascadeDelete: false, deprecatedAndHidden: false },
			{ childSObject: "Old", field: "X", relationshipName: null, deprecatedAndHidden: true },
		],
	};
}

interface FakeTransport extends DescribeTransport {
	describes: { org: string; name: string; ims?: string }[];
	batches: { org: string; names: string[] }[];
}

function fakeTransport(opts: {
	describe?: (name: string, ims?: string) => Promise<{ status: number; body?: string; date?: string }>;
	batchStatus?: (name: string) => number;
} = {}): FakeTransport {
	const t: FakeTransport = {
		describes: [],
		batches: [],
		async describe(org, name, ims) {
			t.describes.push({ org, name, ims });
			if (opts.describe) return { ...(await opts.describe(name, ims)), orgId: "00D000000000001" };
			return { status: 200, body: JSON.stringify(rawDescribe(name)), date: "Mon, 02 Nov 2026 10:00:00 GMT", orgId: "00D000000000001" };
		},
		async batch(org, names) {
			t.batches.push({ org, names: [...names] });
			return {
				orgId: "00D000000000001",
				results: names.map((n) => {
					const status = opts.batchStatus ? opts.batchStatus(n) : 200;
					return status === 200 ? { statusCode: 200, result: rawDescribe(n) } : { statusCode: status, result: [{ errorCode: "X" }] };
				}),
			};
		},
	};
	return t;
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-orgkey-"));
	nested = path.join(root, "billing");
	writeJson(path.join(root, "sfdx-project.json"), { packageDirectories: [{ path: "force-app" }] });
	writeJson(path.join(nested, "sfdx-project.json"), { packageDirectories: [{ path: "force-app" }] });
	setDefault(root, "myalias");
	setDefault(nested, "other");
	const aliasFile = path.join(root, "alias.json");
	writeJson(aliasFile, { orgs: { myalias: USER, other: OTHER } });
	setAliasFileForTests(aliasFile);
	setWorkspaceFolders([root]);
});

after(() => {
	setAliasFileForTests(undefined);
	DescribeStore.setTransportForTests(undefined);
	DescribeStore.configurePersistence(undefined);
	fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
	Date.now = realNow;
});

describe("canonicalOrgKey", () => {
	beforeEach(() => invalidateOrgKeyCache());

	it("maps null, empty, the default sentinel, alias and username to the same username", () => {
		assert.strictEqual(canonicalOrgKey(null), USER);
		assert.strictEqual(canonicalOrgKey(undefined), USER);
		assert.strictEqual(canonicalOrgKey(""), USER);
		assert.strictEqual(canonicalOrgKey(DEFAULT_ORG_KEY), USER);
		assert.strictEqual(canonicalOrgKey("myalias"), USER);
		assert.strictEqual(canonicalOrgKey(USER), USER);
	});

	it("is idempotent", () => {
		assert.strictEqual(canonicalOrgKey(canonicalOrgKey(null)), canonicalOrgKey(null));
	});

	it("resolves a nested project's own default org", () => {
		assert.strictEqual(canonicalOrgKey(null, nested), OTHER);
		assert.strictEqual(canonicalOrgKey(null, root), USER);
	});

	it("leaves unknown aliases unchanged", () => {
		assert.strictEqual(canonicalOrgKey("nope"), "nope");
	});

	it("follows a default-org change after invalidation", () => {
		assert.strictEqual(canonicalOrgKey(null), USER);
		setDefault(root, "other");
		assert.strictEqual(canonicalOrgKey(null), USER, "cached until invalidated");
		invalidateOrgKeyCache();
		assert.strictEqual(canonicalOrgKey(null), OTHER);
		setDefault(root, "myalias");
		invalidateOrgKeyCache();
		assert.strictEqual(canonicalOrgKey(null), USER);
	});

	it("falls back to the CLI default sentinel when nothing is configured", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-empty-"));
		assert.strictEqual(canonicalOrgKey(null, empty), DEFAULT_ORG_KEY);
		fs.rmSync(empty, { recursive: true, force: true });
	});
});

describe("trimDescribe", () => {
	it("keeps what consumers read and drops the rest", () => {
		const t = trimDescribe(rawDescribe("Account"));
		assert.deepStrictEqual(Object.keys(t).sort(), [
			"childRelationships", "createable", "custom", "deletable", "fields", "keyPrefix", "label", "labelPlural", "name", "queryable", "updateable",
		]);
		const name = t.fields[0] as any;
		assert.strictEqual(name.nameField, true);
		assert.strictEqual(name.sortable, true);
		assert.strictEqual(name.nillable, false);
		assert.strictEqual(name.calculated, undefined, "false flags that consumers test with !! are dropped");
		assert.strictEqual(name.soapType, undefined);
		assert.deepStrictEqual(t.fields[1].picklistValues, [{ value: "A" }], "only active values");
		assert.strictEqual(t.childRelationships[1].deprecatedAndHidden, true);
		assert.ok(JSON.stringify(t).length < JSON.stringify(rawDescribe("Account")).length);
	});
});

describe("DescribeStore — canonical keys and invalidation", () => {
	beforeEach(() => {
		invalidateOrgKeyCache();
		DescribeStore.configurePersistence(undefined);
		DescribeStore.invalidateAll();
	});

	it("null, alias and username share one cached describe", async () => {
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.get(null, "Account");
		await DescribeStore.get("myalias", "Account");
		await DescribeStore.get(USER, "Account");
		assert.strictEqual(t.describes.length, 1);
		assert.strictEqual(t.describes[0].org, USER);
	});

	it("an invalidation via null drops the entry fetched via alias (and vice versa)", async () => {
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.get("myalias", "Account");
		OrgMetadataCache.invalidateSObjects(null, ["Account"]);
		assert.strictEqual(DescribeStore.hasFresh(USER, "Account"), false);
		await DescribeStore.get(USER, "Account");
		assert.strictEqual(t.describes.length, 2);
		DescribeStore.invalidateSObject("myalias", "Account");
		assert.strictEqual(DescribeStore.hasFresh(null, "Account"), false);
	});

	it("does not write back a fetch that was invalidated while in flight", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const t = fakeTransport({
			describe: async (name) => {
				await gate;
				return { status: 200, body: JSON.stringify(rawDescribe(name)) };
			},
		});
		DescribeStore.setTransportForTests(t);
		const p = DescribeStore.get(null, "Account");
		await tick();
		DescribeStore.invalidateSObject("myalias", "Account");
		release();
		assert.ok(await p, "the caller still gets its result");
		assert.strictEqual(DescribeStore.hasFresh(null, "Account"), false, "but it was not cached");
	});

	it("emits a structural change through OrgMetadataCache for push/pull with added objects", () => {
		const seen: any[] = [];
		const off = OrgMetadataCache.onChange((org, change) => seen.push({ org, change }));
		OrgMetadataCache.invalidateSObjects("myalias", ["New__c"], true);
		off();
		assert.deepStrictEqual(seen, [{ org: USER, change: { objects: ["New__c"], structural: true } }]);
	});
});

describe("DescribeStore — failure handling", () => {
	beforeEach(() => {
		invalidateOrgKeyCache();
		DescribeStore.configurePersistence(undefined);
		DescribeStore.invalidateAll();
	});

	it("classifies errors", () => {
		assert.strictEqual(classifySchemaError(new Error("HTTP 404: NOT_FOUND")), "notFound");
		assert.strictEqual(classifySchemaError(Object.assign(new Error("x"), { status: 401 })), "sessionExpired");
		assert.strictEqual(classifySchemaError(new Error("Salesforce session expired or revoked. Re-authenticate")), "sessionExpired");
		assert.strictEqual(classifySchemaError(new Error("Could not get org credentials. Set a default org")), "noCredentials");
		assert.strictEqual(classifySchemaError(new Error("HTTP 503: down")), "transient");
		assert.strictEqual(classifySchemaError(new Error("Request timed out after 30000ms")), "transient");
		assert.ok(backoffMs("transient", 1) < backoffMs("transient", 4));
		assert.ok(backoffMs("transient", 20) <= 30_000);
	});

	it("negative-caches a real 404 for the negative TTL only", async () => {
		useFakeClock();
		const t = fakeTransport({ describe: async () => Promise.reject(Object.assign(new Error("HTTP 404: NOT_FOUND"), { status: 404 })) });
		DescribeStore.setTransportForTests(t);
		assert.strictEqual(await DescribeStore.getStrict(null, "Foo"), null, "404 resolves null even when strict");
		assert.strictEqual(await DescribeStore.get(null, "Foo"), null);
		assert.strictEqual(t.describes.length, 1, "second lookup served from the negative cache");
		advance(NEGATIVE_TTL_MS + 1);
		await DescribeStore.get(null, "Foo");
		assert.strictEqual(t.describes.length, 2, "re-fetched after the negative TTL");
	});

	for (const [label, err] of [
		["a timeout", Object.assign(new Error("Request exceeded 10000ms"), { timedOut: true })],
		["a network error", new Error("getaddrinfo ENOTFOUND x.my.salesforce.com")],
		["a 5xx", Object.assign(new Error("HTTP 503: unavailable"), { status: 503 })],
	] as const) {
		it(`never negative-caches ${label}; backs off briefly instead`, async () => {
			useFakeClock();
			let fail = true;
			const t = fakeTransport({
				describe: async (name) => {
					if (fail) throw err;
					return { status: 200, body: JSON.stringify(rawDescribe(name)) };
				},
			});
			DescribeStore.setTransportForTests(t);
			await assert.rejects(DescribeStore.getStrict(null, "Account"), (e: any) => e instanceof SchemaUnavailableError && e.kind === "transient");
			assert.strictEqual(await DescribeStore.get(null, "Account"), null, "non-strict get resolves null");
			assert.strictEqual(t.describes.length, 1, "back-off: no second request right away");
			await assert.rejects(DescribeStore.getStrict(null, "Account"), SchemaUnavailableError);
			advance(backoffMs("transient", 1) + 1);
			fail = false;
			const d = await DescribeStore.getStrict(null, "Account");
			assert.strictEqual(d?.name, "Account", "fetched again once the back-off elapsed");
			assert.strictEqual(t.describes.length, 2);
		});
	}

	it("concurrent failures are one outage: the back-off does not grow per request", async () => {
		useFakeClock();
		const t = fakeTransport({ describe: async () => { throw new Error("getaddrinfo ENOTFOUND x.my.salesforce.com"); } });
		DescribeStore.setTransportForTests(t);
		await Promise.all(["A", "B", "C", "D", "E"].map((n) => DescribeStore.get(null, n)));
		assert.strictEqual(t.describes.length, 5);
		advance(backoffMs("transient", 1) + 1);
		const d = await DescribeStore.get(null, "F");
		assert.strictEqual(d, null);
		assert.strictEqual(t.describes.length, 6, "five simultaneous failures must not have pushed the back-off to 5 steps");
	});

	it("lets one probe through during a back-off, so a recovered org is noticed within seconds", async () => {
		useFakeClock();
		let fail = true;
		const t = fakeTransport({
			describe: async (name) => {
				if (fail) throw new Error("getaddrinfo ENOTFOUND x.my.salesforce.com");
				return { status: 200, body: JSON.stringify(rawDescribe(name)) };
			},
		});
		DescribeStore.setTransportForTests(t);
		await assert.rejects(DescribeStore.getStrict(null, "Account"), SchemaUnavailableError);
		await assert.rejects(DescribeStore.getStrict(null, "Account"), SchemaUnavailableError);
		assert.strictEqual(t.describes.length, 1, "no probe right after the failure");
		// Make the nominal back-off long (several failures), then recover.
		for (let i = 0; i < 3; i++) {
			advance(PROBE_INTERVAL_MS + 1);
			await assert.rejects(DescribeStore.getStrict(null, "Account"), SchemaUnavailableError);
		}
		fail = false;
		advance(PROBE_INTERVAL_MS + 1);
		const d = await DescribeStore.getStrict(null, "Account");
		assert.strictEqual(d?.name, "Account", "the probe succeeded long before the exponential window ended");
		assert.strictEqual((await DescribeStore.getStrict(null, "Contact"))?.name, "Contact", "success cleared the back-off");
	});

	it("a 403/400 on one object does not back the whole org off", async () => {
		useFakeClock();
		const t = fakeTransport({
			describe: async (name) => {
				if (name === "Forbidden__x") throw Object.assign(new Error("HTTP 403: [{\"errorCode\":\"INSUFFICIENT_ACCESS\"}]"), { status: 403 });
				return { status: 200, body: JSON.stringify(rawDescribe(name)) };
			},
		});
		DescribeStore.setTransportForTests(t);
		assert.strictEqual(await DescribeStore.getStrict(null, "Forbidden__x"), null, "treated as not describable");
		assert.strictEqual((await DescribeStore.getStrict(null, "Account"))?.name, "Account", "other objects are unaffected");
		// ...but an org-wide limit is still a back-off.
		const t2 = fakeTransport({ describe: async () => { throw Object.assign(new Error("HTTP 403: REQUEST_LIMIT_EXCEEDED"), { status: 403 }); } });
		DescribeStore.invalidateAll();
		DescribeStore.setTransportForTests(t2);
		await assert.rejects(DescribeStore.getStrict(null, "Account"), SchemaUnavailableError);
	});

	it("revalidates an expired entry with If-Modified-Since and keeps it on 304", async () => {
		useFakeClock();
		let notModified = false;
		const t = fakeTransport({
			describe: async (name) =>
				notModified ? { status: 304 } : { status: 200, body: JSON.stringify(rawDescribe(name)), date: "Mon, 02 Nov 2026 10:00:00 GMT" },
		});
		DescribeStore.setTransportForTests(t);
		const first = await DescribeStore.get(null, "Account");
		advance(DESCRIBE_TTL_MS + 1);
		notModified = true;
		const stale = await DescribeStore.get(null, "Account");
		assert.deepStrictEqual(stale, first, "served stale immediately");
		for (let i = 0; i < 5; i++) await tick();
		assert.strictEqual(t.describes.length, 2);
		assert.strictEqual(t.describes[1].ims, "Mon, 02 Nov 2026 10:00:00 GMT");
		assert.strictEqual(DescribeStore.hasFresh(null, "Account"), true, "304 refreshed the TTL");
	});
});

describe("DescribeStore.getMany (composite/batch)", () => {
	beforeEach(() => {
		invalidateOrgKeyCache();
		DescribeStore.configurePersistence(undefined);
		DescribeStore.invalidateAll();
	});

	it("batches misses in chunks of at most 25, in order, and caches them", async () => {
		const names = Array.from({ length: 60 }, (_, i) => `Obj${i}__c`);
		const t = fakeTransport({ batchStatus: (n) => (n === "Obj7__c" ? 404 : 200) });
		DescribeStore.setTransportForTests(t);
		const out = await DescribeStore.getMany("myalias", names);
		assert.strictEqual(BATCH_SIZE, 25);
		assert.deepStrictEqual(t.batches.map((b) => b.names.length), [25, 25, 10]);
		assert.ok(t.batches.every((b) => b.org === USER));
		assert.strictEqual(out.length, 60);
		assert.strictEqual(out[0]?.name, "Obj0__c");
		assert.strictEqual(out[59]?.name, "Obj59__c");
		assert.strictEqual(out[7], null, "404 subrequest → null");
		// Cached: neither single nor batch lookups hit the network again.
		await DescribeStore.get(null, "Obj3__c");
		await DescribeStore.getMany(null, ["Obj1__c", "Obj7__c"]);
		assert.strictEqual(t.describes.length, 0);
		assert.strictEqual(t.batches.length, 3);
	});

	it("only fetches the misses and keeps duplicates in place", async () => {
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.get(null, "Account");
		const out = await DescribeStore.getMany(null, ["Account", "Contact", "Lead", "Contact"]);
		assert.deepStrictEqual(out.map((d) => d?.name), ["Account", "Contact", "Lead", "Contact"]);
		assert.deepStrictEqual(t.batches.map((b) => b.names), [["Contact", "Lead"]]);
	});

	it("a single miss uses a plain describe", async () => {
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.getMany(null, ["Account"]);
		assert.strictEqual(t.batches.length, 0);
		assert.strictEqual(t.describes.length, 1);
	});

	it("strict mode rejects when a subrequest failed transiently (not cached)", async () => {
		const t = fakeTransport({ batchStatus: (n) => (n === "B" ? 500 : 200) });
		DescribeStore.setTransportForTests(t);
		await assert.rejects(DescribeStore.getMany(null, ["A", "B"], { strict: true }), SchemaUnavailableError);
		assert.strictEqual(DescribeStore.hasFresh(null, "A"), true);
		assert.strictEqual(DescribeStore.hasFresh(null, "B"), false);
		const lenient = await DescribeStore.getMany(null, ["A", "C", "B"]);
		assert.strictEqual(lenient[0]?.name, "A");
	});
});

describe("DescribeStore persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-disk-"));
		invalidateOrgKeyCache();
		DescribeStore.invalidateAll();
	});
	afterEach(() => {
		DescribeStore.configurePersistence(undefined);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("persists trimmed describes and serves them (stale) after a reload, then revalidates", async () => {
		DescribeStore.configurePersistence(dir, { maxEntriesPerOrg: 10, maxBytesPerOrg: 1e6, maxOrgFiles: 2, writeDelayMs: 10 });
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.get(null, "Account");
		DescribeStore.disposeAll(); // flush + forget memory (like a reload)
		const files = fs.readdirSync(dir);
		assert.ok(files.includes("index.json"));
		assert.ok(files.some((f) => /^describe-00D000000000001-.*\.json$/.test(f)));

		const t2 = fakeTransport({ describe: async () => ({ status: 304 }) });
		DescribeStore.setTransportForTests(t2);
		const d = await DescribeStore.get("myalias", "Account");
		assert.strictEqual(d?.name, "Account", "served from disk");
		for (let i = 0; i < 5; i++) await tick();
		assert.strictEqual(t2.describes.length, 1, "revalidated once in the background");
		assert.ok(t2.describes[0].ims, "with If-Modified-Since");
	});

	it("an invalidation before the lazy load prevents resurrection from disk", async () => {
		DescribeStore.configurePersistence(dir, { maxEntriesPerOrg: 10, maxBytesPerOrg: 1e6, maxOrgFiles: 2, writeDelayMs: 10 });
		DescribeStore.setTransportForTests(fakeTransport());
		await DescribeStore.get(null, "Account");
		DescribeStore.disposeAll();
		DescribeStore.invalidateSObject(null, "Account");
		const t = fakeTransport();
		DescribeStore.setTransportForTests(t);
		await DescribeStore.get(null, "Account");
		assert.strictEqual(t.describes.length, 1);
		assert.strictEqual(t.describes[0].ims, undefined, "fresh fetch, not a revalidation");
	});

	it("the full refresh clears the org's files", async () => {
		DescribeStore.configurePersistence(dir, { maxEntriesPerOrg: 10, maxBytesPerOrg: 1e6, maxOrgFiles: 2, writeDelayMs: 10 });
		DescribeStore.setTransportForTests(fakeTransport());
		await DescribeStore.get(null, "Account");
		DescribeStore.disposeAll();
		DescribeStore.clearPersisted("myalias");
		assert.ok(!fs.readdirSync(dir).some((f) => f.startsWith("describe-")));
	});

	it("bounds entries and bytes per org", () => {
		const cache = new DescribeDiskCache(dir, { maxEntriesPerOrg: 3, maxBytesPerOrg: 1e9, maxOrgFiles: 2, writeDelayMs: 10 });
		const entries: Record<string, { d: unknown; t: number }> = {};
		for (let i = 0; i < 6; i++) entries[`O${i}`] = { d: { name: `O${i}` }, t: i };
		const b = cache.bound({ v: 1, orgId: "x", apiVersion: "v1", savedAt: 0, entries });
		assert.deepStrictEqual(Object.keys(b.entries).sort(), ["O3", "O4", "O5"], "newest kept");
		const small = new DescribeDiskCache(dir, { maxEntriesPerOrg: 100, maxBytesPerOrg: 60, maxOrgFiles: 2, writeDelayMs: 10 });
		assert.ok(Object.keys(small.bound({ v: 1, orgId: "x", apiVersion: "v1", savedAt: 0, entries }).entries).length < 6);
	});
});

describe("OrgMetadataCache.getObjectListStrict", () => {
	const origGet = httpUtils.httpsGet;
	const origRun = commandRunner.runCommandArgs;
	beforeEach(() => {
		invalidateOrgKeyCache();
		AuthInfo.clearCache();
		OrgMetadataCache.clearAll();
		DescribeStore.configurePersistence(undefined);
		commandRunner.runCommandArgs = async () =>
			JSON.stringify({ status: 0, result: { accessToken: "t", instanceUrl: "https://x.my.salesforce.com", username: USER, id: "00D1" } });
	});
	afterEach(() => {
		httpUtils.httpsGet = origGet;
		commandRunner.runCommandArgs = origRun;
		AuthInfo.clearCache();
		OrgMetadataCache.clearAll();
	});

	it("rejects (never resolves []) when the org can't answer, throttles retries, and recovers", async () => {
		useFakeClock();
		let fail = true;
		let calls = 0;
		httpUtils.httpsGet = async () => {
			calls++;
			if (fail) throw Object.assign(new Error("HTTP 503: unavailable"), { status: 503 });
			return JSON.stringify({ sobjects: [{ name: "User" }, { name: "Account" }] });
		};
		await assert.rejects(OrgMetadataCache.getObjectListStrict(null), SchemaUnavailableError);
		assert.deepStrictEqual(await OrgMetadataCache.getObjectList(null), [], "the lenient variant still resolves []");
		await assert.rejects(OrgMetadataCache.getObjectListStrict(null), SchemaUnavailableError);
		assert.strictEqual(calls, 1, "failures are re-thrown for a moment, not re-fetched per call");
		fail = false;
		advance(PROBE_INTERVAL_MS + 1);
		assert.deepStrictEqual(await OrgMetadataCache.getObjectListStrict(null), ["Account", "User"]);
		assert.strictEqual(calls, 2);
		assert.deepStrictEqual(await OrgMetadataCache.getObjectListStrict(null), ["Account", "User"], "cached once fetched");
		assert.strictEqual(calls, 2);
	});
});

describe("AuthInfo — single-flight 401 refresh", () => {
	const origRun = commandRunner.runCommandArgs;
	const origGet = httpUtils.httpsGet;
	afterEach(() => {
		commandRunner.runCommandArgs = origRun;
		httpUtils.httpsGet = origGet;
		AuthInfo.clearCache();
	});

	it("concurrent 401s share one CLI token refresh; auth spawns are capped and canonical", async () => {
		invalidateOrgKeyCache();
		AuthInfo.clearCache();
		let token = "t0";
		let refreshes = 0;
		const displayCalls: { args: string[]; timeout?: number }[] = [];
		commandRunner.runCommandArgs = async (_cmd: string, args: string[], _cwd?: string, _o?: unknown, _l?: boolean, timeoutMs?: number) => {
			if (args[1] === "display" && args[2] === "user") {
				refreshes++;
				assert.strictEqual(timeoutMs, AUTH_CLI_TIMEOUT_MS);
				await new Promise((r) => setTimeout(r, 20));
				token = "t1";
				return "{}";
			}
			displayCalls.push({ args, timeout: timeoutMs });
			return JSON.stringify({ status: 0, result: { accessToken: token, instanceUrl: "https://x.my.salesforce.com", username: USER, id: "00D1" } });
		};
		httpUtils.httpsGet = async (_url: string, tok: string) => {
			await new Promise((r) => setTimeout(r, 5));
			if (tok === "t0") throw Object.assign(new Error("HTTP 401: INVALID_SESSION_ID"), { status: 401 });
			return "{\"ok\":true}";
		};
		const results = await Promise.all([
			...Array.from({ length: 4 }, () => AuthInfo.get(null, (a) => `${a.instanceUrl}/x`)),
			AuthInfo.get("myalias", (a) => `${a.instanceUrl}/x`),
			AuthInfo.get(USER, (a) => `${a.instanceUrl}/x`),
		]);
		assert.ok(results.every((r) => r.body === "{\"ok\":true}"));
		assert.strictEqual(refreshes, 1, "one refresh for six concurrent 401s");
		assert.ok(displayCalls.every((c) => c.timeout === AUTH_CLI_TIMEOUT_MS), "sf org display capped");
		assert.ok(displayCalls.every((c) => c.args.includes("--target-org") && c.args.includes(USER)), "canonical username passed to the CLI");
		assert.ok(displayCalls.length <= 2, `auth fetched once before and once after the refresh (got ${displayCalls.length})`);

		// A late 401 carrying the already-replaced token must not trigger another refresh.
		await AuthInfo.get(null, (a) => `${a.instanceUrl}/x`);
		assert.strictEqual(refreshes, 1);
	});
});
