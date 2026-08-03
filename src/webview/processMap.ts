import cytoscape = require("cytoscape");
import dagre = require("cytoscape-dagre");
import svg = require("cytoscape-svg");

cytoscape.use(dagre);
cytoscape.use(svg);

// ── Shapes (must match processGraph.ts) ─────────────────────────────────────────
interface ProcessNode {
  id: string;
  kind: string;
  label: string;
  object?: string;
  namespace?: string;
  active?: boolean;
  meta?: Record<string, unknown>;
}
interface ProcessEdge { id: string; source: string; target: string; kind: string; label?: string; }
interface ProcessGraph { nodes: ProcessNode[]; edges: ProcessEdge[]; }
interface OrgOption { label: string; username: string; }

const vscode = acquireVsCodeApi();
const post = (msg: unknown) => vscode.postMessage(msg);
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const orgSelect = $("org") as HTMLSelectElement;
const searchInput = $("search") as HTMLInputElement;
const activeOnly = $("activeOnly") as HTMLInputElement;
const statusEl = $("status");
const legendEl = $("legend");
const emptyEl = $("empty");
const inspectorEl = $("inspector");
const inspInner = $("inspInner");

const KIND: Record<string, { color: string; icon: string; label: string }> = {
  object: { color: "#3b82f6", icon: "▤", label: "Object" },
  field: { color: "#64748b", icon: "◆", label: "Field" },
  trigger: { color: "#8b5cf6", icon: "⚡", label: "Apex trigger" },
  flow: { color: "#10b981", icon: "⇄", label: "Flow" },
  scheduledFlow: { color: "#0d9488", icon: "⏱", label: "Scheduled flow" },
  validationRule: { color: "#f59e0b", icon: "✓", label: "Validation rule" },
  workflowRule: { color: "#f97316", icon: "⚙", label: "Workflow rule" },
  fieldUpdate: { color: "#eab308", icon: "✎", label: "Field update" },
  apexClass: { color: "#6b7280", icon: "❯", label: "Apex (async)" },
  scheduledJob: { color: "#ec4899", icon: "⏰", label: "Scheduled job" }
};

const themeFg = getComputedStyle(document.body).color || "#cccccc";

let currentGraph: ProcessGraph = { nodes: [], edges: [] };
let cy: cytoscape.Core | undefined;
let layoutName = "dagre";
const hiddenKinds = new Set<string>();
let nodeById = new Map<string, ProcessNode>();

// ── Render ──────────────────────────────────────────────────────────────────────
function render(graph: ProcessGraph): void {
  currentGraph = graph;
  nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  emptyEl.style.display = graph.nodes.length ? "none" : "flex";
  emptyEl.classList.remove("spin");

  const elements: cytoscape.ElementDefinition[] = [
    ...graph.nodes.map((n) => {
      const k = KIND[n.kind] ?? KIND.object;
      return {
        data: {
          id: n.id,
          label: `${k.icon}  ${n.label}`,
          kind: n.kind,
          object: n.object ?? "",
          color: k.color,
          active: n.active === false ? 0 : 1
        }
      };
    }),
    ...graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind } }))
  ];

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("cy"),
    elements,
    minZoom: 0.15,
    maxZoom: 2.5,
    wheelSensitivity: 0.28,
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          "background-opacity": 0.16,
          "border-color": "data(color)",
          "border-width": 1.5,
          label: "data(label)",
          color: themeFg,
          "font-size": 11,
          "font-family": "var(--vscode-font-family)",
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "150px",
          shape: "round-rectangle",
          width: "label",
          height: "label",
          padding: "10px",
          "transition-property": "opacity, border-width, background-opacity",
          "transition-duration": 150
        } as cytoscape.Css.Node
      },
      { selector: 'node[kind="object"]', style: { "background-opacity": 0.9, color: "#fff", "font-weight": "bold", "font-size": 12, padding: "13px", "border-width": 0 } as cytoscape.Css.Node },
      { selector: 'node[kind="field"]', style: { shape: "round-rectangle", "font-size": 10, padding: "7px" } as cytoscape.Css.Node },
      { selector: "node[active=0]", style: { opacity: 0.5, "border-style": "dashed" } as cytoscape.Css.Node },
      { selector: "node.sel", style: { "border-width": 3, "border-color": themeFg } as cytoscape.Css.Node },
      { selector: "node.match", style: { "border-width": 3, "border-color": "#facc15" } as cytoscape.Css.Node },
      {
        selector: "edge",
        style: {
          width: 1.4,
          "line-color": "rgba(140,140,150,0.45)",
          "target-arrow-color": "rgba(140,140,150,0.55)",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.9,
          "curve-style": "bezier",
          "transition-property": "opacity, line-color, width",
          "transition-duration": 150
        } as cytoscape.Css.Edge
      },
      { selector: 'edge[kind="validates"]', style: { "line-style": "dashed", "line-color": "#f59e0b", "target-arrow-color": "#f59e0b" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="schedules"]', style: { "line-color": "#ec4899", "target-arrow-color": "#ec4899" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="invokes"]', style: { "line-style": "dashed", "line-color": "#8b5cf6", "target-arrow-color": "#8b5cf6" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="updates"]', style: { "line-color": "#10b981", "target-arrow-color": "#10b981", width: 1.8 } as cytoscape.Css.Edge },
      { selector: 'edge[kind="fieldOf"]', style: { "line-color": "rgba(120,120,130,0.28)", "target-arrow-shape": "none", "line-style": "dotted" } as cytoscape.Css.Edge },
      { selector: ".hidden", style: { display: "none" } as cytoscape.Css.Node },
      { selector: ".faded", style: { opacity: 0.1 } as cytoscape.Css.Node },
      { selector: "edge.hl", style: { width: 2.6, "line-color": themeFg, "target-arrow-color": themeFg, opacity: 1 } as cytoscape.Css.Edge }
    ],
    layout: { name: "grid" } as cytoscape.LayoutOptions
  });

  cy.on("tap", "node", (evt: cytoscape.EventObject) => select(evt.target.id()));
  cy.on("tap", (evt: cytoscape.EventObject) => { if (evt.target === cy) clearSelection(); });

  runLayout();
  applyVisibility();
  buildLegend();
  updateStatus();
}

