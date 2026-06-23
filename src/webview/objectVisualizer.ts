import cytoscape = require("cytoscape");
import dagre = require("cytoscape-dagre");
import svg = require("cytoscape-svg");

cytoscape.use(dagre);
cytoscape.use(svg);

// ── Message shapes (kept inline so this browser bundle never imports host/
//    vscode-dependent modules). Must match ObjectVisualizerPanelProvider. ──────
interface GraphNodeField {
  name: string;
  type: string;
  isReference: boolean;
  referenceTo?: string[];
  relationshipName?: string;
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

let objectList: ObjectItem[] = [];
let selectedSeeds = new Set<string>();
let pickerFilter: "all" | "standard" | "custom" = "all";
let currentNodes: GraphNode[] = [];
let showFullFields = false;

// ── Cytoscape ────────────────────────────────────────────────────────────────
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

const cy = cytoscape({
  container: $("cy"),
  wheelSensitivity: 0.2,
  minZoom: 0.2,
  maxZoom: 2.5,
  style: [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": cssVar("--vscode-editorWidget-background", "#252526"),
        "border-width": 1,
        "border-color": cssVar("--vscode-widget-border", "#454545"),
        label: "data(label)",
        color: cssVar("--vscode-editor-foreground", "#ccc"),
        "font-family": "var(--vscode-editor-font-family, monospace)",
        "font-size": 11,
        "text-wrap": "wrap",
        "text-valign": "center",
        "text-halign": "center",
        "text-margin-y": 0,
        padding: "8px",
        width: "label",
        height: "label",
        "text-max-width": "260px"
      } as cytoscape.Css.Node
    },
    {
      selector: "node[?seed]",
      style: {
        "border-width": 2,
        "border-color": cssVar("--vscode-focusBorder", "#007fd4"),
        "background-color": cssVar("--vscode-editor-inactiveSelectionBackground", "#2d3640")
      } as cytoscape.Css.Node
    },
    {
      selector: "edge",
      style: {
        width: 1.4,
        "line-color": cssVar("--vscode-descriptionForeground", "#888"),
        "target-arrow-color": cssVar("--vscode-descriptionForeground", "#888"),
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "arrow-scale": 0.9,
        label: "data(via)",
        "font-size": 8,
        color: cssVar("--vscode-descriptionForeground", "#888"),
        "text-rotation": "autorotate",
        "text-background-color": cssVar("--vscode-editor-background", "#1e1e1e"),
        "text-background-opacity": 1,
        "text-background-padding": "1px"
      } as cytoscape.Css.Edge
    },
    {
      selector: "edge[?polymorphic]",
      style: { "line-style": "dashed" } as cytoscape.Css.Edge
    },
    {
      selector: "edge[?selfRef]",
      style: { "line-color": cssVar("--vscode-charts-orange", "#d18616"), "target-arrow-color": cssVar("--vscode-charts-orange", "#d18616") } as cytoscape.Css.Edge
    }
  ]
});

function nodeLabel(n: GraphNode): string {
  const fields = showFullFields ? n.fields : n.referenceFields;
  const header = (n.isSeed ? "◉ " : "") + n.id;
  if (fields.length === 0) return header;
  const lines = fields.slice(0, showFullFields ? 40 : 20).map((f) => {
    const arrow = f.isReference && f.referenceTo && f.referenceTo.length ? " → " + f.referenceTo.join("/") : "";
    return f.name + arrow;
  });
  const more = fields.length > lines.length ? "\n… +" + (fields.length - lines.length) + " more" : "";
  return header + "\n───\n" + lines.join("\n") + more;
}

function renderGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  currentNodes = nodes;
  cy.elements().remove();
  cy.add(
    nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id, label: nodeLabel(n), seed: n.isSeed ? 1 : 0 } }))
  );
  cy.add(
    edges
      .filter((e) => cy.getElementById(e.source).nonempty() && cy.getElementById(e.target).nonempty())
      .map((e) => ({
        group: "edges" as const,
        data: { id: e.id, source: e.source, target: e.target, via: e.via, polymorphic: e.polymorphic ? 1 : 0, selfRef: e.selfRef ? 1 : 0 }
      }))
  );
  cy.layout({ name: "dagre", rankDir: "LR", nodeSep: 30, rankSep: 90, edgeSep: 10 } as cytoscape.LayoutOptions).run();
  cy.fit(undefined, 30);
}

function relabelNodes() {
  cy.batch(() => {
    for (const n of currentNodes) cy.getElementById(n.id).data("label", nodeLabel(n));
  });
}

// ── Object picker ────────────────────────────────────────────────────────────
function renderPickerList() {
  const term = pickerSearch.value.trim().toLowerCase();
  const items = objectList.filter((o) => {
    if (pickerFilter === "standard" && o.custom) return false;
    if (pickerFilter === "custom" && !o.custom) return false;
    return !term || o.name.toLowerCase().includes(term);
  });
  const shown = items.slice(0, 300);
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
  pickerList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.checked) selectedSeeds.add(t.value);
      else selectedSeeds.delete(t.value);
      updatePickerCount();
    });
  });
  const hiddenNote = items.length > shown.length ? " (" + (items.length - shown.length) + " more — refine search)" : "";
  updatePickerCount(hiddenNote);
}
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

orgSelect.addEventListener("change", () => {
  post({ command: "getObjectList", targetOrg: orgSelect.value || null });
  selectedSeeds.clear();
});

$("ov-refresh").addEventListener("click", () => post({ command: "refreshCache", targetOrg: orgSelect.value || null }));
$("ov-export-png").addEventListener("click", () => {
  const data = cy.png({ full: true, scale: 2, bg: cssVar("--vscode-editor-background", "#1e1e1e") });
  post({ command: "saveFile", encoding: "base64", content: data.replace(/^data:image\/png;base64,/, ""), suggestedName: "object-diagram.png" });
});
$("ov-export-svg").addEventListener("click", () => {
  const content = (cy as unknown as { svg: (o: unknown) => string }).svg({ full: true, bg: cssVar("--vscode-editor-background", "#1e1e1e") });
  post({ command: "saveFile", encoding: "utf8", content, suggestedName: "object-diagram.svg" });
});

function childCap(): number {
  const v = childCapSelect.value;
  return v === "all" ? Number.MAX_SAFE_INTEGER : parseInt(v, 10);
}
function build() {
  if (selectedSeeds.size === 0) {
    setStatus("Pick at least one object to visualize.");
    return;
  }
  post({ command: "buildGraph", seeds: Array.from(selectedSeeds), targetOrg: orgSelect.value || null, cap: childCap() });
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
    case "objectList":
      objectList = (msg.objects as ObjectItem[]) || [];
      setStatus(objectList.length + " objects available — click “Pick objects” to start.");
      break;
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
      const warn = nodes.length > 60 ? " ⚠ large graph (" + nodes.length + " nodes)" : "";
      setStatus(nodes.length + " objects, " + edges.length + " relationships" + (trunc.length ? " · some children hidden (cap)" : "") + warn);
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
