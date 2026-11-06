import "./helpers/vscodeStub";
import * as assert from "assert";
import * as path from "path";
import { DEFAULT_ORG_KEY } from "../utils/orgKey";
import {
	NO_ORG_KEY,
	PROBLEM_THROTTLE_MS,
	applyNoDefaultOrgResult,
	classifyHealth,
	classifySchemaError,
	describeHealth,
	findProjectsWithoutDefaultOrg,
	getHealthState,
	getSchemaProblem,
	healthActions,
	onDefaultOrgChangedHealth,
	onLoginCompletedHealth,
	reportSchemaFailure,
	reportSchemaSuccess,
	selectActiveProject,
	setSchemaHealthSink,
	shouldNotify,
	schemaProblemMessage,
} from "../utils/schemaHealth";

const ORG = "dev@example.com";

describe("schemaHealth: classifier", () => {
	it("keeps the pure placeholder key equal to orgKey.DEFAULT_ORG_KEY", () => {
		assert.strictEqual(NO_ORG_KEY, DEFAULT_ORG_KEY);
	});

	const cases: [string, string, boolean?][] = [
		// no default org
		["No default environment found. Use -o or --target-org to specify an environment.", "noDefaultOrg"],
		["NoDefaultEnvError: No default environment found", "noDefaultOrg"],
		["Command failed: there is no default org set for this project", "noDefaultOrg"],
		["Requires a username but none was defined", "noDefaultOrg"],
		["Could not get org credentials. Set a default org or select one and try again. (NoDefaultEnvError: No default environment found.)", "noDefaultOrg"],
		// expired / invalid connection
		["INVALID_SESSION_ID: Session expired or invalid", "authInvalid"],
		['[{"message":"Session expired or invalid","errorCode":"INVALID_SESSION_ID"}]', "authInvalid"],
		["Error authenticating with the refresh token due to: expired access/refresh token", "authInvalid"],
		["expired access/refresh token", "authInvalid"],
		["Salesforce session expired or revoked. Re-authenticate your org: sf org login web --target-org a@b.c", "authInvalid"],
		["NamedOrgNotFoundError: No authorization information found for my-alias.", "authInvalid"],
		["No authorization information found for dev@example.com.", "authInvalid"],
		["NoOrgFound", "authInvalid"],
		["This org appears to have a problem with its OAuth configuration", "authInvalid"],
		["Could not get org credentials. Set a default org or select one and try again. (NamedOrgNotFoundError: No authorization information found for x.)", "authInvalid"],
		["HTTP 401: Unauthorized", "authInvalid"],
		// scratch org gone
		["ScratchOrgDeletedError: That scratch org has been deleted, so you can't connect to it anymore.", "authInvalid", true],
		["The scratch org has expired", "authInvalid", true],
		// unreachable
		["getaddrinfo ENOTFOUND fake-org.my.salesforce.com", "unreachable"],
		["Request timed out after 30000ms", "unreachable"],
		["HTTP 503: Service Unavailable", "unreachable"],
		["HTTP 429: REQUEST_LIMIT_EXCEEDED", "unreachable"],
		["Command failed: sf org display (transient CLI failure)", "unreachable"],
		// not a problem
		["HTTP 404: NOT_FOUND", "ok"],
	];

	for (const [text, state, scratch] of cases) {
		it(`"${text.slice(0, 60)}" -> ${state}${scratch ? " (scratch)" : ""}`, () => {
			const c = classifyHealth(new Error(text), ORG);
			assert.strictEqual(c.state, state);
			assert.strictEqual(!!c.scratchExpired, !!scratch);
		});
	}

	it("a bare 'no credentials' means no default org for the placeholder key, a broken connection for a named org", () => {
		const e = new Error("Could not get org credentials. Set a default org or select one and try again.");
		assert.strictEqual(classifyHealth(e, NO_ORG_KEY).state, "noDefaultOrg");
		assert.strictEqual(classifyHealth(e, ORG).state, "authInvalid");
		assert.strictEqual(classifySchemaError(e), "noCredentials");
	});

	it("nothing thrown is ok; an HTTP status attribute wins over the text", () => {
		assert.strictEqual(classifyHealth(undefined).state, "ok");
		assert.strictEqual(classifyHealth(Object.assign(new Error("x"), { status: 401 }), ORG).state, "authInvalid");
		assert.strictEqual(classifyHealth(Object.assign(new Error("x"), { status: 503 }), ORG).state, "unreachable");
	});

	it("messages follow the status bar wording", () => {
		assert.match(schemaProblemMessage("transient", ORG), /unreachable — using cached schema/);
		assert.match(schemaProblemMessage("authInvalid", "MyAlias"), /connection invalid \(MyAlias\).*--alias MyAlias/);
		assert.match(schemaProblemMessage("authInvalid", "MyAlias", true), /scratch org MyAlias has expired.*choose another org/);
		assert.match(schemaProblemMessage("noDefaultOrg", NO_ORG_KEY), /no default org/);
	});
});

