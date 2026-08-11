import * as assert from "assert";
import {
  countJournal,
  buildRestoreRows,
  buildRevertPlan,
  filterJournal,
  subtractJournal,
  type MigrationJournal
} from "../utils/migrationRevert";

/** A run that created two Contacts and overwrote one existing Account. */
const JOURNAL: MigrationJournal = {
  inserted: {
    Account: [{ id: "001T1", srcId: "001S1" }],
    Contact: [{ id: "003T1", srcId: "003S1" }, { id: "003T2", srcId: "003S2" }]
  },
  updated: {
    Account: [
      {
        id: "001T9",
        srcId: "001S9",
        before: { Name: "Old Name", Industry: null, ParentId: "001T5" },
        after: { Name: "New Name", Industry: "Retail", ParentId: "001T1" },
        status: "updated"
      },
      {
        id: "001T8",
        srcId: "001S8",
        before: { Name: "Untouched" },
        after: { Name: "Attempted" },
        status: "failed",
        message: "FIELD_CUSTOM_VALIDATION_EXCEPTION"
      }
    ]
  }
};

describe("migrationRevert.countJournal", () => {
  it("separates what can be deleted, restored, and neither", () => {
    const c = countJournal(JOURNAL);
    assert.strictEqual(c.inserted, 3);
    assert.strictEqual(c.restorable, 1, "only the row that was actually overwritten");
    assert.strictEqual(c.unrestorable, 1, "the failed write changed nothing");
  });

  it("survives an empty journal", () => {
    assert.deepStrictEqual(countJournal({ inserted: {}, updated: {} }), {
      inserted: 0, restorable: 0, unrestorable: 0
    });
  });
});

describe("migrationRevert.buildRestoreRows", () => {
  const rows = buildRestoreRows("Account", JOURNAL.updated.Account);

  it("skips rows whose write failed — nothing changed, nothing to undo", () => {
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].Id, "001T9");
  });

  it("restores a previously empty field as null rather than omitting it", () => {
    // Omitting it would leave the migrated value in place — the opposite of a revert.
    assert.ok("Industry" in rows[0], "the field is present");
    assert.strictEqual(rows[0].Industry, null);
  });

  it("writes the old values back, not the new ones", () => {
    assert.strictEqual(rows[0].Name, "Old Name");
    assert.strictEqual(rows[0].ParentId, "001T5");
  });

  it("carries the composite type envelope", () => {
    assert.deepStrictEqual(rows[0].attributes, { type: "Account" });
  });
});

describe("migrationRevert.buildRevertPlan", () => {
  const plan = buildRevertPlan(["Account", "Contact"], JOURNAL);

  it("deletes children before parents", () => {
    assert.deepStrictEqual(plan.deletes.map((d) => d.sobject), ["Contact", "Account"]);
    assert.deepStrictEqual(plan.deletes[1].ids, ["001T1"]);
  });

  it("restores before it deletes, so a lookup to an inserted record is released first", () => {
    // Account 001T9's ParentId points at 001T1, which this run inserted and the plan deletes.
    assert.strictEqual(plan.restores[0].rows[0].ParentId, "001T5");
    assert.ok(plan.deletes.some((d) => d.ids.includes("001T1")));
  });

  it("omits objects with nothing to undo", () => {
    assert.deepStrictEqual(plan.restores.map((r) => r.sobject), ["Account"]);
  });

  it("plans nothing for an untouched run", () => {
    const empty = buildRevertPlan(["Account"], { inserted: {}, updated: {} });
    assert.strictEqual(empty.restores.length, 0);
    assert.strictEqual(empty.deletes.length, 0);
  });
});

describe("migrationRevert.filterJournal", () => {
  it("returns the whole journal when nothing is selected explicitly", () => {
    assert.strictEqual(filterJournal(JOURNAL, null), JOURNAL);
    assert.strictEqual(filterJournal(JOURNAL, undefined), JOURNAL);
  });

  it("keeps only the picked records", () => {
    const picked = filterJournal(JOURNAL, {
      inserted: { Contact: ["003T2"] },
      updated: { Account: ["001T9"] }
    });
    assert.deepStrictEqual(picked.inserted, { Contact: [{ id: "003T2", srcId: "003S2" }] });
    assert.strictEqual(picked.updated.Account.length, 1);
    assert.strictEqual(picked.updated.Account[0].id, "001T9");
  });

  it("drops an object entirely when none of its records are picked", () => {
    const picked = filterJournal(JOURNAL, { inserted: { Contact: ["003T1"] }, updated: {} });
    assert.ok(!("Account" in picked.inserted), "Account had nothing selected");
    assert.deepStrictEqual(picked.updated, {});
  });

  it("cannot reach a record the run never wrote", () => {
    // A selection is a filter, never a source of Ids — an Id the journal does not know is ignored.
    const picked = filterJournal(JOURNAL, { inserted: { Account: ["001XX_NOT_OURS"] }, updated: {} });
    assert.deepStrictEqual(picked, { inserted: {}, updated: {} });
  });
});

describe("migrationRevert.subtractJournal", () => {
  it("leaves what a partial revert did not undo", () => {
    const done = filterJournal(JOURNAL, { inserted: { Contact: ["003T1"] }, updated: {} });
    const left = subtractJournal(JOURNAL, done);
    assert.deepStrictEqual(left.inserted.Contact, [{ id: "003T2", srcId: "003S2" }]);
    assert.deepStrictEqual(left.inserted.Account, [{ id: "001T1", srcId: "001S1" }]);
    assert.strictEqual(left.updated.Account.length, 2, "updates were untouched");
  });

  it("is empty once everything has been undone", () => {
    assert.deepStrictEqual(subtractJournal(JOURNAL, JOURNAL), { inserted: {}, updated: {} });
  });

  it("keeps a partial revert from being replayed against the same records", () => {
    const done = filterJournal(JOURNAL, { inserted: {}, updated: { Account: ["001T9"] } });
    const left = subtractJournal(JOURNAL, done);
    assert.ok(!left.updated.Account.some((e) => e.id === "001T9"), "already restored");
  });
});
