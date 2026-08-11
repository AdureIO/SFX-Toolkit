import cytoscape = require("cytoscape");
import dagre = require("cytoscape-dagre");
import svg = require("cytoscape-svg");
import nodeHtmlLabel = require("cytoscape-node-html-label");
import { ObjectSelection, PickerKind } from "./objectSelection";

cytoscape.use(dagre);
cytoscape.use(svg);
nodeHtmlLabel(cytoscape);

// ── Message shapes (kept inline so this browser bundle never imports host/
//    vscode-dependent modules). Must match ObjectVisualizerPanelProvider. ──────
interface GraphNodeField {
  name: string;
  type: string;
  isReference: boolean;
  referenceTo?: string[];
  relationshipName?: string;
  updateable?: boolean;
  calculated?: boolean;
}
interface GraphNode {
  id: string;
  isSeed: boolean;
  fields: GraphNodeField[];
  referenceFields: GraphNodeField[];
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  via: string;
  polymorphic: boolean;
  selfRef: boolean;
}
interface OrgOption {
  label: string;
  username: string;
  isDefault?: boolean;
}
interface ObjectItem {
  name: string;
  custom: boolean;
}

const vscode = acquireVsCodeApi();
function post(msg: unknown) {
  vscode.postMessage(msg);
}

// ── Element refs ─────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const orgSelect = $("ov-org") as HTMLSelectElement;
const childCapSelect = $("ov-childcap") as HTMLSelectElement;
const fullFieldsToggle = $("ov-fullfields") as HTMLInputElement;
const statusEl = $("ov-status");
const pickerEl = $("ov-picker");
const pickerSearch = $("ov-picker-search") as HTMLInputElement;
const pickerList = $("ov-picker-list");
const pickerCount = $("ov-picker-count");

const selectedSeeds = new ObjectSelection();
let pickerFilter: PickerKind = "all";
let currentNodes: GraphNode[] = [];
let showFullFields = false;

// ── Cytoscape ────────────────────────────────────────────────────────────────
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

const accent = cssVar("--vscode-focusBorder", "#007fd4");
const fg = cssVar("--vscode-editor-foreground", "#ccc");
const lineColor = cssVar("--vscode-descriptionForeground", "#888");
const bg = cssVar("--vscode-editor-background", "#1e1e1e");

const cyContainer = $("cy");
const cy = cytoscape({
  container: cyContainer,
  userZoomingEnabled: false, // we handle wheel ourselves: scroll = pan, pinch = zoom
  minZoom: 0.02,
  maxZoom: 3,
  style: [
    {
      // The node itself is an invisible bounding box; the HTML card draws on top.
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-opacity": 0,
        "border-width": 0,
        width: "data(w)",
        height: "data(h)"
      } as cytoscape.Css.Node
    },
    {
      selector: "edge",
      style: {
        width: 1,
        opacity: 0.28,
        "line-color": lineColor,
        "target-arrow-color": lineColor,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "arrow-scale": 0.8
      } as cytoscape.Css.Edge
    },
    { selector: "edge[?polymorphic]", style: { "line-style": "dashed" } as cytoscape.Css.Edge },
    {
      selector: "edge[?selfRef]",
      style: { "line-color": cssVar("--vscode-charts-orange", "#d18616"), "target-arrow-color": cssVar("--vscode-charts-orange", "#d18616") } as cytoscape.Css.Edge
    },
    { selector: "edge.faded", style: { opacity: 0.05 } as cytoscape.Css.Edge },
    {
      selector: "edge.hl",
      style: {
        opacity: 1,
        width: 2,
        "line-color": accent,
        "target-arrow-color": accent,
        label: "data(via)",
        "font-size": 10,
        color: fg,
        "text-rotation": "autorotate",
        "text-background-color": bg,
        "text-background-opacity": 1,
        "text-background-padding": "2px"
      } as cytoscape.Css.Edge
    }
  ]
});

// ── dbdiagram-style HTML cards ───────────────────────────────────────────────
function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function capTargets(arr: string[]): string {
  return arr.length > 2 ? arr.slice(0, 2).join(", ") + " +" + (arr.length - 2) : arr.join(", ");
}

const CARD_W = 244;
const HEAD_H = 30;
const ROW_H = 19;
const MORE_H = 18;
const MAX_ROWS = 24;

// Well-known system / audit fields, always treated as system.
const SYSTEM_FIELD_NAMES = new Set([
  "IsDeleted", "CreatedById", "CreatedDate", "LastModifiedById", "LastModifiedDate", "SystemModstamp",
  "LastActivityDate", "LastViewedDate", "LastReferencedDate", "MayEdit", "IsLocked", "UserRecordAccessId"
]);
// Standard noisy flag groups (e.g. User has hundreds of these editable booleans).
const SYSTEM_FIELD_PREFIXES = ["UserPermissions", "UserPreferences", "EmailPreferences"];
let hideSystem = true;

