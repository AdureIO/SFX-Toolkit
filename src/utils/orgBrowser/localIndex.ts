/**
 * Local presence of metadata: scans the SFDX project's package directories (source format) and maps
 * source files to `Type:fullName`. Pure (no `vscode`): the watcher lives in the panel provider.
 *
 * The type → (directory, suffix) table comes from describeMetadata when known, over a built-in
 * fallback so the index also works offline / before the first listing.
 */
import * as fs from "fs";
import * as path from "path";
import { TypeInfo, compKey } from "./types";

// ── Type table ─────────────────────────────────────────────────────────────────

interface DirType {
	type: string;
	suffix: string;
}

/** Fallback `type → directory + suffix` (source format) for the common types. */
const STATIC_TYPES: { type: string; dir: string; suffix: string }[] = [
	["ApexClass", "classes", "cls"],
	["ApexTrigger", "triggers", "trigger"],
	["ApexPage", "pages", "page"],
	["ApexComponent", "components", "component"],
	["ApexTestSuite", "testSuites", "testSuite"],
	["CustomObject", "objects", "object"],
	["CustomTab", "tabs", "tab"],
	["CustomApplication", "applications", "app"],
	["CustomLabels", "labels", "labels"],
	["CustomMetadata", "customMetadata", "md"],
	["CustomPermission", "customPermissions", "customPermission"],
	["CustomNotificationType", "notificationtypes", "notiftype"],
	["Layout", "layouts", "layout"],
	["FlexiPage", "flexipages", "flexipage"],
	["QuickAction", "quickActions", "quickAction"],
	["Flow", "flows", "flow"],
	["FlowDefinition", "flowDefinitions", "flowDefinition"],
	["PermissionSet", "permissionsets", "permissionset"],
	["PermissionSetGroup", "permissionsetgroups", "permissionsetgroup"],
	["Profile", "profiles", "profile"],
	["Role", "roles", "role"],
	["Group", "groups", "group"],
	["Queue", "queues", "queue"],
	["StaticResource", "staticresources", "resource"],
	["ContentAsset", "contentassets", "asset"],
	["GlobalValueSet", "globalValueSets", "globalValueSet"],
	["StandardValueSet", "standardValueSets", "standardValueSet"],
	["RemoteSiteSetting", "remoteSiteSettings", "remoteSite"],
	["CspTrustedSite", "cspTrustedSites", "cspTrustedSite"],
	["NamedCredential", "namedCredentials", "namedCredential"],
	["ExternalCredential", "externalCredentials", "externalCredential"],
	["ConnectedApp", "connectedApps", "connectedApp"],
	["CustomSite", "sites", "site"],
	["Network", "networks", "network"],
	["Workflow", "workflows", "workflow"],
	["ApprovalProcess", "approvalProcesses", "approvalProcess"],
	["AssignmentRules", "assignmentRules", "assignmentRules"],
	["AutoResponseRules", "autoResponseRules", "autoResponseRules"],
	["EscalationRules", "escalationRules", "escalationRules"],
	["MatchingRules", "matchingRules", "matchingRule"],
	["DuplicateRule", "duplicateRules", "duplicateRule"],
	["SharingRules", "sharingRules", "sharingRules"],
	["Settings", "settings", "settings"],
	["ReportType", "reportTypes", "reportType"],
	["Report", "reports", "report"],
	["Dashboard", "dashboards", "dashboard"],
	["Document", "documents", "document"],
	["EmailTemplate", "email", "email"],
	["ReportFolder", "reports", "reportFolder"],
	["DashboardFolder", "dashboards", "dashboardFolder"],
	["DocumentFolder", "documents", "documentFolder"],
	["EmailFolder", "email", "emailFolder"],
	["CustomObjectTranslation", "objectTranslations", "objectTranslation"],
	["Translations", "translations", "translation"],
	["EmailServicesFunction", "emailservices", "xml"],
	["LightningMessageChannel", "messageChannels", "messageChannel"],
	["PlatformEventChannel", "platformEventChannels", "platformEventChannel"],
	["Territory2Model", "territory2Models", "territory2Model"],
	["Territory2Type", "territory2Types", "territory2Type"],
	["EntitlementProcess", "entitlementProcesses", "entitlementProcess"],
	["SamlSsoConfig", "samlssoconfigs", "samlssoconfig"],
	["AuthProvider", "authproviders", "authprovider"],
	["ExperienceBundle", "experiences", "site"],
	["ManagedTopics", "managedTopics", "managedTopics"],
	["Prompt", "prompts", "prompt"],
	["LightningExperienceTheme", "lightningExperienceThemes", "lightningExperienceTheme"],
].map(([type, dir, suffix]) => ({ type, dir, suffix }));

/** Directories whose entries are whole folders (bundles) → metadata type. */
const BUNDLE_DIRS: Record<string, string> = {
	lwc: "LightningComponentBundle",
	aura: "AuraDefinitionBundle",
	experiences: "ExperienceBundle",
	waveTemplates: "WaveTemplateBundle",
	lightningTypes: "LightningTypeBundle",
};

