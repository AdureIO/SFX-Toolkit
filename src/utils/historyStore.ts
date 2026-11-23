/**
 * File store of the Deploy & Retrieve Center history (no `vscode`): one JSON file per project under `dir`
 * (`<sha1(projectDir)[0:12]>.json`), newest entry first, capped, written debounced and flushable synchronously
 * (deactivate).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HistoryEntry, NewHistoryEntry, addEntry, normalizeEntry, parseHistory, serializeHistory } from "./historyPure";

export interface HistoryStoreOptions {
	/** Debounce of the write after a change (default 1000 ms; 0 writes on the next tick). */
	delayMs?: number;
	/** Called after an entry was added or the history cleared. */
	onChange?: (projectDir: string) => void;
	newId?: () => string;
}

/** `<sha1(projectDir)[0:12]>`: the file name stem of a project. */
export function historyFileStem(projectDir: string): string {
	return crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 12);
}

export class HistoryStore {
	private readonly lists = new Map<string, HistoryEntry[]>();
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly dir: string,
		private readonly opts: HistoryStoreOptions = {}
	) {}

	fileOf(projectDir: string): string {
		return path.join(this.dir, `${historyFileStem(projectDir)}.json`);
	}

	/** The project's entries, newest first (loaded from disk once). */
	get(projectDir: string): HistoryEntry[] {
		let list = this.lists.get(projectDir);
		if (!list) {
			let text: string | undefined;
			try {
				text = fs.readFileSync(this.fileOf(projectDir), "utf8");
			} catch {
				/* none yet */
			}
			list = parseHistory(text);
			this.lists.set(projectDir, list);
		}
		return list;
	}

	add(projectDir: string, entry: NewHistoryEntry): HistoryEntry {
		const e = normalizeEntry(entry, this.opts.newId ?? (() => crypto.randomUUID()));
		this.lists.set(projectDir, addEntry(this.get(projectDir), e));
		this.markDirty(projectDir);
		this.opts.onChange?.(projectDir);
		return e;
	}

	clear(projectDir: string): void {
		this.lists.set(projectDir, []);
		this.markDirty(projectDir);
		this.opts.onChange?.(projectDir);
	}

	private markDirty(projectDir: string): void {
		this.dirty.add(projectDir);
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, this.opts.delayMs ?? 1000);
		(this.timer as { unref?: () => void }).unref?.();
	}

	/** Write every changed project now (synchronously: safe in `deactivate`). */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const todo = [...this.dirty];
		this.dirty.clear();
		if (todo.length === 0) return;
		try {
			fs.mkdirSync(this.dir, { recursive: true });
		} catch {
			return;
		}
		for (const projectDir of todo) {
			const file = this.fileOf(projectDir);
			const tmp = `${file}.${process.pid}.tmp`;
			try {
				fs.writeFileSync(tmp, serializeHistory(this.lists.get(projectDir) ?? []), "utf8");
				fs.renameSync(tmp, file);
			} catch {
				/* the history is a convenience: never break an operation over it */
			}
		}
	}
}
