import {useNavigate} from "@solidjs/router";
import {createMemo, For, Show} from "solid-js";
import {useData, useVersions} from "~/lib/data";
import {computeVersionHistoryState, isNonexistentAt} from "~/lib/versionHistory";

export interface CompareButtonProps {
    /** The version currently being viewed (shown disabled in the selector). */
    currentTag: string;
    /** Build the destination compare URL given the other selected version tag. */
    buildHref: (otherTag: string) => string;
    class?: string;
    /**
     * Table name to check history against (raw name — any `_vN` migration suffix is resolved
     * to its base internally). When set, versions with no recorded change of their own are
     * shown de-emphasized (grayed, but still selectable), and versions before the
     * table/object existed (or after it was removed) are shown in red.
     */
    tableName?: string;
    /** Narrows the history check to one object's changes within `tableName` (object pages). */
    objectId?: string;
}

/**
 * A compact version selector styled like the header "graph" button. Picking a version
 * navigates to the corresponding compare route. The current version is shown but disabled.
 */
export function CompareButton(props: CompareButtonProps) {
    const versions = useVersions();
    const data = useData();
    const navigate = useNavigate();

    const versionIndex = createMemo(() => {
        const idx = new Map<string, number>();
        (versions.versions() ?? []).forEach((v, i) => idx.set(v.tag, i));
        return idx;
    });

    const history = createMemo(() =>
        props.tableName
            ? computeVersionHistoryState(props.tableName, props.objectId, versionIndex(), data)
            : undefined
    );

    const optionClass = (tag: string): string | undefined => {
        const h = history();
        if (!h) return undefined;
        const idx = versionIndex().get(tag);
        if (idx !== undefined && isNonexistentAt(idx, h.events)) return "text-red-500";
        return h.changed.has(tag) ? undefined : "text-text-muted";
    };

    return (
        <select
            class={`text-xs px-2 py-1 field-sizing-content rounded-sm bg-surface-1 border border-border hover:border-primary transition-colors cursor-pointer ${props.class ?? ""}`}
            title="Compare this with another version"
            onChange={(e) => {
                const tag = e.currentTarget.value;
                e.currentTarget.selectedIndex = 0; // reset to placeholder
                if (tag) navigate(props.buildHref(tag));
            }}
        >
            <option disabled selected hidden value="">⇄ compare…</option>
            <Show when={versions.versions()}>
                <For each={versions.versions()}>
                    {(v) => (
                        <option
                            value={v.tag}
                            disabled={v.tag === props.currentTag}
                            class={optionClass(v.tag)}
                        >
                            {v.tag === props.currentTag ? `${v.tag} (current)` : v.tag}
                        </option>
                    )}
                </For>
            </Show>
        </select>
    );
}
