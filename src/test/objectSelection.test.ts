import * as assert from "assert";
import { ObjectSelection, resolveProjectObjects } from "../webview/objectSelection";

describe("webview.ObjectSelection", () => {
  const sel = () => {
    const s = new ObjectSelection();
    s.setItems(["Contact", "Account", "Invoice__c", "Order__c"]);
    return s;
  };

  it("sorts items and infers custom from the __c suffix", () => {
    const s = sel();
    assert.deepStrictEqual(s.names(), ["Account", "Contact", "Invoice__c", "Order__c"]);
    const { shown } = s.visible("");
    assert.strictEqual(shown.find((o) => o.name === "Invoice__c")?.custom, true);
    assert.strictEqual(shown.find((o) => o.name === "Account")?.custom, false);
  });

  it("filters by search term and by kind", () => {
    const s = sel();
    assert.deepStrictEqual(s.visible("acc").shown.map((o) => o.name), ["Account"]);
    assert.deepStrictEqual(s.visible("", { kind: "custom" }).shown.map((o) => o.name), ["Invoice__c", "Order__c"]);
    assert.deepStrictEqual(s.visible("", { kind: "standard" }).shown.map((o) => o.name), ["Account", "Contact"]);
  });

  it("reports how many matches the cap hid", () => {
    const s = sel();
    const v = s.visible("", { cap: 2 });
    assert.strictEqual(v.shown.length, 2);
    assert.strictEqual(v.total, 4);
    assert.strictEqual(v.hidden, 2);
  });

  it("tracks selection and returns stable sorted values", () => {
    const s = sel();
    s.set("Order__c", true);
    s.set("Account", true);
    assert.strictEqual(s.size, 2);
    assert.ok(s.has("Account"));
    assert.deepStrictEqual(s.values(), ["Account", "Order__c"]);
    s.set("Account", false);
    assert.deepStrictEqual(s.values(), ["Order__c"]);
  });

  it("restores the pre-edit selection when an edit is cancelled", () => {
    const s = sel();
    s.set("Account", true);
    s.beginEdit();
    s.set("Contact", true);
    s.set("Account", false);
    assert.deepStrictEqual(s.values(), ["Contact"]);
    s.cancelEdit();
    assert.deepStrictEqual(s.values(), ["Account"], "reverted to the snapshot");
  });

  it("replaceAll swaps the whole selection", () => {
    const s = sel();
    s.set("Account", true);
    s.replaceAll(["Contact", "Order__c"]);
    assert.deepStrictEqual(s.values(), ["Contact", "Order__c"]);
  });
});

describe("objectSelection.resolveProjectObjects", () => {
  it("matches a source folder to the org's namespaced API name", () => {
    const org = ["sfy24__DataSet__c", "sfy24__DataSource__c", "Account"];
    assert.deepStrictEqual(resolveProjectObjects(["DataSet__c", "Account"], org), ["sfy24__DataSet__c", "Account"]);
  });

  it("matches regardless of folder casing", () => {
    assert.deepStrictEqual(resolveProjectObjects(["dataset__c"], ["sfy24__DataSet__c"]), ["sfy24__DataSet__c"]);
  });

  it("prefers an exact hit over a namespace-stripped one", () => {
    const org = ["DataSet__c", "sfy24__DataSet__c"];
    assert.deepStrictEqual(resolveProjectObjects(["DataSet__c"], org), ["DataSet__c"]);
  });

  it("keeps an object the org doesn't report instead of dropping it", () => {
    assert.deepStrictEqual(resolveProjectObjects(["Brand_New__c"], ["Account"]), ["Brand_New__c"]);
  });

  it("passes everything through when the org list hasn't loaded", () => {
    assert.deepStrictEqual(resolveProjectObjects(["A__c", "B__c"], []), ["A__c", "B__c"]);
  });

  it("de-duplicates when two folders resolve to the same org name", () => {
    assert.deepStrictEqual(resolveProjectObjects(["DataSet__c", "dataset__c"], ["sfy24__DataSet__c"]), ["sfy24__DataSet__c"]);
  });
});
