/**
 * Background generation of SObject "schema stub" .cls files into the Salesforce
 * Apex LS folder (.sfdx/tools/sobjects/{standardObjects,customObjects}) so that:
 *   - the Salesforce Apex Language Server stops reporting "Invalid type" for
 *     objects its own refresh skips (custom metadata types, platform events,
 *     namespaced objects), and
 *   - native tooling / the host IDE's AI can discover the schema.
 *
 * Strategy (per the chosen policy):
 *   - FULL stubs (all fields + relationships) for objects referenced in the
 *     workspace; TYPE-ONLY stubs for the rest (cheap, makes the type valid).
 *   - Only manages files we created (marked with MARKER). Existing
 *     Salesforce-generated files are left untouched (no duplicate types / clobber).
 *   - Stale managed stubs (object removed from the org) are deleted on sync.
 *
 * Heavy/vscode-dependent dependencies are lazy-required so the pure helpers below
 * (stub content, used-object detection) stay unit-testable.
 */
import * as fs from "fs";
import * as path from "path";

export const STUB_MARKER = "// ASFX-MANAGED schema stub — regenerated automatically. Do not edit.";

// ─── Pure helpers (unit-testable) ───────────────────────────────────────────────

export interface StubFieldLike {
	name: string;
	type: string;
	label?: string;
	relationshipName?: string;
	referenceTo?: string[];
}
export interface StubDescribeLike {
	name?: string;
	label?: string;
	fields: StubFieldLike[];
	childRelationships: { name: string; childSObject: string }[];
}

/** Map a Salesforce field type to a representative Apex type for the stub. */
export function apexTypeForField(t: string, _f?: StubFieldLike): string {
	switch (t) {
		case "id":
		case "reference":
			return "Id";
		case "boolean":
			return "Boolean";
		case "int":
			return "Integer";
		case "double":
		case "currency":
		case "percent":
			return "Decimal";
		case "date":
			return "Date";
		case "datetime":
			return "Datetime";
		case "time":
			return "Time";
		case "base64":
			return "Blob";
		case "address":
			return "Address";
		case "location":
			return "Location";
		default:
			return "String"; // string, textarea, picklist, email, phone, url, …
	}
}

/** Whether an object lives under customObjects/ (custom suffix or namespaced) vs standardObjects/. */
export function isCustomObject(name: string): boolean {
	return /__(c|mdt|e|b|x|share|history|feed|changeevent|tag)$/i.test(name) || name.includes("__");
}

export function buildTypeOnlyStub(name: string): string {
	return `${STUB_MARKER}\nglobal class ${name} {\n}\n`;
}

const AUG_START = "    // ASFX-AUGMENTED-START — fields added by ASFX Toolkit";
const AUG_END = "    // ASFX-AUGMENTED-END";
const AUG_REGION_RE = /\n?[ \t]*\/\/ ASFX-AUGMENTED-START[\s\S]*?\/\/ ASFX-AUGMENTED-END[^\n]*/;

/**
 * Extend a Salesforce-generated stub in place: inject fields/relationships that
 * the existing class doesn't already declare, inside a delimited, re-runnable
 * region (so re-syncing replaces it rather than duplicating). Salesforce's own
 * content is preserved. Returns the (possibly unchanged) file content.
 */
export function augmentExistingStub(existing: string, d: StubDescribeLike): string {
	// Drop any previous ASFX region so we recompute against Salesforce's content only.
	const base = existing.replace(AUG_REGION_RE, "");
	const declared = new Set<string>();
	for (const m of base.matchAll(/\bglobal\s+[\w.<>]+\s+(\w+)\s*;/g)) declared.add(m[1].toLowerCase());

	const additions: string[] = [];
	const add = (decl: string, key: string) => {
		if (!declared.has(key.toLowerCase())) {
			additions.push(decl);
			declared.add(key.toLowerCase());
		}
	};
	for (const f of d.fields) {
		add(`    global ${apexTypeForField(f.type)} ${f.name};`, f.name);
		if (f.relationshipName && f.referenceTo && f.referenceTo[0]) {
			add(`    global ${f.referenceTo[0]} ${f.relationshipName};`, f.relationshipName);
		}
	}
	for (const cr of d.childRelationships ?? []) {
		add(`    global List<${cr.childSObject}> ${cr.name};`, cr.name);
	}

	if (!additions.length) return base; // nothing missing
	const lastBrace = base.lastIndexOf("}");
	if (lastBrace === -1) return base; // not a class body we understand
	const region = `\n${AUG_START}\n${additions.join("\n")}\n${AUG_END}\n`;
	return base.slice(0, lastBrace) + region + base.slice(lastBrace);
}

