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
  parent?: string;
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
const resultsEl = $("results");
const loadStep = $("loadStep");
const pfill = $("pfill");
const pcount = $("pcount");

function showLoading(on: boolean): void {
  emptyEl.classList.toggle("loading", on);
  emptyEl.classList.toggle("spin", on);
  if (on) {
    emptyEl.style.display = "flex";
    setProgress("Connecting to the org", 0, 0);
  }
}
function setProgress(label: string, completed: number, total: number): void {
  loadStep.textContent = `${label}…`;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 6;
  pfill.style.width = `${pct}%`;
  pcount.textContent = total > 0 ? `${completed} / ${total}` : "";
}

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

// ── Right-click context menu ──────────────────────────────────────────────────────────────────
// Built on the DOM contextmenu event with our own hit-test (reliable inside the webview, where
// cytoscape's cxttap can be swallowed). Left-click never triggers actions — it only selects.
const ctxEl = $("ctxmenu");
let ctxNodeId = "";

function nodeAt(clientX: number, clientY: number): cytoscape.NodeSingular | undefined {
  if (!cy) return undefined;
  const rect = $("cy").getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  let hit: cytoscape.NodeSingular | undefined;
  cy.nodes(":visible").forEach((n: cytoscape.NodeSingular) => {
    const b = n.renderedBoundingBox();
    if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) hit = n;
  });
  return hit;
}

function showContextMenu(clientX: number, clientY: number, id: string): void {
  const node = nodeById.get(id);
  if (!node) return;
  ctxNodeId = id;
  const k = KIND[node.kind] ?? KIND.object;
  ctxEl.innerHTML =
    `<div class="ctx-title"><span class="sw" style="background:${k.color}"></span>${esc(node.label)}</div>` +
    `<div class="ctx-item" data-act="open">↗&nbsp; Open in org</div>` +
    `<div class="ctx-item" data-act="details">ⓘ&nbsp; Details &amp; connections</div>` +
    `<div class="ctx-item" data-act="focus">◎&nbsp; Focus this path</div>` +
    `<div class="ctx-item" data-act="copy">⧉&nbsp; Copy name</div>`;
  ctxEl.classList.add("open");
  // Keep the menu inside the viewport.
  const mw = ctxEl.offsetWidth, mh = ctxEl.offsetHeight;
  ctxEl.style.left = `${Math.min(clientX, window.innerWidth - mw - 8)}px`;
  ctxEl.style.top = `${Math.min(clientY, window.innerHeight - mh - 8)}px`;
  ctxEl.querySelectorAll("[data-act]").forEach((el) =>
    el.addEventListener("click", () => {
      const act = (el as HTMLElement).getAttribute("data-act");
      hideContextMenu();
      if (act === "open") post({ command: "openOrg", nodeId: ctxNodeId });
      else if (act === "details" || act === "focus") select(ctxNodeId);
      else if (act === "copy") post({ command: "copyText", text: node.label });
    })
  );
}
function hideContextMenu(): void { ctxEl.classList.remove("open"); }

$("cy").addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  const hit = nodeAt(e.clientX, e.clientY);
  if (hit) showContextMenu(e.clientX, e.clientY, hit.id());
  else hideContextMenu();
});
// Dismiss the menu on any outside interaction.
document.addEventListener("mousedown", (e: MouseEvent) => { if (!ctxEl.contains(e.target as Node)) hideContextMenu(); });
window.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Escape") hideContextMenu(); });

// Trackpad-modern input (matches the object visualizer): two-finger scroll pans,
// pinch / ⌘|ctrl + wheel zooms toward the cursor. Attached once to the persistent container.
$("cy").addEventListener(
  "wheel",
  (e: WheelEvent) => {
    if (!cy) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.pow(1.01, -e.deltaY);
      const level = Math.min(3, Math.max(0.05, cy.zoom() * factor));
      cy.zoom({ level, renderedPosition: { x: e.offsetX, y: e.offsetY } });
    } else {
      cy.panBy({ x: -e.deltaX, y: -e.deltaY });
    }
  },
  { passive: false }
);

