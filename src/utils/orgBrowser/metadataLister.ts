/**
 * Org Browser listing: describeMetadata + listMetadata over the Metadata SOAP API (the CLI is far too
 * slow to enumerate every type), plus the on-disk listing cache. Pure (no `vscode`): the SOAP transport
 * is injected (`call`), so the parsing, batching, folder expansion and failure isolation are unit-tested
 * against XML fixtures.
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { XMLParser } from "fast-xml-parser";
import { Comp, ListFailure, TypeInfo } from "./types";

// ── SOAP bodies ────────────────────────────────────────────────────────────────

const MET_NS = "http://soap.sforce.com/2006/04/metadata";

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Wrap an operation element in a SOAP envelope carrying the session id. */
export function buildEnvelope(sessionId: string, operationXml: string): string {
	return (
		`<?xml version="1.0" encoding="UTF-8"?>` +
		`<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="${MET_NS}">` +
		`<soapenv:Header><met:SessionHeader><met:sessionId>${escapeXml(sessionId)}</met:sessionId></met:SessionHeader></soapenv:Header>` +
		`<soapenv:Body>${operationXml}</soapenv:Body></soapenv:Envelope>`
	);
}

export function describeOperation(apiVersion: string): string {
	return `<met:describeMetadata><met:asOfVersion>${escapeXml(apiVersion)}</met:asOfVersion></met:describeMetadata>`;
}

/** One `ListMetadataQuery`. */
export interface ListQuery {
	type: string;
	folder?: string;
}

export function listOperation(queries: ListQuery[], apiVersion: string): string {
	const qs = queries
		.map((q) => `<met:queries>${q.folder !== undefined ? `<met:folder>${escapeXml(q.folder)}</met:folder>` : ""}<met:type>${escapeXml(q.type)}</met:type></met:queries>`)
		.join("");
	return `<met:listMetadata>${qs}<met:asOfVersion>${escapeXml(apiVersion)}</met:asOfVersion></met:listMetadata>`;
}

/** The API allows at most this many queries per `listMetadata` call. */
export const MAX_QUERIES_PER_CALL = 3;

export function batchQueries<T>(items: T[], size: number = MAX_QUERIES_PER_CALL): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

// ── Response parsing ───────────────────────────────────────────────────────────

const baseParser = { ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: true } as const;
const describeParser = new XMLParser({ ...baseParser, isArray: (name: string) => name === "metadataObjects" || name === "childXmlNames" });
const listParser = new XMLParser({ ...baseParser, isArray: (name: string) => name === "result" });

const str = (v: unknown): string => (v === undefined || v === null || typeof v === "object" ? "" : String(v));

