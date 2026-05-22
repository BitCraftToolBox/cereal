import {
    type ColumnDef,
    type ColumnFiltersState,
    type ColumnOrderState,
    createSolidTable,
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type SortingState,
    type VisibilityState,
} from "@tanstack/solid-table";
import {createEffect, createMemo, createSignal, For, onCleanup, onMount, Show} from "solid-js";
import {A} from "@solidjs/router";
import {ForeignKeyMapping, resolveTargetTable} from "~/lib/schema";
import {type ResolvedTableMeta, useData} from "~/lib/data";
import {SpriteLink} from "~/components/SpriteImage";
import {createDisplayNameMap, outgoingDisplayTables} from "~/lib/objectRefs";

const isScalar = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

interface DataTableProps {
    tableName: string;
    rows: Record<string, unknown>[];
    meta: ResolvedTableMeta;
    initialFilters?: { field: string; value: string }[];
    initialPage?: number;
    initialPageSize?: number;
    initialGlobalFilter?: string;
    onFilterDismiss?: (field: string, value: string) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single scalar FK value: a link with optional display-name tooltip. */
function FkLink(props: {
    targetTable: string | null | undefined;
    id: unknown;
    displayNames: () => Map<string, Map<string, string>>;
    enumVariants?: string[];
}) {
    const idStr = () => String(props.id);
    const resolvedId = () => {
        if (props.enumVariants && typeof props.id === "string") {
            const idx = props.enumVariants.indexOf(props.id);
            return idx !== -1 ? String(idx) : idStr();
        }
        return idStr();
    };
    const label = () => props.targetTable ? props.displayNames().get(props.targetTable)?.get(resolvedId()) : undefined;
    return (
        <A
            href={`/table/${props.targetTable}/${encodeURIComponent(resolvedId())}`}
            class="text-primary hover:underline font-mono"
            title={`${props.targetTable ?? "unlinked"} #${resolvedId()}`}
        >
            {label() ?? idStr()}
        </A>
    );
}

/** Expandable list cell — scalar or object items. */
function ListCell(props: {
    items: unknown[];
    fks: ForeignKeyMapping[];
    displayNames: () => Map<string, Map<string, string>>;
    forceOpen?: boolean;
    enumValues?: Record<string, string[]>;
    enumVariantsByField: Map<string, string[]>;
}) {
    const [open, setOpen] = createSignal(props.items.length === 1);
    createEffect(() => {
        if (props.forceOpen !== undefined) setOpen(props.forceOpen);
    });
    const scalarFk = () => props.fks.find((fk) => !fk.sourceField.includes("."));
    const scalarEnumVariants = () => {
        const fk = scalarFk();
        return fk ? props.enumVariantsByField.get(fk.sourceField) : undefined;
    };
    return (
        <span>
            <button
                class="text-text-muted text-xs hover:text-primary font-mono"
                onClick={() => setOpen((o) => !o)}
                title={open() ? "Collapse" : "Expand"}
            >
            {open() ? "▼" : "▶"} [{props.items.length}]
            </button>
            <Show when={open()}>
                <ul class="mt-1 space-y-0.5 pl-2 border-l border-border">
                    <For each={props.items}>
                    {(item) => {
                        const resolvedScalarTarget = () => {
                            const fk = scalarFk();
                            if (!fk || !isScalar(item)) return undefined;
                            if (!fk.conditionalTargets?.length) return fk.targetTable;
                            // For scalar list items, context is the item itself won't have the sibling —
                            // use the parent context (the fk.sourceField parent object) if available.
                            return fk.targetTable; // fallback; sibling-based resolution not possible for plain scalar lists
                        };
                        return (
                            <li class="text-xs font-mono">
                                <Show
                                    when={scalarFk() && isScalar(item)}
                                    fallback={
                                        <Show
                                            when={item !== null && typeof item === "object"}
                                            fallback={<span>{String(item)}</span>}
                                        >
                                            <ObjectSummary
                                                obj={item as Record<string, unknown>}
                                                fks={props.fks}
                                                displayNames={props.displayNames}
                                                enumValues={props.enumValues}
                                                enumVariantsByField={props.enumVariantsByField}
                                            />
                                        </Show>
                                    }
                                >
                                    <FkLink targetTable={resolvedScalarTarget()!} id={item}
                                            displayNames={props.displayNames}
                                            enumVariants={scalarEnumVariants()}/>
                                </Show>
                            </li>
                        );
                    }}
                    </For>
                </ul>
            </Show>
        </span>
    );
}

/** Renders any value inline: scalar, FK link, nested object, or array. */
function InlineValue(props: {
    k: string;
    v: unknown;
    fkByLeaf: () => Map<string, ForeignKeyMapping>;
    displayNames: () => Map<string, Map<string, string>>;
    contextObj?: Record<string, unknown>;
    enumValues?: Record<string, string[]>;
    enumVariantsByField: Map<string, string[]>;
}) {
    const fk = () => isScalar(props.v) ? props.fkByLeaf().get(props.k) : undefined;
    const resolvedTarget = () => {
        const f = fk();
        if (!f) return undefined;
        if (!f.conditionalTargets?.length) return f.targetTable;
        return resolveTargetTable(f, props.contextObj ?? {}, props.enumValues);
    };
    const enumVariants = () => {
        const f = fk();
        if (!f?.enumConversion) return undefined;
        return props.enumVariantsByField.get(f.sourceField);
    };
    return (
        <Show when={fk()}
              fallback={
                  <Show when={Array.isArray(props.v)}
                        fallback={
                            <Show when={props.v !== null && typeof props.v === "object"}
                                  fallback={<span>{String(props.v)}</span>}
                            >
                                <ObjectSummary
                                    obj={props.v as Record<string, unknown>}
                                    fks={[]}
                                    displayNames={props.displayNames}
                                    fkByLeafOverride={props.fkByLeaf}
                                    enumValues={props.enumValues}
                                    enumVariantsByField={props.enumVariantsByField}
                                />
                            </Show>
                        }
                  >
                      <span class="text-text-muted">
                          {"["}
                          <For each={props.v as unknown[]}>
                              {(item, i) => (
                                  <span>
                                      <Show when={i() > 0}>, </Show>
                                      <InlineValue k={props.k} v={item} fkByLeaf={props.fkByLeaf} displayNames={props.displayNames}
                                                   contextObj={props.contextObj} enumValues={props.enumValues}
                                                   enumVariantsByField={props.enumVariantsByField}/>
                                  </span>
                              )}
                          </For>
                          {"]"}
                      </span>
                  </Show>
              }
        >
            <FkLink targetTable={resolvedTarget()} id={props.v} displayNames={props.displayNames}
                    enumVariants={enumVariants()}/>
        </Show>
    );
}

/** One-line key:value summary of an object, with FK links for known id fields. */
function ObjectSummary(props: {
    obj: Record<string, unknown>;
    fks: ForeignKeyMapping[];
    displayNames: () => Map<string, Map<string, string>>;
    fkByLeafOverride?: () => Map<string, ForeignKeyMapping>;
    enumValues?: Record<string, string[]>;
    enumVariantsByField: Map<string, string[]>;
}) {
    const fkByLeaf = createMemo(() => {
        if (props.fkByLeafOverride) return props.fkByLeafOverride();
        const m = new Map<string, ForeignKeyMapping>();
        for (const fk of props.fks) {
            const parts = fk.sourceField.split(".");
            m.set(parts[parts.length - 1], fk);
        }
        return m;
    });
    const entries = () => Object.entries(props.obj);
    return (
        <span class="text-text-muted">
            {"{ "}
            <For each={entries()}>
                {([k, v], i) => (
                    <span>
                        <Show when={i() > 0}>, </Show>
                        <span class="text-text">{k}: </span>
                        <InlineValue k={k} v={v} fkByLeaf={fkByLeaf} displayNames={props.displayNames} contextObj={props.obj}
                                     enumValues={props.enumValues} enumVariantsByField={props.enumVariantsByField}/>
                    </span>
                )}
            </For>
            {" }"}
        </span>
    );
}

// ---------------------------------------------------------------------------
// Main DataTable
// ---------------------------------------------------------------------------

export function DataTable(props: DataTableProps) {
    const data = useData();
    const [sorting, setSorting] = createSignal<SortingState>([]);
    const initFilters = (): ColumnFiltersState => {
        // Group by top-level column id so multiple filters on the same column share one entry
        const grouped = new Map<string, string[]>();
        for (const f of props.initialFilters ?? []) {
            const parts = f.field.split(".");
            const colId = parts[0];
            const encodedValue = parts.length > 1 ? `${parts.slice(1).join(".")}::${f.value}` : f.value;
            if (!grouped.has(colId)) grouped.set(colId, []);
            grouped.get(colId)!.push(encodedValue);
        }
        return [...grouped.entries()].map(([id, values]) => ({
            id,
            value: values.length === 1 ? values[0] : values,
        }));
    };
    const [columnFilters, setColumnFilters] = createSignal<ColumnFiltersState>(initFilters());
    const [columnVisibility, setColumnVisibility] = createSignal<VisibilityState>({});
    const [columnOrder, setColumnOrder] = createSignal<ColumnOrderState>([]);
    const [globalFilter, setGlobalFilter] = createSignal(props.initialGlobalFilter ?? "");
    const [showColumnPicker, setShowColumnPicker] = createSignal(false);
    // Per-column expand-all state for list columns (col -> boolean)
    const [listExpanded, setListExpanded] = createSignal<Record<string, boolean>>({});
    const toggleListExpanded = (col: string) =>
        setListExpanded((prev) => ({...prev, [col]: !prev[col]}));
    const isListExpanded = (col: string) => listExpanded()[col];

    // FK mappings for this table — grouped by top-level column name
    const fks = createMemo(() => data.getOutgoingRefs(props.tableName));
    const fksByColumn = createMemo(() => {
        const m = new Map<string, ForeignKeyMapping[]>();
        for (const fk of fks()) {
            const col = fk.sourceField.split(".")[0];
            if (!m.has(col)) m.set(col, []);
            m.get(col)!.push(fk);
        }
        return m;
    });

    // Resolve enumConversion names → variant arrays (once, when fks change)
    const enumVariantsByField = createMemo(() => {
        const m = new Map<string, string[]>();
        for (const fk of fks()) {
            if (fk.enumConversion) {
                const variants = data.getEnum(fk.enumConversion);
                if (variants) m.set(fk.sourceField, variants);
            }
        }
        return m;
    });

    // Fetch display names for all FK target tables that have a displayField
    const {displayNames} = createDisplayNameMap(
        createMemo(() => outgoingDisplayTables(props.tableName, data)),
        data,
    );

    // Detect which columns are list-type (check first non-null value)
    const listColumns = createMemo(() => {
        const cols = new Set<string>();
        for (const col of props.meta.columns) {
            const sample = props.rows.find((r) => r[col] !== null && r[col] !== undefined)?.[col];
            if (Array.isArray(sample)) cols.add(col);
        }
        return cols;
    });

    const columns = createMemo<ColumnDef<Record<string, unknown>>[]>(() => {
        if (props.rows.length === 0) return [];
        return props.meta.columns.map((col) => ({
            accessorKey: col,
            header: col,
            cell: (info) => {
                const value = info.getValue();
                const colFks = fksByColumn().get(col) ?? [];
                const scalarFk = colFks.find((fk) => fk.sourceField === col);

                if (col === props.meta.primaryKey) {
                    return (
                        <A
                            href={`/table/${props.tableName}/${encodeURIComponent(String(value))}`}
                            class="text-primary hover:underline font-mono"
                        >
                            {String(value)}
                        </A>
                    );
                }

                if (Array.isArray(value)) {
                    return <ListCell items={value} fks={colFks} displayNames={displayNames}
                                     forceOpen={isListExpanded(col)} enumValues={props.meta.enumValues}
                                     enumVariantsByField={enumVariantsByField()}/>;
                }

                if (value !== null && typeof value === "object") {
                    return <ObjectSummary obj={value as Record<string, unknown>} fks={colFks}
                                          displayNames={displayNames} enumValues={props.meta.enumValues}
                                          enumVariantsByField={enumVariantsByField()}/>;
                }

                if (scalarFk && value !== null && value !== undefined && value !== 0) {
                    return <FkLink targetTable={scalarFk.targetTable} id={value} displayNames={displayNames}
                                   enumVariants={scalarFk.enumConversion ? enumVariantsByField().get(scalarFk.sourceField) : undefined}/>;
                }

                // noinspection SuspiciousTypeOfGuard
                if (props.meta.spriteFields.includes(col) && typeof value === "string" && value.length > 1) {
                    return <SpriteLink path={value}/>;
                }

                // Plain scalar
                return String(value ?? "");
            },
            enableSorting: typeof props.rows[0]?.[col] !== "object" || Array.isArray(props.rows[0]?.[col]),
            enableColumnFilter: typeof props.rows[0]?.[col] !== "object",
            filterFn: (row, columnId, filterValue) => {
                // filterValue may be a single encoded string or an array of them
                const filters = Array.isArray(filterValue)
                    ? (filterValue as string[]).map(String)
                    : [String(filterValue)];

                // Parse each filter into subPath + needle
                const parsed = filters.map((raw) => {
                    const sep = raw.indexOf("::");
                    const subPath = sep !== -1 ? raw.slice(0, sep).split(".") : [];
                    const needle = (sep !== -1 ? raw.slice(sep + 2) : raw).toLowerCase();
                    return {subPath, needle};
                });

                // Group conditions by their parent path (all but the last segment).
                // Conditions sharing a parent path must be satisfied by the SAME item.
                type Condition = { field: string; needle: string };
                const groups = new Map<string, { parentPath: string[]; conditions: Condition[] }>();
                for (const {subPath, needle} of parsed) {
                    const parentPath = subPath.slice(0, -1);
                    const field = subPath[subPath.length - 1] ?? "";
                    const key = parentPath.join(".");
                    if (!groups.has(key)) groups.set(key, {parentPath, conditions: []});
                    groups.get(key)!.conditions.push({field, needle});
                }

                // Checks whether a single leaf object satisfies all conditions in a group
                function allMatch(obj: unknown, conditions: Condition[]): boolean {
                    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
                    const o = obj as Record<string, unknown>;
                    return conditions.every(({field, needle}) =>
                        field === "" ? false : String(o[field] ?? "").toLowerCase() === needle
                    );
                }

                // Checks a single item (object or scalar) against a set of conditions.
                function itemMatches(item: unknown, conditions: Condition[]): boolean {
                    if (item !== null && typeof item === "object" && !Array.isArray(item))
                        return allMatch(item, conditions);
                    // Scalar: only valid when there's a single no-field condition
                    if (conditions.length === 1 && conditions[0].field === "")
                        return String(item ?? "").toLowerCase() === conditions[0].needle;
                    return false;
                }

                // Navigates to parentPath in v (traversing arrays), then checks that at least
                // one item satisfies ALL conditions simultaneously.
                function matchesGroup(v: unknown, path: string[], conditions: Condition[]): boolean {
                    if (path.length > 0) {
                        const [head, ...rest] = path;
                        if (Array.isArray(v)) return v.some((item) => matchesGroup(item, path, conditions));
                        if (v !== null && typeof v === "object")
                            return matchesGroup((v as Record<string, unknown>)[head], rest, conditions);
                        return false;
                    }
                    // Reached target level
                    if (Array.isArray(v)) return v.some((item) => itemMatches(item, conditions));
                    return itemMatches(v, conditions);
                }

                const rootValue = row.getValue(columnId);
                // All groups must match (AND across different parent paths)
                return [...groups.values()].every(({parentPath, conditions}) =>
                    matchesGroup(rootValue, parentPath, conditions)
                );
            },
            sortingFn: Array.isArray(props.rows[0]?.[col])
                ? (a, b) => ((a.getValue(col) as unknown[])?.length ?? 0) - ((b.getValue(col) as unknown[])?.length ?? 0)
                : "auto",
            size: col === props.meta.primaryKey ? 120 : undefined,
        }));
    });

    const [columnSizing, setColumnSizing] = createSignal<Record<string, number>>({});

    const table = createSolidTable({
        get data() {
            return props.rows;
        },
        get columns() {
            return columns();
        },
        state: {
            get sorting() {
                return sorting();
            },
            get columnFilters() {
                return columnFilters();
            },
            get columnVisibility() {
                return columnVisibility();
            },
            get globalFilter() {
                return globalFilter();
            },
            get columnOrder() {
                return columnOrder();
            },
            get columnSizing() {
                return columnSizing();
            },
        },
        onSortingChange: setSorting,
        onColumnFiltersChange: setColumnFilters,
        onColumnVisibilityChange: setColumnVisibility,
        onGlobalFilterChange: setGlobalFilter,
        onColumnSizingChange: (updater) =>
            setColumnSizing((prev) => typeof updater === "function" ? updater(prev) : updater),
        onColumnOrderChange: setColumnOrder,
        columnResizeMode: "onChange",
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getFilteredRowModel: getFilteredRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        initialState: {
            pagination: {
                pageIndex: props.initialPage ?? 0,
                pageSize: props.initialPageSize ?? 50,
            },
        },
    });

    // Reset to page 0 when navigating to a different table
    createEffect(() => {
        props.tableName; // track
        table.setPageIndex(props.initialPage ?? 0);
    });

    // Drag-to-reorder state
    let dragColId: string | null = null;
    let isResizing = false;
    let didResize = false;

    // Scroll sync for top/bottom scrollbars
    let tableScroll: HTMLDivElement | undefined;
    let topScroll: HTMLDivElement | undefined;
    let innerTable: HTMLTableElement | undefined;
    let syncingFrom: "top" | "bottom" | null = null;

    const onTopScroll = () => {
        if (syncingFrom === "bottom") return;
        syncingFrom = "top";
        if (tableScroll) tableScroll.scrollLeft = topScroll!.scrollLeft;
        syncingFrom = null;
    };
    const onBottomScroll = () => {
        if (syncingFrom === "top") return;
        syncingFrom = "bottom";
        if (topScroll) topScroll.scrollLeft = tableScroll!.scrollLeft;
        syncingFrom = null;
    };

    const onDragStart = (e: DragEvent, colId: string) => {
        if (isResizing) {
            e.preventDefault();
            return;
        }
        dragColId = colId;
        e.dataTransfer?.setData("text/plain", colId);
    };
    const onDrop = (e: DragEvent, targetColId: string) => {
        e.preventDefault();
        if (!dragColId || dragColId === targetColId) return;
        const order = table.getAllLeafColumns().map((c) => c.id);
        const from = order.indexOf(dragColId);
        const to = order.indexOf(targetColId);
        if (from === -1 || to === -1) return;
        const next = [...order];
        next.splice(from, 1);
        next.splice(to, 0, dragColId);
        setColumnOrder(next);
        dragColId = null;
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();

    // Distribute available container width evenly across visible columns.
    // Only redistributes if the table currently fits within the container (user hasn't expanded beyond it).
    const PKMinSize = 120;
    const ColMinSize = 80;

    function distributeWidths(containerWidth: number) {
        const visibleCols = table.getVisibleLeafColumns();
        if (visibleCols.length === 0) return;
        // If user has already made the table wider than the container, don't clobber their sizing.
        if (table.getTotalSize() > containerWidth + 4) return;
        const pkCol = props.meta.primaryKey;
        const pkCount = visibleCols.filter((c) => c.id === pkCol).length;
        const otherCount = visibleCols.length - pkCount;
        const reservedForPK = pkCount * PKMinSize;
        const remaining = Math.max(containerWidth - reservedForPK, otherCount * ColMinSize);
        const otherSize = otherCount > 0 ? Math.floor(remaining / otherCount) : ColMinSize;
        const sizing: Record<string, number> = {};
        for (const col of visibleCols) {
            sizing[col.id] = col.id === pkCol ? PKMinSize : Math.max(otherSize, ColMinSize);
        }
        setColumnSizing(sizing);
    }

    onMount(() => {
        const onMouseUp = () => {
            isResizing = false;
            // Defer so the click event (which fires after mouseup) still sees didResize=true
            setTimeout(() => {
                didResize = false;
            }, 0);
        };
        document.addEventListener("mouseup", onMouseUp);
        onCleanup(() => document.removeEventListener("mouseup", onMouseUp));

        if (!tableScroll || !innerTable || !topScroll) return;

        // Initial distribution
        distributeWidths(tableScroll.clientWidth);

        // Keep top scrollbar spacer in sync
        const spacer = topScroll.firstElementChild as HTMLElement;
        let rafId: number | undefined;
        const ro = new ResizeObserver(() => {
            // Defer to next animation frame to avoid synchronous layout loops
            if (rafId !== undefined) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                rafId = undefined;
                if (!innerTable || !tableScroll) return;
                spacer.style.width = innerTable.offsetWidth + "px";
                distributeWidths(tableScroll.clientWidth);
            });
        });
        ro.observe(tableScroll);
        ro.observe(innerTable);
        onCleanup(() => {
            if (rafId !== undefined) cancelAnimationFrame(rafId);
            ro.disconnect();
        });
    });

