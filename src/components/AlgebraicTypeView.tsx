/**
 * AlgebraicTypeView — interactive, expandable renderer for SpacetimeDB AlgebraicType values.
 *
 * Usage:
 *   const ctx = data.getTypeContext();
 *   const type = data.getColumnTypeRaw(tableName, col);
 *   <Show when={ctx && type}>
 *     <AlgebraicTypeView type={type!} ctx={ctx!} />
 *   </Show>
 */

import {createSignal, For, type JSX, Show} from "solid-js";
import type {AlgebraicType, ProductElement, SpacetimeDBSchema, SumVariant} from "~/lib/schema";

export type TypeContext = {
    schema: SpacetimeDBSchema;
    idxMap: Map<number, string>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCALAR_NAMES: [key: string, display: string][] = [
    ["U8", "u8"], ["U16", "u16"], ["U32", "u32"], ["U64", "u64"], ["U128", "u128"], ["U256", "u256"],
    ["I8", "i8"], ["I16", "i16"], ["I32", "i32"], ["I64", "i64"], ["I128", "i128"], ["I256", "i256"],
    ["F32", "f32"], ["F64", "f64"],
    ["Bool", "bool"],
    ["String", "string"],
    ["Bytes", "bytes"],
];

function getScalarName(type: AlgebraicType): string | undefined {
    for (const [key, display] of SCALAR_NAMES) {
        if (key in type) return display;
    }
    return undefined;
}

/** If this type is Option<T>, return T; otherwise null. */
function unwrapOption(type: AlgebraicType): AlgebraicType | null {
    if (!type.Sum || type.Sum.variants.length !== 2) return null;
    const names = type.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : null));
    if (!names.includes("some") || !names.includes("none")) return null;
    return type.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!
        .algebraic_type;
}

/** Check if a Sum type is a pure enum (every variant has an empty Product body). */
function isPureEnum(type: AlgebraicType): boolean {
    return !!type.Sum && type.Sum.variants.every(
        (v) => v.algebraic_type.Product?.elements.length === 0,
    );
}

/** Whether a type has expandable inner structure (not just a scalar). */
function isExpandable(type: AlgebraicType): boolean {
    if (getScalarName(type)) return false;
    return !!(type.Sum || type.Product);
}

// ---------------------------------------------------------------------------
// Root dispatcher
// ---------------------------------------------------------------------------

export function AlgebraicTypeView(props: {
    type: AlgebraicType;
    ctx: TypeContext;
    /** Recursion depth — callers should leave this unset (defaults to 0). */
    depth?: number;
}): JSX.Element {
    const depth = () => props.depth ?? 0;
    const t = () => props.type;

    // Scalars
    const scalar = () => getScalarName(t());
    return (
        <Show when={scalar()} fallback={<ComplexTypeView type={t()} ctx={props.ctx} depth={depth()}/>}>
            {(name) => <ScalarChip name={name()}/>}
        </Show>
    );
}

