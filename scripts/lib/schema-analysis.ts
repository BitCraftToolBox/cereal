import type {AlgebraicType, ProductElement, SpacetimeDBSchema} from "../../src/lib/schema";
import type {SchemaInfo} from "./table-meta";
import {createSchemaTypeContext} from "../../src/lib/schemaDerive";
import {getOptionSomeBranch} from "../../src/lib/type-walkers";

interface TaggedUnionField {
    path: string;
    typeName: string;
    inList: boolean;
}

interface SchemaAnalysis {
    schemaTableInfo: Map<string, SchemaInfo>;
    globalEnumRegistry: Map<string, { name: string; values: string[] }>;
    resolveEnumNameFromVariants: (columnPath: string, variants: string[]) => string;
    collectTaggedUnionFieldsByName: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
        overrideKeys: Set<string>,
    ) => TaggedUnionField[];
    collectIdFieldsFromProductForFK: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ) => Array<{ path: string; inList: boolean }>;
    /** Every enum-typed column path in a product tree, with the array flag and variants. */
    collectEnumFieldsFromProductForFK: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ) => Array<{ path: string; variants: string[]; inList: boolean }>;
    /** Resolve a dotted column path against the schema (unwrapping Ref/Option/Array). */
    resolveColumnPath: (productTypeRef: number, path: string) => { found: boolean; inList: boolean };
}

