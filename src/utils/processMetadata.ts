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

/** Fetch and normalize the org's automation metadata. */
export async function fetchProcessMetadata(org?: string): Promise<ProcessMetadata> {
    const [triggerRecs, flowRecs, vrRecs, wrRecs, cronRecs, classRecs, wfuRecs] = await Promise.all([
        query(
            org,
            "SELECT Name, Status, NamespacePrefix, EntityDefinition.QualifiedApiName, " +
                "UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, " +
                "UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger",
            true
        ),
        query(
            org,
            "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventId, " +
                "TriggerObjectOrEventLabel, IsActive, NamespacePrefix FROM FlowDefinitionView",
            true
        ),
        query(org, "SELECT ValidationName, Active, NamespacePrefix, EntityDefinition.QualifiedApiName FROM ValidationRule", true),
        query(org, "SELECT Name, TableEnumOrId FROM WorkflowRule", true),
        query(org, "SELECT CronJobDetail.Name, CronExpression, NextFireTime, State FROM CronTrigger WHERE State != 'DELETED'", false),
        query(org, "SELECT Name, NamespacePrefix, SymbolTable FROM ApexClass", true),
        query(org, "SELECT Name, Field, NamespacePrefix FROM WorkflowFieldUpdate", true)
    ]);

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
    const resolve = (ref: string | undefined, fallback?: string): string | undefined =>
        ref ? refMap.get(ref) ?? (isIdLike(ref) ? fallback ?? ref : ref) : undefined;

    const triggers = triggerRecs.map((r) => ({
        name: str(r.Name) ?? "(trigger)",
        object: rel(r, "EntityDefinition.QualifiedApiName") ?? "Unknown",
        events: triggerEvents(r),
        active: str(r.Status) === "Active",
        namespace: str(r.NamespacePrefix)
    }));

    const flows = flowRecs.map((r) => ({
        apiName: str(r.ApiName) ?? str(r.Label) ?? "(flow)",
        label: str(r.Label),
        processType: str(r.ProcessType),
        triggerType: str(r.TriggerType),
        object: resolve(str(r.TriggerObjectOrEventId), str(r.TriggerObjectOrEventLabel)),
        active: r.IsActive === true,
        namespace: str(r.NamespacePrefix)
    }));

    const validationRules = vrRecs.map((r) => ({
        name: str(r.ValidationName) ?? "(rule)",
        object: rel(r, "EntityDefinition.QualifiedApiName") ?? "Unknown",
        active: r.Active === true,
        namespace: str(r.NamespacePrefix)
    }));

    const workflowRules = wrRecs.map((r) => ({
        name: str(r.Name) ?? "(rule)",
        object: resolve(str(r.TableEnumOrId)) ?? "Unknown"
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
            apexJobClasses.push({ name: str(r.Name) ?? "(class)", interfaces: matched, namespace: str(r.NamespacePrefix) });
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
    // Flow.Metadata (Tooling) carries element details: `actionCalls` (apex) + record
    // writes (`recordUpdates`/`recordCreates` → field lineage). Shape varies by version.
    try {
        const flowMeta = await query(org, "SELECT DeveloperName, Metadata FROM Flow WHERE Status = 'Active'", true);
        for (const fr of flowMeta) {
            const dev = str(fr.DeveloperName);
            if (!dev) continue;
            const raw = fr.Metadata;
            const md = (typeof raw === "string" ? safeParse(raw) : raw) as
                | { actionCalls?: unknown[]; recordUpdates?: unknown[]; recordCreates?: unknown[] }
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
        }
    } catch {
        /* Flow.Metadata not queryable on this org/version — field lineage stays partial. */
    }

    return { triggers, flows, validationRules, workflowRules, scheduledJobs, apexJobClasses, fieldUpdates, invocations };
}

function safeParse(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}
