/**
 * What undoing a migration means, expressed as data.
 *
 * The engine records a {@link MigrationJournal} while it writes; this module turns that journal
 * into the exact set of API calls a revert has to make, and nothing here touches the network —
 * the ordering rules and the shape of a restore row are the parts worth testing.
 */

/** A record in the shape the composite/sobjects API expects. */
export interface CollectionsRecord {
  attributes: { type: string };
  [key: string]: unknown;
}

/**
 * One target record this run overwrote, with everything needed to put it back.
 *
 * `before` is read from the target org BEFORE the write, which is why an upsert is always
 * executed as query-then-write: without the read there is nothing to restore to.
 */
export interface RevertUpdateEntry {
  /** Target record Id. */
  id: string;
  /** Source record Id this row came from (empty when it could not be matched back). */
  srcId: string;
  /** Field values as they were in the target before this run wrote to them. */
  before: Record<string, unknown>;
  /** Field values this run sent. */
  after: Record<string, unknown>;
  status: "updated" | "failed";
  message?: string;
}

/** One target record this run created. The source Id is kept so the result can be traced back. */
export interface InsertedRecord {
  /** Target record Id. */
  id: string;
  /** Source record Id it came from (empty if it could not be matched back). */
  srcId: string;
}

/**
 * Everything a run changed in the target org, in the form a revert needs:
 * inserts are undone by deleting, updates by writing `before` back.
 */
export interface MigrationJournal {
  /** sobject → the records this run created. */
  inserted: Record<string, InsertedRecord[]>;
  /** sobject → the rows this run overwrote, with their pre-migration values. */
  updated: Record<string, RevertUpdateEntry[]>;
}

export interface RevertSummary {
  deleted: number;
  restored: number;
  failed: number;
  errors: Array<{ sobject: string; id: string; message: string }>;
}

/**
 * A subset of a journal to act on, by target record Id.
 *
 * Undoing a run is rarely all-or-nothing: one object landed wrong, the rest is fine. An absent
 * sobject key means "nothing from that object", so an empty selection reverts nothing — the
 * caller passes `undefined` when it means everything.
 */
export interface RevertSelection {
  inserted: Record<string, string[]>;
  updated: Record<string, string[]>;
}

/**
 * Narrow a journal to the records the user picked. `undefined` means the whole run.
 *
 * Filtering here rather than at the API layer keeps one guarantee intact: a revert can only ever
 * touch rows that are in the journal, so a stray Id in a selection cannot reach the org.
 */
export function filterJournal(journal: MigrationJournal, selection?: RevertSelection | null): MigrationJournal {
  if (!selection) return journal;
  const out: MigrationJournal = { inserted: {}, updated: {} };
  for (const [sobject, recs] of Object.entries(journal?.inserted ?? {})) {
    const keep = new Set(selection.inserted?.[sobject] ?? []);
    const picked = recs.filter((r) => keep.has(r.id));
    if (picked.length) out.inserted[sobject] = picked;
  }
  for (const [sobject, entries] of Object.entries(journal?.updated ?? {})) {
    const keep = new Set(selection.updated?.[sobject] ?? []);
    const picked = entries.filter((e) => keep.has(e.id));
    if (picked.length) out.updated[sobject] = picked;
  }
  return out;
}

/**
 * Everything in `journal` that is not in `done`.
 *
 * After a partial revert the rest of the run is still sitting in the org, so its journal stays
 * valid — but the records just undone must drop out of it, or a second revert would try to
 * delete rows that no longer exist and restore rows already restored.
 */
export function subtractJournal(journal: MigrationJournal, done: MigrationJournal): MigrationJournal {
  const out: MigrationJournal = { inserted: {}, updated: {} };
  for (const [sobject, recs] of Object.entries(journal?.inserted ?? {})) {
    const gone = new Set((done?.inserted?.[sobject] ?? []).map((r) => r.id));
    const left = recs.filter((r) => !gone.has(r.id));
    if (left.length) out.inserted[sobject] = left;
  }
  for (const [sobject, entries] of Object.entries(journal?.updated ?? {})) {
    const gone = new Set((done?.updated?.[sobject] ?? []).map((e) => e.id));
    const left = entries.filter((e) => !gone.has(e.id));
    if (left.length) out.updated[sobject] = left;
  }
  return out;
}

/** What a revert of this journal would actually do, in plain numbers. */
export function countJournal(journal: MigrationJournal): {
  inserted: number;
  restorable: number;
  unrestorable: number;
} {
  let inserted = 0, restorable = 0, unrestorable = 0;
  for (const recs of Object.values(journal?.inserted ?? {})) inserted += recs.length;
  for (const entries of Object.values(journal?.updated ?? {})) {
    for (const e of entries) e.status === "updated" ? restorable++ : unrestorable++;
  }
  return { inserted, restorable, unrestorable };
}

/**
 * The PATCH rows that put one object's overwritten records back.
 *
 * A field that was empty before the run is restored as `null`, not omitted — omitting it would
 * leave the migrated value in place, which is the opposite of a revert. Rows whose write failed
 * are skipped: nothing changed, so there is nothing to undo.
 */
export function buildRestoreRows(sobject: string, entries: RevertUpdateEntry[]): CollectionsRecord[] {
  return entries
    .filter((e) => e.id && e.status === "updated")
    .map((e) => {
      const rec: CollectionsRecord = { attributes: { type: sobject }, Id: e.id };
      for (const [field, value] of Object.entries(e.before ?? {})) {
        if (field === "Id") continue;
        rec[field] = value === undefined ? null : value;
      }
      return rec;
    });
}

export interface RevertPlan {
  /** Restore first: an overwritten row may point at a record we are about to delete. */
  restores: Array<{ sobject: string; rows: CollectionsRecord[]; entries: RevertUpdateEntry[] }>;
  /** Then delete, children before parents, so a lookup never blocks the delete. */
  deletes: Array<{ sobject: string; ids: string[] }>;
}

/**
 * Turn a journal into an ordered plan.
 *
 * `order` is the migration order (parents first); both phases walk it in reverse. Restores run
 * before deletes because writing an old value back releases any reference to a record this run
 * inserted — do it the other way round and the delete is blocked by its own children.
 */
export function buildRevertPlan(order: string[], journal: MigrationJournal): RevertPlan {
  const reversed = [...order].reverse();
  const plan: RevertPlan = { restores: [], deletes: [] };
  for (const sobject of reversed) {
    const entries = (journal?.updated?.[sobject] ?? []).filter((e) => e.id && e.status === "updated");
    if (entries.length) plan.restores.push({ sobject, rows: buildRestoreRows(sobject, entries), entries });
  }
  for (const sobject of reversed) {
    const ids = (journal?.inserted?.[sobject] ?? []).map((r) => r.id).filter(Boolean);
    if (ids.length) plan.deletes.push({ sobject, ids });
  }
  return plan;
}
