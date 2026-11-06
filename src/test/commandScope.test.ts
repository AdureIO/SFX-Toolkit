import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { COMMAND_SCOPE, commandScopeOf, decideCommandGate } from "../utils/commandScope";

const ROOT = path.join(__dirname, "..", "..");

describe("commandScope", () => {
	it("classifies every command contributed in package.json", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
		const missing = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).filter((c) => !COMMAND_SCOPE[c]);
		assert.deepStrictEqual(missing, []);
	});

	it("classifies every command registered through register() in extension.ts, plus the quick-fix command", () => {
		const src = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
		const ids = new Set<string>();
		for (const m of src.matchAll(/\bregister\(\s*"(adure-sfx-toolkit\.[^"]+)"/g)) ids.add(m[1]);
		ids.add("adure-sfx-toolkit.revealOperationPanel"); // REVEAL_OPERATION_PANEL_COMMAND
		ids.add("adure-sfx-toolkit.apex.createFieldStub");
		assert.ok(ids.size > 50, "found the register() calls");
		assert.deepStrictEqual([...ids].filter((c) => !COMMAND_SCOPE[c]), []);
	});

	it("has no stale entries (every classified command is contributed or registered)", () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
		const known = new Set<string>((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
		const src = fs.readFileSync(path.join(ROOT, "src", "extension.ts"), "utf8");
		for (const m of src.matchAll(/\bregister\(\s*"(adure-sfx-toolkit\.[^"]+)"/g)) known.add(m[1]);
		known.add("adure-sfx-toolkit.revealOperationPanel");
		known.add("adure-sfx-toolkit.apex.createFieldStub");
		assert.deepStrictEqual(Object.keys(COMMAND_SCOPE).filter((c) => !known.has(c)), []);
	});

	it("classifies org vs source commands", () => {
		for (const c of ["executeSOQL", "openOrg", "dataTools", "restExplorer", "dataMigration", "executeAnonymous", "listLogs", "openApexTests", "openPackageExplorer", "orgHealth", "lwcNavigate", "runSnippet", "optimizeSalesforceMemory", "schemaHealthActions"]) {
			assert.strictEqual(commandScopeOf(`adure-sfx-toolkit.${c}`), "org", c);
		}
		for (const c of ["pushSource", "pullSource", "deployMetadata", "deployCurrentFile", "retrieveCurrentFile", "metadataDiff", "resetSourceTracking", "apex.createFieldStub", "repairLwcJsconfig", "generateLwcApexTypings", "objectVisualizer", "openPermissionSetUI"]) {
			assert.strictEqual(commandScopeOf(`adure-sfx-toolkit.${c}`), "source", c);
		}
		assert.strictEqual(commandScopeOf("adure-sfx-toolkit.convertMdapiToSfdx"), "ungated");
	});

	it("gates per project kind", () => {
		const sfdx = { sfdx: true, mdapi: false };
		const mdapi = { sfdx: false, mdapi: true };
		const none = { sfdx: false, mdapi: false };
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.pushSource", sfdx), "run");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.pushSource", mdapi), "mdapi-hint");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.pushSource", none), "not-sfdx");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.executeSOQL", sfdx), "run");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.executeSOQL", mdapi), "run");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.executeSOQL", none), "not-sfdx");
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.convertMdapiToSfdx", mdapi), "run");
		// Unclassified commands fall back to the org rule.
		assert.strictEqual(decideCommandGate("adure-sfx-toolkit.unknown", mdapi), "run");
	});
});
