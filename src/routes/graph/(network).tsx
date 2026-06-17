import {createEffect, createMemo} from "solid-js";
import {A, useNavigate} from "@solidjs/router";
import {isStaticTable, useData} from "~/lib/data";
import {Title} from "@solidjs/meta";
import {useNavHistory} from "~/lib/navHistory";
import {useHomeState} from "~/lib/homeState";
import {FilterToggle} from "~/components/FilterToggle";
import {type NetworkEdge, NetworkGraph, type NetworkNode} from "~/components/NetworkGraph";

export default function NetworkGraphPage() {
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();
    const {showStatic, setShowStatic, showPrivate, setShowPrivate, showNonStatic, setShowNonStatic} = useHomeState();

    createEffect(() => {
        nav.push({path: "/graph", label: "⬡ network"});
    });

    const filteredTables = createMemo(() => {
        const index = data.tableIndex();
        if (!index) return [];

        return index.filter((t) => {
            const isStatic = isStaticTable(t.name);
            const isPublic = t.meta.isPublic ?? true;
            if (!isStatic && !showNonStatic()) return false;
            if (isStatic && !isPublic && !showPrivate()) return false;
            if (isStatic && isPublic && !showStatic()) return false;
            return true;
        });
    });

    const graphData = createMemo(() => {
        const tables = filteredTables();
        const fks = data.foreignKeys?.() ?? [];

        const tableSet = new Set(tables.map((t) => t.name));
        const nodes: NetworkNode[] = tables.map((t) => ({
            id: t.name,
            label: t.name,
            isPublic: t.meta.isPublic ?? true,
            isStatic: isStaticTable(t.name),
        }));

        // Aggregate FK edges between currently included tables.
        const edgeMap = new Map<string, number>();
        for (const fk of fks) {
            if (!tableSet.has(fk.sourceTable)) continue;

            const targets = fk.conditionalTargets
                ? fk.conditionalTargets.map((c) => c.targetTable)
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
                <div class="flex items-center gap-3 sm:ml-auto flex-wrap">
                    <FilterToggle label="📋 Static" checked={showStatic()} onChange={() => setShowStatic((v) => !v)}
                                  title="Show normal static (desc) tables"/>
                    <FilterToggle label="🔒 Hidden" checked={showPrivate()} onChange={() => setShowPrivate((v) => !v)}
                                  title="Show hidden desc tables (no rows, only structure)"/>
                    <FilterToggle label="⚙️ State" checked={showNonStatic()} onChange={() => setShowNonStatic((v) => !v)}
                                  title="Show runtime/non-static tables (any visibility, no rows, only structure)"/>
                </div>
                <span class="text-xs text-text-muted">
                    {graphData().nodes.length} tables · {graphData().edges.length} FK relationships
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
