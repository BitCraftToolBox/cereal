import {A, useLocation} from "@solidjs/router";
import {createEffect, createMemo, createSignal, For, Show} from "solid-js";
import {useNavHistory} from "~/lib/navHistory";

const COLLAPSE_THRESHOLD = 5;

/** Derive a human-readable tooltip from a path like /table/item_desc/42 */
function pathToTitle(path: string): string | undefined {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "table" && parts.length === 2) return parts[1];
    if (parts[0] === "table" && parts.length >= 3) return `${parts[1]} / ${decodeURIComponent(parts[2])}`;
    return undefined;
}

export function Breadcrumb() {
    const location = useLocation();
    const nav = useNavHistory();
    const [expanded, setExpanded] = createSignal(false);

    // Collapse again whenever we navigate to a new page
    createEffect(() => {
        location.pathname;
        setExpanded(false);
    });

    const allCrumbs = createMemo(() => {
        const hist = nav.history();
        const home = {label: "Home", href: "/"};

        if (hist.length > 0 && hist[hist.length - 1].path.split("?")[0] === location.pathname) {
            const entries = hist.map((e, i) => ({
                label: e.label,
                href: i < hist.length - 1 ? e.path : undefined,
                title: pathToTitle(e.path),
            }));
            if (entries[0]?.href !== "/" && entries[0]?.label !== "Home") {
                return [home, ...entries];
            }
            return entries;
        }

        // No history: just show Home + current page label
        const path = location.pathname;
        if (path === "/") return [];
        const currentLabel = pathToTitle(path) ?? decodeURIComponent(path.split("/").filter(Boolean).pop() ?? path);
        return [home, {label: currentLabel, href: undefined, title: pathToTitle(path)}];
    });

    // When collapsed, show first + last two, with an ellipsis button in the middle
    const visibleCrumbs = createMemo(() => {
        const crumbs = allCrumbs();
        if (expanded() || crumbs.length <= COLLAPSE_THRESHOLD) return {crumbs, ellipsisAt: -1};
        // Keep first and last 2
        return {crumbs, ellipsisAt: 1, hidden: crumbs.slice(1, crumbs.length - 2)};
    });

    const renderCrumbs = createMemo(() => {
        const {crumbs, ellipsisAt, hidden} = visibleCrumbs() as any;
        if (ellipsisAt === -1 || expanded()) return crumbs;
        return [
            crumbs[0],
            {label: `…${hidden.length} more…`, href: undefined, isEllipsis: true},
            ...crumbs.slice(crumbs.length - 2),
        ];
    });

    return (
        <Show when={allCrumbs().length > 0}>
            <nav aria-label="Breadcrumb" class="text-sm text-text-muted">
                <ol class="flex items-center flex-wrap gap-1">
                    <For each={renderCrumbs()}>
                        {(crumb: any, i) => (
                            <li class="flex items-center gap-1">
                                <Show when={i() > 0}>
                                    <span class="mx-1 select-none" aria-hidden="true">&gt;</span>
                                </Show>
                                <Show when={crumb.isEllipsis}>
                                    <button
                                        onClick={() => setExpanded(true)}
                                        class="px-1 rounded hover:text-primary hover:bg-surface-2 transition-colors font-mono"
                                        aria-label="Show full navigation history"
                                        title="Show all"
                                    >
                                        {crumb.label}
                                    </button>
                                </Show>
                                <Show when={!crumb.isEllipsis}>
                                    <Show
                                        when={crumb.href}
                                        fallback={
                                            <span class="text-text font-medium font-mono" aria-current="page"
                                                  title={crumb.title}>
                                                {crumb.label}
                                            </span>
                                        }
                                    >
                                        <A
                                            href={crumb.href!}
                                            class="hover:text-primary transition-colors font-mono"
                                            title={crumb.title}
                                            onClick={() => {
                                                if (crumb.href === "/") nav.push({path: "/", label: "Home"});
                                            }}
                                        >
                                            {crumb.label}
                                        </A>
                                    </Show>
                                </Show>
                            </li>
                        )}
                    </For>
                </ol>
            </nav>
        </Show>
    );
}