// ── Render ──────────────────────────────────────────────────────────────────────
function render(graph: ProcessGraph): void {
  currentGraph = graph;
  nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  emptyEl.style.display = graph.nodes.length ? "none" : "flex";
  emptyEl.classList.remove("spin");

  const elements: cytoscape.ElementDefinition[] = [
    ...graph.nodes.map((n) => {
      const isHub = n.kind === "phaseHub";
      const k = KIND[n.kind] ?? { color: "#64748b", icon: "", label: n.kind };
      return {
        data: {
          id: n.id,
          label: isHub ? n.label : `${k.icon}  ${n.label}`,
          kind: n.kind,
          object: n.object ?? "",
          color: isHub ? "#94a3b8" : k.color,
          active: n.active === false ? 0 : 1,
          ...(n.parent ? { parent: n.parent } : {})
        }
      };
    }),
    // Star edges (automation→object membership) are implied by the spine. Exclude them entirely —
    // if left in the graph, dagre still uses them for layout and creates object↔automation cycles
    // that scramble the ranks. The inspector reads the full model from currentGraph, not from cy.
    ...graph.edges
      .filter((e) => e.kind !== "runsOn" && e.kind !== "validates")
      .map((e) => ({ data: { id: e.id, source: e.source, target: e.target, kind: e.kind, label: e.label ?? "" } }))
  ];

  if (cy) cy.destroy();
  cy = cytoscape({
    container: $("cy"),
    elements,
    userZoomingEnabled: false, // wheel handled manually: scroll = pan, ⌘/ctrl+wheel = zoom
    minZoom: 0.05,
    maxZoom: 3,
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
      // Phase box: a labelled compound container around the parallel same-phase automations.
      {
        selector: 'node[kind="phaseHub"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#94a3b8",
          "background-opacity": 0.06,
          "border-width": 1.5,
          "border-style": "dashed",
          "border-color": "rgba(148,163,184,0.65)",
          label: "data(label)",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 2,
          color: "rgba(203,213,225,0.95)",
          "font-size": 11,
          "font-style": "italic",
          "font-weight": "bold",
          padding: "16px"
        } as cytoscape.Css.Node
      },
      // Invisible connection port living inside a phase box; the spine attaches here.
      { selector: 'node[kind="phasePort"]', style: { width: 6, height: 6, "background-opacity": 0, "border-width": 0, label: "", events: "no" } as unknown as cytoscape.Css.Node },
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
      // Process spine (the sequence you read): bright, directional, labelled with the phase.
      {
        selector: 'edge[kind="then"]',
        style: {
          width: 2.4,
          "line-color": "#60a5fa",
          "target-arrow-color": "#60a5fa",
          "arrow-scale": 1.1,
          label: "data(label)",
          "font-size": 9,
          color: "rgba(180,200,235,0.9)",
          "text-rotation": "autorotate",
          "text-background-color": "rgba(0,0,0,0.35)",
          "text-background-opacity": 1,
          "text-background-padding": "2px"
        } as cytoscape.Css.Edge
      },
      // Cross-object hop: an automation writes another object → the process continues there.
      { selector: 'edge[kind="triggers"]', style: { width: 2.6, "line-color": "#ec4899", "target-arrow-color": "#ec4899", "line-style": "dashed", "arrow-scale": 1.1 } as cytoscape.Css.Edge },
      { selector: 'edge[kind="schedules"]', style: { "line-color": "#ec4899", "target-arrow-color": "#ec4899" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="invokes"]', style: { "line-style": "dashed", "line-color": "#8b5cf6", "target-arrow-color": "#8b5cf6" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="updates"]', style: { "line-color": "#10b981", "target-arrow-color": "#10b981", width: 1.6, "line-style": "dotted" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="fieldOf"]', style: { "line-color": "rgba(120,120,130,0.22)", "target-arrow-shape": "none", "line-style": "dotted" } as cytoscape.Css.Edge },
      // Scheduled / autolaunched flow ↔ the object it reads/writes: a dotted teal association line.
      { selector: 'edge[kind="operatesOn"]', style: { "line-color": "rgba(13,148,136,0.55)", "target-arrow-color": "rgba(13,148,136,0.65)", "line-style": "dotted", width: 1.8, "arrow-scale": 0.85 } as cytoscape.Css.Edge },
      { selector: ".hidden", style: { display: "none" } as cytoscape.Css.Node },
      { selector: ".faded", style: { opacity: 0.1 } as cytoscape.Css.Node },
      { selector: "edge.hl", style: { width: 2.6, "line-color": themeFg, "target-arrow-color": themeFg, opacity: 1 } as cytoscape.Css.Edge }
    ],
    layout: { name: "grid" } as cytoscape.LayoutOptions
  });

  cy.on("tap", "node", (evt: cytoscape.EventObject) => select(evt.target.id()));
  cy.on("tap", (evt: cytoscape.EventObject) => { if (evt.target === cy) { clearSelection(); closeResults(); } });
  // Any pan/zoom/tap dismisses an open context menu.
  cy.on("tap pan zoom", hideContextMenu);

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
    opts = { name: "dagre", rankDir: "LR", nodeSep: 28, rankSep: 120, animate: true, animationDuration: 450, padding: 40 } as unknown as cytoscape.LayoutOptions;
  }
  const l = cy.layout(opts);
  // Guarantee no overlapping nodes regardless of layout, then re-fit.
  l.one("layoutstop", () => {
    resolveCollisions();
    packDisconnected();
    cy?.fit(undefined, 40);
  });
  l.run();
}

