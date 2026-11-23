/**
 * Webview side of the filter state shared between the Org Browser and the Deploy Metadata panel (per
 * project; see src/utils/sharedFilterPure.ts). Search text and type selection only: the panel's status
 * filters, and `status:` tokens in the query, stay its own.
 */
import { FilterState } from "../../utils/orgBrowser/filter";
import { SharedFilter, applyShared, sameSharedFilter, sharedPart } from "../../utils/sharedFilterPure";

export interface SharedFilterSync {
	/** The host sent the project's shared filter with `init` (null: none stored yet — this panel's own becomes the shared one). */
	init(shared: SharedFilter | null | undefined): void;
	/** The panel's filter may have changed: tell the host if the shared part did. */
	changed(): void;
	/** The other panel changed the shared filter. */
	receive(shared: SharedFilter): void;
}

export function createSharedFilterSync(cfg: {
	filter(): FilterState;
	/** The filter was replaced from outside: re-render (search box, rows). Must not call `changed`. */
	applied(): void;
	/** Send `{ query, types }` to the host. */
	send(shared: SharedFilter): void;
}): SharedFilterSync {
	let last: SharedFilter | null = null;
	let timer: number | undefined;

	const send = () => {
		const now = sharedPart(cfg.filter());
		if (sameSharedFilter(now, last)) return;
		last = now;
		cfg.send(now);
	};

	return {
		init(shared) {
			if (shared) {
				const f = cfg.filter();
				const next = applyShared(f.query, shared);
				f.query = next.query;
				f.types = next.types;
				last = shared;
			} else {
				last = null; // the panel's own state is published by the next `changed`
				window.clearTimeout(timer);
				timer = window.setTimeout(send, 0);
			}
		},
		changed() {
			window.clearTimeout(timer);
			timer = window.setTimeout(send, 150);
		},
		receive(shared) {
			const f = cfg.filter();
			const next = applyShared(f.query, shared);
			f.query = next.query;
			f.types = next.types;
			last = shared; // what the other panel sent: not ours to send back
			cfg.applied();
		},
	};
}
