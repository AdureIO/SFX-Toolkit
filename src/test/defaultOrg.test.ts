import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveDefaultTargetOrgUsernameSync } from "../utils/defaultOrg";
import { readTargetOrgFromSfdxConfig } from "../utils/sfdxConfig";
import { getKnownTargetOrgUsername, setKnownTargetOrg, getDefaultUsernameFromOrgCache } from "../utils/orgListCache";
import { globalTargetOrg } from "../utils/sfdxConfigPure";

describe("sfdxConfig.readTargetOrgFromSfdxConfig", () => {
  it("reads target-org from sfdx-config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-test-"));
    const sfdxDir = path.join(dir, ".sfdx");
    fs.mkdirSync(sfdxDir);
    fs.writeFileSync(path.join(sfdxDir, "sfdx-config.json"), JSON.stringify({ "target-org": "sandbox@example.com" }));
    assert.strictEqual(readTargetOrgFromSfdxConfig(dir), "sandbox@example.com");
  });

  it("falls back to defaultusername", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-test-"));
    const sfdxDir = path.join(dir, ".sfdx");
    fs.mkdirSync(sfdxDir);
    fs.writeFileSync(path.join(sfdxDir, "sfdx-config.json"), JSON.stringify({ defaultusername: "legacy@example.com" }));
    assert.strictEqual(readTargetOrgFromSfdxConfig(dir), "legacy@example.com");
  });
});

describe("defaultOrg.resolveDefaultTargetOrgUsernameSync", () => {
  const prev = getKnownTargetOrgUsername();

  afterEach(() => {
    setKnownTargetOrg(prev);
  });

  it("prefers sfdx-config over session hint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-test-"));
    const sfdxDir = path.join(dir, ".sfdx");
    fs.mkdirSync(sfdxDir);
    fs.writeFileSync(path.join(sfdxDir, "sfdx-config.json"), JSON.stringify({ "target-org": "from-file" }));
    setKnownTargetOrg("from-session");
    assert.strictEqual(resolveDefaultTargetOrgUsernameSync(dir), "from-file");
  });

  it("uses session hint when config file is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-test-"));
    setKnownTargetOrg("hint-user", dir);
    assert.strictEqual(resolveDefaultTargetOrgUsernameSync(dir), "hint-user");
  });
});

describe("sfdxConfigPure.globalTargetOrg", () => {
  it("reads ~/.sf/config.json, then the legacy ~/.sfdx/sfdx-config.json", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-home-"));
    assert.strictEqual(globalTargetOrg(home), null);
    fs.mkdirSync(path.join(home, ".sfdx"));
    fs.writeFileSync(path.join(home, ".sfdx", "sfdx-config.json"), JSON.stringify({ defaultusername: "legacy@g.com" }));
    assert.strictEqual(globalTargetOrg(home), "legacy@g.com");
    fs.mkdirSync(path.join(home, ".sf"));
    fs.writeFileSync(path.join(home, ".sf", "config.json"), JSON.stringify({ "target-org": "global@g.com" }));
    assert.strictEqual(globalTargetOrg(home), "global@g.com");
  });
});

describe("orgListCache.getDefaultUsernameFromOrgCache", () => {
  it("answers from the given project's config, independent of which project the list came from", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfdx-test-"));
    fs.mkdirSync(path.join(dir, ".sfdx"));
    fs.writeFileSync(path.join(dir, ".sfdx", "sfdx-config.json"), JSON.stringify({ "target-org": "proj@x.com" }));
    assert.strictEqual(getDefaultUsernameFromOrgCache(dir), "proj@x.com");
  });
});
