import {createEffect, createMemo, createSignal, For, JSX, Show} from "solid-js";
import {A} from "@solidjs/router";
import {type ForeignKeyMapping, resolveTargetTable} from "~/lib/schema";
import {SpriteLink} from "~/components/SpriteImage";

interface JsonViewerProps {
    data: unknown;
    expandDepth?: number;
    copyable?: boolean;
    fkMap?: Map<string, {
        targetTable: string;
        conditionalTargets?: ForeignKeyMapping["conditionalTargets"];
        enumConversion?: string
    }>;
    displayNames?: Map<string, Map<string, string>>;
    enumValues?: Record<string, string[]>;
    enumVariantsByName?: Map<string, string[]>;
    spriteFields?: Set<string>;
}

export function JsonViewer(props: JsonViewerProps) {
    const [copied, setCopied] = createSignal(false);
    // null = not forced; true/false = force all expanded/collapsed (version counter forces re-evaluation)
    const [forceExpanded, setForceExpanded] = createSignal<{ value: boolean } | null>(null);

    const copyJson = () => {
        navigator.clipboard.writeText(JSON.stringify(props.data, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div class="relative">
            <Show when={props.copyable !== false}>
                <button
                    onClick={copyJson}
                    class="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-surface-2 hover:bg-surface-3 border border-border text-text-muted"
                    aria-label="Copy JSON to clipboard"
                >
                    {copied() ? "Copied!" : "Copy JSON"}
                </button>
            </Show>
            <button
                onClick={() => setForceExpanded((f) => f?.value === true ? {value: false} : {value: true})}
                class="absolute top-2 right-24 px-2 py-1 text-xs rounded bg-surface-2 hover:bg-surface-3 border border-border text-text-muted"
                aria-label={forceExpanded()?.value === true ? "Collapse all" : "Expand all"}
            >
                {forceExpanded()?.value === true ? "Collapse all" : "Expand all"}
            </button>
            <pre class="bg-surface-1 border border-border rounded-lg p-4 overflow-auto text-sm font-mono max-h-[80vh]">
                <JsonNode
                    value={props.data}
                    depth={0}
                    maxExpandDepth={props.expandDepth ?? 2}
                    fkMap={props.fkMap}
                    displayNames={props.displayNames}
                    enumValues={props.enumValues}
                    enumVariantsByName={props.enumVariantsByName}
                    spriteFields={props.spriteFields}
                    fieldPath=""
                    contextObj={typeof props.data === "object" && props.data !== null && !Array.isArray(props.data)
                        ? props.data as Record<string, unknown>
                        : undefined}
                    forceExpanded={forceExpanded()}
                />
            </pre>
        </div>
    );
}

interface JsonNodeProps {
    value: unknown;
    depth: number;
    maxExpandDepth: number;
    keyName?: string;
    trailing?: boolean;
    fieldPath: string;
    fkMap?: Map<string, {
        targetTable: string;
        conditionalTargets?: ForeignKeyMapping["conditionalTargets"];
        enumConversion?: string
    }>;
    displayNames?: Map<string, Map<string, string>>;
    enumValues?: Record<string, string[]>;
    enumVariantsByName?: Map<string, string[]>;
    contextObj?: Record<string, unknown>;
    forceExpanded?: { value: boolean } | null;
    spriteFields?: Set<string>;
}

function JsonNode(props: JsonNodeProps) {
    const isExpandable = () =>
        props.value !== null && typeof props.value === "object";
    const [expanded, setExpanded] = createSignal(props.depth < props.maxExpandDepth);

    createEffect(() => {
        const f = props.forceExpanded;
        if (f !== null && f !== undefined) setExpanded(f.value);
    });
    const indent = () => "  ".repeat(props.depth);
    const childIndent = () => "  ".repeat(props.depth + 1);

    const fkInfo = createMemo(() => {
        if (!props.fkMap || isExpandable()) return null;
        return props.fkMap.get(props.fieldPath) ?? null;
    });

    const resolvedTargetTable = createMemo(() => {
        const fk = fkInfo();
        if (!fk) return null;
        if (!fk.conditionalTargets?.length) return fk.targetTable;
        // Use contextObj for sibling lookup
        const ctx = props.contextObj ?? {};
        return resolveTargetTable(
            {
                sourceTable: "",
                sourceField: props.fieldPath,
                targetTable: fk.targetTable,
                conditionalTargets: fk.conditionalTargets
            },
            ctx,
            props.enumValues,
        );
    });

    // For enumConversion FKs, convert string value → numeric index for href/label lookup
    const resolvedId = createMemo(() => {
        const fk = fkInfo();
        if (!fk?.enumConversion || typeof props.value !== "string") return String(props.value ?? "");
        const variants = props.enumVariantsByName?.get(fk.enumConversion);
        if (!variants) return String(props.value);
        const idx = variants.indexOf(props.value as string);
        return idx !== -1 ? String(idx) : String(props.value);
    });

    const fkLabel = createMemo(() => {
        const target = resolvedTargetTable();
        if (!target || props.value === null || props.value === undefined || props.value === 0) return null;
        return props.displayNames?.get(target)?.get(resolvedId()) ?? null;
    });

    // Enum annotation for scalar values
    const enumVariant = createMemo(() => {
        if (isExpandable() || !props.enumValues) return null;
        const variants = props.enumValues[props.fieldPath];
        if (!variants || typeof props.value !== "number") return null;
        return variants[props.value] ?? null;
    });

    const fkAnnotation = (): JSX.Element => {
        const target = resolvedTargetTable();
        const variant = enumVariant();
        const hasFk = target && !(props.value === null || props.value === undefined || props.value === 0);
        if (!hasFk && !variant) return <></>;
        return (
            <span class="select-none">
                {" "}
                <span class="text-text-muted">{"// "}</span>
                <Show when={hasFk}>
                    <A
                      href={`/table/${target}/${encodeURIComponent(resolvedId())}`}
                      class="text-text-muted hover:text-primary transition-colors"
                      title={`Go to ${target} #${resolvedId()}`}
                    >
                        <Show when={fkLabel()} fallback={<span>→{target}</span>}>
                            <span class="italic">{target} &quot;{fkLabel()}&quot;</span>
                        </Show>
                    </A>
                </Show>
                <Show when={!hasFk && variant}>
                  <span class="text-text-muted italic">{variant}</span>
                </Show>
            </span>
        );
    };

    return (
        <Show
            when={isExpandable()}
            fallback={
                <>
                    <Show
                        when={props.spriteFields?.has(props.fieldPath) && typeof props.value === "string" && props.value.length > 1}
                        fallback={<JsonPrimitive value={props.value}/>}
                    >
                        <span class="text-green-600 dark:text-green-400">"</span>
                        <SpriteLink path={props.value as string}/>
                        <span class="text-green-600 dark:text-green-400">"</span>
                    </Show>
                    <Show when={props.trailing}><span class="text-text-muted">,</span></Show>
                    {fkAnnotation()}
                </>
            }
        >
            {(() => {
                const isArray = Array.isArray(props.value);
                const entries = isArray
                    ? (props.value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
                    : Object.entries(props.value as Record<string, unknown>);
                const openBrace = isArray ? "[" : "{";
                const closeBrace = isArray ? "]" : "}";
                // For object nodes, this object becomes the contextObj for children
                const childContextObj = !isArray && typeof props.value === "object" && props.value !== null
                    ? props.value as Record<string, unknown>
                    : props.contextObj;

                return (
                    <>
                        <button
                            onClick={() => setExpanded((e) => !e)}
                            class="cursor-pointer hover:text-primary text-text-muted inline"
                            aria-expanded={expanded()}
                            aria-label={expanded() ? "Collapse" : "Expand"}
                        >
                            {expanded() ? "▼" : "▶"}{" "}
                        </button>
                        <span class="text-text-muted">{openBrace}</span>
                        <Show
                            when={expanded()}
                            fallback={<span class="text-text-muted"> ...{entries.length} items {closeBrace}</span>}
                        >
                            <For each={entries}>
                                {([key, val], i) => {
                                    const childPath = props.fieldPath
                                        ? (isArray ? props.fieldPath : `${props.fieldPath}.${key}`)
                                        : key;
                                    return (
                                        <div>
                                            <span>{childIndent()}</span>
                                            <Show when={!isArray}>
                                                <span class="text-primary">&quot;{key}&quot;</span>
                                                <span class="text-text-muted">: </span>
                                            </Show>
                                            <JsonNode
                                                value={val}
                                                depth={props.depth + 1}
                                                maxExpandDepth={props.maxExpandDepth}
                                                trailing={i() < entries.length - 1}
                                                fieldPath={childPath}
                                                fkMap={props.fkMap}
                                                displayNames={props.displayNames}
                                                enumValues={props.enumValues}
                                                enumVariantsByName={props.enumVariantsByName}
                                                spriteFields={props.spriteFields}
                                                contextObj={childContextObj}
                                                forceExpanded={props.forceExpanded}
                                            />
                                        </div>
                                    );
                                }}
                            </For>
                            <div>
                                <span>{indent()}</span>
                                <span class="text-text-muted">{closeBrace}</span>
                                <Show when={props.trailing}><span class="text-text-muted">,</span></Show>
                            </div>
                        </Show>
                    </>
                );
            })()}
        </Show>
    );
}

function JsonPrimitive(props: { value: unknown }) {
    const colorClass = createMemo(() => {
        if (props.value === null) return "text-text-muted";
        if (typeof props.value === "string") return "text-green-600 dark:text-green-400";
        if (typeof props.value === "number") return "text-blue-600 dark:text-blue-400";
        if (typeof props.value === "boolean") return "text-yellow-600 dark:text-yellow-400";
        return "text-text";
    });

    const display = createMemo(() => {
        if (props.value === null) return "null";
        if (typeof props.value === "string") return `"${props.value}"`;
        return String(props.value);
    });

    return <span class={colorClass()}>{display()}</span>;
}