// ── Layout ────────────────────────────────────────────────────────────────────
function runLayout(): void {
  if (!cy) return;
  let opts: cytoscape.LayoutOptions;
  if (layoutName === "cose") {
    opts = { name: "cose", animate: true, animationDuration: 500, nodeRepulsion: () => 12000, idealEdgeLength: () => 90, padding: 40 } as unknown as cytoscape.LayoutOptions;
  } else if (layoutName === "order") {
    const positions = computeOrderPositions(currentGraph);
    opts = { name: "preset", positions: (n: cytoscape.NodeSingular) => positions[n.id()] ?? { x: 0, y: 0 }, fit: true, padding: 50, animate: true, animationDuration: 450 } as unknown as cytoscape.LayoutOptions;
  } else {
    opts = { name: "dagre", rankDir: "LR", nodeSep: 20, rankSep: 110, animate: true, animationDuration: 450, padding: 40 } as unknown as cytoscape.LayoutOptions;
  }
  cy.layout(opts).run();
}

/** Swimlane positions: one lane per object, phases left→right by order-of-execution. */
function computeOrderPositions(graph: ProcessGraph): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const objects = graph.nodes.filter((n) => n.kind === "object").map((n) => n.id);
  const objIndex = new Map(objects.map((id, i) => [id, i]));
  const laneH = 150, baseX = 520, colW = 175;
  const offsetFor = (n: ProcessNode): number | null => {
    if (n.kind === "object") return 0;
    if (n.kind === "field") return 4;
    const o = n.meta && typeof n.meta.order === "string" ? Number(n.meta.order) : null;
    if (o === 1) return -3;
    if (o === 2) return -2;
    if (o === 3) return -1;
    if (o === 5) return 1;
    if (o === 6) return 2;
    return null;
  };
  const cellCount = new Map<string, number>();
  const standalone: ProcessNode[] = [];
  for (const n of graph.nodes) {
    if (n.kind === "object") { pos[n.id] = { x: baseX, y: (objIndex.get(n.id) ?? 0) * laneH }; continue; }
    const off = offsetFor(n);
    const objId = n.object ? `object:${n.object}` : null;
    if (off === null || !objId || !objIndex.has(objId)) { standalone.push(n); continue; }
    const laneY = (objIndex.get(objId) ?? 0) * laneH;
    const key = `${objId}:${off}`;
    const c = cellCount.get(key) ?? 0;
    cellCount.set(key, c + 1);
    pos[n.id] = { x: baseX + off * colW, y: laneY + (c - 0.5) * 34 };
  }
  const bandY = objects.length * laneH + 120;
  standalone.forEach((n, i) => { pos[n.id] = { x: 160 + (i % 8) * 175, y: bandY + Math.floor(i / 8) * 84 }; });
  return pos;
}

