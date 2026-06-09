import {Title} from "@solidjs/meta";
import {A, useNavigate} from "@solidjs/router";
import {createEffect, createMemo, createSignal, For, Show} from "solid-js";
import {LoadingSpinner} from "~/components/LoadingSpinner";
import {useVersions} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";

export default function VersionsListPage() {
    const versions = useVersions();
    const nav = useNavHistory();
    const navigate = useNavigate();

    const [compareMode, setCompareMode] = createSignal(false);
    // Wiki-style two-radio selection: `older` (left) and `newer` (right) tags.
    const [older, setOlder] = createSignal<string | null>(null);
    const [newer, setNewer] = createSignal<string | null>(null);

    createEffect(() => {
        nav.push({path: `/versions`, label: `📋 Versions`});
    });

    const sortedVersions = createMemo(() => versions.versions() ?? []);
    const latestTag = () => sortedVersions()[0]?.tag;

    createEffect(() => {
        // default to last two whenever compare is turned on
        if (compareMode()) {
            setOlder(sortedVersions()[1]?.tag);
            setNewer(latestTag());
        }
    });

    const olderThanNewer = (tag: string) => {
        const n = newer();
        if (!n) return true;
        const nIdx = sortedVersions().findIndex(v => v.tag === n);
        const cIdx = sortedVersions().findIndex(v => v.tag === tag);
        return nIdx < cIdx;
    }
    const newerThanOlder = (tag: string) => {
        const o = older();
        if (!o) return true;
        const oIdx = sortedVersions().findIndex(v => v.tag === o);
        const cIdx = sortedVersions().findIndex(v => v.tag === tag);
        return oIdx > cIdx;
    }

    const selectAndBrowse = (tag: string) => {
        versions.setCurrentTag(tag);
        nav.push({path: "/", label: "Home"});
        navigate("/");
    };

    const compareHref = (from: string, to: string) => `/compare?from=${from}&to=${to}`;

    const canCompare = () => older() && newer() && older() !== newer();
    const compareSelected = () => {
        if (!canCompare()) return;
        navigate(compareHref(older()!, newer()!));
    };

    return (
        <>
            <Title>Versions — cereal</Title>
            <div class="max-w-4xl w-full mx-auto py-6">
                <div class="flex items-start justify-between gap-4 mb-1">
                    <h1 class="text-2xl font-bold">Game Data Versions</h1>
                    <button
                        onClick={() => setCompareMode((m) => !m)}
                        class="shrink-0 px-3 py-1 text-sm rounded-md border transition-colors"
                        classList={{
                            "border-red-300 bg-primary text-white": compareMode(),
                            "border-border hover:bg-surface-2 text-text": !compareMode(),
                        }}
                    >
                        ⇄ <Show when={compareMode()} fallback={"Compare"}>Cancel</Show>
                    </button>
                </div>
                <Show when={compareMode()} fallback={
                    <p class="text-text-muted text-sm h-6 mb-7">
                        Each version corresponds to a game patch. Select a version to browse its data.
                    </p>
                }>
                    <div class="flex mb-6">
                        <p class="text-text-muted text-sm h-6">
                            Select two versions to compare, or use the <span class="font-mono">cur</span>/<span class="font-mono">prev</span> links.
                        </p>
                        <button
                            onClick={compareSelected}
                            disabled={!canCompare()}
                            class="ml-auto px-3 py-1 text-sm rounded-md transition-colors"
                            classList={{
                                "bg-primary text-white hover:bg-primary-hover": !!canCompare(),
                                "bg-surface-2 text-text-muted cursor-not-allowed": !canCompare(),
                            }}
                        >
                            Compare selected
                        </button>
                    </div>
                </Show>

                <Show when={!versions.versions.loading} fallback={
                    <div class="flex items-center gap-2 text-text-muted py-8">
                        <LoadingSpinner size="sm"/>
                        <span>Loading versions…</span>
                    </div>
                }>
                    <Show when={sortedVersions().length === 0}>
                        <p class="text-text-muted">No versions available.</p>
                    </Show>

                    <div class="flex flex-col gap-3">
                        <For each={sortedVersions()}>
                            {(v, i) => {
                                const isCurrent = () => versions.currentTag() === v.tag;
                                const firstLine = () => v.description?.split("\n")[0]?.trim() ?? "";
                                const prevTag = () => sortedVersions()[i() + 1]?.tag;

                                return (
                                    <div
                                        class="rounded-lg border bg-surface-1 p-4 flex items-start gap-4"
                                        classList={{
                                            "border-primary": isCurrent() && !compareMode(),
                                            "border-border": !isCurrent() || compareMode(),
                                        }}
                                    >
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 flex-wrap">
                                                <span class="font-mono font-semibold text-text">{v.tag}</span>
                                                <Show when={v.label && v.label !== v.tag}>
                                                    <span class="text-text-muted text-sm">—</span>
                                                    <span class="text-text-muted text-sm">{v.label}</span>
                                                </Show>
                                                <Show when={isCurrent() && !compareMode()}>
                                                    <span class="ml-1 text-xs bg-primary/20 text-primary border border-primary/30 rounded-sm px-1.5 py-0.5 font-medium">
                                                        Current
                                                    </span>
                                                </Show>
                                            </div>
                                            <Show when={firstLine()}>
                                                <p class="text-text-muted text-sm mt-1 truncate">{firstLine()}</p>
                                            </Show>
                                        </div>
                                        <Show when={compareMode()} fallback={
                                            <div class="flex items-center gap-2 shrink-0">
                                                <A
                                                    href={`/versions/${v.tag}`}
                                                    class="px-3 py-1 text-sm rounded-md border border-border hover:bg-surface-2 transition-colors text-text"
                                                >
                                                    Info
                                                </A>
                                                <Show
                                                    when={!isCurrent()}
                                                    fallback={
                                                        <button
                                                            disabled
                                                            class="px-3 py-1 text-sm rounded-md bg-primary/20 text-primary border border-primary/30 cursor-default"
                                                        >
                                                            Browsing
                                                        </button>
                                                    }
                                                >
                                                    <button
                                                        onClick={() => selectAndBrowse(v.tag)}
                                                        class="px-3 py-1 text-sm rounded-md bg-primary text-white hover:bg-primary-hover transition-colors"
                                                    >
                                                        Browse
                                                    </button>
                                                </Show>
                                            </div>
                                        }>
                                            {/* Compare-mode radios */}
                                            <div class="flex items-center gap-2 shrink-0 self-center">
                                                <input
                                                    type="radio" name="cmp-older" aria-label={`Compare from ${v.tag}`}
                                                    checked={older() === v.tag}
                                                    onChange={() => setOlder(v.tag)}
                                                    disabled={!olderThanNewer(v.tag)}
                                                />
                                                <input
                                                    type="radio" name="cmp-newer" aria-label={`Compare to ${v.tag}`}
                                                    checked={newer() === v.tag}
                                                    onChange={() => setNewer(v.tag)}
                                                    disabled={!newerThanOlder(v.tag)}
                                                />
                                            </div>
                                            {/* cur: compare this row with the latest version */}
                                            <Show when={v.tag !== latestTag()} fallback={<span class="px-2 py-1 text-sm text-text-muted self-center">cur</span>}>
                                                <A href={compareHref(v.tag, latestTag()!)}
                                                   class="px-2 py-1 border border-border text-sm rounded-md text-primary hover:bg-surface-2 transition-colors font-mono self-center">
                                                    cur
                                                </A>
                                            </Show>
                                            {/* prev: compare this row with the version before it */}
                                            <Show when={prevTag()} fallback={<span class="px-2 py-1 text-sm text-text-muted self-center">prev</span>}>{prev =>
                                                <A href={compareHref(prev(), v.tag)}
                                                   class="px-2 py-1 border border-border text-sm rounded-md text-primary hover:bg-surface-2 transition-colors font-mono self-center">
                                                    prev
                                                </A>
                                            }</Show>
                                        </Show>
                                    </div>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </div>
        </>
    );
}