export function buildFullStub(name: string, d: StubDescribeLike): string {
	const lines: string[] = [STUB_MARKER, `// ${d.label ?? name}`, `global class ${name} {`];
	for (const f of d.fields) {
		const labelComment = f.label && f.label !== f.name ? `  // ${f.label}` : "";
		lines.push(`    global ${apexTypeForField(f.type, f)} ${f.name};${labelComment}`);
		if (f.relationshipName && f.referenceTo && f.referenceTo[0]) {
			lines.push(`    global ${f.referenceTo[0]} ${f.relationshipName};`);
		}
	}
	for (const cr of d.childRelationships ?? []) {
		lines.push(`    global List<${cr.childSObject}> ${cr.name};`);
	}
	lines.push("}");
	return lines.join("\n") + "\n";
}

interface NameLookup {
	byLower: Map<string, string>;
	byStripped: Map<string, string>;
}
function buildLookup(objectNames: string[], namespace: string | null): NameLookup {
	const byLower = new Map<string, string>();
	for (const n of objectNames) byLower.set(n.toLowerCase(), n);
	const byStripped = new Map<string, string>();
	if (namespace) {
		const prefix = namespace.toLowerCase() + "__";
		for (const n of objectNames) {
			const l = n.toLowerCase();
			if (l.startsWith(prefix)) byStripped.set(l.slice(prefix.length), n);
		}
	}
	return { byLower, byStripped };
}
function matchTokensInto(text: string, lookup: NameLookup, used: Set<string>): void {
	const tokens = text.match(/[A-Za-z_]\w*(?:__[A-Za-z]+)?/g);
	if (!tokens) return;
	for (const tok of tokens) {
		const l = tok.toLowerCase();
		const hit = lookup.byLower.get(l) ?? lookup.byStripped.get(l);
		if (hit) used.add(hit);
	}
}

/**
 * From workspace file contents, the set of object API names that are referenced.
 * Matches both the full API name and (when a namespace is given) the un-prefixed
 * form so `Widget__c` counts as using `ns__Widget__c`.
 * (Pure; used by tests. The sync uses the streaming walker below.)
 */
export function collectUsedObjectsFromTexts(texts: string[], objectNames: string[], namespace: string | null): Set<string> {
	const lookup = buildLookup(objectNames, namespace);
	const used = new Set<string>();
	for (const text of texts) matchTokensInto(text, lookup, used);
	return used;
}

// ─── File-walking + sync (impure) ───────────────────────────────────────────────

const SOURCE_EXT = /\.(cls|trigger|soql)$/i;
const IGNORE_DIRS = new Set(["node_modules", ".git", ".sfdx", "out", "dist"]);

// Stream workspace source files (one at a time, never all in memory) to find the
// referenced object names.
function collectUsedObjects(root: string, objectNames: string[], namespace: string | null, cap = 8000): Set<string> {
	const lookup = buildLookup(objectNames, namespace);
	const used = new Set<string>();
	let scanned = 0;
	const walk = (dir: string): void => {
		if (scanned >= cap) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (scanned >= cap) return;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!IGNORE_DIRS.has(e.name)) walk(full);
			} else if (SOURCE_EXT.test(e.name)) {
				try {
					matchTokensInto(fs.readFileSync(full, "utf8"), lookup, used);
					scanned++;
				} catch {
					/* ignore */
				}
			}
		}
	};
	walk(root);
	return used;
}

function readFileOrEmpty(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf8");
}

// Cap deletions per run so we never delete a huge batch of stub files at once,
// which can make the Salesforce indexer churn (and previously triggered a bug).
const MAX_DELETIONS_PER_RUN = 100;

/** Remove managed stubs whose object no longer exists in the org (capped). */
function cleanupStaleManaged(base: string, liveNames: Set<string>): void {
	let deleted = 0;
	for (const sub of ["standardObjects", "customObjects"]) {
		const dir = path.join(base, sub);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (deleted >= MAX_DELETIONS_PER_RUN) return;
			if (!e.isFile() || !e.name.endsWith(".cls")) continue;
			const name = e.name.slice(0, -4);
			if (liveNames.has(name)) continue;
			const file = path.join(dir, e.name);
			try {
				if (fs.readFileSync(file, "utf8").startsWith(STUB_MARKER)) {
					fs.unlinkSync(file);
					deleted++;
				}
			} catch {
				/* ignore */
			}
		}
	}
}

