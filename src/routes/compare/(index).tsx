import {Title} from "@solidjs/meta";
import {A} from "@solidjs/router";
import {createEffect, createMemo, createResource, createSignal, For, Show} from "solid-js";
import {CompareHeader} from "~/components/CompareHeader";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {isStaticTable, useCompare} from "~/lib/data";
import {type DiffKind, diffTable, diffVersion, type RowDeltaMap, type SchemaChangeMap, type SchemaDiff} from "~/lib/diff";
import {useNavHistory} from "~/lib/navHistory";

export default function VersionCompareView() {
    const cmp = useCompare();
    const nav = useNavHistory();
    // false will disable fetching by default
    const [loadRows, setLoadRows] = createSignal(true);

    createEffect(() => {
        nav.push({path: `/compare`, label: `⇄ Compare`});
    });

    const fromManifest = () => cmp.fromStore.manifest();
    const toManifest = () => cmp.toStore.manifest();

    const fetchable = (name: string) => {
        const m = cmp.toStore.getTableMeta(name) ?? cmp.fromStore.getTableMeta(name);
        return isStaticTable(name) && (m?.isPublic ?? true);
    };

    // Cheap schema-change counts from the manifests' column lists (column add/remove only).
    const schemaChanges = createMemo((): SchemaChangeMap => {
        const a = fromManifest();
        const b = toManifest();
        const map: SchemaChangeMap = new Map();
        if (!a || !b) return map;
        const metaA = new Map(a.tables.map((t) => [t.name, t]));
        const metaB = new Map(b.tables.map((t) => [t.name, t]));
        for (const name of new Set([...metaA.keys(), ...metaB.keys()])) {
            const ca = metaA.get(name)?.columns ?? [];
            const cb = metaB.get(name)?.columns ?? [];
            const sa = new Set(ca), sb = new Set(cb);
            let count = 0;
            for (const col of new Set([...ca, ...cb])) if (sa.has(col) !== sb.has(col)) count++;
            if (count) map.set(name, count);
        }
        return map;
    });

    // Heavy: fetch + diff all fetchable tables for both versions.
    const [rowDeltas] = createResource(
        () => loadRows() && fromManifest() && toManifest()
            ? {from: cmp.fromTag(), to: cmp.toTag()} : null,
        async (): Promise<RowDeltaMap> => {
            const a = fromManifest()!;
            const b = toManifest()!;
            const metaA = new Map(a.tables.map((t) => [t.name, t]));
            const metaB = new Map(b.tables.map((t) => [t.name, t]));
            const names = [...new Set([...a.tables, ...b.tables].map((t) => t.name))].filter(fetchable);
            const map: RowDeltaMap = new Map();
            await Promise.all(names.map(async (name) => {
                const [ra, rb] = await Promise.all([
                    cmp.fromStore.fetchTable(name).catch(() => []),
                    cmp.toStore.fetchTable(name).catch(() => []),
                ]);
                // Build a column add/remove diff so rows that differ *only* because of a
                // schema column change aren't counted as content changes.
                const colsA = metaA.get(name)?.columns ?? [];
                const colsB = metaB.get(name)?.columns ?? [];
                const setA = new Set(colsA), setB = new Set(colsB);
                const columns: SchemaDiff["columns"] = [];
                for (const col of new Set([...colsA, ...colsB])) {
                    if (setA.has(col) && !setB.has(col)) columns.push({column: col, kind: "removed"});
                    else if (!setA.has(col) && setB.has(col)) columns.push({column: col, kind: "added"});
                }
                const d = diffTable(ra, rb, metaA.get(name), metaB.get(name),
                    {columns, indexes: [], changeCount: columns.length});
                if (d.added || d.removed || d.changed)
                    map.set(name, {added: d.added, removed: d.removed, changed: d.changed});
            }));
            return map;
        },
    );

    const versionDiff = createMemo(() => {
        const a = fromManifest();
        const b = toManifest();
        if (!a || !b) return undefined;
        return diffVersion(a, b, {
            rowDeltas: rowDeltas.latest,
            schemaChanges: schemaChanges(),
            fetchable,
        });
    });

    const loading = () => versionDiff() === undefined;

    const kindStyle: Record<DiffKind, string> = {
        added: "text-green-500",
        removed: "text-red-500",
        changed: "text-yellow-600 dark:text-yellow-400",
    };
    const kindSign: Record<DiffKind, string> = {added: "+", removed: "−", changed: "~"};

    const tableHref = (name: string) =>
        `/compare/${name}?from=${cmp.fromTag()}&to=${cmp.toTag()}`;

    return (
        <div class="w-full max-w-5xl mx-auto space-y-6">
            <Title>⇄ Compare versions — cereal</Title>
            <CompareHeader/>

            <Show when={!loading()} fallback={<div class="flex justify-center py-16"><LoadingSpinner size="lg" label="Loading manifests…"/></div>}>
                {/* Enum changes */}
                <Show when={versionDiff()!.enums.length > 0}>
                    <section class="space-y-2">
                        <h2 class="text-lg font-semibold">Enum changes</h2>
                        <div class="rounded-lg border border-border divide-y divide-border">
                            <For each={versionDiff()!.enums}>
                                {(e) => (
                                    <div class="px-4 py-2 text-sm">
                                        <span class={`font-mono font-medium ${kindStyle[e.kind]}`}>{kindSign[e.kind]} {e.name}</span>
                                        <Show when={e.addedValues?.length}>
                                            <span class="ml-2 text-xs text-green-500 font-mono">+{e.addedValues!.join(", +")}</span>
                                        </Show>
                                        <Show when={e.removedValues?.length}>
                                            <span class="ml-2 text-xs text-red-500 font-mono">−{e.removedValues!.join(", −")}</span>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </section>
                </Show>

                {/* Tables */}
                <section class="space-y-2">
                    <div class="flex items-center justify-between">
                        <h2 class="text-lg font-semibold">Tables</h2>
                        <Show when={!loadRows()} fallback={
                            <Show when={rowDeltas.loading}><span class="text-xs text-text-muted flex items-center gap-1"><LoadingSpinner size="sm"/> diffing rows…</span></Show>
                        }>
                            <button
                                onClick={() => setLoadRows(true)}
                                class="text-xs px-2 py-1 rounded-sm bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                                title="Fetch every table for both versions and diff their rows (slow)"
                            >
                                Compute row changes
                            </button>
                        </Show>
                    </div>
                    <Show when={versionDiff()!.tables.length > 0} fallback={
                        <p class="text-sm text-text-muted">No table structure differences. {loadRows() ? "" : "Compute row changes to find content differences."}</p>
                    }>
                        <div class="rounded-lg border border-border overflow-hidden divide-y divide-border">
                            <Show when={!rowDeltas.loading}>
                                <For each={versionDiff()!.tables}>
                                    {(t) => (
                                        <A href={tableHref(t.name)}
                                           class="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-2 transition-colors">
                                            <span class={`font-mono ${kindStyle[t.kind]}`}>{kindSign[t.kind]}</span>
                                            <span class="font-mono flex-1 min-w-0 truncate">{t.name}</span>
                                            <Show when={t.rowAdded || t.rowChanged || t.rowRemoved}>
                                                <span class="text-xs font-mono whitespace-nowrap">
                                                    <span class="text-green-500">+{t.rowAdded ?? 0}</span>{" "}
                                                    <span class="text-yellow-600 dark:text-yellow-400">~{t.rowChanged ?? 0}</span>{" "}
                                                    <span class="text-red-500">−{t.rowRemoved ?? 0}</span>
                                                </span>
                                            </Show>
                                            <Show when={t.schemaChanges > 0}>
                                                <span class="text-xs text-text-muted whitespace-nowrap">{t.schemaChanges} schema</span>
                                            </Show>
                                            <Show when={!t.fetchable}>
                                                <span class="text-xs text-text-muted">🔒</span>
                                            </Show>
                                        </A>
                                    )}
                                </For>
                            </Show>
                        </div>
                    </Show>
                </section>
            </Show>
        </div>
    );
}


