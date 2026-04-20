import {For, Show} from "solid-js";
import {A} from "@solidjs/router";
import {useData} from "~/lib/data";
import type {RefResult} from "~/lib/objectRefs";
import {RefPopover} from "~/components/RefPopover";

interface RefPillsProps {
    results: RefResult[];
    direction: "outgoing" | "incoming";
    currentTable: string;
    currentId: string;
}

const PILL_CLASS =
    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-1 border border-border hover:border-primary hover:text-primary text-sm transition-colors cursor-pointer";

export function RefPills(props: RefPillsProps) {
    const data = useData();

    const getLabel = (table: string, id: string) =>
        data.getDisplayNames(table)?.get(id);

    const isSelfRef = (result: RefResult) =>
        result.table === props.currentTable &&
        result.ids.length === 1 &&
        result.ids[0] === props.currentId;

    return (
        <div class="flex flex-wrap gap-2">
            <For each={props.results}>
                {(result) => {
                    const single = result.ids.length === 1;
                    const selfRef = isSelfRef(result);
                    const singleLabel = () => single ? getLabel(result.table, result.ids[0]) : undefined;

                    const pillInner = () => (
                        <>
                            <Show when={selfRef}>
                                <span aria-label="Self-reference">🔁</span>
                            </Show>
                            <Show
                                when={props.direction === "outgoing"}
                                fallback={
                                    // incoming: table ← field
                                    <>
                                        <span class="font-mono">{result.table}</span>
                                        <span class="text-text-muted text-xs">← {result.field}</span>
                                    </>
                                }
                            >
                                {/* outgoing: field → table */}
                                <span class="text-text-muted text-xs">{result.field} →</span>
                                <span class="font-mono">{result.table}</span>
                            </Show>
                            <Show
                                when={single}
                                fallback={
                                    <span class="ml-1 px-1.5 py-0.5 rounded-full bg-surface-2 text-xs text-text-muted">
                                        {result.ids.length}
                                    </span>
                                }
                            >
                                <span class="text-primary font-mono">#{result.ids[0]}</span>
                                <Show when={singleLabel()}>
                                    <span class="text-text-muted italic text-xs">{singleLabel()}</span>
                                </Show>
                            </Show>
                        </>
                    );

                    const popoverLinks = () =>
                        result.ids.map((id) => {
                            const lbl = getLabel(result.table, id);
                            return {
                                href: `/table/${result.table}/${encodeURIComponent(id)}`,
                                label: lbl ? `#${id} — ${lbl}` : `#${id}`,
                            };
                        });

                    return (
                        <Show
                            when={single}
                            fallback={
                                <RefPopover links={popoverLinks()}>
                                    {(toggle, open) => (
                                        <button
                                            onClick={toggle}
                                            class={PILL_CLASS}
                                            aria-expanded={open()}
                                        >
                                            {pillInner()}
                                        </button>
                                    )}
                                </RefPopover>
                            }
                        >
                            <A
                                href={`/table/${result.table}/${encodeURIComponent(result.ids[0])}`}
                                class={PILL_CLASS}
                                title={selfRef ? "Self-reference" : undefined}
                            >
                                {pillInner()}
                            </A>
                        </Show>
                    );
                }}
            </For>
        </div>
    );
}