/** Dagre puts every edgeless node at rank 0, so disconnected items (e.g. autolaunched flows with no
 *  object link) pile into one enormous column and blow up the canvas. Tuck them into a tidy grid
 *  just below the connected graph instead. */
function packDisconnected(): void {
  if (!cy) return;
  const loose = cy.nodes(":visible").filter(
    (n: cytoscape.NodeSingular) => !n.isParent() && n.data("kind") !== "phasePort" && n.degree(false) === 0
  );
  if (loose.length < 2) return;
  const connected = cy.nodes(":visible").difference(loose).filter((n: cytoscape.NodeSingular) => n.data("kind") !== "phasePort");
  let startX = 0, startY = 0, width = 900;
  if (connected.nonempty()) {
    const bb = connected.boundingBox();
    startX = bb.x1;
    startY = bb.y2 + 140;
    width = Math.max(700, bb.w);
  }
  const cols = Math.max(1, Math.floor(width / 210));
  const arr = (loose.toArray() as cytoscape.NodeSingular[]).sort((a, b) =>
    String(a.data("label")).localeCompare(String(b.data("label")))
  );
  arr.forEach((n, i) => n.position({ x: startX + (i % cols) * 210, y: startY + Math.floor(i / cols) * 64 }));
}

/** Iteratively separate any overlapping visible nodes (AABB push-apart). Layout-agnostic. */
function resolveCollisions(): void {
  if (!cy) return;
  // Skip when compound phase boxes are present — nudging parents/children would fight the box layout;
  // dagre already spaces those cleanly.
  if (cy.nodes('[kind="phaseHub"]').nonempty()) return;
  const nodes = cy.nodes(":visible").toArray() as cytoscape.NodeSingular[];
  if (nodes.length < 2 || nodes.length > 1600) return; // skip degenerate / very large graphs
  const pad = 12;
  const box = nodes.map((n) => n.boundingBox({}));
  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const aw = box[i].w / 2 + pad / 2;
      const ah = box[i].h / 2 + pad / 2;
      const pa = a.position();
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const bw = box[j].w / 2 + pad / 2;
        const bh = box[j].h / 2 + pad / 2;
        const pb = b.position();
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const ox = aw + bw - Math.abs(dx);
        const oy = ah + bh - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          moved = true;
          if (ox <= oy) {
            const s = (ox / 2) * (dx < 0 ? -1 : 1) || ox / 2;
            a.position("x", pa.x - s);
            b.position("x", pb.x + s);
            pa.x -= s;
          } else {
            const s = (oy / 2) * (dy < 0 ? -1 : 1) || oy / 2;
            a.position("y", pa.y - s);
            b.position("y", pb.y + s);
            pa.y -= s;
          }
        }
      }
    }
    if (!moved) break;
  }
}