/** A field counts as "system": audit fields, standard flag groups, or read-only non-formula fields. */
function isSystemField(f: GraphNodeField): boolean {
  if (SYSTEM_FIELD_NAMES.has(f.name)) return true;
  if (SYSTEM_FIELD_PREFIXES.some((p) => f.name.startsWith(p))) return true;
  if (f.name === "Id" || f.name === "Name" || f.isReference) return false;
  if (f.calculated) return false; // keep formula fields — they're business logic
  return f.updateable === false; // read-only, system-maintained
}

/**
 * Which fields a card shows. "Full fields" → every field on every card (no cap).
 * Otherwise the relationship-relevant subset (Id, Name, and reference fields).
 * System/read-only fields are hidden unless the "System" toggle is on.
 */
function visibleFields(n: GraphNode): { rows: GraphNodeField[]; hidden: number } {
  let source = showFullFields ? n.fields : n.fields.filter((f) => f.name === "Id" || f.name === "Name" || f.isReference);
  if (hideSystem) source = source.filter((f) => !isSystemField(f));
  const cap = showFullFields ? Number.MAX_SAFE_INTEGER : MAX_ROWS;
  if (source.length <= cap) return { rows: source, hidden: 0 };
  return { rows: source.slice(0, cap), hidden: source.length - cap };
}

function rowHtml(f: GraphNodeField): string {
  const badge =
    f.name === "Id"
      ? '<span class="ov-pk">PK</span>'
      : f.isReference
      ? '<span class="ov-fk">FK</span>'
      : "";
  const type = f.isReference && f.referenceTo && f.referenceTo.length ? "→ " + capTargets(f.referenceTo) : f.type;
  return (
    '<div class="ov-row' +
    (f.isReference ? " is-ref" : "") +
    '"><span class="ov-fname">' +
    esc(f.name) +
    "</span>" +
    badge +
    '<span class="ov-ftype">' +
    esc(type) +
    "</span></div>"
  );
}

function cardInner(n: GraphNode): string {
  const { rows, hidden } = visibleFields(n);
  const head =
    '<div class="ov-head"><span class="ov-title">' +
    esc(n.id) +
    '</span><span class="ov-fcount">' +
    n.fields.length +
    " fields</span></div>";
  if (rows.length === 0 && hidden === 0) return head;
  const body = rows.map(rowHtml).join("") + (hidden > 0 ? '<div class="ov-more">… +' + hidden + " more</div>" : "");
  return head + '<div class="ov-body">' + body + "</div>";
}

function nodeData(n: GraphNode) {
  const { rows, hidden } = visibleFields(n);
  const bodyH = rows.length === 0 && hidden === 0 ? 0 : rows.length * ROW_H + (hidden > 0 ? MORE_H : 0) + 6;
  return {
    id: n.id,
    seed: n.isSeed ? 1 : 0,
    w: CARD_W,
    h: HEAD_H + bodyH,
    inner: cardInner(n),
    dim: 0,
    focus: 0
  };
}

(cy as unknown as { nodeHtmlLabel: (opts: unknown[]) => void }).nodeHtmlLabel([
  {
    query: "node",
    halign: "center",
    valign: "center",
    halignBox: "center",
    valignBox: "center",
    tpl: (d: { w: number; seed: number; dim: number; focus: number; inner: string }) => {
      const cls =
        "ov-card" + (d.seed ? " ov-card--seed" : "") + (d.dim ? " is-dim" : "") + (d.focus ? " is-focus" : "");
      return '<div class="' + cls + '" style="width:' + d.w + 'px">' + d.inner + "</div>";
    }
  }
]);

// Tap a node → spotlight its direct relationships; tap empty space → reset.
function clearFocus() {
  cy.batch(() => {
    cy.nodes().forEach((x: cytoscape.NodeSingular) => {
      x.data("dim", 0);
      x.data("focus", 0);
    });
  });
  cy.elements().removeClass("faded hl");
}
cy.on("tap", "node", (evt: cytoscape.EventObject) => {
  const n = evt.target;
  const hood = n.outgoers().union(n.incomers()).union(n);
  const keep = new Set(hood.nodes().map((x: cytoscape.NodeSingular) => x.id()));
  cy.batch(() => {
    cy.nodes().forEach((x: cytoscape.NodeSingular) => {
      x.data("dim", keep.has(x.id()) ? 0 : 1);
      x.data("focus", x.id() === n.id() ? 1 : 0);
    });
  });
  cy.elements().addClass("faded");
  hood.removeClass("faded");
  hood.edges().addClass("hl");
});
cy.on("tap", (evt: cytoscape.EventObject) => {
  if (evt.target === cy) clearFocus();
});

