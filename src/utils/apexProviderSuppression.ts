/**
 * Pure logic for silencing the Salesforce Apex (Jorje) language client's providers that
 * overlap with ours, so every Apex completion / hover / definition / reference comes from
 * the ASFX language server only.
 *
 * vscode-languageclient reads `client.middleware` (-> `_clientOptions.middleware`) on every
 * provider call, so replacing functions on that object at runtime takes effect immediately.
 * No vscode import: unit-testable with a fake middleware object.
 */

/** Middleware keys we may silence, grouped by the feature of OUR server that replaces them. */
export const COMPLETION_KEYS = ["provideCompletionItem", "resolveCompletionItem"] as const;
export const NAVIGATION_KEYS = ["provideHover", "provideDefinition", "provideReferences", "provideDocumentHighlights", "provideSignatureHelp"] as const;

export type SuppressKey = (typeof COMPLETION_KEYS)[number] | (typeof NAVIGATION_KEYS)[number];

/**
 * Replacement for each key. They never call `next`, so Jorje is not even asked.
 * `resolveCompletionItem` hands the item back untouched.
 */
const REPLACEMENTS: Record<SuppressKey, (...args: any[]) => unknown> = {
	provideCompletionItem: () => null,
	resolveCompletionItem: (item: unknown) => item,
	provideHover: () => null,
	provideDefinition: () => null,
	provideReferences: () => null,
	provideDocumentHighlights: () => null,
	provideSignatureHelp: () => null,
};

/** `apex.languageServer`: "auto" is kept for compatibility and means "on". */
export function apexFeaturesEnabled(mode: string | undefined): boolean {
	return mode === "on" || mode === "auto";
}

export interface SuppressionInputs {
	/** Jorje's extension is installed AND has produced a live client we can patch. */
	jorjeClientAvailable: boolean;
	/** Our language server is running (or starting). */
	ownServerRunning: boolean;
	/** `adure-sfx-toolkit.apex.preferOwnProviders`. */
	preferOwnProviders: boolean;
	/** Init option we gave our server: Apex semantic features (hover, definition, references...). */
	apexFeatures: boolean;
	/** Init option we gave our server: Apex completion. */
	apexCompletion: boolean;
}

/** Which Jorje providers to silence right now. Empty = leave Jorje fully untouched. */
export function keysToSuppress(i: SuppressionInputs): SuppressKey[] {
	if (!i.jorjeClientAvailable || !i.ownServerRunning || !i.preferOwnProviders) return [];
	const keys: SuppressKey[] = [];
	if (i.apexCompletion) keys.push(...COMPLETION_KEYS);
	if (i.apexFeatures) keys.push(...NAVIGATION_KEYS);
	return keys;
}

type Middleware = Record<string, unknown>;

interface Saved {
	had: boolean;
	value: unknown;
	ours: unknown;
}

/**
 * Applies / restores the replacements on one middleware object. Remembers exactly what was
 * there before (including "no such key") and only ever touches the keys it was asked to.
 * Bound to a single middleware object; handing it a different one (Jorje restarted with a
 * new client) forgets the old one — a stale object is garbage, not worth restoring.
 */
export class MiddlewareSuppressor {
	private target: Middleware | undefined;
	private readonly saved = new Map<SuppressKey, Saved>();

	/** True when `target` is the object currently patched. */
	isBoundTo(target: object): boolean {
		return this.target === target;
	}

	/** Currently silenced keys. */
	active(): SuppressKey[] {
		return [...this.saved.keys()];
	}

	/**
	 * Make exactly `keys` silenced on `target` (idempotent). Keys no longer wanted are
	 * restored. Returns true when anything changed.
	 */
	apply(target: object, keys: readonly SuppressKey[]): boolean {
		let changed = false;
		if (this.target !== target) {
			this.saved.clear();
			this.target = target as Middleware;
			changed = true;
		}
		const mw = this.target;
		const want = new Set(keys);
		for (const k of [...this.saved.keys()]) {
			if (!want.has(k)) {
				this.restoreKey(k);
				changed = true;
			}
		}
		for (const k of want) {
			const cur = this.saved.get(k);
			if (cur && mw[k] === cur.ours) continue;
			// If someone replaced our stub, their function becomes the new "original".
			const had = Object.prototype.hasOwnProperty.call(mw, k);
			const ours = REPLACEMENTS[k];
			this.saved.set(k, { had, value: mw[k], ours });
			mw[k] = ours;
			changed = true;
		}
		return changed;
	}

	/** Put every original back. Returns true when anything was restored. */
	restore(): boolean {
		const had = this.saved.size > 0;
		for (const k of [...this.saved.keys()]) this.restoreKey(k);
		return had;
	}

	private restoreKey(k: SuppressKey): void {
		const s = this.saved.get(k);
		this.saved.delete(k);
		const mw = this.target;
		if (!s || !mw) return;
		// Do not clobber a function someone else installed over our stub meanwhile.
		if (mw[k] !== s.ours) return;
		if (s.had) mw[k] = s.value;
		else delete mw[k];
	}
}
