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
	isUsableAccessToken,
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

import { cliRefreshesToken, recoverSession, RecoverDeps, CliRefreshResult } from "../utils/authHealthPure";

type A = { accessToken: string };

/** A scripted org: `cli` is the token `sf org display` returns now; `valid` the only token Salesforce accepts. */
function harness(opts: { cache: string | null; cli: () => string; valid: () => string; refreshResult?: CliRefreshResult; refreshRewrites?: string }) {
	const log: string[] = [];
	let cache: A | null = opts.cache ? { accessToken: opts.cache } : null;
	let cliTok = opts.cli;
	const deps: RecoverDeps<A, string> = {
		reread: async (failed) => {
			if (cache && cache.accessToken !== failed) return cache;
			cache = null;
			log.push("display");
			cache = { accessToken: cliTok() };
			return cache;
		},
		invalidate: () => {
			cache = null;
		},
		read: async () => {
			if (!cache) {
				log.push("display");
				cache = { accessToken: cliTok() };
			}
			return cache;
		},
		execute: async (a) => {
			log.push(`exec:${a.accessToken}`);
			if (a.accessToken !== opts.valid()) throw new Error("HTTP 401: INVALID_SESSION_ID");
			return "ok";
		},
		isSessionErr: (e) => /HTTP 401|INVALID_SESSION_ID/.test(String((e as Error).message)),
		refresh: async (f) => {
			log.push(`refresh:${f}`);
			if (opts.refreshRewrites) cliTok = () => opts.refreshRewrites!;
			cache = null; // the real refresh invalidates the cache
			return opts.refreshResult ?? { ok: true };
		},
		noCreds: () => new Error("no creds"),
		sessionError: (rr) => new Error(rr.ok ? "transient" : `confirmed:${rr.error}`),
		onRecovered: (_a, via) => log.push(`recovered:${via}`),
	};
	return { deps, log };
}

describe("authHealthPure: recoverSession (re-read before refresh)", () => {
	it("after `sf org open` the CLI already has a fresh token: re-read, retry, NO forced refresh", async () => {
		const h = harness({ cache: "OLD", cli: () => "NEW", valid: () => "NEW" });
		const r = await recoverSession({ accessToken: "OLD" }, h.deps);
		assert.strictEqual(r.auth.accessToken, "NEW");
		assert.deepStrictEqual(h.log, ["display", "exec:NEW", "recovered:reread"]);
	});
	it("uses a newer cached token without spawning anything", async () => {
		const h = harness({ cache: "NEW", cli: () => "X", valid: () => "NEW" });
		await recoverSession({ accessToken: "OLD" }, h.deps);
		assert.deepStrictEqual(h.log, ["exec:NEW", "recovered:reread"]);
	});
	it("CLI token unchanged: forces the refresh, then retries with the rewritten token", async () => {
		const h = harness({ cache: "OLD", cli: () => "OLD", valid: () => "FRESH", refreshRewrites: "FRESH" });
		const r = await recoverSession({ accessToken: "OLD" }, h.deps);
		assert.strictEqual(r.auth.accessToken, "FRESH");
		assert.deepStrictEqual(h.log, ["display", "refresh:OLD", "display", "exec:FRESH", "recovered:refresh"]);
	});
	it("never resends the failed token, even when the refresh does not change it", async () => {
		const h = harness({ cache: "OLD", cli: () => "OLD", valid: () => "NEVER" });
		await assert.rejects(recoverSession({ accessToken: "OLD" }, h.deps), /transient/);
		assert.strictEqual(h.log.filter((l) => l === "exec:OLD").length, 0);
		assert.strictEqual(h.log.filter((l) => l.startsWith("refresh:")).length, 2);
	});
	it("a refresh skipped by the refreshedFrom short-circuit still ends in a re-read, not a resend of the old token", async () => {
		// refresh() resolves ok without doing anything (late 401), the CLI token is unchanged
		const h = harness({ cache: "OLD", cli: () => "OLD", valid: () => "NEVER" });
		await assert.rejects(recoverSession({ accessToken: "OLD" }, h.deps));
		assert.ok(!h.log.includes("exec:OLD"));
	});
	it("CLI auth failure is confirmed with the CLI's reason; transient CLI failure is not", async () => {
		const bad = harness({ cache: "OLD", cli: () => "OLD", valid: () => "N", refreshResult: { ok: false, authError: true, error: "invalid_grant" } });
		await assert.rejects(recoverSession({ accessToken: "OLD" }, bad.deps), /confirmed:invalid_grant/);
	});
	it("a non-session error on the retry is rethrown as is", async () => {
		const h = harness({ cache: "OLD", cli: () => "NEW", valid: () => "NEW" });
		h.deps.execute = async () => {
			throw new Error("HTTP 500: boom");
		};
		await assert.rejects(recoverSession({ accessToken: "OLD" }, h.deps), /HTTP 500/);
	});
});

