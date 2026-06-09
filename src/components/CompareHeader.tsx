import {createMemo, For, JSX, Show} from "solid-js";
import {useCompare} from "~/lib/data";
import {VersionEntry} from "~/lib/schema";

/**
 * Shared header for compare views: two version dropdowns (from = older, to = newer) that
 * rewrite the URL `from`/`to` params for the current view. The scope normalizes ordering.
 */
export function CompareHeader(props: { title?: JSX.Element; }) {
    const cmp = useCompare();
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

    const Select = (p: { value: string; onChange: (tag: string) => void; label: string, versions: VersionEntry[] | undefined }) => (
        <label class="flex items-center gap-1.5 text-sm">
            <span class="text-text-muted">{p.label}</span>
            <select
                value={p.value}
                onChange={(e) => e.currentTarget.value !== "-" && p.onChange(e.currentTarget.value)}
                class="rounded-md border border-border bg-surface-2 text-text text-sm px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-primary field-sizing-content"
            >
                <Show when={cmp.versions()} fallback={<option value="-">Loading…</option>}>
                    <For each={p.versions} fallback={<option value="-">None</option>}>
                        {(v) => (
                            <option value={v.tag} disabled={v.tag === cmp.fromTag() || v.tag === cmp.toTag()}>
                                {v.label && v.label !== v.tag ? `${v.tag} (${v.label})` : v.tag}
                            </option>
                        )}
                    </For>
                </Show>
            </select>
        </label>
    );

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
                <Select label="From" value={cmp.fromTag()} onChange={cmp.setFrom} versions={olderThanTo()}/>
                <span class="text-text-muted" aria-hidden="true">→</span>
                <Select label="To" value={cmp.toTag()} onChange={cmp.setTo} versions={newerThanFrom()}/>
            </div>
        </div>
    );
}
