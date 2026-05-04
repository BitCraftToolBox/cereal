/**
 * generate-defs.ts
 *
 * Standalone tool that reads <versionDir>/static/*.json and <versionDir>/region_schema.json,
 * computes table metadata and foreign-key mappings, and writes the results
 * to <versionDir>/version_<tag>.json.
 *
 * Usage:
 *   npm run gen-defs -- <versionDir>
 *   e.g. npm run gen-defs -- public/data/2026-04-30
 */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import type {
    AlgebraicType,
    DefManifest,
    EnumDef,
    ForeignKeyMapping,
    ProductElement,
    SearchIndex,
    SpacetimeDBSchema,
    TableMeta,
    VersionEntry,
} from "../src/lib/schema";
import {getNestedValue} from "../src/lib/schema";

// Accept a version folder path as the first argument
const versionArg = process.argv[2];
if (!versionArg) {
    console.error("Usage: tsx scripts/generate-defs.ts <versionDir>");
    console.error("  e.g. tsx scripts/generate-defs.ts public/data/2026-04-30");
    process.exit(1);
}
const VERSION_DIR = path.resolve(process.cwd(), versionArg);
const VERSION_TAG = path.basename(VERSION_DIR);
const DATA_DIR = path.join(VERSION_DIR, "static");
const SCHEMA_FILE = path.join(VERSION_DIR, "region_schema.json");

if (!fs.existsSync(VERSION_DIR)) {
    console.error(`Version directory not found: ${VERSION_DIR}`);
    process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANNOTATIONS = path.resolve(__dirname, "version_annotations.json");

// ---------------------------------------------------------------------------
// 1. Parse region_schema.json
// ---------------------------------------------------------------------------
console.log(`Loading DB schema from ${SCHEMA_FILE}...`);
const regionSchema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf-8")) as SpacetimeDBSchema;

// Build reverse map: typespace index → canonical type name (from top-level types array)
const typeIndexToName = new Map<number, string>();
for (const namedType of regionSchema.types ?? []) {
    typeIndexToName.set(namedType.ty, namedType.name.name);
}

function isEnumType(t: AlgebraicType): boolean {
    if (t.Ref !== undefined) {
        const ref = regionSchema.typespace.types[t.Ref];
        return ref ? isEnumType(ref) : false;
    }
    if (t.Sum) {
        return t.Sum.variants.every(
            (v) => v.algebraic_type.Product && v.algebraic_type.Product.elements.length === 0
        );
    }
    return false;
}

function unwrapType(t: AlgebraicType): AlgebraicType {
    if (t.Ref !== undefined) return unwrapType(regionSchema.typespace.types[t.Ref] ?? t);
    if (t.Array) return unwrapType(t.Array);
    if (t.Sum && t.Sum.variants.length === 2) {
        const names = t.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : ""));
        if (names.includes("some") && names.includes("none")) {
            const some = t.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!;
            return unwrapType(some.algebraic_type);
        }
    }
    return t;
}

/** Recursively collect top-level column names, full dot-path enum column names, and their variant labels. */
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
            // Pass original type so canonical name can be looked up via Ref index
            getOrRegisterEnum(fullPath, enumValues[fullPath], el.algebraic_type);
        } else {
            const resolved = unwrapType(el.algebraic_type);
            // Handle Array<Enum> / Option<Enum> — the outer type isn't an enum but the inner is
            if (isEnumType(resolved)) {
                enumColumns.push(fullPath);
                enumValues[fullPath] = getEnumVariants(resolved);
                getOrRegisterEnum(fullPath, enumValues[fullPath], el.algebraic_type);
            } else if (resolved.Product) {
                collectProductFields(resolved.Product.elements, fullPath, columns, enumColumns, enumValues);
            } else if (resolved.Sum) {
                // Non-option, non-enum Sum (tagged union / ADT): recurse into each variant's product
                for (const variant of resolved.Sum.variants) {
                    const variantName = variant.name && "some" in variant.name ? variant.name.some : null;
                    if (!variantName) continue;
                    // SpacetimeDB serializes variant names with a trailing _ to avoid collisions
                    const variantPath = `${fullPath}.${variantName}_`;
                    const variantResolved = unwrapType(variant.algebraic_type);
                    if (variantResolved.Product && variantResolved.Product.elements.length > 0) {
                        collectProductFields(variantResolved.Product.elements, variantPath, columns, enumColumns, enumValues);
                    }
                    // Scalar variants (Product with 0 elements or raw scalar) have no inner fields to collect
                }
            }
        }
    }
}

/**
 * Return the canonical schema type name for a type, unwrapping Option/Array wrappers.
 * Returns undefined if the innermost named type is not reachable or has no name.
 */
function findCanonicalNameUnwrapped(t: AlgebraicType): string | undefined {
    if (t.Ref !== undefined) return typeIndexToName.get(t.Ref);
    if (t.Array) return findCanonicalNameUnwrapped(t.Array);
    if (t.Sum && t.Sum.variants.length === 2) {
        const names = t.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : ""));
        if (names.includes("some") && names.includes("none")) {
            const some = t.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!;
            return findCanonicalNameUnwrapped(some.algebraic_type);
        }
    }
    return undefined;
}

/** Returns true if the type has an Array wrapper before reaching the named type (through Options). */
function hasArrayWrapper(t: AlgebraicType): boolean {
    if (t.Array) return true;
    if (t.Sum && t.Sum.variants.length === 2) {
        const names = t.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : ""));
        if (names.includes("some") && names.includes("none")) {
            const some = t.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!;
            return hasArrayWrapper(some.algebraic_type);
        }
    }
    return false;
}

/**
 * Walk a product's elements and return every field whose canonical unwrapped type name
 * is a key in TAGGED_UNION_OVERRIDES. Recurses into nested products.
 */
