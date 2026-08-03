import cytoscape = require("cytoscape");
import dagre = require("cytoscape-dagre");
import svg = require("cytoscape-svg");

cytoscape.use(dagre);
cytoscape.use(svg);

// ── Shapes (must match processGraph.ts; kept inline so the bundle has no host deps) ──
interface ProcessNode {
  id: string;
  kind: string;
  label: string;
  object?: string;
  namespace?: string;
  active?: boolean;
  meta?: Record<string, unknown>;
}
interface ProcessEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
}
interface ProcessGraph {
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}
interface OrgOption {
  label: string;
  username: string;
  isDefault?: boolean;
}

const vscode = acquireVsCodeApi();
const post = (msg: unknown) => vscode.postMessage(msg);
const $ = (id: string) => document.getElementById(id) as HTMLElement;

const orgSelect = $("org") as HTMLSelectElement;
const searchInput = $("search") as HTMLInputElement;
const activeOnly = $("activeOnly") as HTMLInputElement;
const statusEl = $("status");
const legendEl = $("legend");

// Per-kind colour + label.
const KIND: Record<string, { color: string; label: string }> = {
  object: { color: "#378add", label: "Object" },
  trigger: { color: "#7f77dd", label: "Apex trigger" },
  flow: { color: "#1d9e75", label: "Flow" },
  scheduledFlow: { color: "#0f6e56", label: "Scheduled flow" },
  validationRule: { color: "#ba7517", label: "Validation rule" },
  workflowRule: { color: "#d85a30", label: "Workflow rule" },
  apexClass: { color: "#888780", label: "Apex (batch/queueable)" },
  scheduledJob: { color: "#d4537e", label: "Scheduled job" }
};

let currentGraph: ProcessGraph = { nodes: [], edges: [] };

let cy: cytoscape.Core | undefined;

function render(graph: ProcessGraph): void {
  currentGraph = graph;
  const elements: cytoscape.ElementDefinition[] = [
    ...graph.nodes.map((n) => ({
      data: { id: n.id, label: n.label, kind: n.kind, object: n.object ?? "", active: n.active === false ? 0 : 1, color: (KIND[n.kind] ?? KIND.object).color }
    })),
    ...graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } }))
  ];

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("cy"),
    elements,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          label: "data(label)",
          color: "#fff",
          "font-size": 10,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "120px",
          shape: "round-rectangle",
          width: "label",
          height: "label",
          padding: "8px",
          "border-width": 1,
          "border-color": "rgba(0,0,0,0.35)"
        } as cytoscape.Css.Node
      },
      { selector: 'node[kind="object"]', style: { shape: "round-rectangle", "font-size": 12, "font-weight": "bold", padding: "12px" } as cytoscape.Css.Node },
      { selector: "node[active=0]", style: { opacity: 0.45, "border-style": "dashed" } as cytoscape.Css.Node },
      {
        selector: "edge",
        style: {
          width: 1.5,
          "line-color": "rgba(128,128,128,0.5)",
          "target-arrow-color": "rgba(128,128,128,0.6)",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier"
        } as cytoscape.Css.Edge
      },
      { selector: 'edge[kind="validates"]', style: { "line-style": "dashed", "line-color": "#ba7517", "target-arrow-color": "#ba7517" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="schedules"]', style: { "line-color": "#d4537e", "target-arrow-color": "#d4537e" } as cytoscape.Css.Edge },
      { selector: ".hidden", style: { display: "none" } as cytoscape.Css.Node },
      { selector: ".faded", style: { opacity: 0.12 } as cytoscape.Css.Node },
      { selector: ".hl", style: { "line-color": "var(--accent)", "target-arrow-color": "var(--accent)", width: 3 } as cytoscape.Css.Edge }
    ],
    layout: { name: "dagre", rankDir: "LR", nodeSep: 18, rankSep: 90 } as cytoscape.LayoutOptions,
    wheelSensitivity: 0.25
  });

  // Focus a node's neighbourhood on tap; click background to clear.
  cy.on("tap", "node", (evt: cytoscape.EventObject) => {
    const n = evt.target;
    const hood = n.closedNeighborhood();
    cy!.elements().addClass("faded");
    hood.removeClass("faded");
    hood.connectedEdges().addClass("hl");
  });
  cy.on("tap", (evt: cytoscape.EventObject) => {
    if (evt.target === cy) {
      cy!.elements().removeClass("faded hl");
    }
  });

  applyFilter();
  const counts = graph.nodes.reduce((m: Record<string, number>, n) => ((m[n.kind] = (m[n.kind] ?? 0) + 1), m), {});
  statusEl.textContent =
    `${graph.nodes.length} nodes, ${graph.edges.length} edges` +
    (counts.object ? ` · ${counts.object} objects` : "") +
    (counts.trigger ? ` · ${counts.trigger} triggers` : "") +
    (counts.flow || counts.scheduledFlow ? ` · ${(counts.flow ?? 0) + (counts.scheduledFlow ?? 0)} flows` : "");
}

