import cytoscape = require("cytoscape");
import dagre = require("cytoscape-dagre");
import svg = require("cytoscape-svg");
import { ObjectSelection } from "./objectSelection";

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
const pickBtn = $("pick");
const pickModal = $("pickModal");
const pickSearch = $("pickSearch") as HTMLInputElement;
const pickList = $("pickList");
const pickCount = $("pickCount");

// Object selection (seeds) — like the Object Visualizer, you choose objects, then build.
const selection = new ObjectSelection();

function updatePickLabel(): void {
  const n = selection.size;
  pickBtn.textContent = n ? `◈ Objects: ${n}` : "◈ Objects: none";
}
function renderPickList(): void {
  const { shown, hidden } = selection.visible(pickSearch.value);
  pickList.innerHTML = shown
    .map(
      (o) =>
        `<label class="pick-item"><input type="checkbox" value="${esc(o.name)}"${selection.has(o.name) ? " checked" : ""}/> ${esc(o.name)}${o.custom ? '<span class="cust">custom</span>' : ""}</label>`
    )
    .join("");
  updatePickCount(hidden);
}
function updatePickCount(hidden = 0): void {
  pickCount.textContent = `${selection.size} selected` + (hidden ? ` · ${hidden} more — refine search` : "");
}
// One delegated listener (not one per checkbox per keystroke) for the whole picker list.
pickList.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.type !== "checkbox") return;
  selection.set(t.value, t.checked);
  updatePickCount();
});
function openPicker(): void {
  selection.beginEdit();
  pickModal.classList.add("open");
  renderPickList();
  pickSearch.focus();
}
function closePicker(): void { pickModal.classList.remove("open"); }
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
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    hideContextMenu();
    if (pickModal.classList.contains("open")) closePicker();
  }
});

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
          ...(n.parent ? { parent: n.parent } : {}),
          ...(n.kind === "phasePort" ? { w: Number(n.meta?.w) || 6, h: Number(n.meta?.h) || 6 } : {})
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
      // Invisible port that reserves the phase box's slot in the layout; the spine attaches here.
      { selector: 'node[kind="phasePort"]', style: { width: "data(w)", height: "data(h)", "background-opacity": 0, "border-width": 0, label: "", events: "no" } as unknown as cytoscape.Css.Node },
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
      // Apex call chain: trigger/class → class. Solid purple with an arrow so the chain reads clearly.
      { selector: 'edge[kind="calls"]', style: { "line-color": "#a78bfa", "target-arrow-color": "#a78bfa", width: 1.8, "arrow-scale": 1, "curve-style": "bezier" } as cytoscape.Css.Edge },
      { selector: 'edge[kind="updates"]', style: { "line-color": "#10b981", "target-arrow-color": "#10b981", width: 1.6, "line-style": "dotted" } as cytoscape.Css.Edge },
      // Apex references a field (read/write unknown) — faint grey.
      { selector: 'edge[kind="references"]', style: { "line-color": "rgba(120,120,130,0.3)", "target-arrow-color": "rgba(120,120,130,0.35)", width: 1, "line-style": "dashed", "arrow-scale": 0.7 } as cytoscape.Css.Edge },
      // Scheduled / autolaunched flow ↔ the object it reads/writes: a dotted teal association line.
      { selector: 'edge[kind="operatesOn"]', style: { "line-color": "rgba(13,148,136,0.55)", "target-arrow-color": "rgba(13,148,136,0.65)", "line-style": "dotted", width: 1.8, "arrow-scale": 0.85 } as cytoscape.Css.Edge },
      // Object → an Apex class that writes it but isn't reached by a call (anchors it to the right).
      { selector: 'edge[kind="processedBy"]', style: { "line-color": "rgba(167,139,250,0.5)", "target-arrow-color": "rgba(167,139,250,0.6)", "line-style": "dotted", width: 1.4, "arrow-scale": 0.8 } as cytoscape.Css.Edge },
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

  applyVisibility(); // apply default filters (fields hidden) BEFORE layout so hidden nodes reserve no space
  runLayout();
  buildLegend();
  updateStatus();
}

/** A filter changed (legend toggle / active-only) → re-hide, then reflow the visible nodes. */
function filterAndRelayout(): void {
  applyVisibility();
  runLayout();
}