function collectTaggedUnionFieldsByName(
    elements: ProductElement[],
    prefix: string,
    inList: boolean,
    overrideKeys: Set<string>,
): Array<{ path: string; typeName: string; inList: boolean }> {
    const result: Array<{ path: string; typeName: string; inList: boolean }> = [];
    for (const el of elements) {
        const name = el.name && "some" in el.name ? el.name.some : null;
        if (!name) continue;
        const fullPath = prefix ? `${prefix}.${name}` : name;
        const canonicalName = findCanonicalNameUnwrapped(el.algebraic_type);
        const isArr = hasArrayWrapper(el.algebraic_type);
        if (canonicalName && overrideKeys.has(canonicalName)) {
            result.push({path: fullPath, typeName: canonicalName, inList: inList || isArr});
        }
        // Recurse into nested products (but not into the tagged union itself — variants are handled externally)
        const unwrapped = unwrapType(el.algebraic_type);
        if (unwrapped.Product) {
            result.push(...collectTaggedUnionFieldsByName(
                unwrapped.Product.elements, fullPath, inList || isArr, overrideKeys,
            ));
        }
    }
    return result;
}

/** Extract variant names from an enum (Sum) type. */
function getEnumVariants(t: AlgebraicType): string[] {
    if (t.Ref !== undefined) {
        const ref = regionSchema.typespace.types[t.Ref];
        return ref ? getEnumVariants(ref) : [];
    }
    if (t.Sum) {
        return t.Sum.variants
            .map((v) => (v.name && "some" in v.name ? v.name.some : null))
            .filter((n): n is string => n !== null);
    }
    return [];
}

interface SchemaInfo {
    columns: string[];
    isPublic: boolean;
    enumColumns: string[];
    /** Internal: column path -> variant string[] (used to build the global enum registry) */
    enumVariants: Record<string, string[]>;
    schemaPrimaryKey?: string;
    /** Index into regionSchema.typespace.types for this table's product type */
    productTypeRef: number;
}

// Global enum registry: signature (sorted variants joined) -> { name, values }
// Name is assigned from the canonical schema type name when available.
const globalEnumRegistry = new Map<string, { name: string; values: string[] }>();

/** Find the first Ref index while unwrapping optionals/arrays (for canonical name lookup). */
function findEnumRef(t: AlgebraicType): number | undefined {
    if (t.Ref !== undefined) return t.Ref;
    if (t.Array) return findEnumRef(t.Array);
    if (t.Sum && t.Sum.variants.length === 2) {
        const names = t.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : ""));
        if (names.includes("some") && names.includes("none")) {
            const some = t.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!;
            return findEnumRef(some.algebraic_type);
        }
    }
    return undefined;
}

const GENERIC_LEAVES = new Set(["id", "type", "name", "value", "flag", "kind", "mode", "state", "status"]);

function deriveEnumName(columnPath: string): { name: string; isGeneric: boolean } {
    const parts = columnPath.split(".");
    const leaf = parts[parts.length - 1];
    const stripped = leaf.replace(/_(id|type)$/, "");
    const isGeneric = GENERIC_LEAVES.has(stripped);
    const baseParts = isGeneric && parts.length > 1
        ? [parts[parts.length - 2].replace(/s$/, "")]
        : stripped.split("_");
    const name = baseParts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
    return {name, isGeneric};
}

function getOrRegisterEnum(columnPath: string, variants: string[], originalType?: AlgebraicType): string {
    const sig = variants.join("|");

    // Prefer canonical name from the schema's named types
    const refIdx = originalType !== undefined ? findEnumRef(originalType) : undefined;
    const canonicalName = refIdx !== undefined ? typeIndexToName.get(refIdx) : undefined;

    if (!globalEnumRegistry.has(sig)) {
        let finalName: string;
        const existingNames = new Set([...globalEnumRegistry.values()].map((e) => e.name));
        if (canonicalName) {
            finalName = canonicalName;
        } else {
            console.log('  [enum] No canonical name for enum on column "%s" with variants [%s]', columnPath, variants.join(", "));
            const {name: candidateName} = deriveEnumName(columnPath);
            finalName = candidateName;
            let suffix = 2;
            while (existingNames.has(finalName)) finalName = `${candidateName}${suffix++}`;
        }
        globalEnumRegistry.set(sig, {name: finalName, values: variants});
    } else if (canonicalName) {
        // Upgrade to canonical name if we now have one
        const existing = globalEnumRegistry.get(sig)!;
        if (existing.name !== canonicalName) {
            existing.name = canonicalName;
        }
    }
    return globalEnumRegistry.get(sig)!.name;
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
        productTypeRef: schemaTable.product_type_ref
    });
}

{
    const pub = [...schemaTableInfo.values()].filter((t) => t.isPublic).length;
    console.log(`  Found ${schemaTableInfo.size} tables in schema (${pub} public, ${schemaTableInfo.size - pub} private)`);
}

// ---------------------------------------------------------------------------
// 2. Table metadata helpers
// ---------------------------------------------------------------------------

const NAME_OVERRIDES: Record<string, string | null> = {
    "traveler_task_desc": null // description field is super long and cumbersome
}

function detectDisplayField(table: string, columns: string[]): string | undefined {
    // always check overrides first
    if (table in NAME_OVERRIDES) {
        return NAME_OVERRIDES[table] ?? undefined;
    }
    // Prefer "name" exactly, then shortest column ending with "name" that isn't an asset reference
    const exactName = columns.find((c) => c === "name");
    if (exactName) return exactName;
    const nameSuffix = columns
        .filter((c) => c.endsWith("name") && !/asset_names?$/.test(c))
        .sort((a, b) => a.length - b.length)[0];
    if (nameSuffix) return nameSuffix;
    // Fall back to exact "title"
    const title = columns.find((c) => c === "title");
    if (title) return title;
    // Fall back to a description column
    return columns.find((c) => c === "description");
}

function detectSearchFields(rows: Record<string, unknown>[]): string[] {
    if (rows.length === 0) return [];
    const keys = Object.keys(rows[0]);

    // Regex for 32-char hex strings (Unity asset GUIDs)
    const HEX_ASSET = /^[0-9a-f]{32}$/i;
    // Regex for a single character or a unicode escape like \u0000
    const SINGLE_CHAR = /^(.|\\u[0-9a-fA-F]{4})$/;

    return keys.filter((k) => {
        // Must contain "name", "description", "desc", or "tag" (case-insensitive)
        const lk = k.toLowerCase();
        if (
            !lk.includes("name") &&
            !lk.includes("description") &&
            !lk.includes("desc") &&
            !lk.includes("tag") &&
            !lk.includes("text")
        ) return false;

        // Exclude asset_name / asset_names columns
        if (/asset_names?$/.test(k)) return false;

        // Sample a few non-empty string values to check content
        const samples: string[] = [];
        for (const row of rows.slice(0, Math.min(20, rows.length))) {
            const v = row[k];
            if (typeof v === "string" && v.length > 0) {
                samples.push(v);
                if (samples.length >= 5) break;
            }
        }

        // If we found no string values, not a search field
        if (samples.length === 0) return false;

        // If all samples are single chars or unicode escapes, skip (font icon fields)
        if (samples.every((v) => SINGLE_CHAR.test(v))) return false;

        // If all samples are 32-char hex strings, skip (Unity asset IDs)
        if (samples.every((v) => HEX_ASSET.test(v))) return false;

        return true;
    });
}