/** Swimlane positions: one lane per object, phases left→right by order-of-execution. */
function computeOrderPositions(graph: ProcessGraph): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const objects = graph.nodes.filter((n) => n.kind === "object").map((n) => n.id);
  const objIndex = new Map(objects.map((id, i) => [id, i]));
  const laneH = 200, baseX = 560, colW = 190;
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
    pos[n.id] = { x: baseX + off * colW, y: laneY + (c - 0.5) * 48 };
  }
  const bandY = objects.length * laneH + 140;
  standalone.forEach((n, i) => { pos[n.id] = { x: 160 + (i % 8) * 200, y: bandY + Math.floor(i / 8) * 96 }; });
  return pos;
}

// ── Visibility (legend toggles + active-only). Search is handled separately so matches stay
//    visible and readable instead of everything else disappearing. ────────────────────────────
function applyVisibility(): void {
  if (!cy) return;
  const onlyActive = activeOnly.checked;
  cy.batch(() => {
    cy!.nodes().forEach((n: cytoscape.NodeSingular) => {
      const kind = String(n.data("kind"));
      let show = !hiddenKinds.has(kind);
      if (show && kind !== "object" && onlyActive && n.data("active") === 0) show = false;
      n.toggleClass("hidden", !show);
    });
    cy!.nodes('[kind="object"]').forEach((o: cytoscape.NodeSingular) => {
      let anyVisible = false;
      o.connectedEdges().connectedNodes().forEach((nb: cytoscape.NodeSingular) => {
        if (nb.id() !== o.id() && !nb.hasClass("hidden")) anyVisible = true;
      });
      o.toggleClass("hidden", !anyVisible);
    });
  });
  applySearch(); // re-evaluate matches against the now-visible set
}

// ── Search: highlight matches, fade the rest (keep context), and fly the viewport to the
//    matches so they're centered and readable. Also drives a clickable result list. ──────────
function currentMatches(): cytoscape.NodeCollection {
  const q = searchInput.value.trim().toLowerCase();
  if (!cy || !q) return cy ? cy.collection() : (undefined as unknown as cytoscape.NodeCollection);
  return cy.nodes(":visible").filter(
    (n: cytoscape.NodeSingular) =>
      String(n.data("label")).toLowerCase().includes(q) || String(n.data("object")).toLowerCase().includes(q)
  );
}

function applySearch(): void {
  if (!cy) return;
  const q = searchInput.value.trim().toLowerCase();
  cy.nodes().removeClass("match");
  if (!q) {
    closeResults();
    if (cy.nodes(".sel").empty()) cy.elements().removeClass("faded");
    return;
  }
  const matches = currentMatches();
  cy.elements().addClass("faded");
  matches.closedNeighborhood().removeClass("faded");
  matches.addClass("match");
  if (matches.nonempty()) cy.animate({ fit: { eles: matches, padding: 90 } }, { duration: 320 });
  renderResults(matches);
}

function centerOn(id: string): void {
  if (!cy) return;
  const n = cy.getElementById(id);
  if (n.length) cy.animate({ fit: { eles: n.closedNeighborhood(), padding: 130 } }, { duration: 320 });
}

function renderResults(matches: cytoscape.NodeCollection): void {
  if (!matches || matches.empty()) {
    resultsEl.innerHTML = `<div class="result-more">No matches</div>`;
    resultsEl.classList.add("open");
    return;
  }
  const arr = matches.toArray() as cytoscape.NodeSingular[];
  const shown = arr.slice(0, 60);
  const rows = shown
    .map((nd) => {
      const node = nodeById.get(nd.id());
      const k = KIND[node?.kind ?? "object"] ?? KIND.object;
      return `<div class="result-item" data-goto="${esc(nd.id())}"><span class="sw" style="background:${k.color}"></span><span style="overflow:hidden;text-overflow:ellipsis">${k.icon} ${esc(node?.label ?? nd.id())}</span><span class="rk">${esc(k.label)}</span></div>`;
    })
    .join("");
  resultsEl.innerHTML =
    `<div class="result-head">${arr.length} match${arr.length === 1 ? "" : "es"} — click to navigate</div>` +
    rows +
    (arr.length > shown.length ? `<div class="result-more">+${arr.length - shown.length} more — refine search</div>` : "");
  resultsEl.classList.add("open");
  resultsEl.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).getAttribute("data-goto") as string;
      searchInput.value = "";
      cy?.elements().removeClass("faded match");
      closeResults();
      select(id);
      centerOn(id);
    })
  );
}