// ── Layout ────────────────────────────────────────────────────────────────────
function runLayout(): void {
  if (!cy) return;
  // Lay out only the VISIBLE elements so filtered-out nodes leave no gaps — the space reflows.
  const vis = cy.elements(":visible");
  const opts: cytoscape.LayoutOptions =
    layoutName === "cose"
      ? ({ name: "cose", eles: vis, animate: true, animationDuration: 500, nodeRepulsion: () => 12000, idealEdgeLength: () => 90, padding: 40 } as unknown as cytoscape.LayoutOptions)
      : ({ name: "dagre", eles: vis, rankDir: "LR", nodeSep: 28, rankSep: 120, animate: true, animationDuration: 450, padding: 40 } as unknown as cytoscape.LayoutOptions);
  const l = cy.layout(opts);
  // Guarantee no overlapping nodes regardless of layout, then re-fit.
  l.one("layoutstop", () => {
    assignPhaseBoxes();
    hideEmptyBoxes(); // fields are hidden by default → hide their (now-parented) boxes too
    resolveCollisions();
    packDisconnected();
    cy?.fit(undefined, 40);
  });
  l.run();
}

/** After the ports are laid out, drop each phase box's items into the box and grid them around the
 *  port. Items are kept OUT of dagre (only the pre-sized port participates), so the box never stretches
 *  to enclose scattered nodes — it ends up exactly around its own gridded members. */
