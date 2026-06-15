import {Title} from "@solidjs/meta";
import {A, useParams} from "@solidjs/router";
import {createEffect, createMemo, createResource, For, Show} from "solid-js";
import {ColumnStructure} from "~/components/ColumnStructure";
import {CompareHeader} from "~/components/CompareHeader";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {type DataStore, isStaticTable, useCompare} from "~/lib/data";
import {type DiffKind, diffSchema, diffTable} from "~/lib/diff";
import {useNavHistory} from "~/lib/navHistory";
import type {AlgebraicType} from "~/lib/schema";

/** Lazily fetch a table's rows from one store (empty when non-fetchable). */
function useRows(tableName: () => string, store: DataStore) {
    const canLoad = () => {
        const m = store.getTableMeta(tableName());
        return m != null && isStaticTable(tableName()) && (m.isPublic ?? true);
    };
    const [rows] = createResource(
        () => canLoad() ? {tag: store.tag(), name: tableName()} : null,
        (s) => store.fetchTableFor(s.tag, s.name).catch(() => []),
    );
    return {rows, canLoad};
}

/** Build a column → AlgebraicType map for the columns that exist in this version. */
function colTypeMap(name: string, store: DataStore): Map<string, AlgebraicType | undefined> {
    const m = store.getTableMeta(name);
    const out = new Map<string, AlgebraicType | undefined>();
    for (const col of m?.columns ?? []) out.set(col, store.getColumnType(name, col));
    return out;
}

