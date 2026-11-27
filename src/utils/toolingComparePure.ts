/**
 * Layer 2 of the layered content compare, pure part: read the SOURCE of code components from the Tooling API
 * (no retrieve) and compare it with the local files. Builds the queries (batched by URL length), turns the
 * records into per-file digests (same normalisation and digest as the local files: `digestContent`), groups
 * bundle files per component and decides `same` / `different` / undecided. No `vscode`, no I/O.
 *
 * Objects and fields used (Tooling API):
 *   ApexClass / ApexTrigger        Name, NamespacePrefix, Body
 *   ApexPage / ApexComponent       Name, NamespacePrefix, Markup
 *   LightningComponentResource     FilePath, Source, LightningComponentBundle.DeveloperName / .NamespacePrefix
 *   AuraDefinition                 DefType, Source, AuraDefinitionBundle.DeveloperName / .NamespacePrefix
 *
 * `-meta.xml` files are not part of any of these. Decision (documented in `decideTooling`): a difference in any
 * body file is `different` (exact, the meta files do not matter); equal bodies are `same` only when the meta
 * files are vouched for by the sync record (org time unchanged since the record, local meta files unchanged);
 * otherwise the component is left to the retrieve layer.
 */
import { compareDigests, digestContent, hashDigests, lookupKeyOf } from "./contentComparePure";
import { ContentResult } from "./compareStatusPure";
import { SyncEntry, isMetaInner, splitMetaDigests } from "./syncRecordPure";

/** Metadata types this layer can read from the Tooling API. */
export const TOOLING_TYPES: ReadonlySet<string> = new Set(["ApexClass", "ApexTrigger", "ApexPage", "ApexComponent", "LightningComponentBundle", "AuraDefinitionBundle"]);

interface SingleSpec {
	kind: "single";
	sobject: string;
	bodyField: string;
	/** Local file suffix: `Foo` + `.cls`. */
	ext: string;
}
interface BundleSpec {
	kind: "lwc" | "aura";
	sobject: string;
	/** Relationship to the bundle record. */
	rel: string;
}
const SPECS: Record<string, SingleSpec | BundleSpec> = {
	ApexClass: { kind: "single", sobject: "ApexClass", bodyField: "Body", ext: ".cls" },
	ApexTrigger: { kind: "single", sobject: "ApexTrigger", bodyField: "Body", ext: ".trigger" },
	ApexPage: { kind: "single", sobject: "ApexPage", bodyField: "Markup", ext: ".page" },
	ApexComponent: { kind: "single", sobject: "ApexComponent", bodyField: "Markup", ext: ".component" },
	LightningComponentBundle: { kind: "lwc", sobject: "LightningComponentResource", rel: "LightningComponentBundle" },
	AuraDefinitionBundle: { kind: "aura", sobject: "AuraDefinition", rel: "AuraDefinitionBundle" },
};

/** What `parse…` found for one org component. `files` undefined = the org does not hand out (all of) its source (managed code, unknown definition type). */
export interface OrgSourceCandidate {
	/** NamespacePrefix of the org record ("" = none). */
	ns: string;
	/** Inner path (as the local files have it, e.g. `Foo.cls`, `foo/foo.js`) → digest. */
	files?: Map<string, string>;
}

/** What the compare asks for. */
export interface ToolingTarget {
	type: string;
	/** Name as the local index has it. */
	name: string;
	/** Namespace of the org component (from the listing); "" = none. */
	ns: string;
}

const soqlStr = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** The name the org's source objects use for a component (`DeveloperName` / `Name`, no namespace). Percent-encoding of file names is decoded. */
export function orgDeveloperName(t: { type: string; name: string; ns: string }): string {
	let n = lookupKeyOf(t.type, t.name).slice(t.type.length + 1);
	if (t.ns && n.startsWith(`${t.ns}__`)) n = n.slice(t.ns.length + 2);
	return n;
}

/** The SOQL of one batch of names of `type`. */
export function toolingQuery(type: string, names: readonly string[]): string {
	const spec = SPECS[type];
	if (!spec) throw new Error(`No Tooling source for ${type}`);
	const list = names.map(soqlStr).join(",");
	if (spec.kind === "single") return `SELECT Name, NamespacePrefix, ${spec.bodyField} FROM ${spec.sobject} WHERE Name IN (${list})`;
	const fields =
		spec.kind === "lwc"
			? `${spec.rel}.DeveloperName, ${spec.rel}.NamespacePrefix, FilePath, Source`
			: `${spec.rel}.DeveloperName, ${spec.rel}.NamespacePrefix, DefType, Source`;
	return `SELECT ${fields} FROM ${spec.sobject} WHERE ${spec.rel}.DeveloperName IN (${list})`;
}

/**
 * Split `targets` into queries: per type, as many names per query as keep the encoded URL below `maxUrlChars`
 * (Salesforce rejects URLs above 16 KB; ~1,000 classes take a handful of requests). `names` of a query map back to the targets by developer name.
 */
export function buildToolingQueries(targets: readonly ToolingTarget[], maxUrlChars = 9000): { type: string; soql: string; names: string[] }[] {
	const byType = new Map<string, Set<string>>();
	for (const t of targets) {
		if (!TOOLING_TYPES.has(t.type)) continue;
		let s = byType.get(t.type);
		if (!s) byType.set(t.type, (s = new Set()));
		s.add(orgDeveloperName(t));
	}
	const out: { type: string; soql: string; names: string[] }[] = [];
	for (const [type, set] of byType) {
		const base = encodeURIComponent(toolingQuery(type, [])).length;
		let cur: string[] = [];
		let len = base;
		const flush = () => {
			if (cur.length > 0) out.push({ type, soql: toolingQuery(type, cur), names: cur });
			cur = [];
			len = base;
		};
		for (const n of [...set].sort()) {
			const add = encodeURIComponent(soqlStr(n)).length + 3; // the quotes and the comma
			if (cur.length > 0 && len + add > maxUrlChars) flush();
			cur.push(n);
			len += add;
		}
		flush();
	}
	return out;
}