// Matches (image|icon)(_asset)?_(name|address) — but not single char / unicode escapes
const SPRITE_FIELD_RE = /^(image|icon)(_asset)?_(name|address)s?$/;
const SINGLE_CHAR = /^(.|\\u[0-9a-fA-F]{4})$/;

function detectSpriteFields(rows: Record<string, unknown>[]): string[] {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).filter((k) => {
        if (!SPRITE_FIELD_RE.test(k)) return false;
        // Verify at least one sample value is a non-trivial string
        for (const row of rows) {
            const v = row[k];
            if (typeof v === "string" && v.length > 1 && !SINGLE_CHAR.test(v)) return true;
        }
        return false;
    });
}

function buildTableMeta(
    tableName: string,
    rows: Record<string, unknown>[],
    info: SchemaInfo | undefined,
): TableMeta {
    const columns = info?.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
    const enumValues: Record<string, string> = {};
    if (info?.enumVariants) {
        for (const [colPath, variants] of Object.entries(info.enumVariants)) {
            // Enum was already registered in collectProductFields with canonical name — just look it up
            const sig = variants.join("|");
            const registered = globalEnumRegistry.get(sig);
            enumValues[colPath] = registered?.name ?? getOrRegisterEnum(colPath, variants);
        }
    }
    return {
        name: tableName,
        primaryKey: info?.schemaPrimaryKey,
        displayField: detectDisplayField(tableName, columns),
        searchFields: detectSearchFields(rows),
        rowCount: rows.length,
        columns,
        isPublic: info?.isPublic ?? true,
        enumColumns: info?.enumColumns ?? [],
        enumValues,
        spriteFields: detectSpriteFields(rows),
    };
}

// ---------------------------------------------------------------------------
// 3. FK detection helpers
// ---------------------------------------------------------------------------

/** Collect ID-like fields (ending _id or _type), recursing into objects and arrays of objects. */
function collectIdFields(
    obj: Record<string, unknown>,
    prefix = "",
    inList = false,
    allRows?: Record<string, unknown>[],
): Array<{ path: string; inList: boolean }> {
    const fields: Array<{ path: string; inList: boolean }> = [];
    for (const [key, value] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if (key.endsWith("_id") || key.endsWith("_type")) {
            if (typeof value === "number" || typeof value === "string") {
                fields.push({path: p, inList});
            }
        }
        // Tagged scalar sum variant: key ends with _ and value is a scalar (e.g. { QuestChain_: 123 })
        if (key.endsWith("_") && (typeof value === "number" || typeof value === "string")) {
            fields.push({path: p, inList});
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            fields.push(...collectIdFields(value as Record<string, unknown>, p, inList));
        }
        if (Array.isArray(value)) {
            // Collect one sample per distinct object shape (key-set signature) so all
            // union variants are explored (e.g. Experience_ vs ItemStack_ in rewards).
            const sampledShapes = new Map<string, Record<string, unknown>>();

            const recordSample = (item: unknown) => {
                if (item && typeof item === "object" && !Array.isArray(item)) {
                    const sig = Object.keys(item as object).sort().join(",");
                    if (!sampledShapes.has(sig)) sampledShapes.set(sig, item as Record<string, unknown>);
                }
            };

            for (const item of value) recordSample(item);

            if (allRows) {
                for (const row of allRows) {
                    const arr = getNestedValue(row, p);
                    if (Array.isArray(arr)) {
                        for (const item of arr) recordSample(item);
                    }
                }
            }

            for (const sample of sampledShapes.values()) {
                fields.push(...collectIdFields(sample, p, true));
            }
        }
    }
    return fields;
}

/** Collect top-level fields that are arrays of scalars (potential list-FKs). */
function collectListFields(obj: Record<string, unknown>, prefix = ""): string[] {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if (Array.isArray(value) && value.length > 0 && typeof value[0] !== "object") {
            fields.push(p);
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            fields.push(...collectListFields(value as Record<string, unknown>, p));
        }
    }
    return fields;
}

function singularize(word: string): string {
    if (word.endsWith("ies")) return word.slice(0, -3) + "y";
    if (word.endsWith("es")) return word.slice(0, -2);
    if (word.endsWith("s")) return word.slice(0, -1);
    return word;
}

/**
 * Walk an AlgebraicType from the schema and collect every field path that could
 * be a FK (ends with _id, _type, or is a tagged scalar variant ending with _).
 * This supplements the data-sampled collectIdFields so that enum variants that
 * don't appear in the current dump are still considered.
 */
