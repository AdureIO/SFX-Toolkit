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

const accent = cssVar("--vscode-focusBorder", "#007fd4");
const fg = cssVar("--vscode-editor-foreground", "#ccc");
const lineColor = cssVar("--vscode-descriptionForeground", "#888");
const bg = cssVar("--vscode-editor-background", "#1e1e1e");

const cy = cytoscape({
  container: $("cy"),
  wheelSensitivity: 0.25,
  minZoom: 0.02,
  maxZoom: 3,
  style: [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": cssVar("--vscode-editorWidget-background", "#252526"),
        "border-width": 1,
        "border-color": cssVar("--vscode-widget-border", "#454545"),
        label: "data(label)",
        color: fg,
        "font-family": "var(--vscode-editor-font-family, monospace)",
        "font-size": 12,
        "text-wrap": "wrap",
        "text-valign": "center",
        "text-halign": "center",
        padding: "7px",
        width: "label",
        height: "label",
        "text-max-width": "320px"
      } as cytoscape.Css.Node
    },
    {
      selector: "node[?seed]",
      style: {
        "border-width": 3,
        "border-color": accent,
        "background-color": cssVar("--vscode-editor-inactiveSelectionBackground", "#2d3640"),
        "font-weight": "bold"
      } as cytoscape.Css.Node
    },
    {
      selector: "edge",
      style: {
        width: 1,
        opacity: 0.22,
        "line-color": lineColor,
        "target-arrow-color": lineColor,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "arrow-scale": 0.7
      } as cytoscape.Css.Edge
    },
    { selector: "edge[?polymorphic]", style: { "line-style": "dashed" } as cytoscape.Css.Edge },
    {
      selector: "edge[?selfRef]",
      style: { "line-color": cssVar("--vscode-charts-orange", "#d18616"), "target-arrow-color": cssVar("--vscode-charts-orange", "#d18616") } as cytoscape.Css.Edge
    },
    // Focus interaction: dim everything except the tapped node's neighbourhood.
    { selector: ".faded", style: { opacity: 0.06, "text-opacity": 0.06 } as cytoscape.Css.Node },
    { selector: "node.hl", style: { "border-color": accent, "border-width": 3 } as cytoscape.Css.Node },
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

// Tap a node → spotlight its direct relationships; tap empty space → reset.
cy.on("tap", "node", (evt) => {
  const n = evt.target;
  const hood = n.outgoers().union(n.incomers()).union(n);
  cy.elements().addClass("faded");
  hood.removeClass("faded");
  hood.nodes().addClass("hl");
  hood.edges().addClass("hl");
  n.addClass("hl");
});
cy.on("tap", (evt) => {
  if (evt.target === cy) cy.elements().removeClass("faded hl");
});

function nodeLabel(n: GraphNode): string {
  // Default: compact name-only box (relationships are shown by the edges).
  if (!showFullFields) return (n.isSeed ? "◉ " : "") + n.id;
  const header = (n.isSeed ? "◉ " : "") + n.id;
  const fields = n.fields;
  if (fields.length === 0) return header;
  const lines = fields.slice(0, 40).map((f) => {
    const arrow = f.isReference && f.referenceTo && f.referenceTo.length ? " → " + f.referenceTo.join("/") : "";
    return f.name + arrow;
  });
  const more = fields.length > lines.length ? "\n… +" + (fields.length - lines.length) + " more" : "";
  return header + "\n───\n" + lines.join("\n") + more;
}

function layoutConfig(name: string): cytoscape.LayoutOptions {
  const base = { padding: 40, animate: false, nodeDimensionsIncludeLabels: true };
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
  runLayout();
}

function relabelNodes() {
  cy.batch(() => {
    for (const n of currentNodes) cy.getElementById(n.id).data("label", nodeLabel(n));
  });
  runLayout();
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
      const warn = nodes.length > 60 ? " ⚠ large — tap a node to focus its relationships" : "";
      setStatus(nodes.length + " objects, " + edges.length + " relationships" + (trunc.length ? " · some children hidden (cap)" : "") + warn);
      break;
    }
    case "projectObjects": {
      // Auto-select the project's own objects (those defined in the SFDX source).
      const projObjects = (msg.objects as string[]) || [];
      const available = new Set(objectList.map((o) => o.name));
      const usable = projObjects.filter((n) => available.size === 0 || available.has(n));
      if (usable.length === 0) {
        setStatus("No project objects found in the workspace source.");
        break;
      }
      selectedSeeds = new Set(usable);
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
