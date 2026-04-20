import {JSX} from "solid-js";

interface Props {
    size?: "sm" | "md" | "lg";
    label?: string;
    class?: string;
}

export function LoadingSpinner(props: Props): JSX.Element {
    const sizeClass = () => {
        switch (props.size ?? "md") {
            case "sm":
                return "w-4 h-4 border-2";
            case "lg":
                return "w-10 h-10 border-4";
            default:
                return "w-6 h-6 border-2";
        }
    };

    return (
        <div
            class={`flex flex-col items-center justify-center gap-3 ${props.class ?? ""}`}
            role="status"
            aria-label={props.label ?? "Loading…"}
        >
            <span
                class={`${sizeClass()} rounded-full border-border border-t-primary animate-spin`}
                aria-hidden="true"
            />
            <span class="text-sm text-text-muted sr-only">{props.label ?? "Loading…"}</span>
        </div>
    );
}

/** Full-page centred loading state, used as a Suspense fallback between route transitions. */
export function PageLoader(): JSX.Element {
    return (
        <div class="flex items-center justify-center min-h-[40vh]">
            <LoadingSpinner size="lg" label="Loading page…"/>
        </div>
    );
}