function applyFilter(): void {
  if (!cy) return;
  const q = searchInput.value.trim().toLowerCase();
  const onlyActive = activeOnly.checked;
  cy.batch(() => {
    cy!.nodes().forEach((n: cytoscape.NodeSingular) => {
      const kind = String(n.data("kind"));
      let show = true;
      if (kind !== "object") {
        if (onlyActive && n.data("active") === 0) show = false;
        if (q && !String(n.data("label")).toLowerCase().includes(q) && !String(n.data("object")).toLowerCase().includes(q)) show = false;
      }
      n.toggleClass("hidden", !show);
    });
    // Hide object nodes with no visible automation neighbour.
    cy!.nodes('[kind="object"]').forEach((o: cytoscape.NodeSingular) => {
      let anyVisible = false;
      o.connectedEdges().connectedNodes().forEach((nb: cytoscape.NodeSingular) => {
        if (nb.id() !== o.id() && !nb.hasClass("hidden")) anyVisible = true;
      });
      o.toggleClass("hidden", !anyVisible);
    });
  });
}

function renderLegend(): void {
  legendEl.innerHTML = Object.values(KIND)
    .map((k) => `<span class="lg"><span class="dot" style="background:${k.color}"></span>${k.label}</span>`)
    .join("");
}

// ── Toolbar wiring ─────────────────────────────────────────────────────────────
$("build").addEventListener("click", () => post({ command: "build", org: orgSelect.value }));
searchInput.addEventListener("input", applyFilter);
activeOnly.addEventListener("change", applyFilter);
$("fit").addEventListener("click", () => cy?.fit(undefined, 30));
$("exportJson").addEventListener("click", () => post({ command: "export", filename: "process-map.json", content: JSON.stringify(currentGraph, null, 2) }));
$("exportPng").addEventListener("click", () => {
  if (!cy) return;
  const data = cy.png({ full: true, output: "base64", bg: "#1e1e1e" });
  post({ command: "export", filename: "process-map.png", content: data, base64: true });
});
$("copyLlm").addEventListener("click", () => post({ command: "copyLlm" }));

window.addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { command: string; orgs?: OrgOption[]; graph?: ProcessGraph; value?: boolean; text?: string };
  if (d.command === "orgList") {
    orgSelect.innerHTML = (d.orgs ?? []).map((o) => `<option value="${o.username}">${o.label}</option>`).join("");
  } else if (d.command === "graph" && d.graph) {
    render(d.graph);
    if (cy) cy.fit(undefined, 30);
  } else if (d.command === "loading") {
    statusEl.textContent = d.value ? "Building the process map…" : statusEl.textContent;
  } else if (d.command === "error") {
    statusEl.textContent = d.text ?? "Error.";
  }
});

renderLegend();
post({ command: "ready" });