    return (
        <div class="space-y-3">
            {/* Toolbar */}
            <div class="flex flex-wrap items-center gap-3">
                <input
                    type="text"
                    placeholder={`Filter ${props.tableName}...`}
                    value={globalFilter()}
                    onInput={(e) => setGlobalFilter(e.currentTarget.value)}
                    class="px-3 py-1.5 rounded-md bg-surface-2 border border-border text-text placeholder:text-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-primary flex-1 min-w-[200px] max-w-md"
                    aria-label="Filter rows"
                />
                <span class="text-sm text-text-muted">
                    {table.getFilteredRowModel().rows.length} of {props.rows.length} rows
                </span>
                <For each={
                    (props.initialFilters ?? []).filter((f) => {
                        const colId = f.field.split(".")[0];
                        const parts = f.field.split(".");
                        const ev = parts.length > 1 ? `${parts.slice(1).join(".")}::${f.value}` : f.value;
                        return columnFilters().some((cf) => {
                            if (cf.id !== colId) return false;
                            if (Array.isArray(cf.value)) return (cf.value as string[]).includes(ev);
                            return cf.value === ev;
                        });
                    })
                }>
                    {(f) => {
                        const parts = f.field.split(".");
                        const encodedValue = parts.length > 1 ? `${parts.slice(1).join(".")}::${f.value}` : f.value;
                        return (
                            <span class="flex items-center gap-1 px-2 py-1 rounded-md bg-surface-2 border border-primary text-xs font-mono">
                                <span class="text-text-muted">{f.field} =</span>
                                <span class="text-primary">{f.value}</span>
                                <button
                                    class="ml-1 text-text-muted hover:text-primary"
                                    title="Clear filter"
                                    onClick={() => {
                                        const colId = parts[0];
                                        const ev = encodedValue;
                                        setColumnFilters((prev) => prev.flatMap((cf) => {
                                            if (cf.id !== colId) return [cf];
                                            if (Array.isArray(cf.value)) {
                                                const remaining = (cf.value as string[]).filter((v) => v !== ev);
                                                if (remaining.length === 0) return [];
                                                return [{id: colId, value: remaining.length === 1 ? remaining[0] : remaining}];
                                            }
                                            return cf.value === ev ? [] : [cf];
                                        }));
                                        props.onFilterDismiss?.(f.field, f.value);
                                    }}
                                >
                                    ✕
                                </button>
                            </span>
                        );
                    }}
                </For>
                <div class="ml-auto relative">
                    <button
                        onClick={() => setShowColumnPicker(!showColumnPicker())}
                        class="px-3 py-1.5 rounded-md bg-surface-2 border border-border text-sm hover:bg-surface-3 transition-colors"
                    >
                        Columns {showColumnPicker() ? "▲" : "▼"}
                    </button>
                    <Show when={showColumnPicker()}>
                        <div
                            class="absolute right-0 top-full mt-1 z-20 min-w-[220px] p-3 bg-surface-1 border border-border rounded-lg shadow-lg space-y-2 text-sm">
                            <div class="flex gap-2 pb-2 border-b border-border">
                                <button
                                    class="flex-1 px-2 py-1 rounded-sm bg-surface-2 hover:bg-surface-3 text-xs transition-colors"
                                    onClick={() => table.getAllLeafColumns().filter((c) => c.id !== props.meta.primaryKey).forEach((c) => c.toggleVisibility(true))}
                                >
                                    Select all
                                </button>
                                <button
                                    class="flex-1 px-2 py-1 rounded-sm bg-surface-2 hover:bg-surface-3 text-xs transition-colors"
                                    onClick={() => table.getAllLeafColumns().filter((c) => c.id !== props.meta.primaryKey).forEach((c) => c.toggleVisibility(false))}
                                >
                                    Deselect all
                                </button>
                            </div>
                            <div class="flex flex-col gap-1 max-h-72 overflow-y-auto">
                                <For each={table.getAllLeafColumns().filter((c) => c.id !== props.meta.primaryKey)}>
                                    {(column) => (
                                        <label class="flex items-center gap-2 cursor-pointer hover:text-text px-1 py-0.5 rounded-sm hover:bg-surface-2">
                                            <input
                                                type="checkbox"
                                                checked={column.getIsVisible()}
                                                onChange={column.getToggleVisibilityHandler()}
                                            />
                                            <span class="font-mono text-xs">{column.id}</span>
                                        </label>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Show>
                </div>
            </div>

            {/* Top scrollbar mirror + Table wrapped in one border */}
            <div class="rounded-lg border border-border overflow-hidden">
                <div
                    ref={topScroll}
                    onScroll={onTopScroll}
                    class="overflow-x-auto overflow-y-hidden border-b border-border scrollbar-thin bg-surface-2"
                    style="height: 16px"
                    aria-hidden="true"
                >
                    <div style="height: 1px"/>
                </div>
                <div
                    ref={tableScroll}
                    onScroll={onBottomScroll}
                    class="overflow-auto scrollbar-thin"
                >
                    <table
                        ref={innerTable}
                        class="text-sm"
                        role="grid"
                        style={{width: table.getTotalSize() + "px", "table-layout": "fixed"}}
                    >
                        <thead>
                        <For each={table.getHeaderGroups()}>
                            {(headerGroup) => (
                                <tr class="bg-surface-2">
                                    <For each={headerGroup.headers}>
                                        {(header) => (
                                            <th
                                                class="relative px-3 py-2 text-left font-medium text-text-muted whitespace-nowrap border-b border-border cursor-pointer select-none hover:bg-surface-3 transition-colors overflow-hidden"
                                                style={{
                                                    width: header.getSize() + "px",
                                                    "max-width": header.getSize() + "px"
                                                }}
                                                onClick={(e) => {
                                                    if (didResize) return;
                                                    header.column.getToggleSortingHandler()?.(e);
                                                }}
                                                draggable={true}
                                                onDragStart={(e) => onDragStart(e, header.column.id)}
                                                onDrop={(e) => onDrop(e, header.column.id)}
                                                onDragOver={onDragOver}
                                                aria-sort={
                                                    header.column.getIsSorted() === "asc" ? "ascending"
                                                        : header.column.getIsSorted() === "desc" ? "descending"
                                                            : "none"
                                                }
                                                title={typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.column.id}
                                            >
                                                <span class="inline-flex items-center gap-0.5 max-w-full overflow-hidden">
                                                    <span class="truncate">{flexRender(header.column.columnDef.header, header.getContext())}</span>
                                                    <Show when={header.column.getIsSorted()}>
                                                        <span class="shrink-0">{header.column.getIsSorted() === "asc" ? "↑" : "↓"}</span>
                                                    </Show>
                                                    <Show when={listColumns().has(header.column.id)}>
                                                        <button
                                                            class="shrink-0 ml-0.5 text-text-muted hover:text-primary transition-colors"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                toggleListExpanded(header.column.id);
                                                            }}
                                                            title={isListExpanded(header.column.id) ? "Collapse all" : "Expand all"}
                                                        >
                                                            {isListExpanded(header.column.id) ? "▼" : "▶"}
                                                        </button>
                                                    </Show>
                                                </span>
                                                {/* Resize handle */}
                                                <div
                                                    class="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none touch-none hover:bg-primary opacity-0 hover:opacity-100 transition-opacity"
                                                    draggable={false}
                                                    onDragStart={(e) => e.preventDefault()}
                                                    onMouseDown={(e) => {
                                                        e.stopPropagation();
                                                        isResizing = true;
                                                        didResize = true;
                                                        header.getResizeHandler()(e);
                                                    }}
                                                    onTouchStart={(e) => {
                                                        e.stopPropagation();
                                                        isResizing = true;
                                                        didResize = true;
                                                        header.getResizeHandler()(e);
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    classList={{"bg-primary opacity-100": header.column.getIsResizing()}}
                                                />
                                            </th>
                                        )}
                                    </For>
                                </tr>
                            )}
                        </For>
                        </thead>
                        <tbody>
                        <For each={table.getRowModel().rows}>
                            {(row) => (
                                <tr class="hover:bg-surface-1 transition-colors border-b border-border last:border-0">
                                    <For each={row.getVisibleCells()}>
                                        {(cell) => (
                                            <td class="px-3 py-1.5 max-w-xs overflow-hidden text-ellipsis align-top">
                                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                            </td>
                                        )}
                                    </For>
                                </tr>
                            )}
                        </For>
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination */}
            <div class="flex items-center justify-between text-sm text-text-muted">
                <div class="flex items-center gap-2">
                    <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
                            class="px-3 py-1 rounded-sm border border-border hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed">
                        Previous
                    </button>
                    <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
                            class="px-3 py-1 rounded-sm border border-border hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed">
                        Next
                    </button>
                </div>
                <span>Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}</span>
                <select value={table.getState().pagination.pageSize}
                        onChange={(e) => table.setPageSize(Number(e.currentTarget.value))}
                        class="px-2 py-1 rounded-sm bg-surface-2 border border-border" aria-label="Rows per page">
                    <For each={[...new Set([25, 50, 100, 250, table.getState().pagination.pageSize])].sort((a, b) => a - b)}>
                        {(size) => <option value={size}>{size} rows</option>}
                    </For>
                </select>
            </div>
        </div>
    );
}
