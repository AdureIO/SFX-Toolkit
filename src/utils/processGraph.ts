/**
 * Pure, host-side builder for the org **Process / Automation Map**.
 *
 * Turns fetched automation metadata (triggers, flows, validation/workflow rules,
 * async-Apex classes, scheduled jobs) into a heterogeneous node/edge graph the
 * Cytoscape webview renders. No `vscode` import — stays unit-testable and is also a
 * clean, stable shape for LLM/cursor consumption (`id`, `kind`, `object`, `meta`).
 *
 * MVP scope: the "automation overview" — every automation linked to the object it
 * acts on. Field-level lineage (what sets a field) is a later phase.
 */

export type ProcessNodeKind =
    | "object"
    | "field"
    | "trigger"
    | "flow" // record-triggered / autolaunched / screen
    | "scheduledFlow"
    | "validationRule"
    | "workflowRule"
    | "fieldUpdate" // workflow field update
    | "apexClass" // implements Batchable / Queueable / Schedulable
    | "scheduledJob" // CronTrigger
    | "phaseHub" // synthetic compound box grouping several same-phase automations that run in parallel
    | "phasePort"; // invisible connection point inside a phase box (spine lines attach here, one per box)

export interface ProcessNode {
    /** Stable id, `${kind}:${name}` (object-qualified for rules). Also the Cytoscape node id. */
    id: string;
    kind: ProcessNodeKind;
    label: string;
    /** The SObject this automation acts on, when applicable. */
    object?: string;
    /** Compound-parent id — set when this node belongs inside a phase box. */
    parent?: string;
    /** Managed-package namespace, when the element belongs to one. */
    namespace?: string;
    active?: boolean;
    /** Free-form extras for the UI/LLM: events, processType, triggerType, className, cron, interfaces… */
    meta?: Record<string, string | string[] | boolean>;
}

export type ProcessEdgeKind =
    | "runsOn"
    | "validates"
    | "schedules"
    | "invokes"
    | "updates"
    | "fieldOf"
    | "then" // execution-order spine: one automation, then the next, on the same object
    | "triggers" // cross-object hop: an automation writes/creates another object, continuing the process
    | "operatesOn" // scheduled / autolaunched flow reads or writes this object (not in the record-save order)
    | "member"; // a phase hub to one of its parallel same-phase automations

export interface ProcessEdge {
    id: string;
    source: string;
    target: string;
    kind: ProcessEdgeKind;
    label?: string;
}

export interface ProcessGraph {
    nodes: ProcessNode[];
    edges: ProcessEdge[];
}

/** Raw metadata the retrieval layer produces (org queries), consumed by {@link buildProcessGraph}. */
export interface ProcessMetadata {
    triggers?: { name: string; object: string; events?: string[]; active?: boolean; namespace?: string; recordId?: string }[];
    flows?: {
        apiName: string;
        label?: string;
        processType?: string;
        triggerType?: string;
        object?: string;
        active?: boolean;
        namespace?: string;
        recordId?: string;
        versionId?: string;
    }[];
    validationRules?: { name: string; object: string; active?: boolean; namespace?: string; recordId?: string }[];
    workflowRules?: { name: string; object: string; active?: boolean; namespace?: string; recordId?: string }[];
    apexJobClasses?: { name: string; interfaces: ("Batchable" | "Queueable" | "Schedulable")[]; namespace?: string; recordId?: string }[];
    scheduledJobs?: { name: string; className?: string; cron?: string; nextFire?: string }[];
    /** Phase 2 — field lineage: automations that write a field. */
    fieldUpdates?: {
        source: string; // the flow apiName or the workflow-field-update name
        sourceKind: "flow" | "fieldUpdate";
        sourceLabel?: string;
        object: string;
        field: string;
        namespace?: string;
    }[];
    /** Phase 3 — a flow invoking an Apex class (invocable action). */
    invocations?: { flow: string; apexClass: string }[];
    /** Objects a flow reads/writes (from Flow metadata record ops) — used to tie scheduled/autolaunched flows to their objects. */
    flowObjects?: { flow: string; object: string }[];
}

/** Salesforce order-of-execution phase (1 = earliest) for a node, or 0 if not in the sync path. */
export function executionOrder(kind: ProcessNodeKind, triggerType?: string): number {
    switch (kind) {
        case "flow":
            if (/before/i.test(triggerType ?? "")) return 1;
            if (/after/i.test(triggerType ?? "")) return 6;
            return 0;
        case "trigger":
            return 2; // runs before + after; placed at the "before" rank
        case "validationRule":
            return 3;
        case "workflowRule":
        case "fieldUpdate":
            return 5;
        default:
            return 0;
    }
}