function closeResults(): void {
  resultsEl.classList.remove("open");
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
  return `<div class="conn" data-goto="${esc(id)}"><span class="sw" style="background:${k.color}"></span><span class="label">${k.icon} ${esc(n.label)}</span><span class="open" data-open="${esc(id)}" title="Open in org">↗</span></div>`;
}

// Human-readable order-of-execution phase names (keyed by the numeric order in node.meta.order).
const PHASE: Record<string, string> = {
  "1": "Before-save flow",
  "2": "Apex trigger (before & after)",
  "3": "Validation rule",
  "5": "Workflow rule / field update",
  "6": "After-save flow"
};

/** The ordered "what fires when a record changes" timeline for an object. */
function execOrderSection(objectId: string): string {
  const autos = currentGraph.edges
    .filter((e) => e.target === objectId && (e.kind === "runsOn" || e.kind === "validates"))
    .map((e) => nodeById.get(e.source))
    .filter((x): x is ProcessNode => !!x);
  if (!autos.length) return "";
  const ord = (n: ProcessNode) => (n.meta && typeof n.meta.order === "string" ? Number(n.meta.order) : 99);
  autos.sort((a, b) => ord(a) - ord(b) || a.label.localeCompare(b.label));
  const items = autos
    .map((n, i) => {
      const k = KIND[n.kind] ?? KIND.object;
      const phase = PHASE[String(ord(n))] ?? k.label;
      return (
        `<li data-goto="${esc(n.id)}"><span class="step" style="background:${k.color}">${i + 1}</span>` +
        `<span class="et"><span class="nm">${k.icon} ${esc(n.label)}</span><span class="ph">${esc(phase)}</span></span>` +
        `<span class="open" data-open="${esc(n.id)}" title="Open in org">↗</span></li>`
      );
    })
    .join("");
  return `<div class="insp-sec"><h4>Execution order — when a record changes</h4><ol class="execorder">${items}</ol></div>`;
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
  if (n.kind === "phaseHub") {
    const members = currentGraph.nodes.filter((x) => x.parent === id).map((x) => x.id);
    sections.push(`<div class="insp-sec"><h4>Runs in parallel (${members.length})</h4>${members.map(connRow).join("")}</div>`);
  } else if (n.kind === "object") {
    const seq = execOrderSection(id);
    if (seq) sections.push(seq);
    const fields = incoming.filter((e) => e.kind === "fieldOf").map((e) => e.source);
    if (fields.length) sections.push(`<div class="insp-sec"><h4>Fields written (${fields.length})</h4>${fields.map(connRow).join("")}</div>`);
  } else if (n.kind === "field") {
    const setters = incoming.filter((e) => e.kind === "updates").map((e) => e.source);
    sections.push(`<div class="insp-sec"><h4>Set by (${setters.length})</h4>${setters.length ? setters.map(connRow).join("") : '<div class="conn">No automation writes this field</div>'}</div>`);
  } else {
    const runsOn = outgoing.filter((e) => e.kind === "runsOn" || e.kind === "validates").map((e) => e.target);
    const prevSeq = incoming.filter((e) => e.kind === "then").map((e) => e.source);
    const nextSeq = outgoing.filter((e) => e.kind === "then").map((e) => e.target);
    const hops = outgoing.filter((e) => e.kind === "triggers").map((e) => e.target);
    const operates = outgoing.filter((e) => e.kind === "operatesOn").map((e) => e.target);
    const writes = outgoing.filter((e) => e.kind === "updates").map((e) => e.target);
    const invokes = outgoing.filter((e) => e.kind === "invokes" || e.kind === "schedules").map((e) => e.target);
    if (m.order) sections.push(`<div class="insp-sec"><h4>Runs at</h4><div class="conn"><span class="badge" style="background:${k.color};color:#fff">${esc(PHASE[String(m.order)] ?? "step")}</span></div></div>`);
    if (runsOn.length) sections.push(`<div class="insp-sec"><h4>Runs on</h4>${runsOn.map(connRow).join("")}</div>`);
    if (operates.length) sections.push(`<div class="insp-sec"><h4>Operates on</h4>${operates.map(connRow).join("")}</div>`);
    if (prevSeq.length) sections.push(`<div class="insp-sec"><h4>Runs after</h4>${prevSeq.map(connRow).join("")}</div>`);
    if (nextSeq.length) sections.push(`<div class="insp-sec"><h4>Then runs</h4>${nextSeq.map(connRow).join("")}</div>`);
    if (writes.length) sections.push(`<div class="insp-sec"><h4>Writes fields (${writes.length})</h4>${writes.map(connRow).join("")}</div>`);
    if (hops.length) sections.push(`<div class="insp-sec"><h4>Continues into (other objects)</h4>${hops.map(connRow).join("")}</div>`);
    if (invokes.length) sections.push(`<div class="insp-sec"><h4>Calls</h4>${invokes.map(connRow).join("")}</div>`);
  }

  inspInner.innerHTML =
    `<div class="insp-head">
       <div class="insp-ico" style="background:${k.color}">${k.icon}</div>
       <div style="flex:1;min-width:0"><div class="insp-title">${esc(n.label)}</div><div class="insp-kind">${k.label}</div></div>
       <button class="ghost insp-open" id="inspOpen" title="Open this component in the org">Open in org ↗</button>
       <button class="insp-x" id="inspClose">×</button>
     </div>
     <div class="insp-body">${rows.join("") || '<div class="meta-row"><span class="k">No metadata</span></div>'}${sections.join("")}</div>`;
  inspectorEl.classList.add("open");
  (document.getElementById("inspClose") as HTMLElement).onclick = clearSelection;
  (document.getElementById("inspOpen") as HTMLElement).onclick = () => post({ command: "openOrg", nodeId: id });
  inspInner.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", () => select((el as HTMLElement).getAttribute("data-goto") as string))
  );
  inspInner.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      post({ command: "openOrg", nodeId: (el as HTMLElement).getAttribute("data-open") as string });
    })
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
  const nodeCount = currentGraph.nodes.filter((n) => n.kind !== "phaseHub" && n.kind !== "phasePort").length;
  statusEl.textContent =
    `${nodeCount} nodes · ${currentGraph.edges.length} connections` +
    (c.object ? `  ·  ${c.object} objects` : "") +
    (c.trigger ? `  ·  ${c.trigger} triggers` : "") +
    (flows ? `  ·  ${flows} flows` : "") +
    (c.field ? `  ·  ${c.field} fields tracked` : "") +
    (currentGraph.nodes.length ? "     —  follow the blue arrows for execution order · right-click a node to open it in the org" : "");
}

