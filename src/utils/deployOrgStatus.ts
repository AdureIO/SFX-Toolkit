/**
 * What the Deploy Metadata panel knows about its target org: `listMetadata` results for the metadata
 * types of the local project (cached per org on disk, refreshed per type), plus the freshness of each.
 * No `vscode` import: the SOAP transport and the listing function are injected, so it is unit-testable.
 */
import { Comp, ListFailure, TypeInfo } from "./orgBrowser/types";
import {
	ListOptions,
	ListResult,
	ListingCache,
	expandOnlyTypes,
	listOrgMetadata,
	loadListingCache,
	saveListingCache,
} from "./orgBrowser/metadataLister";
import { OrgCompInfo, orgLookupKey } from "./deployStatusPure";

export interface DeployOrgStatusDeps {
	/** This panel's own listing cache (it only ever holds the types of local projects). */
	cacheDir: string;
	/** The Org Browser's cache: read-only seed for an org this panel has not listed yet. */
	seedDir?: string;
	apiVersion: string;
	/** SOAP transport for an org (null = default). */
	makeCall(org: string | null): (operationXml: string) => Promise<string>;
	/** Defaults to `listOrgMetadata`. */
	list?: (opts: ListOptions) => Promise<ListResult>;
	now?: () => number;
}

export interface RefreshOptions {
	isCancelled?: () => boolean;
	/** Folder types: list only these folders (pre-deploy check of a few components). */
	onlyFolders?: Record<string, string[]>;
}

/** Outcome of one refresh, for the requested types. */
export interface RefreshOutcome {
	/** Types listed successfully by THIS call. */
	listed: string[];
	/** Types that could not be listed: type → reason. */
	failed: Map<string, string>;
	/** SOAP queries sent are not counted here; this is how many types the call asked for (folder / child types included). */
	requested: string[];
}

/** What the webview needs for the rows of the local project. */
export interface OrgStatusSnapshot {
	/** Local types with a listing → epoch ms of that listing. */
	listed: Record<string, number>;
	/** Local types whose last listing failed → reason. */
	failed: Record<string, string>;
	/** Local component key → [lastModifiedDate, lastModifiedByName, namespacePrefix], for those that exist in the org. */
	comps: Record<string, [number, string, string]>;
	/** Oldest listing among the local types that have one (0 = none). */
	asOf: number;
}

const baseType = (t: string) => t.replace(/ \(.*\)$/, "");

export class DeployOrgStatus {
	private orgKey = "";
	private org: string | null = null;
	private types: TypeInfo[] = [];
	private comps = new Map<string, Comp>();
	private listedAt = new Map<string, number>();
	private failed = new Map<string, string>();

	constructor(private readonly deps: DeployOrgStatusDeps) {}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	/** Forget everything (org or project changed). */
	reset(): void {
		this.types = [];
		this.comps = new Map();
		this.listedAt = new Map();
		this.failed = new Map();
	}

	/** Point at an org and load what is cached for it. Returns true when a cache was found. */
	async load(orgKey: string, org: string | null): Promise<boolean> {
		this.reset();
		this.orgKey = orgKey;
		this.org = org;
		const own = await loadListingCache(this.deps.cacheDir, orgKey);
		const cache = own ?? (this.deps.seedDir ? await loadListingCache(this.deps.seedDir, orgKey) : null);
		// A reset / another load while reading: the newer one wins.
		if (!cache || this.orgKey !== orgKey) return false;
		this.types = cache.types;
		for (const c of cache.comps) this.comps.set(`${c.t}:${c.n}`, c);
		for (const f of cache.failures) this.failed.set(baseType(f.type), f.error);
		if (own) {
			for (const [t, at] of Object.entries(own.typeListedAt ?? {})) this.listedAt.set(t, at);
		} else {
			// The Org Browser's cache is a full listing: every type of it was listed, per-type refreshes later than that.
			for (const t of cache.types) this.listedAt.set(t.name, cache.typeListedAt?.[t.name] ?? cache.listedAt);
			for (const f of cache.failures) this.listedAt.delete(baseType(f.type));
		}
		return true;
	}

	/** The org's described types (empty until a listing or a cache provided them). */
	knownTypes(): TypeInfo[] {
		return this.types;
	}

	/** The last listing of this type failed. */
	hasFailed(type: string): boolean {
		return this.failed.has(type);
	}

	/** Has a (cached or fresh) listing of this type. */
	isListed(type: string): boolean {
		return this.listedAt.has(type);
	}