function nsLabel(name: string, namespace?: string): string {
    return namespace ? `${namespace}__${name}` : name;
}

/** Human-readable Salesforce order-of-execution phase name for a numeric order. */
export function phaseLabel(order: number): string {
    switch (order) {
        case 1:
            return "Before-save flow";
        case 2:
            return "Apex before trigger";
        case 3:
            return "Validation";
        case 5:
            return "Workflow / field update";
        case 6:
            return "After-save flow";
        default:
            return "Other";
    }
}

/** A scheduled flow is one whose start is time-based (not object DML). */
function isScheduledFlow(processType?: string, triggerType?: string): boolean {
    return /schedule/i.test(processType ?? "") || /schedule/i.test(triggerType ?? "");
}

/** A record-triggered flow acts on an object (before/after save). */
function isRecordTriggered(triggerType?: string, object?: string): boolean {
    return !!object && /record/i.test(triggerType ?? "");
}

export function buildProcessGraph(input: ProcessMetadata): ProcessGraph {
    const nodes = new Map<string, ProcessNode>();
    const edges = new Map<string, ProcessEdge>();

    const put = (node: ProcessNode) => {
        if (!nodes.has(node.id)) nodes.set(node.id, node);
        return node.id;
    };
    const ensureObject = (name?: string): string | undefined => {
        if (!name) return undefined;
        const id = `object:${name}`;
        put({ id, kind: "object", label: name });
        return id;
    };
    const link = (source: string, target: string, kind: ProcessEdgeKind, label?: string) => {
        const id = `${source}=>${target}:${kind}`;
        if (!edges.has(id)) edges.set(id, { id, source, target, kind, label });
    };

    for (const t of input.triggers ?? []) {
        const id = put({
            id: `trigger:${t.name}`,
            kind: "trigger",
            label: nsLabel(t.name, t.namespace),
            object: t.object,
            namespace: t.namespace,
            active: t.active,
            meta: { events: t.events ?? [], recordId: t.recordId ?? "" }
        });
        const obj = ensureObject(t.object);
        if (obj) link(id, obj, "runsOn", (t.events ?? []).join(", "));
    }

    for (const f of input.flows ?? []) {
        const scheduled = isScheduledFlow(f.processType, f.triggerType);
        const record = isRecordTriggered(f.triggerType, f.object);
        const id = put({
            id: `flow:${f.apiName}`,
            kind: scheduled ? "scheduledFlow" : "flow",
            label: nsLabel(f.label || f.apiName, f.namespace),
            object: record ? f.object : undefined,
            namespace: f.namespace,
            active: f.active,
            meta: {
                processType: f.processType ?? "",
                triggerType: f.triggerType ?? "",
                kind: scheduled ? "scheduled" : record ? "record-triggered" : "autolaunched",
                recordId: f.recordId ?? "",
                versionId: f.versionId ?? ""
            }
        });
        if (record) {
            const obj = ensureObject(f.object);
            if (obj) link(id, obj, "runsOn", f.triggerType);
        }
    }

    for (const v of input.validationRules ?? []) {
        const id = put({
            id: `validationRule:${v.object}.${v.name}`,
            kind: "validationRule",
            label: nsLabel(v.name, v.namespace),
            object: v.object,
            namespace: v.namespace,
            active: v.active,
            meta: { recordId: v.recordId ?? "" }
        });
        const obj = ensureObject(v.object);
        if (obj) link(id, obj, "validates");
    }

    for (const w of input.workflowRules ?? []) {
        const id = put({
            id: `workflowRule:${w.object}.${w.name}`,
            kind: "workflowRule",
            label: nsLabel(w.name, w.namespace),
            object: w.object,
            namespace: w.namespace,
            active: w.active,
            meta: { recordId: w.recordId ?? "" }
        });
        const obj = ensureObject(w.object);
        if (obj) link(id, obj, "runsOn");
    }

    for (const c of input.apexJobClasses ?? []) {
        put({
            id: `apexClass:${c.name}`,
            kind: "apexClass",
            label: nsLabel(c.name, c.namespace),
            namespace: c.namespace,
            meta: { interfaces: c.interfaces, recordId: c.recordId ?? "" }
        });
    }

    for (const j of input.scheduledJobs ?? []) {
        const id = put({
            id: `scheduledJob:${j.name}`,
            kind: "scheduledJob",
            label: j.name,
            meta: { cron: j.cron ?? "", nextFire: j.nextFire ?? "", className: j.className ?? "" }
        });
        if (j.className) {
            const clsId = `apexClass:${j.className}`;
            put({ id: clsId, kind: "apexClass", label: j.className, meta: { interfaces: ["Schedulable"] } });
            link(id, clsId, "schedules");
        }
    }

    // Phase 3 — flow invokes Apex.
    for (const i of input.invocations ?? []) {
        const flowId = `flow:${i.flow}`;
        const clsId = `apexClass:${i.apexClass}`;
        put({ id: clsId, kind: "apexClass", label: i.apexClass, meta: {} });
        if (nodes.has(flowId)) link(flowId, clsId, "invokes");
    }

    // Phase 2 — field lineage.
    for (const u of input.fieldUpdates ?? []) {
        const obj = ensureObject(u.object);
        const fieldId = `field:${u.object}.${u.field}`;
        put({ id: fieldId, kind: "field", label: u.field, object: u.object });
        if (obj) link(fieldId, obj, "fieldOf");
        let sourceId: string;
        if (u.sourceKind === "flow") {
            sourceId = `flow:${u.source}`;
            if (!nodes.has(sourceId)) continue; // flow not in scope
        } else {
            sourceId = `fieldUpdate:${u.source}`;
            put({
                id: sourceId,
                kind: "fieldUpdate",
                label: nsLabel(u.sourceLabel || u.source, u.namespace),
                object: u.object,
                namespace: u.namespace
            });
            if (obj) link(sourceId, obj, "runsOn");
        }
        link(sourceId, fieldId, "updates");
    }

    // Scheduled / autolaunched flows aren't in the record-save order, but they read/write objects.
    // Tie them to those objects with a dotted "operatesOn" link so they aren't floating.
    for (const fo of input.flowObjects ?? []) {
        const flowId = `flow:${fo.flow}`;
        const flow = nodes.get(flowId);
        if (!flow) continue;
        if (flow.kind !== "scheduledFlow" && !(flow.kind === "flow" && !flow.object)) continue; // only non-record flows
        const obj = ensureObject(fo.object);
        if (obj) link(flowId, obj, "operatesOn");
    }

    // Attach the order-of-execution phase to sync-path nodes.
    for (const n of nodes.values()) {
        const tt = typeof n.meta?.triggerType === "string" ? (n.meta.triggerType as string) : undefined;
        const ord = executionOrder(n.kind, tt);
        if (ord) n.meta = { ...(n.meta ?? {}), order: String(ord) };
    }

    // ── Execution-order spine: chain each object's sync automations in the order they run ──
    // This is what turns the "star of things attached to an object" into a readable *process*:
    // object (record change) → phase-1 automation → phase-2 → … Left-to-right = execution order.
    const SYNC_KINDS = new Set<ProcessNodeKind>(["trigger", "flow", "validationRule", "workflowRule", "fieldUpdate"]);
    const kindRank: Record<string, number> = { flow: 0, trigger: 1, validationRule: 2, workflowRule: 3, fieldUpdate: 4 };
    const phaseOf = (n: ProcessNode): number => {
        const o = n.meta && typeof n.meta.order === "string" ? Number(n.meta.order) : 0;
        return o || 99; // unknown phase sorts last within the object
    };
    const byObject = new Map<string, ProcessNode[]>();
    for (const n of nodes.values()) {
        if (n.object && SYNC_KINDS.has(n.kind)) {
            (byObject.get(n.object) ?? byObject.set(n.object, []).get(n.object)!).push(n);
        }
    }
    for (const [obj, autos] of byObject) {
        const entry = `object:${obj}`;
        if (!nodes.has(entry)) continue;
        // Group by execution phase. Automations in the SAME phase run in parallel (e.g. several
        // triggers, several validation rules), so they must be siblings — fed from the previous
        // phase and feeding the next — not chained to each other.
        const phases = new Map<number, ProcessNode[]>();
        for (const a of autos) {
            const p = phaseOf(a);
            (phases.get(p) ?? phases.set(p, []).get(p)!).push(a);
        }
        let prev = entry; // tail of the spine so far (object entry, a single automation, or a phase-box port)
        for (const p of [...phases.keys()].sort((x, y) => x - y)) {
            const group = phases.get(p)!.sort((a, b) => (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9) || a.label.localeCompare(b.label));
            const label = p < 99 ? phaseLabel(p) : "Other";
            if (group.length === 1) {
                // Single automation in this phase → keep the spine a clean straight line.
                link(prev, group[0].id, "then", label);
                prev = group[0].id;
            } else {
                // Several automations run in parallel → wrap them in ONE labelled phase box (a compound
                // parent). The step-to-step spine attaches to an invisible port inside the box, so there
                // is exactly ONE line into the group instead of an M×N wave. Items sit inside the box.
                const boxId = `phase:${obj}:${p}`;
                const portId = `port:${obj}:${p}`;
                put({ id: boxId, kind: "phaseHub", label, object: obj, meta: { order: String(p) } });
                put({ id: portId, kind: "phasePort", label: "", object: obj, parent: boxId });
                for (const a of group) {
                    const node = nodes.get(a.id);
                    if (node) node.parent = boxId;
                }
                link(prev, portId, "then");
                prev = portId;
            }
        }
    }

    // ── Cross-object hops: an automation that writes/creates a *different* object continues the
    //    process there. This is "how it flows through" — e.g. an after-save flow on A updates B,
    //    which fires B's own automation chain. ──
    for (const e of [...edges.values()]) {
        if (e.kind !== "updates") continue;
        const src = nodes.get(e.source);
        const field = nodes.get(e.target);
        if (!src || !field || !field.object || !src.object) continue;
        if (src.object !== field.object) link(src.id, `object:${field.object}`, "triggers");
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// ── UI helpers (pure) ─────────────────────────────────────────────────────────

export interface GraphFilter {
    kinds?: ProcessNodeKind[];
    object?: string;
    namespaces?: string[];
    activeOnly?: boolean;
    /** Empty/undefined shows all. Filters non-object nodes; objects kept if they still have a neighbour. */
    search?: string;
}

/** Apply a filter, dropping edges whose endpoints were removed and orphan object nodes. */
export function filterProcessGraph(graph: ProcessGraph, filter: GraphFilter): ProcessGraph {
    const kinds = filter.kinds && filter.kinds.length ? new Set(filter.kinds) : undefined;
    const q = filter.search?.trim().toLowerCase();

    const keep = (n: ProcessNode): boolean => {
        if (n.kind === "object") return true; // pruned later if orphaned
        if (kinds && !kinds.has(n.kind)) return false;
        if (filter.object && n.object !== filter.object) return false;
        if (filter.activeOnly && n.active === false) return false;
        if (filter.namespaces && filter.namespaces.length && !filter.namespaces.includes(n.namespace ?? "")) return false;
        if (q && !n.label.toLowerCase().includes(q) && !(n.object ?? "").toLowerCase().includes(q)) return false;
        return true;
    };

    const kept = new Set(graph.nodes.filter(keep).map((n) => n.id));
    const edges = graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target));

    // Drop object nodes that lost every automation neighbour.
    const connected = new Set<string>();
    for (const e of edges) {
        connected.add(e.source);
        connected.add(e.target);
    }
    const nodes = graph.nodes.filter((n) => {
        if (!kept.has(n.id)) return false;
        if (n.kind === "object") return connected.has(n.id);
        return true;
    });
    return { nodes, edges };
}

/** Nodes/edges within `hops` of a focus node (context zoom). */
export function focusSubgraph(graph: ProcessGraph, nodeId: string, hops = 1): ProcessGraph {
    const adjacency = new Map<string, Set<string>>();
    for (const e of graph.edges) {
        (adjacency.get(e.source) ?? adjacency.set(e.source, new Set()).get(e.source)!).add(e.target);
        (adjacency.get(e.target) ?? adjacency.set(e.target, new Set()).get(e.target)!).add(e.source);
    }
    const inScope = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);
    for (let h = 0; h < hops; h++) {
        const next = new Set<string>();
        for (const id of frontier) {
            for (const nb of adjacency.get(id) ?? []) {
                if (!inScope.has(nb)) {
                    inScope.add(nb);
                    next.add(nb);
                }
            }
        }
        frontier = next;
    }
    return {
        nodes: graph.nodes.filter((n) => inScope.has(n.id)),
        edges: graph.edges.filter((e) => inScope.has(e.source) && inScope.has(e.target))
    };
}
