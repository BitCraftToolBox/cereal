import {A} from "@solidjs/router";

export function TableNotFound(props: { name: string }) {
    return (
        <div class="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div class="text-5xl">🥣</div>
            <h1 class="text-2xl font-bold">Table not found</h1>
            <p class="text-text-muted text-sm">
                <span class="font-mono bg-surface-2 px-2 py-0.5 rounded border border-border">{props.name}</span>
                {" "}does not exist in this version of the data.
            </p>
            <A href="/"
               class="px-4 py-2 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors">
                Go home
            </A>
        </div>
    );
}

export function ObjectNotFound(props: { name: string; id: string }) {
    return (
        <div class="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div class="text-5xl">🥣</div>
            <h1 class="text-2xl font-bold">Object not found</h1>
            <p class="text-text-muted text-sm">
                No entry with id{" "}
                <span class="font-mono bg-surface-2 px-2 py-0.5 rounded border border-border">{props.id}</span>
                {" "}in{" "}
                <A href={`/table/${props.name}`} class="font-mono underline hover:text-primary">{props.name}</A>.
            </p>
            <A
                href={`/table/${props.name}`}
                class="px-4 py-2 rounded-lg bg-primary text-white font-medium hover:bg-primary-hover transition-colors"
            >
                Back to table
            </A>
        </div>
    );
}
