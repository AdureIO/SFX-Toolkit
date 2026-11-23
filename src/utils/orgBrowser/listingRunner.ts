/**
 * One org listing run (whole org, or a per-type refresh) with batching and the cache merge, shared by the
 * Org Browser and the Deploy & Retrieve Center. No `vscode` import: the SOAP transport is injected.
 */
import { classifyHealth } from "../schemaHealth";
import { Comp, ListFailure, TypeInfo } from "./types";
import { ListOptions, ListProgress, ListingCache, expandOnlyTypes, listOrgMetadata, mergeTypeRefresh } from "./metadataLister";

/** What a panel knows of the org's listing between runs. */
export interface ListingSnapshot {
	types: TypeInfo[];
	comps: Comp[];
	failures: ListFailure[];
	/** Epoch ms of the last full listing (0 = none). */
	listedAt: number;
	typeListedAt: Record<string, number>;
}

export interface ListingRunOptions {
	orgKey: string;
	apiVersion: string;
	/** Sends one SOAP operation (see `makeSoapCall`). */
	call: ListOptions["call"];
	/** The panel's current state: a per-type refresh merges into it and reuses its type table. */
	state: ListingSnapshot;
	/** Per-type refresh: only these types (folder twins are added). Omitted: the whole org. */
	only?: string[];
	isCancelled(): boolean;
	/** Described types of a whole-org run, as soon as they are known. */
	onTypes?(types: TypeInfo[]): void;
	/** A batch of listed components (buffered: about every 150 ms or 1500 components). */
	onBatch(comps: Comp[], progress: ListProgress): void;
	now?: () => number;
}

export interface ListingRunResult {
	/** The new state of the listing (also what to write to the cache). */
	cache: ListingCache;
	/** The expanded `only` list of a per-type run (those types' old rows are replaced). */
	expanded?: string[];
}

/** Run a listing. Resolves null when cancelled; throws on a fatal org error. */
export async function runListing(o: ListingRunOptions): Promise<ListingRunResult | null> {
	const now = o.now ?? Date.now;
	const expanded = o.only ? expandOnlyTypes(o.only) : undefined;
	let buf: Comp[] = [];
	let lastProgress: ListProgress = { done: 0, total: 0, label: "" };
	let lastFlush = 0;
	const flush = () => {
		o.onBatch(buf, lastProgress);
		buf = [];
		lastFlush = now();
	};
	let result: Awaited<ReturnType<typeof listOrgMetadata>>;
	try {
		result = await listOrgMetadata({
			call: o.call,
			apiVersion: o.apiVersion,
			knownTypes: o.only && o.state.types.length > 0 ? o.state.types : undefined,
			only: expanded,
			isCancelled: o.isCancelled,
			onTypes: (t) => {
				if (!o.only) o.onTypes?.(t);
			},
			onBatch: (comps, progress) => {
				lastProgress = progress;
				buf.push(...comps);
				if (buf.length >= 1500 || now() - lastFlush >= 150) flush();
			},
		});
	} catch (e) {
		// What was listed before the failure still reaches the panel.
		if (buf.length > 0 && !o.isCancelled()) flush();
		throw e;
	}
	if (o.isCancelled()) return null;
	flush();
	const at = now();
	let cache: ListingCache;
	if (expanded) {
		const base: ListingCache = {
			v: 1,
			orgKey: o.orgKey,
			apiVersion: o.apiVersion,
			listedAt: o.state.listedAt || at,
			types: o.state.types,
			comps: o.state.comps,
			failures: o.state.failures,
			typeListedAt: o.state.typeListedAt,
		};
		cache = mergeTypeRefresh(base, expanded, result, at);
		cache.listedAt = o.state.listedAt || at;
	} else {
		cache = { v: 1, orgKey: o.orgKey, apiVersion: o.apiVersion, listedAt: at, types: result.types, comps: result.comps, failures: result.failures };
	}
	return { cache, expanded };
}

/** A listing failure as the panels show it: the overlay state and its text. */
export function listFailureView(e: unknown, orgKey: string, orgLabel: string): { state: string; message: string; log: string } {
	const log = String((e as { message?: string } | undefined)?.message ?? e).replace(/\s+/g, " ").trim();
	const health = classifyHealth(e, orgKey);
	let state: string = health.state;
	let message: string;
	if (health.state === "authInvalid") {
		message = health.scratchExpired
			? `The scratch org ${orgLabel} has expired or was deleted. Choose another org.`
			: `The connection to ${orgLabel} is expired or invalid. Re-authenticate to continue.`;
	} else if (health.state === "noDefaultOrg") {
		message = "No default org is set. Choose an org to browse its metadata.";
	} else {
		state = "unreachable";
		message = `Couldn’t reach ${orgLabel}: ${log.slice(0, 240)}`;
	}
	return { state, message, log };
}
