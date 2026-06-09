import {createMemo, For, JSX, Show} from "solid-js";
import {useLocation} from "@solidjs/router";
import {useCompare} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {VersionEntry} from "~/lib/schema";

/**
 * Shared header for compare views: two version dropdowns (from = older, to = newer) that
 * rewrite the URL `from`/`to` params for the current view. The scope normalizes ordering.
 */
export function CompareHeader(props: { title?: JSX.Element; }) {
    const cmp = useCompare();
    const nav = useNavHistory();
    const location = useLocation();
    const olderThanTo = createMemo(() => {
        const list = cmp.versions();
        const to = cmp.toTag();
        if (!list) return undefined;
        const toIdx = list.findIndex((v) => v.tag === to);
        if (toIdx < 0) return [];
        return list.slice(toIdx);
    });
    const newerThanFrom = createMemo(() => {
        const list = cmp.versions();
        const from = cmp.fromTag();
        if (!list) return undefined;
        const fromIdx = list.findIndex((v) => v.tag === from);
        if (fromIdx < 0) return [];
        return list.slice(0, fromIdx + 1);
    });

    const Select = (p: { value: string; onChange: (tag: string) => void; label: string, versions: VersionEntry[] | undefined }) => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const list = p.versions;
            if (!list?.length) return;
            const idx = list.findIndex((v) => v.tag === p.value);
            if (idx < 0) return;
            // List is newest-first: lower index = newer, higher index = older.
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                const next = list[idx + 1];
                if (next) p.onChange(next.tag);
            } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = list[idx - 1];
                if (next) p.onChange(next.tag);
            }
        };

        return (
            <label class="flex items-center gap-1.5 text-sm">
                <span class="text-text-muted">{p.label}</span>
                <select
                    value={p.value}
                    onChange={(e) => e.currentTarget.value !== "-" && p.onChange(e.currentTarget.value)}
                    onKeyDown={handleKeyDown}
                    class="rounded-md border border-border bg-surface-2 text-text text-sm px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-primary field-sizing-content"
                >
                    <Show when={cmp.versions()} fallback={<option value="-">Loading…</option>}>
                        <For each={p.versions} fallback={<option value="-">None</option>}>
                            {(v) => (
                                <option value={v.tag} disabled={v.tag === cmp.fromTag() || v.tag === cmp.toTag()}>
                                    {v.tag == cmp.fromTag() ? "←" : v.tag == cmp.toTag() ? "→" : ""}{v.label && v.label !== v.tag ? `${v.tag} (${v.label})` : v.tag}
                                </option>
                            )}
                        </For>
                    </Show>
                </select>
            </label>
        );
    };

    // The current breadcrumb path without its query string. Compare pages push their
    // from/to into the path's query, so we rewrite that in place when switching versions.
    const basePath = () => {
        const hist = nav.history();
        const top = hist[hist.length - 1];
        return (top?.path ?? location.pathname).split("?")[0];
    };

    // Switch a version *and* rewrite the top history entry to the path the page effect is
    // about to push. Because the From/To dropdowns only offer in-order options, the scope
    // never swaps from/to here — so the next pushed path is deterministic. Updating the top
    // entry first lets the subsequent push dedup against it (replace) instead of appending a
    // fresh breadcrumb crumb for every version change (mirrors the Navbar version selector).
    const changeFrom = (v: string) => {
        nav.updateTop(undefined, `${basePath()}?from=${v}&to=${cmp.toTag()}`);
        cmp.setFrom(v);
    };
    const changeTo = (v: string) => {
        nav.updateTop(undefined, `${basePath()}?from=${cmp.fromTag()}&to=${v}`);
        cmp.setTo(v);
    };

    return (
        <div class="space-y-3">
            <Show when={props.title}>
                <div>
                    <h1 class="text-2xl font-bold flex items-center gap-2">
                        <span class="text-primary">⇄</span>
                        <span class="font-mono">{props.title}</span>
                    </h1>
                </div>
            </Show>
            <div class="flex flex-wrap items-center justify-center gap-4 rounded-lg border border-border bg-surface-1 px-4 py-3">
                <Select label="From" value={cmp.fromTag()} onChange={changeFrom} versions={olderThanTo()}/>
                <span class="text-text-muted" aria-hidden="true">→</span>
                <Select label="To" value={cmp.toTag()} onChange={changeTo} versions={newerThanFrom()}/>
            </div>
        </div>
    );
}
