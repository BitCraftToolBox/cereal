import {createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show} from "solid-js";
import {A, useBeforeLeave, useLocation} from "@solidjs/router";
import {isStaticTable, type ResolvedTableMeta, useData} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {Title} from "@solidjs/meta";
import {type ObjectMatch, searchCachedTables, searchTableNames} from "~/lib/search";

export default function SearchPage() {
    const data = useData();
    const nav = useNavHistory();
    const location = useLocation();
    const initQ: string = new URLSearchParams(location.search).get("q") ?? "";
    const [query, setQuery] = createSignal<string>(initQ);
    let searchInputRef: HTMLInputElement | undefined;

    // Animate outgoing navigation so the search bar morphs back to the navbar.
    // Skip for browser back/forward (popstate) — those pass state: undefined and no replace flag,
    // but most importantly they should not be intercepted or they get stuck.
    useBeforeLeave((e) => {
        if (!("startViewTransition" in document)) return;
        if (e.defaultPrevented) return;
        // Only intercept explicit link navigations, not browser history pop events.
        // SolidJS sets options.scroll and/or options.resolve for programmatic nav;
        // popstate navigations arrive with no options object at all.
        if (!e.options || (e.options as Record<string, unknown>).delta !== undefined) return;
        e.preventDefault();
        (document as Document & { startViewTransition: (cb: () => void) => unknown })
            .startViewTransition(() => {
                e.retry(true);
            });
    });

    onMount(() => {
        nav.push({path: location.pathname + location.search, label: initQ ? `Search: ${initQ}` : "Search"});

        // Set initial query value imperatively — keeps the input uncontrolled so URL syncing won't flicker
        if (searchInputRef && initQ) searchInputRef.value = initQ;

        // Focus the search input after any in-progress view transition completes.
        // document.getAnimations() includes view-transition pseudo-element animations.
        const pending = document.getAnimations().map((a) => a.finished);
        if (pending.length > 0) {
            Promise.allSettled(pending).then(() => searchInputRef?.focus());
        } else {
            searchInputRef?.focus();
        }

        // Hide the navbar search bar while this page is active
        const navInput = document.querySelector<HTMLElement>("nav form[role='search']");
        if (navInput) navInput.style.display = "none";

        // Steal the "/" shortcut for our own search bar
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "/") return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            e.preventDefault();
            searchInputRef?.focus();
            searchInputRef?.select();
        };
        document.addEventListener("keydown", onKeyDown);

        onCleanup(() => {
            if (navInput) {
                navInput.style.display = "";
                // Clear the navbar input value and reset its signal via a synthetic input event
                const navSearchInput = navInput.querySelector<HTMLInputElement>("input[type='search']");
                if (navSearchInput) {
                    navSearchInput.value = "";
                    navSearchInput.dispatchEvent(new InputEvent("input", {bubbles: true}));
                }
            }
            document.removeEventListener("keydown", onKeyDown);
        });
    });

    // Local cache of fetched rows, separate from the data store so we can track progress
    const [fetchedTables, setFetchedTables] = createSignal<Map<string, {
        meta: ResolvedTableMeta;
        rows: Record<string, unknown>[]
    }>>(new Map());
    const [fetchedCount, setFetchedCount] = createSignal(0);
    const [totalToFetch, setTotalToFetch] = createSignal(0);
    let fetchStarted = false;

    const allStaticPublic = createMemo(() =>
        (data.tableIndex() ?? [])
            .filter((t) => isStaticTable(t.name) && t.meta.isPublic)
    );

    // Kick off fetching all tables once we have the index and a non-empty query
    createEffect(on(
        () => [query().trim(), allStaticPublic().length] as const,
        ([q, count]) => {
            if (!q || count === 0 || fetchStarted) return;
            fetchStarted = true;
            const tables = allStaticPublic();
            setTotalToFetch(tables.length);

            for (const tableEntry of tables) {
                // Check data store cache first (may have been loaded by a prior navigation)
                const cached = data.getTable(tableEntry.name);
                if (cached) {
                    setFetchedTables((prev) => {
                        const next = new Map(prev);
                        next.set(tableEntry.name, {meta: tableEntry.meta, rows: cached});
                        return next;
                    });
                    setFetchedCount((n) => n + 1);
                    continue;
                }
                data.fetchTable(tableEntry.name).then((rows) => {
                    setFetchedTables((prev) => {
                        const next = new Map(prev);
                        next.set(tableEntry.name, {meta: tableEntry.meta, rows});
                        return next;
                    });
                    setFetchedCount((n) => n + 1);
                }).catch(() => {
                    // Count failed fetches so progress completes
                    setFetchedCount((n) => n + 1);
                });
            }
        }
    ));

    // URL sync (debounced) — use history.replaceState directly to avoid router re-render & input flicker
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const handleInput = (val: string) => {
        setQuery(val);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const url = new URL(window.location.href);
            if (val) url.searchParams.set("q", val);
            else url.searchParams.delete("q");
            history.replaceState(history.state, "", url.toString());
        }, 400);
    };

    const handleSubmit = (e: Event) => {
        e.preventDefault();
    };

    const TABLE_PREVIEW = 8;
    const [showAllTables, setShowAllTables] = createSignal(false);

    // Table-name matches — instant, full list (sliced in render)
    const tableMatches = createMemo(() => {
        const q = query().trim();
        if (!q || !data.tableIndex()) return [];
        return searchTableNames(q, data.tableIndex() ?? []);
    });

    // React to URL changes (e.g. browser back/forward, or breadcrumb clicks within the search page)
    createEffect(on(() => location.search, (search) => {
        const q = new URLSearchParams(search).get("q") ?? "";
        if (q !== query()) {
            setQuery(q);
            if (searchInputRef) searchInputRef.value = q;
            // Push to nav history so breadcrumbs truncate correctly (same logic as onMount)
            nav.push({path: location.pathname + search, label: q ? `Search: ${q}` : "Search"});
        }
    }, {defer: true}));

    // Keep breadcrumb label and path in sync with query when typing (replaceState bypasses location.search)
    createEffect(on(query, (q) => {
        const newPath = q ? `/search?q=${encodeURIComponent(q)}` : "/search";
        nav.updateTop(q ? `Search: ${q}` : "Search", newPath);
    }, {defer: true}));

    // Reset "show all" when query changes
    createEffect(on(query, () => setShowAllTables(false)));

    // Object matches — from progressively filled fetchedTables
    const objectResults = createMemo(() => {
        const q = query().trim();
        if (!q) return null;
        return searchCachedTables(q, fetchedTables(), allStaticPublic().map((t) => t.name));
    });

    const totalObjectMatches = createMemo(() => {
        const r = objectResults();
        if (!r) return 0;
        let n = 0;
        for (const matches of r.objects.values()) n += matches.length;
        return n;
    });

    const isFetching = createMemo(() => query().trim() && fetchedCount() < totalToFetch());
    const fetchProgress = createMemo(() => totalToFetch() > 0 ? Math.round(fetchedCount() / totalToFetch() * 100) : 0);

    return (
        <div class="w-auto min-w-[min(67vw,100%)] mx-auto space-y-6">
            <Title>Search — cereal</Title>

            <form onSubmit={handleSubmit} style="view-transition-name: global-search">
                <div class="relative">
                    <input
                        ref={searchInputRef}
                        type="search"
                        placeholder="Search tables, objects, IDs..."
                        onInput={(e) => handleInput(e.currentTarget.value)}
                        class="w-full px-4 py-2.5 rounded-lg bg-surface-1 border border-border text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary text-base"
                        aria-label="Search"
                    />
                    <kbd
                        class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted hidden sm:inline">/</kbd>
                </div>
            </form>

            <Show when={query().trim()}>
                {/* Table name matches */}
                <Show when={tableMatches().length > 0}>
                    <section class="space-y-2" aria-label="Table matches">
                        <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted flex items-center gap-2">
                            Tables
                            <span class="text-text font-normal">{tableMatches().length} results</span>
                            <Show when={tableMatches().length > TABLE_PREVIEW}>
                                <button
                                    onClick={() => setShowAllTables((v) => !v)}
                                    class="text-primary hover:underline font-normal"
                                >
                                    {showAllTables() ? "Show less" : `Show all`}
                                </button>
                            </Show>
                        </h2>
                        <div class="grid gap-1.5 sm:grid-cols-2">
                            <For each={showAllTables() ? tableMatches() : tableMatches().slice(0, TABLE_PREVIEW)}>
                                {(match) => (
                                    <A
                                        href={`/table/${match.tableName}`}
                                        class="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-1 border border-border hover:border-primary hover:text-primary focus:border-primary focus:text-primary focus:outline-none transition-colors text-sm font-mono"
                                    >
                    <span class="text-text-muted text-xs px-1.5 py-0.5 rounded bg-surface-2">
                      {match.category === "static" ? "📋" : match.category === "hidden" ? "🔒" : "⚙️"}
                    </span>
                                        {match.tableName}
                                    </A>
                                )}
                            </For>
                        </div>
                    </section>
                </Show>

                {/* Object matches */}
                <section class="space-y-2" aria-label="Object matches">
                    {/* Progress bar */}
                    <div class="flex items-center gap-3">
                        <h2 class="text-xs font-semibold uppercase tracking-wide text-text-muted">
                            Objects
                            <Show when={totalObjectMatches() > 0}>
                                <span class="ml-2 text-text">{totalObjectMatches()} results</span>
                            </Show>
                        </h2>
                        <Show when={totalToFetch() > 0}>
                            <div class="flex items-center gap-2 ml-auto text-xs text-text-muted">
                                <Show when={isFetching()}>
                                    <span>{fetchedCount()}/{totalToFetch()} tables loaded</span>
                                    <div class="w-24 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                                        <div
                                            class="h-full bg-primary transition-all duration-150 rounded-full"
                                            style={{width: fetchProgress() + "%"}}
                                        />
                                    </div>
                                </Show>
                                <Show when={!isFetching()}>
                                    <span class="text-text-muted">{totalToFetch()} tables searched</span>
                                </Show>
                            </div>
                        </Show>
                    </div>

                    <Show when={objectResults()}>
                        {(results) => (
                            <Show
                                when={totalObjectMatches() > 0}
                                fallback={
                                    <Show when={!isFetching() && fetchedCount() > 0}>
                                        <p class="text-sm text-text-muted">No objects found.</p>
                                    </Show>
                                }
                            >
                                <div class="space-y-4">
                                    <For each={[...results().objects.entries()]}>
                                        {([tableName, matches]) => {
                                            const total = () => results().totalPerTable.get(tableName) ?? matches.length;
                                            return (
                                                <div class="space-y-1.5">
                                                    <div class="flex items-center gap-2">
                                                        <A
                                                            href={`/table/${tableName}?q=${encodeURIComponent(query().trim())}`}
                                                            class="text-xs font-mono text-text-muted hover:text-primary transition-colors"
                                                        >
                                                            {tableName}
                                                        </A>
                                                        <Show when={total() > matches.length}>
                                                            <A
                                                                href={`/table/${tableName}?q=${encodeURIComponent(query().trim())}`}
                                                                class="text-xs text-text-muted hover:text-primary transition-colors"
                                                                title={`${total()} total matches — click to see all`}
                                                            >
                                                                +{total() - matches.length} more
                                                            </A>
                                                        </Show>
                                                    </div>
                                                    <div class="space-y-1">
                                                        <For each={matches}>
                                                            {(match: ObjectMatch) => (
                                                                <A
                                                                    href={`/table/${match.tableName}/${encodeURIComponent(String(match.primaryKey))}`}
                                                                    class="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-1 border border-border hover:border-primary transition-colors text-sm"
                                                                >
                                                                    <span
                                                                        class="font-medium text-text min-w-0 truncate flex-1">{match.displayValue}</span>
                                                                    <Show
                                                                        when={match.score !== -1 && match.matchField !== data.getTableMeta(tableName)?.displayField}>
                                  <span class="shrink-0 text-xs text-text-muted">
                                    {match.matchField}: <span
                                      class="text-text">{match.matchValue.length > 60 ? match.matchValue.slice(0, 60) + "…" : match.matchValue}</span>
                                  </span>
                                                                    </Show>
                                                                    <span
                                                                        class="shrink-0 text-xs px-1.5 py-0.5 rounded bg-surface-2 text-text-muted font-mono"
                                                                        title="Match score (lower = better)">
                                  {match.score === -1 ? "PK" : match.score.toFixed(1)}
                                </span>
                                                                </A>
                                                            )}
                                                        </For>
                                                    </div>
                                                </div>
                                            );
                                        }}
                                    </For>
                                </div>
                            </Show>
                        )}
                    </Show>
                </section>

                {/* Empty state when index not yet loaded */}
                <Show when={!data.tableIndex()}>
                    <p class="text-sm text-text-muted text-center py-8">Loading table index…</p>
                </Show>
            </Show>
        </div>
    );
}
