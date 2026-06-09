import {Title} from "@solidjs/meta";
import {A, useParams} from "@solidjs/router";
import {createEffect, createMemo, JSX, Show} from "solid-js";
import {CompareHeader} from "~/components/CompareHeader";
import {JsonViewer} from "~/components/JsonViewer";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {type DataStore, useCompare} from "~/lib/data";
import {diffObject} from "~/lib/diff";
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

    const from = useObjectView(() => params.name, () => params.id, cmp.fromStore);
    const to = useObjectView(() => params.name, () => params.id, cmp.toStore);

    const highlights = createMemo(() => diffObject(from.row(), to.row()));

    createEffect(() => {
        nav.push({path: `/compare/${params.name}/${params.id}`, label: `⇄ ${to.displayName()}`});
    });

    const loading = () => from.rows.loading || to.rows.loading;

    const Side = (p: { label: string; tag: string; view: ReturnType<typeof useObjectView> }) => (
        <div class="flex-1 min-w-0 space-y-2">
            <h2 class="text-sm font-semibold text-text-muted">
                <p class="text-sm text-text-muted">{p.label} <span class="font-mono text-text">
                    <Show when={p.view.row} fallback={p.tag}>
                        <A href={`/table/${params.name}/${params.id}?version=${p.tag}`}>▣ {p.view.displayName() ?? params.id} @ {p.tag}</A>
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
                    highlights={highlights()}
                    versionTag={p.tag}
                />
            </Show>
        </div>
    );

    return (
        <div class="w-full mx-auto space-y-6">
            <Title>⇄ {params.name} / {to.displayName() ?? params.id} — cereal</Title>
            <CompareHeader title={
                <>
                    <A href={`/compare/?from=${cmp.fromTag()}&to=${cmp.toTag()}`}>Compare</A>
                    {" "}/ <A href={`/compare/${params.name}?from=${cmp.fromTag()}&to=${cmp.toTag()}`}>{params.name}</A>
                    {" "}/ {to.displayName() ?? decodeURIComponent(params.id)}
                </>
            }/>

            <Show when={!loading()} fallback={<div class="flex justify-center py-16"><LoadingSpinner size="lg" label="Loading…"/></div>}>
                <Show
                    when={highlights().size > 0 || !from.row() || !to.row()}
                    fallback={<div class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                        No differences between these versions.
                    </div>}
                >
                    <div class="flex flex-col lg:flex-row gap-4">
                        <Side label="From" tag={cmp.fromTag()} view={from}/>
                        <Side label="To" tag={cmp.toTag()} view={to}/>
                    </div>
                </Show>
            </Show>
        </div>
    );
}