function collectIdFieldsFromType(
    t: AlgebraicType,
    prefix: string,
    inList: boolean,
): Array<{ path: string; inList: boolean }> {
    const result: Array<{ path: string; inList: boolean }> = [];

    // Resolve named ref
    if (t.Ref !== undefined) {
        const resolved = regionSchema.typespace.types[t.Ref];
        if (resolved) result.push(...collectIdFieldsFromType(resolved, prefix, inList));
        return result;
    }

    // Array → recurse with inList=true
    if (t.Array) {
        result.push(...collectIdFieldsFromType(t.Array, prefix, true));
        return result;
    }

    // Option (Some/None with 2 variants) → unwrap Some branch
    if (t.Sum && t.Sum.variants.length === 2) {
        const names = t.Sum.variants.map((v) => (v.name && "some" in v.name ? v.name.some : ""));
        if (names.includes("some") && names.includes("none")) {
            const some = t.Sum.variants.find((v) => v.name && "some" in v.name && v.name.some === "some")!;
            result.push(...collectIdFieldsFromType(some.algebraic_type, prefix, inList));
            return result;
        }
    }

    // Enum (all-unit Sum) → skip, not a FK holder
    if (isEnumType(t)) return result;

    // Tagged union (non-option, non-enum Sum) → recurse into every variant
    if (t.Sum) {
        for (const variant of t.Sum.variants) {
            const vName = variant.name && "some" in variant.name ? variant.name.some : null;
            if (!vName) continue;
            const vPath = prefix ? `${prefix}.${vName}_` : `${vName}_`;
            const inner = variant.algebraic_type;
            const innerUnwrapped = unwrapType(inner);
            if (innerUnwrapped.Product && innerUnwrapped.Product.elements.length === 0) {
                // Unit variant (no payload) — skip
                continue;
            }
            if (innerUnwrapped.Product) {
                result.push(...collectIdFieldsFromProductForFK(innerUnwrapped.Product.elements, vPath, inList));
            } else {
                // Scalar variant (tagged scalar like { QuestChain_: 123 }) — the path itself is the FK
                result.push({path: vPath, inList});
            }
        }
        return result;
    }

    // Product → recurse into elements
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
        // Skip pure direct-enum fields — they are enum-backed PKs, not FK targets
        // (Array<Enum> fields like required_biomes are NOT skipped here; their path is handled by ENUM_FK_OVERRIDES)
        if (isEnumType(el.algebraic_type)) continue;
        if (name.endsWith("_id") || name.endsWith("_type")) {
            result.push({path: fullPath, inList});
        }
        // Always recurse to find nested _id/_type fields inside objects/unions
        result.push(...collectIdFieldsFromType(el.algebraic_type, fullPath, inList));
    }
    return result;
}

