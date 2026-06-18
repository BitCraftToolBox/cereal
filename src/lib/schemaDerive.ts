/**
 * schemaDerive.ts — shared, framework-agnostic derivation of structural table metadata
 * from a `SpacetimeDBSchema`.
 *
 * This is the single source of truth for column lists, enum registration/naming, and
 * primary-key/visibility derivation. **Both** the build script (`scripts/lib/schema-analysis.ts`)
 * and the frontend data layer (`src/lib/data.tsx`) import from here so build-time and runtime
 * derivation can never drift.
 *
 * The version manifest no longer carries `columns`, `enumColumns`, `enumValues`, `searchFields`,
 * or the top-level `enums` array — they are all reconstructed from the schema via `deriveSchema`.
 */

import type {AlgebraicType, ProductElement, SpacetimeDBSchema} from "./schema";
import {findRefIndexThroughOptionArray, hasArrayThroughOption, unwrapRefOptionArray,} from "./type-walkers";

export interface EnumRegistryEntry {
    name: string;
    values: string[];
}

/**
 * Split a table name's *trailing* migration suffix (`_v<N>`). The migration base is the full
 * table name minus that suffix (e.g. `deployable_state_v2` → base `deployable_state`, N=2); a
 * bare base counts as version 0. Only a trailing `_v\d+` is split — names whose own base
 * contains `_v` are unaffected.
 */
export function migrationBase(name: string): { base: string; version: number } {
    const m = name.match(/^(.*)_v(\d+)$/);
    if (m) return {base: m[1], version: parseInt(m[2], 10)};
    return {base: name, version: 0};
}

/** Resolution of migrated `_vN` tables for a single snapshot's set of table names. */
export interface MigrationInfo {
    /** migration base → current (highest-N present) table name. */
    currentByBase: Map<string, string>;
    /** Map any table name to the current version of its migration base. */
    resolveCurrent: (table: string) => string;
    /** True if `table` is an old (superseded) migration version (a newer one exists). */
    isSuperseded: (table: string) => boolean;
}

/**
 * Group a snapshot's table names by migration base and pick the current (highest-N) version of
 * each. In a world-wipe a chain can collapse back to the bare base, so "current" is always
 * whichever version is actually present at the highest N in *this* snapshot.
 */
export function buildMigrationInfo(tableNames: Iterable<string>): MigrationInfo {
    const best = new Map<string, { table: string; version: number }>();
    for (const name of tableNames) {
        const {base, version} = migrationBase(name);
        const existing = best.get(base);
        if (!existing || version > existing.version) best.set(base, {table: name, version});
    }
    const currentByBase = new Map<string, string>();
    for (const [base, {table}] of best) currentByBase.set(base, table);
    const resolveCurrent = (table: string): string =>
        currentByBase.get(migrationBase(table).base) ?? table;
    const isSuperseded = (table: string): boolean => resolveCurrent(table) !== table;
    return {currentByBase, resolveCurrent, isSuperseded};
}

/**
 * Low-level type primitives + a shared enum registry for a single schema. The build script
 * reuses these for FK detection; the frontend uses them via `deriveSchema`.
 */
export interface SchemaTypeContext {
    typeIndexToName: Map<number, string>;
    /** Resolve a typespace Ref index to its `AlgebraicType` (or undefined). */
    resolveRef: (idx: number) => AlgebraicType | undefined;
    isEnumType: (t: AlgebraicType) => boolean;
    /** Unwrap Ref/Option/Array down to a structural type. */
    unwrapType: (t: AlgebraicType) => AlgebraicType;
    getEnumVariants: (t: AlgebraicType) => string[];
    findCanonicalNameUnwrapped: (t: AlgebraicType) => string | undefined;
    hasArrayWrapper: (t: AlgebraicType) => boolean;
    findEnumRef: (t: AlgebraicType) => number | undefined;
    /** signature (variants joined) → { canonical name, values }. */
    globalEnumRegistry: Map<string, EnumRegistryEntry>;
    getOrRegisterEnum: (columnPath: string, variants: string[], originalType?: AlgebraicType) => string;
    resolveEnumNameFromVariants: (columnPath: string, variants: string[]) => string;
    /**
     * Walk a product's elements, pushing top-level column names into `columns`, and every
     * enum-typed (possibly nested) column path into `enumColumns` / `enumValues`.
     */
    collectProductFields: (
        elements: ProductElement[],
        prefix: string,
        columns: string[],
        enumColumns: string[],
        enumValues: Record<string, string[]>,
    ) => void;
}