// Trackpad-modern input: two-finger scroll pans, pinch (ctrl/⌘ + wheel) zooms.
cyContainer.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.pow(1.01, -e.deltaY);
      const level = Math.min(3, Math.max(0.02, cy.zoom() * factor));
      cy.zoom({ level, renderedPosition: { x: e.offsetX, y: e.offsetY } });
    } else {
      cy.panBy({ x: -e.deltaX, y: -e.deltaY });
    }
  },
  { passive: false }
);

function layoutConfig(name: string): cytoscape.LayoutOptions {
  const base = { padding: 40, animate: false, nodeDimensionsIncludeLabels: false };
  switch (name) {
    case "dagre-tb":
      return { name: "dagre", rankDir: "TB", nodeSep: 35, rankSep: 110, edgeSep: 10, ...base } as cytoscape.LayoutOptions;
    case "grid":
      return { name: "grid", avoidOverlap: true, ...base } as cytoscape.LayoutOptions;
    case "concentric":
      return {
        name: "concentric",
        minNodeSpacing: 30,
        concentric: (n: cytoscape.NodeSingular) => (n.data("seed") ? 2 : 1),
        levelWidth: () => 1,
        ...base
      } as unknown as cytoscape.LayoutOptions;
    case "cose":
      return { name: "cose", idealEdgeLength: () => 120, nodeRepulsion: () => 9000, ...base } as unknown as cytoscape.LayoutOptions;
    case "breadthfirst":
      return { name: "breadthfirst", directed: true, spacingFactor: 1.3, ...base } as cytoscape.LayoutOptions;
    default:
      return { name: "dagre", rankDir: "LR", nodeSep: 35, rankSep: 130, edgeSep: 10, ...base } as cytoscape.LayoutOptions;
  }
}

let currentLayout = "dagre-lr";
function runLayout() {
  cy.layout(layoutConfig(currentLayout)).run();
  cy.fit(undefined, 40);
}

function renderGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  currentNodes = nodes;
  cy.elements().remove();
  cy.add(nodes.map((n) => ({ group: "nodes" as const, data: nodeData(n) })));
  cy.add(
    edges
      .filter((e) => cy.getElementById(e.source).nonempty() && cy.getElementById(e.target).nonempty())
      .map((e) => ({
        group: "edges" as const,
        data: { id: e.id, source: e.source, target: e.target, via: e.via, polymorphic: e.polymorphic ? 1 : 0, selfRef: e.selfRef ? 1 : 0 }
      }))
  );
  runLayout();
}

function relabelNodes() {
  // Full-fields toggle changes card content + height → recompute and re-lay out.
  cy.batch(() => {
    for (const n of currentNodes) {
      const d = nodeData(n);
      const node = cy.getElementById(n.id);
      node.data("inner", d.inner);
      node.data("h", d.h);
    }
  });
  runLayout();
}

// ── Object picker (selection state shared with the Process Visualizer) ───────
function renderPickerList() {
  const { shown, hidden } = selectedSeeds.visible(pickerSearch.value, { kind: pickerFilter, cap: 300 });
  pickerList.innerHTML = shown
    .map(
      (o) =>
        '<label class="ov-pick-item"><input type="checkbox" value="' +
        o.name +
        '"' +
        (selectedSeeds.has(o.name) ? " checked" : "") +
        "> " +
        o.name +
        (o.custom ? ' <span class="ov-badge">custom</span>' : "") +
        "</label>"
    )
    .join("");
  updatePickerCount(hidden ? " (" + hidden + " more — refine search)" : "");
}
// One delegated listener for the whole list (not one per checkbox per render).
pickerList.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.type !== "checkbox") return;
  selectedSeeds.set(t.value, t.checked);
  updatePickerCount();
});
function updatePickerCount(extra = "") {
  pickerCount.textContent = selectedSeeds.size + " selected" + extra;
}
function openPicker() {
  pickerEl.classList.add("open");
  renderPickerList();
  pickerSearch.focus();
}
function closePicker() {
  pickerEl.classList.remove("open");
}

// ── Wire toolbar ─────────────────────────────────────────────────────────────
function setStatus(text: string) {
  statusEl.textContent = text;
}

$("ov-pick").addEventListener("click", openPicker);
$("ov-picker-cancel").addEventListener("click", closePicker);
$("ov-picker-apply").addEventListener("click", () => {
  closePicker();
  build();
});
$("ov-picker-clear").addEventListener("click", () => {
  selectedSeeds.clear();
  renderPickerList();
});
pickerSearch.addEventListener("input", renderPickerList);
document.querySelectorAll('input[name="ov-filter"]').forEach((r) =>
  r.addEventListener("change", (e) => {
    pickerFilter = (e.target as HTMLInputElement).value as typeof pickerFilter;
    renderPickerList();
  })
);

