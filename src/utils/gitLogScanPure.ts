/**
 * Streaming accumulator for `git log --format=%x00%ct --name-only --no-renames` (newest commit first). Pure
 * (no `vscode`, no `git`): the host feeds it lines, it records the first (= newest) commit time of each needed
 * path, reports when every needed path is found (so the host can kill git), and gives the boundary: the time
 * of the oldest commit read.
 *
 * Output shape per commit: `\0<unix seconds>`, a blank line, then one path per line (none for a merge commit).
 */

/** Hard cap on the commits one scan reads. */
export const MAX_SCAN_COMMITS = 1000;

export interface GitLogScanResult {
	/** Path → newest commit time (ms) of the needed paths found (all touched paths when `needed` was null). */
	times: Map<string, number>;
	/** Time (ms) of the oldest commit read; null = no commit was read. */
	boundary: number | null;
	/** Commits read. */
	commits: number;
	/** The scan stopped at the cap (there may be older commits). */
	capped: boolean;
}

/** Normalise a path from the log: forward slashes, no CR / surrounding whitespace. */
export function normalizeLogPath(p: string): string {
	return p.replace(/\r$/, "").trim().replace(/\\/g, "/");
}

export class GitLogScan {
	private readonly remaining: Set<string> | null;
	private readonly times = new Map<string, number>();
	private commits = 0;
	private boundary: number | null = null;
	private currentMs = 0;
	private isCapped = false;
	private isDone = false;

	/** `needed` null = record every path (no early stop, used for a `<old>..HEAD` range). */
	constructor(needed: Iterable<string> | null, private readonly maxCommits: number = MAX_SCAN_COMMITS) {
		this.remaining = needed ? new Set([...needed].map(normalizeLogPath)) : null;
		if (this.remaining && this.remaining.size === 0) this.isDone = true;
	}

	/** Every needed path found, or the cap reached: the host can stop reading (kill git). */
	get done(): boolean {
		return this.isDone;
	}

	/** Feed one output line (without its newline). Returns `done`. */
	feedLine(line: string): boolean {
		if (this.isDone) return true;
		if (line.charCodeAt(0) === 0) {
			const secs = Number(line.slice(1).trim());
			if (!Number.isFinite(secs) || secs <= 0) {
				this.currentMs = 0;
				return false;
			}
			if (this.commits >= this.maxCommits) {
				this.isCapped = true;
				this.isDone = true;
				return true;
			}
			this.commits++;
			this.currentMs = secs * 1000;
			if (this.boundary === null || this.currentMs < this.boundary) this.boundary = this.currentMs;
			return false;
		}
		if (this.currentMs === 0) return false;
		const p = normalizeLogPath(line);
		if (!p) return false;
		if (this.remaining) {
			if (!this.remaining.has(p)) return false;
			this.remaining.delete(p);
			this.times.set(p, this.currentMs);
			if (this.remaining.size === 0) this.isDone = true;
		} else {
			const prev = this.times.get(p);
			if (prev === undefined || this.currentMs > prev) this.times.set(p, this.currentMs);
		}
		return this.isDone;
	}

	/** The result so far (call after the stream ended or `done`). */
	result(): GitLogScanResult {
		return { times: this.times, boundary: this.boundary, commits: this.commits, capped: this.isCapped || this.commits >= this.maxCommits };
	}
}

/** Splits streamed chunks into lines (handles a line split across chunks); `flush` returns the last partial line. */
export class LineSplitter {
	private buf = "";
	push(chunk: string): string[] {
		this.buf += chunk;
		const parts = this.buf.split("\n");
		this.buf = parts.pop() ?? "";
		return parts;
	}
	flush(): string[] {
		const rest = this.buf;
		this.buf = "";
		return rest ? [rest] : [];
	}
}
