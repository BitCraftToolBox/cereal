import {useNavigate} from "@solidjs/router";
import {For, Show} from "solid-js";
import {useVersions} from "~/lib/data";

export interface CompareButtonProps {
    /** The version currently being viewed (shown disabled in the selector). */
    currentTag: string;
    /** Build the destination compare URL given the other selected version tag. */
    buildHref: (otherTag: string) => string;
    class?: string;
}

/**
 * A compact version selector styled like the header "graph" button. Picking a version
 * navigates to the corresponding compare route. The current version is shown but disabled.
 */
export function CompareButton(props: CompareButtonProps) {
    const versions = useVersions();
    const navigate = useNavigate();

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
                        <option value={v.tag} disabled={v.tag === props.currentTag}>
                            {v.tag === props.currentTag ? `${v.tag} (current)` : v.tag}
                        </option>
                    )}
                </For>
            </Show>
        </select>
    );
}
