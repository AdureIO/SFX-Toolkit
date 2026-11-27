import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
	buildDeleteArgs,
	buildDestructivePackage,
	confirmationMatches,
	deleteListing,
	destructiveConfirmText,
	escapeXml,
	normalizeApiVersion,
	parseDeleteOutcome,
} from "../utils/destructivePure";
import { buildTestArgs, normalizeTestNames, testLevelArgs } from "../utils/deployTestArgsPure";
import { runDestructiveDeploy } from "../utils/destructiveRun";

describe("destructive package builder", () => {
	it("an empty package.xml with the version, and destructiveChanges.xml with types and members sorted", () => {
		const r = buildDestructivePackage(
			[
				{ type: "ApexClass", fullName: "Zeta" },
				{ type: "CustomField", fullName: "Account.B__c" },
				{ type: "ApexClass", fullName: "Alpha" },
				{ type: "CustomField", fullName: "Account.A__c" },
			],
			"v62.0"
		);
		assert.strictEqual(
			r.packageXml,
			`<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>62.0</version>\n</Package>\n`
		);
		assert.strictEqual(
			r.destructiveXml,
			[
				`<?xml version="1.0" encoding="UTF-8"?>`,
				`<Package xmlns="http://soap.sforce.com/2006/04/metadata">`,
				`    <types>`,
				`        <members>Alpha</members>`,
				`        <members>Zeta</members>`,
				`        <name>ApexClass</name>`,
				`    </types>`,
				`    <types>`,
				`        <members>Account.A__c</members>`,
				`        <members>Account.B__c</members>`,
				`        <name>CustomField</name>`,
				`    </types>`,
				`    <version>62.0</version>`,
				`</Package>`,
				``,
			].join("\n")
		);
	});

	it("escapes XML in names and drops duplicates", () => {
		const r = buildDestructivePackage(
			[
				{ type: "Report", fullName: `Folder/A & B <"c">'` },
				{ type: "Report", fullName: `Folder/A & B <"c">'` },
			],
			"61.0"
		);
		assert.ok(r.destructiveXml.includes("<members>Folder/A &amp; B &lt;&quot;c&quot;&gt;&apos;</members>"));
		assert.strictEqual(r.destructiveXml.match(/<members>/g)?.length, 1);
		assert.strictEqual(escapeXml("a&b"), "a&amp;b");
	});

	it("API version forms", () => {
		assert.strictEqual(normalizeApiVersion("v67.0"), "67.0");
		assert.strictEqual(normalizeApiVersion("62"), "62.0");
		assert.strictEqual(normalizeApiVersion(" 61.0 "), "61.0");
		assert.throws(() => normalizeApiVersion("latest"), /Invalid API version/);
	});
});

