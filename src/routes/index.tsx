import {createMemo, createSignal, For, onCleanup, onMount, Show} from "solid-js";
import {A} from "@solidjs/router";
import {isStaticTable, useData} from "~/lib/data";

export default function Home() {
    const data = useData();
    const [search, setSearch] = createSignal("");
    const [showStatic, setShowStatic] = createSignal(true);
    const [showPrivate, setShowPrivate] = createSignal(false);
    const [showNonStatic, setShowNonStatic] = createSignal(false);
    let filterRef: HTMLInputElement | undefined;

    onMount(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            // Ignore if a modifier (except shift) is held, or if focus is already on an interactive element
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            // Only printable single characters, but not "/" (that belongs to the navbar search shortcut)
            if (e.key.length !== 1 || e.key === "/") return;
            filterRef?.focus();
            // Let the keypress land in the input naturally — don't call setSearch here,
            // the input's onInput handler will fire after the browser inserts the character.
        };
        document.addEventListener("keydown", onKeyDown);
        onCleanup(() => document.removeEventListener("keydown", onKeyDown));
    });

    const filteredTables = createMemo(() => {
        const index = data.tableIndex();
        if (!index) return [];
        const q = search().toLowerCase().trim().replace(/\s+/g, "_");
        return index.filter((t) => {
            const isStatic = isStaticTable(t.name);
            const isPublic = t.meta.isPublic;
            // Determine which category this table falls into
            if (!isStatic && !showNonStatic()) return false;
            else if (isStatic && !isPublic && !showPrivate()) return false;
            else if (isStatic && isPublic && !showStatic()) return false;
            // filter search query
            else if (
                q
                && !t.name.toLowerCase().includes(q)
                && !t.name.toLowerCase().replace(/_/g, "").includes(q)
            ) return false;

            return true;
        });
    });

    const Toggle = (tprops: { label: string; checked: boolean; onChange: () => void; title?: string }) => (
        <label
            class="flex items-center gap-1.5 cursor-pointer select-none text-sm text-text-muted hover:text-text transition-colors"
            title={tprops.title}>
            <input
                type="checkbox"
                checked={tprops.checked}
                onChange={tprops.onChange}
                class="w-3.5 h-3.5 accent-primary"
            />
            {tprops.label}
        </label>
    );

    return (
        <div class="max-w-5xl mx-auto space-y-6">
            <div class="text-center py-8 space-y-4">
                <h1 class="text-4xl font-bold">🥣 cereal</h1>
                <p class="text-text-muted text-lg">Browse BitCraft game data</p>
            </div>

            <Show
                when={!data.tableIndex.loading}
                fallback={<div class="text-center text-text-muted py-8">Loading tables…</div>}
            >
                <div class="flex flex-wrap items-center justify-center sm:justify-start gap-x-4 gap-y-2">
                    <input
                        ref={filterRef}
                        type="search"
                        placeholder="Filter tables..."
                        value={search()}
                        onInput={(e) => setSearch(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape" && (e.currentTarget as HTMLInputElement).value === "") {
                                (e.currentTarget as HTMLInputElement).blur();
                            }
                        }}
                        class="px-3 py-1.5 rounded-lg bg-surface-1 border border-border text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary text-sm w-56"
                        aria-label="Filter tables"
                    />
                    <p class="text-sm text-text-muted">{filteredTables().length} tables</p>
                    <A
                        href={`/graph`}
                        class="text-xs px-2 py-1 rounded bg-surface-1 border border-border hover:border-primary hover:text-primary transition-colors"
                        title="View network graph"
                    >
                        ⬡ graph
                    </A>
                    <div class="flex items-center gap-3 sm:ml-auto flex-wrap">
                        <Toggle label="📋 Static" checked={showStatic()} onChange={() => setShowStatic((v) => !v)}
                                title="Show normal static (desc) tables"/>
                        <Toggle label="🔒 Hidden" checked={showPrivate()} onChange={() => setShowPrivate((v) => !v)}
                                title="Show hidden desc tables (no rows, only structure)"/>
                        <Toggle label="⚙️ State" checked={showNonStatic()} onChange={() => setShowNonStatic((v) => !v)}
                                title="Show runtime/non-static tables (any visibility, no rows, only structure)"/>
                    </div>
                </div>
                <Show
                    when={filteredTables().length > 0}
                    fallback={
                        <div class="text-center text-text-muted py-8">
                            {data.tableIndex()?.length === 0 ? "No data loaded — run npm run gen-defs first." : "No tables match your search."}
                        </div>
                    }
                >
                    <div class="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                        <For each={filteredTables()}>
                            {(table) => (
                                <A
                                    href={`/table/${table.name}`}
                                    class="block p-4 rounded-lg bg-surface-1 border border-border hover:border-primary hover:shadow-md transition-all group"
                                >
                                    <div
                                        class="font-medium font-mono text-text group-hover:text-primary transition-colors">
                                        {table.name}
                                    </div>
                                    <div class="flex items-center gap-3 mt-2 text-xs text-text-muted">
                                        <Show when={!table.meta.isPublic}>
                                            <span title="Private table">🔒</span>
                                        </Show>
                                        <Show when={!isStaticTable(table.name)}>
                                            <span title="Non-static table">⚙️</span>
                                        </Show>
                                        <Show when={table.meta.rowCount > 0}>
                                            <span>{table.meta.rowCount.toLocaleString()} rows</span>
                                        </Show>
                                        <Show when={table.meta.columns.length > 0}>
                                            <span>{table.meta.columns.length} cols</span>
                                        </Show>
                                    </div>
                                </A>
                            )}
                        </For>
                    </div>
                </Show>
            </Show>
        </div>
    );
}