describe("authHealthPure: cliRefreshesToken", () => {
	it("org open, with and without org", () => {
		assert.deepStrictEqual(cliRefreshesToken(["sf", "org", "open", "-o", "a@b.com"]), { match: true, org: "a@b.com" });
		assert.deepStrictEqual(cliRefreshesToken(["sf", "org", "open", "--path", "/x"]), { match: true, org: null });
	});
	it("deploy / retrieve string commands (quoted args)", () => {
		assert.deepStrictEqual(cliRefreshesToken("sf project deploy start --target-org 'a@b.com' --json"), { match: true, org: "a@b.com" });
		assert.deepStrictEqual(cliRefreshesToken("sf project retrieve start --target-org=my"), { match: true, org: "my" });
	});
	it("apex run test", () => {
		assert.strictEqual(cliRefreshesToken(["sf", "apex", "run", "test"]).match, true);
	});
	it("our own auth reads and unrelated commands do not match", () => {
		assert.strictEqual(cliRefreshesToken(["sf", "org", "display", "--json"]).match, false);
		assert.strictEqual(cliRefreshesToken(["sf", "org", "display", "user", "--json"]).match, false);
		assert.strictEqual(cliRefreshesToken(["sf", "org", "list"]).match, false);
		assert.strictEqual(cliRefreshesToken("git status").match, false);
	});
});

import { MAX_SESSION_MS, MIN_SESSION_MS, clampSessionTimeoutMs, parseSessionTimeout, parseUserId, sessionTimeoutQuery, slidingExpiry } from "../utils/authHealthPure";

describe("authHealthPure: sliding session expiry", () => {
	const MIN = 60_000;
	it("slides to now + timeout - margin (margin = min(10 %, 2 min))", () => {
		assert.strictEqual(slidingExpiry({ now: 0, current: 0, sessionTimeoutMs: 30 * MIN }), 28 * MIN);
		assert.strictEqual(slidingExpiry({ now: 0, current: 0, sessionTimeoutMs: 10 * MIN }), 9 * MIN);
		assert.strictEqual(slidingExpiry({ now: 0, current: 0, sessionTimeoutMs: 5 * MIN }), 4.5 * MIN);
	});
	it("only extends, never shortens", () => {
		assert.strictEqual(slidingExpiry({ now: 0, current: 50 * MIN, sessionTimeoutMs: 30 * MIN }), 50 * MIN);
	});
	it("an explicit CLI expiration caps it", () => {
		assert.strictEqual(slidingExpiry({ now: 0, current: 0, sessionTimeoutMs: 120 * MIN, cliCap: 20 * MIN }), 20 * MIN);
	});
	it("unknown timeout falls back to the 10-min default; known timeout is clamped to 5 min..12 h", () => {
		assert.strictEqual(slidingExpiry({ now: 0, current: 0 }), 9 * MIN);
		assert.strictEqual(clampSessionTimeoutMs(undefined), 10 * MIN);
		assert.strictEqual(clampSessionTimeoutMs(NaN), 10 * MIN);
		assert.strictEqual(clampSessionTimeoutMs(0), 10 * MIN);
		assert.strictEqual(clampSessionTimeoutMs(60_000), MIN_SESSION_MS);
		assert.strictEqual(clampSessionTimeoutMs(48 * 3600_000), MAX_SESSION_MS);
		assert.strictEqual(clampSessionTimeoutMs(30 * MIN), 30 * MIN);
	});
	it("parses NumSecondsValid, clamped; absent / garbage -> undefined", () => {
		assert.strictEqual(parseSessionTimeout(JSON.stringify({ records: [{ NumSecondsValid: 7200 }] })), 7200_000);
		assert.strictEqual(parseSessionTimeout(JSON.stringify({ records: [{ NumSecondsValid: 30 }] })), MIN_SESSION_MS);
		assert.strictEqual(parseSessionTimeout(JSON.stringify({ records: [] })), undefined);
		assert.strictEqual(parseSessionTimeout("nope"), undefined);
	});
	it("query is only built for a plausible user id", () => {
		assert.ok(sessionTimeoutQuery("005xx000001Sv6AAAS")!.includes("UsersId = '005xx000001Sv6AAAS'"));
		assert.strictEqual(sessionTimeoutQuery("x' OR '1'='1"), undefined);
		assert.strictEqual(sessionTimeoutQuery(undefined), undefined);
	});
	it("parseUserId validates the userinfo user_id", () => {
		assert.strictEqual(parseUserId(JSON.stringify({ user_id: "005xx000001Sv6AAAS" })), "005xx000001Sv6AAAS");
		assert.strictEqual(parseUserId(JSON.stringify({ user_id: "x' OR '1'='1" })), undefined);
		assert.strictEqual(parseUserId(JSON.stringify({})), undefined);
		assert.strictEqual(parseUserId("nope"), undefined);
	});
});

describe("isUsableAccessToken", () => {
	it("accepts real-looking tokens", () => {
		assert.strictEqual(isUsableAccessToken("00D5g000004abcd!AQEAQxyz0123456789"), true);
		assert.strictEqual(isUsableAccessToken("abcDEF123.xyz"), true);
	});
	it("rejects placeholders and empties", () => {
		const long = "[REDACTED - run sf org auth show-access-token ...]";
		for (const v of ["[REDACTED]", long, "", undefined, null, "****", "abc def"]) {
			assert.strictEqual(isUsableAccessToken(v as any), false, String(v));
		}
	});
});
