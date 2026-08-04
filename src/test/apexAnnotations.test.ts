import * as assert from "assert";
import { parseContext, getStaticItems, annotationTargetFrom } from "../utils/apexCompletions";

describe("apex annotations completion", () => {
  it("detects annotation context on an @-only line", () => {
    const ctx = parseContext("    @", undefined, undefined, "\n    public class Foo {");
    assert.strictEqual(ctx.type, "annotation");
    assert.strictEqual(ctx.prefix, "");
  });

  it("does not treat an email or expression @ as an annotation", () => {
    const ctx = parseContext("String s = 'a@b';", undefined, undefined, "");
    assert.notStrictEqual(ctx.type, "annotation");
  });

  it("infers class vs method target from the following code", () => {
    assert.strictEqual(annotationTargetFrom("\npublic class Foo {"), "class");
    assert.strictEqual(annotationTargetFrom("\npublic static void doIt() {"), "method");
    assert.strictEqual(annotationTargetFrom("\nInteger count = 0;"), "method"); // property-like member
    assert.strictEqual(annotationTargetFrom(""), "any");
  });

  it("offers annotations filtered by prefix, @ included in the label, name-only inserted", () => {
    const ctx = parseContext("    @Aur", undefined, undefined, "\n    public static void m() {");
    const items = getStaticItems(ctx);
    const aura = items.find((i) => i.label === "@AuraEnabled");
    assert.ok(aura, "AuraEnabled offered for @Aur");
    assert.strictEqual(aura!.insertText, "AuraEnabled", "inserts the name only (@ already typed)");
    assert.ok(/method/.test(aura!.detail ?? ""));
  });

  it("ranks target-appropriate annotations first", () => {
    const clsCtx = parseContext("@", undefined, undefined, "\npublic class Foo {");
    const items = getStaticItems(clsCtx);
    const rest = items.find((i) => i.label === "@RestResource"); // class-only
    const future = items.find((i) => i.label === "@Future"); // method-only
    assert.ok(rest && future);
    assert.ok((rest!.sortText ?? "") < (future!.sortText ?? ""), "class annotation sorts before method annotation in class position");
  });

  it("detects an Apex picklist assignment context", () => {
    const ctx = parseContext("        acc.Industry = '");
    assert.strictEqual(ctx.type, "apexPicklist");
    assert.strictEqual(ctx.objectName, "acc");
    assert.strictEqual(ctx.pickField, "Industry");
    assert.strictEqual(ctx.prefix, "");
  });

  it("captures a partial picklist value and relationship hops", () => {
    const ctx = parseContext("con.Account.Type == 'Cust");
    assert.strictEqual(ctx.type, "apexPicklist");
    assert.strictEqual(ctx.objectName, "con");
    assert.deepStrictEqual(ctx.relPath, ["Account"]);
    assert.strictEqual(ctx.pickField, "Type");
    assert.strictEqual(ctx.prefix, "Cust");
  });

  it("does not treat a plain string assignment as a picklist", () => {
    const ctx = parseContext("String name = '");
    assert.notStrictEqual(ctx.type, "apexPicklist");
  });

  it("emits snippet insert text for parameterised annotations", () => {
    const ctx = parseContext("@InvocableMethod", undefined, undefined, "\npublic static void m() {");
    const item = getStaticItems(ctx).find((i) => i.label === "@InvocableMethod");
    assert.ok(item && item.isSnippet, "parameterised annotation is a snippet");
    assert.ok(item!.insertText!.includes("${1:"), "has a tab stop");
  });
});
