import "./helpers/vscodeStub";
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { targetOrgFromProjectDir } from "../utils/sfdxConfigPure";
import { resolveDefaultTargetOrgUsernameSync } from "../utils/defaultOrg";
import { getDefaultUsernameFromOrgCache, getKnownTargetOrgUsername, setKnownTargetOrg } from "../utils/orgListCache";

let tmp: string;
const write = (rel: string, body: unknown) => {
	const f = path.join(tmp, rel);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
};

describe("targetOrgFromProjectDir (.sf/config.json and .sfdx/sfdx-config.json)", () => {
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-cfg-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("reads .sf/config.json (CLI v2)", () => {
		write(".sf/config.json", { "target-org": "v2-alias" });
		assert.strictEqual(targetOrgFromProjectDir(tmp), "v2-alias");
	});

	it("reads .sfdx/sfdx-config.json (legacy) incl. defaultusername", () => {
		write(".sfdx/sfdx-config.json", { defaultusername: "legacy@example.com" });
		assert.strictEqual(targetOrgFromProjectDir(tmp), "legacy@example.com");
	});

	it("prefers .sf when both exist", () => {
		write(".sf/config.json", { "target-org": "new" });
		write(".sfdx/sfdx-config.json", { "target-org": "old" });
		assert.strictEqual(targetOrgFromProjectDir(tmp), "new");
	});

	it("falls through to .sfdx when .sf has no target-org or is unreadable", () => {
		write(".sf/config.json", { "target-dev-hub": "hub" });
		write(".sfdx/sfdx-config.json", { "target-org": "old" });
		assert.strictEqual(targetOrgFromProjectDir(tmp), "old");
		write(".sf/config.json", "{ not json");
		assert.strictEqual(targetOrgFromProjectDir(tmp), "old");
	});

	it("returns null when neither exists or the value is blank", () => {
		assert.strictEqual(targetOrgFromProjectDir(tmp), null);
		write(".sf/config.json", { "target-org": "  " });
		assert.strictEqual(targetOrgFromProjectDir(tmp), null);
	});
});

describe("global default-org fallbacks only answer for their own project", () => {
	afterEach(() => setKnownTargetOrg(null));

	it("the session hint applies to the project it was recorded for only", () => {
		const a = path.join(os.tmpdir(), "asfx-proj-a");
		const b = path.join(os.tmpdir(), "asfx-proj-b");
		setKnownTargetOrg("hint@example.com", a);
		assert.strictEqual(getKnownTargetOrgUsername(a), "hint@example.com");
		assert.strictEqual(getKnownTargetOrgUsername(b), null);
		assert.strictEqual(resolveDefaultTargetOrgUsernameSync(a), "hint@example.com");
		assert.strictEqual(resolveDefaultTargetOrgUsernameSync(b), null);
	});

	it("the org-list default flag does not answer for a project the list was not produced in", () => {
		assert.strictEqual(getDefaultUsernameFromOrgCache(path.join(os.tmpdir(), "asfx-proj-a")), null);
	});
});
