/**
 * Single source of truth for SObject describe REST calls.
 *
 * One fetch per org+sobject, shared by every consumer (SOQL editor, data tools,
 * language server, stub sync, LWC), with TTL, in-flight dedup and:
 *
 * - **Canonical org keys** (`canonicalOrgKey`): alias, username and `null`-default
 *   all hit one entry, so warm-ups and invalidations reach what the LS reads.
 * - **Trimmed storage**: only the attributes consumers actually read are kept
 *   (`trimDescribe`) — a raw describe of a wide object is hundreds of KB.
 * - **Failure rules**: only a real 404 is negative-cached. Network errors,
 *   timeouts, 5xx and auth failures are NOT cached; the org backs off briefly and
 *   the problem is surfaced once via schemaHealth.
 * - **Revalidation**: an expired entry is served stale while it is revalidated in
 *   the background with If-Modified-Since (304 → keep, refresh TTL).
 * - **Persistence** (optional, `configurePersistence`): trimmed describes survive a
 *   reload on disk per orgId + API version, loaded lazily and revalidated.
 * - **Batching** (`getMany`): misses go out as REST composite/batch requests of
 *   ≤25 describes each.
 */
import { AuthInfo } from "./authInfo";
import { getToolingApiVersion } from "./constants";
import { outputChannel } from "./outputChannel";
import { canonicalOrgKey } from "./orgKey";
import { classifySchemaError, backoffMs, reportSchemaFailure, reportSchemaSuccess, SchemaFailureKind } from "./schemaHealth";
import { DescribeDiskCache, DiskCacheLimits, PersistedOrg } from "./describeDiskCache";

/** Freshness window for a successful describe; after it the entry is revalidated (served stale meanwhile). */
export const DESCRIBE_TTL_MS = 10 * 60 * 1000;
/** Window to cache a real "not an SObject" (404), so typing a partial name doesn't re-hit the org. */
export const NEGATIVE_TTL_MS = 60 * 1000;
/** Max raw describes kept per org (least-recently-used evicted first). */
export const MAX_DESCRIBES_PER_ORG = 300;
/** Max orgs with cached describes (least-recently-used org evicted first). */
export const MAX_ORGS = 5;
/** Non-default orgs untouched for this long are dropped on the next access. */
export const ORG_IDLE_MS = 30 * 60 * 1000;
/** Total HTTP time for one describe (incl. retries); the idle timeout alone allowed ~93 s. */
export const DESCRIBE_HTTP_BUDGET_MS = 10_000;
/** Total HTTP time for one composite/batch request (up to 25 describes). */
export const BATCH_HTTP_BUDGET_MS = 25_000;
/** Max subrequests per composite/batch call (Salesforce limit). */
export const BATCH_SIZE = 25;
/** Concurrent composite/batch calls per getMany. */
const BATCH_CONCURRENCY = 2;
/** Concurrent background revalidations. */
const REVALIDATE_CONCURRENCY = 4;

// ─── Trimmed shape ────────────────────────────────────────────────────────────

export interface TrimmedField {
	name: string;
	type: string;
	label?: string;
	inlineHelpText?: string;
	length?: number;
	sortable?: boolean;
	aggregatable?: boolean;
	groupable?: boolean;
	nillable?: boolean;
	relationshipName?: string;
	referenceTo?: string[];
	/** Active picklist values only. */
	picklistValues?: { value: string }[];
	updateable?: boolean;
	createable?: boolean;
	calculated?: true;
	externalId?: true;
	unique?: true;
	nameField?: true;
}

export interface TrimmedChildRelationship {
	childSObject: string;
	field?: string;
	relationshipName?: string | null;
	cascadeDelete?: true;
	deprecatedAndHidden?: true;
}

/** The describe as stored: exactly the attributes any consumer reads (see trimDescribe). */
export interface TrimmedDescribe {
	name: string;
	label?: string;
	labelPlural?: string;
	keyPrefix?: string;
	custom?: boolean;
	queryable?: boolean;
	createable?: boolean;
	updateable?: boolean;
	deletable?: boolean;
	fields: TrimmedField[];
	childRelationships: TrimmedChildRelationship[];
}