async function syncProject(
	projectDir: string,
	org: string | null,
	scope: "referenced" | "all",
	report?: (msg: string) => void,
): Promise<number> {
	// Lazy-require vscode-dependent modules so the pure helpers stay testable.
	const { OrgMetadataCache } = require("./orgMetadataCache");
	const { SoqlSchemaProvider } = require("./soqlSchemaProvider");
	const { outputChannel } = require("./outputChannel");

	const objectNames: string[] = await OrgMetadataCache.getObjectList(org);
	if (!objectNames.length) return 0;

	let namespace: string | null = null;
	try {
		const raw = fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8");
		const ns = JSON.parse(raw).namespace;
		namespace = typeof ns === "string" && ns.trim() ? ns.trim() : null;
	} catch {
		namespace = null;
	}

	const used = collectUsedObjects(projectDir, objectNames, namespace);
	const base = path.join(projectDir, ".sfdx", "tools", "sobjects");

	// Default ("referenced") only touches objects used in code — tens, not the
	// thousands a full org has. "all" additionally writes type-only stubs for the
	// rest (heavier I/O).
	const liveSet = new Set(objectNames);
	const targets = scope === "all" ? objectNames : objectNames.filter((n) => used.has(n));

	let written = 0;
	let done = 0;
	for (const name of targets) {
		report?.(`${++done}/${targets.length} ${name}`);
		const dir = path.join(base, isCustomObject(name) ? "customObjects" : "standardObjects");
		const file = path.join(dir, `${name}.cls`);
		const before = readFileOrEmpty(file);
		const isSalesforceOwned = !!before && !before.startsWith(STUB_MARKER);

		let content: string;
		if (used.has(name)) {
			const d = await SoqlSchemaProvider.getDescribe(org, name);
			content = isSalesforceOwned
				? d ? augmentExistingStub(before, d) : before
				: d ? buildFullStub(name, d) : buildTypeOnlyStub(name);
		} else {
			// scope === "all", unused: type-only, but never overwrite Salesforce's.
			if (isSalesforceOwned) continue;
			content = buildTypeOnlyStub(name);
		}

		if (content !== before) {
			writeFile(file, content);
			written++;
		}
	}

	// Remove our managed stubs that are stale (object gone, or no longer used in
	// "referenced" mode).
	cleanupStaleManaged(base, scope === "all" ? liveSet : new Set(used));
	outputChannel.appendLine(`SObjectStubSync: ${projectDir} — ${written} stub(s) written/extended (${used.size} referenced, scope=${scope}).`);
	return written;
}

let timer: NodeJS.Timeout | undefined;

/**
 * Debounced background sync for all SFDX projects in the workspace. Safe no-op
 * when disabled or outside an SFDX project. Never throws into the caller.
 */
export function scheduleStubSync(): void {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		void runStubSync();
	}, 1500);
}

let firstSyncDone = false;
let firstSyncWrote = false;

/** State of the initial background stub sync — used to time the post-load restart. */
export function getInitialSyncState(): { done: boolean; wrote: boolean } {
	return { done: firstSyncDone, wrote: firstSyncWrote };
}

async function runStubSync(): Promise<void> {
	try {
		const vscode = require("vscode");
		const enabled = vscode.workspace
			.getConfiguration("adure-sfx-toolkit")
			.get("apex.generateSObjectStubs", true);
		if (!enabled) return;
		const { resolveDefaultTargetOrgUsernameSync } = require("./defaultOrg");
		const scope = vscode.workspace.getConfiguration("adure-sfx-toolkit").get("apex.stubScope", "referenced") === "all" ? "all" : "referenced";
		const folders: { uri: { fsPath: string } }[] = vscode.workspace.workspaceFolders ?? [];
		let changed = 0;
		// Status-bar (Window) progress so the user knows we're caching org schema.
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "ASFX: caching org schema" },
			async (progress: { report: (v: { message?: string }) => void }) => {
				for (const folder of folders) {
					const root = folder.uri.fsPath;
					// Sync the workspace root project and any nested sfdx-project.json dirs.
					for (const projectDir of findSfdxProjectDirs(root)) {
						const org = resolveDefaultTargetOrgUsernameSync(projectDir) ?? null;
						changed += await syncProject(projectDir, org, scope, (msg) => progress.report({ message: msg }));
					}
				}
			},
		);
		// Record the first sync's outcome so the post-initial-load restart (handled
		// by the health monitor, after the LS finishes loading) knows whether new
		// stub types were written and need to be picked up.
		if (!firstSyncDone) {
			firstSyncDone = true;
			firstSyncWrote = changed > 0;
		}

		// Opt-in incremental restart after later stub changes (default OFF: the
		// Salesforce LS picks up changes via its file watcher; restarting on large
		// change sets can trigger a Salesforce indexer bug).
		if (changed > 0 && vscode.workspace.getConfiguration("adure-sfx-toolkit").get("apex.autoRestartLanguageServer", false)) {
			await forceApexRestart(vscode);
		}
	} catch (e: any) {
		try {
			require("./outputChannel").outputChannel.appendLine(`SObjectStubSync failed: ${e?.message ?? e}`);
		} catch {
			/* ignore */
		}
	}
}

