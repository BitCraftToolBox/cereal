import {createEffect, createMemo} from "solid-js";
import {A, useNavigate} from "@solidjs/router";
import {isStaticTable, useData} from "~/lib/data";
import {Title} from "@solidjs/meta";
import {useNavHistory} from "~/lib/navHistory";
import {type NetworkEdge, NetworkGraph, type NetworkNode} from "~/components/NetworkGraph";

export default function NetworkGraphPage() {
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();

    createEffect(() => {
        nav.push({path: "/graph", label: "⬡ network"});
    });

    const graphData = createMemo(() => {
        const index = data.tableIndex();
        const fks = data.foreignKeys?.() ?? [];
        if (!index) return {nodes: [], edges: []};

        // Only static tables (public + hidden desc tables)
        const staticTables = index.filter(t => isStaticTable(t.name));
        const tableSet = new Set(staticTables.map(t => t.name));

        const nodes: NetworkNode[] = staticTables.map(t => ({
            id: t.name,
            label: t.name,
            isPublic: t.meta.isPublic ?? true,
        }));

        // Aggregate FK edges between tables, counting weight
        const edgeMap = new Map<string, number>();
        for (const fk of fks) {
            if (!tableSet.has(fk.sourceTable)) continue;

            const targets = fk.conditionalTargets
                ? fk.conditionalTargets.map(c => c.targetTable)
                : [fk.targetTable];

            for (const target of targets) {
                if (!target || !tableSet.has(target)) continue;
                const key = `${fk.sourceTable}|${target}`;
                edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
            }
        }

        const edges: NetworkEdge[] = [...edgeMap.entries()].map(([key, weight]) => {
            const [source, target] = key.split("|");
            return {source, target, weight};
        });

        return {nodes, edges};
    });

    const handleNavigate = (tableId: string) => {
        navigate(`/graph/${tableId}`);
    };

    return (
        <div class="flex flex-col flex-1 min-h-0 gap-3">
            <Title>network graph — cereal</Title>
            <div class="flex items-center gap-3 flex-wrap">
                <h1 class="text-xl font-bold">Network Graph</h1>
                <A
                    href="/"
                    class="text-xs px-2 py-1 rounded-sm bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                >
                    ⊞ tables
                </A>
                <span class="text-xs text-text-muted">
          {graphData().nodes.length} desc tables · {graphData().edges.length} FK relationships
        </span>
            </div>
            <NetworkGraph
                nodes={graphData().nodes}
                edges={graphData().edges}
                onNavigate={handleNavigate}
            />
        </div>
    );
}
