/**
 * End-to-end: the REAL host schema modules (schemaHost handlers → SoqlSchemaProvider →
 * OrgMetadataCache / DescribeStore / AuthInfo / httpUtils, with persistence) wired to
 * the REAL language server (out/server.js). Only the bottom of the stack is faked:
 *   - `https.request` answers Salesforce REST JSON (gzip-encoded, composite/batch,
 *     If-Modified-Since → 304), and
 *   - `runCommandArgs` answers `sf org display`.
 *
 * Reproduces "Apex completion returns nothing" as seen in a real VS Code: every
 * completion below needs the `User` / `Account` describe to travel host → server.
 * Requires `npm run compile` first (out/server.js).
 */
import { setWorkspaceFolders } from "./helpers/vscodeStub";
import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { pathToFileURL } from "url";
import { registerSchemaHostHandlers } from "../schemaHost";
import { DescribeStore } from "../utils/describeStore";
import { OrgMetadataCache } from "../utils/orgMetadataCache";
import { AuthInfo } from "../utils/authInfo";
import { invalidateOrgKeyCache, setAliasFileForTests } from "../utils/orgKey";
import { setSchemaHealthSink } from "../utils/schemaHealth";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rpc = require("vscode-jsonrpc/node");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const commandRunner = require("../utils/commandRunner");

const USERNAME = "dev@example.com";
const INSTANCE = "https://fake-org.my.salesforce.com";

// ─── Realistic Salesforce REST payloads ─────────────────────────────────────────

function rawField(name: string, type: string, extra: Record<string, unknown> = {}): any {
	return {
		aggregatable: type !== "textarea",
		autoNumber: false,
		byteLength: type === "string" ? 240 : 0,
		calculated: false,
		caseSensitive: false,
		createable: true,
		custom: name.endsWith("__c"),
		defaultedOnCreate: false,
		deprecatedAndHidden: false,
		digits: 0,
		externalId: false,
		filterable: true,
		groupable: type !== "textarea",
		htmlFormatted: false,
		idLookup: false,
		inlineHelpText: null,
		label: name,
		length: type === "string" ? 80 : type === "textarea" ? 1333 : 0,
		name,
		nameField: false,
		nillable: true,
		permissionable: false,
		picklistValues: [],
		polymorphicForeignKey: false,
		precision: 0,
		referenceTo: [],
		relationshipName: null,
		restrictedPicklist: false,
		scale: 0,
		soapType: "xsd:string",
		sortable: type !== "textarea",
		type,
		unique: false,
		updateable: true,
		...extra,
	};
}

function describeOf(name: string, fields: any[], children: any[] = []): any {
	return {
		activateable: false,
		createable: true,
		custom: name.endsWith("__c"),
		deletable: true,
		fields,
		keyPrefix: "005",
		label: name,
		labelPlural: name + "s",
		name,
		queryable: true,
		updateable: true,
		urls: { sobject: `/services/data/v62.0/sobjects/${name}`, describe: `/services/data/v62.0/sobjects/${name}/describe` },
		recordTypeInfos: [{ name: "Master", active: true, available: true, defaultRecordTypeMapping: true }],
		childRelationships: children,
	};
}

const DESCRIBES: Record<string, any> = {
	User: describeOf("User", [
		rawField("Id", "id", { nillable: false }),
		rawField("Name", "string", { nameField: true, nillable: false, updateable: false }),
		rawField("Username", "string", { nillable: false }),
		rawField("Signature", "textarea"),
		rawField("ManagerId", "reference", { referenceTo: ["User"], relationshipName: "Manager" }),
		rawField("ProfileId", "reference", { referenceTo: ["Profile"], relationshipName: "Profile", nillable: false }),
	]),
	Account: describeOf(
		"Account",
		[
			rawField("Id", "id", { nillable: false }),
			rawField("Name", "string", { nameField: true, nillable: false }),
			rawField("Industry", "picklist", { picklistValues: [{ active: true, value: "Banking", label: "Banking" }] }),
			rawField("OwnerId", "reference", { referenceTo: ["User"], relationshipName: "Owner", nillable: false }),
		],
		[{ childSObject: "Contact", field: "AccountId", relationshipName: "Contacts", cascadeDelete: false, deprecatedAndHidden: false }],
	),
	Profile: describeOf("Profile", [rawField("Id", "id"), rawField("Name", "string", { nameField: true })]),
	Contact: describeOf("Contact", [rawField("Id", "id"), rawField("LastName", "string")]),
};