export default function TableCompareView() {
    const params = useParams<{ name: string }>();
    const cmp = useCompare();
    const nav = useNavHistory();

    const fromRows = useRows(() => params.name, cmp.fromStore);
    const toRows = useRows(() => params.name, cmp.toStore);

    createEffect(() => {
        nav.push({path: `/compare/${params.name}?from=${cmp.fromTag()}&to=${cmp.toTag()}`, label: `⇄ ${params.name}`});
    });

    const metaFrom = () => cmp.fromStore.getTableMeta(params.name);
    const metaTo = () => cmp.toStore.getTableMeta(params.name);

    // Both manifests must be settled before we can decide whether each side is loadable.
    const manifestsReady = () =>
        cmp.fromStore.manifest() !== undefined && cmp.toStore.manifest() !== undefined;
    const bothLoadable = () => fromRows.canLoad() && toRows.canLoad();

    /** Why a side can't have its rows compared, or null when it's loadable. */
    const sideIssue = (store: DataStore): string | null => {
        const m = store.getTableMeta(params.name);
        if (m == null) return "is absent";
        if (!isStaticTable(params.name)) return "contains runtime state";
        if (!(m.isPublic ?? true)) return "is private";
        return null;
    };
    const fromIssue = () => sideIssue(cmp.fromStore);
    const toIssue = () => sideIssue(cmp.toStore);

    const schema = createMemo(() => {
        const ctxA = cmp.fromStore.getTypeContext();
        const ctxB = cmp.toStore.getTypeContext();
        return diffSchema(
            colTypeMap(params.name, cmp.fromStore),
            colTypeMap(params.name, cmp.toStore),
            ctxA?.schema.tables?.find((t) => t.name === params.name),
            ctxB?.schema.tables?.find((t) => t.name === params.name),
            ctxA && {typespace: ctxA.schema.typespace.types, idxMap: ctxA.idxMap},
            ctxB && {typespace: ctxB.schema.typespace.types, idxMap: ctxB.idxMap},
        );
    });

    const tableDiff = createMemo(() => {
        // Rows can only be diffed when both versions actually expose row data.
        if (!bothLoadable()) return undefined;
        const a = fromRows.rows();
        const b = toRows.rows();
        if (a === undefined || b === undefined) return undefined;
        return diffTable(a, b, metaFrom(), metaTo(), schema());
    });

    // Column highlight maps: from-side shows removed/changed, to-side shows added/changed.
    const fromColHighlights = createMemo(() => {
        const m = new Map<string, DiffKind>();
        for (const c of schema().columns) if (c.kind !== "added") m.set(c.column, c.kind);
        return m;
    });
    const toColHighlights = createMemo(() => {
        const m = new Map<string, DiffKind>();
        for (const c of schema().columns) if (c.kind !== "removed") m.set(c.column, c.kind);
        return m;
    });

    const displayName = (id: string, store: DataStore): string =>
        store.getDisplayNames(params.name)?.get(id) ?? id;

    // Reactive label getter — must be a function (not an eagerly-evaluated string)
    // so that SolidJS can track the `displayNameVersion` signal read inside
    // `getDisplayNames` and re-evaluate each For-item cell when names load async.
    const makeLabel = (id: string, store: DataStore) => () => displayName(id, store);

    const compareHref = (id: string) =>
        `/compare/${params.name}/${encodeURIComponent(id)}?from=${cmp.fromTag()}&to=${cmp.toTag()}`;

    // Only "loading" while the manifests are settling, or while both sides' rows are still
    // being fetched. A side that simply isn't loadable must not keep the page spinning.
    const loading = () => !manifestsReady() || (bothLoadable() && tableDiff() === undefined);

    const kindStyle: Record<DiffKind, string> = {
        added: "text-green-500",
        removed: "text-red-500",
        changed: "text-yellow-600 dark:text-yellow-400",
    };
    const kindSign: Record<DiffKind, string> = {added: "+", removed: "−", changed: "~"};

    return (
        <div class="w-full mx-auto space-y-6">
            <Title>{`⇄ ${params.name} — cereal`}</Title>
            <CompareHeader title={
                <>
                    <A href={`/compare/?from=${cmp.fromTag()}&to=${cmp.toTag()}`}>Compare</A>
                    {" "}/ {params.name}
                </>
            }/>

            <Show when={!loading()} fallback={<div class="flex justify-center py-16"><LoadingSpinner size="lg" label="Loading table…"/></div>}>
                {/* Summary */}
                <div class="flex flex-wrap gap-2 text-sm">
                    <Show when={tableDiff()}>
                        <span class="px-2 py-1 rounded-md bg-surface-1 border border-border">
                            <span class="text-green-500">+{tableDiff()!.added}</span>{" / "}
                            <span class="text-yellow-600 dark:text-yellow-400">~{tableDiff()!.changed}</span>{" / "}
                            <span class="text-red-500">−{tableDiff()!.removed}</span> rows
                        </span>
                    </Show>
                    <span class="px-2 py-1 rounded-md bg-surface-1 border border-border">
                        {schema().changeCount} schema change{schema().changeCount === 1 ? "" : "s"}
                    </span>
                </div>

                {/* Schema changes */}
                <Show when={schema().changeCount > 0}>
                    <div class="space-y-2">
                        <h2 class="text-lg font-semibold">Schema changes</h2>
                        <Show when={schema().indexes.length > 0}>
                            <div class="flex flex-wrap gap-1.5 text-xs">
                                <p class="text-sm">{`Column Ind${schema().indexes.length == 1 ? "ex" : "ices"}`}</p>
                                <For each={schema().indexes}>
                                    {(idx) => (
                                        <span class={`px-1.5 py-0.5 rounded-sm bg-surface-2 border border-border font-mono ${kindStyle[idx.kind]}`}>
                                            {kindSign[idx.kind]} {idx.name}
                                        </span>
                                    )}
                                </For>
                            </div>
                        </Show>
                        <div class="flex flex-col lg:flex-row gap-4">
                            <div class="flex-1 min-w-0 space-y-1">
                                <p class="text-sm text-text-muted">To <span class="font-mono text-text">
                                    <Show when={metaFrom()} fallback={cmp.fromTag()}>
                                        <A href={`/table/${params.name}?version=${cmp.fromTag()}`}>⊞ {params.name} @ {cmp.fromTag()}</A>
                                    </Show>
                                </span></p>
                                <Show when={metaFrom()} fallback={<p class="text-sm text-text-muted italic">Table absent.</p>}>
                                    <ColumnStructure
                                        meta={metaFrom()!} fks={cmp.fromStore.getOutgoingRefs(params.name)}
                                        tableName={params.name}
                                        schemaTable={cmp.fromStore.getTypeContext()?.schema.tables?.find((t) => t.name === params.name)}
                                        columnType={(c) => cmp.fromStore.getColumnType(params.name, c)}
                                        typeCtx={cmp.fromStore.getTypeContext()}
                                        highlights={fromColHighlights()}
                                    />
                                </Show>
                            </div>
                            <div class="flex-1 min-w-0 space-y-1">
                                <p class="text-sm text-text-muted">To <span class="font-mono text-text">
                                    <Show when={metaTo()} fallback={cmp.toTag()}>
                                        <A href={`/table/${params.name}?version=${cmp.toTag()}`}>⊞ {params.name} @ {cmp.toTag()}</A>
                                    </Show>
                                </span></p>
                                <Show when={metaTo()} fallback={<p class="text-sm text-text-muted italic">Table absent.</p>}>
                                    <ColumnStructure
                                        meta={metaTo()!} fks={cmp.toStore.getOutgoingRefs(params.name)}
                                        tableName={params.name}
                                        schemaTable={cmp.toStore.getTypeContext()?.schema.tables?.find((t) => t.name === params.name)}
                                        columnType={(c) => cmp.toStore.getColumnType(params.name, c)}
                                        typeCtx={cmp.toStore.getTypeContext()}
                                        highlights={toColHighlights()}
                                    />
                                </Show>
                            </div>
                        </div>
                    </div>
                </Show>

                {/* Row data unavailable on one or both sides */}
                <Show when={!bothLoadable()}>
                    <div class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted space-y-1">
                        <p>Row comparison isn't available:</p>
                        <ul class="list-disc list-inside">
                            <Show when={fromIssue()}>
                                <li>the table {fromIssue()} in <span class="font-mono text-text">{cmp.fromTag()}</span></li>
                            </Show>
                            <Show when={toIssue()}>
                                <li>the table {toIssue()} in <span class="font-mono text-text">{cmp.toTag()}</span></li>
                            </Show>
                        </ul>
                    </div>
                </Show>
                {/* Row changes */}
                <Show when={tableDiff()}>
                    <Show
                        when={tableDiff()!.rows.length > 0}
                        fallback={<Show when={schema().changeCount === 0}>
                            <div class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                                No row or schema differences between these versions.
                            </div>
                        </Show>}
                    >
                        <div class="space-y-2">
                            <h2 class="text-lg font-semibold">Row changes</h2>
                            <div class="rounded-lg border border-border overflow-hidden divide-y divide-border">
                                <For each={tableDiff()!.rows}>
                                    {(r) => {
                                        const store = r.kind === "removed" ? cmp.fromStore : cmp.toStore;
                                        // `label` is a getter so that the `displayNameVersion` signal
                                        // read inside `getDisplayNames` is tracked by the JSX expressions
                                        // below — without this, async name resolution never re-renders.
                                        const label = makeLabel(r.id, store);
                                        // Keyless tables use JSON-string ids that aren't routable.
                                        const linkable = (metaTo()?.primaryKey ?? metaFrom()?.primaryKey) != null;
                                        return (
                                            <Show
                                                when={linkable}
                                                fallback={
                                                    <div class="flex items-center gap-2 px-4 py-2 text-sm font-mono">
                                                        <span class={kindStyle[r.kind]}>{kindSign[r.kind]}</span>
                                                        <span>{label()}</span>
                                                    </div>
                                                }
                                            >
                                                <A href={compareHref(r.id)}
                                                   class="flex items-center gap-2 px-4 py-2 text-sm font-mono hover:bg-surface-2 transition-colors">
                                                    <span class={kindStyle[r.kind]}>{kindSign[r.kind]}</span>
                                                    <span>{label()}</span>
                                                    <Show when={label() !== r.id}>
                                                        <span class="text-text-muted text-xs">#{r.id}</span>
                                                    </Show>
                                                </A>
                                            </Show>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </Show>
                </Show>
            </Show>
        </div>
    );
}



