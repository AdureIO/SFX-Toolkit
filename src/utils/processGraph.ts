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
    | "then" // execution-order spine: one automation, then the next, on the same object
    | "triggers" // cross-object hop: an automation writes/creates another object, continuing the process
    | "operatesOn" // scheduled / autolaunched flow reads or writes this object (not in the record-save order)
    | "member" // a phase hub to one of its parallel same-phase automations
    | "references" // an Apex class/trigger references a field (read/write unknown — from the dependency API)
    | "calls" // a trigger/class calls another Apex class (the call chain to a field write)
    | "processedBy"; // object → an Apex writer that isn't reached by a call, so it sits to the right of the object

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
    /** Phase 2 — field lineage: automations / Apex that WRITE a field. */
    fieldUpdates?: {
        source: string; // the flow apiName, workflow-field-update name, or Apex class/trigger name
        sourceKind: "flow" | "fieldUpdate" | "apexClass" | "apexTrigger";
        sourceLabel?: string;
        object: string;
        field: string;
        namespace?: string;
    }[];
    /** Field lineage (references): a component references a field, read/write unknown (dependency API). */
    fieldReferences?: {
        source: string;
        sourceKind: "apexClass" | "apexTrigger" | "flow";
        object: string;
        field: string;
        namespace?: string;
    }[];
    /** Phase 3 — a flow invoking an Apex class (invocable action). */
    invocations?: { flow: string; apexClass: string }[];
    /** Apex call chain: a trigger/class calls another class (static parse). Builds trigger→class→class→field. */
    apexCalls?: { caller: string; callerKind: "apexClass" | "apexTrigger"; callee: string }[];
    /** Objects a flow reads/writes (from Flow metadata record ops) — used to tie scheduled/autolaunched flows to their objects. */
    flowObjects?: { flow: string; object: string }[];
}

/**
 * Scope raw metadata to a chosen set of objects (like the Object Visualizer's seeds) so the graph
 * stays focused and readable. Keeps automations/fields on those objects, and the flows/invocations
 * that operate on them. Non-object-scoped async (scheduled jobs, job classes) is dropped when scoping.
 */
