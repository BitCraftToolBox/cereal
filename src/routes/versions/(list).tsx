import {A, useNavigate} from "@solidjs/router";
import {For, Show, createMemo, createEffect} from "solid-js";
import {Title} from "@solidjs/meta";
import {useVersions} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";
import {LoadingSpinner} from "~/components/LoadingSpinner";

export default function VersionsListPage() {
    const versions = useVersions();
    const nav = useNavHistory();
    const navigate = useNavigate();

    createEffect(() => {
        nav.push({path: `/versions`, label: `📋 Versions`});
    });

    const sortedVersions = createMemo(() => versions.versions() ?? []);

    const selectAndBrowse = (tag: string) => {
        versions.setCurrentTag(tag);
        nav.push({path: "/", label: "Home"});
        navigate("/");
    };

    return (
        <>
            <Title>Versions — cereal</Title>
            <div class="max-w-4xl w-full mx-auto py-6">
                <h1 class="text-2xl font-bold mb-1">Game Data Versions</h1>
                <p class="text-text-muted text-sm mb-6">
                    Each version corresponds to a game patch. Select a version to browse its data.
                </p>

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
                            {(v) => {
                                const isCurrent = () => versions.currentTag() === v.tag;
                                const firstLine = () => v.description?.split("\n")[0]?.trim() ?? "";

                                return (
                                    <div
                                        class="rounded-lg border bg-surface-1 p-4 flex items-start gap-4"
                                        classList={{
                                            "border-primary": isCurrent(),
                                            "border-border": !isCurrent(),
                                        }}
                                    >
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 flex-wrap">
                                                <span class="font-mono font-semibold text-text">{v.tag}</span>
                                                <Show when={v.label && v.label !== v.tag}>
                                                    <span class="text-text-muted text-sm">—</span>
                                                    <span class="text-text-muted text-sm">{v.label}</span>
                                                </Show>
                                                <Show when={isCurrent()}>
                                                    <span class="ml-1 text-xs bg-primary/20 text-primary border border-primary/30 rounded-sm px-1.5 py-0.5 font-medium">
                                                        Current
                                                    </span>
                                                </Show>
                                            </div>
                                            <Show when={firstLine()}>
                                                <p class="text-text-muted text-sm mt-1 truncate">{firstLine()}</p>
                                            </Show>
                                        </div>

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
