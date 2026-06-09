import {Title} from "@solidjs/meta";
import {A, useParams, useSearchParams} from "@solidjs/router";
import {createEffect, createResource, createSignal, For, Show, Suspense} from "solid-js";
import {ColumnStructure} from "~/components/ColumnStructure";
import {CompareButton} from "~/components/CompareButton";
import {DataTable} from "~/components/DataTable";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {TableNotFound} from "~/components/NotFound";
import {isStaticTable, type ResolvedTableMeta, useData} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import type {ForeignKeyMapping} from "~/lib/schema";

function CollapsibleSchema(props: {
    meta: ResolvedTableMeta;
    fks: ForeignKeyMapping[];
    tableName: string;
}) {
    const data = useData();
    const [open, setOpen] = createSignal(false);
    const typeCtx = () => data.getTypeContext();
    const schemaTable = () => typeCtx()?.schema.tables?.find((t) => t.name === props.tableName);
    return (
        <div class="rounded-lg border border-border overflow-hidden">
            <button
                class="w-full flex items-center justify-between px-4 py-2 bg-surface-1 hover:bg-surface-2 transition-colors text-sm font-medium"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open()}
            >
                <span>Schema</span>
                <span class="text-text-muted text-xs">{open() ? "▲" : "▼"} {props.meta.columns.length} columns</span>
            </button>
            <Show when={open()}>
                <div class="border-t border-border">
                    <ColumnStructure
                        meta={props.meta}
                        fks={props.fks}
                        tableName={props.tableName}
                        schemaTable={schemaTable()}
                        columnType={(col) => data.getColumnType(props.tableName, col)}
                        typeCtx={typeCtx()}
                    />
                </div>
            </Show>
        </div>
    );
}


