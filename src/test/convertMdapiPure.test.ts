import * as assert from "assert";
import {
	FORCEIGNORE_LINES,
	GITIGNORE_LINES,
	buildSfdxProjectJson,
	countComponents,
	describePlan,
	mergeIgnoreLines,
	parsePackageVersion,
	planConversion,
	resolveSourceApiVersion,
	type ConversionInputs,
} from "../utils/convertMdapiPure";

const PKG = '<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata"><types><members>*</members><name>ApexClass</name></types><version>58.0</version></Package>';

function inputs(over: Partial<ConversionInputs> = {}): ConversionInputs {
	return {
		folderName: "my-proj",
		packageXml: PKG,
		toolingApiVersion: "v67.0",
		forceAppExists: false,
		sfdxProjectExists: false,
		forceignoreExists: false,
		gitignoreContent: undefined,
		isGitRepo: false,
		manifestPackageExists: false,
		srcChoice: "keep",
		...over,
	};
}

describe("convertMdapiPure: versions and sfdx-project.json", () => {
	it("reads <version> from package.xml", () => {
		assert.strictEqual(parsePackageVersion(PKG), "58.0");
		assert.strictEqual(parsePackageVersion("<version>45</version>"), "45.0");
		assert.strictEqual(parsePackageVersion("<Package/>"), undefined);
	});

	it("falls back to the tooling API version without the v", () => {
		assert.strictEqual(resolveSourceApiVersion(undefined, "v67.0"), "67.0");
		assert.strictEqual(resolveSourceApiVersion("<Package/>", "v66.0"), "66.0");
		assert.strictEqual(resolveSourceApiVersion(PKG, "v67.0"), "58.0");
	});

	it("builds the sfdx-project.json", () => {
		const json = JSON.parse(buildSfdxProjectJson("my-proj", "58.0"));
		assert.deepStrictEqual(json, {
			packageDirectories: [{ path: "force-app", default: true }],
			name: "my-proj",
			namespace: "",
			sfdcLoginUrl: "https://login.salesforce.com",
			sourceApiVersion: "58.0",
		});
	});
});

describe("convertMdapiPure: ignore-file merge", () => {
	it("appends only the missing lines, no duplicates", () => {
		const r = mergeIgnoreLines(".sfdx/\nfoo\n", GITIGNORE_LINES);
		assert.deepStrictEqual(r.added, [".sf/", "node_modules/"]);
		assert.strictEqual(r.content, ".sfdx/\nfoo\n.sf/\nnode_modules/\n");
		const again = mergeIgnoreLines(r.content, GITIGNORE_LINES);
		assert.deepStrictEqual(again.added, []);
		assert.strictEqual(again.content, r.content);
	});

	it("adds a newline separator when the file has none at the end, and keeps CRLF", () => {
		assert.strictEqual(mergeIgnoreLines("a", [".sf/"]).content, "a\n.sf/\n");
		assert.strictEqual(mergeIgnoreLines("a\r\n", [".sf/"]).content, "a\r\n.sf/\r\n");
	});

	it("matches existing lines by trimmed value", () => {
		assert.deepStrictEqual(mergeIgnoreLines("  .sf/  \n", [".sf/"]).added, []);
	});
});

describe("convertMdapiPure: planConversion", () => {
	it("aborts when force-app already exists", () => {
		const p = planConversion(inputs({ forceAppExists: true }));
		assert.strictEqual(p.ok, false);
		if (!p.ok) assert.match(p.reason, /force-app/);
	});

	it("plans keep: no src action, manifest copy, default .forceignore", () => {
		const p = planConversion(inputs());
		assert.ok(p.ok);
		if (!p.ok) return;
		assert.strictEqual(p.srcAction, "none");
		assert.strictEqual(p.copyManifest, true);
		assert.deepStrictEqual(p.convertArgs, ["project", "convert", "mdapi", "--root-dir", "src", "--output-dir", "force-app"]);
		assert.strictEqual(p.sourceApiVersion, "58.0");
		assert.strictEqual(p.forceignoreContent, FORCEIGNORE_LINES.join("\n") + "\n");
		// Not a git repo and no .gitignore: nothing to create.
		assert.strictEqual(p.gitignore, null);
	});

	it("plans move: git mv in a git repo, rename otherwise", () => {
		const git = planConversion(inputs({ srcChoice: "move", isGitRepo: true }));
		const fsr = planConversion(inputs({ srcChoice: "move", isGitRepo: false }));
		assert.ok(git.ok && fsr.ok);
		if (git.ok) assert.strictEqual(git.srcAction, "git-mv");
		if (fsr.ok) assert.strictEqual(fsr.srcAction, "rename");
		if (git.ok) assert.strictEqual(git.movedSrcDir, "mdapi-src");
	});

	it("leaves existing files alone", () => {
		const p = planConversion(inputs({ forceignoreExists: true, manifestPackageExists: true, gitignoreContent: ".sfdx/\n.sf/\nnode_modules/\n", isGitRepo: true }));
		assert.ok(p.ok);
		if (!p.ok) return;
		assert.strictEqual(p.forceignoreContent, null);
		assert.strictEqual(p.copyManifest, false);
		assert.strictEqual(p.gitignore, null);
	});

	it("creates .gitignore only in a git repo, appends when it exists", () => {
		const created = planConversion(inputs({ isGitRepo: true }));
		assert.ok(created.ok);
		if (created.ok) {
			assert.strictEqual(created.gitignore?.created, true);
			assert.strictEqual(created.gitignore?.content, ".sfdx/\n.sf/\nnode_modules/\n");
		}
		const appended = planConversion(inputs({ gitignoreContent: "out/\n" }));
		assert.ok(appended.ok);
		if (appended.ok) {
			assert.strictEqual(appended.gitignore?.created, false);
			assert.strictEqual(appended.gitignore?.content, "out/\n.sfdx/\n.sf/\nnode_modules/\n");
		}
	});

	it("describes the steps for the dialog", () => {
		const p = planConversion(inputs({ srcChoice: "move", isGitRepo: true }));
		assert.ok(p.ok);
		if (!p.ok) return;
		const text = describePlan(p, "move").join("\n");
		assert.match(text, /sfdx-project\.json/);
		assert.match(text, /git mv/);
		assert.match(describePlan(p, "keep").join("\n"), /Keep src/);
	});
});

describe("convertMdapiPure: countComponents", () => {
	it("counts a source file and its -meta.xml companion once", () => {
		assert.strictEqual(
			countComponents([
				"main/default/classes/A.cls",
				"main/default/classes/A.cls-meta.xml",
				"main/default/objects/Obj__c/Obj__c.object-meta.xml",
				"main/default/objects/Obj__c/fields/F__c.field-meta.xml",
			]),
			3
		);
		assert.strictEqual(countComponents([]), 0);
	});
});
