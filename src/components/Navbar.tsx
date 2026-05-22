import {A, useIsRouting, useNavigate} from "@solidjs/router";
import {createMemo, createSignal, For, onCleanup, onMount, Show} from "solid-js";
import {useTheme} from "~/lib/theme";
import {useData, useVersions} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {searchTableNames, searchWithIndex, type ObjectMatch, type TableMatch, type SearchResult} from "~/lib/search";

const MAX_TABLE_SUGGESTIONS = 3;
const MAX_OBJECT_SUGGESTIONS = 15;
const OBJECT_SCORE_CUTOFF = 3.5;

export function Navbar() {
    const {isDark, toggle} = useTheme();
    const data = useData();
    const versions = useVersions();
    const nav = useNavHistory();
    const navigate = useNavigate();
    const isRouting = useIsRouting();
    const [searchQuery, setSearchQuery] = createSignal("");
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [activeIndex, setActiveIndex] = createSignal(-1);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let inputRef: HTMLInputElement | undefined;
    let dropdownRef: HTMLUListElement | undefined;

    const anyLoading = () => {
        return data.tableIndex.loading || data.searchIndex.loading || data.schema.loading || isRouting();
    }

    const getInput = () => {
        if (inputRef && document.contains(inputRef)) return inputRef;
        return document.querySelector<HTMLInputElement>("nav input[type='search']") ?? undefined;
    };

    const suggestions = createMemo((): SearchResult[] => {
        const q = searchQuery().trim();
        if (!q || !data.tableIndex()) return [];

        const tableMatches: TableMatch[] = searchTableNames(q, data.tableIndex() ?? [])
            .slice(0, MAX_TABLE_SUGGESTIONS);

        const idx = data.searchIndex();
        let objectMatches: ObjectMatch[] = [];
        if (idx) {
            const results = searchWithIndex(q, idx, MAX_OBJECT_SUGGESTIONS, OBJECT_SCORE_CUTOFF);
            // Flatten all object matches across tables, sort by score, take top N
            for (const matches of results.objects.values()) {
                objectMatches.push(...matches);
            }
            objectMatches.sort((a, b) => a.score - b.score);
            objectMatches = objectMatches.slice(0, MAX_OBJECT_SUGGESTIONS);
        }

        return [...tableMatches, ...objectMatches];
    });

    const hasSuggestions = () => dropdownOpen() && suggestions().length > 0;

    const vt = (fn: () => void) => {
        if ("startViewTransition" in document) {
            document.startViewTransition(fn);
        } else fn();
    };

    const commitSuggestion = (result: SearchResult) => {
        setSearchQuery("");
        setDropdownOpen(false);
        setActiveIndex(-1);
        if (result.kind === "table") {
            vt(() => navigate(`/table/${result.tableName}`));
        } else {
            const path = `/table/${result.tableName}/${encodeURIComponent(String(result.primaryKey))}`;
            const label = result.displayValue && result.displayValue !== String(result.primaryKey)
                ? `▣ ${result.displayValue}`
                : `▣ ${result.tableName} #${result.primaryKey}`;
            vt(() => navigate(path));
        }
    };

    const handleInput = (e: InputEvent) => {
        setSearchQuery((e.currentTarget as HTMLInputElement).value);
        setDropdownOpen(true);
        setActiveIndex(-1);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            if (searchQuery() === "") {
                setDropdownOpen(false);
                setActiveIndex(-1);
                getInput()?.blur();
                return;
            }
        } else if (e.key === "Enter" && e.shiftKey) {
            handleSearch(e);
            return;
        }
        if (!hasSuggestions()) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, suggestions().length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, -1));
        } else if (e.key === "Escape") {
            setDropdownOpen(false);
            setActiveIndex(-1);
        } else if (e.key === "Enter" && activeIndex() >= 0) {
            e.preventDefault();
            commitSuggestion(suggestions()[activeIndex()]);
        }
    };

    const handleSearch = (e: Event) => {
        e.preventDefault();
        const q = searchQuery().trim();
        if (!q) return;
        setDropdownOpen(false);
        vt(() => navigate(`/search?q=${encodeURIComponent(q)}`));
    };

    onMount(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "/") return;
            const tag = (e.target as HTMLElement).tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            e.preventDefault();
            const input = getInput();
            input?.focus();
            input?.select();
        };
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (!inputRef?.contains(target) && !dropdownRef?.contains(target)) {
                setDropdownOpen(false);
                setActiveIndex(-1);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown);
        onCleanup(() => {
            document.removeEventListener("keydown", onKeyDown);
            document.removeEventListener("pointerdown", onPointerDown);
        });
    });

    // Shared search form JSX extracted as a render function to avoid duplication
    const SearchForm = (extraClass = "") => (
        <form onSubmit={handleSearch} class={`relative ${extraClass}`} role="search"
              style="view-transition-name: global-search">
            <div class="relative">
                <input
                    ref={inputRef}
                    type="search"
                    placeholder="Search tables, objects, IDs..."
                    value={searchQuery()}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onFocus={() => {
                        if (searchQuery().trim()) setDropdownOpen(true);
                    }}
                    class="w-full px-3 py-1.5 rounded-md bg-surface-2 border border-border text-text placeholder:text-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
                    aria-label="Global search"
                    aria-autocomplete="list"
                    aria-expanded={hasSuggestions()}
                    autocomplete="off"
                />
                <kbd class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted hidden sm:inline">/</kbd>
            </div>

            <Show when={hasSuggestions()}>
                <ul
                    ref={dropdownRef}
                    class="absolute top-full mt-1 left-0 right-0 bg-surface-1 border border-border rounded-md shadow-lg z-50 py-1 max-h-96 overflow-y-auto min-w-64"
                    role="listbox"
                >
                    <For each={suggestions()}>
                        {(result, i) => {
                            const isActive = () => activeIndex() === i();
                            return (
                                <li
                                    role="option"
                                    aria-selected={isActive()}
                                    class="px-3 py-1.5 text-sm cursor-pointer transition-colors flex flex-col gap-0.5"
                                    classList={{
                                        "bg-primary text-white": isActive(),
                                        "hover:bg-surface-2": !isActive(),
                                    }}
                                    onPointerDown={(e) => {
                                        e.preventDefault();
                                        commitSuggestion(result);
                                    }}
                                    onMouseEnter={() => setActiveIndex(i())}
                                >
                                    <Show when={result.kind === "table"}>
                                        {(() => {
                                            const t = result as TableMatch;
                                            const q = searchQuery().trim().toLowerCase();
                                            const qNorm = q.replace(/[\s_]+/g, "");
                                            const name = t.tableName;
                                            const nameNorm = name.replace(/_/g, "");
                                            const matchIdx = nameNorm.indexOf(qNorm);
                                            let highlighted: any = name;
                                            if (matchIdx >= 0) {
                                                let normCount = 0, start = -1, end = -1;
                                                for (let ci = 0; ci < name.length; ci++) {
                                                    if (name[ci] === "_") continue;
                                                    if (normCount === matchIdx) start = ci;
                                                    normCount++;
                                                    if (normCount === matchIdx + qNorm.length) { end = ci + 1; break; }
                                                }
                                                if (start >= 0 && end >= 0) {
                                                    highlighted = (
                                                        <>
                                                            {name.slice(0, start)}
                                                            <mark class="bg-transparent font-bold text-inherit underline">{name.slice(start, end)}</mark>
                                                            {name.slice(end)}
                                                        </>
                                                    );
                                                }
                                            }
                                            return (
                                                <span class="font-mono">
                                                    <span class="opacity-60 text-xs">table: </span>{highlighted}
                                                </span>
                                            );
                                        })()}
                                    </Show>
                                    <Show when={result.kind === "object"}>
                                        {(() => {
                                            const o = result as ObjectMatch;
                                            const pk = String(o.primaryKey);
                                            const hasName = o.displayValue && o.displayValue !== pk;
                                            const showMatchField = o.matchField !== "name" && o.matchField !== "id";
                                            const showPk = o.matchValue === pk;
                                            return (
                                                <>
                                                    <span class="font-mono text-xs opacity-60">{o.tableName}:</span>
                                                    <span class="font-mono">
                                                        {hasName ? o.displayValue : pk}
                                                        <Show when={showMatchField || showPk}>
                                                            <span class="opacity-60 text-xs ml-1.5">
                                                                ({showMatchField
                                                                    ? <>{o.matchField}: {o.matchValue}</>
                                                                    : <>pk: {pk}</>
                                                                })
                                                            </span>
                                                        </Show>
                                                    </span>
                                                </>
                                            );
                                        })()}
                                    </Show>
                                </li>
                            );
                        }}
                    </For>
                    <Show when={suggestions().length > 0}>
                        <li class="px-3 py-1 text-xs text-text-muted border-t border-border mt-1 pt-1">
                            Press Shift+Enter to see full search results
                        </li>
                    </Show>
                </ul>
            </Show>
        </form>
    );

    function selectVersion(tag: string) {
        nav.updateTop(undefined, undefined, tag)
        versions.setCurrentTag(tag);
    }

    function handleSelectKey(e: KeyboardEvent, currentTag: string) {
        const currentIndex = versions.versions()?.findIndex(v => v.tag === currentTag);
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            if (currentIndex === undefined || currentIndex < 0 || currentIndex >= (versions.versions()?.length ?? 0) - 1) return;
            const target = versions.versions()?.[currentIndex + 1]?.tag;
            if (target) selectVersion(target);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            if (currentIndex === undefined || currentIndex <= 0) return;
            const target = versions.versions()?.[currentIndex - 1]?.tag;
            if (target) selectVersion(target);
        }
    }

    const VersionSelect = () => (
        <select
            value={versions.currentTag()}
            onKeyDown={(e) => handleSelectKey(e, e.currentTarget?.value)}
            onChange={(e) => selectVersion(e.currentTarget.value)}
            class="px-2 py-1 rounded-md bg-surface-2 border border-border text-text text-sm w-full sm:w-auto focus:outline-hidden focus:ring-1 focus:ring-primary"
            aria-label="Data version"
        >
            <Show when={versions.versions()} fallback={<option value="latest">Loading…</option>}>
                <For each={versions.versions()}>
                    {(v) => <option value={v.tag}>{v.tag + (v.label ? " (" + v.label + ")" : "") }</option>}
                </For>
            </Show>
        </select>
    );

    const DarkModeButton = () => (
        <button
            onClick={toggle}
            class="p-2 rounded-md hover:bg-surface-2 transition-colors"
            aria-label={isDark() ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark() ? "Switch to light mode" : "Switch to dark mode"}
        >
            <Show when={isDark()} fallback={<span class="text-lg">🌙</span>}>
                <span class="text-lg">☀️</span>
            </Show>
        </button>
    );

    return (
        <nav class="sticky top-0 z-50 bg-surface-1 border-b border-border shadow-xs" role="navigation" aria-label="Main navigation">
            {/* Main bar */}
            <div class="max-w-7xl mx-auto px-4 flex items-center h-14 gap-4">
                {/* Logo */}
                <A href="/" class="text-xl font-bold text-primary hover:text-primary-hover shrink-0" aria-label="Home"
                   onClick={() => nav.push({path: "/", label: "Home"})}>
                    🥣 cereal
                </A>

                {/* Desktop: search bar (hidden on mobile) */}
                <div class="hidden sm:flex flex-1 max-w-lg">
                    {SearchForm("flex-1")}
                </div>

                {/* Global loading indicator */}
                <Show when={anyLoading()} fallback={<div class="w-4 h-4"></div>}>
                    <LoadingSpinner size="sm" label="Loading data…" class="shrink-0 hidden sm:flex"/>
                </Show>

                {/* Desktop: version + dark mode (hidden on mobile) */}
                <div class="hidden sm:flex items-center gap-2 ml-auto shrink-0">
                    <VersionSelect/>
                    <A
                        href={"/versions"}
                        class="px-2 py-1 text-sm text-text-muted hover:text-text hover:bg-surface-2 rounded-md transition-colors"
                        title="View all versions"
                    >
                        All versions
                    </A>
                    <DarkModeButton/>
                </div>

                {/* Mobile: loading + hamburger button */}
                <div class="flex items-center gap-2 ml-auto sm:hidden">
                    <Show when={anyLoading()}>
                        <LoadingSpinner size="sm" label="Loading data…" class="shrink-0"/>
                    </Show>
                    <button
                        onClick={() => setMenuOpen(o => !o)}
                        class="p-2 rounded-md hover:bg-surface-2 transition-colors"
                        aria-label={menuOpen() ? "Close menu" : "Open menu"}
                        aria-expanded={menuOpen()}
                    >
                        <Show
                            when={menuOpen()}
                            fallback={
                                // Hamburger icon
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-text" fill="none"
                                     viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
                                </svg>
                            }
                        >
                            {/* X icon */}
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-text" fill="none"
                                 viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </Show>
                    </button>
                </div>
            </div>

            {/* Mobile expanded menu */}
            <Show when={menuOpen()}>
                <div class="sm:hidden border-t border-border bg-surface-1 px-4 py-3 flex flex-col gap-3">
                    {SearchForm("w-full")}
                    <div class="flex items-center justify-between gap-2">
                        <VersionSelect/>
                        <A
                            href={"/versions"}
                            class="px-2 py-1 text-sm text-text-muted hover:text-text hover:bg-surface-2 rounded-md transition-colors"
                            onClick={() => { setMenuOpen(false); }}
                        >
                            All versions
                        </A>
                        <DarkModeButton/>
                    </div>
                </div>
            </Show>
        </nav>
    );
}