/**
 * Reduce a raw describe to what the consumers use: SoqlSchemaProvider.parse (LS
 * describe), OrgMetadataCache, SchemaCache (data tools / migration), soqlEdit
 * (fieldMetaFor / objectMetaFor / nameFieldOf) and the stub sync. Keep this in
 * sync when a consumer starts reading a new attribute.
 */
export function trimDescribe(raw: any): TrimmedDescribe {
	const fields: TrimmedField[] = [];
	for (const f of Array.isArray(raw?.fields) ? raw.fields : []) {
		if (!f || typeof f.name !== "string") continue;
		const o: TrimmedField = { name: f.name, type: typeof f.type === "string" && f.type ? f.type : "string" };
		if (f.label) o.label = f.label;
		if (f.inlineHelpText) o.inlineHelpText = f.inlineHelpText;
		if (typeof f.length === "number" && f.length > 0) o.length = f.length;
		if (typeof f.sortable === "boolean") o.sortable = f.sortable;
		if (typeof f.aggregatable === "boolean") o.aggregatable = f.aggregatable;
		if (typeof f.groupable === "boolean") o.groupable = f.groupable;
		if (typeof f.nillable === "boolean") o.nillable = f.nillable;
		if (typeof f.updateable === "boolean") o.updateable = f.updateable;
		if (typeof f.createable === "boolean") o.createable = f.createable;
		if (f.relationshipName) o.relationshipName = f.relationshipName;
		if (Array.isArray(f.referenceTo) && f.referenceTo.length) o.referenceTo = f.referenceTo.filter((r: unknown) => typeof r === "string");
		if (Array.isArray(f.picklistValues) && f.picklistValues.length) {
			const vals = f.picklistValues
				.filter((p: any) => p && p.active !== false && p.value)
				.map((p: any) => ({ value: String(p.value) }));
			if (vals.length) o.picklistValues = vals;
		}
		if (f.calculated === true) o.calculated = true;
		if (f.externalId === true) o.externalId = true;
		if (f.unique === true) o.unique = true;
		if (f.nameField === true) o.nameField = true;
		fields.push(o);
	}
	const childRelationships: TrimmedChildRelationship[] = [];
	for (const cr of Array.isArray(raw?.childRelationships) ? raw.childRelationships : []) {
		if (!cr || typeof cr.childSObject !== "string") continue;
		const o: TrimmedChildRelationship = { childSObject: cr.childSObject };
		if (cr.field) o.field = cr.field;
		o.relationshipName = cr.relationshipName ?? null;
		if (cr.cascadeDelete === true) o.cascadeDelete = true;
		if (cr.deprecatedAndHidden === true) o.deprecatedAndHidden = true;
		childRelationships.push(o);
	}
	const out: TrimmedDescribe = { name: raw?.name, fields, childRelationships };
	if (raw?.label) out.label = raw.label;
	if (raw?.labelPlural) out.labelPlural = raw.labelPlural;
	if (raw?.keyPrefix) out.keyPrefix = raw.keyPrefix;
	for (const k of ["custom", "queryable", "createable", "updateable", "deletable"] as const) {
		if (typeof raw?.[k] === "boolean") out[k] = raw[k];
	}
	return out;
}

// ─── Errors / transport ───────────────────────────────────────────────────────

/** Thrown by strict lookups when the org can't answer right now (never for a 404). */
export class SchemaUnavailableError extends Error {
	constructor(public readonly kind: SchemaFailureKind, message: string) {
		super(message);
		this.name = "SchemaUnavailableError";
	}
}

export interface TransportDescribeResult {
	status: number;
	body?: string;
	/** Server `Date` header (for the next If-Modified-Since). */
	date?: string;
	orgId?: string;
}

export interface TransportBatchResult {
	/** One per requested name, same order. */
	results: { statusCode: number; result?: unknown }[];
	date?: string;
	orgId?: string;
}

/** Network seam (replaced in unit tests). Errors are thrown like AuthInfo/httpUtils do. */
export interface DescribeTransport {
	describe(orgKey: string, sobject: string, ifModifiedSince?: string): Promise<TransportDescribeResult>;
	batch(orgKey: string, sobjects: string[]): Promise<TransportBatchResult>;
}

function headerString(v: string | string[] | undefined): string | undefined {
	return Array.isArray(v) ? v[0] : v;
}

