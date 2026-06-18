import {Title} from "@solidjs/meta";
import {A, useParams} from "@solidjs/router";
import {createEffect, createMemo, Show} from "solid-js";
import {CompareHeader} from "~/components/CompareHeader";
import {JsonViewer} from "~/components/JsonViewer";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {type DataStore, useCompare} from "~/lib/data";
import {type ObjectDiff, diffObjectSides} from "~/lib/diff";
import {useNavHistory} from "~/lib/navHistory";
import {buildFkMap, createDisplayNameMap, createObjectRow, outgoingDisplayTables,} from "~/lib/objectRefs";

/** Bundle all JsonViewer props for one version's view of an object. */
function useObjectView(tableName: () => string, objectId: () => string, store: DataStore) {
    const {meta, rows, row, displayName} = createObjectRow(tableName, objectId, store);

    const {displayNames} = createDisplayNameMap(
        createMemo(() => outgoingDisplayTables(tableName(), store)),
        store,
    );

    const fkMap = createMemo(() => buildFkMap(store.getOutgoingRefs(tableName())));

    const enumVariantsByName = createMemo((): Map<string, string[]> => {
        const m = new Map<string, string[]>();
        for (const fk of store.getOutgoingRefs(tableName())) {
            if (fk.enumConversion && !m.has(fk.enumConversion)) {
                const variants = store.getEnum(fk.enumConversion);
                if (variants) m.set(fk.enumConversion, variants);
            }
        }
        return m;
    });

    return {meta, row, displayName, displayNames, fkMap, enumVariantsByName, rows};
}

export default function ObjectCompareView() {
    const params = useParams<{ name: string; id: string }>();
    const cmp = useCompare();
    const nav = useNavHistory();

    // Resolve to each side's current migration version so an object that lives in a migrated
    // `_vN` table is paired by base (e.g. `deployable_desc_v2` ↔ `deployable_desc_v3`).
    const fromName = () => cmp.fromStore.resolveCurrentTable(params.name);
    const toName = () => cmp.toStore.resolveCurrentTable(params.name);

    const from = useObjectView(fromName, () => params.id, cmp.fromStore);
    const to = useObjectView(toName, () => params.id, cmp.toStore);

    const objectDiff = createMemo(() => diffObjectSides(from.row(), to.row()));

    createEffect(() => {
        nav.push({path: `/compare/${params.name}/${params.id}?from=${cmp.fromTag()}&to=${cmp.toTag()}`, label: `⇄ ${to.displayName()}`});
    });

    const loading = () => from.rows.loading || to.rows.loading;

    const Side = (p: { label: string; tag: string; name: string; view: ReturnType<typeof useObjectView>; highlights: ObjectDiff }) => (
        <div class="flex-1 min-w-0 space-y-2">
            <h2 class="text-sm font-semibold text-text-muted">
                <p class="text-sm text-text-muted">{p.label} <span class="font-mono text-text">
                    <Show when={p.view.row()} keyed fallback={p.tag}>
                        <A href={`/table/${p.name}/${params.id}?version=${p.tag}`}>▣ {p.view.displayName() ?? params.id} @ {p.tag}</A>
                    </Show>
                </span></p>
            </h2>
            <Show
                when={p.view.row()}
                fallback={<div class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                    Not present in this version.
                </div>}
            >
                <JsonViewer
                    data={p.view.row()}
                    expandDepth={4}
                    copyable
                    fkMap={p.view.fkMap()}
                    displayNames={p.view.displayNames()}
                    enumValues={p.view.meta()?.enumValues}
                    enumVariantsByName={p.view.enumVariantsByName()}
                    spriteFields={new Set(p.view.meta()?.spriteFields ?? [])}
                    highlights={p.highlights}
                    versionTag={p.tag}
                />
            </Show>
        </div>
    );

    return (
        <div class="w-full mx-auto space-y-6">
            <Title>{`⇄ ${params.name} / ${to.displayName()} — cereal`}</Title>
            <CompareHeader title={
                <>
                    <A href={`/compare/?from=${cmp.fromTag()}&to=${cmp.toTag()}`}>Compare</A>
                    {" "}/ <A href={`/compare/${params.name}?from=${cmp.fromTag()}&to=${cmp.toTag()}`}>{params.name}</A>
                    {" "}/ {to.displayName() ?? decodeURIComponent(params.id)}
                </>
            }/>

            <Show when={!loading()} fallback={<div class="flex justify-center py-16"><LoadingSpinner size="lg" label="Loading…"/></div>}>
                <Show
                    when={objectDiff().from.size > 0 || objectDiff().to.size > 0 || !from.row() || !to.row()}
                    fallback={
                        <div class="flex flex-col items-center p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                            <p>No differences between these versions.</p>
                            <div class="flex flex-row gap-4">
                                <A href={`/table/${fromName()}/${params.id}?version=${cmp.fromTag()}`}>▣ {from.displayName()} @ {cmp.fromTag()}</A>
                                <A href={`/table/${toName()}/${params.id}?version=${cmp.toTag()}`}>▣ {to.displayName()} @ {cmp.toTag()}</A>
                            </div>
                        </div>
                    }
                >
                    <div class="flex flex-col lg:flex-row gap-4">
                        <Side label="From" tag={cmp.fromTag()} name={fromName()} view={from} highlights={objectDiff().from}/>
                        <Side label="To" tag={cmp.toTag()} name={toName()} view={to} highlights={objectDiff().to}/>
                    </div>
                </Show>
            </Show>
        </div>
    );
}