// Known Salesforce Apex LS restart command ids across extension versions, plus a
// dynamic fallback. Restarting makes it re-read the stub files we just wrote.
const APEX_RESTART_COMMANDS = [
	"sf.apex.languageServer.restart",
	"sfdx.force.apex.languageServer.restart",
];

let lastRestart = 0;

function logSync(m: string): void {
	require("./outputChannel").outputChannel.appendLine(`SObjectStubSync: ${m}`);
}

async function findRestartCommand(vscode: any): Promise<string | undefined> {
	const all: string[] = await vscode.commands.getCommands(true);
	return (
		APEX_RESTART_COMMANDS.find((c) => all.includes(c)) ??
		all.find((c) => /apex/i.test(c) && /languageserver/i.test(c) && /restart/i.test(c)) ??
		all.find((c) => /restart/i.test(c) && /apex/i.test(c))
	);
}

/**
 * Invoke the Salesforce Apex restart command with a specific behavior, silently
 * (source "statusBar" honors `restartBehavior` instead of prompting). For a given
 * `behavior` we temporarily set the config, run, then restore it — leaving the
 * user's setting unchanged. `restart` keeps the Apex DB; `reset` cleans it.
 */
async function invokeApexRestart(vscode: any, behavior: "restart" | "reset"): Promise<boolean> {
	if (!vscode.extensions.getExtension("salesforce.salesforcedx-vscode-apex")) return false;
	const cmd = await findRestartCommand(vscode);
	if (!cmd) {
		logSync("no Apex restart command found; reload the window or run 'SFDX: Restart Apex Language Server'.");
		return false;
	}
	try {
		if (cmd === "sf.apex.languageServer.restart") {
			const cfg = vscode.workspace.getConfiguration("salesforcedx-vscode-apex");
			const prev = cfg.inspect("languageServer.restartBehavior")?.globalValue;
			await cfg.update("languageServer.restartBehavior", behavior, vscode.ConfigurationTarget.Global);
			try {
				await vscode.commands.executeCommand(cmd, "statusBar");
			} finally {
				await cfg.update("languageServer.restartBehavior", prev, vscode.ConfigurationTarget.Global);
			}
		} else {
			await vscode.commands.executeCommand(cmd);
		}
		return true;
	} catch (e: any) {
		logSync(`Apex LS ${behavior} failed: ${e?.message ?? e}`);
		return false;
	}
}

/** Silent restart (keep DB), throttled to once per 30s. Used after stub changes. */
export async function forceApexRestart(vscode: any): Promise<boolean> {
	const now = Date.now();
	if (now - lastRestart < 30000) return false;
	const ok = await invokeApexRestart(vscode, "restart");
	if (ok) {
		lastRestart = now;
		logSync("requested Apex Language Server restart (keep DB).");
	}
	return ok;
}

/** Clean the Apex DB and restart — recovery path when the LS has crashed/corrupted. */
export async function cleanRestartApex(vscode: any): Promise<boolean> {
	const ok = await invokeApexRestart(vscode, "reset");
	if (ok) {
		lastRestart = Date.now();
		logSync("requested Apex Language Server clean + restart (reset DB).");
	}
	return ok;
}

/** All directories under root (incl. root) that contain an sfdx-project.json. */
function findSfdxProjectDirs(root: string, cap = 50): string[] {
	const dirs: string[] = [];
	const walk = (dir: string): void => {
		if (dirs.length >= cap) return;
		if (fs.existsSync(path.join(dir, "sfdx-project.json"))) dirs.push(dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) walk(path.join(dir, e.name));
		}
	};
	walk(root);
	return dirs;
}