describe("schemaHealth: state machine", () => {
	let changes = 0;
	let announced: string[] = [];
	let recovered: string[] = [];
	beforeEach(() => {
		changes = 0;
		announced = [];
		recovered = [];
		setSchemaHealthSink({
			onProblem: (org, kind) => announced.push(`${org}|${kind}`),
			onRecovered: (org) => recovered.push(org),
			onChange: () => changes++,
		});
	});
	after(() => setSchemaHealthSink(undefined));

	it("sets a problem per org and exposes its state", () => {
		reportSchemaFailure(ORG, "authInvalid", new Error("expired access/refresh token"));
		assert.strictEqual(getHealthState(ORG), "authInvalid");
		assert.strictEqual(getSchemaProblem(ORG)?.scratchExpired, false);
		reportSchemaFailure("other@example.com", "transient");
		assert.strictEqual(getHealthState("other@example.com"), "unreachable");
		assert.strictEqual(getHealthState("nobody@example.com"), "ok");
	});

	it("notFound is not a problem", () => {
		reportSchemaFailure(ORG, "notFound");
		assert.strictEqual(getHealthState(ORG), "ok");
		assert.strictEqual(changes, 0);
	});

	it("an expired scratch org is flagged on the problem", () => {
		reportSchemaFailure(ORG, "authInvalid", new Error("ScratchOrgDeletedError: That scratch org has been deleted"));
		assert.strictEqual(getSchemaProblem(ORG)?.scratchExpired, true);
		assert.strictEqual(describeHealth(getSchemaProblem(ORG), "Scratch1")?.canReauth, false);
	});

	it("clears on the first success for that org, and only that org", () => {
		reportSchemaFailure(ORG, "transient");
		reportSchemaFailure("b@example.com", "transient");
		reportSchemaSuccess(ORG);
		assert.strictEqual(getHealthState(ORG), "ok");
		assert.strictEqual(getHealthState("b@example.com"), "unreachable");
		assert.deepStrictEqual(recovered, [ORG]);
		reportSchemaSuccess(ORG); // already clear: silent
		assert.deepStrictEqual(recovered, [ORG]);
	});

	it("moves between states for the same org (unreachable -> authInvalid)", () => {
		reportSchemaFailure(ORG, "transient");
		reportSchemaFailure(ORG, "authInvalid");
		assert.strictEqual(getHealthState(ORG), "authInvalid");
	});

	it("clears 'no default org' when the default org changes", () => {
		reportSchemaFailure(NO_ORG_KEY, "noDefaultOrg");
		reportSchemaFailure(ORG, "authInvalid");
		onDefaultOrgChangedHealth();
		assert.strictEqual(getHealthState(NO_ORG_KEY), "ok");
		assert.strictEqual(getHealthState(ORG), "authInvalid", "other orgs keep their own state");
	});

	it("a completed login clears connection problems (not 'unreachable' or 'no default org')", () => {
		reportSchemaFailure(ORG, "authInvalid");
		reportSchemaFailure("b@example.com", "transient");
		reportSchemaFailure(NO_ORG_KEY, "noDefaultOrg");
		onLoginCompletedHealth();
		assert.strictEqual(getHealthState(ORG), "ok");
		assert.strictEqual(getHealthState("b@example.com"), "unreachable");
		assert.strictEqual(getHealthState(NO_ORG_KEY), "noDefaultOrg");
	});

	it("announces once per throttle window, but keeps the problem persistent", () => {
		const realNow = Date.now;
		let now = 1_000_000;
		Date.now = () => now;
		try {
			reportSchemaFailure(ORG, "authInvalid");
			reportSchemaFailure(ORG, "authInvalid");
			reportSchemaFailure(ORG, "authInvalid");
			assert.strictEqual(announced.length, 1);
			now += PROBLEM_THROTTLE_MS + 1;
			reportSchemaFailure(ORG, "authInvalid");
			assert.strictEqual(announced.length, 2);
			assert.strictEqual(getHealthState(ORG), "authInvalid");
		} finally {
			Date.now = realNow;
		}
	});

	it("applyNoDefaultOrgResult sets and clears the shared problem", () => {
		applyNoDefaultOrgResult(["/p"]);
		assert.strictEqual(getHealthState(NO_ORG_KEY), "noDefaultOrg");
		applyNoDefaultOrgResult([]);
		assert.strictEqual(getHealthState(NO_ORG_KEY), "ok");
		// it never wipes a different problem on the placeholder key
		reportSchemaFailure(NO_ORG_KEY, "transient");
		applyNoDefaultOrgResult([]);
		assert.strictEqual(getHealthState(NO_ORG_KEY), "unreachable");
	});
});