function objectNames(): string[] {
	const names = ["Account", "Contact", "Profile", "User", "Opportunity", "Lead", "Case", "Task", "Event", "Group"];
	for (let i = 0; i < 300; i++) names.push(`Custom${i}__c`);
	return names.sort((a, b) => a.localeCompare(b));
}

// ─── Fake https layer ───────────────────────────────────────────────────────────

interface FakeNet {
	log: string[];
	/** When set, every request fails with this error (org unreachable). */
	down: Error | null;
	/** Respond 304 to requests carrying If-Modified-Since. */
	allow304: boolean;
	/** Fail describeGlobal only. */
	globalFails: boolean;
	/** Latency of `sf org display` and of every HTTP response (a cold real CLI takes 1-3 s). */
	cliMs: number;
	httpMs: number;
	/** `sf org display` fails until this time (ms epoch) — a CLI that is not ready right after activation. */
	authFailsUntil: number;
}
const net: FakeNet = { log: [], down: null, allow304: true, globalFails: false, cliMs: 0, httpMs: 0, authFailsUntil: 0 };

function respond(
	method: string,
	url: URL,
	headers: Record<string, string>,
	body: string,
): { status: number; body: string; headers?: Record<string, string> } {
	const p = url.pathname;
	const base = { Date: "Mon, 02 Nov 2026 10:00:00 GMT" };
	const ims = Object.keys(headers).find((k) => k.toLowerCase() === "if-modified-since");
	if (method === "GET" && /\/sobjects\/?$/.test(p)) {
		if (net.globalFails) return { status: 503, body: "[]" };
		return { status: 200, body: JSON.stringify({ encoding: "UTF-8", maxBatchSize: 200, sobjects: objectNames().map((name) => ({ name, label: name, queryable: true })) }), headers: base };
	}
	const m = /\/sobjects\/([^/]+)\/describe$/.exec(p);
	if (method === "GET" && m) {
		const d = DESCRIBES[decodeURIComponent(m[1])];
		if (!d) return { status: 404, body: JSON.stringify([{ errorCode: "NOT_FOUND", message: "The requested resource does not exist" }]) };
		if (ims && net.allow304) return { status: 304, body: "", headers: base };
		return { status: 200, body: JSON.stringify(d), headers: base };
	}
	if (method === "POST" && /\/composite\/batch$/.test(p)) {
		const req = JSON.parse(body) as { batchRequests: { url: string }[] };
		const results = req.batchRequests.map((r) => {
			const mm = /sobjects\/([^/]+)\/describe$/.exec(r.url);
			const d = mm ? DESCRIBES[decodeURIComponent(mm[1])] : undefined;
			return d ? { statusCode: 200, result: d } : { statusCode: 404, result: [{ errorCode: "NOT_FOUND" }] };
		});
		return { status: 200, body: JSON.stringify({ hasErrors: false, results }), headers: base };
	}
	return { status: 404, body: "[]" };
}

class FakeReq extends EventEmitter {
	private chunks: Buffer[] = [];
	constructor(private readonly opts: any, private readonly cb: (res: any) => void) {
		super();
	}
	write(b: Buffer | string): boolean {
		this.chunks.push(Buffer.from(b));
		return true;
	}
	setTimeout(): this {
		return this;
	}
	destroy(): void {}
	end(): void {
		const hdrs: Record<string, string> = {};
		for (const [k, v] of Object.entries(this.opts.headers ?? {})) hdrs[k] = String(v);
		const url = new URL(`https://${this.opts.hostname}${this.opts.path}`);
		setTimeout(() => {
			net.log.push(`${this.opts.method} ${url.pathname}`);
			if (net.down) {
				this.emit("error", net.down);
				return;
			}
			const r = respond(this.opts.method, url, hdrs, Buffer.concat(this.chunks).toString());
			const wantsGzip = Object.entries(hdrs).some(([k, v]) => k.toLowerCase() === "accept-encoding" && /gzip/.test(v));
			const raw = Buffer.from(r.body);
			const payload = wantsGzip && raw.length ? zlib.gzipSync(raw) : raw;
			const res: any = Readable.from(payload.length ? [payload] : []);
			res.statusCode = r.status;
			res.headers = { ...(r.headers ?? {}), ...(wantsGzip && raw.length ? { "content-encoding": "gzip" } : {}) };
			// Readable.from objectMode → use a plain binary stream so 'data' yields Buffers.
			const bin = new Readable({ read() {} });
			if (payload.length) bin.push(payload);
			bin.push(null);
			(bin as any).statusCode = r.status;
			(bin as any).headers = res.headers;
			this.cb(bin);
		}, net.httpMs);
	}
}

// ─── Workspace + server wiring ──────────────────────────────────────────────────