// ── Visibility (legend toggles + search + active-only) ──────────────────────────
function applyVisibility(): void {
  if (!cy) return;
  const q = searchInput.value.trim().toLowerCase();
  const onlyActive = activeOnly.checked;
  cy.batch(() => {
    cy!.nodes().forEach((n: cytoscape.NodeSingular) => {
      const kind = String(n.data("kind"));
      let show = !hiddenKinds.has(kind);
      if (show && kind !== "object" && onlyActive && n.data("active") === 0) show = false;
      const matched = !q || String(n.data("label")).toLowerCase().includes(q) || String(n.data("object")).toLowerCase().includes(q);
      if (show && kind !== "object" && q && !matched) show = false;
      n.toggleClass("hidden", !show);
      n.toggleClass("match", !!q && matched && kind !== "object");
    });
    cy!.nodes('[kind="object"]').forEach((o: cytoscape.NodeSingular) => {
      let anyVisible = false;
      o.connectedEdges().connectedNodes().forEach((nb: cytoscape.NodeSingular) => {
        if (nb.id() !== o.id() && !nb.hasClass("hidden")) anyVisible = true;
      });
      o.toggleClass("hidden", !anyVisible);
    });
  });
}

// ── Selection / focus + inspector ───────────────────────────────────────────────
function select(id: string): void {
  if (!cy) return;
  const node = cy.getElementById(id);
  if (!node.length) return;
  cy.elements().removeClass("sel faded hl");
  const hood = node.closedNeighborhood();
  cy.elements().addClass("faded");
  hood.removeClass("faded");
  hood.connectedEdges().addClass("hl");
  node.addClass("sel");
  openInspector(id);
}
function clearSelection(): void {
  if (!cy) return;
  cy.elements().removeClass("sel faded hl");
  inspectorEl.classList.remove("open");
}

function neighborsOf(id: string): { incoming: ProcessEdge[]; outgoing: ProcessEdge[] } {
  return {
    incoming: currentGraph.edges.filter((e) => e.target === id),
    outgoing: currentGraph.edges.filter((e) => e.source === id)
  };
}

function connRow(id: string): string {
  const n = nodeById.get(id);
  if (!n) return "";
  const k = KIND[n.kind] ?? KIND.object;
  return `<div class="conn" data-goto="${esc(id)}"><span class="sw" style="background:${k.color}"></span>${k.icon} ${esc(n.label)}</div>`;
}

function openInspector(id: string): void {
  const n = nodeById.get(id);
  if (!n) return;
  const k = KIND[n.kind] ?? KIND.object;
  const m = n.meta ?? {};
  const rows: string[] = [];
  const row = (key: string, val: unknown) => { if (val !== undefined && val !== "" && !(Array.isArray(val) && !val.length)) rows.push(`<div class="meta-row"><span class="k">${key}</span><span class="v">${esc(Array.isArray(val) ? val.join(", ") : val)}</span></div>`); };
  row("Object", n.object);
  row("Namespace", n.namespace);
  if (n.active !== undefined) row("Active", n.active ? "Yes" : "No");
  row("Events", m.events);
  row("Trigger", m.triggerType);
  row("Process type", m.processType);
  row("Interfaces", m.interfaces);
  row("Cron", m.cron);
  row("Next fire", m.nextFire);
  row("Exec phase", m.order);

  const { incoming, outgoing } = neighborsOf(id);
  const sections: string[] = [];
  if (n.kind === "object") {
    const autos = incoming.filter((e) => e.kind === "runsOn" || e.kind === "validates").map((e) => e.source);
    const fields = incoming.filter((e) => e.kind === "fieldOf").map((e) => e.source);
    if (autos.length) sections.push(`<div class="insp-sec"><h4>Automation on this object (${autos.length})</h4>${autos.map(connRow).join("")}</div>`);
    if (fields.length) sections.push(`<div class="insp-sec"><h4>Fields written (${fields.length})</h4>${fields.map(connRow).join("")}</div>`);
  } else if (n.kind === "field") {
    const setters = incoming.filter((e) => e.kind === "updates").map((e) => e.source);
    sections.push(`<div class="insp-sec"><h4>Set by (${setters.length})</h4>${setters.length ? setters.map(connRow).join("") : '<div class="conn">No automation writes this field</div>'}</div>`);
  } else {
    const runsOn = outgoing.filter((e) => e.kind === "runsOn" || e.kind === "validates").map((e) => e.target);
    const writes = outgoing.filter((e) => e.kind === "updates").map((e) => e.target);
    const invokes = outgoing.filter((e) => e.kind === "invokes" || e.kind === "schedules").map((e) => e.target);
    if (runsOn.length) sections.push(`<div class="insp-sec"><h4>Runs on</h4>${runsOn.map(connRow).join("")}</div>`);
    if (writes.length) sections.push(`<div class="insp-sec"><h4>Writes fields (${writes.length})</h4>${writes.map(connRow).join("")}</div>`);
    if (invokes.length) sections.push(`<div class="insp-sec"><h4>Calls</h4>${invokes.map(connRow).join("")}</div>`);
  }

  inspInner.innerHTML =
    `<div class="insp-head">
       <div class="insp-ico" style="background:${k.color}">${k.icon}</div>
       <div><div class="insp-title">${esc(n.label)}</div><div class="insp-kind">${k.label}</div></div>
       <button class="insp-x" id="inspClose">×</button>
     </div>
     <div class="insp-body">${rows.join("") || '<div class="meta-row"><span class="k">No metadata</span></div>'}${sections.join("")}</div>`;
  inspectorEl.classList.add("open");
  (document.getElementById("inspClose") as HTMLElement).onclick = clearSelection;
  inspInner.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", () => select((el as HTMLElement).getAttribute("data-goto") as string))
  );
}

