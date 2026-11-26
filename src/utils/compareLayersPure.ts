/**
 * Orchestration of the layered content compare: components flow through the cheap layers in order (sync
 * record, Tooling API source, source tracking); each layer decides what it can, the rest flows on, and what no
 * layer decided is left for the retrieve + diff. Pure: the layers are injected. No `vscode`.
 */
import { ContentResult } from "./compareStatusPure";

export type LayerName = "sync" | "tooling" | "tracking";
export type DecisionSource = LayerName | "retrieve";

export const DECISION_SOURCES: readonly DecisionSource[] = ["sync", "tooling", "tracking", "retrieve"];

export interface CompareLayer<T> {
	name: LayerName;
	/** Items per call (progress and results are reported after each); default: all at once. */
	batch?: number;
	/** Decide what can be decided: item key → result. Items missing from the map flow to the next layer. */
	run(items: T[]): Promise<Map<string, ContentResult>>;
}

export interface LayerStat {
	name: LayerName;
	/** Items that reached the layer. */
	input: number;
	decided: number;
	ms: number;
	/** The layer failed (the rest of its input flowed on). */
	error?: string;
}

export interface LayerRunOptions<T> {
	now(): number;
	/** Pause / cancel: stop before the next batch. */
	isStopped(): boolean;
	/** After each batch of a layer: record the decisions. */
	onDecided(layer: LayerName, decided: Map<string, ContentResult>, items: T[]): Promise<void> | void;
}

export interface LayerRunResult<T> {
	/** Items no layer decided, in their original order (also the ones not reached when stopped). */
	undecided: T[];
	stats: LayerStat[];
	stopped: boolean;
}

/** Run `items` through `layers` in order. A layer that throws leaves its remaining input undecided (it flows on). */
export async function runLayers<T extends { key: string }>(items: readonly T[], layers: readonly CompareLayer<T>[], o: LayerRunOptions<T>): Promise<LayerRunResult<T>> {
	let rest = [...items];
	const stats: LayerStat[] = [];
	for (let li = 0; li < layers.length; li++) {
		const layer = layers[li];
		if (rest.length === 0) break;
		if (o.isStopped()) return { undecided: rest, stats, stopped: true };
		const stat: LayerStat = { name: layer.name, input: rest.length, decided: 0, ms: 0 };
		stats.push(stat);
		const t0 = o.now();
		const size = Math.max(1, layer.batch ?? rest.length);
		const left: T[] = [];
		let at = 0;
		let stopped = false;
		for (; at < rest.length; at += size) {
			if (o.isStopped()) {
				stopped = true;
				break;
			}
			const slice = rest.slice(at, at + size);
			let decided: Map<string, ContentResult>;
			try {
				decided = await layer.run(slice);
			} catch (e) {
				stat.error = String((e as Error)?.message ?? e);
				// A layer that failed once is not tried again for this run: everything it has left flows on.
				left.push(...rest.slice(at));
				at = rest.length;
				break;
			}
			if (o.isStopped() && decided.size === 0) {
				stopped = true;
				break;
			}
			const mine = new Map<string, ContentResult>();
			for (const it of slice) {
				const r = decided.get(it.key);
				if (r) mine.set(it.key, r);
				else left.push(it);
			}
			stat.decided += mine.size;
			if (mine.size > 0) await o.onDecided(layer.name, mine, slice);
		}
		stat.ms = o.now() - t0;
		if (stopped) return { undecided: [...left, ...rest.slice(at)], stats, stopped: true };
		rest = left;
	}
	return { undecided: rest, stats, stopped: false };
}

/** The per-layer counts of a run as one log / tooltip line: "512 sync · 180 tooling · 40 retrieve" (zero counts left out). */
export function layerSummary(counts: Partial<Record<DecisionSource, number>>): string {
	return DECISION_SOURCES.filter((s) => (counts[s] ?? 0) > 0)
		.map((s) => `${(counts[s] ?? 0).toLocaleString("en-US")} ${s}`)
		.join(" · ");
}
