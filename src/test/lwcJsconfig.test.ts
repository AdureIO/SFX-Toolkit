import * as assert from "assert";
import { buildLwcJsconfig, jsconfigNeedsUpdate, requiredIncludes } from "../utils/lwcJsconfig";

const TYPINGS = "../../../../.sfdx/typings/lwc";

describe("lwcJsconfig.buildLwcJsconfig", () => {
  it("creates a working config from nothing", () => {
    const c = buildLwcJsconfig(undefined, TYPINGS);
    const opts = c.compilerOptions!;
    assert.strictEqual(opts.experimentalDecorators, true, "@api/@track/@wire need decorators");
    assert.strictEqual(opts.baseUrl, ".");
    assert.strictEqual(opts.moduleResolution, "node");
    // c/foo resolves to foo/foo.js (nested) — and to foo for flat layouts.
    assert.deepStrictEqual((opts.paths as Record<string, string[]>)["c/*"], ["*/*", "*"]);
    // Component sources (incl. subdirectories) and the generated typings.
    assert.deepStrictEqual(c.include, requiredIncludes(TYPINGS));
    assert.ok(c.include!.includes("**/*"), "subdirectories inside a component are covered");
  });

  it("preserves settings it does not own", () => {
    const c = buildLwcJsconfig(
      { compilerOptions: { strict: true, target: "ES2017" }, include: ["custom/**"], typeAcquisition: { include: ["jest"] } },
      TYPINGS
    );
    assert.strictEqual(c.compilerOptions!.strict, true, "unrelated option kept");
    assert.strictEqual(c.compilerOptions!.target, "ES2017", "an existing target is not overridden");
    assert.deepStrictEqual(c.typeAcquisition, { include: ["jest"] }, "unknown top-level keys kept");
    assert.ok(c.include!.includes("custom/**"), "existing includes kept");
    assert.ok(c.include!.includes("**/*"), "required includes added");
  });

  it("repairs settings that break LWC even when already present", () => {
    const c = buildLwcJsconfig(
      { compilerOptions: { experimentalDecorators: false, baseUrl: "./src", moduleResolution: "classic" } },
      TYPINGS
    );
    assert.strictEqual(c.compilerOptions!.experimentalDecorators, true);
    assert.strictEqual(c.compilerOptions!.baseUrl, ".");
    assert.strictEqual(c.compilerOptions!.moduleResolution, "node");
  });

  it("merges into existing c/* paths without dropping them", () => {
    const c = buildLwcJsconfig({ compilerOptions: { paths: { "c/*": ["custom/*"], "x/*": ["y/*"] } } }, TYPINGS);
    const paths = c.compilerOptions!.paths as Record<string, string[]>;
    assert.deepStrictEqual(paths["c/*"], ["custom/*", "*/*", "*"]);
    assert.deepStrictEqual(paths["x/*"], ["y/*"], "other mappings kept");
  });

  it("does not duplicate entries when run twice", () => {
    const once = buildLwcJsconfig(undefined, TYPINGS);
    const twice = buildLwcJsconfig(once, TYPINGS);
    assert.deepStrictEqual(twice, once, "idempotent");
  });
});

describe("lwcJsconfig.jsconfigNeedsUpdate", () => {
  it("is true when missing or incomplete, false once repaired", () => {
    assert.strictEqual(jsconfigNeedsUpdate(undefined, TYPINGS), true);
    assert.strictEqual(jsconfigNeedsUpdate({ compilerOptions: {} }, TYPINGS), true);
    const good = buildLwcJsconfig(undefined, TYPINGS);
    assert.strictEqual(jsconfigNeedsUpdate(good, TYPINGS), false, "no needless rewrite");
  });
});
