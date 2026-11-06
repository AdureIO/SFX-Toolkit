import "./helpers/vscodeStub";
import { setWorkspaceFolders, vscodeStubState } from "./helpers/vscodeStub";
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isMdapiFolder, isMdapiProject, isSalesforceProject, isWorkspaceUsable, mdapiFolders } from "../utils/projectUtils";
import { metadataKindOf } from "../utils/sfMetadataRefs";

const NS = "http://soap.sforce.com/2006/04/metadata";
const GOOD_PACKAGE = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="${NS}">\n  <version>58.0</version>\n</Package>\n`;

let tmp: string;
let savedFolders: typeof vscodeStubState.workspaceFolders;

function mkProject(name: string, opts: { pkg?: string | null; sfdx?: boolean } = {}): string {
	const dir = path.join(tmp, name);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	if (opts.pkg !== null) fs.writeFileSync(path.join(dir, "src", "package.xml"), opts.pkg ?? GOOD_PACKAGE);
	if (opts.sfdx) fs.writeFileSync(path.join(dir, "sfdx-project.json"), "{}");
	return dir;
}

describe("MDAPI project detection", () => {
	beforeEach(() => {
		savedFolders = vscodeStubState.workspaceFolders; // other suites set theirs at load time
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-mdapi-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		vscodeStubState.workspaceFolders = savedFolders;
	});

	it("accepts src/package.xml with the Metadata API namespace", () => {
		assert.strictEqual(isMdapiFolder(mkProject("ok")), true);
	});

	it("rejects a wrong or missing xmlns, and a missing package.xml", () => {
		assert.strictEqual(isMdapiFolder(mkProject("badns", { pkg: '<Package xmlns="http://example.com/other"></Package>' })), false);
		assert.strictEqual(isMdapiFolder(mkProject("nons", { pkg: "<Package></Package>" })), false);
		assert.strictEqual(isMdapiFolder(mkProject("nopkg", { pkg: null })), false);
		assert.strictEqual(isMdapiFolder(path.join(tmp, "does-not-exist")), false);
	});

	it("rejects when sfdx-project.json is in the folder", () => {
		assert.strictEqual(isMdapiFolder(mkProject("both", { sfdx: true })), false);
	});

	it("rejects when an ancestor has sfdx-project.json", () => {
		fs.writeFileSync(path.join(tmp, "sfdx-project.json"), "{}");
		assert.strictEqual(isMdapiFolder(mkProject("nested")), false);
	});

	it("only reads the head of the file (xmlns within the first 4KB)", () => {
		const padded = `<?xml version="1.0"?>\n<Package xmlns="${NS}">\n${"<!-- x -->\n".repeat(2000)}</Package>`;
		assert.strictEqual(isMdapiFolder(mkProject("big", { pkg: padded })), true);
	});

	it("workspace: MDAPI-only is MDAPI + usable, not SFDX", () => {
		const a = mkProject("a");
		setWorkspaceFolders([a]);
		assert.strictEqual(isSalesforceProject(), false);
		assert.strictEqual(isMdapiProject(), true);
		assert.strictEqual(isWorkspaceUsable(), true);
		assert.deepStrictEqual(mdapiFolders(), [a]);
	});

	it("workspace: a mixed multi-root workspace stays SFDX", () => {
		const a = mkProject("a");
		const b = mkProject("b", { pkg: null, sfdx: true });
		setWorkspaceFolders([a, b]);
		assert.strictEqual(isSalesforceProject(), true);
		assert.strictEqual(isMdapiProject(), false);
		assert.strictEqual(isWorkspaceUsable(), true);
	});

	it("workspace: neither kind is not usable", () => {
		const plain = path.join(tmp, "plain");
		fs.mkdirSync(plain);
		setWorkspaceFolders([plain]);
		assert.strictEqual(isMdapiProject(), false);
		assert.strictEqual(isWorkspaceUsable(), false);
	});

	it("workspace: several MDAPI folders are all listed", () => {
		const a = mkProject("a");
		const b = mkProject("b");
		setWorkspaceFolders([a, b]);
		assert.deepStrictEqual(mdapiFolders(), [a, b]);
	});
});

describe("metadataKindOf: Flow files", () => {
	it("recognises SFDX .flow-meta.xml and MDAPI .flow", () => {
		assert.strictEqual(metadataKindOf("/w/force-app/main/default/flows/F.flow-meta.xml"), "flow");
		assert.strictEqual(metadataKindOf("/w/src/flows/F.flow"), "flow");
		assert.strictEqual(metadataKindOf("C:\\w\\src\\flows\\F.flow"), "flow");
		assert.strictEqual(metadataKindOf("/w/src/flows/F.flowDefinition"), undefined);
	});
});
