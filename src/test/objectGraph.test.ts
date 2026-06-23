import * as assert from "assert";
import { buildObjectGraph } from "../utils/objectGraph";
import type { SObjectDescribe } from "../utils/orgMetadataCache";

/** Tiny describe factory. refs: [fieldName, [targets...]]; children: childSObject names. */
function describe_(
  refs: [string, string[]][] = [],
  children: string[] = [],
  scalars: string[] = ["Id", "Name"]
): SObjectDescribe {
  return {
    fields: [
      ...scalars.map((name) => ({ name, type: name === "Id" ? "id" : "string" })),
      ...refs.map(([name, referenceTo]) => ({ name, type: "reference", referenceTo, relationshipName: name.replace(/Id$/, "") }))
    ],
    childRelationships: children.map((childSObject) => ({ childSObject, relationshipName: childSObject + "s" }))
  };
}

describe("objectGraph.buildObjectGraph", () => {
  it("includes seed + 1-hop parents and children, edges only among the set", () => {
    const describes = new Map<string, SObjectDescribe>([
      ["Case", describe_([["AccountId", ["Account"]], ["ContactId", ["Contact"]]], ["CaseComment"])],
      ["Account", describe_([], ["Case", "Contact"])],
      ["Contact", describe_([["AccountId", ["Account"]]], [])],
      ["CaseComment", describe_([["ParentId", ["Case"]]], [])]
    ]);

    const g = buildObjectGraph(["Case"], describes);
    const ids = g.nodes.map((n) => n.id).sort();
    // Case (seed) + parents Account, Contact + child CaseComment.
    assert.deepStrictEqual(ids, ["Account", "Case", "CaseComment", "Contact"]);

    // Seed flag.
    assert.strictEqual(g.nodes.find((n) => n.id === "Case")!.isSeed, true);
    assert.strictEqual(g.nodes.find((n) => n.id === "Account")!.isSeed, false);

    // Contact.AccountId -> Account is drawn (both neighbours in scope).
    assert.ok(g.edges.some((e) => e.source === "Contact" && e.target === "Account"));
    // Case edges to its parents.
    assert.ok(g.edges.some((e) => e.source === "Case" && e.target === "Account" && e.via === "AccountId"));
    assert.ok(g.edges.some((e) => e.source === "Case" && e.target === "Contact"));
  });

  it("does not expand neighbours beyond 1 hop", () => {
    const describes = new Map<string, SObjectDescribe>([
      ["Case", describe_([["AccountId", ["Account"]]], [])],
      ["Account", describe_([["OwnerId", ["User"]]], ["Opportunity"])],
      ["User", describe_()],
      ["Opportunity", describe_()]
    ]);
    const g = buildObjectGraph(["Case"], describes);
    const ids = g.nodes.map((n) => n.id).sort();
    // Account is a neighbour; its parent User and child Opportunity must NOT appear.
    assert.deepStrictEqual(ids, ["Account", "Case"]);
    // And no edge to the out-of-scope User.
    assert.ok(!g.edges.some((e) => e.target === "User"));
  });

  it("handles polymorphic references (all targets, flagged)", () => {
    const describes = new Map<string, SObjectDescribe>([
      ["Case", describe_([["OwnerId", ["User", "Group"]]], [])],
      ["User", describe_()],
      ["Group", describe_()]
    ]);
    const g = buildObjectGraph(["Case"], describes);
    assert.deepStrictEqual(g.nodes.map((n) => n.id).sort(), ["Case", "Group", "User"]);
    const owner = g.edges.filter((e) => e.via === "OwnerId");
    assert.strictEqual(owner.length, 2);
    assert.ok(owner.every((e) => e.polymorphic === true));
  });

  it("handles self references", () => {
    const describes = new Map<string, SObjectDescribe>([
      ["Account", describe_([["ParentId", ["Account"]]], [])]
    ]);
    const g = buildObjectGraph(["Account"], describes);
    assert.deepStrictEqual(g.nodes.map((n) => n.id), ["Account"]);
    const loop = g.edges.find((e) => e.source === "Account" && e.target === "Account");
    assert.ok(loop && loop.selfRef === true);
  });

  it("caps children per seed and records the dropped ones", () => {
    const children = Array.from({ length: 10 }, (_, i) => "Child" + String(i).padStart(2, "0"));
    const describes = new Map<string, SObjectDescribe>([["Account", describe_([], children)]]);
    const g = buildObjectGraph(["Account"], describes, { childCap: 3 });
    // 1 seed + 3 kept children = 4 nodes.
    assert.strictEqual(g.nodes.length, 4);
    assert.strictEqual(g.truncated.length, 1);
    assert.ok(g.truncated[0].startsWith("Account:"));
    // Deterministic order → first three alphabetically kept.
    assert.ok(g.nodes.some((n) => n.id === "Child00"));
    assert.ok(!g.nodes.some((n) => n.id === "Child09"));
  });

  it("splits reference vs all fields for node detail toggle", () => {
    const describes = new Map<string, SObjectDescribe>([
      ["Case", describe_([["AccountId", ["Account"]]], [])],
      ["Account", describe_()]
    ]);
    const g = buildObjectGraph(["Case"], describes);
    const caseNode = g.nodes.find((n) => n.id === "Case")!;
    assert.strictEqual(caseNode.referenceFields.length, 1);
    assert.strictEqual(caseNode.referenceFields[0].name, "AccountId");
    assert.ok(caseNode.fields.length > caseNode.referenceFields.length);
  });
});
