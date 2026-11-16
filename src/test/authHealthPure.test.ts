import "./helpers/vscodeStub";
import * as assert from "assert";
import {
	AUTH_VALID_MS,
	AuthReprobeScheduler,
	buildSessionError,
	classifyRefreshOutcome,
	computeExpiresAt,
	describeCliFailure,
	healthKeyCandidates,
	isGenuineAuthCliError,
	nextReprobeDelayMs,
} from "../utils/authHealthPure";
import {
	classifySchemaError,
	getHealthState,
	healAuthProblem,
	reportSchemaFailure,
	setSchemaHealthSink,
} from "../utils/schemaHealth";

describe("authHealthPure: token lifetime", () => {
	it("caps at 10 minutes, honours a sooner CLI expiration", () => {
		assert.strictEqual(AUTH_VALID_MS, 600_000);
		assert.strictEqual(computeExpiresAt(undefined, 1000), 1000 + AUTH_VALID_MS);
		assert.strictEqual(computeExpiresAt(1000 + 2 * 3600_000, 1000), 1000 + AUTH_VALID_MS);
		assert.strictEqual(computeExpiresAt(1000 + 60_000, 1000), 1000 + 60_000);
		assert.strictEqual(computeExpiresAt(NaN, 1000), 1000 + AUTH_VALID_MS);
	});
});

describe("authHealthPure: CLI refresh classification", () => {
	it("success", () => assert.deepStrictEqual(classifyRefreshOutcome(undefined), { ok: true }));
	it("timeout / network / lock are NOT auth errors", () => {
		for (const m of ["Command timed out after 20000ms", "read ETIMEDOUT", "getaddrinfo ENOTFOUND x.my.salesforce.com", "EBUSY: resource busy", "Command exited with code 1"]) {
			const r = classifyRefreshOutcome(new Error(m));
			assert.strictEqual(r.ok, false, m);
			assert.strictEqual(r.authError, false, m);
		}
	});
	it("refresh-token errors are auth errors, reason extracted from JSON", () => {
		const e: any = new Error("exit");
		e.stdout = JSON.stringify({ name: "RefreshTokenAuthError", message: "Error authenticating with the refresh token due to: expired access/refresh token" });
		const r = classifyRefreshOutcome(e);
		assert.strictEqual(r.authError, true);
		assert.ok(r.error!.startsWith("RefreshTokenAuthError: Error authenticating"));
		assert.ok(isGenuineAuthCliError("invalid_grant"));
		assert.ok(!isGenuineAuthCliError(undefined));
	});
	it("describeCliFailure falls back to the first line", () => {
		assert.strictEqual(describeCliFailure(new Error("\nboom\nmore")), "boom");
	});
});

describe("authHealthPure: error classification with confirmation", () => {
	it("CLI auth error -> confirmed authInvalid incl. the CLI reason", () => {
		const err = buildSessionError({ ok: false, authError: true, error: "invalid_grant" }, "sf org login web");
		assert.strictEqual(classifySchemaError(err), "authInvalid");
		assert.ok(err.message.includes("invalid_grant"));
		assert.strictEqual(err.status, 401);
	});
	it("CLI refresh worked but request still rejected -> transient, not authInvalid", () => {
		const err = buildSessionError({ ok: true }, "sf org login web");
		assert.strictEqual(classifySchemaError(err), "transient");
	});
	it("CLI refresh failed transiently -> transient", () => {
		const err = buildSessionError({ ok: false, authError: false, error: "read ETIMEDOUT" }, "x");
		assert.strictEqual(classifySchemaError(err), "transient");
		assert.ok(err.message.includes("ETIMEDOUT"));
	});
	it("unconfirmed raw errors keep classifying as authInvalid (existing behaviour)", () => {
		assert.strictEqual(classifySchemaError(new Error("HTTP 401: nope")), "authInvalid");
	});
});

describe("authHealthPure: self-heal and key mapping", () => {
	beforeEach(() => setSchemaHealthSink(undefined));
	it("a success under any spelling clears the auth problem, case-insensitively", () => {
		reportSchemaFailure("Dev@Example.com", "authInvalid");
		assert.strictEqual(getHealthState("Dev@Example.com"), "authInvalid");
		healAuthProblem(healthKeyCandidates("dev@example.com", null, "myalias", undefined));
		assert.strictEqual(getHealthState("Dev@Example.com"), "ok");
	});
	it("clears unreachable too, leaves other orgs and noDefaultOrg alone", () => {
		reportSchemaFailure("a@x.com", "transient");
		reportSchemaFailure("b@x.com", "authInvalid");
		reportSchemaFailure("__default__", "noDefaultOrg");
		healAuthProblem(["a@x.com"]);
		assert.strictEqual(getHealthState("a@x.com"), "ok");
		assert.strictEqual(getHealthState("b@x.com"), "authInvalid");
		healAuthProblem(["__default__"]);
		assert.strictEqual(getHealthState("__default__"), "noDefaultOrg");
	});
	it("healthKeyCandidates dedupes and drops empties", () => {
		assert.deepStrictEqual(healthKeyCandidates("A@x.com", "a@x.com", null, "", "alias"), ["A@x.com", "alias"]);
	});
});

describe("authHealthPure: re-probe backoff", () => {
	it("1, 2, 5, 10 min then stays at 10", () => {
		assert.deepStrictEqual([0, 1, 2, 3, 4, 50].map(nextReprobeDelayMs), [60_000, 120_000, 300_000, 600_000, 600_000, 600_000]);
	});
	it("scheduler probes on schedule, never stops, forgets recovered orgs", () => {
		let t = 0;
		const s = new AuthReprobeScheduler(() => t);
		assert.deepStrictEqual(s.due(["a"]), []);
		t = 59_000;
		assert.deepStrictEqual(s.due(["a"]), []);
		t = 60_000;
		assert.deepStrictEqual(s.due(["a"]), ["a"]);
		t = 60_000 + 119_000;
		assert.deepStrictEqual(s.due(["a"]), []);
		t = 60_000 + 120_000;
		assert.deepStrictEqual(s.due(["a"]), ["a"]);
		t += 300_000;
		assert.deepStrictEqual(s.due(["a"]), ["a"]);
		for (let i = 0; i < 5; i++) {
			t += 600_000;
			assert.deepStrictEqual(s.due(["a"]), ["a"]);
		}
		assert.deepStrictEqual(s.due([]), []);
		t += 1;
		assert.deepStrictEqual(s.due(["a"]), []); // restarted schedule
	});
});
