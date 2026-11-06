/**
 * Persistent, trimmed describe cache on disk (one JSON file per org + API version
 * under the extension's globalStorage), so a window reload serves completion from
 * the last session's schema immediately while DescribeStore revalidates it in the
 * background (If-Modified-Since → 304).
 *
 * - Files are keyed by **orgId + API version** (`describe-<orgId>-<ver>.json`); a small
 *   `index.json` maps the canonical org key (username) to its orgId so we can load
 *   before any auth/CLI call.
 * - Loaded lazily (first use of an org), written debounced (never per keystroke:
 *   only fetch results schedule a write), bounded (entries per file, bytes per file,
 *   number of org files), flushed synchronously on dispose — no timer outlives it.
 * - Pure Node (no vscode import) so it is unit-testable.
 */
import * as fs from "fs";
import * as path from "path";

export interface PersistedEntry {
	/** Trimmed describe (never null — misses are not persisted). */
	d: unknown;
	/** When it was fetched / last revalidated (ms). */
	t: number;
	/** Server `Date` of the response that produced it (used for If-Modified-Since). */
	sd?: string;
}

export interface PersistedOrg {
	v: 1;
	orgId: string;
	apiVersion: string;
	savedAt: number;
	entries: Record<string, PersistedEntry>;
	/** describeGlobal object names, when known. */
	objects?: { list: string[]; t: number };
}

export interface DiskCacheLimits {
	/** Most-recent entries kept per org file. */
	maxEntriesPerOrg: number;
	/** Approximate byte cap per org file (oldest entries dropped first). */
	maxBytesPerOrg: number;
	/** Org files kept (least-recently-saved deleted first). */
	maxOrgFiles: number;
	/** Debounce for writes (ms). */
	writeDelayMs: number;
}

export const DEFAULT_DISK_LIMITS: DiskCacheLimits = {
	maxEntriesPerOrg: 400,
	maxBytesPerOrg: 16 * 1024 * 1024,
	maxOrgFiles: 8,
	writeDelayMs: 5000,
};

const INDEX_FILE = "index.json";

