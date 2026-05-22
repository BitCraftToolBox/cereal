import {A, useLocation} from "@solidjs/router";
import {Title} from "@solidjs/meta";

export default function NotFound() {
    const location = useLocation();

    return (
        <div class="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-center px-4">
            <Title>404 — cereal</Title>
            <span class="text-4xl" aria-hidden="true">🥣️</span>
            <div class="space-y-1">
                <p class="text-lg font-semibold text-text">404</p>
                <p class="text-sm text-text-muted font-mono max-w-xl wrap-break-word">Page not found</p>
            </div>
            <p class="text-text-muted text-sm max-w-sm">
                <span class="font-mono bg-surface-2 px-2 py-0.5 rounded-sm text-text border border-border">
                    {location.pathname}
                </span>
                {" "}doesn't exist or may have been moved.
            </p>
            <A
                href="/"
                class="px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors"
            >
                Go home
            </A>
        </div>
    );
}
