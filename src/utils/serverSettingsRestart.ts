/**
 * Decides when a settings change must restart (or stop) the language server, and
 * debounces bursts of changes into one transition.
 *
 * The init options and the heap cap of the server are only read at process start, so a
 * change to any of RESTART_KEYS needs a restart. Pure (no vscode import) so it can be
 * unit-tested with a fake configuration event and fake timers.
 */

export const CONFIG_SECTION = "adure-sfx-toolkit";

/** Settings (relative to the section) read once at server start. */
export const RESTART_KEYS = [
	"apex.languageServer",
	"apex.enableCompletion",
	"apex.validateSemantics",
	"apex.semanticHighlighting",
	"apex.languageServerMaxMemoryMB",
	"apex.languageServerParseWorkers",
	"soql.enableCompletion",
] as const;

export interface ConfigChangeLike {
	affectsConfiguration(section: string): boolean;
}

/** True when the change touches any setting that is baked into the running server. */
export function affectsServerRestart(e: ConfigChangeLike): boolean {
	return RESTART_KEYS.some((k) => e.affectsConfiguration(`${CONFIG_SECTION}.${k}`));
}

export interface ServerSettingsSnapshot {
	mode: string;
	soqlCompletion: boolean;
	apexCompletion: boolean;
}

/**
 * Whether a server process is still useful. `apex.languageServer = off` only disables the
 * Apex *semantic* features; the same process also serves SOQL / Apex completion, so it is
 * stopped on "off" only when those are disabled too.
 */
export function serverWanted(s: ServerSettingsSnapshot): boolean {
	return s.mode !== "off" || s.soqlCompletion || s.apexCompletion;
}

export interface TimerApi {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: TimerApi = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface SettingsRestartDeps {
	debounceMs?: number;
	/** Current settings, read when the debounce fires. */
	snapshot(): ServerSettingsSnapshot;
	/** Serialized stop-then-start (must await the full stop before starting). */
	restart(): Promise<void>;
	/** Serialized stop. */
	stop(): Promise<void>;
	timers?: TimerApi;
}

export class ServerSettingsRestarter {
	private handle: unknown;
	private disposed = false;
	private readonly delay: number;
	private readonly timers: TimerApi;

	constructor(private readonly deps: SettingsRestartDeps) {
		this.delay = deps.debounceMs ?? 500;
		this.timers = deps.timers ?? realTimers;
	}

	/** Feed every configuration-change event; irrelevant ones are ignored. */
	onConfigChange(e: ConfigChangeLike): void {
		if (this.disposed || !affectsServerRestart(e)) return;
		if (this.handle !== undefined) this.timers.clear(this.handle);
		this.handle = this.timers.set(() => {
			this.handle = undefined;
			void this.fire();
		}, this.delay);
	}

	private async fire(): Promise<void> {
		const wanted = serverWanted(this.deps.snapshot());
		try {
			if (wanted) await this.deps.restart();
			else await this.deps.stop();
		} catch {
			/* the transition chain logs its own failures */
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.handle !== undefined) this.timers.clear(this.handle);
		this.handle = undefined;
	}
}

/** Minimum gap between "language server restarted" notices. */
export class Throttle {
	private last = -Infinity;
	constructor(private readonly gapMs: number, private readonly now: () => number = Date.now) {}
	/** True (and records the time) when a notice may be shown now. */
	allow(): boolean {
		const t = this.now();
		if (t - this.last < this.gapMs) return false;
		this.last = t;
		return true;
	}
}
