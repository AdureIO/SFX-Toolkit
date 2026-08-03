import * as assert from "assert";
import { buildProcessGraph, filterProcessGraph, focusSubgraph } from "../utils/processGraph";

describe("processGraph.buildProcessGraph", () => {
  it("links triggers, flows, validation and workflow rules to their object", () => {
    const g = buildProcessGraph({
      triggers: [{ name: "AccountTrigger", object: "Account", events: ["before insert", "after update"] }],
      flows: [{ apiName: "Set_Account_Owner", triggerType: "RecordAfterSave", object: "Account", active: true }],
      validationRules: [{ name: "Name_Required", object: "Account", active: true }],
      workflowRules: [{ name: "Notify_Owner", object: "Account", active: false }]
    });

    const acc = g.nodes.find((n) => n.id === "object:Account");
    assert.ok(acc && acc.kind === "object", "Account object node exists");
    assert.ok(g.nodes.some((n) => n.kind === "trigger" && n.object === "Account"));
    assert.ok(g.nodes.some((n) => n.kind === "flow" && n.object === "Account"));

    // Every automation has an edge to the object.
    const toAccount = g.edges.filter((e) => e.target === "object:Account");
    assert.strictEqual(toAccount.length, 4, "trigger + flow + VR + WR all connect to Account");
    assert.ok(toAccount.some((e) => e.kind === "validates"), "VR uses a validates edge");
  });

  it("classifies scheduled flows and links scheduled jobs to their apex class", () => {
    const g = buildProcessGraph({
      flows: [{ apiName: "Nightly_Cleanup", processType: "ScheduledFlow" }],
      scheduledJobs: [{ name: "Nightly Batch", className: "CleanupBatch", cron: "0 0 1 * * ?" }]
    });
    assert.ok(g.nodes.some((n) => n.kind === "scheduledFlow"), "scheduled flow classified");
    assert.ok(g.nodes.some((n) => n.id === "apexClass:CleanupBatch"), "referenced apex class node created");
    assert.ok(g.edges.some((e) => e.kind === "schedules" && e.target === "apexClass:CleanupBatch"));
  });

  it("filters by kind and prunes orphaned object nodes", () => {
    const g = buildProcessGraph({
      triggers: [{ name: "AccountTrigger", object: "Account" }],
      validationRules: [{ name: "R1", object: "Account" }]
    });
    const onlyTriggers = filterProcessGraph(g, { kinds: ["trigger"] });
    assert.ok(onlyTriggers.nodes.some((n) => n.kind === "trigger"));
    assert.ok(onlyTriggers.nodes.some((n) => n.id === "object:Account"), "object kept — still has a trigger neighbour");
    assert.ok(!onlyTriggers.nodes.some((n) => n.kind === "validationRule"), "VR filtered out");
  });

  it("focus subgraph returns a node and its neighbours", () => {
    const g = buildProcessGraph({
      triggers: [{ name: "AccountTrigger", object: "Account" }],
      validationRules: [{ name: "R1", object: "Contact" }]
    });
    const focus = focusSubgraph(g, "object:Account", 1);
    assert.ok(focus.nodes.some((n) => n.id === "trigger:AccountTrigger"));
    assert.ok(!focus.nodes.some((n) => n.object === "Contact"), "unrelated object excluded");
  });
});
