/**
 * NetworkGraph — force-directed graph of all static tables and their FK relationships.
 */

import {createMemo, createSignal, For, onCleanup, onMount, Show,} from "solid-js";
import * as d3Zoom from "d3-zoom";
import * as d3Selection from "d3-selection";
import * as d3Force from "d3-force";

export interface NetworkNode {
    id: string;
    label: string;
    isPublic: boolean;
}

export interface NetworkEdge {
    source: string;
    target: string;
    /** number of FK mappings between these two tables (edge weight) */
    weight: number;
}

export interface NetworkGraphProps {
    nodes: NetworkNode[];
    edges: NetworkEdge[];
    onNavigate: (tableId: string) => void;
}

// ── Sizing ────────────────────────────────────────────────────────────────────
const NODE_W = 110;
const NODE_H = 36;
const CORNER_R = 5;

const PUBLIC_COLOR = "hsl(220 65% 60%)";
const PUBLIC_BORDER = "hsl(220 65% 45% / 0.8)";
const HIDDEN_COLOR = "hsl(260 40% 55%)";
const HIDDEN_BORDER = "hsl(260 40% 40% / 0.8)";
const EDGE_COLOR = "color-mix(in srgb, var(--color-border) 50%, transparent)";
const EDGE_HOV = "hsl(220 65% 60% / 0.9)";

function nodeColor(n: NetworkNode, hov: boolean) {
    const base = n.isPublic ? PUBLIC_COLOR : HIDDEN_COLOR;
    return `color-mix(in srgb, ${base} ${hov ? 95 : 75}%, transparent)`;
}

function nodeBorder(n: NetworkNode) {
    return n.isPublic ? PUBLIC_BORDER : HIDDEN_BORDER;
}