const restTransport: DescribeTransport = {
	async describe(orgKey, sobject, ifModifiedSince) {
		const version = getToolingApiVersion();
		const r = await AuthInfo.getEx(
			orgKey,
			(a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/sobjects/${encodeURIComponent(sobject)}/describe`,
			{ headers: ifModifiedSince ? { "If-Modified-Since": ifModifiedSince } : undefined, totalTimeoutMs: DESCRIBE_HTTP_BUDGET_MS }
		);
		return { status: r.status, body: r.body, date: headerString(r.headers.date), orgId: r.auth.orgId };
	},
	async batch(orgKey, sobjects) {
		const version = getToolingApiVersion();
		const r = await AuthInfo.postEx(
			orgKey,
			(a) => `${a.instanceUrl.replace(/\/$/, "")}/services/data/${version}/composite/batch`,
			{ batchRequests: sobjects.map((n) => ({ method: "GET", url: `${version}/sobjects/${encodeURIComponent(n)}/describe` })) },
			{ totalTimeoutMs: BATCH_HTTP_BUDGET_MS }
		);
		const data = JSON.parse(r.body);
		const results = Array.isArray(data?.results) ? data.results : [];
		return { results, date: headerString(r.headers.date), orgId: r.auth.orgId };
	},
};

// ─── Store ────────────────────────────────────────────────────────────────────

interface Entry {
	/** Trimmed describe; null = confirmed "not an SObject" (404). */
	d: TrimmedDescribe | null;
	/** Fetched / last revalidated (ms). */
	t: number;
	/** Server Date of the producing response. */
	sd?: string;
	/** Loaded from disk: serve, but revalidate once. */
	stale?: boolean;
}

interface OrgState {
	key: string;
	entries: Map<string, Entry>;
	lastUsed: number;
	failures: number;
	backoffUntil: number;
	backoffKind?: SchemaFailureKind;
	orgId?: string;
	diskLoad?: Promise<void>;
	/** Names invalidated before the disk load finished (must not be resurrected). */
	tombstones: Set<string>;
	/** The whole org was invalidated before the disk load finished. */
	dropAllOnLoad: boolean;
	/** Disk load finished (or there is no disk cache). */
	loaded: boolean;
	objects?: { list: string[]; t: number };
}

/** Tiny promise pool. */
class Limiter {
	private active = 0;
	private queue: (() => void)[] = [];
	constructor(private readonly max: number) {}
	run<T>(fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const start = () => {
				this.active++;
				fn().then(resolve, reject).finally(() => {
					this.active--;
					this.queue.shift()?.();
				});
			};
			if (this.active < this.max) start();
			else this.queue.push(start);
		});
	}
	clear(): void {
		this.queue = [];
	}
}

type Outcome = TrimmedDescribe | null | SchemaUnavailableError;

class DescribeStoreImpl {
	private orgs = new Map<string, OrgState>();
	private locks = new Map<string, Promise<TrimmedDescribe | null>>();
	private transport: DescribeTransport = restTransport;
	private disk: DescribeDiskCache | undefined;
	private revalidations = new Limiter(REVALIDATE_CONCURRENCY);

	// ── configuration ──

	/** Enable the on-disk cache under `dir` (undefined disables it). Flushes the previous one. */
	configurePersistence(dir: string | undefined, limits?: DiskCacheLimits): void {
		this.disk?.dispose();
		this.disk = dir ? new DescribeDiskCache(dir, limits) : undefined;
		for (const st of this.orgs.values()) {
			st.diskLoad = undefined;
			st.loaded = false;
		}
	}

	/** Test hook: replace the network layer (undefined restores REST). */
	setTransportForTests(t: DescribeTransport | undefined): void {
		this.transport = t ?? restTransport;
	}

	// ── org state ──

	private state(org: string | null | undefined): OrgState {
		const key = canonicalOrgKey(org);
		const now = Date.now();
		this.pruneOrgs(now, key);
		let st = this.orgs.get(key);
		if (st) {
			this.orgs.delete(key); // re-insert → most-recently-used
		} else {
			st = { key, entries: new Map(), lastUsed: now, failures: 0, backoffUntil: 0, tombstones: new Set(), dropAllOnLoad: false, loaded: false };
		}
		st.lastUsed = now;
		this.orgs.set(key, st);
		return st;
	}

	private pruneOrgs(now: number, current: string): void {
		const def = canonicalOrgKey(null);
		for (const [k, st] of this.orgs) {
			if (k !== current && k !== def && now - st.lastUsed > ORG_IDLE_MS) this.dropOrg(k);
		}
		while (this.orgs.size >= MAX_ORGS && !this.orgs.has(current)) {
			const oldest = this.orgs.keys().next().value;
			if (oldest === undefined) break;
			this.dropOrg(oldest);
		}
	}

	private dropOrg(key: string): void {
		this.orgs.delete(key);
		for (const lk of [...this.locks.keys()]) if (lk.startsWith(`${key}|`)) this.locks.delete(lk);
	}

	private ensureLoaded(st: OrgState): Promise<void> {
		const disk = this.disk;
		if (!disk) {
			st.loaded = true;
			st.tombstones.clear();
			return Promise.resolve();
		}
		if (!st.diskLoad) {
			st.diskLoad = disk.load(st.key, getToolingApiVersion()).then((data) => {
				if (!data || st.dropAllOnLoad || this.disk !== disk) return;
				st.orgId = st.orgId ?? data.orgId;
				if (st.orgId !== data.orgId) return;
				const names = Object.keys(data.entries).sort((a, b) => data.entries[a].t - data.entries[b].t);
				for (const name of names) {
					if (st.tombstones.has(name) || st.entries.has(name)) continue;
					const e = data.entries[name];
					if (!e?.d) continue;
					st.entries.set(name, { d: e.d as TrimmedDescribe, t: e.t, sd: e.sd, stale: true });
				}
				this.trim(st);
				if (!st.objects && data.objects && !st.tombstones.has("*objects*")) st.objects = data.objects;
			}).catch(() => undefined).finally(() => {
				st.tombstones.clear();
				st.dropAllOnLoad = false;
				st.loaded = true;
			});
		}
		return st.diskLoad;
	}

	private trim(st: OrgState): void {
		while (st.entries.size > MAX_DESCRIBES_PER_ORG) {
			const oldest = st.entries.keys().next().value;
			if (oldest === undefined) break;
			st.entries.delete(oldest);
		}
	}

	private put(st: OrgState, name: string, entry: Entry): void {
		st.entries.delete(name);
		st.entries.set(name, entry);
		this.trim(st);
	}

	private snapshot(st: OrgState): PersistedOrg | null {
		if (!st.orgId) return null;
		const entries: PersistedOrg["entries"] = {};
		for (const [name, e] of st.entries) if (e.d) entries[name] = { d: e.d, t: e.t, sd: e.sd };
		return { v: 1, orgId: st.orgId, apiVersion: getToolingApiVersion(), savedAt: Date.now(), entries, objects: st.objects };
	}

	private persist(st: OrgState): void {
		if (!this.disk || !st.orgId || this.orgs.get(st.key) !== st) return;
		this.disk.scheduleWrite(st.key, () => (this.orgs.get(st.key) === st ? this.snapshot(st) : null));
	}

	/** A response proved which org this key is; a changed orgId (sandbox refresh, recreated scratch) drops the old data. */
	private learnOrgId(st: OrgState, orgId: string | undefined): void {
		if (!orgId) return;
		if (st.orgId && st.orgId !== orgId) {
			st.entries.clear();
			st.objects = undefined;
		}
		st.orgId = orgId;
	}

	private onFailure(st: OrgState, kind: SchemaFailureKind, sobject: string, e: unknown): SchemaUnavailableError {
		st.failures++;
		st.backoffKind = kind;
		st.backoffUntil = Date.now() + backoffMs(kind, st.failures);
		reportSchemaFailure(st.key, kind);
		const msg = String((e as any)?.message ?? e);
		outputChannel.appendLine(`DescribeStore: describe ${sobject} failed (${kind}; backing off): ${msg}`);
		return new SchemaUnavailableError(kind, msg);
	}

	private onSuccess(st: OrgState): void {
		if (st.failures || st.backoffUntil) {
			st.failures = 0;
			st.backoffUntil = 0;
			st.backoffKind = undefined;
		}
		reportSchemaSuccess(st.key);
	}

	private inBackoff(st: OrgState): SchemaUnavailableError | null {
		if (Date.now() < st.backoffUntil) {
			return new SchemaUnavailableError(st.backoffKind ?? "transient", `Schema temporarily unavailable for ${st.key} (backing off).`);
		}
		return null;
	}

	// ── fetching ──

	private lockKey(st: OrgState, name: string): string {
		return `${st.key}|${name}`;
	}

	/** Single fetch (with If-Modified-Since when revalidating `prev`). Resolves the trimmed describe / null (404). */
	private fetchOne(st: OrgState, name: string, prev?: Entry): Promise<TrimmedDescribe | null> {
		const lk = this.lockKey(st, name);
		const existing = this.locks.get(lk);
		if (existing) return existing;
		const owns = () => this.locks.get(lk) === promise && this.orgs.get(st.key) === st;
		const ims = prev?.d ? prev.sd ?? new Date(prev.t).toUTCString() : undefined;
		const promise: Promise<TrimmedDescribe | null> = this.transport
			.describe(st.key, name, ims)
			.then(
				(r) => {
					this.onSuccess(st);
					if (!owns()) return r.status === 304 ? prev?.d ?? null : r.body ? trimDescribe(JSON.parse(r.body)) : null;
					this.learnOrgId(st, r.orgId);
					if (r.status === 304 && prev?.d) {
						this.put(st, name, { d: prev.d, t: Date.now(), sd: r.date ?? prev.sd });
						this.persist(st);
						return prev.d;
					}
					const d = trimDescribe(JSON.parse(r.body ?? "{}"));
					this.put(st, name, { d, t: Date.now(), sd: r.date });
					this.persist(st);
					return d;
				},
				(e) => {
					const kind = classifySchemaError(e);
					if (kind === "notFound") {
						this.onSuccess(st);
						if (owns()) {
							this.put(st, name, { d: null, t: Date.now() });
							if (prev?.d) this.persist(st); // object was deleted → drop it from disk too
						}
						return null;
					}
					throw this.onFailure(st, kind, name, e);
				}
			)
			.finally(() => {
				if (this.locks.get(lk) === promise) this.locks.delete(lk);
			});
		this.locks.set(lk, promise);
		return promise;
	}

	private revalidateInBackground(st: OrgState, name: string, prev: Entry): void {
		if (this.locks.has(this.lockKey(st, name)) || this.inBackoff(st)) return;
		void this.revalidations
			.run(() => (this.orgs.get(st.key) === st ? this.fetchOne(st, name, prev) : Promise.resolve(null)))
			.catch(() => undefined);
	}

	/**
	 * Cached lookup without network. `undefined` = not cached (must fetch). Serves an
	 * expired/disk entry and kicks off its revalidation.
	 */
	private lookup(st: OrgState, name: string, ttlMs: number): TrimmedDescribe | null | undefined {
		const hit = st.entries.get(name);
		if (!hit) return undefined;
		const age = Date.now() - hit.t;
		if (hit.d === null) {
			if (age < NEGATIVE_TTL_MS) return null;
			st.entries.delete(name);
			return undefined;
		}
		st.entries.delete(name); // LRU touch
		st.entries.set(name, hit);
		if (hit.stale || age >= ttlMs) this.revalidateInBackground(st, name, hit);
		return hit.d;
	}

	private async resolveOne(org: string | null | undefined, sobject: string, ttlMs: number): Promise<TrimmedDescribe | null> {
		if (!sobject) return null;
		const st = this.state(org);
		await this.ensureLoaded(st);
		const cached = this.lookup(st, sobject, ttlMs);
		if (cached !== undefined) return cached;
		const inflight = this.locks.get(this.lockKey(st, sobject));
		if (inflight) return inflight;
		const backoff = this.inBackoff(st);
		if (backoff) throw backoff;
		return this.fetchOne(st, sobject);
	}

	/**
	 * Trimmed describe for org+sobject (cached / joined / fetched once). Resolves null
	 * when it isn't an SObject OR the org can't answer right now. Never throws.
	 */
	async get(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): Promise<TrimmedDescribe | null> {
		try {
			return await this.resolveOne(org, sobject, ttlMs);
		} catch {
			return null;
		}
	}

	/** Back-compat name for {@link get} (the payload is the trimmed describe). */
	getRaw(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): Promise<TrimmedDescribe | null> {
		return this.get(org, sobject, ttlMs);
	}

	/**
	 * Like {@link get}, but rejects with SchemaUnavailableError when the org can't
	 * answer (network / timeout / 5xx / auth) instead of resolving null — so the
	 * language server can tell "not an object" from "try again later".
	 */
	getStrict(org: string | null, sobject: string): Promise<TrimmedDescribe | null> {
		return this.resolveOne(org, sobject, DESCRIBE_TTL_MS);
	}

	/**
	 * Describes for many objects, in order. Cached ones are served from the store;
	 * the misses go out as REST composite/batch requests (≤ BATCH_SIZE each). With
	 * `strict`, rejects with SchemaUnavailableError if any could not be answered.
	 */
	async getMany(org: string | null, names: string[], opts: { strict?: boolean } = {}): Promise<(TrimmedDescribe | null)[]> {
		const st = this.state(org);
		await this.ensureLoaded(st);
		const outcome = new Map<string, Outcome | Promise<Outcome>>();
		const misses: string[] = [];
		const settle = (p: Promise<TrimmedDescribe | null>): Promise<Outcome> =>
			p.then(
				(d) => d,
				(e) => (e instanceof SchemaUnavailableError ? e : new SchemaUnavailableError("transient", String(e?.message ?? e)))
			);
		const seen = new Set<string>();
		for (const name of names) {
			if (!name || seen.has(name)) continue;
			seen.add(name);
			const cached = this.lookup(st, name, DESCRIBE_TTL_MS);
			if (cached !== undefined) {
				outcome.set(name, cached);
				continue;
			}
			const inflight = this.locks.get(this.lockKey(st, name));
			if (inflight) {
				outcome.set(name, settle(inflight));
				continue;
			}
			misses.push(name);
		}
		if (misses.length) {
			const backoff = this.inBackoff(st);
			if (backoff) {
				for (const n of misses) outcome.set(n, backoff);
			} else {
				const pool = new Limiter(BATCH_CONCURRENCY);
				for (let i = 0; i < misses.length; i += BATCH_SIZE) {
					const chunk = misses.slice(i, i + BATCH_SIZE);
					// Start on a microtask: the per-name locks below must be registered before
					// fetchBatch snapshots them (it writes back only while they are still current).
					const chunkP: Promise<Map<string, Outcome>> = Promise.resolve().then(() =>
						chunk.length === 1
							? pool.run(() => settle(this.fetchOne(st, chunk[0])).then((o) => new Map([[chunk[0], o]])))
							: pool.run(() => this.fetchBatch(st, chunk))
					);
					for (const n of chunk) {
						const p = chunkP.then((m) => m.get(n) ?? null);
						outcome.set(n, p);
						// Join point for concurrent single lookups of the same name.
						if (chunk.length > 1) {
							const lk = this.lockKey(st, n);
							const lock: Promise<TrimmedDescribe | null> = p
								.then((o) => {
									if (o instanceof SchemaUnavailableError) throw o;
									return o;
								})
								.finally(() => {
									if (this.locks.get(lk) === lock) this.locks.delete(lk);
								});
							lock.catch(() => undefined);
							this.locks.set(lk, lock);
						}
					}
				}
			}
		}
		const resolved = new Map<string, Outcome>();
		for (const [n, o] of outcome) resolved.set(n, await o);
		if (opts.strict) {
			for (const o of resolved.values()) if (o instanceof SchemaUnavailableError) throw o;
		}
		return names.map((n) => {
			const o = resolved.get(n);
			return o instanceof SchemaUnavailableError || o === undefined ? null : o;
		});
	}

	private async fetchBatch(st: OrgState, chunk: string[]): Promise<Map<string, Outcome>> {
		const out = new Map<string, Outcome>();
		const locksAtStart = new Map(chunk.map((n) => [n, this.locks.get(this.lockKey(st, n))]));
		let r: TransportBatchResult;
		try {
			r = await this.transport.batch(st.key, chunk);
		} catch (e) {
			const kind = classifySchemaError(e);
			const err = this.onFailure(st, kind === "notFound" ? "transient" : kind, chunk.join(","), e);
			for (const n of chunk) out.set(n, err);
			return out;
		}
		this.onSuccess(st);
		const alive = this.orgs.get(st.key) === st;
		if (alive) this.learnOrgId(st, r.orgId);
		let changed = false;
		chunk.forEach((name, i) => {
			const sub = r.results[i];
			// Write back only if nothing invalidated this name meanwhile (its lock is gone then).
			const owns = alive && this.locks.get(this.lockKey(st, name)) === locksAtStart.get(name);
			if (sub && sub.statusCode >= 200 && sub.statusCode < 300 && sub.result) {
				const d = trimDescribe(sub.result);
				out.set(name, d);
				if (owns) {
					this.put(st, name, { d, t: Date.now(), sd: r.date });
					changed = true;
				}
			} else if (sub && sub.statusCode === 404) {
				out.set(name, null);
				if (owns) this.put(st, name, { d: null, t: Date.now() });
			} else {
				out.set(name, new SchemaUnavailableError("transient", `describe ${name}: subrequest status ${sub?.statusCode ?? "missing"}`));
			}
		});
		if (changed) this.persist(st);
		return out;
	}

	/** Whether a fresh, successful describe is already cached (no network). */
	hasFresh(org: string | null, sobject: string, ttlMs: number = DESCRIBE_TTL_MS): boolean {
		const hit = this.orgs.get(canonicalOrgKey(org))?.entries.get(sobject);
		return !!hit && hit.d !== null && !hit.stale && Date.now() - hit.t < ttlMs;
	}

	// ── persisted object list (describeGlobal), for OrgMetadataCache ──

	/** Object names persisted for this org from a previous session (null if none). */
	async getPersistedObjectList(org: string | null): Promise<{ list: string[]; t: number } | null> {
		const st = this.state(org);
		await this.ensureLoaded(st);
		return st.objects ?? null;
	}

	/** Remember the org's object list (persisted with the describes). */
	persistObjectList(org: string | null, list: string[], orgId?: string): void {
		const st = this.state(org);
		this.learnOrgId(st, orgId);
		st.objects = { list, t: Date.now() };
		this.persist(st);
	}

	/** Forget the persisted object list (structural change) so it isn't served stale. */
	dropObjectList(org: string | null): void {
		const st = this.state(org);
		st.objects = undefined;
		if (!st.loaded) st.tombstones.add("*objects*");
		this.persist(st);
	}

	// ── invalidation ──

	/** Drop an org's describes — memory AND disk (schema may have changed). */
	invalidate(org: string | null): void {
		const key = canonicalOrgKey(org);
		const st = this.orgs.get(key);
		if (st) st.dropAllOnLoad = true;
		this.dropOrg(key);
		this.disk?.clear(key);
	}

	/** Drop one object's describe — memory AND disk — so the next use refetches. */
	invalidateSObject(org: string | null, sobject: string): void {
		const st = this.orgs.get(canonicalOrgKey(org));
		if (!st) {
			// Not loaded yet in this session: make sure the disk copy can't resurrect it.
			if (this.disk) this.state(org).tombstones.add(sobject);
			return;
		}
		if (!st.loaded) st.tombstones.add(sobject);
		const had = st.entries.delete(sobject);
		this.locks.delete(this.lockKey(st, sobject));
		if (had) this.persist(st);
	}

	/** Drop every org's in-memory describes (disk copies stay; they are revalidated on use). */
	invalidateAll(): void {
		this.orgs.clear();
		this.locks.clear();
		this.revalidations.clear();
	}

	/** Full Refresh: forget memory and disk for an org (alias of invalidate, explicit name). */
	clearPersisted(org: string | null): void {
		this.invalidate(org);
	}

	/** Release everything (deactivate / workspace switch): flush pending disk writes, no timers left. */
	disposeAll(): void {
		this.disk?.flushSync();
		this.invalidateAll();
	}

	/** Stop persistence for good (deactivate). */
	shutdown(): void {
		this.disk?.dispose();
		this.disk = undefined;
		this.invalidateAll();
	}
}

export const DescribeStore = new DescribeStoreImpl();