// Renders non-scalar types
function ComplexTypeView(props: { type: AlgebraicType; ctx: TypeContext; depth: number }): JSX.Element {
    const t = () => props.type;

    // Ref
    if (t().Ref !== undefined) {
        return <RefView refIdx={t().Ref!} ctx={props.ctx} depth={props.depth}/>;
    }

    // Array<T>
    if (t().Array) {
        return (
            <span class="inline-flex items-baseline gap-0.5 flex-wrap">
        <AlgebraicTypeView type={t().Array!} ctx={props.ctx} depth={props.depth}/>
        <span class="text-text-muted/60">[]</span>
      </span>
        );
    }

    // Sum types
    if (t().Sum) {
        // Option<T>
        const inner = unwrapOption(t());
        if (inner) {
            return (
                <span class="inline-flex items-baseline gap-0.5">
          <AlgebraicTypeView type={inner} ctx={props.ctx} depth={props.depth}/>
          <span class="text-yellow-400/80 font-bold">?</span>
        </span>
            );
        }
        if (isPureEnum(t())) {
            return <EnumView variants={t().Sum!.variants}/>;
        }
        return <SumView variants={t().Sum!.variants} ctx={props.ctx} depth={props.depth}/>;
    }

    // Product (struct)
    if (t().Product) {
        return <ProductView elements={t().Product!.elements} ctx={props.ctx} depth={props.depth}/>;
    }

    return <span class="text-text-muted/80 italic">unknown</span>;
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function ScalarChip(props: { name: string }): JSX.Element {
    const cls = () => {
        switch (props.name) {
            case "string":
                return "text-green-400/90";
            case "bool":
                return "text-purple-400/90";
            case "bytes":
                return "text-orange-400/90";
            default:
                return "text-sky-400/90"; // numeric types
        }
    };
    return <span class={cls()}>{props.name}</span>;
}

// ---------------------------------------------------------------------------
// Ref — named type, expandable
// ---------------------------------------------------------------------------

function RefView(props: { refIdx: number; ctx: TypeContext; depth: number }): JSX.Element {
    const [expanded, setExpanded] = createSignal(false);
    const name = () => props.ctx.idxMap.get(props.refIdx) ?? `Ref(${props.refIdx})`;
    const resolved = () => props.ctx.schema.typespace?.types?.[props.refIdx];
    const canExpand = () => {
        const r = resolved();
        return !!r && isExpandable(r);
    };

    return (
        <span class="inline-flex flex-col gap-0.5">
            <span class="inline-flex items-baseline gap-0.5">
            <Show
                when={canExpand()}
                fallback={<span class="text-amber-300/90">{name()}</span>}
            >
                <button
                    class="text-amber-300/90 hover:text-amber-200 inline-flex items-baseline gap-0.5 cursor-pointer transition-colors"
                    onClick={(e) => {
                        e.stopPropagation();
                        setExpanded((v) => !v);
                    }}
                    title={expanded() ? "Collapse" : `Expand ${name()}`}
                >
                    <span
                        class="text-text-muted/50 text-[10px] leading-none select-none">{expanded() ? "▾" : "▸"}</span>
                    <span>{name()}</span>
                </button>
            </Show>
            </span>
            <Show when={expanded() && resolved()}>
                <div class="ml-2 pl-2 border-l border-border/50">
                    <AlgebraicTypeView type={resolved()!} ctx={props.ctx} depth={props.depth + 1}/>
                </div>
            </Show>
        </span>
    );
}

// ---------------------------------------------------------------------------
// Pure enum — inline variant list, truncated with "show more"
// ---------------------------------------------------------------------------

const ENUM_INLINE_LIMIT = 8;

function EnumView(props: { variants: SumVariant[] }): JSX.Element {
    const [expanded, setExpanded] = createSignal(false);
    const names = () =>
        props.variants
            .map((v) => (v.name && "some" in v.name ? v.name.some : null))
            .filter(Boolean) as string[];
    const shown = () => (expanded() ? names() : names().slice(0, ENUM_INLINE_LIMIT));
    const extra = () => names().length - ENUM_INLINE_LIMIT;

    return (
        <span class="inline-flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
            <For each={shown()}>
                {(v, i) => (
                    <>
                        <Show when={i() > 0}>
                            <span class="text-text-muted/50 select-none">|</span>
                        </Show>
                        <span class="text-violet-400/80" title={String(i())}>{v}</span>
                    </>
                )}
            </For>
            <Show when={!expanded() && extra() > 0}>
                <button
                    class="text-text-muted/50 hover:text-text-muted text-[11px] transition-colors ml-0.5"
                    onClick={() => setExpanded(true)}
                >
                    +{extra()} more
                </button>
            </Show>
            <Show when={expanded() && names().length > ENUM_INLINE_LIMIT}>
                <button
                    class="text-text-muted/50 hover:text-text-muted text-[11px] transition-colors ml-0.5"
                    onClick={() => setExpanded(false)}
                >
                    less
                </button>
            </Show>
        </span>
    );
}

// ---------------------------------------------------------------------------
// Sum (tagged union with payloads) — collapsible variant list
// ---------------------------------------------------------------------------

function SumView(props: { variants: SumVariant[]; ctx: TypeContext; depth: number }): JSX.Element {
    return (
        <div class="space-y-0.5">
            <For each={props.variants}>
                {(v) => {
                    const vName = v.name && "some" in v.name ? v.name.some : "?";
                    const inner = v.algebraic_type;
                    const isEmpty = !!(inner.Product && inner.Product.elements.length === 0);
                    return (
                        <div class="flex items-start gap-1">
                            <span class="text-text-muted/50 select-none mt-px">|</span>
                            <span class="text-pink-300/80">{vName}</span>
                            <Show when={!isEmpty}>
                                <span class="text-text-muted/50 select-none">(</span>
                                <AlgebraicTypeView type={inner} ctx={props.ctx} depth={props.depth + 1}/>
                                <span class="text-text-muted/50 select-none">)</span>
                            </Show>
                        </div>
                    );
                }}
            </For>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Product (struct / record) — field list
// ---------------------------------------------------------------------------

function ProductView(props: { elements: ProductElement[]; ctx: TypeContext; depth: number }): JSX.Element {
    if (props.elements.length === 0) {
        return <span class="text-text-muted/50">{"{}"}</span>;
    }

    return (
        <div class="space-y-0.5">
            <For each={props.elements}>
                {(el) => {
                    const fieldName = el.name && "some" in el.name ? el.name.some : "?";
                    return (
                        <div class="flex items-start gap-1.5">
                            <span class="text-text/80">{fieldName}</span>
                            <span class="text-text-muted/50 select-none">:</span>
                            <AlgebraicTypeView type={el.algebraic_type} ctx={props.ctx} depth={props.depth + 1}/>
                        </div>
                    );
                }}
            </For>
        </div>
    );
}