function splitLabel(label: string): string[] {
    const maxChars = Math.max(6, Math.floor(NODE_W / 7.2));
    if (label.length <= maxChars) return [label];
    const words = label.split(/[ _]+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
        const seg = cur ? `${cur}_${w}` : w;
        if (seg.length > maxChars && cur) {
            lines.push(cur);
            cur = w;
        } else cur = seg;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
}

// ── Force simulation ──────────────────────────────────────────────────────────
interface SimNode extends d3Force.SimulationNodeDatum {
    id: string;
}

interface SimLink extends d3Force.SimulationLinkDatum<SimNode> {
    weight: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function NetworkGraph(props: NetworkGraphProps) {
    let svgRef!: SVGSVGElement;
    let containerRef!: HTMLDivElement;

    const [dims, setDims] = createSignal({w: 800, h: 600});
    const [transformStr, setTransformStr] = createSignal("translate(0,0) scale(1)");
    const [hoveredNode, setHoveredNode] = createSignal<string | null>(null);
    const [hoveredEdge, setHoveredEdge] = createSignal<string | null>(null);

    // Computed node positions from simulation (reactive via tick counter)
    const [positions, setPositions] = createSignal<Map<string, { x: number; y: number }>>(new Map());

    // Re-run simulation when nodes/edges change
    const simKey = createMemo(() => `${props.nodes.length}:${props.edges.length}`);

    let stopSim: (() => void) | null = null;

    function buildSim(w: number, h: number) {
        const simNodes: SimNode[] = props.nodes.map(n => ({
            id: n.id,
            x: w / 2 + (Math.random() - 0.5) * w * 0.5,
            y: h / 2 + (Math.random() - 0.5) * h * 0.5,
        }));

        const idToNode = new Map(simNodes.map(n => [n.id, n]));

        const simLinks: SimLink[] = props.edges
            .filter(e => e.source !== e.target)
            .flatMap(e => {
                const s = idToNode.get(e.source);
                const t = idToNode.get(e.target);
                return s && t ? [{source: s, target: t, weight: e.weight}] : [];
            });

        const simulation = d3Force.forceSimulation<SimNode>(simNodes)
            .force("link", d3Force.forceLink<SimNode, SimLink>(simLinks)
                .id(n => n.id)
                .distance(d => Math.max(160, 220 - (d as SimLink).weight * 10))
                .strength(0.4))
            .force("charge", d3Force.forceManyBody().strength(-300))
            .force("center", d3Force.forceCenter(w / 2, h / 2))
            .force("collision", d3Force.forceCollide(Math.max(NODE_W, NODE_H) * 0.85))
            .alphaDecay(0.03)
            .stop();

        return {simulation, simNodes};
    }

    function snapshotPositions(simNodes: SimNode[]) {
        const map = new Map<string, { x: number; y: number }>();
        for (const n of simNodes) map.set(n.id, {x: n.x ?? 0, y: n.y ?? 0});
        return map;
    }

    function runSim(w: number, h: number) {
        stopSim?.();
        const {simulation, simNodes} = buildSim(w, h);
        const n = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
        for (let i = 0; i < n; i++) simulation.tick();
        setPositions(snapshotPositions(simNodes));
        stopSim = null;
    }

    onMount(() => {
        const ro = new ResizeObserver(entries => {
            for (const en of entries) {
                const {width, height} = en.contentRect;
                setDims({w: width, h: height});
            }
        });
        ro.observe(containerRef);
        onCleanup(() => ro.disconnect());
        onCleanup(() => stopSim?.());

        const svg = d3Selection.select(svgRef);
        const zoom = d3Zoom.zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.05, 5])
            .on("zoom", event => setTransformStr(event.transform.toString()));
        svg.call(zoom as any);
        onCleanup(() => svg.on(".zoom", null));
    });

    // Restart sim when dims or data change
    createMemo(() => {
        const {w, h} = dims();
        simKey(); // track
        runSim(w, h);
    });

    const edgeKey = (e: NetworkEdge) => `${e.source}|${e.target}`;

    return (
        <div
            ref={containerRef!}
            class="relative flex flex-col flex-1 min-h-0 rounded-lg border border-border bg-surface-0 overflow-hidden"
        >
            {/* Legend */}
            <div
                class="absolute top-3 left-3 z-10 flex flex-col gap-1 bg-surface-1/90 border border-border rounded-md px-3 py-2 text-xs text-text-muted pointer-events-none select-none">
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${PUBLIC_COLOR}`}/>
                    public table
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-3 h-3 rounded-sm" style={`background:${HIDDEN_COLOR}`}/>
                    hidden table
                </div>
            </div>


            <div class="absolute bottom-3 right-3 z-10 text-xs text-text-muted/60 pointer-events-none select-none">
                scroll to zoom · drag to pan · click to navigate
            </div>

            <svg ref={svgRef!} width="100%" height="100%" style="display:block;flex:1;min-height:0">
                <defs>
                    <marker id="net-arrow" viewBox="0 -5 10 10" refX={10} refY={0} markerWidth={5} markerHeight={5}
                            orient="auto">
                        <path d="M0,-5L10,0L0,5" fill={EDGE_COLOR}/>
                    </marker>
                    <marker id="net-arrow-hov" viewBox="0 -5 10 10" refX={10} refY={0} markerWidth={5} markerHeight={5}
                            orient="auto">
                        <path d="M0,-5L10,0L0,5" fill={EDGE_HOV}/>
                    </marker>
                </defs>

                <g transform={transformStr()}>
                    {/* Edges */}
                    <For each={props.edges.filter(e => e.source !== e.target)}>
                        {(edge) => {
                            const src = () => positions().get(edge.source);
                            const tgt = () => positions().get(edge.target);
                            const key = edgeKey(edge);
                            const isHov = () => hoveredEdge() === key || hoveredNode() === edge.source || hoveredNode() === edge.target;
                            return (
                                <Show when={src() && tgt()}>
                                    <g>
                                        <line
                                            x1={src()!.x} y1={src()!.y}
                                            x2={tgt()!.x} y2={tgt()!.y}
                                            stroke={isHov() ? EDGE_HOV : EDGE_COLOR}
                                            stroke-width={isHov() ? Math.min(1 + edge.weight, 4) : Math.min(0.5 + edge.weight * 0.3, 2)}
                                            marker-end={isHov() ? "url(#net-arrow-hov)" : "url(#net-arrow)"}
                                            style="pointer-events:none"
                                        />
                                        {/* fat invisible hit target */}
                                        <line
                                            x1={src()!.x} y1={src()!.y}
                                            x2={tgt()!.x} y2={tgt()!.y}
                                            stroke="transparent" stroke-width={14}
                                            onMouseEnter={() => setHoveredEdge(key)}
                                            onMouseLeave={() => setHoveredEdge(null)}
                                        />
                                    </g>
                                </Show>
                            );
                        }}
                    </For>

                    {/* Nodes */}
                    <For each={props.nodes}>
                        {(node) => {
                            const pos = () => positions().get(node.id);
                            const isHov = () => hoveredNode() === node.id;
                            const lines = splitLabel(node.label);
                            const lineH = 13;
                            const totalTextH = lines.length * lineH;
                            return (
                                <Show when={pos()}>
                                    <g
                                        transform={`translate(${pos()!.x},${pos()!.y})`}
                                        style="cursor:pointer"
                                        onMouseEnter={() => setHoveredNode(node.id)}
                                        onMouseLeave={() => setHoveredNode(null)}
                                        onClick={() => props.onNavigate(node.id)}
                                    >
                                        <title>{node.id}</title>
                                        <rect
                                            x={-NODE_W / 2} y={-NODE_H / 2}
                                            width={NODE_W} height={NODE_H}
                                            rx={CORNER_R}
                                            fill={nodeColor(node, isHov())}
                                            stroke={nodeBorder(node)}
                                            stroke-width={isHov() ? 2.5 : 1.5}
                                        />
                                        <text
                                            text-anchor="middle"
                                            font-size="10"
                                            fill="var(--color-text)"
                                            style="pointer-events:none;font-family:monospace"
                                        >
                                            <For each={lines}>
                                                {(line, i) => (
                                                    <tspan
                                                        x={0}
                                                        y={-totalTextH / 2 + i() * lineH + lineH * 0.8}
                                                    >
                                                        {line}
                                                    </tspan>
                                                )}
                                            </For>
                                        </text>
                                    </g>
                                </Show>
                            );
                        }}
                    </For>

                    {/* Edge weight label on hover */}
                    <For each={props.edges.filter(e => e.source !== e.target)}>
                        {(edge) => {
                            const src = () => positions().get(edge.source);
                            const tgt = () => positions().get(edge.target);
                            const key = edgeKey(edge);
                            const isHov = () => hoveredEdge() === key;
                            const mid = () => src() && tgt()
                                ? {x: (src()!.x + tgt()!.x) / 2, y: (src()!.y + tgt()!.y) / 2}
                                : null;
                            const label = `${edge.weight} FK${edge.weight !== 1 ? "s" : ""}`;
                            const bw = label.length * 6.5 + 12;
                            return (
                                <Show when={isHov() && mid()}>
                                    <g style="pointer-events:none">
                                        <rect
                                            x={mid()!.x - bw / 2} y={mid()!.y - 10}
                                            width={bw} height={18} rx={3}
                                            fill="color-mix(in srgb, var(--color-surface-1) 97%, transparent)"
                                            stroke="color-mix(in srgb, var(--color-border) 70%, transparent)" stroke-width={0.5}
                                        />
                                        <text x={mid()!.x} y={mid()!.y} text-anchor="middle"
                                              dominant-baseline="middle" font-size="10"
                                              fill="var(--color-text-muted)"
                                              style="font-family:monospace">
                                            {label}
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
