/**
 * Host side of the filter state the Org Browser and Deploy & Retrieve Metadata share per project
 * (search text and type selection; see sharedFilterPure.ts). Stored in the workspaceState under
 * `asfx.metadataFilter.<projectDir>`; a change made by one panel is broadcast so the other one, if open
 * for the same project, updates live.
 */
import * as vscode from "vscode";
import { SharedFilter, sameSharedFilter, sanitizeSharedFilter, sharedFilterKey } from "./sharedFilterPure";
import { samePath } from "./projectDiscoveryPure";

export type SharedFilterSource = "orgBrowser" | "deploy" | "syncCenter";

export interface SharedFilterChange {
	dir: string;
	filter: SharedFilter;
	/** The panel that made the change (it must not be told about its own change). */
	source: SharedFilterSource;
}

export class SharedMetadataFilter {
	private static memento: vscode.Memento | undefined;
	private static readonly emitter = new vscode.EventEmitter<SharedFilterChange>();
	static readonly onDidChange: vscode.Event<SharedFilterChange> = SharedMetadataFilter.emitter.event;

	/** Call once on activation. */
	static init(context: vscode.ExtensionContext): void {
		this.memento = context.workspaceState;
	}

	/** The shared filter of a project, or null when none was stored yet. */
	static get(projectDir: string | undefined): SharedFilter | null {
		if (!projectDir || !this.memento) return null;
		return sanitizeSharedFilter(this.memento.get(sharedFilterKey(projectDir)));
	}

	/** Store `raw` for the project and tell the other panels. A no-op when nothing changed. */
	static set(projectDir: string | undefined, raw: unknown, source: SharedFilterSource): void {
		const filter = sanitizeSharedFilter(raw);
		if (!projectDir || !filter || !this.memento) return;
		if (sameSharedFilter(this.get(projectDir), filter)) return;
		void this.memento.update(sharedFilterKey(projectDir), filter);
		this.emitter.fire({ dir: projectDir, filter, source });
	}

	/** Subscribe a panel: `handler` runs for changes of `dir()`'s project made by the other panel. */
	static subscribe(self: SharedFilterSource, dir: () => string | undefined, handler: (filter: SharedFilter) => void): vscode.Disposable {
		return this.onDidChange((e) => {
			if (e.source !== self && samePath(e.dir, dir())) handler(e.filter);
		});
	}
}
