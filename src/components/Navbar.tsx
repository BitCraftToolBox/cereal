import {A, useIsRouting, useNavigate} from "@solidjs/router";
import {createMemo, createSignal, For, onCleanup, onMount, Show} from "solid-js";
import {useTheme} from "~/lib/theme";
import {isStaticTable, useData} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {searchTableNames} from "~/lib/search";

const MAX_DROPDOWN = 8;

export function Navbar() {
    const {isDark, toggle} = useTheme();
    const data = useData();
    const nav = useNavHistory();
    const navigate = useNavigate();
    const isRouting = useIsRouting();
    const [searchQuery, setSearchQuery] = createSignal("");
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [activeIndex, setActiveIndex] = createSignal(-1);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let inputRef: HTMLInputElement | undefined;
    let dropdownRef: HTMLUListElement | undefined;

    const getInput = () => {
        if (inputRef && document.contains(inputRef)) return inputRef;
        return document.querySelector<HTMLInputElement>("nav input[type='search']") ?? undefined;
    };

    const suggestions = createMemo(() => {
        const q = searchQuery().trim().toLowerCase().replace(/\s+/g, "_");
        if (!q || !data.tableIndex()) return [];
        return searchTableNames(q, data.tableIndex() ?? [])
            .slice(0, MAX_DROPDOWN)
            .map(t => t.tableName);
    });

    const hasSuggestions = () => dropdownOpen() && suggestions().length > 0;

    const vt = (fn: () => void) => {
        if ("startViewTransition" in document) {
            document.startViewTransition(fn);
        } else fn();
    };

    const commitSuggestion = (name: string) => {
        setSearchQuery("");
        setDropdownOpen(false);
        setActiveIndex(-1);
        nav.push({path: `/table/${name}`, label: `⊞ ${name}`});
        vt(() => navigate(`/table/${name}`));
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
        if (suggestions().length === 1) {
            commitSuggestion(suggestions()[0]);
            return;
        }
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
                    class="w-full px-3 py-1.5 rounded-md bg-surface-2 border border-border text-text placeholder:text-text-muted text-sm focus:outline-none focus:ring-2 focus:ring-primary"
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
                    class="absolute top-full mt-1 left-0 right-0 bg-surface-1 border border-border rounded-md shadow-lg z-50 py-1 max-h-72 overflow-y-auto"
                    role="listbox"
                >
                    <For each={suggestions()}>
                        {(name, i) => (
                            <li
                                role="option"
                                aria-selected={activeIndex() === i()}
                                class="px-3 py-1.5 text-sm font-mono cursor-pointer transition-colors"
                                classList={{
                                    "bg-primary text-white": activeIndex() === i(),
                                    "hover:bg-surface-2": activeIndex() !== i(),
                                }}
                                onPointerDown={(e) => {
                                    e.preventDefault();
                                    commitSuggestion(name);
                                }}
                                onMouseEnter={() => setActiveIndex(i())}
                            >
                                {(() => {
                                    const q = searchQuery().trim().toLowerCase().replace(/\s+/g, "_");
                                    if (!q) return name;
                                    const qNorm = q.replace(/_/g, "");
                                    const nameNorm = name.replace(/_/g, "");
                                    const matchIdx = nameNorm.indexOf(qNorm);
                                    if (matchIdx < 0) return name;
                                    let normCount = 0;
                                    let start = -1, end = -1;
                                    for (let i = 0; i < name.length; i++) {
                                        if (name[i] === "_") continue;
                                        if (normCount === matchIdx) start = i;
                                        normCount++;
                                        if (normCount === matchIdx + qNorm.length) {
                                            end = i + 1;
                                            break;
                                        }
                                    }
                                    if (start < 0 || end < 0) return name;
                                    return (
                                        <>
                                            {name.slice(0, start)}
                                            <mark
                                                class="bg-transparent font-bold text-inherit underline">{name.slice(start, end)}</mark>
                                            {name.slice(end)}
                                        </>
                                    );
                                })()}
                            </li>
                        )}
                    </For>
                    <Show
                        when={(data.tableIndex() ?? []).filter(t => isStaticTable(t.name) && t.name.includes(searchQuery().trim().toLowerCase().replace(/\s+/g, "_"))).length > MAX_DROPDOWN}>
                        <li class="px-3 py-1 text-xs text-text-muted border-t border-border mt-1 pt-1">
                            Press Enter to search all results
                        </li>
                    </Show>
                </ul>
            </Show>
        </form>
    );

    const VersionSelect = () => (
        <select
            value={data.version()}
            onChange={(e) => data.setVersion(e.currentTarget.value)}
            class="px-2 py-1 rounded-md bg-surface-2 border border-border text-text text-sm w-full sm:w-auto"
            aria-label="Data version"
        >
            <Show when={data.versions()} fallback={<option value="latest">Loading…</option>}>
                <For each={data.versions()}>
                    {(v) => <option value={v.hash}>{v.label}</option>}
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
        <nav class="sticky top-0 z-50 bg-surface-1 border-b border-border shadow-sm" role="navigation" aria-label="Main navigation">
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
                <Show when={data.tableIndex.loading || isRouting()}>
                    <LoadingSpinner size="sm" label="Loading data…" class="shrink-0 hidden sm:flex"/>
                </Show>

                {/* Desktop: version + dark mode (hidden on mobile) */}
                <div class="hidden sm:flex items-center gap-2 ml-auto shrink-0">
                    <VersionSelect/>
                    <DarkModeButton/>
                </div>

                {/* Mobile: loading + hamburger button */}
                <div class="flex items-center gap-2 ml-auto sm:hidden">
                    <Show when={data.tableIndex.loading || isRouting()}>
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
                        <DarkModeButton/>
                    </div>
                </div>
            </Show>
        </nav>
    );
}
