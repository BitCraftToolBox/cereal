import {createEffect, createResource, createSignal, For, Show, Suspense} from "solid-js";
import {A, useParams, useSearchParams} from "@solidjs/router";
import {isStaticTable, type ResolvedTableMeta, useData} from "~/lib/data";
import {DataTable} from "~/components/DataTable";
import {Title} from "@solidjs/meta";
import {useNavHistory} from "~/lib/navHistory";
import type {ForeignKeyMapping} from "~/lib/schema";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {AlgebraicTypeView} from "~/components/AlgebraicTypeView";
import {TableNotFound} from "~/components/NotFound";

function ColumnStructure(props: { meta: ResolvedTableMeta; fks: ForeignKeyMapping[]; tableName: string }) {
    const data = useData();

    const fksByCol = () => {
        const m = new Map<string, ForeignKeyMapping[]>();
        for (const fk of props.fks) {
            const col = fk.sourceField.split(".")[0];
            if (!m.has(col)) m.set(col, []);
            m.get(col)!.push(fk);
        }
        return m;
    };

    const schemaTable = () => {
        const schema = data.getTypeContext()?.schema;
        if (!schema) return undefined;
        return schema.tables?.find((t) => t.name === props.tableName);
    };

    const columnIndex = (colName: string) => {
        return props.meta.columns.indexOf(colName);
    };

    const hasUniqueConstraint = (colName: string) => {
        const table = schemaTable();
        if (!table?.constraints) return false;
        const colIdx = columnIndex(colName);
        return table.constraints.some((c) => c.data?.Unique?.columns?.includes(colIdx));
    };

    const getIndexInfo = (colName: string) => {
        const table = schemaTable();
        if (!table?.indexes) return undefined;
        const colIdx = columnIndex(colName);
        const matchingIndexes = table.indexes.filter((idx) => {
            const cols = idx.algorithm?.BTree ?? idx.algorithm?.Hash ?? idx.algorithm?.Direct ?? [];
            return Array.isArray(cols) ? cols.includes(colIdx) : cols === colIdx;
        });
        if (matchingIndexes.length === 0) return undefined;
        
        return matchingIndexes.map((idx) => {
            const cols = idx.algorithm?.BTree ?? idx.algorithm?.Hash ?? idx.algorithm?.Direct ?? [];
            if (typeof cols === 'number' || cols.length === 1) {
                return { type: "single" as const, name: idx.accessor_name?.some ?? idx.name?.some };
            } else if (cols.length > 1) {
                const colNames = cols.map((i) => props.meta.columns[i]).filter(Boolean);
                return { type: "multi" as const, name: idx.accessor_name?.some ?? idx.name?.some, columns: colNames };
            }
            // unknown index types should have been filtered by `matchingIndex` before so this *shouldn't* happen
            return null;
        }).filter((v: any): v is NonNullable<typeof v> => !!v);
    };

    return (
        <div class="rounded-lg border border-border overflow-hidden">
            <table class="w-full text-sm">
                <thead class="bg-surface-2">
                <tr>
                    <th class="px-4 py-2 text-left font-medium text-text-muted">Column</th>
                    <th class="px-4 py-2 text-left font-medium text-text-muted">Type</th>
                </tr>
                </thead>
                <tbody>
                <For each={props.meta.columns}>
                    {(col) => {
                        const enumVariants = () => props.meta.enumValues?.[col];
                        const colFks = () => fksByCol().get(col) ?? [];
                        const colTypeRaw = () => data.getColumnType(props.tableName, col);
                        const ctx = () => data.getTypeContext();
                        const indexInfo = () => getIndexInfo(col);
                        return (
                            <tr class="border-t border-border align-top">
                                <td class="px-4 py-2 font-mono text-text">
                                    <div class="flex flex-wrap items-center gap-1">
                                        <Show when={col === props.meta.primaryKey}>
                                            <span
                                                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted"
                                                title="Primary Key - always unique and indexed">PK</span>
                                        </Show>
                                        <Show when={enumVariants()}>
                                            <span
                                                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted">enum</span>
                                        </Show>
                                        <Show when={colFks().length > 0}>
                                            <span
                                                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted"
                                                title="Foreign key">FK</span>
                                        </Show>
                                        <Show when={col !== props.meta.primaryKey && hasUniqueConstraint(col)}>
                                            <span
                                                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted"
                                                title="Unique constraint">UNIQUE</span>
                                        </Show>
                                        <Show when={col !== props.meta.primaryKey}>
                                            <For each={indexInfo()}>
                                                {(idx) => (
                                                    <Show when={idx.type === "multi"}
                                                        fallback={
                                                            <span
                                                                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted"
                                                                title={`Indexed on ${idx.name || "this column"}`}>IDX</span>
                                                        }
                                                    >
                                                        <span
                                                            class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-3 text-text-muted cursor-help"
                                                            title={`Multi-column index ${idx.name}: ${(idx as any).columns?.join(", ")}`}>IDX*</span>
                                                    </Show>
                                                )}
                                            </For>
                                        </Show>
                                        <span>{col}</span>
                                    </div>
                                    <Show when={colFks().length > 0}>
                                        <div class="flex flex-wrap gap-1 mt-1">
                                            <For each={colFks()}>
                                                {(fk) => (
                                                    <A
                                                        href={`/table/${fk.targetTable}`}
                                                        class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-2 border border-border hover:border-primary hover:text-primary transition-colors font-mono"
                                                        title={`${fk.sourceField} → ${fk.targetTable}.${fk.targetField ?? "id"}`}
                                                    >
                                                        → {fk.targetTable}
                                                    </A>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </td>
                                <td class="px-4 py-2 text-xs font-mono">
                                    <Show
                                        when={colTypeRaw() && ctx()}
                                        fallback={
                                            <Show when={enumVariants()}>
                                                <span class="text-violet-400/70">{enumVariants()!.join(" | ")}</span>
                                            </Show>
                                        }
                                    >
                                        <AlgebraicTypeView type={colTypeRaw()!} ctx={ctx()!}/>
                                    </Show>
                                </td>
                            </tr>
                        );
                    }}
                </For>
                </tbody>
            </table>
        </div>
    );
}

function CollapsibleSchema(props: { meta: ResolvedTableMeta; fks: ForeignKeyMapping[]; tableName: string }) {
    const [open, setOpen] = createSignal(false);
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
                    <ColumnStructure meta={props.meta} fks={props.fks} tableName={props.tableName}/>
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
    const canLoad = () => { const m = meta(); return m != null && isStaticTable(params.name) && (m.isPublic ?? true); };

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

    return (
        <div class="w-full min-w-[min(67vw,100%)] mx-auto space-y-6">
            <Title>{params.name} — cereal</Title>

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
                            <ColumnStructure meta={m()} fks={outgoingRefs()} tableName={params.name}/>
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
                                        <ColumnStructure meta={meta()!} fks={outgoingRefs()} tableName={params.name}/>
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
