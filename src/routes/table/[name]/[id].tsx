import {Title} from "@solidjs/meta";
import {A, useNavigate, useParams} from "@solidjs/router";
import {createEffect, createMemo, Show} from "solid-js";
import {CompareButton} from "~/components/CompareButton";
import {JsonViewer} from "~/components/JsonViewer";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {ObjectNotFound, TableNotFound} from "~/components/NotFound";
import {RefPills} from "~/components/RefPills";
import {isStaticTable, useData} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {buildFkMap, createDisplayNameMap, createIncomingResults, createObjectRow, createOutgoingResults, outgoingDisplayTables,} from "~/lib/objectRefs";
import {type ForeignKeyMapping} from "~/lib/schema";

export default function ObjectView() {
    const params = useParams<{ name: string; id: string }>();
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();

    createEffect(() => {
        const m = data.getTableMeta(params.name);
        if (!m) return;
        if (!isStaticTable(params.name) || !(m.isPublic ?? true)) {
            navigate(`/table/${params.name}`, {replace: true});
        }
    });

    const {meta, rows, row, displayName} = createObjectRow(
        () => params.name,
        () => params.id,
        data,
    );

    const tableNotFound = () => !data.tableIndex.loading && data.getTableMeta(params.name) == null;
    const objectNotFound = () => !rows.loading && rows() != null && !row();

    createEffect(() => {
        nav.push({path: `/table/${params.name}/${params.id}`, label: `▣ ${displayName()}`});
    });

    // Outgoing refs: grouped by (field, targetTable, conditional)
    const outgoingResults = createOutgoingResults(row, () => params.name, data);

    // Pre-fetch target tables so display names are available in RefPills and JsonViewer
    const {displayNames} = createDisplayNameMap(
        createMemo(() => outgoingDisplayTables(params.name, data)),
        data,
    );

    // Incoming refs: fetches source tables internally, returns non-empty results only
    const incomingResults = createIncomingResults(row, meta, () => params.name, data);

    // fkMap and enumVariantsByName for JsonViewer
    const fkMap = createMemo((): Map<string, {
        targetTable: string;
        conditionalTargets?: ForeignKeyMapping["conditionalTargets"];
        enumConversion?: string;
    }> => buildFkMap(data.getOutgoingRefs(params.name)));

    const enumVariantsByName = createMemo((): Map<string, string[]> => {
        const m = new Map<string, string[]>();
        for (const fk of data.getOutgoingRefs(params.name)) {
            if (fk.enumConversion && !m.has(fk.enumConversion)) {
                const variants = data.getEnum(fk.enumConversion);
                if (variants) m.set(fk.enumConversion, variants);
            }
        }
        return m;
    });

    return (
        <div class="w-full min-w-[min(67vw,100%)] mx-auto space-y-6">
            <Title>{`${displayName()} — ${params.name} — cereal`}</Title>

            <Show when={tableNotFound()}>
                <TableNotFound name={params.name}/>
            </Show>

            <Show when={objectNotFound()}>
                <ObjectNotFound name={params.name} id={params.id}/>
            </Show>

            <Show
                when={!tableNotFound() && !objectNotFound() && row()}
                fallback={
                    <Show when={!tableNotFound() && !objectNotFound()}>
                        <div class="flex justify-center py-16">
                            <LoadingSpinner size="lg" label="Loading object…"/>
                        </div>
                    </Show>
                }
            >
                {/* Header */}
                <div>
                    <div class="flex items-center gap-3">
                        <h1 class="text-2xl font-bold">{displayName()}</h1>
                        <A
                            href={`/graph/${params.name}/${params.id}`}
                            class="text-xs px-2 py-1 rounded-sm bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                            title="View reference graph for this object"
                        >
                            ⬡ graph
                        </A>
                        <CompareButton
                            currentTag={data.tag()}
                            buildHref={(other) => `/compare/${params.name}/${params.id}?from=${other}&to=${data.tag()}`}
                        />
                    </div>
                    <p class="text-sm text-text-muted font-mono">
                        <A href={`/table/${params.name}`}
                           class="hover:text-primary transition-colors">⊞ {params.name}</A>
                        {" / "}{params.id}
                    </p>
                </div>

                <Show when={outgoingResults().length > 0}>
                    <div class="space-y-2">
                        <h2 class="text-lg font-semibold">References</h2>
                        <RefPills
                            results={outgoingResults()}
                            direction="outgoing"
                            currentTable={params.name}
                            currentId={decodeURIComponent(params.id)}
                        />
                    </div>
                </Show>

                <Show when={incomingResults().length > 0}>
                    <div class="space-y-2">
                        <h2 class="text-lg font-semibold">Referenced By</h2>
                        <RefPills
                            results={incomingResults()}
                            direction="incoming"
                            currentTable={params.name}
                            currentId={decodeURIComponent(params.id)}
                        />
                    </div>
                </Show>

                <div class="space-y-2">
                    <h2 class="text-lg font-semibold">Raw Data</h2>
                    <JsonViewer
                        data={row()}
                        expandDepth={3}
                        copyable
                        fkMap={fkMap()}
                        displayNames={displayNames()}
                        enumValues={meta()?.enumValues}
                        enumVariantsByName={enumVariantsByName()}
                        spriteFields={new Set(meta()?.spriteFields ?? [])}
                    />
                </div>
            </Show>
        </div>
    );
}
