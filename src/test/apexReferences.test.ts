import * as assert from "assert";
import { Position, Range } from "vscode-languageserver/node";
import { symbolAt, findReferencesInText, blankNonCode, identifierAt, ApexIndexLike } from "../utils/apexReferences";

const SRC = [
  "public class AccountService {",              // 0
  "    private String label;",                  // 1
  "",                                           // 2
  "    public void first() {",                  // 3
  "        Account acc = new Account();",       // 4
  "        acc.Name = label;",                  // 5
  "        update acc;",                        // 6
  "    }",                                      // 7
  "",                                           // 8
  "    public void second() {",                 // 9
  "        Contact acc = new Contact();",       // 10
  "        acc.LastName = 'x';",                // 11
  "    }",                                      // 12
  "}"                                           // 13
].join("\n");

// The scopes parseApex produces for this source: the class body, and each method body.
const index: ApexIndexLike = {
  classRanges: [{ name: "AccountService", range: Range.create(0, 0, 13, 1) }],
  varDecls: [
    { name: "label", scope: Range.create(0, 0, 13, 1) },  // field → class scope
    { name: "acc", scope: Range.create(3, 0, 7, 5) },     // local in first()
    { name: "acc", scope: Range.create(9, 0, 12, 5) }     // local in second()
  ]
};

describe("apexReferences.symbolAt", () => {
  it("confines a local to the method that declares it", () => {
    // `acc` on line 4 (first()) must not reach the `acc` in second().
    const ref = symbolAt(SRC, index, Position.create(4, 16))!;
    assert.strictEqual(ref.name, "acc");
    assert.ok(ref.scope, "a local carries a scope");
    assert.strictEqual(ref.localOnly, true, "a local is never searched in other files");

    const lines = findReferencesInText(SRC, ref.name, ref.scope).map((r) => r.start.line);
    assert.deepStrictEqual(lines, [4, 5, 6], "only first()'s occurrences");
    assert.ok(!lines.includes(10), "second()'s acc is a different variable");
  });

  it("resolves the other method's same-named local independently", () => {
    const ref = symbolAt(SRC, index, Position.create(10, 16))!;
    const lines = findReferencesInText(SRC, ref.name, ref.scope).map((r) => r.start.line);
    assert.deepStrictEqual(lines, [10, 11]);
  });

  it("treats an unknown identifier as workspace-wide", () => {
    const ref = symbolAt(SRC, index, Position.create(0, 14))!; // the class name
    assert.strictEqual(ref.name, "AccountService");
    assert.strictEqual(ref.localOnly, false, "types are searched across files");
  });
});

describe("apexReferences.findReferencesInText", () => {
  it("matches whole words only", () => {
    const text = "Integer count = 1; Integer counter = 2; count = count + 1;";
    const lines = findReferencesInText(text, "count");
    assert.strictEqual(lines.length, 3, "`counter` is not a match");
  });

  it("ignores occurrences in comments and strings", () => {
    const text = ["// acc is mentioned here", "String s = 'acc';", "/* acc */", "Account acc = null;"].join("\n");
    const found = findReferencesInText(text, "acc").map((r) => r.start.line);
    assert.deepStrictEqual(found, [3], "only the real declaration");
  });

  it("reports an accurate range for the match", () => {
    const r = findReferencesInText("Account acc = null;", "acc")[0];
    assert.strictEqual(r.start.line, 0);
    assert.strictEqual(r.start.character, 8);
    assert.strictEqual(r.end.character, 11);
  });
});

describe("apexReferences helpers", () => {
  it("blankNonCode preserves offsets", () => {
    const text = "a // comment\nb";
    assert.strictEqual(blankNonCode(text).length, text.length);
    assert.strictEqual(blankNonCode(text).split("\n")[1], "b");
  });

  it("identifierAt finds the word under the cursor", () => {
    assert.strictEqual(identifierAt("Account acc = null;", Position.create(0, 9)), "acc");
    assert.strictEqual(identifierAt("Account acc = null;", Position.create(0, 7)), "Account");
  });
});
