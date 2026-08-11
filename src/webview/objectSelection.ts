/**
 * Shared object-picker state for the webview bundles (Object Visualizer + Process Visualizer).
 *
 * Holds the "which objects has the user picked" logic — list, selection, search/kind filtering,
 * and cancel/restore — so both pickers behave identically. Rendering stays with each webview,
 * since their markup and CSS differ. Pure: no DOM, no `vscode`.
 */

export interface PickerItem {
    name: string;
    custom: boolean;
}

export type PickerKind = "all" | "standard" | "custom";

export interface VisibleItems {
    /** The items to render (already capped). */
    shown: PickerItem[];
    /** How many matched the filter before the cap. */
    total: number;
    /** How many matches were cut by the cap (0 when everything fits). */
    hidden: number;
}

export class ObjectSelection {
    private items: PickerItem[] = [];
    private readonly selected = new Set<string>();
    private snapshot: string[] = [];

    /** Replace the available objects. Accepts plain names (custom inferred from the `__c` suffix). */
    setItems(items: (PickerItem | string)[]): void {
        this.items = items
            .map((o) => (typeof o === "string" ? { name: o, custom: /__c$/i.test(o) } : o))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    get size(): number {
        return this.selected.size;
    }

    /** Every available object name (the full list, regardless of selection or filter). */
    names(): string[] {
        return this.items.map((o) => o.name);
    }

    has(name: string): boolean {
        return this.selected.has(name);
    }

    /** Currently picked object names, in stable (sorted) order. */
    values(): string[] {
        return [...this.selected].sort((a, b) => a.localeCompare(b));
    }

    set(name: string, on: boolean): void {
        if (on) this.selected.add(name);
        else this.selected.delete(name);
    }

    clear(): void {
        this.selected.clear();
    }

    replaceAll(names: string[]): void {
        this.selected.clear();
        for (const n of names) this.selected.add(n);
    }

    /** Remember the selection so a cancelled picker can restore it. */
    beginEdit(): void {
        this.snapshot = this.values();
    }

    /** Undo edits made since {@link beginEdit}. */
    cancelEdit(): void {
        this.replaceAll(this.snapshot);
    }

    /** Items matching the search term and kind filter, capped for rendering. */
    visible(query: string, opts?: { kind?: PickerKind; cap?: number }): VisibleItems {
        const term = query.trim().toLowerCase();
        const kind = opts?.kind ?? "all";
        const cap = opts?.cap ?? 500;
        const matches = this.items.filter((o) => {
            if (kind === "standard" && o.custom) return false;
            if (kind === "custom" && !o.custom) return false;
            return !term || o.name.toLowerCase().includes(term);
        });
        const shown = matches.slice(0, cap);
        return { shown, total: matches.length, hidden: matches.length - shown.length };
    }
}
