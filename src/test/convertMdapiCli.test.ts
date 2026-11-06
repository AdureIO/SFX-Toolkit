import * as assert from "assert";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildSfdxProjectJson, countComponents, planConversion } from "../utils/convertMdapiPure";

const NS = "http://soap.sforce.com/2006/04/metadata";

function sfAvailable(): boolean {
	try {
		cp.execFileSync("sf", ["--version"], { stdio: "ignore", timeout: 30000, shell: process.platform === "win32" });
		return true;
	} catch {
		return false;
	}
}

function listRel(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) walk(full);
			else out.push(path.relative(root, full));
		}
	};
	walk(root);
	return out;
}

describe("convert MDAPI -> SFDX with the real Salesforce CLI", function () {
	this.timeout(120000);
	let tmp: string;
	let hasSf = false;

	before(function () {
		hasSf = sfAvailable();
		if (!hasSf) this.skip();
	});
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asfx-mdapi-cli-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("converts a tiny fixture (one class, one object with a field)", () => {
		const src = path.join(tmp, "src");
		fs.mkdirSync(path.join(src, "classes"), { recursive: true });
		fs.mkdirSync(path.join(src, "objects"), { recursive: true });
		const packageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="${NS}">\n  <types><members>Hello</members><name>ApexClass</name></types>\n  <types><members>Thing__c</members><name>CustomObject</name></types>\n  <version>58.0</version>\n</Package>\n`;
		fs.writeFileSync(path.join(src, "package.xml"), packageXml);
		fs.writeFileSync(path.join(src, "classes", "Hello.cls"), "public class Hello {}\n");
		fs.writeFileSync(
			path.join(src, "classes", "Hello.cls-meta.xml"),
			`<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="${NS}">\n  <apiVersion>58.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`
		);
		fs.writeFileSync(
			path.join(src, "objects", "Thing__c.object"),
			`<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="${NS}">\n  <deploymentStatus>Deployed</deploymentStatus>\n  <fields>\n    <fullName>Note__c</fullName>\n    <label>Note</label>\n    <type>Text</type>\n    <length>80</length>\n  </fields>\n  <label>Thing</label>\n  <nameField><label>Thing Name</label><type>Text</type></nameField>\n  <pluralLabel>Things</pluralLabel>\n  <sharingModel>ReadWrite</sharingModel>\n</CustomObject>\n`
		);

		const plan = planConversion({
			folderName: "fixture",
			packageXml,
			toolingApiVersion: "v67.0",
			forceAppExists: false,
			sfdxProjectExists: false,
			forceignoreExists: false,
			isGitRepo: false,
			manifestPackageExists: false,
			srcChoice: "keep",
		});
		assert.ok(plan.ok);
		if (!plan.ok) return;
		fs.writeFileSync(path.join(tmp, "sfdx-project.json"), buildSfdxProjectJson("fixture", plan.sourceApiVersion));

		cp.execFileSync("sf", plan.convertArgs, { cwd: tmp, stdio: "pipe", timeout: 100000, shell: process.platform === "win32" });

		const out = path.join(tmp, "force-app");
		const files = listRel(out).map((f) => f.replace(/\\/g, "/"));
		assert.ok(files.includes("main/default/classes/Hello.cls"), files.join("\n"));
		assert.ok(files.includes("main/default/objects/Thing__c/fields/Note__c.field-meta.xml"), files.join("\n"));
		assert.ok(countComponents(files) >= 3, `components: ${countComponents(files)}`);
		// The MDAPI source is untouched.
		assert.ok(fs.existsSync(path.join(src, "classes", "Hello.cls")));
	});
});