	/** The org's record of a local component, if it exists there. */
	get(type: string, name: string): OrgCompInfo | undefined {
		const c = this.comps.get(orgLookupKey(type, name));
		return c ? { lm: c.lm, by: c.by } : undefined;
	}

	/**
	 * List `types` in the org (all of them live, one `listMetadata` per type; folder types per folder)
	 * and merge the result in. A type that fails keeps its previous data and is recorded as failed.
	 * Throws on a fatal error (expired session, unreachable org) and when cancelled.
	 */
	async refresh(types: string[], o: RefreshOptions = {}): Promise<RefreshOutcome> {
		const orgKey = this.orgKey;
		const requested = [...new Set(types)];
		const want = expandOnlyTypes(requested);
		const list = this.deps.list ?? listOrgMetadata;
		const result = await list({
			call: this.deps.makeCall(this.org),
			apiVersion: this.deps.apiVersion,
			knownTypes: this.types.length > 0 ? this.types : undefined,
			only: want,
			onlyFolders: o.onlyFolders,
			isCancelled: o.isCancelled,
		});
		// The org changed while listing: this result is for another org.
		if (this.orgKey !== orgKey) throw new Error("Org changed while listing");

		const failedBase = new Map<string, string>();
		for (const f of result.failures) failedBase.set(baseType(f.type), f.error);
		const known = new Set(result.types.map((t) => t.name));
		if (this.types.length === 0 && result.types.length > 0) this.types = result.types;

		const at = this.now();
		const listed: string[] = [];
		const failed = new Map<string, string>();
		for (const t of requested) {
			const group = expandOnlyTypes([t]);
			const err = group.map((g) => failedBase.get(g)).find((e) => e !== undefined) ?? (known.has(t) ? undefined : "Not a listable metadata type in this org");
			if (err !== undefined) {
				failed.set(t, err);
				this.failed.set(t, err);
				continue;
			}
			const folders = o.onlyFolders?.[t];
			if (Array.isArray(folders)) {
				// Only some folders were listed: merge those in; the type as a whole is no fresher than before.
				const queried = new Set(folders);
				const folderOf = (n: string) => n.slice(0, Math.max(0, n.lastIndexOf("/")));
				for (const [k, c] of this.comps) if (c.t === t && queried.has(folderOf(c.n))) this.comps.delete(k);
				for (const c of result.comps) if (c.t === t) this.comps.set(`${c.t}:${c.n}`, c);
				listed.push(t);
				continue;
			}
			// Replace this type's rows (and its folder / content twin's) with the fresh ones.
			const set = new Set(group);
			for (const [k, c] of this.comps) if (set.has(c.t)) this.comps.delete(k);
			for (const c of result.comps) if (set.has(c.t)) this.comps.set(`${c.t}:${c.n}`, c);
			for (const g of group) {
				this.listedAt.set(g, at);
				this.failed.delete(g);
			}
			listed.push(t);
		}
		await this.persist().catch(() => undefined);
		return { listed, failed, requested: want };
	}

	/** The state for the webview, for the given local components. */
	snapshot(local: Iterable<{ key: string; type: string; name: string }>): OrgStatusSnapshot {
		const listed: Record<string, number> = {};
		const failed: Record<string, string> = {};
		const comps: Record<string, [number, string, string]> = {};
		let asOf = 0;
		for (const l of local) {
			const at = this.listedAt.get(l.type);
			if (at !== undefined && listed[l.type] === undefined) {
				listed[l.type] = at;
				asOf = asOf === 0 ? at : Math.min(asOf, at);
			}
			const err = this.failed.get(l.type);
			if (err !== undefined) failed[l.type] = err;
			const c = this.comps.get(orgLookupKey(l.type, l.name));
			if (c) comps[l.key] = [c.lm, c.by, c.ns];
		}
		return { listed, failed, comps, asOf };
	}

	private async persist(): Promise<void> {
		if (!this.orgKey) return;
		const failures: ListFailure[] = [...this.failed.entries()].map(([type, error]) => ({ type, error }));
		const cache: ListingCache = {
			v: 1,
			orgKey: this.orgKey,
			apiVersion: this.deps.apiVersion,
			listedAt: this.now(),
			types: this.types,
			comps: [...this.comps.values()],
			failures,
			typeListedAt: Object.fromEntries(this.listedAt),
		};
		await saveListingCache(this.deps.cacheDir, cache);
	}
}
