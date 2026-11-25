import {Show} from "solid-js";
import type {TableOrigin} from "~/lib/schemaDerive";

const LABELS: Record<TableOrigin, { text: string; title: string }> = {
    region: {text: "region", title: "Declared only in the region module schema"},
    global: {text: "global", title: "Declared only in the global module schema"},
    both: {text: "region + global", title: "Declared in both the region and global module schemas"},
};

/**
 * Small badge telling which BitCraft module schema(s) declare a table. When the region and
 * global declarations disagree (`mismatches` non-empty) a warning marker is added.
 */
export function OriginTag(props: { origin: TableOrigin; mismatches?: string[] }) {
    const label = () => LABELS[props.origin];
    const mismatched = () => (props.mismatches?.length ?? 0) > 0;
    return (
        <span class="inline-flex items-center gap-1">
            <span
                class="text-xs px-1.5 py-0.5 rounded-sm bg-surface-2 border border-border text-text-muted whitespace-nowrap"
                title={label().title}
            >
                {label().text}
            </span>
            <Show when={mismatched()}>
                <span
                    class="text-xs"
                    title={`Region and global schemas disagree (showing region): ${props.mismatches!.join("; ")}`}
                    aria-label="Region and global schemas disagree"
                >
                    ⚠️
                </span>
            </Show>
        </span>
    );
}