describe("destructive: arguments and confirmation", () => {
	const base = { manifest: "/t/package.xml", destructive: "/t/destructiveChanges.xml", org: "me@x.org" };

	it("sf project deploy start --manifest … --post-destructive-changes … --target-org … --test-level … --json", () => {
		assert.deepStrictEqual(buildDeleteArgs({ ...base, testLevel: "NoTestRun" }), [
			"project", "deploy", "start",
			"--manifest", "/t/package.xml",
			"--post-destructive-changes", "/t/destructiveChanges.xml",
			"--target-org", "me@x.org",
			"--test-level", "NoTestRun",
			"--json",
		]);
	});

	it("specified tests are added for RunSpecifiedTests only; bad levels and names throw", () => {
		const a = buildDeleteArgs({ ...base, testLevel: "RunSpecifiedTests", specifiedTests: ["FooTest", "ns.BarTest.m1"] });
		assert.deepStrictEqual(a.slice(9, 15), ["--test-level", "RunSpecifiedTests", "--tests", "FooTest", "--tests", "ns.BarTest.m1"]);
		assert.ok(!buildDeleteArgs({ ...base, testLevel: "RunLocalTests", specifiedTests: ["FooTest"] }).includes("--tests"));
		assert.throws(() => buildDeleteArgs({ ...base, testLevel: "Everything" }), /Invalid test level/);
		assert.throws(() => buildDeleteArgs({ ...base, testLevel: "RunSpecifiedTests", specifiedTests: ["a; rm -rf /"] }), /Invalid Apex test name/);
	});

	it("the shared test-level helpers keep the Deploy panel's behaviour", () => {
		assert.strictEqual(buildTestArgs(["A", " B "]), "-t A -t B");
		assert.strictEqual(buildTestArgs("-t A -t B"), "-t A -t B");
		assert.deepStrictEqual(normalizeTestNames("--tests X Y"), ["X", "Y"]);
		assert.deepStrictEqual(testLevelArgs("RunRelevantTests"), ["--test-level", "RunRelevantTests"]);
	});

	it("typed confirmation: alias, else username; exact match", () => {
		assert.strictEqual(destructiveConfirmText({ alias: "prod", username: "a@b.c" }), "prod");
		assert.strictEqual(destructiveConfirmText({ username: "a@b.c" }), "a@b.c");
		assert.strictEqual(destructiveConfirmText({ alias: " ", username: "a@b.c" }), "a@b.c");
		assert.strictEqual(confirmationMatches(" prod ", "prod"), true);
		assert.strictEqual(confirmationMatches("Prod", "prod"), false);
		assert.strictEqual(confirmationMatches("", ""), false);
		assert.strictEqual(confirmationMatches(undefined, "prod"), false);
	});

	it("the modal listing: first 20, then +n more", () => {
		const comps = Array.from({ length: 23 }, (_, i) => ({ type: "ApexClass", fullName: `C${i}` }));
		const l = deleteListing(comps);
		assert.strictEqual(l.length, 21);
		assert.strictEqual(l[0], "ApexClass:C0");
		assert.strictEqual(l[20], "+3 more");
		assert.deepStrictEqual(deleteListing(comps.slice(0, 2)), ["ApexClass:C0", "ApexClass:C1"]);
	});
});

const OK_JSON = JSON.stringify({
	status: 0,
	result: {
		id: "0AfXX0000000001AAA",
		status: "Succeeded",
		numberComponentsDeployed: 2,
		numberComponentsTotal: 2,
		numberComponentErrors: 0,
		numberTestsCompleted: 0,
		numberTestErrors: 0,
		completedDate: "2026-11-23T10:00:00.000Z",
		details: { componentSuccesses: [{ fullName: "A", componentType: "ApexClass", deleted: true }] },
	},
});
const FAIL_JSON = JSON.stringify({
	status: 1,
	name: "DeployFailed",
	message: "Deploy failed.",
	result: {
		id: "0AfXX0000000002AAA",
		status: "Failed",
		numberComponentsDeployed: 0,
		numberComponentErrors: 1,
		details: { componentFailures: { fullName: "B", componentType: "ApexClass", problem: "In use by a trigger" } },
	},
});

describe("destructive: result parsing", () => {
	it("success: stats, id and completion time in the deploy panel's shape", () => {
		const o = parseDeleteOutcome({ stdout: OK_JSON, ok: true });
		assert.strictEqual(o.kind, "success");
		if (o.kind !== "success") return;
		assert.deepStrictEqual(o.stats, { components: 2, componentErrors: 0, testsPassed: 0, testsFailed: 0 });
		assert.strictEqual(o.deployId, "0AfXX0000000001AAA");
		assert.strictEqual(o.completedAt, Date.parse("2026-11-23T10:00:00.000Z"));
		assert.strictEqual(o.apiResult?.status, "Succeeded");
	});

	it("failure from the stdout of a non-zero exit: api result with the component failures", () => {
		const o = parseDeleteOutcome({ stdout: FAIL_JSON, error: "Command failed", ok: false });
		assert.strictEqual(o.kind, "failed");
		if (o.kind !== "failed") return;
		assert.strictEqual(o.stats.componentErrors, 1);
		assert.strictEqual(o.deployId, "0AfXX0000000002AAA");
		const f = o.apiResult?.details?.componentFailures;
		assert.strictEqual((f as { problem?: string }).problem, "In use by a trigger");
	});

	it("an error envelope without a deploy result is a failure with the CLI's message", () => {
		const o = parseDeleteOutcome({ stdout: JSON.stringify({ status: 1, name: "NoOrg", message: "No authorization information found for x." }), error: "boom", ok: false });
		assert.strictEqual(o.kind, "failed");
		if (o.kind !== "failed") return;
		assert.strictEqual(o.errorText, "No authorization information found for x.");
		assert.strictEqual(o.apiResult, undefined);
	});

	it("a Failed result is a failure even with exit code 0; no stdout at all uses the error text", () => {
		assert.strictEqual(parseDeleteOutcome({ stdout: FAIL_JSON, ok: true }).kind, "failed");
		const o = parseDeleteOutcome({ error: "spawn sf ENOENT", ok: false });
		assert.strictEqual(o.kind, "failed");
		if (o.kind === "failed") assert.strictEqual(o.errorText, "spawn sf ENOENT");
	});
});

