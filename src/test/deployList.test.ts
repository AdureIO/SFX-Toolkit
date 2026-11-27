import * as assert from "assert";
import {
	DEPLOY_LIST_LIMIT,
	OrgDeployRow,
	deployRequestQuery,
	isUnsupportedQueryError,
	labelOfComponents,
	mergeDeployLists,
	okOfStatus,
	orgRowOfDeployResult,
	parseDeployDetails,
	parseDeployRequests,
} from "../utils/deployListPure";
import { HistoryEntry } from "../utils/historyPure";

const ID1 = "0Af000000000001AAA";
const ID2 = "0Af000000000002AAA";
const ID3 = "0Af000000000003AAA";

const record = (o: Record<string, unknown> = {}) => ({
	attributes: { type: "DeployRequest" },
	Id: ID1,
	Status: "Succeeded",
	StartDate: "2026-11-24T10:00:00.000+0000",
	CompletedDate: "2026-11-24T10:01:30.000+0000",
	CreatedDate: "2026-11-24T09:59:50.000+0000",
	CreatedBy: { attributes: { type: "User" }, Name: "Dieter Martens" },
	CheckOnly: false,
	NumberComponentsDeployed: 12,
	NumberComponentsTotal: 12,
	NumberComponentErrors: 0,
	NumberTestsCompleted: 40,
	NumberTestsTotal: 40,
	NumberTestErrors: 0,
	...o,
});

describe("DeployRequest query and parse", () => {
	it("builds the Tooling API query: newest first, limit 20, queued deploys (no start date) kept on top", () => {
		const q = deployRequestQuery();
		assert.ok(q.startsWith("SELECT Id, Status, StartDate, CompletedDate, CreatedDate, CreatedBy.Name, CheckOnly, NumberComponentsDeployed, NumberComponentsTotal, NumberComponentErrors, NumberTestsCompleted, NumberTestsTotal, NumberTestErrors"));
		assert.ok(q.includes("FROM DeployRequest ORDER BY StartDate DESC NULLS FIRST LIMIT 20"));
		assert.strictEqual(DEPLOY_LIST_LIMIT, 20);
		assert.ok(q.includes("ErrorMessage") && q.includes("TestLevel"));
		assert.ok(!deployRequestQuery({ level: "basic" }).includes("ErrorMessage"), "the reduced query has only the base fields");
		assert.ok(deployRequestQuery({ failedOnly: true }).includes("WHERE Status IN ('Failed', 'SucceededPartial', 'Canceled') ORDER BY"));
		assert.ok(!q.includes("WHERE"));
	});

	it("parses the records: dates, counts, who, check-only", () => {
		const rows = parseDeployRequests({ size: 2, totalSize: 2, done: true, records: [record(), record({ Id: ID2, Status: "Failed", CheckOnly: true, NumberComponentErrors: 2, NumberTestsCompleted: 5, NumberTestErrors: 1, NumberTestsTotal: 40, ErrorMessage: "boom", TestLevel: "RunLocalTests" })] });
		assert.strictEqual(rows.length, 2);
		const [a, b] = rows;
		assert.strictEqual(a.id, ID1);
		assert.strictEqual(a.createdBy, "Dieter Martens");
		assert.strictEqual(a.startedAt, Date.parse("2026-11-24T10:00:00.000+0000"));
		assert.strictEqual(a.completedAt, Date.parse("2026-11-24T10:01:30.000+0000"));
		assert.deepStrictEqual(a.components, { done: 12, total: 12, errors: 0 });
		assert.deepStrictEqual(a.tests, { done: 40, total: 40, errors: 0 });
		assert.strictEqual(a.checkOnly, false);
		assert.strictEqual(b.checkOnly, true);
		assert.deepStrictEqual(b.tests, { done: 6, total: 40, errors: 1 });
		assert.strictEqual(b.errorMessage, "boom");
		assert.strictEqual(b.testLevel, "RunLocalTests");
	});

	it("handles queued deploys (no dates, no user), junk and empty answers", () => {
		const [q] = parseDeployRequests({ records: [{ Id: ID3, Status: "Pending", StartDate: null, CompletedDate: null, CreatedDate: "2026-11-24T11:00:00.000+0000", CreatedBy: null }] });
		assert.strictEqual(q.startedAt, Date.parse("2026-11-24T11:00:00.000+0000"), "created date stands in for the start");
		assert.strictEqual(q.completedAt, undefined);
		assert.strictEqual(q.createdBy, undefined);
		assert.deepStrictEqual(parseDeployRequests({ records: [{ Status: "Succeeded" }, null, "x"] }), [], "rows without an id are dropped");
		assert.deepStrictEqual(parseDeployRequests(null), []);
		assert.deepStrictEqual(parseDeployRequests({ records: "no" }), []);
		assert.deepStrictEqual(parseDeployRequests([{ errorCode: "INVALID_TYPE" }]), []);
	});

	it("maps the status to ok", () => {
		assert.strictEqual(okOfStatus("Succeeded"), true);
		for (const s of ["Failed", "SucceededPartial", "Canceled"]) assert.strictEqual(okOfStatus(s), false, s);
		for (const s of ["Pending", "InProgress", "Canceling"]) assert.strictEqual(okOfStatus(s), null, s);
	});

	it("tells an unsupported object from an unsupported field", () => {
		assert.strictEqual(isUnsupportedQueryError("HTTP 400: [{\"message\":\"sObject type 'DeployRequest' is not supported.\",\"errorCode\":\"INVALID_TYPE\"}]"), "object");
		assert.strictEqual(isUnsupportedQueryError("HTTP 400: [{\"message\":\"No such column 'TestLevel' on entity 'DeployRequest'\",\"errorCode\":\"INVALID_FIELD\"}]"), "field");
		assert.strictEqual(isUnsupportedQueryError("HTTP 401: Session expired"), undefined);
		assert.strictEqual(isUnsupportedQueryError("getaddrinfo ENOTFOUND"), undefined);
	});

	it("reads a deployRequest result (the REST / CLI fallback) as a row", () => {
		const row = orgRowOfDeployResult({ id: ID1, status: "Failed", checkOnly: true, numberComponentsDeployed: 1, numberComponentsTotal: 3, numberComponentErrors: 2, numberTestsTotal: 0, createdDate: "2026-11-24T10:00:00.000Z", completedDate: "2026-11-24T10:02:00.000Z", createdByName: "Me" } as never);
		assert.ok(row);
		assert.strictEqual(row!.checkOnly, true);
		assert.strictEqual(row!.createdBy, "Me");
		assert.strictEqual(row!.completedAt! - row!.startedAt, 120000);
		assert.deepStrictEqual(row!.components, { done: 1, total: 3, errors: 2 });
		assert.strictEqual(orgRowOfDeployResult({} as never), undefined);
		assert.strictEqual(orgRowOfDeployResult(null), undefined);
	});
});

