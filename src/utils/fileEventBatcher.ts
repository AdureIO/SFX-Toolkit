/**
 * Coalesces file-watcher events per URI before they are forwarded to the language
 * server. A big git checkout fires tens of thousands of events; truncating the
 * queue (the old `pending.slice(-5000)`) silently dropped some, leaving the server's
 * type index wrong. Deduping by URI keeps one event per file (bounded by the number
 * of distinct files) and never loses a file.
 *
 * Pure (no vscode import) — change types use the LSP numbering
 * (1 = Created, 2 = Changed, 3 = Deleted).
 */

export const FILE_CREATED = 1;
export const FILE_CHANGED = 2;
export const FILE_DELETED = 3;

/** Net effect of two consecutive events on one file. */
export function mergeFileChange(prev: number | undefined, next: number): number {
	if (prev === undefined) return next;
	// Created then changed is still "new" to the server.
	if (prev === FILE_CREATED && next === FILE_CHANGED) return FILE_CREATED;
	// Deleted then re-created (branch switch) — report it as changed content.
	if (prev === FILE_DELETED && next === FILE_CREATED) return FILE_CHANGED;
	return next;
}

export class FileEventBatcher {
	private pending = new Map<string, number>();

	add(uri: string, type: number): void {
		const merged = mergeFileChange(this.pending.get(uri), type);
		// Re-insert so iteration order follows the latest event.
		this.pending.delete(uri);
		this.pending.set(uri, merged);
	}

	get size(): number {
		return this.pending.size;
	}

	/** Take all coalesced events (one per URI) and reset. */
	drain(): { uri: string; type: number }[] {
		const out = [...this.pending].map(([uri, type]) => ({ uri, type }));
		this.pending.clear();
		return out;
	}

	clear(): void {
		this.pending.clear();
	}
}
