import * as assert from "assert";
import * as path from "path";
import { componentKeysFromList, componentKeysFromPaths, historyErrorsFromCliText, parseRetrieveHistory } from "../utils/commandHistoryPure";
import { buildTypeTable } from "../utils/orgBrowser/localIndex";

describe("commandHistoryPure", () => {
	const table = buildTypeTable();
	const proj = path.join(path.sep, "w", "proj");

	it("componentKeysFromList: type or componentType, deduped, incomplete skipped", () => {
		assert.deepStrictEqual(
			componentKeysFromList([{ type: "ApexClass", fullName: "A" }, { componentType: "ApexClass", fullName: "A" }, { componentType: "CustomObject", fullName: "O__c" }, { fullName: "x" }, { type: "ApexClass" }]),
			["ApexClass:A", "CustomObject:O__c"]
		);
		assert.deepStrictEqual(componentKeysFromList(undefined), []);
	});

	it("componentKeysFromPaths: absolute and relative paths map through the type table", () => {
		const keys = componentKeysFromPaths(proj, [path.join(proj, "force-app", "main", "default", "classes", "Foo.cls"), "force-app/main/default/triggers/T.trigger", path.join(proj, "README.md"), path.join(path.sep, "elsewhere", "classes", "X.cls")], table);
		assert.deepStrictEqual(keys, ["ApexClass:Foo", "ApexTrigger:T"]);
	});

	it("historyErrorsFromCliText: JSON message, plain text, ANSI, empty", () => {
		assert.deepStrictEqual(historyErrorsFromCliText('noise {"status":1,"message":"Bad\\nthing"}'), [{ message: "Bad thing" }]);
		assert.deepStrictEqual(historyErrorsFromCliText("\u001b[31mboom\u001b[0m   here"), [{ message: "boom here" }]);
		assert.deepStrictEqual(historyErrorsFromCliText("  "), []);
		assert.deepStrictEqual(historyErrorsFromCliText(undefined), []);
	});

	it("parseRetrieveHistory: components and failed files", () => {
		const out = JSON.stringify({ status: 0, result: { files: [{ type: "ApexClass", fullName: "A", state: "Changed" }, { type: "ApexClass", fullName: "B", state: "Failed", error: "nope" }] } });
		assert.deepStrictEqual(parseRetrieveHistory(`prefix\n${out}`), { components: ["ApexClass:A", "ApexClass:B"], errors: [{ component: "ApexClass:B", message: "nope" }] });
		assert.strictEqual(parseRetrieveHistory("no json"), null);
		assert.strictEqual(parseRetrieveHistory('{"result":{}}'), null);
	});
});