const root = path.join(os.tmpdir(), `sfx-hostserver-${process.pid}`);
const classes = path.join(root, "force-app", "main", "default", "classes");
const cacheDir = path.join(root, "global-storage", "describe-cache");
let child: cp.ChildProcess;
let conn: any;
let seq = 1;
const origRequest = https.request;
const origRun = commandRunner.runCommandArgs;

function installFakes(): void {
	(https as any).request = (opts: any, cb: (res: any) => void) => new FakeReq(opts, cb);
	commandRunner.runCommandArgs = async (_cmd: string, args: string[]) => {
		await new Promise((r) => setTimeout(r, net.cliMs));
		if (Date.now() < net.authFailsUntil) throw new Error("Command failed: sf org display (transient CLI failure)");
		if (args[0] === "org" && args[1] === "display" && args[2] !== "user") {
			return JSON.stringify({
				status: 0,
				result: { accessToken: "00Dxx!token", instanceUrl: INSTANCE, username: USERNAME, id: "00D000000000AAA", apiVersion: "62.0" },
			});
		}
		return JSON.stringify({ status: 0, result: {} });
	};
}

function resetHostState(): void {
	AuthInfo.clearCache();
	OrgMetadataCache.clearAll();
	invalidateOrgKeyCache();
}

function itemsOf(res: any): any[] {
	return Array.isArray(res) ? res : res?.items ?? [];
}
function labelsOf(res: any): string[] {
	return itemsOf(res).map((i: any) => i.label);
}

async function completeAt(src: string, lang = "apex", ext = "cls"): Promise<any> {
	const offset = src.indexOf("|");
	assert.ok(offset >= 0, "cursor marker missing");
	const text = src.slice(0, offset) + src.slice(offset + 1);
	const before = text.slice(0, offset).split("\n");
	const position = { line: before.length - 1, character: before[before.length - 1].length };
	const uri = pathToFileURL(path.join(classes, `T${seq++}.${ext}`)).href;
	// Like VS Code: the document is open without the last typed character, then an
	// incremental didChange delivers it, then the completion request follows.
	const typed = position.character > 0 ? before[before.length - 1][position.character - 1] : "";
	const opened = typed ? text.slice(0, offset - 1) + text.slice(offset) : text;
	await conn.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: lang, version: 1, text: opened } });
	if (typed) {
		const at = { line: position.line, character: position.character - 1 };
		await conn.sendNotification("textDocument/didChange", {
			textDocument: { uri, version: 2 },
			contentChanges: [{ range: { start: at, end: at }, text: typed }],
		});
	}
	const context = typed === "." ? { triggerKind: 2, triggerCharacter: "." } : { triggerKind: 1 };
	const started = Date.now();
	const res = await conn.sendRequest("textDocument/completion", { textDocument: { uri }, position, context });
	if (process.env.E2E_TRACE) console.log(`  [completion ${Date.now() - started}ms] ${itemsOf(res).length} items, incomplete=${!!res?.isIncomplete}`);
	return res;
}

const inMethod = (body: string) => `public class Main {\n  void m() {\n${body}\n  }\n}\n`;

/** Poll until `fn` yields the wanted labels (the first request may be answered "incomplete" while the host warms up). */
let waitMs = 2000;
async function eventually(fn: () => Promise<string[]>, want: string[], what: string): Promise<string[]> {
	let labels: string[] = [];
	const until = Date.now() + waitMs;
	for (let i = 0; i === 0 || Date.now() < until; i++) {
		labels = await fn();
		if (want.every((w) => labels.includes(w))) return labels;
		await new Promise((r) => setTimeout(r, 250));
	}
	assert.fail(`${what}: expected ${want.join(",")} in [${labels.slice(0, 30).join(",")}] (${labels.length} items)`);
}

const SCENARIOS: { name: string; setup(): void; cliMs?: number; httpMs?: number; authFailsMs?: number }[] = [
	{
		name: "the CLI fails for the first 4 s after activation, then works",
		setup: () => fs.writeFileSync(path.join(root, ".sfdx", "sfdx-config.json"), JSON.stringify({ "target-org": USERNAME })),
		authFailsMs: 4000,
	},
	{
		name: "cold start with a slow CLI (3 s) and slow org (1.2 s)",
		setup: () => fs.writeFileSync(path.join(root, ".sfdx", "sfdx-config.json"), JSON.stringify({ "target-org": USERNAME })),
		cliMs: 3000,
		httpMs: 1200,
	},
	{
		name: "default org = username in .sfdx/sfdx-config.json",
		setup: () => fs.writeFileSync(path.join(root, ".sfdx", "sfdx-config.json"), JSON.stringify({ "target-org": USERNAME })),
	},
	{
		name: "no default configured (the CLI's global default)",
		setup: () => fs.rmSync(path.join(root, ".sfdx", "sfdx-config.json"), { force: true }),
	},
	{
		name: "default org = alias",
		setup: () => {
			fs.writeFileSync(path.join(root, ".sfdx", "sfdx-config.json"), JSON.stringify({ "target-org": "MyAlias" }));
			const aliasFile = path.join(root, "alias.json");
			fs.writeFileSync(aliasFile, JSON.stringify({ orgs: { MyAlias: USERNAME } }));
			setAliasFileForTests(aliasFile);
		},
	},
];