// ── Records → per-file digests ─────────────────────────────────────────────────

const digestOfText = (text: string): string => digestContent(Buffer.from(text, "utf8"));

/** Local file name of an Aura definition (`DefType`), without the bundle name; undefined for a definition type this layer does not know. */
const AURA_FILE: Record<string, (bundle: string) => string> = {
	COMPONENT: (b) => `${b}.cmp`,
	APPLICATION: (b) => `${b}.app`,
	EVENT: (b) => `${b}.evt`,
	INTERFACE: (b) => `${b}.intf`,
	TOKENS: (b) => `${b}.tokens`,
	DESIGN: (b) => `${b}.design`,
	SVG: (b) => `${b}.svg`,
	DOCUMENTATION: (b) => `${b}.auradoc`,
	STYLE: (b) => `${b}.css`,
	CONTROLLER: (b) => `${b}Controller.js`,
	HELPER: (b) => `${b}Helper.js`,
	RENDERER: (b) => `${b}Renderer.js`,
	PROVIDER: (b) => `${b}Provider.js`,
	MODEL: (b) => `${b}Model.js`,
	TESTSUITE: (b) => `${b}Test.js`,
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" ? (v as Record<string, unknown>) : undefined);

/**
 * Turn the records of one query into candidates, keyed `Type:DeveloperName`. Several records with the same
 * name and namespace (never expected) make the component undecidable (`files` undefined).
 */
export function parseToolingRecords(type: string, records: readonly unknown[]): Map<string, OrgSourceCandidate[]> {
	const spec = SPECS[type];
	const out = new Map<string, OrgSourceCandidate[]>();
	if (!spec) return out;
	const add = (name: string, ns: string, files: Map<string, string> | undefined): void => {
		const key = `${type}:${name}`;
		const list = out.get(key) ?? [];
		const dup = list.find((c) => c.ns === ns);
		if (dup) dup.files = undefined;
		else list.push({ ns, files });
		out.set(key, list);
	};
	if (spec.kind === "single") {
		for (const r of records) {
			const o = rec(r);
			const name = str(o?.Name);
			if (!o || !name) continue;
			const body = str(o[spec.bodyField]);
			add(name, str(o.NamespacePrefix) ?? "", body === undefined ? undefined : new Map([[`${name}${spec.ext}`, digestOfText(body)]]));
		}
		return out;
	}
	// Bundles: one record per file; a bundle is complete only when every one of its files has readable source.
	const bundles = new Map<string, { name: string; ns: string; files: Map<string, string>; ok: boolean }>();
	for (const r of records) {
		const o = rec(r);
		const b = rec(o?.[spec.rel]);
		const name = str(b?.DeveloperName);
		if (!o || !name) continue;
		const ns = str(b?.NamespacePrefix) ?? "";
		const id = `${ns}\0${name}`;
		let g = bundles.get(id);
		if (!g) bundles.set(id, (g = { name, ns, files: new Map(), ok: true }));
		const source = str(o.Source);
		let inner: string | undefined;
		if (spec.kind === "lwc") {
			const fp = str(o.FilePath);
			if (fp !== undefined) inner = fp.replace(/^lwc\//, "");
		} else {
			const f = AURA_FILE[str(o.DefType) ?? ""];
			if (f) inner = `${name}/${f(name)}`;
		}
		// The `-meta.xml` of a bundle is the meta layer's business, never decided from here.
		if (inner !== undefined && isMetaInner(inner)) continue;
		if (inner === undefined || source === undefined) {
			g.ok = false;
			continue;
		}
		g.files.set(inner, digestOfText(source));
	}
	for (const g of bundles.values()) add(g.name, g.ns, g.ok ? g.files : undefined);
	return out;
}

/** The candidate of the right namespace, undefined when there is none or it is ambiguous. */
export function pickCandidate(cands: readonly OrgSourceCandidate[] | undefined, ns: string): OrgSourceCandidate | undefined {
	const m = (cands ?? []).filter((c) => c.ns === ns);
	return m.length === 1 ? m[0] : undefined;
}

// ── Decision ───────────────────────────────────────────────────────────────────

export interface ToolingDecisionInput {
	/** The component's local files, `inner → digest`. */
	local: ReadonlyMap<string, string>;
	/** The org's body files of the component; undefined = not readable from the Tooling API. */
	org: ReadonlyMap<string, string> | undefined;
	/** The org's current lastModifiedDate. */
	orgLm: number;
	syncRecord?: SyncEntry;
}

/**
 * - body files differ (a file missing or different on either side): `different`, whatever the meta files say;
 * - body files equal and the component has no meta file: `same`;
 * - body files equal and the meta files are vouched for (the sync record has the org's current lastModifiedDate
 *   and the same meta hash as the local meta files now): `same`;
 * - otherwise undecided: the retrieve layer compares the meta files too.
 */
export function decideTooling(i: ToolingDecisionInput): ContentResult | undefined {
	if (!i.org) return undefined;
	const { body, meta } = splitMetaDigests(i.local);
	if (body.size === 0) return undefined;
	if (compareDigests(body, i.org) === "different") return "different";
	if (meta.size === 0) return "same";
	const r = i.syncRecord;
	if (r && r.lm !== undefined && r.lm === i.orgLm && r.meta !== undefined && r.meta === hashDigests(meta)) return "same";
	return undefined;
}
