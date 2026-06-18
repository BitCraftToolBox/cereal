import {Title} from "@solidjs/meta";
import {A} from "@solidjs/router";
import {createEffect, createMemo, createResource, createSignal, For, Show} from "solid-js";
import type {TableMeta} from "~/lib/schema";
import {CompareHeader} from "~/components/CompareHeader";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {isStaticTable, useCompare} from "~/lib/data";
import {type DiffKind, diffTable, diffVersion, type RowDeltaMap, type SchemaChangeMap, type SchemaDiff} from "~/lib/diff";
import {useNavHistory} from "~/lib/navHistory";
import {buildMigrationInfo} from "~/lib/schemaDerive";

export default function VersionCompareView() {
    const cmp = useCompare();
    const nav = useNavHistory();
    // false will disable fetching by default
    const [loadRows, setLoadRows] = createSignal(true);

    createEffect(() => {
        nav.push({path: `/compare?from=${cmp.fromTag()}&to=${cmp.toTag()}`, label: `⇄ Compare`});
    });

    const fromManifest = () => cmp.fromStore.manifest();
    const toManifest = () => cmp.toStore.manifest();

    const fromTableMetaByName = createMemo(() => {
        const m = fromManifest();
        return new Map((m?.tables ?? []).map((t) => [t.name, t] as const));
    });

    const toTableMetaByName = createMemo(() => {
        const m = toManifest();
        return new Map((m?.tables ?? []).map((t) => [t.name, t] as const));
    });

    const manifestMeta = (name: string): TableMeta | undefined =>
        toTableMetaByName().get(name) ?? fromTableMetaByName().get(name);

    // During version switches Solid resources can briefly expose previous values while the new
    // request is in flight. Require explicit tag match so compare logic never mixes versions.
    const manifestsMatchSelection = createMemo(() => {
        const from = cmp.fromTag();
        const to = cmp.toTag();
        const a = fromManifest();
        const b = toManifest();
        return !!a && !!b && a.tag === from && b.tag === to;
    });

    // Both schemas must be loaded before structural (column) info is available, since the
    // manifest no longer carries column lists — they're derived from region_schema.json.
    const schemasReady = () =>
        cmp.fromStore.getTypeContext() != null && cmp.toStore.getTypeContext() != null;

    // Logical tables, keyed by migration base: each side contributes its *current* (highest-N)
    // version, so a migrated `_vN` table is paired by base instead of appearing as remove+add.
    // Computed purely from manifest table names (no schema needed) so it's available early.
    const logicalTables = createMemo((): Array<{ base: string; from?: string; to?: string }> => {
        const a = fromManifest();
        const b = toManifest();
        if (!a || !b || !manifestsMatchSelection()) return [];
        const fromMig = buildMigrationInfo(a.tables.map((t) => t.name));
        const toMig = buildMigrationInfo(b.tables.map((t) => t.name));
        const bases = new Set([...fromMig.currentByBase.keys(), ...toMig.currentByBase.keys()]);
        return [...bases].map((base) => ({
            base,
            from: fromMig.currentByBase.get(base),
            to: toMig.currentByBase.get(base),
        }));
    });

    const fetchable = (name: string) => {
        const m = manifestMeta(name);
        return isStaticTable(name) && (m?.isPublic ?? true);
    };

    // Row-level diffs are only valid when *both* sides can actually be fetched.
    const pairFetchable = (fromName: string, toName: string) => {
        const fromMeta = fromTableMetaByName().get(fromName);
        const toMeta = toTableMetaByName().get(toName);
        const canFrom = fromMeta != null && isStaticTable(fromName) && (fromMeta.isPublic ?? true);
        const canTo = toMeta != null && isStaticTable(toName) && (toMeta.isPublic ?? true);
        return canFrom && canTo;
    };

    const singleFetchable = (name: string, side: "from" | "to") => {
        const meta = side === "from" ? fromTableMetaByName().get(name) : toTableMetaByName().get(name);
        return meta != null && isStaticTable(name) && (meta.isPublic ?? true);
    };

    // Column add/remove counts, sourced from the schema-derived column lists (both schemas
    // loaded), keyed by migration base and paired against each side's current version.
    const schemaChanges = createMemo((): SchemaChangeMap => {
        const map: SchemaChangeMap = new Map();
        if (!fromManifest() || !toManifest() || !schemasReady()) return map;
        for (const {base, from, to} of logicalTables()) {
            if (!from || !to) continue;
            const ca = cmp.fromStore.getColumns(from);
            const cb = cmp.toStore.getColumns(to);
            const sa = new Set(ca), sb = new Set(cb);
            let count = 0;
            for (const col of new Set([...ca, ...cb])) if (sa.has(col) !== sb.has(col)) count++;
            if (count) map.set(base, count);
        }
        return map;
    });

    const rowDeltaSource = createMemo(() => {
        if (!loadRows() || !manifestsMatchSelection() || !schemasReady()) return null;
        const from = cmp.fromTag();
        const to = cmp.toTag();
        const twoSided = logicalTables()
            .filter((lt) => lt.from && lt.to && pairFetchable(lt.from!, lt.to!))
            .map((lt) => {
                const fromName = lt.from!;
                const toName = lt.to!;
                return {
                    kind: "two-sided" as const,
                    base: lt.base,
                    from: fromName,
                    to: toName,
                    fromMeta: fromTableMetaByName().get(fromName),
                    toMeta: toTableMetaByName().get(toName),
                    fromCols: cmp.fromStore.getColumns(fromName),
                    toCols: cmp.toStore.getColumns(toName),
                };
            });

        const addedOnly = logicalTables()
            .filter((lt) => !lt.from && lt.to && singleFetchable(lt.to, "to"))
            .map((lt) => ({
                kind: "added-only" as const,
                base: lt.base,
                to: lt.to!,
            }));

        const removedOnly = logicalTables()
            .filter((lt) => lt.from && !lt.to && singleFetchable(lt.from, "from"))
            .map((lt) => ({
                kind: "removed-only" as const,
                base: lt.base,
                from: lt.from!,
            }));

        return {from, to, pairs: [...twoSided, ...addedOnly, ...removedOnly]};
    });

    const [rowDeltas] = createResource(
        rowDeltaSource,
        async (s): Promise<{ from: string; to: string; deltas: RowDeltaMap }> => {
            const map: RowDeltaMap = new Map();
            await Promise.all(s.pairs.map(async (p) => {
                if (p.kind === "two-sided") {
                    const [ra, rb] = await Promise.all([
                        cmp.fromStore.fetchTableFor(s.from, p.from).catch(() => null),
                        cmp.toStore.fetchTableFor(s.to, p.to).catch(() => null),
                    ]);
                    // A failed fetch (404/private/network) must not be interpreted as "empty table",
                    // or we'd report false added/removed rows. Skip row deltas for this base instead.
                    if (!ra || !rb) return;
                    // Build a column add/remove diff so rows that differ *only* because of a
                    // schema column change aren't counted as content changes.
                    const setA = new Set(p.fromCols), setB = new Set(p.toCols);
                    const columns: SchemaDiff["columns"] = [];
                    for (const col of new Set([...p.fromCols, ...p.toCols])) {
                        if (setA.has(col) && !setB.has(col)) columns.push({column: col, kind: "removed"});
                        else if (!setA.has(col) && setB.has(col)) columns.push({column: col, kind: "added"});
                    }
                    const d = diffTable(ra, rb, p.fromMeta, p.toMeta,
                        {columns, indexes: [], changeCount: columns.length});
                    if (d.added || d.removed || d.changed)
                        map.set(p.base, {added: d.added, removed: d.removed, changed: d.changed});
                    return;
                }

                if (p.kind === "added-only") {
                    const rows = await cmp.toStore.fetchTableFor(s.to, p.to).catch(() => null);
                    if (!rows) return;
                    if (rows.length > 0) map.set(p.base, {added: rows.length, removed: 0, changed: 0});
                    return;
                }

                const rows = await cmp.fromStore.fetchTableFor(s.from, p.from).catch(() => null);
                if (!rows) return;
                if (rows.length > 0) map.set(p.base, {added: 0, removed: rows.length, changed: 0});
            }));
            return {from: s.from, to: s.to, deltas: map};
        },
    );

    const versionDiff = createMemo(() => {
        const a = fromManifest();
        const b = toManifest();
        if (!a || !b || !manifestsMatchSelection()) return undefined;

        const currentFrom = cmp.fromTag();
        const currentTo = cmp.toTag();
        const latest = rowDeltas.latest;
        const matchingRowDeltas = latest && latest.from === currentFrom && latest.to === currentTo
            ? latest.deltas
            : undefined;

        return diffVersion(a, b, {
            rowDeltas: matchingRowDeltas,
            schemaChanges: schemaChanges(),
            fetchable,
            enumsA: cmp.fromStore.getEnums(),
            enumsB: cmp.toStore.getEnums(),
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
