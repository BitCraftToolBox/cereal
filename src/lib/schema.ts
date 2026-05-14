/**
 * Compact per-object entry inside a SearchIndex table group.
 * - Plain string/number → just the primary key (table has no display name or search fields)
 * - Object → pk + optional display name + optional search field pairs
 */
export type CompactSearchEntry =
    | string
    | number
    | { pk: string | number; n?: string; f?: [string, string][] };

/** Top-level structure of search_<tag>.json */
export interface SearchIndex {
    tag: string;
    entries: Record<string, CompactSearchEntry[]>;
}

/**
 * Foreign key mapping configuration.
 * Maps table fields to the tables they reference.
 */
export interface ForeignKeyMapping {
    sourceTable: string;
    sourceField: string;
    targetTable: string;
    targetField?: string;
    isList?: boolean;
    /**
     * When the source field stores an enum variant *name* (string) but the target PK is
     * the numeric enum index, set this to the enum name in DefManifest.enums so the
     * frontend can convert: variants.indexOf(stringValue) → numeric id.
     */
    enumConversion?: string;
    conditionalTargets?: {
        whenField: string;
        whenValue: string;
        targetTable: string | null;
    }[];
}

/**
 * A named enum extracted from the DB schema, shared across tables.
 */
export interface EnumDef {
    name: string;
    values: string[];
}

/**
 * Table metadata included in the version manifest.
 */
export interface TableMeta {
    name: string;
    primaryKey?: string;
    displayField?: string;
    searchFields: string[];
    rowCount: number;
    columns: string[];
    isPublic: boolean;
    enumColumns: string[];
    enumValues: Record<string, string>;
    spriteFields: string[];
}

/**
 * A single entry in public/versions.json - lightweight metadata about each version.
 */
export interface VersionEntry {
    tag: string;
    label?: string;
    description?: string;
}

/**
 * A pre-computed manifest of all tables and FK mappings for a specific data version.
 * Stored in public/data/<tag>/version_<tag>.json.
 */
export interface DefManifest extends VersionEntry {
    /** All named enums, deduplicated */
    enums: EnumDef[];
    /** Metadata for all tables */
    tables: TableMeta[];
    /** Foreign key mappings across all tables */
    foreignKeys: ForeignKeyMapping[];
}

/**
 * Resolve the actual target table for a FK, taking into account conditionalTargets.
 * enumValues here is the resolved variant array (not the name map).
 * @param fk The FK mapping
 * @param contextObj The object containing the source field (used to read sibling fields)
 * @param enumValues The enumValues map from TableMeta (to resolve numeric enum values to names)
 */
export function resolveTargetTable(
    fk: ForeignKeyMapping,
    contextObj: Record<string, unknown>,
    enumValues?: Record<string, string[]>,
): string | null {
    return resolveTargetTableWithCondition(fk, contextObj, enumValues).targetTable;
}

/**
 * Like resolveTargetTable but also returns the matched condition's whenField/whenValue,
 * so callers can build filter URLs.
 */
export function resolveTargetTableWithCondition(
    fk: ForeignKeyMapping,
    contextObj: Record<string, unknown>,
    enumValues?: Record<string, string[]>,
): { targetTable: string | null; conditionalFilter?: { field: string; value: string } } {
    if (!fk.conditionalTargets?.length) return { targetTable: fk.targetTable };
    for (const cond of fk.conditionalTargets) {
        const sourceParts = fk.sourceField.split(".");
        const whenParts = cond.whenField.split(".");
        let commonLen = 0;
        while (
            commonLen < sourceParts.length - 1 &&
            commonLen < whenParts.length - 1 &&
            sourceParts[commonLen] === whenParts[commonLen]
        ) commonLen++;
        const relPath = whenParts.slice(commonLen).join(".");
        const siblingValue = relPath ? getNestedValue(contextObj, relPath) : contextObj[cond.whenField];

        let resolvedName: string | undefined;
        if (typeof siblingValue === "number" && enumValues) {
            const variants = enumValues[cond.whenField] ?? enumValues[relPath] ?? enumValues[whenParts[whenParts.length - 1]];
            resolvedName = variants?.[siblingValue];
        } else if (typeof siblingValue === "string") {
            resolvedName = siblingValue;
        }
        if (resolvedName === cond.whenValue)
            return {
                targetTable: cond.targetTable,
                conditionalFilter: { field: cond.whenField, value: cond.whenValue },
            };
    }
    return { targetTable: fk.targetTable };
}

