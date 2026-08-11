import * as assert from "assert";
import { buildProcessGraph, filterProcessGraph, focusSubgraph, scopeMetadataToObjects } from "../utils/processGraph";

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

  it("builds field lineage, invocations and execution order (phase 2/3)", () => {
    const g = buildProcessGraph({
      flows: [{ apiName: "SetOwner", triggerType: "RecordBeforeSave", object: "Account" }],
      fieldUpdates: [
        { source: "SetOwner", sourceKind: "flow", object: "Account", field: "OwnerId" },
        { source: "WFU", sourceKind: "fieldUpdate", object: "Account", field: "Status__c" }
      ],
      invocations: [{ flow: "SetOwner", apexClass: "OwnerService" }]
    });
    assert.ok(g.nodes.some((n) => n.kind === "field" && n.label === "OwnerId"), "field node created");
    assert.ok(g.nodes.some((n) => n.kind === "fieldUpdate"), "workflow field update node created");
    assert.strictEqual(g.edges.filter((e) => e.kind === "updates").length, 2, "two updates edges");
    assert.ok(g.edges.some((e) => e.kind === "invokes" && e.target === "apexClass:OwnerService"));
    assert.strictEqual(g.nodes.find((n) => n.kind === "flow")?.meta?.order, "1", "before-save flow is phase 1");
  });

  it("chains an object's automations into an execution-order process spine", () => {
    const g = buildProcessGraph({
      triggers: [{ name: "AccountTrigger", object: "Account", events: ["before insert"] }],
      flows: [
        { apiName: "BeforeF", triggerType: "RecordBeforeSave", object: "Account" },
        { apiName: "AfterF", triggerType: "RecordAfterSave", object: "Account" }
      ],
      validationRules: [{ name: "VR1", object: "Account" }]
    });
    const then = g.edges.filter((e) => e.kind === "then");
    // entry → before-save flow → trigger → validation → after-save flow == 4 sequence edges
    assert.strictEqual(then.length, 4, "one spine edge between each consecutive step");
    assert.ok(then.some((e) => e.source === "object:Account"), "spine starts at the object entry");
    const targets = then.map((e) => e.target);
    assert.ok(targets.indexOf("flow:BeforeF") < targets.indexOf("flow:AfterF"), "before-save precedes after-save in the spine");
  });

  it("wraps same-phase automations in a labelled phase box with a single line to the next group", () => {
    const g = buildProcessGraph({
      triggers: [
        { name: "T1", object: "Account", events: ["before insert"] },
        { name: "T2", object: "Account", events: ["before insert"] }
      ],
      validationRules: [
        { name: "V1", object: "Account" },
        { name: "V2", object: "Account" }
      ]
    });
    const boxes = g.nodes.filter((n) => n.kind === "phaseHub");
    assert.strictEqual(boxes.length, 2, "one box for the before-trigger phase and one for the validation phase");
    // Items record their phase box (gridded into it after layout), not chained to each other.
    assert.strictEqual(g.nodes.find((n) => n.id === "trigger:T1")?.meta?.box, "phase:Account:2");
    assert.strictEqual(g.nodes.find((n) => n.id === "validationRule:Account.V1")?.meta?.box, "phase:Account:3");
    // Each box has an invisible port (parented into the box) that reserves its slot in the layout.
    const port = g.nodes.find((n) => n.kind === "phasePort" && n.id === "port:Account:2");
    assert.ok(port && port.parent === "phase:Account:2", "port lives inside its box");
    const then = g.edges.filter((e) => e.kind === "then");
    assert.strictEqual(
      then.filter((e) => e.source.startsWith("port:") && e.target.startsWith("port:")).length,
      1,
      "a single line connects the two phase boxes"
    );
    assert.ok(!then.some((e) => e.source.startsWith("trigger:")), "triggers are not individually chained onward");
  });

  it("adds a cross-object hop when an automation writes another object", () => {
    const g = buildProcessGraph({
      flows: [{ apiName: "AccToContact", triggerType: "RecordAfterSave", object: "Account" }],
      fieldUpdates: [{ source: "AccToContact", sourceKind: "flow", object: "Contact", field: "Foo__c" }]
    });
    assert.ok(
      g.edges.some((e) => e.kind === "triggers" && e.source === "flow:AccToContact" && e.target === "object:Contact"),
      "cross-object hop links the writing flow to the target object"
    );
  });

  it("links Apex classes/triggers that write a field, and keeps references distinct from writes", () => {
    const g = buildProcessGraph({
      fieldUpdates: [
        { source: "AccountService", sourceKind: "apexClass", object: "Account", field: "Rating" },
        { source: "AccountTrigger", sourceKind: "apexTrigger", object: "Account", field: "Rating" }
      ],
      fieldReferences: [
        // Same class already writes Rating → must NOT be downgraded to a reference.
        { source: "AccountService", sourceKind: "apexClass", object: "Account", field: "Rating" },
        // A different class only references it.
        { source: "ReportUtil", sourceKind: "apexClass", object: "Account", field: "Rating" }
      ]
    });
    const fieldId = "field:Account.Rating";
    const writers = g.edges.filter((e) => e.kind === "updates" && e.target === fieldId).map((e) => e.source);
    assert.ok(writers.includes("apexClass:AccountService"));
    assert.ok(writers.includes("trigger:AccountTrigger"));
    const refs = g.edges.filter((e) => e.kind === "references" && e.target === fieldId).map((e) => e.source);
    assert.ok(refs.includes("apexClass:ReportUtil"), "reference-only class is linked as a reference");
    assert.ok(!refs.includes("apexClass:AccountService"), "a confirmed writer is not also a faint reference");
  });

  it("hangs a field off the automation that sets it, to the right (no field→object edge)", () => {
    const g = buildProcessGraph({
      flows: [{ apiName: "SetOwner", triggerType: "RecordBeforeSave", object: "Account" }],
      fieldUpdates: [{ source: "SetOwner", sourceKind: "flow", object: "Account", field: "OwnerId" }]
    });
    assert.ok(g.edges.some((e) => e.kind === "updates" && e.source === "flow:SetOwner" && e.target === "field:Account.OwnerId"), "setter → field edge present");
    assert.ok(!g.nodes.some((n) => n.id.startsWith("fieldbox:")), "no field box");
  });

  it("builds the Apex call chain and prunes util classes off the write path", () => {
    const g = buildProcessGraph({
      triggers: [{ name: "AccountTrigger", object: "Account", events: ["before insert"] }],
      fieldUpdates: [{ source: "ServiceB", sourceKind: "apexClass", object: "Account", field: "Rating" }],
      apexCalls: [
        { caller: "AccountTrigger", callerKind: "apexTrigger", callee: "ServiceA" },
        { caller: "ServiceA", callerKind: "apexClass", callee: "ServiceB" }, // ServiceB writes Rating
        { caller: "ServiceA", callerKind: "apexClass", callee: "LoggerUtil" } // dead-end util → pruned
      ]
    });
    // Chain trigger → ServiceA → ServiceB → field is present.
    assert.ok(g.edges.some((e) => e.kind === "calls" && e.source === "trigger:AccountTrigger" && e.target === "apexClass:ServiceA"));
    assert.ok(g.edges.some((e) => e.kind === "calls" && e.source === "apexClass:ServiceA" && e.target === "apexClass:ServiceB"));
    assert.ok(g.edges.some((e) => e.kind === "updates" && e.source === "apexClass:ServiceB" && e.target === "field:Account.Rating"));
    // The util that leads nowhere is pruned.
    assert.ok(!g.nodes.some((n) => n.id === "apexClass:LoggerUtil"), "dead-end util pruned");
  });

  it("scopes metadata to selected objects (seeds)", () => {
    const md = {
      triggers: [
        { name: "AccT", object: "Account" },
        { name: "ConT", object: "Contact" }
      ],
      flows: [
        { apiName: "AccFlow", triggerType: "RecordAfterSave", object: "Account" },
        { apiName: "LeadFlow", triggerType: "RecordAfterSave", object: "Lead" },
        { apiName: "Nightly", processType: "ScheduledFlow" }
      ],
      fieldUpdates: [
        { source: "Svc", sourceKind: "apexClass" as const, object: "Account", field: "Rating" },
        { source: "Svc", sourceKind: "apexClass" as const, object: "Lead", field: "Status" }
      ],
      flowObjects: [{ flow: "Nightly", object: "Account" }],
      scheduledJobs: [{ name: "Job1" }]
    };
    const scoped = scopeMetadataToObjects(md, ["Account"]);
    assert.deepStrictEqual(scoped.triggers?.map((t) => t.object), ["Account"], "only Account triggers");
    assert.ok(scoped.flows?.some((f) => f.apiName === "AccFlow"));
    assert.ok(scoped.flows?.some((f) => f.apiName === "Nightly"), "scheduled flow kept because it writes Account");
    assert.ok(!scoped.flows?.some((f) => f.apiName === "LeadFlow"), "Lead flow dropped");
    assert.strictEqual(scoped.fieldUpdates?.length, 1, "only the Account field write");
    assert.strictEqual(scoped.scheduledJobs?.length, 0, "non-object async dropped when scoping");
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
