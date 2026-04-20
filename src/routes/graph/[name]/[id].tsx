import {createEffect, createMemo, Show} from "solid-js";
import {A, useNavigate, useParams} from "@solidjs/router";
import {useData} from "~/lib/data";
import {Title} from "@solidjs/meta";
import {useNavHistory} from "~/lib/navHistory";
import {type GraphEdge, type GraphNode, RefGraph} from "~/components/RefGraph";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {ObjectNotFound, TableNotFound} from "~/components/NotFound";
import {
  allDisplayTables,
  createDisplayNameMap,
  createIncomingResults,
  createObjectRow,
  createOutgoingResults,
} from "~/lib/objectRefs";

export default function ObjectGraph() {
    const params = useParams<{ name: string; id: string }>();
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();

    const {meta, rows, row, displayName} = createObjectRow(
        () => params.name,
        () => params.id,
        data,
    );

    createEffect(() => {
        nav.push({path: `/graph/${params.name}/${params.id}`, label: `⬡ ${displayName()}`});
    });

    const outgoingResults = createOutgoingResults(row, () => params.name, data);
    const incomingResults = createIncomingResults(row, meta, () => params.name, data);

    // Display names for all referenced tables
    const {displayNames: displayLabels} = createDisplayNameMap(
        createMemo(() => allDisplayTables(params.name, data)),
        data,
    );

    const makeLabel = (tableName: string, objId: string) =>
        displayLabels().get(tableName)?.get(objId) ?? `${tableName} #${objId}`;

    // Build graph nodes + edges
    const graphData = createMemo(() => {
        const name = params.name;
        const id = decodeURIComponent(params.id);
        const centerNodeId = `${name}/${id}`;
        displayLabels(); // subscribe for reactivity

        const nodeMap = new Map<string, { kind: GraphNode["kind"]; label: string }>();
        nodeMap.set(centerNodeId, {kind: "center", label: displayName()});

        for (const result of outgoingResults()) {
            for (const tid of result.ids) {
                const nid = `${result.table}/${tid}`;
                if (nid === centerNodeId) continue;
                if (!nodeMap.has(nid))
                    nodeMap.set(nid, {
                        kind: "outgoing",
                        label: makeLabel(result.table, tid)
                    });
            }
        }

        for (const result of incomingResults()) {
            for (const matchedId of result.ids) {
                const nid = `${result.table}/${matchedId}`;
                if (nid === centerNodeId) continue;
                const cur = nodeMap.get(nid);
                nodeMap.set(nid, {
                    kind: cur?.kind === "outgoing" ? "both" : "incoming",
                    label: makeLabel(result.table, matchedId),
                });
            }
        }

        const nodes: GraphNode[] = [...nodeMap.entries()].map(([nid, {kind, label}]) => ({
            id: nid, label, kind, isSelf: false,
        }));

        const edges: GraphEdge[] = [];
        for (const result of outgoingResults()) {
            for (const tid of result.ids) {
                const nid = `${result.table}/${tid}`;
                const isSelf = nid === centerNodeId;
                edges.push({source: centerNodeId, target: isSelf ? centerNodeId : nid, label: result.field, isSelf});
            }
        }
        for (const result of incomingResults()) {
            for (const matchedId of result.ids) {
                const nid = `${result.table}/${matchedId}`;
                if (nid === centerNodeId) continue;
                edges.push({source: nid, target: centerNodeId, label: result.field, isSelf: false});
            }
        }

        return {nodes, edges};
    });

    const handleNavigate = (nodeId: string) => {
        const slash = nodeId.indexOf("/");
        if (slash === -1) navigate(`/graph/${nodeId}`);
        else navigate(`/graph/${nodeId.slice(0, slash)}/${encodeURIComponent(nodeId.slice(slash + 1))}`);
    };

    const loading = () => rows.loading;
    const centerId = () => `${params.name}/${decodeURIComponent(params.id)}`;
    const tableNotFound = () => !data.tableIndex.loading && data.getTableMeta(params.name) == null;
    const objectNotFound = () => !rows.loading && rows() != null && !row();

    return (
        <div class="flex flex-col flex-1 min-h-0 gap-3">
            <Title>{displayName()} graph — cereal</Title>

            <Show when={tableNotFound()}>
                <TableNotFound name={params.name}/>
            </Show>

            <Show when={objectNotFound()}>
                <ObjectNotFound name={params.name} id={params.id}/>
            </Show>

            <Show when={!tableNotFound() && !objectNotFound()}>
                <div class="flex items-center gap-3 flex-wrap">
                    <h1 class="text-xl font-bold">{displayName()}</h1>
                    <span class="text-sm text-text-muted font-mono">
                      <A href={`/table/${params.name}`} class="hover:text-primary transition-colors">⊞ {params.name}</A>
                        {" / "}{params.id}
                    </span>
                    <A href={`/table/${params.name}/${params.id}`}
                       class="text-xs px-2 py-1 rounded bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors">
                        ▣ object view
                    </A>
                    <A href={`/graph/${params.name}`}
                       class="text-xs px-2 py-1 rounded bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors">
                        ⬡ table graph
                    </A>
                    <Show when={loading()}><LoadingSpinner size="sm" label="Loading refs…"/></Show>
                    <Show when={!loading()}>
                      <span class="text-xs text-text-muted">
                        {graphData().edges.filter(e => !e.isSelf && e.source === centerId()).length} outgoing
                          {" · "}
                          {graphData().edges.filter(e => !e.isSelf && e.target === centerId()).length} incoming
                      </span>
                    </Show>
                </div>
                <Show
                    when={!rows.loading}
                    fallback={<div class="flex justify-center items-center flex-1"><LoadingSpinner size="lg"
                                                                                                   label="Loading…"/>
                    </div>}
                >
                    <RefGraph nodes={graphData().nodes} edges={graphData().edges} onNavigate={handleNavigate}/>
                </Show>
            </Show>
        </div>
    );
}
