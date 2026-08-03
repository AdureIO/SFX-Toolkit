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
    | "trigger"
    | "flow" // record-triggered / autolaunched / screen
    | "scheduledFlow"
    | "validationRule"
    | "workflowRule"
    | "apexClass" // implements Batchable / Queueable / Schedulable
    | "scheduledJob"; // CronTrigger

export interface ProcessNode {
    /** Stable id, `${kind}:${name}` (object-qualified for rules). Also the Cytoscape node id. */
    id: string;
    kind: ProcessNodeKind;
    label: string;
    /** The SObject this automation acts on, when applicable. */
    object?: string;
    /** Managed-package namespace, when the element belongs to one. */
    namespace?: string;
    active?: boolean;
    /** Free-form extras for the UI/LLM: events, processType, triggerType, className, cron, interfaces… */
    meta?: Record<string, string | string[] | boolean>;
}

export type ProcessEdgeKind = "runsOn" | "validates" | "schedules" | "invokes";

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
    triggers?: { name: string; object: string; events?: string[]; active?: boolean; namespace?: string }[];
    flows?: {
        apiName: string;
        label?: string;
        processType?: string;
        triggerType?: string;
        object?: string;
        active?: boolean;
        namespace?: string;
    }[];
    validationRules?: { name: string; object: string; active?: boolean; namespace?: string }[];
    workflowRules?: { name: string; object: string; active?: boolean; namespace?: string }[];
    apexJobClasses?: { name: string; interfaces: ("Batchable" | "Queueable" | "Schedulable")[]; namespace?: string }[];
    scheduledJobs?: { name: string; className?: string; cron?: string; nextFire?: string }[];
}

function nsLabel(name: string, namespace?: string): string {
    return namespace ? `${namespace}__${name}` : name;
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
            meta: { events: t.events ?? [] }
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
                kind: scheduled ? "scheduled" : record ? "record-triggered" : "autolaunched"
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
            active: v.active
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
            active: w.active
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
            meta: { interfaces: c.interfaces }
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
