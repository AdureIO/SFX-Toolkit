import * as assert from "assert";
import { listOrgMetadata } from "../utils/orgBrowser/metadataLister";

const env = (inner: string) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="http://soap.sforce.com/2006/04/metadata"><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
const DESCRIBE = env(
	`<describeMetadataResponse><result>` +
		`<metadataObjects><directoryName>reports</directoryName><inFolder>true</inFolder><metaFile>false</metaFile><suffix>report</suffix><xmlName>Report</xmlName></metadataObjects>` +
		`<metadataObjects><directoryName>flows</directoryName><inFolder>false</inFolder><metaFile>false</metaFile><suffix>flow</suffix><xmlName>Flow</xmlName></metadataObjects>` +
		`</result></describeMetadataResponse>`
);
const item = (type: string, fullName: string) => `<result><fullName>${fullName}</fullName><type>${type}</type><lastModifiedDate>2024-03-02T10:30:00.000Z</lastModifiedDate></result>`;

describe("orgBrowser lister: onlyFolders (pre-deploy check of a few folder components)", () => {
	const make = () => {
		const queries: { type: string; folder?: string }[] = [];
		const call = async (op: string) => {
			if (op.includes("<met:describeMetadata>")) return DESCRIBE;
			const qs = [...op.matchAll(/<met:queries>([\s\S]*?)<\/met:queries>/g)].map((m) => ({
				type: /<met:type>([^<]*)<\/met:type>/.exec(m[1])![1],
				folder: /<met:folder>([^<]*)<\/met:folder>/.exec(m[1])?.[1],
			}));
			queries.push(...qs);
			return env(`<listMetadataResponse>${qs.map((q) => (q.type === "Report" ? item("Report", `${q.folder}/R`) : item(q.type, "X"))).join("")}</listMetadataResponse>`);
		};
		return { call, queries };
	};

	it("queries only the given folders: no folder list, no other folder, no unfiled$public", async () => {
		const { call, queries } = make();
		const r = await listOrgMetadata({ call, apiVersion: "67.0", only: ["Report", "ReportFolder"], onlyFolders: { Report: ["Sales", "Ops/Q1", "Sales"] } });
		assert.deepStrictEqual(queries, [
			{ type: "Report", folder: "Sales" },
			{ type: "Report", folder: "Ops/Q1" },
		]);
		assert.deepStrictEqual(r.comps.map((c) => c.n).sort(), ["Ops/Q1/R", "Sales/R"]);
		assert.deepStrictEqual(r.failures, []);
	});

	it("without onlyFolders it still lists every folder (unchanged behaviour)", async () => {
		const { call, queries } = make();
		await listOrgMetadata({ call, apiVersion: "67.0", only: ["Report", "ReportFolder"] });
		assert.ok(queries.some((q) => q.type === "ReportFolder"));
		assert.ok(queries.some((q) => q.type === "Report" && q.folder === "unfiled$public"));
	});

	it("plain types are unaffected", async () => {
		const { call, queries } = make();
		await listOrgMetadata({ call, apiVersion: "67.0", only: ["Flow"], onlyFolders: { Report: ["Sales"] } });
		assert.deepStrictEqual(queries, [{ type: "Flow", folder: undefined }]);
	});
});
