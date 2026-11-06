/**
 * Which project kinds each command runs in. Pure (no vscode) so it can be unit tested,
 * and the single source of truth for `register()` in extension.ts.
 *
 * - "org":      needs only a Salesforce project folder + an org (SFDX or legacy MDAPI).
 * - "source":   needs SFDX-format source (sfdx-project.json): push/pull, local deploy and
 *               retrieve, source tracking, stubs. In an MDAPI project these show a
 *               "Convert to SFDX format" hint instead of running.
 * - "ungated":  runs everywhere it is invoked (the conversion command itself).
 *
 * Every registered or contributed command MUST appear here (enforced by a unit test).
 */
export type CommandScope = "org" | "source" | "ungated";

const P = "adure-sfx-toolkit.";

const ORG: string[] = [
	"optimizeSalesforceMemory",
	"listLogs",
	"addDebugTrace",
	"quickTrace",
	"deleteAllLogs",
	"deleteTrace",
	"refreshTraces",
	"executeAnonymous",
	"rerunLastApex",
	"executeSOQL",
	"refreshOrgs",
	"openOrg",
	"setAsDefaultOrg",
	"setAsDefaultDevHub",
	"copyUsername",
	"renameAlias",
	"generatePassword",
	"deleteOrg",
	"connectOrg",
	"createScratch",
	"quickScratch",
	"refreshMetadata",
	"openSOQLEditor",
	"processMap",
	"schemaHealthActions",
	"orgHealth",
	"quickSoql",
	"deployHistory",
	"addToGitignore",
	"addToIgnore",
	"showSnippets",
	"openSnippetsPanel",
	"runSnippet",
	"runSnippetFromTree",
	"addSnippet",
	"deleteSnippet",
	"editSnippetFile",
	"editSnippet",
	"refreshSnippets",
	"lwcNavigate",
	"lwcGoToJs",
	"lwcGoToHtml",
	"lwcGoToMeta",
	"lwcGoToCss",
	"dataTools",
	"restExplorer",
	"dataMigration",
	"openPackageExplorer",
	"listInstalledPackages",
	"openApexCoverage",
	"refreshApexCoverage",
	"toggleApexCoverageLines",
	"toggleApexCoverageBadge",
	"clearApexTestResults",
	"toggleHideMetaXml",
	"openApexTests",
	"showOutput",
	"revealOperationPanel",
	"openOrgBrowser",
];

const SOURCE: string[] = [
	"deployMetadata",
	"openPermissionSetUI",
	"pushSource",
	"pushSourceForce",
	"pullSource",
	"pullSourceForce",
	"deployCurrentFile",
	"retrieveCurrentFile",
	"validateApexFile",
	"resetSourceTracking",
	"repairLwcJsconfig",
	"generateLwcApexTypings",
	"objectVisualizer",
	"metadataDiff",
	"addToForceignore",
	"apex.createFieldStub",
];

const UNGATED: string[] = ["convertMdapiToSfdx"];

export const COMMAND_SCOPE: Readonly<Record<string, CommandScope>> = Object.freeze({
	...Object.fromEntries(ORG.map((c) => [P + c, "org" as const])),
	...Object.fromEntries(SOURCE.map((c) => [P + c, "source" as const])),
	...Object.fromEntries(UNGATED.map((c) => [P + c, "ungated" as const])),
});

export function commandScopeOf(command: string): CommandScope | undefined {
	return COMMAND_SCOPE[command];
}

export type GateDecision = "run" | "not-sfdx" | "mdapi-hint";

/**
 * What to do when `command` is invoked. Unclassified commands are treated as "org"
 * (the tests make sure none exist).
 */
export function decideCommandGate(command: string, state: { sfdx: boolean; mdapi: boolean }): GateDecision {
	const scope = COMMAND_SCOPE[command] ?? "org";
	if (scope === "ungated") return "run";
	if (state.sfdx) return "run";
	if (state.mdapi) return scope === "source" ? "mdapi-hint" : "run";
	return "not-sfdx";
}