export function createSchemaTypeContext(schema: SpacetimeDBSchema): SchemaTypeContext {
    const typeIndexToName = new Map<number, string>();
    for (const namedType of schema.types ?? []) {
        typeIndexToName.set(namedType.ty, namedType.name.name);
    }

    const resolveRef = (idx: number): AlgebraicType | undefined => schema.typespace.types[idx];

    function isEnumType(t: AlgebraicType): boolean {
        if (t.Ref !== undefined) {
            const ref = resolveRef(t.Ref);
            return ref ? isEnumType(ref) : false;
        }
        if (t.Sum) {
            return t.Sum.variants.every(
                (v) => v.algebraic_type.Product && v.algebraic_type.Product.elements.length === 0,
            );
        }
        return false;
    }

    function unwrapType(t: AlgebraicType): AlgebraicType {
        return unwrapRefOptionArray(t, resolveRef);
    }

    function getEnumVariants(t: AlgebraicType): string[] {
        if (t.Ref !== undefined) {
            const ref = resolveRef(t.Ref);
            return ref ? getEnumVariants(ref) : [];
        }
        if (t.Sum) {
            return t.Sum.variants
                .map((v) => (v.name && "some" in v.name ? v.name.some : null))
                .filter((n): n is string => n !== null);
        }
        return [];
    }

    function findCanonicalNameUnwrapped(t: AlgebraicType): string | undefined {
        const refIdx = findRefIndexThroughOptionArray(t);
        return refIdx !== undefined ? typeIndexToName.get(refIdx) : undefined;
    }

    function hasArrayWrapper(t: AlgebraicType): boolean {
        return hasArrayThroughOption(t);
    }

    function findEnumRef(t: AlgebraicType): number | undefined {
        return findRefIndexThroughOptionArray(t);
    }

    const globalEnumRegistry = new Map<string, EnumRegistryEntry>();

    function getOrRegisterEnum(columnPath: string, variants: string[], originalType?: AlgebraicType): string {
        const sig = variants.join("|");
        const refIdx = originalType !== undefined ? findEnumRef(originalType) : undefined;
        const canonicalName = refIdx !== undefined ? typeIndexToName.get(refIdx) : undefined;

        if (!globalEnumRegistry.has(sig)) {
            if (!canonicalName) {
                // NB this should never happen with the sorts of schema we see in BitCraft. If it does,
                // grab deriveEnumName back from source control to assign names dynamically.
                throw new Error(`[enum] No canonical name for enum on column "${columnPath}" with variants [${variants.join(", ")}]`);
            }
            globalEnumRegistry.set(sig, {name: canonicalName, values: variants});
        } else if (canonicalName) {
            const existing = globalEnumRegistry.get(sig)!;
            if (existing.name !== canonicalName) existing.name = canonicalName;
        }

        return globalEnumRegistry.get(sig)!.name;
    }

    function resolveEnumNameFromVariants(columnPath: string, variants: string[]): string {
        const sig = variants.join("|");
        const registered = globalEnumRegistry.get(sig);
        return registered?.name ?? getOrRegisterEnum(columnPath, variants);
    }

    function collectProductFields(
        elements: ProductElement[],
        prefix: string,
        columns: string[],
        enumColumns: string[],
        enumValues: Record<string, string[]>,
    ): void {
        for (const el of elements) {
            const colName = el.name && "some" in el.name ? el.name.some : null;
            if (!colName) continue;
            const fullPath = prefix ? `${prefix}.${colName}` : colName;
            if (!prefix) columns.push(colName);

            if (isEnumType(el.algebraic_type)) {
                enumColumns.push(fullPath);
                enumValues[fullPath] = getEnumVariants(el.algebraic_type);
                getOrRegisterEnum(fullPath, enumValues[fullPath], el.algebraic_type);
            } else {
                const resolved = unwrapType(el.algebraic_type);
                if (isEnumType(resolved)) {
                    enumColumns.push(fullPath);
                    enumValues[fullPath] = getEnumVariants(resolved);
                    getOrRegisterEnum(fullPath, enumValues[fullPath], el.algebraic_type);
                } else if (resolved.Product) {
                    collectProductFields(resolved.Product.elements, fullPath, columns, enumColumns, enumValues);
                } else if (resolved.Sum) {
                    for (const variant of resolved.Sum.variants) {
                        const variantName = variant.name && "some" in variant.name ? variant.name.some : null;
                        if (!variantName) continue;
                        const variantPath = `${fullPath}.${variantName}_`;
                        const variantResolved = unwrapType(variant.algebraic_type);
                        if (variantResolved.Product && variantResolved.Product.elements.length > 0) {
                            collectProductFields(variantResolved.Product.elements, variantPath, columns, enumColumns, enumValues);
                        }
                    }
                }
            }
        }
    }

    return {
        typeIndexToName,
        resolveRef,
        isEnumType,
        unwrapType,
        getEnumVariants,
        findCanonicalNameUnwrapped,
        hasArrayWrapper,
        findEnumRef,
        globalEnumRegistry,
        getOrRegisterEnum,
        resolveEnumNameFromVariants,
        collectProductFields,
    };
}

