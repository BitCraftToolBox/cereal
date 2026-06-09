import {useParams, A, useNavigate} from "@solidjs/router";
import {Show, For, createEffect} from "solid-js";
import {Title} from "@solidjs/meta";
import {useVersions} from "~/lib/data";
import {useNavHistory} from "~/lib/navHistory";

/** Very simple markdown-like renderer: converts URLs in text to links, newlines to <br> */
function DescriptionRenderer(props: { text: string }) {
    const lines = () => props.text.split("\n");

    // Regex to find URLs
    const urlRegex = /https?:\/\/[^\s)]+/g;

    type LinePart = { kind: "text"; value: string } | { kind: "link"; url: string };

    const renderLine = (line: string): LinePart[] => {
        const parts: LinePart[] = [];
        let last = 0;
        let match: RegExpExecArray | null;
        urlRegex.lastIndex = 0;
        while ((match = urlRegex.exec(line)) !== null) {
            if (match.index > last) parts.push({kind: "text", value: line.slice(last, match.index)});
            parts.push({kind: "link", url: match[0]});
            last = match.index + match[0].length;
        }
        if (last < line.length) parts.push({kind: "text", value: line.slice(last)});
        return parts;
    };

    return (
        <div class="text-text whitespace-pre-wrap leading-relaxed">
            <For each={lines()}>
                {(line, i) => (
                    <>
                        <Show when={i() > 0}><br/></Show>
                        <For each={renderLine(line)}>
                            {(part) =>
                                part.kind === "text" ? (
                                    <span>{part.value}</span>
                                ) : (
                                    <a
                                        href={part.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="text-primary underline hover:text-primary-hover"
                                    >
                                        {part.url}
                                    </a>
                                )
                            }
                        </For>
                    </>
                )}
            </For>
        </div>
    );
}

export default function VersionDetailPage() {
    const params = useParams<{ tag: string }>();
    const versions = useVersions();
    const nav = useNavHistory();
    const navigate = useNavigate();

    createEffect(() => {
        nav.push({path: `/versions/${params.tag}`, label: `📋 ${params.tag}`});
    });

    const allVersions = () => versions.versions() ?? [];
    const currentIndex = () => allVersions().findIndex((v) => v.tag === params.tag);
    const nextVersion = () => currentIndex() > 0 ? allVersions()[currentIndex() - 1] : null;
    const prevVersion = () => currentIndex() < allVersions().length - 1 ? allVersions()[currentIndex() + 1] : null;
    const version = () => allVersions()[currentIndex()];
    const isCurrent = () => versions.currentTag() === params.tag;

    function handleSelectKey(e: KeyboardEvent) {
        let target;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            target = prevVersion()?.tag;
        } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            target = nextVersion()?.tag;
        }
        if (target) {
            nav.updateTop(`📋 ${target}`, `/versions/${target}`);
            navigate(`/versions/${target}`);
        }
    }

    return (
        <>
            <Title>{`${params.tag} — Versions — cereal`}</Title>
            <div class="max-w-3xl w-full mx-auto py-6">
                {/* Navigation panel */}
                <div class="rounded-lg border border-border bg-surface-1 p-4 mb-4 flex flex-col gap-3">
                    <div class="flex items-center justify-between gap-2">
                        <Show when={prevVersion()} fallback={
                            <button disabled class="grow basis-0 px-3 py-1.5 rounded-md border border-border text-text-muted text-sm cursor-not-allowed opacity-50">← Previous</button>
                        }>
                            {(prev) => (
                                <A href={`/versions/${prev().tag}`} onclick={() => nav.updateTop(`📋 ${prev().tag}`, `/versions/${prev().tag}`)}
                                   class="grow basis-0 text-center px-3 py-1.5 rounded-md border border-border text-text hover:bg-surface-2 transition-colors text-sm">
                                    ← {prev().tag}
                                </A>
                            )}
                        </Show>
                        <div class="grow flex justify-center gap-2">
                            <label class="sr-only">Jump: </label>
                            <select
                                class="max-w-[36ch] rounded-md border border-border bg-surface-2 text-text text-sm px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-primary"
                                value={params.tag}
                                onKeyDown={handleSelectKey}
                                onChange={(e) => {
                                    const target = e.currentTarget.value;
                                    nav.updateTop(`📋 ${target}`, `/versions/${target}`);
                                    navigate(`/versions/${target}`);
                                }}
                            >
                                <For each={allVersions()}>
                                    {(v, i) => (
                                        <option value={v.tag} selected={i() === currentIndex()}>{v.label && v.label !== v.tag ? `${v.tag} (${v.label})` : v.tag}</option>
                                    )}
                                </For>
                            </select>
                            <A href={"/versions"} class="px-3 py-1.5 rounded-md border border-border text-text hover:bg-surface-2 transition-colors text-sm whitespace-nowrap">
                                View all
                            </A>
                        </div>
                        <Show when={nextVersion()} fallback={
                            <button disabled class="grow basis-0 px-3 py-1.5 rounded-md border border-border text-text-muted text-sm cursor-not-allowed opacity-50">Next →</button>
                        }>
                            {(next) => (
                                <A href={`/versions/${next().tag}`} onclick={() => nav.updateTop(`📋 ${next().tag}`, `/versions/${next().tag}`)}
                                   class="grow basis-0 text-center px-3 py-1.5 rounded-md border border-border text-text hover:bg-surface-2 transition-colors text-sm">
                                    {next().tag} →
                                </A>
                            )}
                        </Show>
                    </div>
                </div>
                <Show
                    when={version()}
                    fallback={
                        <Show
                            when={!versions.versions.loading}
                            fallback={<p class="text-text-muted">Loading…</p>}
                        >
                            <div class="rounded-lg border border-border bg-surface-1 p-6">
                                <p class="text-text-muted">Version <code class="font-mono">{params.tag}</code> not found.</p>
                                <A href={"/versions"} class="mt-3 inline-block text-primary hover:underline text-sm">← Back to versions</A>
                            </div>
                        </Show>
                    }
                >
                    {(v) => (
                        <div class="rounded-lg border border-border bg-surface-1 p-6">
                            <div class="flex items-start justify-between gap-4 flex-wrap mb-4">
                                <div>
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <h1 class="text-2xl font-bold font-mono">{v().tag}</h1>
                                        <Show when={isCurrent()}>
                                            <span class="text-xs bg-primary/20 text-primary border border-primary/30 rounded-sm px-1.5 py-0.5 font-medium">
                                                Current
                                            </span>
                                        </Show>
                                    </div>
                                    <Show when={v().label && v().label !== v().tag}>
                                        <p class="text-text-muted mt-1">{v().label}</p>
                                    </Show>
                                </div>

                                <Show when={!isCurrent()}>
                                    <button
                                        onClick={() => {
                                            versions.setCurrentTag(v().tag);
                                            nav.push({path: "/", label: "Home"});
                                            navigate("/");
                                        }}
                                        class="px-4 py-2 rounded-md bg-primary text-white hover:bg-primary-hover transition-colors text-sm"
                                    >
                                        Browse this version
                                    </button>
                                </Show>
                            </div>

                            <Show when={v().description} fallback={
                                <p class="text-text-muted text-sm italic">No description available.</p>
                            }>
                                <div class="border-t border-border pt-4">
                                    <DescriptionRenderer text={v().description!}/>
                                </div>
                            </Show>
                        </div>
                    )}
                </Show>
            </div>
        </>
    );
}
