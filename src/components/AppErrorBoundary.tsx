import {ErrorBoundary, type JSX} from "solid-js";

interface Props {
    children: JSX.Element;
}

function ErrorFallback(err: unknown, reset: () => void) {
    const message = err instanceof Error ? err.message : String(err);
    return (
        <div
            class="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-center px-4"
            role="alert"
            aria-live="assertive"
        >
            <span class="text-4xl" aria-hidden="true">⚠️</span>
            <div class="space-y-1">
                <p class="text-lg font-semibold text-text">Something went wrong</p>
                <p class="text-sm text-text-muted font-mono max-w-xl wrap-break-word">{message}</p>
            </div>
            <button
                class="px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors"
                onClick={reset}
            >
                Try again
            </button>
        </div>
    );
}

export function AppErrorBoundary(props: Props) {
    return (
        <ErrorBoundary fallback={ErrorFallback}>
            {props.children}
        </ErrorBoundary>
    );
}