// ── Legend ──────────────────────────────────────────────────────────────────────
function buildLegend(): void {
  const counts: Record<string, number> = {};
  for (const n of currentGraph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  legendEl.innerHTML = Object.keys(KIND)
    .filter((k) => counts[k])
    .map((k) => `<span class="chip${hiddenKinds.has(k) ? " off" : ""}" data-kind="${k}"><span class="sw" style="background:${KIND[k].color}"></span>${KIND[k].label} <span class="n">${counts[k]}</span></span>`)
    .join("");
  legendEl.querySelectorAll("[data-kind]").forEach((el) =>
    el.addEventListener("click", () => {
      const kind = (el as HTMLElement).getAttribute("data-kind") as string;
      if (hiddenKinds.has(kind)) hiddenKinds.delete(kind);
      else hiddenKinds.add(kind);
      el.classList.toggle("off");
      applyVisibility();
    })
  );
}

function updateStatus(): void {
  const c: Record<string, number> = {};
  for (const n of currentGraph.nodes) c[n.kind] = (c[n.kind] ?? 0) + 1;
  const flows = (c.flow ?? 0) + (c.scheduledFlow ?? 0);
  statusEl.textContent =
    `${currentGraph.nodes.length} nodes · ${currentGraph.edges.length} connections` +
    (c.object ? `  ·  ${c.object} objects` : "") +
    (c.trigger ? `  ·  ${c.trigger} triggers` : "") +
    (flows ? `  ·  ${flows} flows` : "") +
    (c.field ? `  ·  ${c.field} fields tracked` : "");
}

// ── Toolbar ─────────────────────────────────────────────────────────────────────
$("build").addEventListener("click", () => { emptyEl.classList.add("spin"); emptyEl.style.display = "flex"; post({ command: "build", org: orgSelect.value }); });
searchInput.addEventListener("input", applyVisibility);
activeOnly.addEventListener("change", applyVisibility);
$("fit").addEventListener("click", () => cy?.fit(undefined, 40));
$("layout").querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    layoutName = (b as HTMLElement).getAttribute("data-l") as string;
    $("layout").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    runLayout();
  })
);
$("exportJson").addEventListener("click", () => post({ command: "export", filename: "process-map.json", content: JSON.stringify(currentGraph, null, 2) }));
$("exportPng").addEventListener("click", () => {
  if (!cy) return;
  post({ command: "export", filename: "process-map.png", content: cy.png({ full: true, output: "base64", bg: getComputedStyle(document.body).backgroundColor }), base64: true });
});
$("copyLlm").addEventListener("click", () => post({ command: "copyLlm" }));

window.addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { command: string; orgs?: OrgOption[]; graph?: ProcessGraph; value?: boolean; text?: string };
  if (d.command === "orgList") {
    orgSelect.innerHTML = (d.orgs ?? []).map((o) => `<option value="${esc(o.username)}">${esc(o.label)}</option>`).join("");
  } else if (d.command === "graph" && d.graph) {
    render(d.graph);
    cy?.fit(undefined, 40);
  } else if (d.command === "loading") {
    if (d.value) { emptyEl.classList.add("spin"); emptyEl.style.display = "flex"; }
  } else if (d.command === "error") {
    emptyEl.classList.remove("spin");
    statusEl.textContent = d.text ?? "Error.";
  }
});

post({ command: "ready" });
