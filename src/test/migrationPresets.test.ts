import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listPresets, presetDirs, presetFileName, presetPath, PRESET_SUFFIX } from "../utils/migrationPresets";

/** A throwaway tree so the listing runs against real files rather than a stubbed fs. */
function makeTree(): { root: string; dirs: ReturnType<typeof presetDirs> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-presets-"));
  const dirs = { project: path.join(root, "project"), global: path.join(root, "global") };
  fs.mkdirSync(dirs.project, { recursive: true });
  fs.mkdirSync(dirs.global, { recursive: true });
  return { root, dirs };
}

function write(dir: string, name: string, mtime?: number): void {
  const file = path.join(dir, name + PRESET_SUFFIX);
  fs.writeFileSync(file, "{}", "utf8");
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
}

describe("migrationPresets.presetDirs", () => {
  const GLOBAL = "/Users/me/Library/Application Support/Code/User/globalStorage/adure.sfx";

  it("puts project presets with the project's own source", () => {
    const dirs = presetDirs("/work/app", GLOBAL);
    assert.strictEqual(dirs.project, path.join("/work/app", ".sfdx", "asfx", "migrations"));
  });

  it("puts global presets in the extension's own storage, never in the project", () => {
    const dirs = presetDirs("/work/app", GLOBAL);
    assert.strictEqual(dirs.global, path.join(GLOBAL, "migrations"));
    assert.ok(!dirs.global.includes("/work/app"));
  });
});

describe("migrationPresets.presetFileName", () => {
  it("keeps a readable name readable", () => {
    assert.strictEqual(presetFileName("Accounts and contacts"), "Accounts and contacts.migration.json");
  });

  it("strips what a file name cannot carry", () => {
    assert.strictEqual(presetFileName("prod/staging: v2"), "prod_staging_ v2.migration.json");
  });

  it("still produces a file for an empty name", () => {
    assert.strictEqual(presetFileName(""), "migration.migration.json");
    assert.strictEqual(presetFileName("///"), "migration.migration.json");
  });

  it("round-trips through presetPath", () => {
    assert.strictEqual(presetPath("/d", "Accounts"), path.join("/d", "Accounts.migration.json"));
  });
});

describe("migrationPresets.listPresets", () => {
  it("returns nothing when neither directory exists", () => {
    // A scope that was never used is empty, not an error.
    assert.deepStrictEqual(listPresets({ project: "/nope/a", global: "/nope/b" }), []);
  });

  it("labels each preset with the scope it came from", () => {
    const { dirs } = makeTree();
    write(dirs.project, "Local");
    write(dirs.global, "Shared");
    const found = listPresets(dirs);
    assert.strictEqual(found.find((p) => p.name === "Local")?.scope, "project");
    assert.strictEqual(found.find((p) => p.name === "Shared")?.scope, "global");
  });

  it("lets a project preset shadow a global one of the same name", () => {
    // The more specific location wins, the way it does for settings.
    const { dirs } = makeTree();
    write(dirs.project, "Accounts");
    write(dirs.global, "Accounts");
    const found = listPresets(dirs).filter((p) => p.name === "Accounts");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].scope, "project");
  });

  it("orders newest first", () => {
    const { dirs } = makeTree();
    write(dirs.project, "Older", Date.parse("2026-01-01"));
    write(dirs.project, "Newer", Date.parse("2026-06-01"));
    assert.deepStrictEqual(listPresets(dirs).map((p) => p.name), ["Newer", "Older"]);
  });

  it("still finds presets saved before there were scopes", () => {
    // They sit directly in .sfdx/asfx; an upgrade must not appear to lose them.
    const { root, dirs } = makeTree();
    const legacy = path.join(root, "legacy");
    fs.mkdirSync(legacy);
    write(legacy, "FromBefore");
    const found = listPresets(dirs, legacy);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].scope, "project");
  });

  it("ignores files that are not presets", () => {
    const { dirs } = makeTree();
    write(dirs.project, "Real");
    fs.writeFileSync(path.join(dirs.project, "notes.txt"), "x");
    fs.writeFileSync(path.join(dirs.project, "other.json"), "{}");
    assert.deepStrictEqual(listPresets(dirs).map((p) => p.name), ["Real"]);
  });
});