/**
 * Get a nested value by a dot-separated path, traversing into arrays by collecting all element values.
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) {
            const results = current
                .filter((el) => el && typeof el === "object")
                .map((el) => (el as Record<string, unknown>)[part])
                .filter((v) => v !== null && v !== undefined);
            current = results.length === 1 ? results[0] : results.length > 1 ? results : undefined;
        } else if (typeof current === "object") {
            current = (current as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }
    return current;
}

// ---------------------------------------------------------------------------
// SpacetimeDB schema types (shared with generate-defs.ts)
// ---------------------------------------------------------------------------

export interface AlgebraicType {
    Product?: { elements: ProductElement[] };
    Sum?: { variants: SumVariant[] };
    /** Array element type */
    Array?: AlgebraicType;
    Ref?: number;
    // Scalar primitives — value is always `[]` in JSON
    U8?: unknown;
    U16?: unknown;
    U32?: unknown;
    U64?: unknown;
    U128?: unknown;
    U256?: unknown;
    I8?: unknown;
    I16?: unknown;
    I32?: unknown;
    I64?: unknown;
    I128?: unknown;
    I256?: unknown;
    F32?: unknown;
    F64?: unknown;
    Bool?: unknown;
    String?: unknown;
    Bytes?: unknown;
}

export interface SumVariant {
    name: { some: string } | null;
    algebraic_type: AlgebraicType;
}

export interface ProductElement {
    name: { some: string } | null;
    algebraic_type: AlgebraicType;
}

export interface SchemaIndex {
    name?: { some?: string };
    accessor_name?: { some?: string };
    algorithm: {
        BTree?: number[];
        Hash?: number[];
        Direct?: number;
    };
}

export interface SchemaConstraint {
    name?: { some?: string };
    data: {
        Unique?: {
            columns: number[];
        };
    };
}

export interface SchemaTable {
    name: string;
    product_type_ref: number;
    primary_key: number[];
    indexes?: SchemaIndex[];
    constraints?: SchemaConstraint[];
    table_access: { Public?: unknown[] } | { Private?: unknown[] };
}

export interface NamedType {
    name: { scope: string[]; name: string };
    ty: number;
    custom_ordering?: boolean;
}

/** Full SpacetimeDB module schema (region_schema.json / latest-schema.json) */
export interface SpacetimeDBSchema {
    typespace: { types: AlgebraicType[] };
    tables: SchemaTable[];
    types: NamedType[];
}

/** Build a map from typespace index → canonical type name */
export function buildTypeIndexMap(schema: SpacetimeDBSchema): Map<number, string> {
    const m = new Map<number, string>();
    for (const nt of schema.types ?? []) m.set(nt.ty, nt.name.name);
    return m;
}

/**
 * Given a table name (snake_case) and a column name, return the raw AlgebraicType.
 * Returns undefined if the table or column isn't found in the schema.
 */
export function getColumnTypeElement(
    tableName: string,
    columnName: string,
    schema: SpacetimeDBSchema,
): AlgebraicType | undefined {
    const schemaTable = schema.tables?.find((t) => t.name === tableName);
    if (!schemaTable) return undefined;
    const typeDef = schema.typespace?.types?.[schemaTable.product_type_ref];
    return typeDef?.Product?.elements.find(
        (el) => el.name && "some" in el.name && el.name.some === columnName,
    )?.algebraic_type;
}