describe("deploy details", () => {
	it("maps component failures with their position and test failures with the stack", () => {
		const d = parseDeployDetails({
			status: "Failed",
			details: {
				componentFailures: [
					{ componentType: "ApexClass", fullName: "Foo", fileName: "classes/Foo.cls", lineNumber: 12, columnNumber: 5, problem: "Variable does not exist: x" },
					{ componentType: "CustomField", fullName: "Account.X__c", problem: "Required field missing", lineNumber: 0 },
				],
				runTestResult: {
					failures: [{ name: "FooTest", methodName: "testIt", message: "System.AssertException: Assertion Failed", stackTrace: "Class.FooTest.testIt: line 9, column 1", type: "Class" }, { name: "BarTest" }],
					codeCoverageWarnings: [{ name: "Foo", message: "Test coverage of selected Apex Class is 60%, at least 75% required" }, { message: "Average test coverage across all Apex Classes and Triggers is 60%" }],
				},
			},
		});
		assert.deepStrictEqual(d.componentErrors[0], { type: "ApexClass", name: "Foo", fileName: "classes/Foo.cls", line: 12, column: 5, message: "Variable does not exist: x" });
		assert.deepStrictEqual(d.componentErrors[1], { type: "CustomField", name: "Account.X__c", message: "Required field missing" }, "no position when the org gives 0");
		assert.deepStrictEqual(d.testErrors[0], { className: "FooTest", methodName: "testIt", message: "System.AssertException: Assertion Failed", stackTrace: "Class.FooTest.testIt: line 9, column 1" });
		assert.deepStrictEqual(d.testErrors[1], { className: "BarTest", message: "Test failed" });
		assert.deepStrictEqual(d.codeCoverageWarnings, ["Foo: Test coverage of selected Apex Class is 60%, at least 75% required", "Average test coverage across all Apex Classes and Triggers is 60%"]);
	});

	it("takes a single failure object (the API sends one object, not a list) and a warning-level problem", () => {
		const d = parseDeployDetails({ details: { componentFailures: { componentType: "Flow", fullName: "F", problem: "Check this", problemType: "Warning" } as never } });
		assert.strictEqual(d.componentErrors.length, 1);
		assert.strictEqual(d.componentErrors[0].message, "Warning: Check this");
		assert.strictEqual(d.codeCoverageWarnings, undefined);
	});

	it("a failed deploy with only a top-level message shows that message; a clean one shows nothing", () => {
		assert.deepStrictEqual(parseDeployDetails({ status: "Failed", errorMessage: "UNKNOWN_EXCEPTION: boom" }).componentErrors, [{ message: "UNKNOWN_EXCEPTION: boom" }]);
		assert.deepStrictEqual(parseDeployDetails({ status: "Succeeded" }), { componentErrors: [], testErrors: [] });
		assert.deepStrictEqual(parseDeployDetails(null), { componentErrors: [], testErrors: [] });
	});
});