/** `objects/<Obj>/<dir>/<name>.<suffix>-meta.xml` children of a decomposed CustomObject. */
const OBJECT_CHILDREN: Record<string, DirType> = {
	fields: { type: "CustomField", suffix: "field" },
	validationRules: { type: "ValidationRule", suffix: "validationRule" },
	recordTypes: { type: "RecordType", suffix: "recordType" },
	listViews: { type: "ListView", suffix: "listView" },
	webLinks: { type: "WebLink", suffix: "webLink" },
	compactLayouts: { type: "CompactLayout", suffix: "compactLayout" },
	fieldSets: { type: "FieldSet", suffix: "fieldSet" },
	businessProcesses: { type: "BusinessProcess", suffix: "businessProcess" },
	sharingReasons: { type: "SharingReason", suffix: "sharingReason" },
	indexes: { type: "Index", suffix: "index" },
};

export interface TypeTable {
	/** directory name → types stored there (distinguished by suffix). */
	byDir: Map<string, DirType[]>;
}

/** Build the lookup table from describeMetadata types (may be empty) over the built-in fallback. */
export function buildTypeTable(described: TypeInfo[] = []): TypeTable {
	const byDir = new Map<string, DirType[]>();
	const add = (dir: string, type: string, suffix: string) => {
		if (!dir || !suffix) return;
		const list = byDir.get(dir) ?? [];
		if (!list.some((x) => x.type === type)) list.push({ type, suffix });
		byDir.set(dir, list);
	};
	for (const t of described) add(t.dir, t.name, t.suffix);
	for (const t of STATIC_TYPES) add(t.dir, t.type, t.suffix);
	return { byDir };
}

// ── Path → component mapping ───────────────────────────────────────────────────

export interface MappedFile {
	type: string;
	name: string;
	/** `meta`: the component's own -meta.xml (creates the entry); `bundle`: file inside a bundle directory; `content`: companion/body file (attach only). */
	kind: "meta" | "bundle" | "content";
	/** Bundle root directory, relative to the package dir (forward slashes). */
	bundleRoot?: string;
}

const META_SUFFIX = "-meta.xml";

function splitMeta(file: string): { name: string; suffix: string } | null {
	if (!file.endsWith(META_SUFFIX)) return null;
	const base = file.slice(0, -META_SUFFIX.length);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return null;
	return { name: base.slice(0, dot), suffix: base.slice(dot + 1) };
}

/**
 * Map one source file (path relative to a package directory, forward slashes) to the component it
 * belongs to, or null when it is not part of a component (sfdx-project.json, READMEs, …).
 */
export function mapSourceFile(rel: string, table: TypeTable): MappedFile | null {
	const seg = rel.split("/").filter(Boolean);
	let k = -1;
	for (let i = 0; i < seg.length - 1; i++) {
		if (table.byDir.has(seg[i]) || BUNDLE_DIRS[seg[i]]) {
			k = i;
			break;
		}
	}
	if (k < 0) return null;
	const dir = seg[k];
	const rest = seg.slice(k + 1);
	const file = rest[rest.length - 1];

	// Bundles (lwc, aura, experiences …): everything under <dir>/<name>/ belongs to <name>.
	const bundleType = BUNDLE_DIRS[dir];
	if (bundleType && rest.length >= 2) {
		return { type: bundleType, name: rest[0], kind: "bundle", bundleRoot: seg.slice(0, k + 2).join("/") };
	}
	if (bundleType && rest.length === 1) {
		const m = splitMeta(file);
		if (m && table.byDir.get(dir)?.some((d) => d.suffix === m.suffix)) {
			return { type: table.byDir.get(dir)!.find((d) => d.suffix === m.suffix)!.type, name: m.name, kind: "meta" };
		}
		return null;
	}

	// Decomposed CustomObject: objects/<Obj>/<Obj>.object-meta.xml and objects/<Obj>/<childDir>/<name>.<suffix>-meta.xml.
	if (dir === "objects" && rest.length >= 2) {
		const obj = rest[0];
		const m = splitMeta(file);
		if (!m) return null;
		if (rest.length === 2 && m.suffix === "object" && m.name === obj) return { type: "CustomObject", name: obj, kind: "meta" };
		if (rest.length === 3) {
			const child = OBJECT_CHILDREN[rest[1]];
			if (child && m.suffix === child.suffix) return { type: child.type, name: `${obj}.${m.name}`, kind: "meta" };
		}
		return null;
	}

	const types = table.byDir.get(dir) ?? [];
	const m = splitMeta(file);

	// Static resources: unzipped folder content belongs to <name>; the zip/js body is a sibling file.
	if (dir === "staticresources") {
		if (rest.length === 1 && m && m.suffix === "resource") return { type: "StaticResource", name: m.name, kind: "meta" };
		if (rest.length >= 2) return { type: "StaticResource", name: rest[0], kind: "content" };
		const dot = file.lastIndexOf(".");
		return { type: "StaticResource", name: dot > 0 ? file.slice(0, dot) : file, kind: "content" };
	}

	if (m) {
		const hit = types.find((t) => t.suffix === m.suffix);
		if (!hit) return null;
		// Folder-based types keep the folder path in the name: reports/Folder/Report.report-meta.xml → Folder/Report
		if (rest.length > 1) {
			const folderBased = hit.type === "Report" || hit.type === "Dashboard" || hit.type === "Document" || hit.type === "EmailTemplate" || /Folder$/.test(hit.type);
			if (folderBased) return { type: hit.type, name: [...rest.slice(0, -1), m.name].join("/"), kind: "meta" };
			// <dir>/<name>/<name>.<suffix>-meta.xml (objectTranslations …)
			if (rest.length === 2 && rest[0] === m.name) return { type: hit.type, name: m.name, kind: "meta" };
			return null;
		}
		return { type: hit.type, name: m.name, kind: "meta" };
	}

	// Content files (classes/Foo.cls, email/Folder/T.email, documents/Folder/x.png …): companions of a -meta.xml.
	const contentType = types.find((t) => file.endsWith("." + t.suffix));
	if (contentType) {
		const stripped = [...rest.slice(0, -1), file.slice(0, -(contentType.suffix.length + 1))];
		const folderBased = rest.length > 1;
		return { type: contentType.type, name: folderBased ? stripped.join("/") : stripped[0], kind: "content" };
	}
	return null;
}