function detectForeignKeys(
    tables: Record<string, { meta: TableMeta; rows: Record<string, unknown>[] }>
): ForeignKeyMapping[] {
    const mappings: ForeignKeyMapping[] = [];

    // PK value sets per table (for value-based fallback)
    const pkSets = new Map<string, Set<unknown>>();
    for (const [name, {meta, rows}] of Object.entries(tables)) {
        if (!meta.primaryKey) continue;
        const s = new Set<unknown>();
        for (const row of rows) s.add(row[meta.primaryKey]);
        pkSets.set(name, s);
    }

    // base-name → table-name map (e.g. "item" → "item_desc")
    const baseToTable = new Map<string, string>();
    for (const tName of Object.keys(tables)) {
        const base = tName.replace(/_desc(_v\d+)?$/, "");
        if (!baseToTable.has(base) || !tName.match(/_v\d+$/)) baseToTable.set(base, tName);
    }

    /** Find a table by field leaf name via contiguous sub-sequence search. */
    function findTableByFieldName(fieldLeaf: string): string | undefined {
        const isId = fieldLeaf.endsWith("_id");
        const isType = fieldLeaf.endsWith("_type");
        if (!isId && !isType) return undefined;
        const base = isId ? fieldLeaf.slice(0, -3) : fieldLeaf;
        const parts = base.split("_");
        for (let start = 0; start < parts.length; start++) {
            for (let end = parts.length; end > start; end--) {
                const candidate = parts.slice(start, end).join("_");
                if (baseToTable.has(candidate)) return baseToTable.get(candidate)!;
            }
        }
        return undefined;
    }

    // Hard-coded overrides — applied before name-based and value-based matching.
    // Key: "field" (any table) or "table.field" (specific). Value: target table or null to skip.
    const OVERRIDES: Record<string, string | null> = {
        "recipe_performance_id": null,
        "player_animation_id": null,
        "ability_unlock_desc.ability_type_enum_id": null,
        "knowledge_scroll_desc.scroll_type": "knowledge_scroll_type_desc",
        "quest_drop_desc.extraction_id": "extraction_recipe_desc",
        "convert_to_on_durability_zero": "item_desc",
        "enemy_ai_desc_id": "enemy_ai_params_desc",
        "enemy_ai_params_desc_id": "enemy_ai_params_desc",
        "consumed_building": "building_desc",
        "building_function_type_mapping_desc.type_id": "building_type_desc",
        "interior_instance_desc.intertior_environment_id": "interior_environment_desc",
        "interior_instance_desc.biome": "biome_desc",
        "interior_spawn_desc.traveler_ruin_entity_id": "enemy_ai_params_desc",
        "interior_spawn_desc.paving_id": "paving_tile_desc",
        "equipment_preset_knowledge_desc.knowledge_id": "secondary_knowledge_desc",
        "empire_rank_requirement": "empire_rank_desc",
        "on_destroy_yield_resource_id": "resource_desc",
        "consumed_resource": "resource_desc",
        "combat_action_multi_hit_desc.id": "combat_action_desc",
    };

    /**
     * Tagged-union overrides — keyed by the canonical SpacetimeDB type name of a Sum type.
     * When a field's unwrapped type matches a key here, each variant listed maps to a target table.
     * Use null to explicitly skip a variant.
     * Applies to every table that has a field of that type (including Option<T> and T[]).
     */
    const TAGGED_UNION_OVERRIDES: Record<string, Record<string, string | null>> = {
        "AbilityType": {
            "_Unsupported": null,
            "Eat": "item_desc",
            "CombatAction": "combat_action_desc",
            "AutoAttack": null,
            "Custom": "ability_custom_desc",
            "Prospecting": "prospecting_desc",
            "Equip": "item_desc",
            "DeployableDeploy": "collectible_desc",
            "AddToToolbelt": "item_desc",
            "DeployableToggle": "collectible_desc",
            "Emote": "collectible_desc",
            "EquipPreset": null, // index, not FK
        },
        "CompletionCondition": {
            "PaddingNone": null,
            "ItemStack": null, // nested item_id / item_type handled by Pass 1
            "Achievement": "achievement_desc",
            "Collectible": "collectible_desc",
            "Level": null, // nested skill_id handled by Pass 1
            "SecondaryKnowledge": "secondary_knowledge_desc",
            "EquippedItem": "item_desc",
        },
        "QuestRequirement": {
            "PaddingNone": null,
            "QuestChain": "quest_chain_desc",
            "Achievement": "achievement_desc",
            "Collectible": "collectible_desc",
            "Level": null, // nested skill_id handled by Pass 1
            "ItemStack": null, // nested item_id / item_type handled by Pass 1
            "SecondaryKnowledge": "secondary_knowledge_desc",
        },
        "QuestReward": {
            "PaddingNone": null,
            "ItemStack": null, // nested item_id / item_type handled by Pass 1
            "Achievement": "achievement_desc",
            "Collectible": "collectible_desc",
            "Experience": null, // nested skill_id handled by Pass 1
            "SecondaryKnowledge": "secondary_knowledge_desc",
        },
    };
    // numeric enum index. Matched by the enum name on the column (from globalEnumRegistry),
    // so they apply to every table that has that enum column — not just one specific table.
    const ENUM_FK_OVERRIDES: Array<{
        /** Match columns whose enum name equals this */
        enumName: string;
        /** The column path suffix to match (e.g. "stats.id" or "enemy_type") */
        sourceField: string;
        targetTable: string;
        targetField: string;
        isList?: boolean;
    }> = [
        {
            enumName: "CharacterStatType",
            sourceField: "stats.id",
            targetTable: "character_stat_desc",
            targetField: "stat_type",
            isList: true
        },
        {
            enumName: "CharacterStatType",
            sourceField: "stat_effects.id",
            targetTable: "character_stat_desc",
            targetField: "stat_type",
            isList: true
        },
        {enumName: "EnemyType", sourceField: "enemy_type", targetTable: "enemy_desc", targetField: "enemy_type"},
        {enumName: "NpcType", sourceField: "traveler_type", targetTable: "npc_desc", targetField: "npc_type"},
        {
            enumName: "Biome",
            sourceField: "required_biomes",
            targetTable: "biome_desc",
            targetField: "biome_type",
            isList: true
        },
    ];

    // Manual overrides for scalar-list FK fields.
    const LIST_OVERRIDES: Record<string, string | null> = {
        "required_knowledges": "secondary_knowledge_desc",
        "blocking_knowledges": "secondary_knowledge_desc",
        "discovery_triggers": "secondary_knowledge_desc",
        "required_knowledges_to_use": "secondary_knowledge_desc",
        "required_knowledges_to_convert": "secondary_knowledge_desc",
        "required_items_to_start": "item_desc",
        "required_items_to_interact_with_reward": "item_desc",
        "quest_chain_desc.stages": "quest_stage_desc",
        "building_function_type_mapping_desc.desc_ids": "building_desc",
        "interior_network_desc.child_interior_instances": "interior_instance_desc",
        "achievement_desc.requisites": "achievement_desc",
        "achievement_desc.resource_disc": "resource_desc",
        "achievement_desc.crafting_disc": "crafting_recipe_desc",
        "achievement_desc.cargo_disc": "cargo_desc",
        "achievement_desc.item_disc": "item_desc", // actually auto-matched since it has values but oh well
        "achievement_desc.collectible_rewards": "collectible_desc",
        "cargo_desc.on_destroy_yield_cargos": "cargo_desc", // unused by game since cargo is no longer extractable
        "claim_tech_desc.requirements": "claim_tech_desc",
        "claim_tech_desc.unlocks_techs": "claim_tech_desc",
        "required_claim_tech_ids": "claim_tech_desc",
        "required_achievements": "achievement_desc",
        "interior_spawn_desc.loot_chests": "loot_chest_desc",
        "loot_chest_desc.loot_tables": "loot_table_desc",
        "resource_desc.enemy_params_id": "enemy_ai_params_desc",
        "achievement_requirements": "achievement_desc",
    };

    /**
     * Conditional FK rules: when a sibling field has a specific enum value,
     * the FK target should be overridden. Each rule matches FKs by their leaf field name
     * and adds conditionalTargets based on a sibling field.
     *
     * siblingLeaf: leaf field name of the sibling (relative to the same object as the FK leaf)
     * enumName:    variant name => targetTable
     * The existing mapping's targetTable becomes the fallback (for unmatched variants).
     */
    const CONDITIONAL_FK_RULES: {
        fkLeaf: string;
        siblingLeaf: string;
        conditions: { whenValue: string; targetTable: string | null }[];
    }[] = [
        {
            // item_stack.item_id: points to item_desc or cargo_desc depending on item_type
            fkLeaf: "item_id",
            siblingLeaf: "item_type",
            conditions: [
                {whenValue: "Item", targetTable: "item_desc"},
                {whenValue: "Cargo", targetTable: "cargo_desc"},
            ],
        },
        {
            fkLeaf: "description_id",
            siblingLeaf: "entity_type",
            conditions: [
                {whenValue: "Building", targetTable: "building_desc"},
                {whenValue: "Enemy", targetTable: "enemy_desc"},
                {whenValue: "Npc", targetTable: "npc_desc"},
                {whenValue: "Resource", targetTable: "resource_desc"},
                {whenValue: "Player", targetTable: "player_state"},
                {whenValue: "None", targetTable: null}
            ]
        }
    ];

    // ---------------------------------------------------------------------------
    // Pass 0: tagged-union overrides — find fields by canonical SpacetimeDB type name
    // and emit variant → table FK mappings.
    // ---------------------------------------------------------------------------
    const taggedUnionOverrideKeys = new Set(Object.keys(TAGGED_UNION_OVERRIDES));
    for (const [sourceName] of Object.entries(tables)) {
        const info = schemaTableInfo.get(sourceName);
        if (!info) continue;
        const typeDef = regionSchema.typespace.types[info.productTypeRef];
        if (!typeDef?.Product) continue;

        const taggedFields = collectTaggedUnionFieldsByName(
            typeDef.Product.elements, "", false, taggedUnionOverrideKeys,
        );
        for (const {path: fieldPath, typeName, inList} of taggedFields) {
            const variantMappings = TAGGED_UNION_OVERRIDES[typeName]!;
            for (const [variantName, targetTable] of Object.entries(variantMappings)) {
                const variantPath = `${fieldPath}.${variantName}_`;
                if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === variantPath)) continue;
                if (targetTable === null) continue;
                if (!(targetTable in tables)) {
                    console.warn(`  [tagged-union override] ${sourceName}.${variantPath}: target "${targetTable}" not found`);
                    continue;
                }
                console.log(`  [tagged-union] ${sourceName}.${variantPath} -> ${targetTable}`);
                mappings.push({
                    sourceTable: sourceName,
                    sourceField: variantPath,
                    targetTable,
                    targetField: tables[targetTable].meta.primaryKey,
                    isList: inList,
                });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Pass 1: scalar and object-nested ID fields
    // ---------------------------------------------------------------------------
    for (const [sourceName, {meta: sourceMeta, rows: sourceRows}] of Object.entries(tables)) {
        if (sourceRows.length === 0) continue;
        const idFields = collectIdFields(sourceRows[0], "", false, sourceRows);

        // Also walk the schema type to catch _id/_type fields inside tagged-union variants
        // that don't appear in the current data dump.
        const schemaIdFields = (() => {
            const info = schemaTableInfo.get(sourceName);
            if (!info) return [];
            const typeDef = regionSchema.typespace.types[info.productTypeRef];
            if (!typeDef?.Product) return [];
            return collectIdFieldsFromProductForFK(typeDef.Product.elements, "", false);
        })();

        // Merge: data-sampled takes priority (preserves inList); schema adds missing paths
        const allIdFieldsMap = new Map<string, { path: string; inList: boolean }>();
        for (const f of idFields) allIdFieldsMap.set(f.path, f);
        for (const f of schemaIdFields) {
            if (!allIdFieldsMap.has(f.path)) allIdFieldsMap.set(f.path, f);
        }
        const mergedIdFields = [...allIdFieldsMap.values()];
        const enumColSet = new Set(sourceMeta.enumColumns);

        for (const {path: fieldPath, inList} of mergedIdFields) {
            const isPrimaryKey = !!sourceMeta.primaryKey && fieldPath === sourceMeta.primaryKey;
            const leafKey = fieldPath.includes(".") ? fieldPath.split(".").pop()! : fieldPath;

            if (enumColSet.has(fieldPath) || enumColSet.has(leafKey)) continue;

            // Step 1: overrides
            const overrideKey = `${sourceName}.${fieldPath}`;
            const override =
                overrideKey in OVERRIDES ? OVERRIDES[overrideKey]
                    : fieldPath in OVERRIDES ? OVERRIDES[fieldPath]
                        : leafKey in OVERRIDES ? OVERRIDES[leafKey]
                            : undefined;
            if (override !== undefined) {
                if (override !== null && override in tables) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: override,
                        targetField: tables[override].meta.primaryKey,
                        isList: inList
                    });
                }
                continue;
            }

            // Step 1b: list overrides — these take priority over name-based matching too
            const listOverrideKey = `${sourceName}.${fieldPath}`;
            const listOverride =
                listOverrideKey in LIST_OVERRIDES ? LIST_OVERRIDES[listOverrideKey]
                    : fieldPath in LIST_OVERRIDES ? LIST_OVERRIDES[fieldPath]
                        : leafKey in LIST_OVERRIDES ? LIST_OVERRIDES[leafKey]
                            : undefined;
            if (listOverride !== undefined) {
                if (listOverride !== null && listOverride in tables) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: listOverride,
                        targetField: tables[listOverride].meta.primaryKey,
                        isList: true
                    });
                }
                continue;
            }

            // Step 2a: tagged scalar sum variant (key ends with _) — strip trailing _ and find table
            if (leafKey.endsWith("_")) {
                // Convert CamelCase to snake_case, then look up base table
                const camelBase = leafKey.slice(0, -1);
                const snakeBase = camelBase
                    .replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`)
                    .replace(/^_/, "");
                const nameMatch = baseToTable.get(snakeBase) ?? baseToTable.get(camelBase.toLowerCase());
                if (nameMatch && nameMatch in tables) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: nameMatch,
                        targetField: tables[nameMatch].meta.primaryKey,
                        isList: inList
                    });
                }
                // Skip value-based matching for tagged variants regardless
                continue;
            }

            // Step 2b: name-based
            const nameMatch = findTableByFieldName(leafKey);
            if (nameMatch) {
                if (nameMatch !== sourceName) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: nameMatch,
                        targetField: tables[nameMatch].meta.primaryKey,
                        isList: inList
                    });
                }
                continue;
            }

            // PKs with no name match don't go to value-based matching
            if (isPrimaryKey) continue;

            // Step 3: value-based fallback
            const sampleValues = new Set<unknown>();
            for (const row of sourceRows.slice(0, Math.min(50, sourceRows.length))) {
                const val = getNestedValue(row, fieldPath);
                const vals = Array.isArray(val) ? val : [val];
                for (const v of vals) {
                    if (v !== null && v !== undefined && v !== 0 && v !== "") sampleValues.add(v);
                }
            }
            if (sampleValues.size === 0) continue;

            // Skip small integer sets — likely an enum, not a real FK
            if (
                sampleValues.size <= 6 &&
                [...sampleValues].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10)
            ) continue;

            let bestTarget = "", bestRate = 0;
            for (const [targetName, targetPkSet] of pkSets) {
                if (targetName === sourceName) continue;
                let matches = 0;
                for (const v of sampleValues) if (targetPkSet.has(v)) matches++;
                const rate = matches / sampleValues.size;
                if (rate > bestRate && rate >= 0.5) {
                    bestRate = rate;
                    bestTarget = targetName;
                }
            }
            if (bestTarget) {
                console.log(`  [value-match fallback] ${sourceName}.${fieldPath} -> ${bestTarget} (${(bestRate * 100).toFixed(0)}%)`);
                mappings.push({
                    sourceTable: sourceName,
                    sourceField: fieldPath,
                    targetTable: bestTarget,
                    targetField: tables[bestTarget].meta.primaryKey,
                    isList: inList
                });
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Pass 1b: ensure OVERRIDES are applied even when collectIdFields missed the
    // field (e.g. first-row value is null/non-scalar, or field doesn't end in _id/_type).
    // ---------------------------------------------------------------------------
    for (const [overrideKey, target] of Object.entries(OVERRIDES)) {
        if (overrideKey.includes(".")) {
            // Table-specific override: "table.field"
            const dotIdx = overrideKey.indexOf(".");
            const sourceName = overrideKey.slice(0, dotIdx);
            const fieldPath = overrideKey.slice(dotIdx + 1);
            if (!(sourceName in tables)) continue;
            if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === fieldPath)) continue;
            const info = schemaTableInfo.get(sourceName);
            if (!info || !info.columns.includes(fieldPath)) continue;
            if (target !== null && target in tables) {
                console.log(`  [override late-apply] ${sourceName}.${fieldPath} -> ${target}`);
                mappings.push({
                    sourceTable: sourceName,
                    sourceField: fieldPath,
                    targetTable: target,
                    targetField: tables[target].meta.primaryKey,
                    isList: false
                });
            }
        } else {
            // Global leaf override: apply to every table that has this column
            for (const [sourceName] of Object.entries(tables)) {
                if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === overrideKey)) continue;
                const info = schemaTableInfo.get(sourceName);
                if (!info || !info.columns.includes(overrideKey)) continue;
                if (target !== null && target in tables) {
                    console.log(`  [override late-apply global] ${sourceName}.${overrideKey} -> ${target}`);
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: overrideKey,
                        targetTable: target,
                        targetField: tables[target].meta.primaryKey,
                        isList: false
                    });
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Pass 2: scalar-list fields (array of plain values)
    // ---------------------------------------------------------------------------
    for (const [sourceName, {rows: sourceRows}] of Object.entries(tables)) {
        // Step 1: apply LIST_OVERRIDES unconditionally (field may be empty in all sample rows)
        for (const [overrideKey, target] of Object.entries(LIST_OVERRIDES)) {
            // Keys may be "table.field" or just "field"
            let appliesTo: string | null = null;
            let fieldPath: string;
            if (overrideKey.includes(".")) {
                const dot = overrideKey.indexOf(".");
                const keyTable = overrideKey.slice(0, dot);
                fieldPath = overrideKey.slice(dot + 1);
                if (keyTable === sourceName) appliesTo = fieldPath;
            } else {
                fieldPath = overrideKey;
                appliesTo = fieldPath;
            }
            if (appliesTo === null) continue;

            const tableMeta = tables[sourceName].meta;
            if (!tableMeta.columns.includes(appliesTo)) continue;
            if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === appliesTo)) continue;

            if (target !== null && target in tables) {
                mappings.push({
                    sourceTable: sourceName,
                    sourceField: appliesTo,
                    targetTable: target,
                    targetField: tables[target].meta.primaryKey,
                    isList: true
                });
            }
        }

        // Step 2: name-based discovery for non-overridden list fields
        const sampleRow = sourceRows.find((r) =>
            Object.values(r).some((v) => Array.isArray(v) && v.length > 0)
        ) ?? sourceRows[0];
        if (!sampleRow) continue;

        for (const fieldPath of collectListFields(sampleRow)) {
            // Skip if already covered by an override
            if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === fieldPath)) continue;

            const leafKey = fieldPath.includes(".") ? fieldPath.split(".").pop()! : fieldPath;

            // Check table-specific or global list override
            const tableSpecificKey = `${sourceName}.${fieldPath}`;
            const override =
                tableSpecificKey in LIST_OVERRIDES ? LIST_OVERRIDES[tableSpecificKey]
                    : fieldPath in LIST_OVERRIDES ? LIST_OVERRIDES[fieldPath]
                        : undefined;
            if (override !== undefined) {
                if (override !== null && override in tables) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: override,
                        targetField: tables[override].meta.primaryKey,
                        isList: true
                    });
                }
                continue;
            }

            // Name-based via singularization
            const parts = leafKey.split("_").map(singularize);
            let nameMatch: string | undefined;
            outer: for (let start = 0; start < parts.length; start++) {
                for (let end = parts.length; end > start; end--) {
                    const candidate = parts.slice(start, end).join("_");
                    if (baseToTable.has(candidate)) {
                        nameMatch = baseToTable.get(candidate)!;
                        break outer;
                    }
                }
            }
            if (nameMatch && nameMatch !== sourceName) {
                const targetPkSet = pkSets.get(nameMatch)!;
                let verified = false;
                for (const row of sourceRows.slice(0, 20)) {
                    const arr = getNestedValue(row, fieldPath);
                    if (Array.isArray(arr) && arr.some((v) => targetPkSet.has(v))) {
                        verified = true;
                        break;
                    }
                }
                if (verified) {
                    mappings.push({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: nameMatch,
                        targetField: tables[nameMatch].meta.primaryKey,
                        isList: true
                    });
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // Post-process: enum FK overrides (source stores enum name, target uses numeric index)
    // ---------------------------------------------------------------------------
    // Build a reverse map: sig -> enumName for quick lookup
    const sigToEnumName = new Map<string, string>();
    for (const [sig, entry] of globalEnumRegistry) sigToEnumName.set(sig, entry.name);

    for (const override of ENUM_FK_OVERRIDES) {
        for (const [sourceName] of Object.entries(tables)) {
            // Check if this table has the target enum column
            const variants = schemaTableInfo.get(sourceName)?.enumVariants[override.sourceField];
            if (!variants) continue;

            // Verify the enum on that column matches the expected enumName
            const sig = variants.join("|");
            const enumEntry = globalEnumRegistry.get(sig);
            if (!enumEntry || enumEntry.name !== override.enumName) continue;

            // Skip if already mapped
            if (mappings.some((m) => m.sourceTable === sourceName && m.sourceField === override.sourceField)) continue;

            // Verify target table exists
            if (!(override.targetTable in tables)) continue;

            console.log(`  [enum FK] ${sourceName}.${override.sourceField} → ${override.targetTable}.${override.targetField} via enum "${enumEntry.name}"`);
            mappings.push({
                sourceTable: sourceName,
                sourceField: override.sourceField,
                targetTable: override.targetTable,
                targetField: override.targetField,
                isList: override.isList,
                enumConversion: enumEntry.name,
            });
        }
    }

    // ---------------------------------------------------------------------------
    // Post-process: attach conditionalTargets to FKs matching CONDITIONAL_FK_RULES
    // ---------------------------------------------------------------------------
    for (const mapping of mappings) {
        const fkLeaf = mapping.sourceField.split(".").pop()!;
        const rule = CONDITIONAL_FK_RULES.find((r) => r.fkLeaf === fkLeaf);
        if (!rule) continue;

        // Build sibling path: replace the leaf with the sibling leaf
        const parts = mapping.sourceField.split(".");
        const siblingPath = [...parts.slice(0, -1), rule.siblingLeaf].join(".");

        // Verify the sibling field actually exists and is an enum column in this source table
        const sourceMeta = tables[mapping.sourceTable]?.meta;
        if (!sourceMeta) continue;
        const siblingIsEnum = sourceMeta.enumColumns.includes(siblingPath) ||
            sourceMeta.enumColumns.includes(rule.siblingLeaf);
        if (!siblingIsEnum) continue;

        mapping.conditionalTargets = rule.conditions.map((c) => ({
            whenField: siblingPath,
            whenValue: c.whenValue,
            targetTable: c.targetTable,
        }));
        // Use the first condition's target as the default targetTable
        mapping.targetTable = rule.conditions[0].targetTable!;
        console.log(`  [conditional FK] ${mapping.sourceTable}.${mapping.sourceField}: depends on ${siblingPath}`);
    }

    return mappings;
}

// ---------------------------------------------------------------------------
// 4. Load data files
// ---------------------------------------------------------------------------
const jsonFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort();
console.log(`\nFound ${jsonFiles.length} data files in ${DATA_DIR}`);

const tableData: Record<string, { meta: TableMeta; rows: Record<string, unknown>[] }> = {};

for (const file of jsonFiles) {
    const tableName = file.replace(/\.json$/, "");
    process.stdout.write(`  Loading ${tableName}...`);
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf-8")) as Record<string, unknown>[];
    tableData[tableName] = {meta: buildTableMeta(tableName, rows, schemaTableInfo.get(tableName)), rows};
    console.log(` ${rows.length} rows`);
}

// Register schema-only (private) tables with empty rows for FK name resolution.
// Skip "staged_*" tables — they mirror non-staged desc tables and produce redundant FKs.
let privateOnlyCount = 0;
let skippedStagedCount = 0;
for (const [tableName, info] of schemaTableInfo) {
    if (tableName in tableData) continue;
    if (tableName.startsWith("staged_")) {
        skippedStagedCount++;
        continue;
    }
    tableData[tableName] = {meta: buildTableMeta(tableName, [], info), rows: []};
    privateOnlyCount++;
}
console.log(`  Registered ${privateOnlyCount} schema-only (private) tables`);
console.log(`  Skipped ${skippedStagedCount} staged_ tables`);

// ---------------------------------------------------------------------------
// 5. Detect FKs and write outputs
// ---------------------------------------------------------------------------
console.log("\nDetecting foreign keys...");
const foreignKeys = detectForeignKeys(tableData);
console.log(`  Found ${foreignKeys.length} foreign key mappings`);


let annotations: VersionEntry[] = [];
if (fs.existsSync(ANNOTATIONS)) {
    try {
        annotations = JSON.parse(fs.readFileSync(ANNOTATIONS, "utf-8")) as VersionEntry[];
        console.log(`Loaded ${annotations.length} version annotations`);
    } catch (e) {
        console.warn("Could not parse version_annotations.json, ignoring:", e);
    }
}

const annotationsByTag = new Map<string, VersionEntry>(annotations.map((v) => [v.tag, v]));

const manifest: DefManifest = {
    tag: VERSION_TAG,
    label: annotationsByTag.get(VERSION_TAG)?.label,
    description: annotationsByTag.get(VERSION_TAG)?.description,
    enums: [...globalEnumRegistry.values()].map(({name, values}): EnumDef => ({name, values})),
    tables: Object.values(tableData).map(({meta}) => meta),
    foreignKeys,
};

const outputPath = path.join(VERSION_DIR, `version_${VERSION_TAG}.json`);
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log(`\nWrote ${outputPath}`);

// ---------------------------------------------------------------------------
// 6. Generate search index
// ---------------------------------------------------------------------------
console.log("\nBuilding search index...");
const searchEntries: Record<string, (string | number | { pk: string | number; n?: string; f?: [string, string][] })[]> = {};
let totalEntryCount = 0;

for (const [tableName, {meta, rows}] of Object.entries(tableData)) {
    // Only index static, public tables that have rows
    if (!meta.isPublic || rows.length === 0) continue;
    if (!tableName.endsWith("_desc") && !tableName.match(/_desc_v\d+$/) && tableName !== "claim_tile_cost") continue;
    if (!meta.primaryKey) continue;

    const hasDisplay = !!meta.displayField;
    const searchFields = meta.searchFields.filter((f) => f !== meta.displayField);

    const tableEntries: (string | number | { pk: string | number; n?: string; f?: [string, string][] })[] = [];

    for (const row of rows) {
        const rawPk = row[meta.primaryKey!];
        if (rawPk == null) continue;
        // Keep PK as number when it is one — saves space in JSON
        const pk = typeof rawPk === "number" ? rawPk : String(rawPk);

        if (!hasDisplay && searchFields.length === 0) {
            // Pure PK table — just store the raw pk value
            tableEntries.push(pk);
            continue;
        }

        const displayRaw = hasDisplay ? row[meta.displayField!] : undefined;
        const n = displayRaw != null ? String(displayRaw) : undefined;

        const fieldPairs: [string, string][] = [];
        for (const field of searchFields) {
            const val = row[field];
            if (val == null || val === "") continue;
            const str = String(val);
            if (str.length <= 1) continue;
            if (/^\\u[0-9a-f]{4}$/i.test(str)) continue;
            if (/^[0-9a-f]{32,}$/i.test(str)) continue;
            fieldPairs.push([field, str]);
        }

        const entry: { pk: string | number; n?: string; f?: [string, string][] } = {pk};
        if (n != null) entry.n = n;
        if (fieldPairs.length > 0) entry.f = fieldPairs;
        tableEntries.push(entry);
    }

    if (tableEntries.length > 0) {
        searchEntries[tableName] = tableEntries;
        totalEntryCount += tableEntries.length;
    }
}

const searchIndex: SearchIndex = {tag: VERSION_TAG, entries: searchEntries};
const searchPath = path.join(VERSION_DIR, `search_${VERSION_TAG}.json`);
fs.writeFileSync(searchPath, JSON.stringify(searchIndex), "utf-8"); // compact, no indent
const fileSizeKb = Math.round(fs.statSync(searchPath).size / 1024);
console.log(`Wrote ${searchPath} (${totalEntryCount} entries, ${fileSizeKb} KB)`);

console.log("\nDone.");
