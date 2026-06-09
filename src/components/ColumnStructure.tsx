import {A} from "@solidjs/router";
import {For, Show} from "solid-js";
import {AlgebraicTypeView} from "~/components/AlgebraicTypeView";
import type {ResolvedTableMeta} from "~/lib/data";
import type {DiffKind} from "~/lib/diff";
import type {AlgebraicType, ForeignKeyMapping, SchemaTable, SpacetimeDBSchema} from "~/lib/schema";

export interface ColumnStructureProps {
    meta: ResolvedTableMeta;
    fks: ForeignKeyMapping[];
    tableName: string;
    /** Raw schema table (for index/constraint badges). */
    schemaTable?: SchemaTable;
    /** Resolve a column's raw AlgebraicType. */
    columnType: (col: string) => AlgebraicType | undefined;
    /** Type context for rendering AlgebraicTypeView (schema + idxMap). */
    typeCtx?: { schema: SpacetimeDBSchema; idxMap: Map<number, string> };
    /** Optional per-column highlight map for compare views. */
    highlights?: Map<string, DiffKind>;
}

/** Tailwind classes for a column row given its diff highlight kind. */
function highlightClass(kind: DiffKind | undefined): string {
    switch (kind) {
        case "added":
            return "bg-green-500/10";
        case "removed":
            return "bg-red-500/10";
        case "changed":
            return "bg-yellow-500/10";
        default:
            return "";
    }
}

export function ColumnStructure(props: ColumnStructureProps) {
    const fksByCol = () => {
        const m = new Map<string, ForeignKeyMapping[]>();
        for (const fk of props.fks) {
            const col = fk.sourceField.split(".")[0];
            if (!m.has(col)) m.set(col, []);
            m.get(col)!.push(fk);
        }
        return m;
    };

    const columnIndex = (colName: string) => props.meta.columns.indexOf(colName);

    const hasUniqueConstraint = (colName: string) => {
        const table = props.schemaTable;
        if (!table?.constraints) return false;
        const colIdx = columnIndex(colName);
        return table.constraints.some((c) => c.data?.Unique?.columns?.includes(colIdx));
    };

    const getIndexInfo = (colName: string) => {
        const table = props.schemaTable;
        if (!table?.indexes) return undefined;
        const colIdx = columnIndex(colName);
        const matchingIndexes = table.indexes.filter((idx) => {
            const cols = idx.algorithm?.BTree ?? idx.algorithm?.Hash ?? idx.algorithm?.Direct ?? [];
            return Array.isArray(cols) ? cols.includes(colIdx) : cols === colIdx;
        });
        if (matchingIndexes.length === 0) return undefined;

        return matchingIndexes.map((idx) => {
            const cols = idx.algorithm?.BTree ?? idx.algorithm?.Hash ?? idx.algorithm?.Direct ?? [];
            if (typeof cols === "number" || cols.length === 1) {
                return {type: "single" as const, name: idx.accessor_name?.some ?? idx.name?.some};
            } else if (cols.length > 1) {
                const colNames = cols.map((i) => props.meta.columns[i]).filter(Boolean);
                return {type: "multi" as const, name: idx.accessor_name?.some ?? idx.name?.some, columns: colNames};
            }
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
                        const colTypeRaw = () => props.columnType(col);
                        const ctx = () => props.typeCtx;
                        const indexInfo = () => getIndexInfo(col);
                        const hl = () => props.highlights?.get(col);
                        return (
                            <tr class={`border-t border-border align-top ${highlightClass(hl())}`}>
                                <td class="px-4 py-2 font-mono text-text">
                                    <div class="flex flex-wrap items-center gap-1">
                                        <Show when={hl()}>
                                            <span
                                                class="text-xs px-1.5 py-0.5 rounded-sm font-medium"
                                                classList={{
                                                    "bg-green-500/20 text-green-500": hl() === "added",
                                                    "bg-red-500/20 text-red-500": hl() === "removed",
                                                    "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400": hl() === "changed",
                                                }}
                                                title={`Column ${hl()}`}
                                            >
                                                {hl() === "added" ? "+" : hl() === "removed" ? "−" : "~"}
                                            </span>
                                        </Show>
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
