import * as assert from "assert";
import { buildReauthArgs, looksLikeSandboxUsername, parseLoginUsername } from "../utils/reauthArgsPure";
import { formatWarmupFailure } from "../utils/authInfoPure";

describe("reauthArgsPure", () => {
	it("bare login without a record", () => {
		assert.deepStrictEqual(buildReauthArgs(null), ["org", "login", "web"]);
	});
	it("uses alias and instance url", () => {
		assert.deepStrictEqual(
			buildReauthArgs({ alias: "uat", username: "a@b.com.uat", instanceUrl: "https://x.my.salesforce.com" }),
			["org", "login", "web", "--alias", "uat", "--instance-url", "https://x.my.salesforce.com"]
		);
	});
	it("sandbox without instance url uses test.salesforce.com", () => {
		assert.deepStrictEqual(buildReauthArgs({ username: "m@24flow.eu.partial" }), ["org", "login", "web", "--instance-url", "https://test.salesforce.com"]);
		assert.deepStrictEqual(buildReauthArgs({ username: "m@x.com", isSandbox: true }).slice(3), ["--instance-url", "https://test.salesforce.com"]);
	});
	it("production without instance url stays bare; explicit isSandbox=false wins", () => {
		assert.deepStrictEqual(buildReauthArgs({ username: "m@24flow.eu" }), ["org", "login", "web"]);
		assert.deepStrictEqual(buildReauthArgs({ username: "m@24flow.eu.partial", isSandbox: false }), ["org", "login", "web"]);
	});
	it("sandbox heuristic is conservative", () => {
		assert.ok(looksLikeSandboxUsername("m@24flow.eu.partial"));
		assert.ok(looksLikeSandboxUsername("m@acme.com.uat"));
		assert.ok(!looksLikeSandboxUsername("m@acme.com"));
		assert.ok(!looksLikeSandboxUsername("m@acme.co.uk"));
		assert.ok(!looksLikeSandboxUsername("nodomain"));
	});
	it("parses login username", () => {
		assert.strictEqual(parseLoginUsername('{"status":0,"result":{"username":"a@b.c"}}'), "a@b.c");
		assert.strictEqual(parseLoginUsername("garbage"), null);
	});
});

describe("formatWarmupFailure", () => {
	const json = JSON.stringify({ name: "NamedOrgNotFoundError", code: "X", message: "line one\nline two", stack: "at foo", cause: { name: "MyDomainResolverTimeoutError" } });
	it("one line from JSON message", () => {
		const s = formatWarmupFailure("org1", new Error(json));
		assert.ok(!s.includes("\n"));
		assert.ok(!s.includes("stack"));
		assert.ok(s.startsWith("AuthInfo: background auth warm-up failed (org1): NamedOrgNotFoundError/X: line one"));
		assert.ok(s.endsWith("deleted or refreshed)"));
	});
	it("object and DomainNotFoundError code", () => {
		const s = formatWarmupFailure(null, { name: "E", code: "DomainNotFoundError", message: "nope" });
		assert.ok(s.startsWith("AuthInfo: background auth warm-up failed: E/DomainNotFoundError: nope"));
		assert.ok(s.includes("domain doesn't resolve"));
	});
	it("plain error has no suffix", () => {
		assert.strictEqual(formatWarmupFailure("o", new Error("boom\nmore")), "AuthInfo: background auth warm-up failed (o): Error: boom");
	});
});

import { formatReauthHint, orgPickItems, reauthButtonLabel } from "../utils/reauthArgsPure";
import { onLoginCompletedHealth, reportSchemaFailure, getHealthState, reportSchemaSuccess } from "../utils/schemaHealth";

describe("reauth hint, picker and button label", () => {
	it("renders a valid hint (no --target-org)", () => {
		assert.strictEqual(formatReauthHint("m@x.com"), "sf org login web --alias m@x.com");
		assert.strictEqual(
			formatReauthHint("uat", { username: "m@x.com.uat", alias: "uat", instanceUrl: "https://x.my.salesforce.com" }),
			"sf org login web --alias uat --instance-url https://x.my.salesforce.com"
		);
		assert.strictEqual(formatReauthHint("m@24flow.eu.partial"), "sf org login web --alias m@24flow.eu.partial --instance-url https://test.salesforce.com");
		assert.ok(!formatReauthHint("a").includes("--target-org"));
	});
	it("builds picker items", () => {
		assert.deepStrictEqual(orgPickItems([{ label: "prod (default)", username: "a@b.com" }]), [{ label: "prod", description: "a@b.com", username: "a@b.com" }]);
	});
	it("button label", () => {
		assert.strictEqual(reauthButtonLabel("uat"), "Re-authenticate uat");
		assert.strictEqual(reauthButtonLabel(undefined), "Re-authenticate…");
		assert.strictEqual(reauthButtonLabel("__default__"), "Re-authenticate…");
	});
	it("login clears only the named org's problem", () => {
		reportSchemaFailure("a@x.com", "authInvalid" as any);
		reportSchemaFailure("b@x.com", "authInvalid" as any);
		onLoginCompletedHealth(["A@x.com"]);
		assert.strictEqual(getHealthState("a@x.com"), "ok");
		assert.notStrictEqual(getHealthState("b@x.com"), "ok");
		onLoginCompletedHealth();
		assert.strictEqual(getHealthState("b@x.com"), "ok");
		reportSchemaSuccess("b@x.com");
	});
});