describe("schemaHealth: popup throttling", () => {
	beforeEach(() => setSchemaHealthSink(undefined));

	it("at most one popup per org and state per session", () => {
		assert.strictEqual(shouldNotify(ORG, "authInvalid"), true);
		assert.strictEqual(shouldNotify(ORG, "authInvalid"), false);
		assert.strictEqual(shouldNotify(ORG, "noDefaultOrg"), true, "another state is a new popup");
		assert.strictEqual(shouldNotify("b@example.com", "authInvalid"), true, "another org is a new popup");
	});

	it("never pops up for offline or ok", () => {
		assert.strictEqual(shouldNotify(ORG, "unreachable"), false);
		assert.strictEqual(shouldNotify(ORG, "ok"), false);
	});

	it("a clear does not re-arm the popup", () => {
		assert.strictEqual(shouldNotify(ORG, "authInvalid"), true);
		reportSchemaFailure(ORG, "authInvalid");
		reportSchemaSuccess(ORG);
		assert.strictEqual(shouldNotify(ORG, "authInvalid"), false);
	});
});

describe("schemaHealth: no default org detection", () => {
	it("a project is flagged only when the sync sources and the CLI both have no default", async () => {
		const asked: string[] = [];
		const missing = await findProjectsWithoutDefaultOrg(["/a", "/b", "/c"], {
			resolveSync: (d) => (d === "/a" ? "dev@example.com" : null),
			resolveCli: async (d) => {
				asked.push(d);
				return d === "/b" ? "global@example.com" : null;
			},
		});
		assert.deepStrictEqual(missing, ["/c"]);
		assert.deepStrictEqual(asked, ["/b", "/c"], "the CLI is only asked when the cheap sources are empty");
	});

	it("a failing CLI counts as no default", async () => {
		const missing = await findProjectsWithoutDefaultOrg(["/a"], {
			resolveSync: () => null,
			resolveCli: async () => {
				throw new Error("boom");
			},
		});
		assert.deepStrictEqual(missing, ["/a"]);
	});
});

describe("schemaHealth: active project selection", () => {
	const root = path.resolve("/ws");
	const nested = path.join(root, "billing");
	const deeper = path.join(nested, "inner");

	it("the deepest project containing the active file wins", () => {
		const dirs = [root, nested, deeper];
		assert.strictEqual(selectActiveProject(path.join(deeper, "force-app", "A.cls"), dirs, root), deeper);
		assert.strictEqual(selectActiveProject(path.join(nested, "force-app", "A.cls"), dirs, root), nested);
		assert.strictEqual(selectActiveProject(path.join(root, "force-app", "A.cls"), dirs, root), root);
	});

	it("falls back to the primary project without an editor or outside every project", () => {
		assert.strictEqual(selectActiveProject(undefined, [root, nested], root), root);
		assert.strictEqual(selectActiveProject(path.resolve("/elsewhere/A.cls"), [root, nested], root), root);
		assert.strictEqual(selectActiveProject(undefined, [], undefined), undefined);
	});

	it("does not confuse sibling folders sharing a prefix", () => {
		const other = path.join(root, "billing-old");
		assert.strictEqual(selectActiveProject(path.join(other, "A.cls"), [root, nested], root), root);
	});
});

describe("schemaHealth: status bar content and actions", () => {
	it("texts match the spec", () => {
		reportSchemaFailure(NO_ORG_KEY, "noDefaultOrg");
		reportSchemaFailure(ORG, "authInvalid");
		reportSchemaFailure("c@example.com", "transient");
		const nd = describeHealth(getSchemaProblem(NO_ORG_KEY), NO_ORG_KEY)!;
		assert.strictEqual(nd.text, "$(warning) ASFX: no default org");
		assert.strictEqual(nd.tooltip, "Schema completion, validation and org features need a default org for this project.");
		assert.strictEqual(describeHealth(getSchemaProblem(ORG), "MyAlias")!.text, "$(error) ASFX: org connection invalid (MyAlias)");
		assert.strictEqual(describeHealth(getSchemaProblem("c@example.com"), "c")!.text, "$(cloud-offline) ASFX: org unreachable — using cached schema");
		assert.strictEqual(describeHealth(undefined, ORG), undefined);
		setSchemaHealthSink(undefined);
	});

	it("quick pick offers the one-click fixes", () => {
		const nd = describeHealth({ orgKey: NO_ORG_KEY, kind: "noDefaultOrg", state: "noDefaultOrg", scratchExpired: false, message: "", at: 0 }, null)!;
		assert.deepStrictEqual(healthActions(nd).map((a) => a.label), ["Set default org…", "Create scratch org…", "Dismiss"]);
		assert.deepStrictEqual(healthActions(nd, false).map((a) => a.id), ["setDefaultOrg", "dismiss"]);
		const ai = describeHealth({ orgKey: ORG, kind: "authInvalid", state: "authInvalid", scratchExpired: false, message: "", at: 0 }, "a")!;
		assert.deepStrictEqual(healthActions(ai).map((a) => a.label), ["Re-authenticate (sf org login web)", "Choose another default org…", "Show details"]);
		const sx = describeHealth({ orgKey: ORG, kind: "authInvalid", state: "authInvalid", scratchExpired: true, message: "", at: 0 }, "a")!;
		assert.ok(!healthActions(sx).some((a) => a.id === "reauth"), "an expired scratch org cannot be re-authenticated");
		assert.ok(healthActions(sx).some((a) => a.id === "chooseOrg"));
	});
});
