import * as assert from "assert";
import { LogStore, getLastRetrieve, getRetrieveTimes, initRetrieveLog, recordDeployed, recordRetrieved, resetRetrieveLogForTests } from "../utils/retrieveLog";

describe("retrieveLog: deploys", () => {
	const mem = (): LogStore & { data: Record<string, unknown> } => {
		const data: Record<string, unknown> = {};
		return { data, get: <T>(k: string, d: T) => (k in data ? (data[k] as T) : d), update: (k, v) => void (data[k] = v) };
	};
	beforeEach(() => initRetrieveLog(mem(), (org) => org ?? "default"));
	afterEach(() => resetRetrieveLogForTests());

	it("records a deploy with the org's own lastModifiedDate per component, falling back to the completion time", () => {
		const lm = new Date("2025-06-01T10:00:00.000Z");
		const done = new Date("2025-06-01T10:05:00.000Z");
		recordDeployed("u@x", [{ type: "ApexClass", fullName: "A", at: lm }, { type: "Flow", fullName: "F" }], done);
		assert.strictEqual(getLastRetrieve("u@x", "ApexClass", "A"), lm.toISOString());
		assert.strictEqual(getLastRetrieve("u@x", "Flow", "F"), done.toISOString());
	});

	it("shares the log with retrieves, per org: the last of either wins", () => {
		recordRetrieved("u@x", [{ type: "ApexClass", fullName: "A" }], new Date("2025-01-01T00:00:00Z"));
		recordDeployed("u@x", [{ type: "ApexClass", fullName: "A", at: new Date("2025-02-01T00:00:00Z") }]);
		recordDeployed("other", [{ type: "ApexClass", fullName: "A", at: new Date("2025-03-01T00:00:00Z") }]);
		assert.strictEqual(getRetrieveTimes("u@x")["ApexClass:A"], Date.parse("2025-02-01T00:00:00Z"));
		assert.strictEqual(getRetrieveTimes("other")["ApexClass:A"], Date.parse("2025-03-01T00:00:00Z"));
	});
});
