import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { loadDeploySelection, type TreeNode } from "../utils/deploySelectionPure";

const ds = loadDeploySelection();

const f = (p: string): TreeNode => ({ label: p.split("/").pop(), path: p });
const d = (p: string, children: TreeNode[]): TreeNode => ({ label: p.split("/").pop(), path: p, children });

const CMD = "force-app/main/default/customMetadata";
const tree: TreeNode[] = [
  d("force-app", [
    d(CMD, [f(`${CMD}/Xpower_Field_Mapping.Third_Party_Account.md-meta.xml`), f(`${CMD}/Xpower_Field_Mapping.Other.md-meta.xml`)]),
    d("force-app/main/default/classes", [f("force-app/main/default/classes/A.cls"), f("force-app/main/default/classes/B.cls")]),
    d("force-app/main/default/objects", [
      d("force-app/main/default/objects/Account", [
        d("force-app/main/default/objects/Account/fields", [f("force-app/main/default/objects/Account/fields/X__c.field-meta.xml")]),
      ]),
    ]),
  ]),
];
const third = `${CMD}/Xpower_Field_Mapping.Third_Party_Account.md-meta.xml`;
const other = `${CMD}/Xpower_Field_Mapping.Other.md-meta.xml`;

describe("deploySelectionPure.dsMinimalPaths", () => {
  it("filter hides one of two siblings, one selected -> only that file", () => {
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, new Set([third])), [third]);
  });

  it("all leaves of a folder selected -> folder path emitted, leaves dropped", () => {
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, new Set([third, other])), [CMD]);
  });

  it("selected leaves of different folders stay individual", () => {
    const r = ds.dsMinimalPaths(tree, new Set([third, "force-app/main/default/classes/A.cls"]));
    assert.deepStrictEqual(r.sort(), [third, "force-app/main/default/classes/A.cls"].sort());
  });

  it("everything selected -> the package root only", () => {
    const all = new Set([third, other, "force-app/main/default/classes/A.cls", "force-app/main/default/classes/B.cls", "force-app/main/default/objects/Account/fields/X__c.field-meta.xml"]);
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, all), ["force-app"]);
  });

  it("nested single-child chain: full selection emits the highest fully-selected folder", () => {
    const x = "force-app/main/default/objects/Account/fields/X__c.field-meta.xml";
    const r = ds.dsMinimalPaths(tree, new Set([x, third]));
    assert.deepStrictEqual(r.sort(), ["force-app/main/default/objects", third].sort());
  });

  it("empty selection -> nothing", () => {
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, new Set()), []);
  });

  it("extra (git/preset) paths not in the tree are emitted as-is, de-duplicated and normalized", () => {
    const r = ds.dsMinimalPaths(tree, new Set([third, "./scripts/foo.sh", "scripts\\foo.sh"]));
    assert.deepStrictEqual(r, [third, "scripts/foo.sh"]);
  });

  it("a selected path that is a tree folder is treated as all leaves under it", () => {
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, new Set([CMD])), [CMD]);
  });

  it("works on a collapsed-looking (merged) subtree: a merged node path never widens", () => {
    // The panel's collapsed render uses the deepest folder path; selecting its only leaf must not emit a parent.
    const r = ds.dsMinimalPaths(tree, new Set(["force-app/main/default/objects/Account/fields/X__c.field-meta.xml"]));
    assert.deepStrictEqual(r, ["force-app/main/default/objects"]); // only leaf under objects => whole subtree is selected
    const r2 = ds.dsMinimalPaths(tree, new Set(["force-app/main/default/classes/B.cls"]));
    assert.deepStrictEqual(r2, ["force-app/main/default/classes/B.cls"]);
  });
});

describe("deploySelectionPure.dsFolderState", () => {
  const idx = ds.dsBuildIndex(tree);
  it("indeterminate when only some leaves (visible or hidden) are selected", () => {
    assert.strictEqual(ds.dsFolderState(idx, new Set([third]), CMD), "indeterminate");
  });
  it("checked only when all leaves in the FULL tree are selected", () => {
    assert.strictEqual(ds.dsFolderState(idx, new Set([third, other]), CMD), "checked");
  });
  it("unchecked when none selected / unknown folder", () => {
    assert.strictEqual(ds.dsFolderState(idx, new Set(), CMD), "unchecked");
    assert.strictEqual(ds.dsFolderState(idx, new Set([third]), "nope"), "unchecked");
  });
  it("ancestor folder is indeterminate when a descendant folder is fully selected but siblings are not", () => {
    assert.strictEqual(ds.dsFolderState(idx, new Set([third, other]), "force-app"), "indeterminate");
  });
});

describe("deploySelectionPure.dsApplyFolderToggle", () => {
  it("folder click under a filter selects only the visible leaves", () => {
    const next = ds.dsApplyFolderToggle(new Set(), [third], true);
    assert.deepStrictEqual(Array.from(next), [third]);
    const idx = ds.dsBuildIndex(tree);
    assert.strictEqual(ds.dsFolderState(idx, next, CMD), "indeterminate");
    assert.deepStrictEqual(ds.dsMinimalPaths(tree, next), [third]);
  });
  it("unchecking only removes visible leaves, hidden selections survive", () => {
    const next = ds.dsApplyFolderToggle(new Set([third, other]), [third], false);
    assert.deepStrictEqual(Array.from(next), [other]);
  });
  it("does not mutate the input set", () => {
    const base = new Set([other]);
    ds.dsApplyFolderToggle(base, [third], true);
    assert.deepStrictEqual(Array.from(base), [other]);
  });
});

describe("deploySelectionPure.dsCountByLeaf", () => {
  it("normalizes and de-duplicates", () => {
    assert.deepStrictEqual(ds.dsCountByLeaf(["a/b", "./a/b", "a\\b", ""]), ["a/b"]);
  });
});

describe("DeployMetadataPanelProvider wiring", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "providers", "DeployMetadataPanelProvider.ts"), "utf8");
  it("inlines the shared selection source", () => {
    assert.ok(src.includes("${DEPLOY_SELECTION_SOURCE}"));
  });
  it("getMinimalSourcePaths never reads folder checkbox state", () => {
    const start = src.indexOf("function getMinimalSourcePaths()");
    const end = src.indexOf("function getCurrentPresetState()");
    const body = src.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.ok(!body.includes(".path-check:checked"));
    assert.ok(body.includes("dsMinimalPaths("));
  });
});
