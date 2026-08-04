import { runCommandArgs } from "./commandRunner";
import { ProcessMetadata } from "./processGraph";

/**
 * Retrieval layer for the Process / Automation Map. Runs a handful of Tooling/SOQL
 * queries via the Salesforce CLI and normalizes the result into {@link ProcessMetadata}.
 *
 * Every query is isolated: a failure (e.g. an object not present in the org, or a field
 * name that differs by API version) yields an empty slice, never a broken map. Object
 * references are normalized to API names so nodes from different sources merge.
 *
 * NOTE: the exact field names on FlowDefinitionView / WorkflowRule vary a little across
 * API versions — this is the layer to sanity-check against a real org first.
 */

type Rec = Record<string, unknown>;

async function query(org: string | undefined, soql: string, tooling: boolean): Promise<Rec[]> {
    const args = ["data", "query", "-q", soql, "--json"];
    if (tooling) args.push("--use-tooling-api");
    if (org) args.push("--target-org", org);
    try {
        const raw = await runCommandArgs("sf", args, undefined, undefined, false);
        return (JSON.parse(raw) as { result?: { records?: Rec[] } }).result?.records ?? [];
    } catch {
        return [];
    }
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const rel = (r: Rec, path: string): string | undefined => {
    const obj = r[path.split(".")[0]] as Rec | undefined;
    return obj ? str(obj[path.split(".")[1]]) : undefined;
};
const isIdLike = (s: string): boolean => /^[a-zA-Z0-9]{15,18}$/.test(s);

/** Resolve DurableId/object-Id references to QualifiedApiName via EntityDefinition. */
async function resolveObjectRefs(org: string | undefined, refs: Set<string>): Promise<Map<string, string>> {
    const ids = [...refs].filter(isIdLike);
    if (!ids.length) return new Map();
    const inList = ids.map((i) => `'${i}'`).join(",");
    const recs = await query(org, `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${inList})`, true);
    const map = new Map<string, string>();
    for (const r of recs) {
        const d = str(r.DurableId);
        const q = str(r.QualifiedApiName);
        if (d && q) map.set(d, q);
    }
    return map;
}

function triggerEvents(r: Rec): string[] {
    const map: [string, string][] = [
        ["UsageBeforeInsert", "before insert"],
        ["UsageAfterInsert", "after insert"],
        ["UsageBeforeUpdate", "before update"],
        ["UsageAfterUpdate", "after update"],
        ["UsageBeforeDelete", "before delete"],
        ["UsageAfterDelete", "after delete"],
        ["UsageAfterUndelete", "after undelete"]
    ];
    return map.filter(([f]) => r[f] === true).map(([, label]) => label);
}

const JOB_INTERFACES: [RegExp, "Batchable" | "Queueable" | "Schedulable"][] = [
    [/Batchable/i, "Batchable"],
    [/Queueable/i, "Queueable"],
    [/Schedulable/i, "Schedulable"]
];

/** A single progress update emitted while fetching. */
export interface FetchProgress {
    label: string;
    completed: number;
    total: number;
}

/** Fetch and normalize the org's automation metadata. `onProgress` reports query completion for a loading UI. */
export async function fetchProcessMetadata(org?: string, onProgress?: (p: FetchProgress) => void): Promise<ProcessMetadata> {
    // Named parallel queries — each reports progress as it resolves so the UI shows a real bar.
    const steps: { label: string; soql: string; tooling: boolean }[] = [
        {
            label: "Apex triggers",
            soql:
                "SELECT Id, Name, Status, NamespacePrefix, EntityDefinition.QualifiedApiName, " +
                "UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, " +
                "UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger",
            tooling: true
        },
        {
            // NOTE: FlowDefinitionView is NOT supported on the Tooling API — it must be queried on the standard API.
            label: "Flows",
            soql:
                "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventId, " +
                "TriggerObjectOrEventLabel, IsActive, NamespacePrefix, DurableId, ActiveVersionId FROM FlowDefinitionView",
            tooling: false
        },
        { label: "Validation rules", soql: "SELECT Id, ValidationName, Active, NamespacePrefix, EntityDefinition.QualifiedApiName FROM ValidationRule", tooling: true },
        { label: "Workflow rules", soql: "SELECT Id, Name, TableEnumOrId FROM WorkflowRule", tooling: true },
        { label: "Scheduled jobs", soql: "SELECT CronJobDetail.Name, CronExpression, NextFireTime, State FROM CronTrigger WHERE State != 'DELETED'", tooling: false },
        { label: "Apex classes", soql: "SELECT Id, Name, NamespacePrefix, SymbolTable FROM ApexClass", tooling: true },
        { label: "Field updates", soql: "SELECT Name, Field, NamespacePrefix FROM WorkflowFieldUpdate", tooling: true }
    ];
    // +2 downstream phases (object refs, flow metadata) so the bar reaches 100% at the end.
    const total = steps.length + 2;
    let completed = 0;
    const tick = (label: string) => onProgress?.({ label, completed: ++completed, total });

    const [triggerRecs, flowRecs, vrRecs, wrRecs, cronRecs, classRecs, wfuRecs] = await Promise.all(
        steps.map((st) => query(org, st.soql, st.tooling).then((recs) => (tick(st.label), recs)))
    );

    // Normalize object refs (flows/workflows can reference an Id/DurableId).
    const rawRefs = new Set<string>();
    for (const f of flowRecs) {
        const id = str(f.TriggerObjectOrEventId);
        if (id) rawRefs.add(id);
    }
    for (const w of wrRecs) {
        const t = str(w.TableEnumOrId);
        if (t) rawRefs.add(t);
    }
    const refMap = await resolveObjectRefs(org, rawRefs);
    tick("Object references");
    const resolve = (ref: string | undefined, fallback?: string): string | undefined =>
        ref ? refMap.get(ref) ?? (isIdLike(ref) ? fallback ?? ref : ref) : undefined;

    const triggers = triggerRecs.map((r) => ({
        name: str(r.Name) ?? "(trigger)",
        object: rel(r, "EntityDefinition.QualifiedApiName") ?? "Unknown",
        events: triggerEvents(r),
        active: str(r.Status) === "Active",
        namespace: str(r.NamespacePrefix),
        recordId: str(r.Id)
    }));

    const flows = flowRecs.map((r) => ({
        apiName: str(r.ApiName) ?? str(r.Label) ?? "(flow)",
        label: str(r.Label),
        processType: str(r.ProcessType),
        triggerType: str(r.TriggerType),
        object: resolve(str(r.TriggerObjectOrEventId), str(r.TriggerObjectOrEventLabel)),
        active: r.IsActive === true,
        namespace: str(r.NamespacePrefix),
        recordId: str(r.DurableId),
        versionId: str(r.ActiveVersionId)
    }));

    const validationRules = vrRecs.map((r) => ({
        name: str(r.ValidationName) ?? "(rule)",
        object: rel(r, "EntityDefinition.QualifiedApiName") ?? "Unknown",
        active: r.Active === true,
        namespace: str(r.NamespacePrefix),
        recordId: str(r.Id)
    }));

    const workflowRules = wrRecs.map((r) => ({
        name: str(r.Name) ?? "(rule)",
        object: resolve(str(r.TableEnumOrId)) ?? "Unknown",
        recordId: str(r.Id)
    }));

    const scheduledJobs = cronRecs.map((r) => ({
        name: rel(r, "CronJobDetail.Name") ?? "(job)",
        cron: str(r.CronExpression),
        nextFire: str(r.NextFireTime)
    }));

    const apexJobClasses: ProcessMetadata["apexJobClasses"] = [];
    for (const r of classRecs) {
        const symbol = r.SymbolTable as { interfaces?: string[] } | null | undefined;
        const ifaces = symbol?.interfaces ?? [];
        const matched = JOB_INTERFACES.filter(([re]) => ifaces.some((i) => re.test(i))).map(([, name]) => name);
        if (matched.length) {
            apexJobClasses.push({ name: str(r.Name) ?? "(class)", interfaces: matched, namespace: str(r.NamespacePrefix), recordId: str(r.Id) });
        }
    }

    // ── Phase 2/3: field lineage + apex invocations (best-effort) ──────────────
    const fieldUpdates: NonNullable<ProcessMetadata["fieldUpdates"]> = [];
    for (const r of wfuRecs) {
        const f = str(r.Field); // "Object.FieldApiName"
        if (!f || !f.includes(".")) continue;
        const [object, ...rest] = f.split(".");
        fieldUpdates.push({
            source: str(r.Name) ?? f,
            sourceKind: "fieldUpdate",
            object,
            field: rest.join("."),
            namespace: str(r.NamespacePrefix)
        });
    }

    const invocations: NonNullable<ProcessMetadata["invocations"]> = [];
    const flowObjects: NonNullable<ProcessMetadata["flowObjects"]> = [];
    // Flow.Metadata (Tooling) carries element details: `actionCalls` (apex) + record
    // writes (`recordUpdates`/`recordCreates` → field lineage). Shape varies by version.
    try {
        const flowMeta = await query(org, "SELECT DeveloperName, Metadata FROM Flow WHERE Status = 'Active'", true);
        for (const fr of flowMeta) {
            const dev = str(fr.DeveloperName);
            if (!dev) continue;
            const raw = fr.Metadata;
            const md = (typeof raw === "string" ? safeParse(raw) : raw) as
                | {
                      actionCalls?: unknown[];
                      recordUpdates?: unknown[];
                      recordCreates?: unknown[];
                      recordLookups?: unknown[];
                      recordDeletes?: unknown[];
                  }
                | undefined;
            if (!md) continue;
            for (const acU of md.actionCalls ?? []) {
                const ac = acU as { actionType?: string; actionName?: string };
                if (String(ac.actionType).toLowerCase() === "apex" && ac.actionName) {
                    invocations.push({ flow: dev, apexClass: String(ac.actionName) });
                }
            }
            for (const ruU of [...(md.recordUpdates ?? []), ...(md.recordCreates ?? [])]) {
                const ru = ruU as { object?: string; inputAssignments?: { field?: string }[] };
                const obj = str(ru.object);
                if (!obj) continue;
                for (const ia of ru.inputAssignments ?? []) {
                    if (ia.field) fieldUpdates.push({ source: dev, sourceKind: "flow", object: obj, field: ia.field });
                }
            }
            // Every object the flow reads or writes → ties scheduled/autolaunched flows to their objects.
            for (const elU of [
                ...(md.recordLookups ?? []),
                ...(md.recordUpdates ?? []),
                ...(md.recordCreates ?? []),
                ...(md.recordDeletes ?? [])
            ]) {
                const obj = str((elU as { object?: string }).object);
                if (obj) flowObjects.push({ flow: dev, object: obj });
            }
        }
    } catch {
        /* Flow.Metadata not queryable on this org/version — field lineage stays partial. */
    }
    tick("Flow metadata");

    return { triggers, flows, validationRules, workflowRules, scheduledJobs, apexJobClasses, fieldUpdates, invocations, flowObjects };
}

function safeParse(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}