export default function TableView() {
    const params = useParams<{ name: string }>();
    const [searchParams, setSearchParams] = useSearchParams();
    const data = useData();
    const nav = useNavHistory();
    const [refsOpen, setRefsOpen] = createSignal(false);

    // Parse ?filter=field=value&filter=field2=value2 (repeatable)
    const initialFilters = () => {
        const raw = searchParams.filter;
        if (!raw) return [];
        const entries = Array.isArray(raw) ? raw : [raw];
        return entries.flatMap((f) => {
            const eq = f.indexOf("=");
            if (eq === -1) return [];
            return [{field: decodeURIComponent(f.slice(0, eq)), value: decodeURIComponent(f.slice(eq + 1))}];
        });
    };

    const initialGlobalFilter = () => {
        const q = searchParams.q;
        return typeof q === "string" ? q : (q?.[0] ?? "");
    };

    const initialPage = () => {
        const p = Array.isArray(searchParams.page) ? searchParams.page[0] : searchParams.page;
        const n = parseInt(p ?? "1", 10);
        return isNaN(n) || n < 1 ? 0 : n - 1; // convert 1-based URL param to 0-based index
    };

    const initialPageSize = () => {
        const p = Array.isArray(searchParams.pageSize) ? searchParams.pageSize[0] : searchParams.pageSize;
        const n = parseInt(p ?? "50", 10);
        return isNaN(n) || n < 1 ? 50 : n;
    };

    /** Remove a specific filter entry from the URL when its badge is dismissed. */
    const onFilterDismiss = (field: string, value: string) => {
        const raw = searchParams.filter;
        const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
        // Match exact entry — both field and value must match
        const target = `${field}=${value}`;
        const remaining = entries.filter((e) => e !== target);
        setSearchParams({filter: remaining.length ? remaining : undefined});
    };

    const meta = () => data.getTableMeta(params.name);
    // Only attempt to load once the manifest is available (meta !== undefined) AND the table is static/public
    const canLoad = () => {
        const m = meta();
        return m != null && isStaticTable(params.name) && (m.isPublic ?? true);
    };

    const [rows] = createResource(
        () => canLoad() ? {tag: data.tag(), name: params.name} : null,
        (s) => data.fetchTable(s.name)
    );

    createEffect(() => {
        nav.push({path: `/table/${params.name}`, label: `⊞ ${params.name}`});
    });

    const outgoingRefs = () => data.getOutgoingRefs(params.name);
    const incomingRefs = () => data.getIncomingRefs(params.name);
    const hasRefs = () => outgoingRefs().length > 0 || incomingRefs().length > 0;
    const tableNotFound = () => !data.tableIndex.loading && data.getTableMeta(params.name) == null;

    const typeCtx = () => data.getTypeContext();
    const schemaTable = () => typeCtx()?.schema.tables?.find((t) => t.name === params.name);
    const columnType = (col: string) => data.getColumnType(params.name, col);

    return (
        <div class="w-full min-w-[min(67vw,100%)] mx-auto space-y-6">
            <Title>{`${params.name} — cereal`}</Title>

            <Show when={tableNotFound()}>
                <TableNotFound name={params.name}/>
            </Show>

            <Show when={!tableNotFound()}>
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <h1 class="text-2xl font-bold font-mono">{params.name}</h1>
                        <A
                            href={`/graph/${params.name}`}
                            class="text-xs px-2 py-1 rounded-sm bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                            title="View FK graph for this table"
                        >
                            ⬡ graph
                        </A>
                        <CompareButton
                            currentTag={data.tag()}
                            buildHref={(other) => `/compare/${params.name}?from=${other}&to=${data.tag()}`}
                        />
                    </div>
                    <Show when={meta()}>
                        {(m) => (
                            <div class="flex gap-2 text-xs text-text-muted">
                                <Show when={!m().isPublic}>
                                    <span class="px-2 py-1 rounded-sm bg-surface-2 border border-border"
                                          title="Private table — no data available">🔒 Private</span>
                                </Show>
                                <Show when={!isStaticTable(params.name)}>
                                    <span
                                        class="px-2 py-1 rounded-sm bg-surface-2 border border-border">⚙️ Non-static</span>
                                </Show>
                                <span
                                    class="px-2 py-1 rounded-sm bg-surface-2 border border-border">{m().columns.length} columns</span>
                                <Show when={m().rowCount > 0}>
                                    <span
                                        class="px-2 py-1 rounded-sm bg-surface-2 border border-border">{m().rowCount.toLocaleString()} rows</span>
                                </Show>
                            </div>
                        )}
                    </Show>
                </div>

                {/* FK References — collapsible */}
                <Show when={hasRefs()}>
                    <div class="rounded-lg border border-border overflow-hidden">
                        <button
                            class="w-full flex items-center justify-between px-4 py-2 bg-surface-1 hover:bg-surface-2 transition-colors text-sm font-medium"
                            onClick={() => setRefsOpen((o) => !o)}
                            aria-expanded={refsOpen()}
                        >
                            <span>References</span>
                            <span class="text-text-muted text-xs">
              {refsOpen() ? "▲" : "▼"}
                                {" "}
                                <Show when={outgoingRefs().length > 0}>
                <span class="ml-1">{outgoingRefs().length} outgoing</span>
              </Show>
              <Show when={incomingRefs().length > 0}>
                <span class="ml-1">{incomingRefs().length} incoming</span>
              </Show>
            </span>
                        </button>
                        <Show when={refsOpen()}>
                            <div class="px-4 py-3 space-y-3 bg-surface-0 border-t border-border">
                                <Show when={outgoingRefs().length > 0}>
                                    <div>
                                        <p class="text-xs text-text-muted mb-2 uppercase tracking-wide">This table
                                            references</p>
                                        <div class="flex flex-wrap gap-2">
                                            <For each={outgoingRefs()}>
                                                {(fk) => {
                                                    const isCircular = fk.targetTable === params.name;
                                                    return (
                                                        <A
                                                            href={`/table/${fk.targetTable}`}
                                                            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-1 border border-border hover:border-primary hover:text-primary text-xs font-mono transition-colors"
                                                            title={isCircular ? "Recursive/self-referential" : undefined}
                                                        >
                                                            <Show when={isCircular}>
                                                                <span aria-label="Recursive reference">🔁</span>
                                                            </Show>
                                                            <span class="text-text-muted">{fk.sourceField} →</span>
                                                            <span>{fk.targetTable}</span>
                                                        </A>
                                                    );
                                                }}
                                            </For>
                                        </div>
                                    </div>
                                </Show>
                                <Show when={incomingRefs().length > 0}>
                                    <div>
                                        <p class="text-xs text-text-muted mb-2 uppercase tracking-wide">Referenced
                                            by</p>
                                        <div class="flex flex-wrap gap-2">
                                            <For each={incomingRefs()}>
                                                {(fk) => {
                                                    const isCircular = fk.sourceTable === params.name;
                                                    return (
                                                        <A
                                                            href={`/table/${fk.sourceTable}`}
                                                            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-surface-1 border border-border hover:border-primary hover:text-primary text-xs font-mono transition-colors"
                                                            title={isCircular ? "Recursive/self-referential" : undefined}
                                                        >
                                                            <Show when={isCircular}>
                                                                <span aria-label="Recursive reference">🔁</span>
                                                            </Show>
                                                            <span>{fk.sourceTable}</span>
                                                            <span class="text-text-muted">← {fk.sourceField}</span>
                                                        </A>
                                                    );
                                                }}
                                            </For>
                                        </div>
                                    </div>
                                </Show>
                            </div>
                        </Show>
                    </div>
                </Show>

                <Show when={!canLoad() && meta()}>
                    {(m) => (
                        <div class="space-y-2">
                            <div class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                                {!isStaticTable(params.name)
                                    ? "This table contains runtime state. Cereal only comes in static flavors."
                                    : "This table is private and its contents are not accessible."}
                            </div>
                            <ColumnStructure meta={m()} fks={outgoingRefs()} tableName={params.name}
                                             schemaTable={schemaTable()} columnType={columnType} typeCtx={typeCtx()}/>
                        </div>
                    )}
                </Show>

                <Show when={canLoad()}>
                    <Suspense fallback={<div class="flex justify-center py-16"><LoadingSpinner size="lg"
                                                                                               label="Loading table data…"/>
                    </div>}>
                        <Show
                            when={rows() !== undefined && meta()}
                            fallback={null}
                        >
                            <Show
                                when={rows()!.length > 0}
                                fallback={
                                    <div class="space-y-2">
                                        <div
                                            class="p-4 rounded-lg bg-surface-1 border border-border text-sm text-text-muted">
                                            This table is empty in the current version.
                                        </div>
                                        <ColumnStructure meta={meta()!} fks={outgoingRefs()} tableName={params.name}
                                                         schemaTable={schemaTable()} columnType={columnType} typeCtx={typeCtx()}/>
                                    </div>
                                }
                            >
                                <CollapsibleSchema meta={meta()!} fks={outgoingRefs()} tableName={params.name}/>
                                <DataTable tableName={params.name} rows={rows()!} meta={meta()!}
                                           initialFilters={initialFilters()} initialPage={initialPage()}
                                           initialPageSize={initialPageSize()}
                                           initialGlobalFilter={initialGlobalFilter()}
                                           onFilterDismiss={onFilterDismiss}/>
                            </Show>
                        </Show>
                    </Suspense>
                </Show>
            </Show>
        </div>
    );
}
