import type {AlgebraicType} from "./schema";

function getVariantName(t: { name?: { some: string } | unknown } | undefined): string | undefined {
    return t && t.name && typeof t.name === "object" && "some" in t.name
        ? (t.name as { some: string }).some
        : undefined;
}

export function getOptionSomeBranch(t: AlgebraicType): AlgebraicType | undefined {
    if (!t.Sum || t.Sum.variants.length !== 2) return undefined;
    const names = t.Sum.variants.map((v) => getVariantName(v) ?? "");
    if (!names.includes("some") || !names.includes("none")) return undefined;
    const some = t.Sum.variants.find((v) => getVariantName(v) === "some");
    return some?.algebraic_type;
}

export function unwrapRefOptionArray(
    t: AlgebraicType,
    resolveRef: (idx: number) => AlgebraicType | undefined,
): AlgebraicType {
    if (t.Ref !== undefined) return unwrapRefOptionArray(resolveRef(t.Ref) ?? t, resolveRef);
    if (t.Array) return unwrapRefOptionArray(t.Array, resolveRef);
    const some = getOptionSomeBranch(t);
    if (some) return unwrapRefOptionArray(some, resolveRef);
    return t;
}

export function findRefIndexThroughOptionArray(t: AlgebraicType): number | undefined {
    if (t.Ref !== undefined) return t.Ref;
    if (t.Array) return findRefIndexThroughOptionArray(t.Array);
    const some = getOptionSomeBranch(t);
    if (some) return findRefIndexThroughOptionArray(some);
    return undefined;
}

export function hasArrayThroughOption(t: AlgebraicType): boolean {
    if (t.Array) return true;
    const some = getOptionSomeBranch(t);
    if (some) return hasArrayThroughOption(some);
    return false;
}