function assignPhaseBoxes(): void {
  if (!cy) return;
  const byBox = new Map<string, string[]>();
  for (const n of currentGraph.nodes) {
    const boxId = n.meta && typeof n.meta.box === "string" ? n.meta.box : "";
    if (boxId) (byBox.get(boxId) ?? byBox.set(boxId, []).get(boxId)!).push(n.id);
  }
  byBox.forEach((ids, boxId) => {
    const box = cy!.getElementById(boxId);
    const port = box.children('[kind="phasePort"]').first(); // read the structural child, not a re-derived id
    const center = port.nonempty() ? port.position() : box.position();
    const items = ids.map((id) => cy!.getElementById(id)).filter((el) => el.nonempty());
    const n = items.length;
    const cols = Math.max(1, Math.round(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const colW = 215, rowH = 44;
    const totalW = (cols - 1) * colW, totalH = (rows - 1) * rowH;
    items.forEach((el, i) => {
      el.move({ parent: boxId });
      const col = i % cols, row = Math.floor(i / cols);
      el.position({ x: center.x - totalW / 2 + col * colW, y: center.y - totalH / 2 + row * rowH });
    });
  });
}

/** Dagre puts every edgeless node at rank 0, so disconnected items (e.g. autolaunched flows with no
 *  object link) pile into one enormous column and blow up the canvas. Tuck them into a tidy grid
 *  just below the connected graph instead. */
function packDisconnected(): void {
  if (!cy) return;
  const loose = cy.nodes(":visible").filter(
    (n: cytoscape.NodeSingular) => !n.isParent() && !n.isChild() && n.data("kind") !== "phasePort" && n.degree(false) === 0
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

// ── Visibility (legend toggles + active-only). Search is handled separately so matches stay
//    visible and readable instead of everything else disappearing. ────────────────────────────
function applyVisibility(): void {
  if (!cy) return;
  const onlyActive = activeOnly.checked;
  cy.batch(() => {
    cy!.nodes().forEach((n: cytoscape.NodeSingular) => {
      const kind = String(n.data("kind"));
      if (kind === "phaseHub" || kind === "phasePort") return; // phase boxes handled by hideEmptyBoxes
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
    hideEmptyBoxes(); // hide emptied boxes BEFORE layout so :visible excludes them (no reserved gap)
  });
  applySearch(); // re-evaluate matches against the now-visible set
}

/** A phase box is hidden when all its member items are hidden. Skips field boxes (toggle-driven)
 *  and boxes whose children aren't parented yet (pre-layout) so the spine isn't broken. */
function hideEmptyBoxes(): void {
  if (!cy) return;
  cy.nodes('[kind="phaseHub"]').forEach((box: cytoscape.NodeSingular) => {
    const items = box.children().filter((c: cytoscape.NodeSingular) => c.data("kind") !== "phasePort");
    if (items.length === 0) return; // not parented yet → leave it in the layout
    let anyChild = false;
    items.forEach((c: cytoscape.NodeSingular) => { if (!c.hasClass("hidden")) anyChild = true; });
    box.toggleClass("hidden", !anyChild);
  });
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

/** One inspector section — "Title (count)" + a connection row per id. Empty string when there are none. */
function sec(title: string, ids: string[], suffix = ""): string {
  return ids.length ? `<div class="insp-sec"><h4>${esc(title)} (${ids.length})${esc(suffix)}</h4>${ids.map(connRow).join("")}</div>` : "";
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
    const members = currentGraph.nodes.filter((x) => x.meta?.box === id).map((x) => x.id);
    sections.push(sec("Runs in parallel", members));
  } else if (n.kind === "object") {
    const seq = execOrderSection(id);
    if (seq) sections.push(seq);
    sections.push(sec("Fields changed", currentGraph.nodes.filter((f) => f.kind === "field" && f.object === n.label).map((f) => f.id)));
    sections.push(sec("Processed by (Apex)", outgoing.filter((e) => e.kind === "processedBy").map((e) => e.target)));
  } else if (n.kind === "field") {
    const setters = incoming.filter((e) => e.kind === "updates").map((e) => e.source);
    sections.push(`<div class="insp-sec"><h4>Set by (${setters.length})</h4>${setters.length ? setters.map(connRow).join("") : '<div class="conn">No automation writes this field</div>'}</div>`);
    sections.push(sec("Referenced by", incoming.filter((e) => e.kind === "references").map((e) => e.source), " — read/write unknown"));
  } else {
    const out = (kind: string) => outgoing.filter((e) => e.kind === kind).map((e) => e.target);
    const inc = (kind: string) => incoming.filter((e) => e.kind === kind).map((e) => e.source);
    if (m.order) sections.push(`<div class="insp-sec"><h4>Runs at</h4><div class="conn"><span class="badge" style="background:${k.color};color:#fff">${esc(PHASE[String(m.order)] ?? "step")}</span></div></div>`);
    sections.push(sec("Runs on", outgoing.filter((e) => e.kind === "runsOn" || e.kind === "validates").map((e) => e.target)));
    sections.push(sec("Operates on", out("operatesOn")));
    sections.push(sec("Called by", inc("calls")));
    sections.push(sec("Runs after", inc("then")));
    sections.push(sec("Then runs", out("then")));
    sections.push(sec("Calls Apex", out("calls")));
    sections.push(sec("Sets fields", out("updates")));
    sections.push(sec("Continues into (other objects)", out("triggers")));
    sections.push(sec("Invokes / schedules", outgoing.filter((e) => e.kind === "invokes" || e.kind === "schedules").map((e) => e.target)));
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
      filterAndRelayout(); // reflow so hidden kinds leave no gaps
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
$("build").addEventListener("click", () => {
  const seeds = selection.values();
  if (!seeds.length) { statusEl.textContent = "Pick at least one object first (use the “Objects” button)."; return; }
  showLoading(true);
  post({ command: "build", org: orgSelect.value, seeds });
});
// Object picker
pickBtn.addEventListener("click", openPicker);
pickSearch.addEventListener("input", renderPickList);
$("pickApply").addEventListener("click", () => { closePicker(); updatePickLabel(); });
$("pickClear").addEventListener("click", () => { selection.clear(); renderPickList(); });
const cancelPick = () => { selection.cancelEdit(); closePicker(); updatePickLabel(); };
$("pickCancel").addEventListener("click", cancelPick);
pickModal.addEventListener("click", (e: MouseEvent) => { if (e.target === pickModal) cancelPick(); });
orgSelect.addEventListener("change", () => {
  selection.clear();
  selection.setItems([]);
  updatePickLabel();
  post({ command: "objectList", org: orgSelect.value });
});
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
activeOnly.addEventListener("change", filterAndRelayout);
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
    label?: string; completed?: number; total?: number; objects?: string[];
  };
  if (d.command === "orgList") {
    orgSelect.innerHTML = (d.orgs ?? []).map((o) => `<option value="${esc(o.username)}">${esc(o.label)}</option>`).join("");
    post({ command: "objectList", org: orgSelect.value }); // preload objects for the picker
  } else if (d.command === "objectList") {
    selection.setItems(d.objects ?? []);
    if (pickModal.classList.contains("open")) renderPickList();
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
