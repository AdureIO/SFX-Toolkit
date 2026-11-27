import * as assert from "assert";
import {
	COLUMN_DEFS,
	ColumnId,
	MAX_COLUMN_WIDTH,
	defaultLayout,
	defaultPanes,
	fitPanes,
	normalizePanes,
	GRID_MIN,
	SPLITTER_W,
	gridTemplate,
	moveColumn,
	normalizeLayout,
	setColumnVisible,
	setColumnWidth,
	visibleColumns,
} from "../utils/syncCenterColumnsPure";

const ids = (l: { cols: { id: ColumnId }[] }) => l.cols.map((c) => c.id);
const visible = (l: Parameters<typeof visibleColumns>[0]) => visibleColumns(l).map((c) => c.id);

describe("sync center column layout", () => {
	it("defaults to the current columns", () => {
		assert.deepStrictEqual(visible(defaultLayout()), ["name", "type", "ns", "by", "mod", "status", "actions"]);
		assert.strictEqual(defaultLayout().cols.length, COLUMN_DEFS.length);
	});

	it("sanitises anything stored: unknown / duplicate columns dropped, missing ones appended, widths clamped", () => {
		const l = normalizeLayout({
			cols: [
				{ id: "status", visible: true, width: 5 },
				{ id: "bogus", visible: true, width: 100 },
				{ id: "status", visible: false, width: 300 },
				{ id: "type", visible: "yes", width: "wide" },
				{ id: "file", visible: true, width: 99999 },
				null,
				42,
				{ visible: true },
			],
		});
		assert.deepStrictEqual(new Set(ids(l)).size, COLUMN_DEFS.length);
		assert.deepStrictEqual(ids(l).slice(0, 4), ["name", "status", "type", "file"]);
		const by = (id: ColumnId) => l.cols.find((c) => c.id === id)!;
		assert.strictEqual(by("status").width, 60);
		assert.strictEqual(by("status").visible, true);
		const def = COLUMN_DEFS.find((d) => d.id === "type")!;
		assert.strictEqual(by("type").width, def.width);
		assert.strictEqual(by("type").visible, def.visible);
		assert.strictEqual(by("file").width, MAX_COLUMN_WIDTH);
		// a column the stored layout lacks comes back with its default
		assert.strictEqual(by("actions").visible, true);
		assert.strictEqual(by("path").visible, false);
	});

	it("name is always first and visible", () => {
		const l = normalizeLayout({ cols: [{ id: "type", visible: true, width: 100 }, { id: "name", visible: false, width: 100 }] });
		assert.strictEqual(l.cols[0].id, "name");
		assert.strictEqual(l.cols[0].visible, true);
		assert.strictEqual(setColumnVisible(defaultLayout(), "name", false).cols[0].visible, true);
	});

	it("garbage gives the default", () => {
		for (const raw of [undefined, null, 7, "x", [], {}, { cols: "no" }]) assert.deepStrictEqual(normalizeLayout(raw), defaultLayout());
	});

	it("hides, shows and resizes", () => {
		let l = setColumnVisible(defaultLayout(), "ns", false);
		assert.ok(!visible(l).includes("ns"));
		l = setColumnVisible(l, "created", true);
		assert.ok(visible(l).includes("created"));
		assert.strictEqual(setColumnWidth(l, "type", 1).cols.find((c) => c.id === "type")!.width, 60);
		assert.strictEqual(setColumnWidth(l, "type", 250.4).cols.find((c) => c.id === "type")!.width, 250);
	});

	it("moves before / after a column, never before name, never name itself", () => {
		const l = defaultLayout();
		assert.deepStrictEqual(visible(moveColumn(l, "status", "type", false)).slice(0, 3), ["name", "status", "type"]);
		assert.deepStrictEqual(visible(moveColumn(l, "type", "status", true)).slice(-3), ["status", "type", "actions"]);
		assert.deepStrictEqual(ids(moveColumn(l, "status", "name", false)).slice(0, 2), ["name", "status"]);
		assert.deepStrictEqual(moveColumn(l, "name", "type", true), l);
		assert.deepStrictEqual(moveColumn(l, "type", "type", true), l);
	});

	it("builds the grid template of the visible columns", () => {
		const g = gridTemplate(defaultLayout());
		assert.ok(g.cols.startsWith("34px minmax(140px,1fr) 120px"));
		assert.strictEqual(g.cols.split(" ").length, 1 + visible(defaultLayout()).length);
		const hidden = gridTemplate(setColumnVisible(defaultLayout(), "actions", false));
		assert.ok(hidden.minWidth < g.minWidth);
	});
});

describe("sync center name column and panes", () => {
	it("the name column's width is its minimum and counts toward the grid's minimum", () => {
		const wide = setColumnWidth(defaultLayout(), "name", 300);
		const g = gridTemplate(wide);
		assert.ok(g.cols.startsWith("34px minmax(300px,1fr)"));
		assert.strictEqual(g.minWidth - gridTemplate(defaultLayout()).minWidth, 160);
		assert.strictEqual(setColumnWidth(defaultLayout(), "name", 10).cols[0].width, 140);
	});

	it("an indent widens only the checkbox column", () => {
		const g = gridTemplate(defaultLayout(), 28);
		assert.ok(g.cols.startsWith("62px minmax(140px,1fr)"));
		assert.strictEqual(g.minWidth, gridTemplate(defaultLayout()).minWidth + 28);
	});

	it("the layout round-trips through JSON", () => {
		const l = setColumnWidth(defaultLayout(), "name", 333);
		assert.deepStrictEqual(normalizeLayout(JSON.parse(JSON.stringify(l))), l);
	});

	it("normalizePanes clamps, defaults and survives garbage", () => {
		assert.deepStrictEqual(normalizePanes({ side: 50, right: 9000 }), { side: 160, right: 600 });
		assert.deepStrictEqual(normalizePanes({ side: 300.4, right: 250 }), { side: 300, right: 250 });
		assert.deepStrictEqual(normalizePanes(undefined), defaultPanes());
		assert.deepStrictEqual(normalizePanes({ side: "x", right: NaN }), defaultPanes());
		assert.deepStrictEqual(normalizePanes(JSON.parse(JSON.stringify({ side: 200, right: 400 }))), { side: 200, right: 400 });
	});

	it("fitPanes keeps the grid at its minimum: right gives way first, then the sidebar", () => {
		const total = 1000;
		const f = fitPanes({ side: 300, right: 600 }, total, true);
		assert.ok(total - f.side - f.right - 2 * SPLITTER_W >= GRID_MIN);
		assert.strictEqual(f.side, 300);
		assert.strictEqual(f.right, 1000 - 360 - 8 - 300);
		const tight = fitPanes({ side: 480, right: 600 }, 800, true);
		assert.ok(tight.right >= 240 && tight.side >= 160);
		assert.deepStrictEqual(tight, { side: 800 - 360 - 8 - 240, right: 240 });
	});

	it("fitPanes ignores the sidebar when it is hidden and never goes below the limits", () => {
		const f = fitPanes({ side: 480, right: 600 }, 900, false);
		assert.strictEqual(f.right, 900 - 360 - 4);
		assert.strictEqual(f.side, 480);
		assert.deepStrictEqual(fitPanes({ side: 480, right: 600 }, 300, true), { side: 160, right: 240 });
	});
});
