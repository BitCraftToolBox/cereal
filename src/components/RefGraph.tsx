/**
 * RefGraph — orthogonal graph of table/object FK relationships.
 * Layout:
 *   - Incoming refs on the LEFT  (nodes that point to center)
 *   - Outgoing refs on the RIGHT (nodes center points to)
 *   - Bidirectional ("both") ABOVE / BELOW, alternating
 */

import {createMemo, createSignal, For, onCleanup, onMount, Show,} from "solid-js";
import * as d3Zoom from "d3-zoom";
import * as d3Selection from "d3-selection";

export interface GraphNode {
    id: string;
    label: string;
    kind: "center" | "outgoing" | "incoming" | "both";
    isSelf?: boolean;
}

export interface GraphEdge {
    source: string;
    target: string;
    label: string;
    isSelf?: boolean;
}

export interface RefGraphProps {
    nodes: GraphNode[];
    edges: GraphEdge[];
    onNavigate: (nodeId: string) => void;
}

interface NodePos {
    x: number;
    y: number;
    kind: GraphNode["kind"];
    label: string;
    isSelf?: boolean;
    id: string;
}

// ── Sizing ────────────────────────────────────────────────────────────────────
const NODE_W = 120;
const NODE_H = 48;
const CENTER_W = 144;
const CENTER_H = 58;
const CORNER_R = 7;

const COL_GAP = 320;
const ROW_GAP = 80;
const BOTH_GAP = 180;
const BOTH_SPACING = 160;

function nodeSize(kind: GraphNode["kind"]) {
    return kind === "center"
        ? {w: CENTER_W, h: CENTER_H}
        : {w: NODE_W, h: NODE_H};
}

const KIND_COLOR: Record<GraphNode["kind"], string> = {
    center: "hsl(var(--color-primary) / 1)",
    outgoing: "hsl(220 70% 60% / 1)",
    incoming: "hsl(280 60% 65% / 1)",
    both: "hsl(160 60% 55% / 1)",
};

const KIND_BORDER: Record<GraphNode["kind"], string> = {
    center: "hsl(var(--color-primary) / 0.8)",
    outgoing: "hsl(220 70% 45% / 0.7)",
    incoming: "hsl(280 55% 50% / 0.7)",
    both: "hsl(160 55% 40% / 0.7)",
};

// ── Layout ────────────────────────────────────────────────────────────────────
const MULTI_COL_THRESHOLD = 16;
/** Gap between overflow columns on the same side (much tighter than COL_GAP) */
const OVERFLOW_COL_GAP = 140;
/** Vertical offset for alternating columns — half a row so nodes interleave evenly. */
const MULTI_COL_VERT_OFFSET = ROW_GAP / 2;

/**
 * Place a group of nodes into one or more columns.
 * When `group.length > MULTI_COL_THRESHOLD` the nodes are distributed evenly
 * across the minimum number of columns needed, so each column has roughly the
 * same height.  Each extra column is shifted `OVERFLOW_COL_GAP` px outward and
 * `MULTI_COL_VERT_OFFSET` px downward so adjacent columns are clearly distinct.
 *
 * @param group   nodes to place
 * @param baseX   x-center of the first column
 * @param cy      vertical center of the whole layout
 * @param dir     +1 = right side (outgoing), -1 = left side (incoming)
 * @param pos     output map
 */
function placeColumn(
    group: GraphNode[],
    baseX: number,
    cy: number,
    dir: 1 | -1,
    pos: Map<string, { x: number; y: number }>,
) {
    if (group.length === 0) return;
    const numCols = Math.ceil(group.length / MULTI_COL_THRESHOLD);
    // Distribute evenly: ceil so earlier columns get one extra node if uneven.
    const perCol = Math.ceil(group.length / numCols);
    for (let c = 0; c < numCols; c++) {
        const slice = group.slice(c * perCol, (c + 1) * perCol);
        const x = baseX + dir * c * OVERFLOW_COL_GAP;
        const colOffset = (c % 2) * MULTI_COL_VERT_OFFSET;
        const totalH = (slice.length - 1) * ROW_GAP;
        slice.forEach((n, i) => {
            pos.set(n.id, {x, y: cy + colOffset - totalH / 2 + i * ROW_GAP});
        });
    }
}