function safe(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class DescribeDiskCache {
	private index: Record<string, string> | null = null;
	private pending = new Map<string, () => PersistedOrg | null>();
	private timer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(private readonly dir: string, private readonly limits: DiskCacheLimits = DEFAULT_DISK_LIMITS) {}

	fileFor(orgId: string, apiVersion: string): string {
		return path.join(this.dir, `describe-${safe(orgId)}-${safe(apiVersion)}.json`);
	}

	private readIndex(): Record<string, string> {
		if (this.index) return this.index;
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(this.dir, INDEX_FILE), "utf8"));
			this.index = raw && typeof raw === "object" ? raw : {};
		} catch {
			this.index = {};
		}
		return this.index!;
	}

	/** orgId last seen for an org key (no network). */
	orgIdFor(orgKey: string): string | undefined {
		return this.readIndex()[orgKey];
	}

	/** Load an org's persisted describes (async; null when absent, corrupt or another version). */
	async load(orgKey: string, apiVersion: string): Promise<PersistedOrg | null> {
		const orgId = this.orgIdFor(orgKey);
		if (!orgId) return null;
		try {
			const raw = await fs.promises.readFile(this.fileFor(orgId, apiVersion), "utf8");
			const data = JSON.parse(raw) as PersistedOrg;
			if (data?.v !== 1 || data.orgId !== orgId || data.apiVersion !== apiVersion || typeof data.entries !== "object") return null;
			return data;
		} catch {
			return null;
		}
	}

	/**
	 * Schedule a (debounced) write of an org's snapshot. `snapshot` is called at write
	 * time so the latest state is saved; returning null skips the write.
	 */
	scheduleWrite(orgKey: string, snapshot: () => PersistedOrg | null): void {
		if (this.disposed) return;
		this.pending.set(orgKey, snapshot);
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flushAsync();
		}, this.limits.writeDelayMs);
		this.timer.unref?.();
	}

	/** Bound a snapshot: newest `maxEntriesPerOrg` entries, then under `maxBytesPerOrg`. */
	bound(data: PersistedOrg): PersistedOrg {
		let names = Object.keys(data.entries).sort((a, b) => data.entries[b].t - data.entries[a].t);
		if (names.length > this.limits.maxEntriesPerOrg) names = names.slice(0, this.limits.maxEntriesPerOrg);
		const sizes = names.map((n) => JSON.stringify(data.entries[n]).length + n.length + 4);
		let total = sizes.reduce((a, b) => a + b, 0) + JSON.stringify(data.objects ?? null).length;
		while (names.length && total > this.limits.maxBytesPerOrg) {
			total -= sizes.pop()!;
			names.pop();
		}
		const entries: Record<string, PersistedEntry> = {};
		for (const n of names) entries[n] = data.entries[n];
		return { ...data, entries };
	}

	private takePending(): { orgKey: string; data: PersistedOrg }[] {
		const out: { orgKey: string; data: PersistedOrg }[] = [];
		for (const [orgKey, snap] of this.pending) {
			let data: PersistedOrg | null = null;
			try {
				data = snap();
			} catch {
				data = null;
			}
			if (data && data.orgId) out.push({ orgKey, data: this.bound(data) });
		}
		this.pending.clear();
		return out;
	}

	private async flushAsync(): Promise<void> {
		const items = this.takePending();
		if (!items.length) return;
		try {
			await fs.promises.mkdir(this.dir, { recursive: true });
			for (const { orgKey, data } of items) {
				const file = this.fileFor(data.orgId, data.apiVersion);
				const tmp = `${file}.${process.pid}.tmp`;
				await fs.promises.writeFile(tmp, JSON.stringify(data), "utf8");
				await fs.promises.rename(tmp, file);
				this.readIndex()[orgKey] = data.orgId;
			}
			await fs.promises.writeFile(path.join(this.dir, INDEX_FILE), JSON.stringify(this.readIndex()), "utf8");
			await this.pruneFiles();
		} catch {
			/* disk cache is best-effort */
		}
	}

	/** Write everything pending now (synchronously) — used on dispose. */
	flushSync(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const items = this.takePending();
		if (!items.length) return;
		try {
			fs.mkdirSync(this.dir, { recursive: true });
			for (const { orgKey, data } of items) {
				fs.writeFileSync(this.fileFor(data.orgId, data.apiVersion), JSON.stringify(data), "utf8");
				this.readIndex()[orgKey] = data.orgId;
			}
			fs.writeFileSync(path.join(this.dir, INDEX_FILE), JSON.stringify(this.readIndex()), "utf8");
		} catch {
			/* best-effort */
		}
	}

	/** Keep only the `maxOrgFiles` most recently written describe files. */
	private async pruneFiles(): Promise<void> {
		const names = (await fs.promises.readdir(this.dir)).filter((n) => /^describe-.*\.json$/.test(n));
		if (names.length <= this.limits.maxOrgFiles) return;
		const stats = await Promise.all(
			names.map(async (n) => ({ n, m: (await fs.promises.stat(path.join(this.dir, n)).catch(() => null))?.mtimeMs ?? 0 }))
		);
		stats.sort((a, b) => b.m - a.m);
		for (const { n } of stats.slice(this.limits.maxOrgFiles)) {
			await fs.promises.unlink(path.join(this.dir, n)).catch(() => undefined);
		}
	}

	/** Delete an org's persisted describes (full Refresh). */
	clear(orgKey: string): void {
		this.pending.delete(orgKey);
		const orgId = this.orgIdFor(orgKey);
		if (!orgId) return;
		try {
			for (const n of fs.readdirSync(this.dir)) {
				if (n.startsWith(`describe-${safe(orgId)}-`)) fs.unlinkSync(path.join(this.dir, n));
			}
		} catch {
			/* ignore */
		}
	}

	/** Flush pending writes and stop; later schedules are ignored. */
	dispose(): void {
		this.flushSync();
		this.disposed = true;
	}
}
