/**
 * Forwards the unsaved text of open LWC / Aura / Visualforce / Flow files to the language
 * server (`sfx/metadataBuffer`), so Find References and LWC → Apex navigation see edits
 * that are not on disk yet. These languages are not in the client's documentSelector
 * (that would run every server feature on them), hence this side channel.
 *
 * Pure (no vscode import): per-URI debounce, "null = use disk again" bookkeeping and the
 * path filter, testable with fake timers.
 */
import type { TimerApi } from "./serverSettingsRestart";

export const METADATA_BUFFER_DEBOUNCE_MS = 300;

const GENERATED_PATH = /[\\/](?:\.sfdx|\.sf|node_modules)[\\/]/;
const PATTERNS: RegExp[] = [
	/[\\/]lwc[\\/].+\.(?:js|html)$/i, // **/lwc/**/*.{js,html}
	/[\\/]aura[\\/].+\.(?:js|cmp|app|evt)$/i, // **/aura/**/*.{js,cmp,app,evt}
	/\.(?:page|component)$/i, // **/*.{page,component}
	/\.flow(?:-meta\.xml)?$/i, // **/*.flow-meta.xml (SFDX) and **/*.flow (MDAPI)
];

/** True for a file path whose unsaved text the server's metadata scanners may use. */
export function isMetadataBufferPath(fsPath: string): boolean {
	return !GENERATED_PATH.test(fsPath) && PATTERNS.some((p) => p.test(fsPath));
}

const realTimers: TimerApi = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class MetadataBufferSync {
	private pending = new Map<string, { handle: unknown; text: () => string }>();
	/** URIs the server currently holds an overlay for. */
	private sent = new Set<string>();
	private readonly timers: TimerApi;

	constructor(
		private readonly send: (uri: string, text: string | null) => void,
		private readonly debounceMs: number = METADATA_BUFFER_DEBOUNCE_MS,
		timers?: TimerApi,
	) {
		this.timers = timers ?? realTimers;
	}

	/** The document is dirty: send its text after the debounce (latest edit wins). */
	changed(uri: string, text: () => string): void {
		const prev = this.pending.get(uri);
		if (prev) this.timers.clear(prev.handle);
		const handle = this.timers.set(() => {
			this.pending.delete(uri);
			this.sent.add(uri);
			this.send(uri, text());
		}, this.debounceMs);
		this.pending.set(uri, { handle, text });
	}

	/** Saved / closed / reverted: the server uses disk again (sent right away). */
	released(uri: string): void {
		const prev = this.pending.get(uri);
		if (prev) {
			this.timers.clear(prev.handle);
			this.pending.delete(uri);
		}
		if (this.sent.delete(uri)) this.send(uri, null);
	}

	/** The server restarted and lost its overlay: send the given dirty documents again. */
	resendAll(dirty: { uri: string; text: () => string }[]): void {
		for (const p of this.pending.values()) this.timers.clear(p.handle);
		this.pending.clear();
		this.sent.clear();
		for (const d of dirty) {
			this.sent.add(d.uri);
			this.send(d.uri, d.text());
		}
	}

	dispose(): void {
		for (const p of this.pending.values()) this.timers.clear(p.handle);
		this.pending.clear();
		this.sent.clear();
	}
}