function computeLayout(nodes: GraphNode[], w: number, h: number): Map<string, { x: number; y: number }> {
    const cx = w / 2, cy = h / 2;
    const pos = new Map<string, { x: number; y: number }>();

    const center = nodes.find(n => n.kind === "center");
    const incoming = nodes.filter(n => n.kind === "incoming");
    const outgoing = nodes.filter(n => n.kind === "outgoing");
    const both = nodes.filter(n => n.kind === "both");

    if (center) pos.set(center.id, {x: cx, y: cy});

    // Place incoming columns to the left of center, expanding further left.
    placeColumn(incoming, cx - COL_GAP, cy, -1, pos);
    // Place outgoing columns to the right of center, expanding further right.
    placeColumn(outgoing, cx + COL_GAP, cy, 1, pos);

    const below = both.filter((_, i) => i % 2 === 0);
    const above = both.filter((_, i) => i % 2 !== 0);
    const row = (group: GraphNode[], y: number) => {
        const totalW = (group.length - 1) * BOTH_SPACING;
        group.forEach((n, i) => pos.set(n.id, {x: cx - totalW / 2 + i * BOTH_SPACING, y}));
    };
    if (above.length) row(above, cy - BOTH_GAP);
    if (below.length) row(below, cy + BOTH_GAP);

    return pos;
}

// ── Edge routing ──────────────────────────────────────────────────────────────
/**
 * Orthogonal path with kind-aware exit direction.
 * - left/right column nodes (incoming/outgoing) always exit/enter horizontally.
 * - above/below nodes (both) always exit/enter vertically.
 * `offset` shifts the path perpendicularly to separate bidirectional pairs.
 */