describe("destructive: run with a fake sf", () => {
	const comps = [
		{ type: "ApexClass", fullName: "B" },
		{ type: "ApexClass", fullName: "A" },
		{ type: "Flow", fullName: "F" },
	];

	it("writes both files to a temp dir, runs the command in the project, removes the temp dir", async () => {
		let seen: { args: string[]; cwd: string; pkg: string; destr: string } | undefined;
		const res = await runDestructiveDeploy({
			projectDir: "/proj",
			org: "my-sbx",
			components: comps,
			testLevel: "RunLocalTests",
			apiVersion: "62.0",
			exec: async (args, cwd) => {
				const manifest = args[args.indexOf("--manifest") + 1];
				const destructive = args[args.indexOf("--post-destructive-changes") + 1];
				seen = { args, cwd, pkg: fs.readFileSync(manifest, "utf8"), destr: fs.readFileSync(destructive, "utf8") };
				assert.strictEqual(path.dirname(manifest), path.dirname(destructive));
				return OK_JSON;
			},
		});
		assert.ok(seen);
		assert.strictEqual(seen!.cwd, "/proj");
		assert.ok(seen!.args.join(" ").includes("--target-org my-sbx --test-level RunLocalTests --json"));
		assert.ok(seen!.pkg.includes("<version>62.0</version>") && !seen!.pkg.includes("<types>"));
		assert.ok(seen!.destr.indexOf("<members>A</members>") < seen!.destr.indexOf("<members>B</members>"));
		assert.strictEqual(res.outcome.kind, "success");
		assert.deepStrictEqual(res.types, ["ApexClass", "Flow"]);
		const dir = path.dirname(seen!.args[seen!.args.indexOf("--manifest") + 1]);
		assert.ok(!fs.existsSync(dir), "temp dir removed");
	});

	it("a rejected run is parsed from the error's stdout; a cancelled one is cancelled", async () => {
		const failed = await runDestructiveDeploy({
			projectDir: "/p",
			org: "o",
			components: comps,
			testLevel: "NoTestRun",
			apiVersion: "62.0",
			exec: async () => {
				throw Object.assign(new Error("Command failed"), { stdout: FAIL_JSON });
			},
		});
		assert.strictEqual(failed.outcome.kind, "failed");
		const cancelled = await runDestructiveDeploy({
			projectDir: "/p",
			org: "o",
			components: comps,
			testLevel: "NoTestRun",
			apiVersion: "62.0",
			exec: async () => {
				throw Object.assign(new Error("Command cancelled."), { cancelled: true });
			},
		});
		assert.strictEqual(cancelled.outcome.kind, "cancelled");
	});

	it("invalid input throws before anything runs", async () => {
		let ran = false;
		const exec = async () => {
			ran = true;
			return "";
		};
		await assert.rejects(() => runDestructiveDeploy({ projectDir: "/p", org: "o", components: [], testLevel: "NoTestRun", apiVersion: "62.0", exec }), /Nothing to delete/);
		await assert.rejects(() => runDestructiveDeploy({ projectDir: "/p", org: "o", components: comps, testLevel: "Nope", apiVersion: "62.0", exec }), /Invalid test level/);
		assert.strictEqual(ran, false);
	});
});