/** Structural metadata for one table, reconstructed from the schema. */
export interface DerivedTableStructure {
    /** Top-level column names, in declaration order. */
    columns: string[];
    /** Single-column primary key name (undefined for composite / keyless). */
    primaryKey?: string;
    isPublic: boolean;
    /** Enum-typed column path → canonical enum name. */
    enumColumnNames: Record<string, string>;
    /** Every enum-typed column path (top-level + nested). */
    enumColumns: string[];
    /** Enum-typed column path → its variant list. */
    enumVariants: Record<string, string[]>;
    productTypeRef: number;
}

export interface DerivedSchema {
    /** table name → structural metadata. */
    tables: Map<string, DerivedTableStructure>;
    /** canonical enum name → variant values. */
    enums: Map<string, string[]>;
    /** Migrated `_vN` resolution for this snapshot's tables. */
    migration: MigrationInfo;
    /** The underlying type context (shared enum registry, type walkers). */
    ctx: SchemaTypeContext;
}

/**
 * Build the per-table structure map (using an existing type context so the enum registry is
 * shared with whatever else derived from that context).
 */
export function deriveTablesFromCtx(
    schema: SpacetimeDBSchema,
    ctx: SchemaTypeContext,
): Map<string, DerivedTableStructure> {
    const tables = new Map<string, DerivedTableStructure>();
    for (const schemaTable of schema.tables) {
        const typeDef = schema.typespace.types[schemaTable.product_type_ref];
        const columns: string[] = [];
        const enumColumns: string[] = [];
        const enumVariants: Record<string, string[]> = {};
        ctx.collectProductFields(typeDef?.Product?.elements ?? [], "", columns, enumColumns, enumVariants);

        const isPublic = "Public" in schemaTable.table_access;
        const primaryKey = schemaTable.primary_key.length === 1
            ? columns[schemaTable.primary_key[0]]
            : undefined;

        const enumColumnNames: Record<string, string> = {};
        for (const [col, variants] of Object.entries(enumVariants)) {
            enumColumnNames[col] = ctx.resolveEnumNameFromVariants(col, variants);
        }

        tables.set(schemaTable.name, {
            columns,
            primaryKey,
            isPublic,
            enumColumnNames,
            enumColumns,
            enumVariants,
            productTypeRef: schemaTable.product_type_ref,
        });
    }
    return tables;
}

/**
 * Derive all structural metadata (columns, enums, primary keys, visibility) from a schema.
 * The result's enum registry is fully populated, so `enums` covers every enum referenced by
 * any table column.
 */
export function deriveSchema(schema: SpacetimeDBSchema): DerivedSchema {
    const ctx = createSchemaTypeContext(schema);
    const tables = deriveTablesFromCtx(schema, ctx);
    const enums = new Map<string, string[]>(
        [...ctx.globalEnumRegistry.values()].map((e) => [e.name, e.values] as const),
    );
    const migration = buildMigrationInfo(tables.keys());
    return {tables, enums, migration, ctx};
}