const hist = (o: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: "h1",
	kind: "deploy",
	org: "me@x.org",
	at: Date.parse("2026-11-24T10:00:05.000Z"),
	durationMs: 80000,
	components: ["ApexClass:Foo", "ApexClass:Bar", "CustomField:Account.X__c"],
	componentCount: 3,
	ok: true,
	source: "center",
	...o,
});

const orgRow = (o: Partial<OrgDeployRow> = {}): OrgDeployRow => ({
	id: ID1,
	status: "Succeeded",
	checkOnly: false,
	createdBy: "Dieter Martens",
	startedAt: Date.parse("2026-11-24T10:00:00.000Z"),
	completedAt: Date.parse("2026-11-24T10:01:30.000Z"),
	components: { done: 12, total: 12, errors: 0 },
	tests: { done: 40, total: 40, errors: 0 },
	...o,
});

const opts = { orgLabel: "Prod", sameOrg: (o: string) => o === "me@x.org" };

describe("merging the org's deploys with the local history", () => {
	it("a local entry with the same deploy id enriches the org entry: label, source, component keys, kind", () => {
		const items = mergeDeployLists([orgRow()], [hist({ deployId: ID1, label: "Sprint 12 hotfix" } as Partial<HistoryEntry>)], opts);
		assert.strictEqual(items.length, 1);
		const i = items[0];
		assert.strictEqual(i.id, ID1);
		assert.strictEqual(i.deployId, ID1);
		assert.strictEqual(i.source, "both");
		assert.strictEqual(i.label, "Sprint 12 hotfix");
		assert.deepStrictEqual(i.componentKeys, ["ApexClass:Foo", "ApexClass:Bar", "CustomField:Account.X__c"]);
		assert.strictEqual(i.createdBy, "Dieter Martens", "the org's numbers and user are kept");
		assert.deepStrictEqual(i.components, { done: 12, total: 12, errors: 0 });
		assert.strictEqual(i.durationMs, 90000);
		assert.strictEqual(i.org, "Prod");
		assert.strictEqual(i.ok, true);
	});

	it("derives a label from the components when the entry has none, and uses the entry's kind (a delete is a deploy to the org)", () => {
		const [i] = mergeDeployLists([orgRow()], [hist({ deployId: ID1, kind: "delete" })], opts);
		assert.strictEqual(i.label, "Foo, Bar +1");
		assert.strictEqual(i.kind, "delete");
		assert.strictEqual(labelOfComponents(["ApexClass:Foo"]), "Foo");
		assert.strictEqual(labelOfComponents([]), undefined);
		assert.strictEqual(labelOfComponents(["A:x", "A:y"], 40), "x, y +38");
	});

	it("an org deploy nobody here knows is source org; a check-only one is a validate", () => {
		const [i] = mergeDeployLists([orgRow({ checkOnly: true })], [], opts);
		assert.strictEqual(i.source, "org");
		assert.strictEqual(i.kind, "validate");
		assert.strictEqual(i.componentKeys, undefined);
		assert.strictEqual(i.label, undefined);
	});

	it("keeps the local-only entries: retrieves, deletes, deploys the org list did not return", () => {
		const items = mergeDeployLists(
			[orgRow()],
			[
				hist({ id: "r1", kind: "retrieve", at: Date.parse("2026-11-24T12:00:00.000Z"), components: ["ApexClass:Foo"], componentCount: 1 }),
				hist({ id: "d1", kind: "delete", at: Date.parse("2026-11-24T11:00:00.000Z"), deployId: ID2, ok: false, errors: [{ component: "ApexClass:Foo", message: "in use" }], components: ["ApexClass:Foo", "ApexClass:Bar"], componentCount: 2 }),
			],
			opts
		);
		assert.deepStrictEqual(items.map((x) => x.id), ["r1", "d1", ID1], "newest first");
		const [r, d] = items;
		assert.strictEqual(r.source, "local");
		assert.strictEqual(r.kind, "retrieve");
		assert.strictEqual(r.status, "Succeeded");
		assert.strictEqual(r.deployId, undefined);
		assert.strictEqual(r.durationMs, 80000);
		assert.strictEqual(r.completedAt, r.startedAt + 80000);
		assert.deepStrictEqual(r.components, { done: 1, total: 1, errors: 0 });
		assert.strictEqual(d.deployId, ID2);
		assert.strictEqual(d.ok, false);
		assert.strictEqual(d.status, "Failed");
		assert.deepStrictEqual(d.components, { done: 1, total: 2, errors: 1 });
		assert.deepStrictEqual(d.componentKeys, ["ApexClass:Foo", "ApexClass:Bar"]);
	});

	it("ignores history of other orgs", () => {
		const items = mergeDeployLists([orgRow()], [hist({ id: "x", org: "other@y.org" }), hist({ id: "y", deployId: ID1, org: "other@y.org", kind: "delete" })], opts);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].source, "org");
		assert.strictEqual(items[0].kind, "deploy");
	});

	it("with no org answer (offline, no access) it is the history only", () => {
		const items = mergeDeployLists(undefined, [hist({ id: "a", at: 1 }), hist({ id: "b", at: 2 })], opts);
		assert.deepStrictEqual(items.map((i) => i.id), ["b", "a"]);
		assert.ok(items.every((i) => i.source === "local"));
		assert.deepStrictEqual(mergeDeployLists(undefined, [], opts), []);
	});

	it("failedOnly keeps what did not succeed (failed, partial, cancelled); pending ones are not failures", () => {
		const org = [orgRow({ id: ID1 }), orgRow({ id: ID2, status: "Failed", startedAt: 5 }), orgRow({ id: ID3, status: "InProgress", completedAt: undefined, startedAt: 6 })];
		const local = [hist({ id: "l1", ok: false, at: 7 }), hist({ id: "l2", ok: true, at: 8 })];
		const all = mergeDeployLists(org, local, opts);
		assert.strictEqual(all.length, 5);
		assert.strictEqual(all.find((i) => i.id === ID3)?.ok, null);
		assert.strictEqual(all.find((i) => i.id === ID3)?.durationMs, undefined);
		const failed = mergeDeployLists(org, local, { ...opts, failedOnly: true });
		assert.deepStrictEqual(failed.map((i) => i.id).sort(), [ID2, "l1"].sort());
		assert.ok(failed.every((i) => i.ok === false));
		assert.strictEqual(mergeDeployLists([orgRow({ status: "Canceled" })], [], { ...opts, failedOnly: true }).length, 1);
	});

	it("is newest first and capped", () => {
		const org = Array.from({ length: 30 }, (_, i) => orgRow({ id: `0Af${String(i).padStart(15, "0")}`, startedAt: 1000 + i }));
		const items = mergeDeployLists(org, [], { ...opts, limit: 10 });
		assert.strictEqual(items.length, 10);
		assert.strictEqual(items[0].startedAt, 1029);
		assert.ok(items.every((x, i) => i === 0 || items[i - 1].startedAt >= x.startedAt));
	});
});