fullFieldsToggle.addEventListener("change", () => {
  showFullFields = fullFieldsToggle.checked;
  relabelNodes();
});

const systemToggle = $("ov-system") as HTMLInputElement;
hideSystem = !systemToggle.checked; // default: unchecked → system hidden
systemToggle.addEventListener("change", () => {
  hideSystem = !systemToggle.checked;
  relabelNodes();
});

orgSelect.addEventListener("change", () => {
  post({ command: "getObjectList", targetOrg: orgSelect.value || null });
  selectedSeeds.clear();
});

const layoutSelect = $("ov-layout") as HTMLSelectElement;
layoutSelect.addEventListener("change", () => {
  currentLayout = layoutSelect.value;
  if (currentNodes.length) runLayout();
});
$("ov-fit").addEventListener("click", () => cy.fit(undefined, 40));
$("ov-project").addEventListener("click", () => post({ command: "getProjectObjects" }));
$("ov-refresh").addEventListener("click", () => post({ command: "refreshCache", targetOrg: orgSelect.value || null }));
$("ov-export-png").addEventListener("click", () => {
  const data = cy.png({ full: true, scale: 2, bg: cssVar("--vscode-editor-background", "#1e1e1e") });
  post({ command: "saveFile", encoding: "base64", content: data.replace(/^data:image\/png;base64,/, ""), suggestedName: "object-diagram.png" });
});
$("ov-export-svg").addEventListener("click", () => {
  const content = (cy as unknown as { svg: (o: unknown) => string }).svg({ full: true, bg: cssVar("--vscode-editor-background", "#1e1e1e") });
  post({ command: "saveFile", encoding: "utf8", content, suggestedName: "object-diagram.svg" });
});

const directionSelect = $("ov-direction") as HTMLSelectElement;
const polyToggle = $("ov-poly") as HTMLInputElement;
const auditToggle = $("ov-audit") as HTMLInputElement;
function childCap(): number {
  const v = childCapSelect.value;
  return v === "all" ? Number.MAX_SAFE_INTEGER : parseInt(v, 10);
}
function build() {
  if (selectedSeeds.size === 0) {
    setStatus("Pick at least one object to visualize.");
    return;
  }
  post({
    command: "buildGraph",
    seeds: selectedSeeds.values(),
    targetOrg: orgSelect.value || null,
    cap: childCap(),
    direction: directionSelect.value,
    includePolymorphic: polyToggle.checked,
    includeAudit: auditToggle.checked
  });
}

// ── Host -> webview ──────────────────────────────────────────────────────────
window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as Record<string, unknown>;
  switch (msg.command) {
    case "orgList": {
      const orgs = (msg.orgs as OrgOption[]) || [];
      orgSelect.innerHTML = '<option value="">Default org</option>';
      for (const o of orgs) {
        const opt = document.createElement("option");
        opt.value = o.username || "";
        opt.textContent = o.label || o.username;
        if (o.isDefault) opt.selected = true;
        orgSelect.appendChild(opt);
      }
      post({ command: "getObjectList", targetOrg: orgSelect.value || null });
      break;
    }
    case "objectList": {
      const objects = (msg.objects as ObjectItem[]) || [];
      selectedSeeds.setItems(objects);
      setStatus(objects.length + " objects available — click “Pick objects” to start.");
      break;
    }
    case "progress":
      setStatus("Describing " + msg.done + "/" + msg.total + " objects…");
      break;
    case "loading":
      if (msg.value) setStatus("Loading…");
      break;
    case "graph": {
      const nodes = (msg.nodes as GraphNode[]) || [];
      const edges = (msg.edges as GraphEdge[]) || [];
      renderGraph(nodes, edges);
      const trunc = (msg.truncated as string[]) || [];
      const warn = nodes.length > 60 ? " ⚠ large — tap a node to focus its relationships" : "";
      setStatus(nodes.length + " objects, " + edges.length + " relationships" + (trunc.length ? " · some children hidden (cap)" : "") + warn);
      break;
    }
    case "projectObjects": {
      // Auto-select the project's own objects (those defined in the SFDX source).
      const projObjects = (msg.objects as string[]) || [];
      const available = new Set(selectedSeeds.names());
      const usable = projObjects.filter((n) => available.size === 0 || available.has(n));
      if (usable.length === 0) {
        setStatus("No project objects found in the workspace source.");
        break;
      }
      selectedSeeds.replaceAll(usable);
      setStatus("Selected " + usable.length + " project object(s).");
      build();
      break;
    }
    case "cacheRefreshed":
      post({ command: "getObjectList", targetOrg: orgSelect.value || null });
      setStatus("Cache refreshed.");
      break;
    case "error":
      setStatus("Error: " + msg.text);
      break;
  }
});

// Kick things off.
post({ command: "getOrgList" });
