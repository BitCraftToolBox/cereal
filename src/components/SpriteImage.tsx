import {createSignal, onCleanup, Show} from "solid-js";
import {Portal} from "solid-js/web";
import {SPRITE_CDN_BASE} from "~/lib/constants";

/** All URL variants for a path with bracket notation, base first then each quantity tier. */
function spriteVariants(path: string): string[] {
    const bracketMatch = path.match(/^([\w/]+)(\[(,\d+)+])$/);
    if (!bracketMatch) return [`${SPRITE_CDN_BASE}/${path}.webp`];
    const baseName = bracketMatch[1];
    const quantities = bracketMatch[2]
        .split(",")
        .map((n) => parseInt(n))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);
    return [
        `${SPRITE_CDN_BASE}/${baseName}.webp`,
        ...quantities.map((q) => `${SPRITE_CDN_BASE}/${baseName}${q}.webp`),
    ];
}

/** Renders a sprite asset path as a link to the image, with a fixed-position image tooltip on hover. */
export function SpriteLink(props: { path: string; class?: string }) {
    const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
    const [frameIdx, setFrameIdx] = createSignal(0);
    const variants = () => spriteVariants(props.path);
    const currentUrl = () => variants()[frameIdx() % variants().length];

    let interval: ReturnType<typeof setInterval> | undefined;

    const showAt = (e: MouseEvent) => {
        setPos({x: e.clientX, y: e.clientY});
        if (variants().length > 1 && !interval) {
            interval = setInterval(() => setFrameIdx((i) => i + 1), 600);
        }
    };
    const move = (e: MouseEvent) => setPos({x: e.clientX, y: e.clientY});
    const hide = () => {
        setPos(null);
        setFrameIdx(0);
        if (interval) {
            clearInterval(interval);
            interval = undefined;
        }
    };

    onCleanup(() => {
        if (interval) clearInterval(interval);
    });

    return (
        <>
            <a
                href={`${SPRITE_CDN_BASE}/${props.path}.webp`}
                target="_blank"
                rel="noopener noreferrer"
                class={`text-primary hover:underline font-mono text-xs ${props.class ?? ""}`}
                onMouseEnter={showAt}
                onMouseMove={move}
                onMouseLeave={hide}
                onClick={(e) => e.stopPropagation()}
            >
                {props.path}
            </a>
            <Show when={pos()}>
                <Portal mount={document.body}>
                    <div
                        class="fixed z-9999 p-1 bg-surface-1 border border-border rounded-sm shadow-lg pointer-events-none"
                        style={{left: `${pos()!.x + 12}px`, top: `${pos()!.y + 12}px`}}
                    >
                        <img
                            src={currentUrl()}
                            alt={props.path}
                            class="max-w-[128px] max-h-[128px] object-contain"
                            style="image-rendering: crisp-edges"
                        />
                    </div>
                </Portal>
            </Show>
        </>
    );
}