function routedPath(
    sx: number, sy: number, srcKind: GraphNode["kind"],
    tx: number, ty: number, tgtKind: GraphNode["kind"],
    offset = 0,
): string {
    const {w: sw, h: sh} = nodeSize(srcKind);
    const {w: tw, h: th} = nodeSize(tgtKind);
    const dx = tx - sx, dy = ty - sy;

    // Force horizontal-first when either side is a left/right column node.
    // Force vertical-first when both sides are top/bottom nodes.
    const preferHoriz =
        srcKind === "incoming" || srcKind === "outgoing" ||
        tgtKind === "incoming" || tgtKind === "outgoing" ||
        (srcKind === "center" && tgtKind !== "both") ||
        (tgtKind === "center" && srcKind !== "both");

    const useHoriz = preferHoriz || Math.abs(dx) >= Math.abs(dy);

    if (useHoriz) {
        const signX = dx >= 0 ? 1 : -1;
        const x1 = sx + signX * sw / 2;
        const x2 = tx - signX * tw / 2;
        const y1 = sy + offset;
        const y2 = ty + offset;
        if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} H ${x2}`;
        const midX = (x1 + x2) / 2;
        return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
    } else {
        const signY = dy >= 0 ? 1 : -1;
        const y1 = sy + signY * sh / 2;
        const y2 = ty - signY * th / 2;
        const x1 = sx + offset;
        const x2 = tx + offset;
        if (Math.abs(x2 - x1) < 1) return `M ${x1} ${y1} V ${y2}`;
        const midY = (y1 + y2) / 2;
        return `M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`;
    }
}

function pathMidpoint(d: string): { x: number; y: number } {
    const tokens = d.replace(/([MHV])/g, " $1 ").trim().split(/\s+/).filter(Boolean);
    const pts: { x: number; y: number }[] = [];
    let cx = 0, cy = 0, i = 0;
    while (i < tokens.length) {
        const cmd = tokens[i++];
        if (cmd === "M") {
            cx = +tokens[i++];
            cy = +tokens[i++];
            pts.push({x: cx, y: cy});
        } else if (cmd === "H") {
            cx = +tokens[i++];
            pts.push({x: cx, y: cy});
        } else if (cmd === "V") {
            cy = +tokens[i++];
            pts.push({x: cx, y: cy});
        }
    }
    if (!pts.length) return {x: 0, y: 0};
    const mid = (pts.length - 1) / 2;
    const lo = Math.floor(mid), hi = Math.ceil(mid);
    return {x: (pts[lo].x + pts[hi].x) / 2, y: (pts[lo].y + pts[hi].y) / 2};
}

// ── Label splitting ───────────────────────────────────────────────────────────
function splitLabel(label: string, kind: GraphNode["kind"]): string[] {
    const w = kind === "center" ? CENTER_W : NODE_W;
    const maxChars = Math.max(6, Math.floor(w / 7.2));
    if (label.length <= maxChars) return [label];
    const words = label.split(/[ _]+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
        const seg = cur ? `${cur} ${w}` : w;
        if (seg.length > maxChars && cur) {
            lines.push(cur);
            cur = w;
        } else cur = seg;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 4);
}

function arrowMarkerId(kind: GraphNode["kind"]) {
    return `arrow-ortho-${kind}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function RefGraph(props: RefGraphProps) {
    let svgRef!: SVGSVGElement;
    let containerRef!: HTMLDivElement;

    const [dims, setDims] = createSignal({w: 800, h: 600});
    const [transformStr, setTransformStr] = createSignal("translate(0,0) scale(1)");
    const [hoveredEdge, setHoveredEdge] = createSignal<number | null>(null);
    const [hoveredNode, setHoveredNode] = createSignal<string | null>(null);

    const nodePositions = createMemo((): Map<string, NodePos> => {
        const {w, h} = dims();
        const layout = computeLayout(props.nodes, w, h);
        const result = new Map<string, NodePos>();
        for (const n of props.nodes) {
            const p = layout.get(n.id) ?? {x: w / 2, y: h / 2};
            result.set(n.id, {...p, kind: n.kind, label: n.label, isSelf: n.isSelf, id: n.id});
        }
        return result;
    });

    const edgeData = createMemo(() => {
        const positions = nodePositions();
        const reverseSet = new Set(
            props.edges.filter(e => !e.isSelf).map(e => `${e.target}|${e.source}`)
        );
        return props.edges
            .filter(e => !e.isSelf)
            .map((e, i) => {
                const src = positions.get(e.source);
                const tgt = positions.get(e.target);
                if (!src || !tgt) return null;
                const offset = reverseSet.has(`${e.source}|${e.target}`) ? 6 : 0;
                const d = routedPath(src.x, src.y, src.kind, tgt.x, tgt.y, tgt.kind, offset);
                return {i, d, label: e.label, targetKind: tgt.kind};
            })
            .filter(Boolean) as { i: number; d: string; label: string; targetKind: GraphNode["kind"] }[];
    });

    const selfEdges = createMemo(() => {
        const positions = nodePositions();
        return props.edges.filter(e => e.isSelf).flatMap(e => {
            const p = positions.get(e.source);
            return p ? [{...e, x: p.x, y: p.y}] : [];
        });
    });

    // ── Zoom / pan ────────────────────────────────────────────────────────────
    onMount(() => {
        const ro = new ResizeObserver(entries => {
            for (const en of entries) {
                const {width, height} = en.contentRect;
                setDims({w: width, h: height});
            }
        });
        ro.observe(containerRef);
        onCleanup(() => ro.disconnect());

        const svg = d3Selection.select(svgRef);
        const zoom = d3Zoom.zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.15, 5])
            .on("zoom", event => setTransformStr(event.transform.toString()));

        svg.call(zoom as any);
        onCleanup(() => svg.on(".zoom", null));
    });

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div
            ref={containerRef!}
            class="relative flex flex-col flex-1 min-h-0 rounded-lg border border-border bg-surface-0 overflow-hidden"
        >
            <div
                class="absolute top-3 left-3 z-10 flex flex-col gap-1 bg-surface-1/90 border border-border rounded-md px-3 py-2 text-xs text-text-muted pointer-events-none select-none">
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${KIND_COLOR.center}`}/>
                    center
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${KIND_COLOR.incoming}`}/>
                    incoming ←
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${KIND_COLOR.outgoing}`}/>
                    outgoing →
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${KIND_COLOR.both}`}/>
                    both ↕
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 flex items-center justify-center text-[10px]">🔁</span>
                    self-ref
                </div>
            </div>
            <div class="absolute bottom-3 right-3 z-10 text-xs text-text-muted/60 pointer-events-none select-none">
                scroll to zoom · drag to pan · click to navigate
            </div>

            <svg
                ref={svgRef!}
                width="100%" height="100%"
                style="display:block;flex:1;min-height:0"
            >
                <defs>
                    <For each={["center", "outgoing", "incoming", "both"] as GraphNode["kind"][]}>
                        {(kind) => (
                            <marker id={arrowMarkerId(kind)} viewBox="0 -5 10 10" refX={10} refY={0} markerWidth={6}
                                    markerHeight={6} orient="auto">
                                <path d="M0,-5L10,0L0,5" fill={KIND_COLOR[kind]}/>
                            </marker>
                        )}
                    </For>
                </defs>

                <g transform={transformStr()}>
                    {/* Layer 1: edges */}
                    <For each={edgeData()}>
                        {(edge) => {
                            const isHov = () => hoveredEdge() === edge.i;
                            return (
                                <g>
                                    <path d={edge.d} fill="none"
                                          stroke={isHov() ? KIND_COLOR[edge.targetKind] : "hsl(var(--color-border) / 0.6)"}
                                          stroke-width={isHov() ? 2 : 1.5}
                                          marker-end={`url(#${arrowMarkerId(edge.targetKind)})`}
                                          style="pointer-events:none"/>
                                    <path d={edge.d} fill="none" stroke="transparent" stroke-width={14}
                                          onMouseEnter={() => setHoveredEdge(edge.i)}
                                          onMouseLeave={() => setHoveredEdge(null)}
                                          style="cursor:default"/>
                                </g>
                            );
                        }}
                    </For>

                    {/* Self-loop arcs */}
                    <For each={selfEdges()}>
                        {(e) => {
                            const hw = CENTER_W / 2;
                            const hh = CENTER_H / 2;
                            return (
                                <g>
                                    <path
                                        d={`M ${e.x - hw * 0.5} ${e.y - hh} C ${e.x - hw * 1.8} ${e.y - hh * 3}, ${e.x + hw * 1.8} ${e.y - hh * 3}, ${e.x + hw * 0.5} ${e.y - hh}`}
                                        fill="none" stroke="hsl(var(--color-primary) / 0.5)"
                                        stroke-width={1.5} stroke-dasharray="4,3" style="pointer-events:none"/>
                                    <text x={e.x} y={e.y - hh * 3.3} text-anchor="middle" font-size="10"
                                          fill="hsl(var(--color-primary) / 0.7)"
                                          style="pointer-events:none;font-family:monospace">
                                        🔁 {e.label}
                                    </text>
                                </g>
                            );
                        }}
                    </For>

                    {/* Layer 2: nodes */}
                    <For each={[...nodePositions().entries()]}>
                        {([id, pos]) => {
                            const isHov = () => hoveredNode() === id;
                            const isCenter = pos.kind === "center";
                            const {w, h} = nodeSize(pos.kind);
                            const lines = splitLabel(pos.label, pos.kind);
                            const lineH = 14;
                            const totalTextH = lines.length * lineH;
                            return (
                                <g
                                    class="graph-node"
                                    transform={`translate(${pos.x},${pos.y})`}
                                    style={`cursor:${isCenter ? "default" : "pointer"}`}
                                    onMouseEnter={() => setHoveredNode(id)}
                                    onMouseLeave={() => setHoveredNode(null)}
                                    onClick={() => {
                                        if (!isCenter) props.onNavigate(id);
                                    }}
                                >
                                    <title>{pos.id}</title>
                                    <rect
                                        x={-w / 2} y={-h / 2} width={w} height={h} rx={CORNER_R}
                                        fill={`${KIND_COLOR[pos.kind]}${isHov() ? "cc" : "88"}`}
                                        stroke={KIND_BORDER[pos.kind]}
                                        stroke-width={isHov() ? 2.5 : isCenter ? 2 : 1.5}
                                    />
                                    <Show when={pos.isSelf}>
                                        <text y={-h / 2 - 6} text-anchor="middle" font-size="12"
                                              style="pointer-events:none">🔁
                                        </text>
                                    </Show>
                                    <text
                                        text-anchor="middle"
                                        font-size={isCenter ? "13" : "11"}
                                        font-weight={isCenter ? "bold" : "normal"}
                                        fill="hsl(var(--color-text) / 1)"
                                        style="pointer-events:none;font-family:monospace"
                                    >
                                        <For each={lines}>
                                            {(line, i) => (
                                                <tspan
                                                    x={0}
                                                    y={-totalTextH / 2 + i() * lineH + lineH * 0.75}
                                                >
                                                    {line}
                                                </tspan>
                                            )}
                                        </For>
                                    </text>
                                </g>
                            );
                        }}
                    </For>

                    {/* Layer 3: edge labels on top */}
                    <For each={edgeData()}>
                        {(edge) => {
                            const isHov = () => hoveredEdge() === edge.i;
                            const mid = () => pathMidpoint(edge.d);
                            const bw = () => edge.label.length * 6.2 + 12;
                            const bh = 20;
                            return (
                                <Show when={isHov()}>
                                    <g style="pointer-events:none">
                                        <rect
                                            x={mid().x - bw() / 2} y={mid().y - bh / 2}
                                            width={bw()} height={bh} rx={3}
                                            fill="hsl(var(--color-surface-1) / 0.97)"
                                            stroke="hsl(var(--color-border) / 0.7)" stroke-width={0.5}
                                        />
                                        <text x={mid().x} y={mid().y} text-anchor="middle"
                                              dominant-baseline="middle" font-size="10"
                                              fill="hsl(var(--color-text-muted) / 1)"
                                              style="font-family:monospace">
                                            {edge.label}
                                        </text>
                                    </g>
                                </Show>
                            );
                        }}
                    </For>
                </g>
            </svg>
        </div>
    );
}
