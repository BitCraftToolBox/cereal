import {createEffect, createMemo, Show} from "solid-js";
import {A, useNavigate, useParams} from "@solidjs/router";
import {useData} from "~/lib/data";
import {Title} from "@solidjs/meta";
import {useNavHistory} from "~/lib/navHistory";
import {type GraphEdge, type GraphNode, RefGraph} from "~/components/RefGraph";
import {TableNotFound} from "~/components/NotFound";

export default function TableGraph() {
    const params = useParams<{ name: string }>();
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();

    createEffect(() => {
        nav.push({path: `/graph/${params.name}`, label: `⬡ ${params.name}`});
    });

    const outgoing = createMemo(() => data.getOutgoingRefs(params.name));
    const incoming = createMemo(() => data.getIncomingRefs(params.name));

    const graphData = createMemo(() => {
        const name = params.name;
        const out = outgoing();
        const inc = incoming();

        const nodeMap = new Map<string, GraphNode["kind"]>();
        nodeMap.set(name, "center");

        for (const fk of out) {
            const t = fk.conditionalTargets
                ? fk.conditionalTargets.map((c) => c.targetTable)
                : [fk.targetTable];
            for (const tbl of t) {
                if (!tbl || tbl === name) continue;
                const cur = nodeMap.get(tbl);
                nodeMap.set(tbl, cur === "incoming" ? "both" : "outgoing");
            }
        }
        for (const fk of inc) {
            if (fk.sourceTable === name) continue;
            const cur = nodeMap.get(fk.sourceTable);
            nodeMap.set(fk.sourceTable, cur === "outgoing" ? "both" : "incoming");
        }

        const nodes: GraphNode[] = [...nodeMap.entries()].map(([id, kind]) => ({
            id,
            label: id,
            kind,
            isSelf: false,
        }));

        const edges: GraphEdge[] = [];

        // Outgoing edges
        for (const fk of out) {
            const targets = fk.conditionalTargets
                ? fk.conditionalTargets.map((c) => c.targetTable)
                : [fk.targetTable];
            for (const tbl of targets) {
                if (!tbl) continue;
                edges.push({
                    source: name,
                    target: tbl === name ? name : tbl,
                    label: fk.sourceField,
                    isSelf: tbl === name,
                });
            }
        }

        // Incoming edges (from other tables to this one)
        for (const fk of inc) {
            if (fk.sourceTable === name) continue;
            edges.push({
                source: fk.sourceTable,
                target: name,
                label: fk.sourceField,
                isSelf: false,
            });
        }

        return {nodes, edges};
    });

    const handleNavigate = (nodeId: string) => {
        navigate(`/graph/${nodeId}`);
    };

    const tableNotFound = () => !data.tableIndex.loading && data.getTableMeta(params.name) == null;

    return (
        <div class="flex flex-col flex-1 min-h-0 gap-3">
            <Title>{params.name} graph — cereal</Title>

            <Show when={tableNotFound()}>
                <TableNotFound name={params.name}/>
            </Show>

            <Show when={!tableNotFound()}>
                <div class="flex items-center gap-3">
                    <h1 class="text-xl font-bold font-mono">{params.name}</h1>
                    <A
                        href={`/table/${params.name}`}
                        class="text-xs px-2 py-1 rounded-sm bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                    >
                        ⊞ table
                    </A>
                    <span class="text-xs text-text-muted">
                      {outgoing().length} outgoing · {incoming().length} incoming
                    </span>
                </div>
                <RefGraph
                    nodes={graphData().nodes}
                    edges={graphData().edges}
                    onNavigate={handleNavigate}
                />
            </Show>
        </div>
    );
}