export function buildSchemaAnalysis(regionSchema: SpacetimeDBSchema): SchemaAnalysis {
    // Shared, drift-proof type/enum derivation (same module the frontend uses).
    const ctx = createSchemaTypeContext(regionSchema);
    const {
        isEnumType,
        unwrapType,
        getEnumVariants,
        findCanonicalNameUnwrapped,
        hasArrayWrapper,
        globalEnumRegistry,
        resolveEnumNameFromVariants,
        collectProductFields,
    } = ctx;

    function collectTaggedUnionFieldsByName(
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
        overrideKeys: Set<string>,
    ): TaggedUnionField[] {
        const result: TaggedUnionField[] = [];
        for (const el of elements) {
            const name = el.name && "some" in el.name ? el.name.some : null;
            if (!name) continue;
            const fullPath = prefix ? `${prefix}.${name}` : name;
            const canonicalName = findCanonicalNameUnwrapped(el.algebraic_type);
            const isArr = hasArrayWrapper(el.algebraic_type);
            if (canonicalName && overrideKeys.has(canonicalName)) {
                result.push({path: fullPath, typeName: canonicalName, inList: inList || isArr});
            }
            const unwrapped = unwrapType(el.algebraic_type);
            if (unwrapped.Product) {
                result.push(...collectTaggedUnionFieldsByName(unwrapped.Product.elements, fullPath, inList || isArr, overrideKeys));
            }
        }
        return result;
    }

    function collectIdFieldsFromType(
        t: AlgebraicType,
        prefix: string,
        inList: boolean,
    ): Array<{ path: string; inList: boolean }> {
        const result: Array<{ path: string; inList: boolean }> = [];

        if (t.Ref !== undefined) {
            const resolved = regionSchema.typespace.types[t.Ref];
            if (resolved) result.push(...collectIdFieldsFromType(resolved, prefix, inList));
            return result;
        }

        if (t.Array) {
            result.push(...collectIdFieldsFromType(t.Array, prefix, true));
            return result;
        }

        const some = getOptionSomeBranch(t);
        if (some) {
            result.push(...collectIdFieldsFromType(some, prefix, inList));
            return result;
        }

        if (isEnumType(t)) return result;

        if (t.Sum) {
            for (const variant of t.Sum.variants) {
                const vName = variant.name && "some" in variant.name ? variant.name.some : null;
                if (!vName) continue;
                const vPath = prefix ? `${prefix}.${vName}_` : `${vName}_`;
                const inner = variant.algebraic_type;
                const innerUnwrapped = unwrapType(inner);
                if (innerUnwrapped.Product && innerUnwrapped.Product.elements.length === 0) continue;
                if (innerUnwrapped.Product) {
                    result.push(...collectIdFieldsFromProductForFK(innerUnwrapped.Product.elements, vPath, inList));
                } else {
                    result.push({path: vPath, inList});
                }
            }
            return result;
        }

        if (t.Product) {
            result.push(...collectIdFieldsFromProductForFK(t.Product.elements, prefix, inList));
        }

        return result;
    }

    function collectIdFieldsFromProductForFK(
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ): Array<{ path: string; inList: boolean }> {
        const result: Array<{ path: string; inList: boolean }> = [];
        for (const el of elements) {
            const name = el.name && "some" in el.name ? el.name.some : null;
            if (!name) continue;
            const fullPath = prefix ? `${prefix}.${name}` : name;
            if (isEnumType(el.algebraic_type)) continue;
            if (name.endsWith("_id") || name.endsWith("_type")) {
                result.push({path: fullPath, inList});
            }
            result.push(...collectIdFieldsFromType(el.algebraic_type, fullPath, inList));
        }
        return result;
    }

    function collectEnumFieldsFromType(
        t: AlgebraicType,
        prefix: string,
        inList: boolean,
    ): Array<{ path: string; variants: string[]; inList: boolean }> {
        if (t.Ref !== undefined) {
            const resolved = regionSchema.typespace.types[t.Ref];
            return resolved ? collectEnumFieldsFromType(resolved, prefix, inList) : [];
        }
        if (t.Array) return collectEnumFieldsFromType(t.Array, prefix, true);
        const some = getOptionSomeBranch(t);
        if (some) return collectEnumFieldsFromType(some, prefix, inList);
        if (isEnumType(t)) return [{path: prefix, variants: getEnumVariants(t), inList}];
        if (t.Sum) {
            const result: Array<{ path: string; variants: string[]; inList: boolean }> = [];
            for (const variant of t.Sum.variants) {
                const vName = variant.name && "some" in variant.name ? variant.name.some : null;
                if (!vName) continue;
                const vPath = prefix ? `${prefix}.${vName}_` : `${vName}_`;
                const innerUnwrapped = unwrapType(variant.algebraic_type);
                if (innerUnwrapped.Product && innerUnwrapped.Product.elements.length > 0) {
                    result.push(...collectEnumFieldsFromProductForFK(innerUnwrapped.Product.elements, vPath, inList));
                }
            }
            return result;
        }
        if (t.Product) return collectEnumFieldsFromProductForFK(t.Product.elements, prefix, inList);
        return [];
    }

    function collectEnumFieldsFromProductForFK(
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ): Array<{ path: string; variants: string[]; inList: boolean }> {
        const result: Array<{ path: string; variants: string[]; inList: boolean }> = [];
        for (const el of elements) {
            const name = el.name && "some" in el.name ? el.name.some : null;
            if (!name) continue;
            const fullPath = prefix ? `${prefix}.${name}` : name;
            result.push(...collectEnumFieldsFromType(el.algebraic_type, fullPath, inList));
        }
        return result;
    }

    /** Unwrap Ref/Option/Array to a structural type, recording whether an Array was crossed. */
    function unwrapToStructural(t: AlgebraicType): { type: AlgebraicType | undefined; inList: boolean } {
        let cur: AlgebraicType | undefined = t;
        let inList = false;
        for (let guard = 0; guard < 100 && cur; guard++) {
            if (cur.Ref !== undefined) {
                cur = regionSchema.typespace.types[cur.Ref];
                continue;
            }
            if (cur.Array) {
                inList = true;
                cur = cur.Array;
                continue;
            }
            const some = getOptionSomeBranch(cur);
            if (some) {
                cur = some;
                continue;
            }
            break;
        }
        return {type: cur, inList};
    }

    function resolveColumnPath(productTypeRef: number, path: string): { found: boolean; inList: boolean } {
        const parts = path.split(".");
        let cur: AlgebraicType | undefined = regionSchema.typespace.types[productTypeRef];
        let inList = false;
        for (const seg of parts) {
            if (!cur) return {found: false, inList};
            const {type, inList: crossed} = unwrapToStructural(cur);
            inList = inList || crossed;
            if (!type) return {found: false, inList};
            if (type.Product) {
                const el = type.Product.elements.find((e) => e.name && "some" in e.name && e.name.some === seg);
                if (!el) return {found: false, inList};
                cur = el.algebraic_type;
            } else if (type.Sum && seg.endsWith("_")) {
                const vName = seg.slice(0, -1);
                const v = type.Sum.variants.find((x) => x.name && "some" in x.name && x.name.some === vName);
                if (!v) return {found: false, inList};
                cur = v.algebraic_type;
            } else {
                return {found: false, inList};
            }
        }
        const {inList: leafCrossed} = unwrapToStructural(cur ?? {});
        return {found: true, inList: inList || leafCrossed};
    }

    const schemaTableInfo = new Map<string, SchemaInfo>();
    for (const schemaTable of regionSchema.tables) {
        const typeDef = regionSchema.typespace.types[schemaTable.product_type_ref];
        const columns: string[] = [];
        const enumColumns: string[] = [];
        const enumVariants: Record<string, string[]> = {};
        collectProductFields(typeDef?.Product?.elements ?? [], "", columns, enumColumns, enumVariants);

        const isPublic = "Public" in schemaTable.table_access;
        const schemaPrimaryKey = schemaTable.primary_key.length === 1
            ? columns[schemaTable.primary_key[0]]
            : undefined;

        schemaTableInfo.set(schemaTable.name, {
            columns,
            isPublic,
            enumColumns,
            enumVariants,
            schemaPrimaryKey,
            productTypeRef: schemaTable.product_type_ref,
        });
    }

    return {
        schemaTableInfo,
        globalEnumRegistry,
        resolveEnumNameFromVariants,
        collectTaggedUnionFieldsByName,
        collectIdFieldsFromProductForFK,
        collectEnumFieldsFromProductForFK,
        resolveColumnPath,
    };
}

