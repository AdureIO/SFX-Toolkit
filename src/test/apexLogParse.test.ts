import * as assert from "assert";
import { extractCodeUnit } from "../utils/apexLogParse";

describe("extractCodeUnit", () => {
  it("extracts a class.method entry point", () => {
    const log = "10:00:00.0 (1)|EXECUTION_STARTED\n10:00:00.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|01p000|MyClass.myMethod\n";
    assert.strictEqual(extractCodeUnit(log), "MyClass.myMethod");
  });
  it("extracts anonymous apex", () => {
    const log = "10:00:00.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex\n";
    assert.strictEqual(extractCodeUnit(log), "execute_anonymous_apex");
  });
  it("extracts a trigger entry point", () => {
    const log = "10:00:00.1 |CODE_UNIT_STARTED|[EXTERNAL]|01q000|MyTrigger on Account trigger event BeforeInsert\n";
    assert.strictEqual(extractCodeUnit(log), "MyTrigger on Account trigger event BeforeInsert");
  });
  it("uses the first CODE_UNIT_STARTED", () => {
    const log = "x|CODE_UNIT_STARTED|[EXTERNAL]|Outer.run\ny|CODE_UNIT_STARTED|[EXTERNAL]|Inner.run\n";
    assert.strictEqual(extractCodeUnit(log), "Outer.run");
  });
  it("returns null when absent", () => {
    assert.strictEqual(extractCodeUnit("10:00:00.0|USER_DEBUG|[1]|DEBUG|hi"), null);
  });
});
