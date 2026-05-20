import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveDefaultTargetOrgUsernameSync } from "../utils/defaultOrg";
import { readTargetOrgFromSfdxConfig } from "../utils/sfdxConfig";
import { getKnownTargetOrgUsername, setKnownTargetOrg } from "../utils/orgListCache";

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
    setKnownTargetOrg("hint-user");
    assert.strictEqual(resolveDefaultTargetOrgUsernameSync(dir), "hint-user");
  });
});