for (const scenario of SCENARIOS)
describe(`host → server completion (real host modules, real server, fake HTTP) — ${scenario.name}`, function () {
	this.timeout(60000);

	before(async () => {
		fs.mkdirSync(classes, { recursive: true });
		fs.mkdirSync(path.join(root, ".sfdx"), { recursive: true });
		fs.writeFileSync(path.join(root, "sfdx-project.json"), JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "62.0" }));
		net.log.length = 0;
		net.cliMs = scenario.cliMs ?? 0;
		net.httpMs = scenario.httpMs ?? 0;
		net.authFailsUntil = Date.now() + (scenario.authFailsMs ?? 0);
		waitMs = 4000 + (scenario.authFailsMs ?? 0) + (scenario.cliMs ?? 0) * 2 + (scenario.httpMs ?? 0) * 3;
		fs.rmSync(cacheDir, { recursive: true, force: true });
		scenario.setup();
		setWorkspaceFolders([root]);
		installFakes();
		resetHostState();
		DescribeStore.configurePersistence(cacheDir);

		const serverPath = path.join(__dirname, "..", "server.js");
		assert.ok(fs.existsSync(serverPath), "out/server.js must be built (run npm run compile)");
		child = cp.spawn("node", [serverPath, "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
		conn = rpc.createMessageConnection(new rpc.StreamMessageReader(child.stdout!), new rpc.StreamMessageWriter(child.stdin!));
		// The REAL host handlers, registered on the test connection (what LanguageClient.onRequest does).
		const t0 = Date.now();
		registerSchemaHostHandlers({
			onRequest: (method, handler) =>
				conn.onRequest(method, async (params: any) => {
					const started = Date.now() - t0;
					try {
						const r = await handler(params);
						if (process.env.E2E_TRACE) console.log(`  [host +${started}ms] ${method} ${JSON.stringify(params).slice(0, 60)} -> ${Array.isArray(r) ? r.length + " items" : r ? "ok" : String(r)} (${Date.now() - t0 - started}ms)`);
						return r;
					} catch (e: any) {
						if (process.env.E2E_TRACE) console.log(`  [host +${started}ms] ${method} ${JSON.stringify(params).slice(0, 60)} -> THROWS ${e?.code ?? ""} ${String(e?.message).slice(0, 80)}`);
						throw e;
					}
				}),
		});
		conn.onNotification("textDocument/publishDiagnostics", () => undefined);
		conn.listen();
		// What vscode-languageclient sends from src/languageClient.ts (same init options, VS Code-like capabilities).
		await conn.sendRequest("initialize", {
			processId: process.pid,
			clientInfo: { name: "Visual Studio Code" },
			rootUri: pathToFileURL(root).href,
			workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
			capabilities: {
				workspace: { applyEdit: true, workspaceFolders: true, semanticTokens: { refreshSupport: true }, didChangeWatchedFiles: { dynamicRegistration: true } },
				textDocument: {
					synchronization: { dynamicRegistration: true, willSave: true, didSave: true },
					completion: {
						dynamicRegistration: true,
						contextSupport: true,
						completionItem: { snippetSupport: true, commitCharactersSupport: true, documentationFormat: ["markdown", "plaintext"], deprecatedSupport: true, preselectSupport: true, labelDetailsSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] }, insertReplaceSupport: true },
						completionList: { itemDefaults: ["commitCharacters", "editRange", "insertTextFormat", "insertTextMode"] },
					},
					hover: { contentFormat: ["markdown", "plaintext"] },
					semanticTokens: { requests: { range: true, full: { delta: true } }, tokenTypes: [], tokenModifiers: [], formats: ["relative"] },
				},
			},
			initializationOptions: { apexFeatures: true, apexCompletion: true, apexValidateSchema: true, apexSemanticHighlighting: true, parseWorkers: 1 },
		});
		await conn.sendNotification("initialized", {});
	});

	after(() => {
		try { conn?.dispose(); } catch { /* ignore */ }
		try { child?.kill(); } catch { /* ignore */ }
		DescribeStore.shutdown();
		setAliasFileForTests(undefined);
		DescribeStore.configurePersistence(undefined);
		(https as any).request = origRequest;
		commandRunner.runCommandArgs = origRun;
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	const USER_SOQL = "List<User> users = [SELECT Signature FROM User WHERE Id = :UserInfo.getUserId() WITH USER_MODE];";

	it("users[0].Signature. → String instance methods", async () => {
		const labels = await eventually(
			async () => labelsOf(await completeAt(inMethod(`    ${USER_SOQL}\n    users[0].Signature.|`))),
			["replace", "contains"],
			"users[0].Signature.",
		);
		assert.ok(labels.includes("replace"));
	});

	it("users.get(0).Na → User fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod(`    ${USER_SOQL}\n    users.get(0).Na|`))),
			["Name"],
			"users.get(0).Na",
		);
	});

	it("users.get(0).Signature. → String methods", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod(`    ${USER_SOQL}\n    users.get(0).Signature.|`))),
			["replace"],
			"users.get(0).Signature.",
		);
	});

	it("User t = users.get(0); t.Na → User fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod(`    ${USER_SOQL}\n    User t = users.get(0);\n    t.Na|`))),
			["Name"],
			"t.Na",
		);
	});

	it("relationship hop: t.Manager. → User fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    User t;\n    t.Manager.|"))),
			["Name", "Signature"],
			"t.Manager.",
		);
	});

	it("inline query [SELECT Id FROM Account].Na → List methods; [..][0].Na → Account fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    Object o = [SELECT Id FROM Account].|"))),
			["size", "get"],
			"[SELECT Id FROM Account].",
		);
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    Object o = [SELECT Id FROM Account][0].Na|"))),
			["Name"],
			"[SELECT Id FROM Account][0].Na",
		);
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    Account a = [SELECT Id FROM Account LIMIT 1];\n    a.Na|"))),
			["Name"],
			"Account a = [... LIMIT 1]; a.Na",
		);
	});

	it("SOQL SELECT Na| FROM User (.soql file) → User fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt("SELECT Na| FROM User", "soql", "soql")),
			["Name"],
			"SELECT Na FROM User",
		);
	});

	it("SOQL inside Apex: [SELECT Na| FROM User] → User fields", async () => {
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    List<User> u = [SELECT Na| FROM User];"))),
			["Name"],
			"apex inline SELECT Na",
		);
	});

	it("traffic: gzip describeGlobal + describes went through the fake org once, no org spam", () => {
		const globals = net.log.filter((l) => /GET .*\/sobjects\/?$/.test(l)).length;
		assert.ok(globals >= 1, "object list was fetched");
		assert.ok(globals <= 2, `object list fetched ${globals}x`);
	});

	it("a restarted session serves from the persisted caches while the org is unreachable", async () => {
		DescribeStore.disposeAll(); // flush to disk, drop memory
		resetHostState();
		net.down = new Error("getaddrinfo ENOTFOUND fake-org.my.salesforce.com");
		try {
			await conn.sendNotification("sfx/refreshSchema");
			const labels = await eventually(
				async () => labelsOf(await completeAt(inMethod("    User t;\n    t.Na|"))),
				["Name"],
				"persisted describe while offline",
			);
			assert.ok(labels.includes("Name"));
		} finally {
			net.down = null;
		}
	});

	it("an unreachable org surfaces in schema health instead of failing silently", async () => {
		DescribeStore.clearPersisted(null);
		resetHostState();
		const problems: string[] = [];
		setSchemaHealthSink({ onProblem: (_o, kind, msg) => problems.push(`${kind}: ${msg}`), onRecovered: () => undefined });
		net.down = new Error("getaddrinfo ENOTFOUND fake-org.my.salesforce.com");
		try {
			await conn.sendNotification("sfx/refreshSchema");
			const until = Date.now() + waitMs;
			while (!problems.length && Date.now() < until) {
				await completeAt(inMethod("    Account a;\n    a.Na|"));
				await new Promise((r) => setTimeout(r, 250));
			}
			assert.ok(problems.length > 0, "the status bar sink must be told the org is unreachable");
			assert.match(problems[0], /unreachable/);
		} finally {
			net.down = null;
		}
	});

	it("recovers after the org comes back (no negative cache that never clears)", async () => {
		await conn.sendNotification("sfx/refreshSchema");
		resetHostState();
		await eventually(
			async () => labelsOf(await completeAt(inMethod("    User t;\n    t.Na|"))),
			["Name"],
			"recovery after outage",
		);
	});
});
