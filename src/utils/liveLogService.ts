import * as vscode from "vscode";
import {
	listApexLogs,
	listActiveTraceFlags,
	fetchApexLogHead,
	extractCodeUnit,
	type ApexLogRow,
} from "./apexLogApi";

/**
 * One shared source of Apex-log discovery for BOTH log views (the sidebar tree and
 * the ASFX Workbench Logs tab). Per org, it keeps the current log list + resolved
 * entry-point names and pushes them to every subscriber, so the list is fetched and
 * enriched once, not per view.
 *
 * Discovery is event-driven by default (subscribers call refresh() on visibility /
 * focus / after running Apex). When an active debug TraceFlag exists for the org it
 * goes **live** automatically — polling at a short cadence so new logs appear as they
 * land — and drops back to event-driven the moment the trace expires or is removed.
 */
export interface LogSnapshot {
	rows: ApexLogRow[];
	/** logId → entry-point code unit (resolved lazily from each log's head). */
	units: Record<string, string>;
	/** True while a debug trace is active for this org (the list is live-polling). */
	live: boolean;
}

type Sub = (snap: LogSnapshot) => void;

interface OrgState {
	org: string | null;
	subs: Set<Sub>;
	rows: ApexLogRow[];
	units: Map<string, string>;
	live: boolean;
	timer?: ReturnType<typeof setTimeout>;
	polling: boolean;
	/** Bumped on every stop so an in-flight tick from a stopped loop never re-arms. */
	loopGen: number;
	enrichGen: number;
	/** Set once the last subscriber leaves / disposeAll — all async work bails out. */
	disposed: boolean;
}

function liveIntervalMs(): number {
	const s = vscode.workspace.getConfiguration("adure-sfx-toolkit").get<number>("liveLogIntervalSeconds", 3);
	return Math.max(2, s) * 1000;
}

class LiveLogServiceImpl {
	private map = new Map<string, OrgState>();

	private key(org: string | null): string {
		return org || "__default__";
	}

	/** Subscribe a view to an org's log discovery. Disposing stops the org's loop when last. */
	subscribe(org: string | null, fn: Sub): vscode.Disposable {
		const k = this.key(org);
		let st = this.map.get(k);
		if (!st) {
			st = { org, subs: new Set(), rows: [], units: new Map(), live: false, polling: false, loopGen: 0, enrichGen: 0, disposed: false };
			this.map.set(k, st);
		}
		st.subs.add(fn);
		fn(this.snapshot(st)); // hand over whatever we have right now (may be empty)
		void this.evaluate(st, true); // then refresh + check trace state
		return new vscode.Disposable(() => {
			const s = this.map.get(k);
			if (!s) return;
			s.subs.delete(fn);
			if (s.subs.size === 0) {
				this.disposeState(s);
				if (this.map.get(k) === s) this.map.delete(k);
			}
		});
	}

	/** Stop every poll loop and drop all cached rows/units (deactivate / workspace switch). */
	disposeAll(): void {
		for (const st of this.map.values()) {
			st.subs.clear();
			this.disposeState(st);
		}
		this.map.clear();
	}

	private disposeState(st: OrgState): void {
		st.disposed = true;
		this.stopLoop(st);
		st.enrichGen++;
		st.rows = [];
		st.units.clear();
	}

	/** Force an immediate re-list + trace re-evaluation for an org (event-driven trigger). */
	async refresh(org: string | null): Promise<void> {
		const st = this.map.get(this.key(org));
		if (st) await this.evaluate(st, true);
	}

	/**
	 * Drop everything cached for an org (rows + resolved units), push the empty list to
	 * every subscriber right away, then re-list from the org. Used after "delete all" so
	 * the views clear even when the org call failed or no trace/poll loop is running.
	 */
	async clear(org: string | null): Promise<void> {
		const st = this.map.get(this.key(org));
		if (!st) return;
		st.enrichGen++; // abandon any in-flight enrichment of the old rows
		st.rows = [];
		st.units.clear();
		this.push(st);
		await this.evaluate(st, true);
	}

	private snapshot(st: OrgState): LogSnapshot {
		return { rows: st.rows, units: Object.fromEntries(st.units), live: st.live };
	}

	private push(st: OrgState): void {
		if (st.disposed || st.subs.size === 0) return;
		const snap = this.snapshot(st);
		st.subs.forEach((fn) => {
			try {
				fn(snap);
			} catch {
				/* one view's failure must not starve the others */
			}
		});
	}

	private async traceActive(org: string | null): Promise<boolean> {
		try {
			return (await listActiveTraceFlags(org)).count > 0;
		} catch {
			return false;
		}
	}

	private async evaluate(st: OrgState, fetchNow: boolean): Promise<void> {
		if (st.disposed) return;
		st.live = await this.traceActive(st.org);
		if (st.disposed) return;
		if (st.live) this.ensureLoop(st);
		if (fetchNow) await this.fetch(st);
		else this.push(st);
	}

	/** Start the live poll loop (idempotent). It self-terminates when the trace ends. */
	private ensureLoop(st: OrgState): void {
		if (st.polling || st.disposed) return;
		st.polling = true;
		const gen = ++st.loopGen;
		const alive = () => !st.disposed && st.polling && st.loopGen === gen;
		const tick = async () => {
			st.timer = undefined;
			if (!alive()) return;
			if (st.subs.size === 0) { this.stopLoop(st); return; }
			const live = await this.traceActive(st.org);
			if (!alive()) return;
			st.live = live;
			if (!st.live) { this.stopLoop(st); this.push(st); return; } // trace gone → back to event-driven
			await this.fetch(st);
			if (!alive()) return; // stopped/disposed while fetching — don't re-arm
			st.timer = setTimeout(tick, liveIntervalMs());
		};
		st.timer = setTimeout(tick, liveIntervalMs());
	}

	private stopLoop(st: OrgState): void {
		if (st.timer) { clearTimeout(st.timer); st.timer = undefined; }
		st.polling = false;
		st.loopGen++;
	}

	private async fetch(st: OrgState): Promise<void> {
		let rows: ApexLogRow[];
		try {
			rows = await listApexLogs(st.org);
		} catch {
			return;
		}
		if (st.disposed) return;
		st.rows = rows;
		// Keep only units for logs still listed so the map can't grow without bound.
		if (st.units.size) {
			const ids = new Set(rows.map((r) => r.id));
			for (const id of [...st.units.keys()]) if (!ids.has(id)) st.units.delete(id);
		}
		this.push(st); // push every fetch — covers row changes and live-flag changes
		void this.enrich(st, ++st.enrichGen);
	}

	/** Resolve each log's entry-point code unit from its head, in the background. */
	private async enrich(st: OrgState, gen: number): Promise<void> {
		for (const r of st.rows) {
			if (gen !== st.enrichGen || st.disposed) return;
			if (st.units.has(r.id)) continue;
			try {
				const unit = extractCodeUnit(await fetchApexLogHead(st.org, r.id));
				if (gen !== st.enrichGen || st.disposed) return;
				if (unit) {
					st.units.set(r.id, unit);
					if (gen === st.enrichGen) this.push(st);
				}
			} catch {
				/* keep the operation label */
			}
		}
	}
}

export const LiveLogService = new LiveLogServiceImpl();
