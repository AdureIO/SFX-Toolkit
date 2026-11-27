/**
 * Deploy & Retrieve Metadata: the grid's column layout (which columns, in which order, how wide). Stored per
 * computer by the host (`globalState`, key `syncCenter.columns`) and handed to the webview with `init`; the
 * webview posts changes back. Everything read from storage or from the webview is sanitised here. Pure (no
 * `vscode`, no DOM): runs in the host, the webview and the tests.
 *
 * The checkbox column is always first and not part of the layout. `name` is always shown and always the first
 * column of the layout. It flexes: its width is the minimum, it takes the remaining room (so it is only ever
 * as wide as it has to be when the grid is tight, and it grows when there is space). It can be resized like the others.
 */

export type ColumnId = "name" | "type" | "status" | "ns" | "by" | "mod" | "modLocal" | "created" | "id" | "file" | "path" | "state" | "actions";

export interface ColumnDef {
	id: ColumnId;
	label: string;
	/** Default width in px (the name column flexes). */
	width: number;
	min: number;
	/** Shown by default. */
	visible: boolean;
	/** Always shown and first; no hide, no move. */
	fixed?: boolean;
}

/** Every column, in default order. */
export const COLUMN_DEFS: readonly ColumnDef[] = [
	{ id: "name", label: "Name", width: 140, min: 140, visible: true, fixed: true },
	{ id: "type", label: "Type", width: 120, min: 60, visible: true },
	{ id: "ns", label: "Namespace", width: 70, min: 60, visible: true },
	{ id: "by", label: "Last modified by", width: 120, min: 60, visible: true },
	{ id: "mod", label: "Last modified", width: 90, min: 60, visible: true },
	{ id: "modLocal", label: "Last modified (local)", width: 110, min: 60, visible: false },
	{ id: "status", label: "Status", width: 130, min: 60, visible: true },
	{ id: "created", label: "Created date", width: 100, min: 60, visible: false },
	{ id: "id", label: "Id", width: 150, min: 60, visible: false },
	{ id: "file", label: "File name", width: 200, min: 60, visible: false },
	{ id: "path", label: "Local path", width: 260, min: 60, visible: false },
	{ id: "state", label: "Manageable state", width: 120, min: 60, visible: false },
	{ id: "actions", label: "Actions", width: 250, min: 120, visible: true },
];

export const MAX_COLUMN_WIDTH = 600;
/** The checkbox column. */
export const CHECKBOX_WIDTH = 34;

const DEF_BY_ID = new Map<string, ColumnDef>(COLUMN_DEFS.map((d) => [d.id, d]));

export interface ColumnPref {
	id: ColumnId;
	visible: boolean;
	width: number;
}

export interface ColumnLayout {
	cols: ColumnPref[];
}

export const COLUMNS_STORE_KEY = "syncCenter.columns";

export function defaultLayout(): ColumnLayout {
	return { cols: COLUMN_DEFS.map((d) => ({ id: d.id, visible: d.visible, width: d.width })) };
}

export function clampWidth(id: ColumnId, w: number): number {
	const d = DEF_BY_ID.get(id)!;
	return Math.max(d.min, Math.min(MAX_COLUMN_WIDTH, Math.round(w)));
}

/**
 * Make any value a valid layout: unknown or duplicate columns are dropped, missing columns are appended (default
 * visibility and width, in default order), widths are clamped, `name` is first and visible. Anything that is not
 * an object gives the default.
 */
export function normalizeLayout(raw: unknown): ColumnLayout {
	const list: unknown = raw && typeof raw === "object" ? (raw as { cols?: unknown }).cols : undefined;
	if (!Array.isArray(list)) return defaultLayout();
	const seen = new Set<string>();
	const cols: ColumnPref[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const r = item as { id?: unknown; visible?: unknown; width?: unknown };
		const def = typeof r.id === "string" ? DEF_BY_ID.get(r.id) : undefined;
		if (!def || seen.has(def.id)) continue;
		seen.add(def.id);
		const w = typeof r.width === "number" && Number.isFinite(r.width) ? r.width : def.width;
		cols.push({ id: def.id, visible: def.fixed ? true : typeof r.visible === "boolean" ? r.visible : def.visible, width: clampWidth(def.id, w) });
	}
	for (const d of COLUMN_DEFS) if (!seen.has(d.id)) cols.push({ id: d.id, visible: d.visible, width: d.width });
	// `name` first.
	const at = cols.findIndex((c) => c.id === "name");
	if (at > 0) cols.unshift(...cols.splice(at, 1));
	return { cols };
}

export function visibleColumns(l: ColumnLayout): ColumnPref[] {
	return l.cols.filter((c) => c.visible);
}