export function scopeMetadataToObjects(md: ProcessMetadata, seeds: string[]): ProcessMetadata {
    const set = new Set(seeds);
    const keep = (o?: string): boolean => !!o && set.has(o);

    // Flows that either run on a seed object or read/write one → keep them and their invocations.
    const flowNames = new Set<string>();
    for (const f of md.flows ?? []) if (keep(f.object)) flowNames.add(f.apiName);
    for (const fo of md.flowObjects ?? []) if (keep(fo.object)) flowNames.add(fo.flow);

    return {
        triggers: (md.triggers ?? []).filter((t) => keep(t.object)),
        flows: (md.flows ?? []).filter((f) => keep(f.object) || flowNames.has(f.apiName)),
        validationRules: (md.validationRules ?? []).filter((v) => keep(v.object)),
        workflowRules: (md.workflowRules ?? []).filter((w) => keep(w.object)),
        fieldUpdates: (md.fieldUpdates ?? []).filter((u) => keep(u.object)),
        fieldReferences: (md.fieldReferences ?? []).filter((r) => keep(r.object)),
        flowObjects: (md.flowObjects ?? []).filter((fo) => keep(fo.object)),
        invocations: (md.invocations ?? []).filter((i) => flowNames.has(i.flow)),
        // Keep the whole call graph — the builder prunes it to chains that end in a scoped field write.
        apexCalls: md.apexCalls,
        apexJobClasses: [],
        scheduledJobs: []
    };
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

    // Resolve (and lazily create) the node that is the source of a field write/reference.
    const ensureFieldSource = (
        source: string,
        sourceKind: "flow" | "fieldUpdate" | "apexClass" | "apexTrigger",
        object: string,
        namespace?: string,
        sourceLabel?: string
    ): string | undefined => {
        if (sourceKind === "flow") {
            const id = `flow:${source}`;
            return nodes.has(id) ? id : undefined; // flow not in scope
        }
        if (sourceKind === "apexClass") {
            const id = `apexClass:${source}`;
            put({ id, kind: "apexClass", label: nsLabel(source, namespace), namespace, meta: {} });
            return id;
        }
        if (sourceKind === "apexTrigger") {
            const id = `trigger:${source}`;
            if (!nodes.has(id)) put({ id, kind: "trigger", label: nsLabel(source, namespace), object, namespace, meta: {} });
            return id;
        }
        const id = `fieldUpdate:${source}`;
        put({ id, kind: "fieldUpdate", label: nsLabel(sourceLabel || source, namespace), object, namespace });
        if (nodes.has(`object:${object}`)) link(id, `object:${object}`, "runsOn");
        return id;
    };

    // Phase 2 — field lineage. A field hangs off the automation/class that touches it (writer → field),
    // placed to the RIGHT — never in front of the object. Writes use `updates`; dependency-API
    // references use `references`, skipped when the same source already has a confirmed write.
    const addFieldSource = (
        s: { source: string; sourceKind: "flow" | "fieldUpdate" | "apexClass" | "apexTrigger"; object: string; field: string; namespace?: string; sourceLabel?: string },
        kind: "updates" | "references"
    ) => {
        ensureObject(s.object);
        const fieldId = `field:${s.object}.${s.field}`;
        put({ id: fieldId, kind: "field", label: s.field, object: s.object });
        const sourceId = ensureFieldSource(s.source, s.sourceKind, s.object, s.namespace, s.sourceLabel);
        if (!sourceId) return;
        if (kind === "references" && edges.has(`${sourceId}=>${fieldId}:updates`)) return;
        link(sourceId, fieldId, kind);
    };
    for (const u of input.fieldUpdates ?? []) addFieldSource(u, "updates");
    for (const r of input.fieldReferences ?? []) addFieldSource(r, "references");

    // ── Apex call chain: trigger/class → class → … (edges) ────────────────────────────────────
    for (const c of input.apexCalls ?? []) {
        const callerId = c.callerKind === "apexTrigger" ? `trigger:${c.caller}` : `apexClass:${c.caller}`;
        const calleeId = `apexClass:${c.callee}`;
        if (!nodes.has(callerId)) put({ id: callerId, kind: c.callerKind === "apexTrigger" ? "trigger" : "apexClass", label: c.caller, meta: {} });
        put({ id: calleeId, kind: "apexClass", label: c.callee, meta: {} });
        if (callerId !== calleeId) link(callerId, calleeId, "calls");
    }

    // Prune util noise (classes that never lead to a write) and get back the set of called classes.
    const calledClasses = pruneApexNoise(nodes, edges);

    // Any Apex writer NOT reached by a call hangs off the object it writes, so it reads to the RIGHT
    // of the object rather than floating disconnected.
    for (const e of [...edges.values()]) {
        if (e.kind !== "updates" && e.kind !== "references") continue;
        const src = nodes.get(e.source);
        const field = nodes.get(e.target);
        if (src?.kind === "apexClass" && field?.object && !calledClasses.has(src.id)) {
            const objId = `object:${field.object}`;
            if (nodes.has(objId)) link(objId, src.id, "processedBy");
        }
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
                // parent). Only an invisible, pre-sized *port* takes part in the dagre layout (so the box's
                // slot is reserved and the spine has exactly ONE line into the group); the items themselves
                // are parented into the box and gridded afterwards. Keeping the items OUT of dagre avoids the
                // box stretching to enclose scattered, edgeless nodes.
                const boxId = `phase:${obj}:${p}`;
                const portId = `port:${obj}:${p}`;
                const cols = Math.max(1, Math.round(Math.sqrt(group.length)));
                const rows = Math.ceil(group.length / cols);
                const boxW = (cols - 1) * 215 + 210;
                const boxH = (rows - 1) * 44 + 74;
                put({ id: boxId, kind: "phaseHub", label, object: obj, meta: { order: String(p) } });
                put({ id: portId, kind: "phasePort", label: "", object: obj, parent: boxId, meta: { w: String(boxW), h: String(boxH) } });
                for (const a of group) {
                    const node = nodes.get(a.id);
                    if (node) node.meta = { ...(node.meta ?? {}), box: boxId };
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

/**
 * Drop Apex classes that are pure-util noise: keep a class only if it writes a field, transitively
 * CALLS a class that writes one, or is invoked/scheduled/async. This keeps the call chain focused on
 * paths that actually end in a field change (trigger → class → class → field). Returns the set of
 * classes that are the target of a `calls` edge (reused by the caller to anchor uncalled writers).
 */
function pruneApexNoise(nodes: Map<string, ProcessNode>, edges: Map<string, ProcessEdge>): Set<string> {
    const isApex = (id: string) => nodes.get(id)?.kind === "apexClass";
    const writers = new Set<string>(); // apex classes that write a field
    const callsIn = new Map<string, Set<string>>(); // callee → callers
    const calledClasses = new Set<string>(); // any calls target
    const keepAnyway = new Set<string>(); // invoked/scheduled targets + reference sources
    const incident = new Map<string, string[]>(); // nodeId → edgeIds touching it
    const touch = (nodeId: string, edgeId: string) => (incident.get(nodeId) ?? incident.set(nodeId, []).get(nodeId)!).push(edgeId);

    // Single pass over the edges: classify + build the incidence map for O(1) node removal later.
    for (const [id, e] of edges) {
        touch(e.source, id);
        touch(e.target, id);
        if (e.kind === "updates" && isApex(e.source)) writers.add(e.source);
        else if (e.kind === "calls") {
            calledClasses.add(e.target);
            (callsIn.get(e.target) ?? callsIn.set(e.target, new Set()).get(e.target)!).add(e.source);
        } else if ((e.kind === "invokes" || e.kind === "schedules") && isApex(e.target)) keepAnyway.add(e.target);
        else if (e.kind === "references" && isApex(e.source)) keepAnyway.add(e.source);
    }

    // Reverse BFS from writers along calls → every class on a path that ends in a write.
    const leadsToWrite = new Set<string>(writers);
    const stack = [...writers];
    while (stack.length) {
        const n = stack.pop() as string;
        for (const pred of callsIn.get(n) ?? []) {
            if (isApex(pred) && !leadsToWrite.has(pred)) {
                leadsToWrite.add(pred);
                stack.push(pred);
            }
        }
    }

    for (const n of nodes.values()) {
        if (n.kind !== "apexClass") continue;
        const isJob = Array.isArray(n.meta?.interfaces) && (n.meta!.interfaces as string[]).length > 0;
        if (leadsToWrite.has(n.id) || keepAnyway.has(n.id) || isJob) continue;
        nodes.delete(n.id);
        for (const eid of incident.get(n.id) ?? []) edges.delete(eid);
    }
    return calledClasses;
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