// ── Project scan ───────────────────────────────────────────────────────────────

export interface LocalEntry {
	type: string;
	name: string;
	key: string;
	/** Every file of the component (bundles: all files). Absolute paths. */
	files: string[];
	/** Bundle root directory (absolute) — overwrite/reveal target for bundles. */
	root?: string;
	/** The file to open / compare. */
	primary: string;
}

export interface LocalIndex {
	entries: Map<string, LocalEntry>;
	scannedAt: number;
}

/** `packageDirectories[].path` from sfdx-project.json ([] when missing / unreadable). */
export function readPackageDirectories(projectDir: string): string[] {
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "sfdx-project.json"), "utf8"));
		const dirs: string[] = Array.isArray(cfg?.packageDirectories) ? cfg.packageDirectories.map((p: { path?: string }) => p?.path).filter(Boolean) : [];
		return dirs;
	} catch {
		return [];
	}
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".sfdx", ".sf", ".vscode", ".husky", "__tests__"]);

async function walk(dir: string, out: string[]): Promise<void> {
	let ents: fs.Dirent[];
	try {
		ents = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const subs: Promise<void>[] = [];
	for (const e of ents) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			subs.push(walk(path.join(dir, e.name), out));
		} else if (e.isFile()) {
			out.push(path.join(dir, e.name));
		}
	}
	await Promise.all(subs);
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Scan `packageDirs` (relative to `projectDir`) and build the local index. */
export async function scanProject(projectDir: string, packageDirs: string[], table: TypeTable = buildTypeTable()): Promise<LocalIndex> {
	const entries = new Map<string, LocalEntry>();
	const content: { mapped: MappedFile; abs: string; pkgAbs: string }[] = [];

	for (const pkg of packageDirs) {
		const pkgAbs = path.resolve(projectDir, pkg);
		const files: string[] = [];
		await walk(pkgAbs, files);
		for (const abs of files) {
			const rel = toPosix(path.relative(pkgAbs, abs));
			const mapped = mapSourceFile(rel, table);
			if (!mapped) continue;
			const key = compKey(mapped.type, mapped.name);
			if (mapped.kind === "content") {
				content.push({ mapped, abs, pkgAbs });
				continue;
			}
			let entry = entries.get(key);
			if (!entry) {
				entry = { type: mapped.type, name: mapped.name, key, files: [], primary: abs };
				if (mapped.bundleRoot) entry.root = path.join(pkgAbs, ...mapped.bundleRoot.split("/"));
				entries.set(key, entry);
			}
			entry.files.push(abs);
		}
	}
	// Companion/body files attach to an existing entry only.
	for (const c of content) {
		const entry = entries.get(compKey(c.mapped.type, c.mapped.name));
		if (!entry) continue;
		entry.files.push(c.abs);
		if (entry.primary.endsWith(META_SUFFIX)) entry.primary = c.abs;
	}
	// Bundles: open the main script/markup file.
	for (const e of entries.values()) {
		if (!e.root) continue;
		const base = path.basename(e.root);
		const pick =
			e.files.find((f) => f === path.join(e.root!, `${base}.js`)) ??
			e.files.find((f) => f === path.join(e.root!, `${base}.cmp`)) ??
			e.files.find((f) => !f.endsWith(META_SUFFIX)) ??
			e.files[0];
		if (pick) e.primary = pick;
	}
	return { entries, scannedAt: Date.now() };
}

/** Absolute paths a retrieve of this entry would overwrite (the bundle directory, or its files). */
export function overwriteTargets(entry: LocalEntry): string[] {
	return entry.root ? [entry.root] : entry.files;
}