export function setColumnVisible(l: ColumnLayout, id: ColumnId, visible: boolean): ColumnLayout {
	if (DEF_BY_ID.get(id)?.fixed) return l;
	return { cols: l.cols.map((c) => (c.id === id ? { ...c, visible } : c)) };
}

export function setColumnWidth(l: ColumnLayout, id: ColumnId, width: number): ColumnLayout {
	return { cols: l.cols.map((c) => (c.id === id ? { ...c, width: clampWidth(id, width) } : c)) };
}

/**
 * Move column `id` next to `targetId` (before it, or after it with `after`). A fixed column neither moves nor is
 * moved around: nothing can land before `name`.
 */
export function moveColumn(l: ColumnLayout, id: ColumnId, targetId: ColumnId, after: boolean): ColumnLayout {
	if (id === targetId || DEF_BY_ID.get(id)?.fixed) return l;
	const cols = l.cols.filter((c) => c.id !== id);
	const moved = l.cols.find((c) => c.id === id);
	let to = cols.findIndex((c) => c.id === targetId);
	if (!moved || to < 0) return l;
	if (DEF_BY_ID.get(targetId)?.fixed) to = 0;
	cols.splice(after || DEF_BY_ID.get(targetId)?.fixed ? to + 1 : to, 0, moved);
	return normalizeLayout({ cols });
}

/**
 * CSS `grid-template-columns` of the visible columns (checkbox first) and the grid's minimum width. `indent` widens
 * the checkbox column (the group-by-type view indents its rows). The grid is never narrower than `minWidth`: the
 * scroller scrolls horizontally instead of cutting columns off.
 */
export function gridTemplate(l: ColumnLayout, indent = 0): { cols: string; minWidth: number } {
	const first = CHECKBOX_WIDTH + Math.max(0, indent);
	const parts = [`${first}px`];
	let min = first;
	for (const c of visibleColumns(l)) {
		const d = DEF_BY_ID.get(c.id)!;
		if (d.fixed) {
			parts.push(`minmax(${c.width}px,1fr)`);
			min += c.width;
		} else {
			parts.push(`${c.width}px`);
			min += c.width;
		}
	}
	return { cols: parts.join(" "), minWidth: min };
}

export function columnLabel(id: ColumnId): string {
	return DEF_BY_ID.get(id)?.label ?? id;
}

export function isFixedColumn(id: ColumnId): boolean {
	return !!DEF_BY_ID.get(id)?.fixed;
}

// ── Pane widths (filter sidebar, right panel) ──────────────────────────────────

/** Stored per computer next to the column layout. */
export const PANES_STORE_KEY = "syncCenter.panes";
export const SIDE_MIN = 160;
export const SIDE_MAX = 480;
export const SIDE_DEFAULT = 248;
export const RIGHT_MIN = 240;
export const RIGHT_MAX = 600;
export const RIGHT_DEFAULT = 360;
/** The grid never gets narrower than this because of a pane. */
export const GRID_MIN = 360;
/** The two splitters (4px each). */
export const SPLITTER_W = 4;

export interface PaneWidths {
	side: number;
	right: number;
}

const clampTo = (v: unknown, min: number, max: number, def: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : def);

export function defaultPanes(): PaneWidths {
	return { side: SIDE_DEFAULT, right: RIGHT_DEFAULT };
}

/** Anything read from storage or the webview becomes valid pane widths (static limits only). */
export function normalizePanes(raw: unknown): PaneWidths {
	const r = raw && typeof raw === "object" ? (raw as { side?: unknown; right?: unknown }) : {};
	return { side: clampTo(r.side, SIDE_MIN, SIDE_MAX, SIDE_DEFAULT), right: clampTo(r.right, RIGHT_MIN, RIGHT_MAX, RIGHT_DEFAULT) };
}

/**
 * The widths that fit `total` (the width of the body): each within its limits, the grid keeping `GRID_MIN`. The
 * right panel gives way first, then the sidebar (only when it is shown). A window too small for the minimums keeps
 * the minimums (the grid then scrolls).
 */
export function fitPanes(p: PaneWidths, total: number, sideShown: boolean): PaneWidths {
	let { side, right } = normalizePanes(p);
	const fixed = SPLITTER_W + (sideShown ? SPLITTER_W : 0);
	const avail = total - GRID_MIN - fixed;
	if (side * (sideShown ? 1 : 0) + right > avail) right = Math.max(RIGHT_MIN, avail - (sideShown ? side : 0));
	if (sideShown && side + right > avail) side = Math.max(SIDE_MIN, avail - right);
	return { side, right };
}
