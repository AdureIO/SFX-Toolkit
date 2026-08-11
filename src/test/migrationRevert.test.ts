import * as assert from "assert";
import {
  countJournal,
  buildRestoreRows,
  buildRevertPlan,
  type MigrationJournal
} from "../utils/migrationRevert";

/** A run that created two Contacts and overwrote one existing Account. */
const JOURNAL: MigrationJournal = {
  inserted: { Account: ["001T1"], Contact: ["003T1", "003T2"] },
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
