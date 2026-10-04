import * as assert from "assert";
import { escapeShellArg, escapeCmdArg } from "../utils/commandRunner";

const posix = process.platform === "win32" ? describe.skip : describe;

describe("escapeCmdArg (cmd.exe)", () => {
  it("quotes and caret-escapes metacharacters", () => {
    assert.strictEqual(escapeCmdArg("a&b", false), '^"a^&b^"');
  });

  it("escapes embedded quotes MSVCRT-style and doubles carets for .cmd shims", () => {
    assert.strictEqual(escapeCmdArg('say "hi"', false), '^"say^ \\^"hi\\^"^"');
    assert.strictEqual(escapeCmdArg("x|y", true), '^^^"x^^^|y^^^"');
  });
});

posix("escapeShellArg", () => {
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
