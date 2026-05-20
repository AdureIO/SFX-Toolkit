import * as assert from "assert";
import { escapeShellArg } from "../utils/commandRunner";

describe("escapeShellArg", () => {
  it("wraps paths containing $ so the shell does not expand them", () => {
    const arg = escapeShellArg("/project/force-app/main/default/classes/Foo$Bar.cls");
    assert.ok(arg.startsWith("'") && arg.endsWith("'"));
    assert.ok(arg.includes("Foo$Bar"));
    assert.ok(!arg.includes('"'));
  });

  it("escapes embedded single quotes", () => {
    assert.strictEqual(escapeShellArg("it's"), "'it'\\''s'");
  });
});