/** The SOAP fault text (`CODE: message`) of a response or error body, or null. Works on truncated bodies. */
export function faultMessage(text: string): string | null {
	if (!text || !/faultstring|Fault>/i.test(text)) return null;
	const fs_ = /<(?:\w+:)?faultstring>([\s\S]*?)(?:<\/(?:\w+:)?faultstring>|$)/i.exec(text);
	const fc = /<(?:\w+:)?faultcode>(?:\w+:)?([\s\S]*?)<\/(?:\w+:)?faultcode>/i.exec(text);
	const msg = (fs_?.[1] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
	if (msg) return msg;
	return fc?.[1] ? fc[1].trim() : "SOAP fault";
}

/** Parent types of a `describeMetadata` response (child types are listed in `children`). */
export function parseDescribe(xml: string): TypeInfo[] {
	const fault = faultMessage(xml);
	if (fault) throw new Error(fault);
	const doc = describeParser.parse(xml);
	const result = doc?.Envelope?.Body?.describeMetadataResponse?.result;
	const objs: any[] = Array.isArray(result?.metadataObjects) ? result.metadataObjects : [];
	const out: TypeInfo[] = [];
	for (const o of objs) {
		const name = str(o.xmlName);
		if (!name) continue;
		out.push({
			name,
			dir: str(o.directoryName),
			suffix: str(o.suffix),
			inFolder: str(o.inFolder) === "true",
			metaFile: str(o.metaFile) === "true",
			children: (Array.isArray(o.childXmlNames) ? o.childXmlNames : []).map(str).filter(Boolean),
		});
	}
	return out;
}

/** Parents plus their child types (CustomField, ValidationRule …) as separate, listable types. */
export function expandTypes(parents: TypeInfo[]): TypeInfo[] {
	const seen = new Set(parents.map((p) => p.name));
	const out = [...parents];
	for (const p of parents) {
		for (const child of p.children) {
			if (seen.has(child)) continue;
			seen.add(child);
			out.push({ name: child, dir: "", suffix: "", inFolder: false, metaFile: false, children: [], parent: p.name });
		}
	}
	return out;
}

function toMs(v: unknown): number {
	const s = str(v);
	if (!s) return 0;
	const t = Date.parse(s);
	return Number.isNaN(t) ? 0 : t;
}

/** Components of a `listMetadata` response. `fallbackType` is used when an entry carries no `type`. */
export function parseListResponse(xml: string, fallbackType = ""): Comp[] {
	const fault = faultMessage(xml);
	if (fault) throw new Error(fault);
	const doc = listParser.parse(xml);
	const results: any[] = doc?.Envelope?.Body?.listMetadataResponse?.result ?? [];
	const out: Comp[] = [];
	for (const r of results) {
		if (!r || typeof r !== "object") continue;
		const n = str(r.fullName);
		if (!n) continue;
		out.push({
			t: str(r.type) || fallbackType,
			n,
			ns: str(r.namespacePrefix),
			ms: str(r.manageableState),
			by: str(r.lastModifiedByName),
			bi: str(r.lastModifiedById),
			lm: toMs(r.lastModifiedDate),
			cd: toMs(r.createdDate),
			id: str(r.id),
			f: str(r.fileName),
		});
	}
	return out;
}

// ── Folder types ───────────────────────────────────────────────────────────────

/** Types whose components live in folders → the folder metadata type and its file suffix. */
export const FOLDER_TYPES: Record<string, { folderType: string; suffix: string; unfiled?: string }> = {
	Report: { folderType: "ReportFolder", suffix: "reportFolder", unfiled: "unfiled$public" },
	Dashboard: { folderType: "DashboardFolder", suffix: "dashboardFolder" },
	Document: { folderType: "DocumentFolder", suffix: "documentFolder" },
	EmailTemplate: { folderType: "EmailFolder", suffix: "emailFolder", unfiled: "unfiled$public" },
};

// ── Listing ────────────────────────────────────────────────────────────────────

export interface ListProgress {
	/** Types fully listed (or failed). */
	done: number;
	total: number;
	label: string;
}

export interface ListOptions {
	/** Sends one SOAP operation element and resolves with the raw response XML. Throw `{ fatal: true }` errors to abort. */
	call: (operationXml: string) => Promise<string>;
	/** e.g. "67.0" */
	apiVersion: string;
	/** Already-known types (from the cache): describeMetadata is skipped. */
	knownTypes?: TypeInfo[];
	/** Restrict listing to these types (per-type refresh). Folder types are expanded automatically. */
	only?: string[];
	concurrency?: number;
	isCancelled?: () => boolean;
	onTypes?: (types: TypeInfo[]) => void;
	/** Called with each batch of components as soon as it is parsed. */
	onBatch?: (comps: Comp[], progress: ListProgress) => void;
	onFailure?: (failure: ListFailure) => void;
}

export interface ListResult {
	types: TypeInfo[];
	comps: Comp[];
	failures: ListFailure[];
}

/** Types worth listing first so the grid fills with what people look for. */
const PRIORITY = ["ApexClass", "ApexTrigger", "CustomObject", "LightningComponentBundle", "AuraDefinitionBundle", "Flow", "PermissionSet", "Layout", "Profile"];

function orderTypes(types: TypeInfo[]): TypeInfo[] {
	const rank = (n: string) => {
		const i = PRIORITY.indexOf(n);
		return i < 0 ? PRIORITY.length : i;
	};
	return [...types].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** A cancelled run rejects with this. */
export class ListCancelled extends Error {
	constructor() {
		super("Listing cancelled");
		this.name = "ListCancelled";
	}
}

function isFatal(e: unknown): boolean {
	const err = e as { fatal?: boolean; message?: string } | undefined;
	return !!err?.fatal || /HTTP 401|INVALID_SESSION_ID|Session expired|Could not get org credentials/i.test(String(err?.message ?? ""));
}

function errText(e: unknown): string {
	return String((e as { message?: string } | undefined)?.message ?? e).replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function listOrgMetadata(opts: ListOptions): Promise<ListResult> {
	const cancelled = () => opts.isCancelled?.() === true;
	const concurrency = Math.max(1, opts.concurrency ?? 4);

	let parents: TypeInfo[];
	if (opts.knownTypes && opts.knownTypes.length > 0) {
		parents = opts.knownTypes.filter((t) => !t.parent);
	} else {
		parents = parseDescribe(await opts.call(describeOperation(opts.apiVersion)));
	}
	if (cancelled()) throw new ListCancelled();
	let allTypes = expandTypes(parents);
	// Folder types (ReportFolder …) are not in describeMetadata but are real, retrievable types.
	for (const [typeName, f] of Object.entries(FOLDER_TYPES)) {
		const content = allTypes.find((t) => t.name === typeName);
		if (content && !allTypes.some((t) => t.name === f.folderType)) {
			allTypes.push({ name: f.folderType, dir: content.dir, suffix: f.suffix, inFolder: false, metaFile: true, children: [], parent: typeName });
		}
	}
	allTypes = orderTypes(allTypes);
	opts.onTypes?.(allTypes);

	const folderTypeNames = new Set(Object.values(FOLDER_TYPES).map((f) => f.folderType));
	const only = opts.only ? new Set(opts.only) : null;
	// Units of progress: every listable type except the folder types (they ride along with their content type).
	const targets = allTypes.filter((t) => !folderTypeNames.has(t.name) && (!only || only.has(t.name) || (FOLDER_TYPES[t.name] && only.has(FOLDER_TYPES[t.name].folderType))));
	const total = targets.length;
	let done = 0;

	const comps: Comp[] = [];
	const failures: ListFailure[] = [];
	const fail = (type: string, error: string) => {
		const f = { type, error };
		failures.push(f);
		opts.onFailure?.(f);
	};
	const emit = (batch: Comp[], label: string) => {
		comps.push(...batch);
		opts.onBatch?.(batch, { done, total, label });
	};
	const finishUnit = (label: string) => {
		done++;
		opts.onBatch?.([], { done, total, label });
	};

	/** Run `queries` in ≤3-query calls, `concurrency` calls at a time; failing calls are retried one query at a time. */
	const runQueries = async (queries: ListQuery[], onQueryDone: (q: ListQuery, ok: boolean) => void): Promise<void> => {
		const batches = batchQueries(queries);
		let next = 0;
		const runSingle = async (q: ListQuery) => {
			try {
				const found = parseListResponse(await opts.call(listOperation([q], opts.apiVersion)), q.type);
				emit(found, q.type);
				onQueryDone(q, true);
			} catch (e) {
				if (isFatal(e)) throw e;
				fail(q.folder !== undefined ? `${q.type} (${q.folder})` : q.type, errText(e));
				onQueryDone(q, false);
			}
		};
		const worker = async () => {
			for (;;) {
				if (cancelled()) throw new ListCancelled();
				const i = next++;
				if (i >= batches.length) return;
				const batch = batches[i];
				try {
					const found = parseListResponse(await opts.call(listOperation(batch, opts.apiVersion)), batch.length === 1 ? batch[0].type : "");
					emit(found, batch.map((q) => q.type).join(", "));
					for (const q of batch) onQueryDone(q, true);
				} catch (e) {
					if (isFatal(e)) throw e;
					if (batch.length === 1) {
						fail(batch[0].folder !== undefined ? `${batch[0].type} (${batch[0].folder})` : batch[0].type, errText(e));
						onQueryDone(batch[0], false);
					} else {
						// One bad type must not sink its neighbours: isolate it.
						for (const q of batch) {
							if (cancelled()) throw new ListCancelled();
							await runSingle(q);
						}
					}
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, worker));
	};

	// Phase 1: every plain type, plus the folder lists of the folder-based types.
	const plain = targets.filter((t) => !FOLDER_TYPES[t.name]);
	const foldered = targets.filter((t) => FOLDER_TYPES[t.name]);
	const phase1: ListQuery[] = [...plain.map((t) => ({ type: t.name })), ...foldered.map((t) => ({ type: FOLDER_TYPES[t.name].folderType }))];
	const folderPaths = new Map<string, string[]>(); // folder type → folder fullNames
	const folderFailed = new Set<string>();
	const folderTypeToContent = new Map(foldered.map((t) => [FOLDER_TYPES[t.name].folderType, t.name]));

	await runQueries(phase1, (q, ok) => {
		if (folderTypeToContent.has(q.type)) {
			if (!ok) folderFailed.add(q.type);
		} else {
			finishUnit(q.type);
		}
	});
	// Collect folder names from the components just listed.
	for (const c of comps) {
		if (folderTypeToContent.has(c.t)) {
			const arr = folderPaths.get(c.t) ?? [];
			arr.push(c.n);
			folderPaths.set(c.t, arr);
		}
	}

	// Phase 2: the content of each folder, 3 per call.
	const phase2: ListQuery[] = [];
	const remaining = new Map<string, number>();
	for (const t of foldered) {
		const f = FOLDER_TYPES[t.name];
		if (folderFailed.has(f.folderType)) {
			finishUnit(t.name);
			continue;
		}
		const qs: ListQuery[] = (folderPaths.get(f.folderType) ?? []).map((folder) => ({ type: t.name, folder }));
		if (f.unfiled) qs.push({ type: t.name, folder: f.unfiled });
		if (qs.length === 0) {
			finishUnit(t.name);
			continue;
		}
		remaining.set(t.name, qs.length);
		phase2.push(...qs);
	}
	await runQueries(phase2, (q) => {
		const left = (remaining.get(q.type) ?? 1) - 1;
		remaining.set(q.type, left);
		if (left === 0) finishUnit(q.type);
	});

	return { types: allTypes, comps, failures };
}

// ── Disk cache ─────────────────────────────────────────────────────────────────

export interface ListingCache {
	v: 1;
	orgKey: string;
	apiVersion: string;
	/** Epoch ms of the (last full) listing. */
	listedAt: number;
	types: TypeInfo[];
	comps: Comp[];
	failures: ListFailure[];
	/** Epoch ms of the last per-type refresh, per type. */
	typeListedAt?: Record<string, number>;
}

export function cacheFilePath(dir: string, orgKey: string): string {
	return path.join(dir, `${orgKey.replace(/[^A-Za-z0-9._@-]/g, "_")}.json.gz`);
}

export async function saveListingCache(dir: string, cache: ListingCache): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
	const file = cacheFilePath(dir, cache.orgKey);
	const tmp = `${file}.${process.pid}.tmp`;
	const gz = await new Promise<Buffer>((resolve, reject) => zlib.gzip(Buffer.from(JSON.stringify(cache), "utf8"), (e, b) => (e ? reject(e) : resolve(b))));
	await fs.promises.writeFile(tmp, gz);
	await fs.promises.rename(tmp, file);
}

/** The cached listing for an org, or null when missing / unreadable / from another format version. */
export async function loadListingCache(dir: string, orgKey: string): Promise<ListingCache | null> {
	try {
		const gz = await fs.promises.readFile(cacheFilePath(dir, orgKey));
		const json = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(gz, (e, b) => (e ? reject(e) : resolve(b))));
		const parsed = JSON.parse(json.toString("utf8")) as ListingCache;
		if (parsed?.v !== 1 || !Array.isArray(parsed.comps) || !Array.isArray(parsed.types)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function deleteListingCache(dir: string, orgKey: string): Promise<void> {
	await fs.promises.unlink(cacheFilePath(dir, orgKey)).catch(() => undefined);
}

/** Replace the rows of `types` in a cached listing with freshly listed ones (per-type refresh). */
export function mergeTypeRefresh(cache: ListingCache, refreshed: string[], fresh: ListResult, at: number): ListingCache {
	const replace = new Set(refreshed);
	for (const r of refreshed) {
		const f = FOLDER_TYPES[r];
		if (f) replace.add(f.folderType);
	}
	const keptFailures = cache.failures.filter((f) => !replace.has(f.type.replace(/ \(.*\)$/, "")));
	const typeListedAt = { ...(cache.typeListedAt ?? {}) };
	for (const r of replace) typeListedAt[r] = at;
	return {
		...cache,
		comps: [...cache.comps.filter((c) => !replace.has(c.t)), ...fresh.comps],
		failures: [...keptFailures, ...fresh.failures],
		typeListedAt,
	};
}