// ── Toolbar ─────────────────────────────────────────────────────────────────────
$("build").addEventListener("click", () => { showLoading(true); post({ command: "build", org: orgSelect.value }); });
searchInput.addEventListener("input", applySearch);
searchInput.addEventListener("focus", () => { if (searchInput.value.trim()) applySearch(); });
searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    applySearch();
    searchInput.blur();
  } else if (e.key === "Enter") {
    // Enter jumps to the single best (first) match.
    const first = (currentMatches().toArray() as cytoscape.NodeSingular[])[0];
    if (first) { searchInput.value = ""; cy?.elements().removeClass("faded match"); closeResults(); select(first.id()); centerOn(first.id()); }
  }
});
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

window.addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as {
    command: string; orgs?: OrgOption[]; graph?: ProcessGraph; value?: boolean; text?: string;
    label?: string; completed?: number; total?: number;
  };
  if (d.command === "orgList") {
    orgSelect.innerHTML = (d.orgs ?? []).map((o) => `<option value="${esc(o.username)}">${esc(o.label)}</option>`).join("");
  } else if (d.command === "graph" && d.graph) {
    showLoading(false);
    render(d.graph);
    cy?.fit(undefined, 40);
  } else if (d.command === "progress") {
    setProgress(d.label ?? "Working", d.completed ?? 0, d.total ?? 0);
  } else if (d.command === "loading") {
    showLoading(!!d.value);
  } else if (d.command === "error") {
    showLoading(false);
    statusEl.textContent = d.text ?? "Error.";
  }
});

post({ command: "ready" });
