/**
 * Pure planning helpers for "Convert MDAPI project to SFDX format" (no vscode, no I/O),
 * so they can be unit tested. The command in src/commands/convertMdapi.ts does the I/O.
 */

export type SrcChoice = "keep" | "move";

export const OUTPUT_DIR = "force-app";
export const MOVED_SRC_DIR = "mdapi-src";
export const LOGIN_URL = "https://login.salesforce.com";

export const FORCEIGNORE_LINES: readonly string[] = [
	"package.xml",
	"**/jsconfig.json",
	"**/.eslintrc.json",
	"**/__tests__/**",
	"**/node_modules/**",
	"**/*.dup",
];

export const GITIGNORE_LINES: readonly string[] = [".sfdx/", ".sf/", "node_modules/"];

/** `<version>62.0</version>` of an MDAPI package.xml, or undefined. */
export function parsePackageVersion(packageXml: string): string | undefined {
	const m = /<version>\s*(\d+(?:\.\d+)?)\s*<\/version>/.exec(packageXml);
	if (!m) return undefined;
	return m[1].includes(".") ? m[1] : `${m[1]}.0`;
}

/** Version for sourceApiVersion: package.xml first, else the configured API version without the "v". */
export function resolveSourceApiVersion(packageXml: string | undefined, fallbackToolingVersion: string): string {
	const fromXml = packageXml ? parsePackageVersion(packageXml) : undefined;
	if (fromXml) return fromXml;
	const fallback = fallbackToolingVersion.replace(/^v/i, "").trim();
	return fallback || "62.0";
}

export function buildSfdxProjectJson(folderName: string, sourceApiVersion: string): string {
	const json = {
		packageDirectories: [{ path: OUTPUT_DIR, default: true }],
		name: folderName,
		namespace: "",
		sfdcLoginUrl: LOGIN_URL,
		sourceApiVersion,
	};
	return JSON.stringify(json, null, 2) + "\n";
}

/**
 * Append the entries of `wanted` that `existing` does not already contain (compared by
 * trimmed line). Never reorders or removes existing lines. `added` lists what was appended.
 */
export function mergeIgnoreLines(existing: string, wanted: readonly string[]): { content: string; added: string[] } {
	const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
	const added: string[] = [];
	for (const w of wanted) {
		if (!have.has(w) && !added.includes(w)) added.push(w);
	}
	if (added.length === 0) return { content: existing, added };
	const eol = existing.includes("\r\n") ? "\r\n" : "\n";
	const sep = existing.length > 0 && !/\r?\n$/.test(existing) ? eol : "";
	return { content: existing + sep + added.join(eol) + eol, added };
}

export interface ConversionInputs {
	folderName: string;
	/** Raw `src/package.xml`, if readable. */
	packageXml?: string;
	/** `getToolingApiVersion()` (e.g. "v67.0"). */
	toolingApiVersion: string;
	forceAppExists: boolean;
	sfdxProjectExists: boolean;
	forceignoreExists: boolean;
	/** Existing .gitignore content, undefined when the file does not exist. */
	gitignoreContent?: string;
	isGitRepo: boolean;
	manifestPackageExists: boolean;
	srcChoice: SrcChoice;
}

export type SrcAction = "none" | "git-mv" | "rename";

export type ConversionPlan =
	| { ok: false; reason: string }
	| {
			ok: true;
			/** sfdx-project.json to create (we never overwrite one). */
			sfdxProjectJson: string;
			sourceApiVersion: string;
			/** CLI args for `sf`. */
			convertArgs: string[];
			copyManifest: boolean;
			/** Full default .forceignore content to create, or null when one exists. */
			forceignoreContent: string | null;
			/** .gitignore to write (create or append), or null when nothing to do. */
			gitignore: { content: string; created: boolean; added: string[] } | null;
			srcAction: SrcAction;
			movedSrcDir: string;
		};

export function planConversion(i: ConversionInputs): ConversionPlan {
	if (i.forceAppExists) {
		return { ok: false, reason: `"${OUTPUT_DIR}" already exists in this folder. Remove or rename it first; nothing was changed.` };
	}
	if (i.sfdxProjectExists) {
		return { ok: false, reason: "sfdx-project.json already exists in this folder; it is not an MDAPI project." };
	}
	const sourceApiVersion = resolveSourceApiVersion(i.packageXml, i.toolingApiVersion);

	let gitignore: { content: string; created: boolean; added: string[] } | null = null;
	if (i.gitignoreContent !== undefined) {
		const merged = mergeIgnoreLines(i.gitignoreContent, GITIGNORE_LINES);
		if (merged.added.length) gitignore = { content: merged.content, created: false, added: merged.added };
	} else if (i.isGitRepo) {
		const merged = mergeIgnoreLines("", GITIGNORE_LINES);
		gitignore = { content: merged.content, created: true, added: merged.added };
	}

	return {
		ok: true,
		sfdxProjectJson: buildSfdxProjectJson(i.folderName, sourceApiVersion),
		sourceApiVersion,
		convertArgs: ["project", "convert", "mdapi", "--root-dir", "src", "--output-dir", OUTPUT_DIR],
		copyManifest: !i.manifestPackageExists,
		forceignoreContent: i.forceignoreExists ? null : FORCEIGNORE_LINES.join("\n") + "\n",
		gitignore,
		srcAction: i.srcChoice === "move" ? (i.isGitRepo ? "git-mv" : "rename") : "none",
		movedSrcDir: MOVED_SRC_DIR,
	};
}

/** Human-readable steps for the confirmation dialog. */
export function describePlan(plan: Extract<ConversionPlan, { ok: true }>, srcChoice: SrcChoice): string[] {
	const steps = [
		`Create sfdx-project.json (package directory "${OUTPUT_DIR}", API ${plan.sourceApiVersion}).`,
		`Convert src/ to ${OUTPUT_DIR}/ with the Salesforce CLI.`,
	];
	if (plan.copyManifest) steps.push("Copy src/package.xml to manifest/package.xml.");
	if (plan.forceignoreContent) steps.push("Create .forceignore.");
	if (plan.gitignore) steps.push(plan.gitignore.created ? "Create .gitignore." : `Add ${plan.gitignore.added.join(", ")} to .gitignore.`);
	steps.push(
		srcChoice === "move"
			? `Move src/ to ${plan.movedSrcDir}/ (${plan.srcAction === "git-mv" ? "git mv" : "rename"}).`
			: "Keep src/ untouched."
	);
	return steps;
}

/**
 * Number of metadata components in a converted tree. `files` are paths relative to the
 * output dir; a `X-meta.xml` whose companion `X` exists is not counted separately.
 */
export function countComponents(files: readonly string[]): number {
	const set = new Set(files.map((f) => f.replace(/\\/g, "/")));
	let n = 0;
	for (const f of set) {
		if (f.endsWith("-meta.xml") && set.has(f.slice(0, -"-meta.xml".length))) continue;
		n++;
	}
	return n;
}
