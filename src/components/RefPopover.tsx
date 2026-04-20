import {createEffect, createSignal, For, onCleanup, Show} from "solid-js";
import {A} from "@solidjs/router";
import type {JSX} from "solid-js";

export interface RefLink {
    href: string;
    label: string;
}

interface RefPopoverProps {
    links: RefLink[];
    class?: string;
    children: (toggle: (e: MouseEvent) => void, open: () => boolean) => JSX.Element;
}

export function RefPopover(props: RefPopoverProps) {
    const [open, setOpen] = createSignal(false);
    let containerRef: HTMLDivElement | undefined;

    const toggle = (e: MouseEvent) => {
        e.preventDefault();
        setOpen((v) => !v);
    };

    const handleOutside = (e: MouseEvent) => {
        if (containerRef && !containerRef.contains(e.target as Node)) {
            setOpen(false);
        }
    };

    const handleKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false);
    };

    createEffect(() => {
        if (open()) {
            document.addEventListener("mousedown", handleOutside);
            document.addEventListener("keydown", handleKey);
        } else {
            document.removeEventListener("mousedown", handleOutside);
            document.removeEventListener("keydown", handleKey);
        }
    });

    onCleanup(() => {
        document.removeEventListener("mousedown", handleOutside);
        document.removeEventListener("keydown", handleKey);
    });

    return (
        <div ref={containerRef} class={`relative inline-block ${props.class ?? ""}`}>
            {props.children(toggle, open)}
            <Show when={open()}>
                <div
                    class="absolute z-50 top-full left-0 mt-1 min-w-[220px] max-w-xs max-h-72 overflow-y-auto rounded-md border border-border bg-surface-0 shadow-lg py-1"
                    role="menu"
                >
                    <For each={props.links}>
                        {(link) => (
                            <A
                                href={link.href}
                                role="menuitem"
                                class="flex px-3 py-1.5 text-sm font-mono hover:bg-surface-1 hover:text-primary transition-colors whitespace-nowrap"
                                onClick={() => setOpen(false)}
                            >
                                {link.label}
                            </A>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
