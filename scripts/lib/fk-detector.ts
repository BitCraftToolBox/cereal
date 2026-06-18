import fs from "node:fs";
import path from "node:path";
import type {ForeignKeyMapping, ProductElement, SpacetimeDBSchema} from "../../src/lib/schema";
import {buildMigrationInfo, migrationBase} from "../../src/lib/schemaDerive";
import {parseJsonLossless} from "./json-lossless";
import type {BuildTableMeta, SchemaInfo} from "./table-meta";

export interface TypeConditionalRule {
    /** Canonical enum type that discriminates the target (e.g. "ItemType", "EntityType"). */
    discriminatorType: string;
    /** Optional: only apply when the discriminator column's leaf name matches this. */
    discriminatorLeaf?: string;
    /** Explicit sibling FK leaf in the same product (e.g. "description_id"). */
    siblingLeaf?: string;
    /** Or derive the sibling leaf from the discriminator leaf by suffix substitution. */
    siblingSuffix?: { from: string; to: string };
    conditions: { whenValue: string; targetTable: string | null }[];
}

export interface FkDetectionConfig {
    /** Table name prefixes to exclude entirely (e.g. "staged_", "inter_module_message"). */
    ignoreTables?: string[];
    nameOverrides: Record<string, string | null>;
    /** Target may be a single table, an array of tables (unconditional multi-target), or null. */
    fkOverrides: Record<string, string | string[] | null>;
    listOverrides: Record<string, string | string[] | null>;
    taggedUnionOverrides: Record<string, Record<string, string | null>>;
    /** Map a canonical enum type → the table it identifies (PK is the enum's int form). */
    enumTargets: Record<string, string | null>;
    typeConditionalRules: TypeConditionalRule[];
}

export interface CandidateMatch {
    sourceTable: string;
    sourceField: string;
    targetTable: string;
    matchRate: number;
    /** Reverse coverage: fraction of the target's PKs hit by the (sampled) source values.
     *  High forward + high reverse ⇒ tight population match (e.g. enemy_state), vs a magnet
     *  table (health_state) that many sources point into but only partially overlap. */
    reverseRate?: number;
    /** Other targets tied at the top forward tier (kept for manual disambiguation). */
    alternateTargets?: string[];
    sampleSize: number;
    isList?: boolean;
    sourceKind: "static" | "state-dump";
    overrideType: "fkOverrides" | "listOverrides";
    configKey: string;
    configValue: string;
    configSnippet: string;
}

/** ECS "center" tables that are the canonical target of generic owner/entity references.
 *  STDB has no real FKs, so a generic `owner_entity_id` overlaps many `*_state` magnet
 *  tables at 100%; when several tie on forward rate we bias toward these design centers. */
const PREFERRED_SOURCE_TABLES = new Set<string>([
    "player_state",
    "claim_state",
    "building_state",
    "deployable_state",
    "placeable_state",
    "npc_state",
]);

export type TableDataMap = Record<string, { meta: BuildTableMeta; rows: Record<string, unknown>[] }>;

interface FkDetectorDeps {
    tables: TableDataMap;
    schemaTableInfo: Map<string, SchemaInfo>;
    regionSchema: SpacetimeDBSchema;
    fkConfig: FkDetectionConfig;
    globalEnumRegistry: Map<string, { name: string; values: string[] }>;
    collectTaggedUnionFieldsByName: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
        overrideKeys: Set<string>,
    ) => Array<{ path: string; typeName: string; inList: boolean }>;
    collectIdFieldsFromProductForFK: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ) => Array<{ path: string; inList: boolean }>;
    collectEnumFieldsFromProductForFK: (
        elements: ProductElement[],
        prefix: string,
        inList: boolean,
    ) => Array<{ path: string; variants: string[]; inList: boolean }>;
    resolveColumnPath: (productTypeRef: number, path: string) => { found: boolean; inList: boolean };
    getNestedValue: (obj: Record<string, unknown>, key: string) => unknown;
}

function isEntityIdLike(fieldLeaf: string): boolean {
    return /(^|_)entity_ids?$/.test(fieldLeaf);
}

/** True when `name` is (the current version of) an ECS-center table in `PREFERRED_SOURCE_TABLES`.
 *  Resolves through the migration suffix so `deployable_state_v2` counts as `deployable_state`. */
function isPreferredSource(name: string): boolean {
    return PREFERRED_SOURCE_TABLES.has(migrationBase(name).base);
}

function leafOf(p: string): string {
    return p.includes(".") ? p.split(".").pop()! : p;
}

function parentOf(p: string): string {
    return p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
}

function collectIdFields(
    obj: Record<string, unknown>,
    getNestedValue: FkDetectorDeps["getNestedValue"],
    prefix = "",
    inList = false,
    allRows?: Record<string, unknown>[],
): Array<{ path: string; inList: boolean }> {
    const fields: Array<{ path: string; inList: boolean }> = [];
    for (const [key, value] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if ((key.endsWith("_id") || key.endsWith("_type")) && (typeof value === "number" || typeof value === "string")) {
            fields.push({path: p, inList});
        }
        if (key.endsWith("_") && (typeof value === "number" || typeof value === "string")) {
            fields.push({path: p, inList});
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            fields.push(...collectIdFields(value as Record<string, unknown>, getNestedValue, p, inList));
        }
        if (Array.isArray(value)) {
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
                    if (Array.isArray(arr)) for (const item of arr) recordSample(item);
                }
            }
            for (const sample of sampledShapes.values()) {
                fields.push(...collectIdFields(sample, getNestedValue, p, true));
            }
        }
    }
    return fields;
}

function collectListFields(obj: Record<string, unknown>, prefix = ""): string[] {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${key}` : key;
        if (Array.isArray(value) && value.length > 0 && typeof value[0] !== "object") fields.push(p);
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

function detectValueCandidatesForRows(
    sourceTable: string,
    rows: Record<string, unknown>[],
    allTables: TableDataMap,
    getNestedValue: FkDetectorDeps["getNestedValue"],
    pkSets: Map<string, Set<unknown>>,
    alreadyMapped?: Set<string>,
): CandidateMatch[] {
    if (rows.length === 0) return [];
    const sourceMeta = allTables[sourceTable]?.meta;
    if (!sourceMeta) return [];

    const idFields = collectIdFields(rows[0], getNestedValue, "", false, rows);
    const enumColSet = new Set(sourceMeta.enumColumns);
    const out: CandidateMatch[] = [];

    for (const {path: fieldPath, inList} of idFields) {
        const leafKey = leafOf(fieldPath);
        if (enumColSet.has(fieldPath) || enumColSet.has(leafKey)) continue;
        // Preferred ECS-center tables: `entity_id` is their own identity, never an outgoing FK —
        // don't report candidates trying to point it at the other tables that share its id space.
        if (fieldPath === "entity_id" && isPreferredSource(sourceTable)) continue;
        // Defer to type/name matches already produced by detectForeignKeys — even a
        // correct value match is just noise if the column is already mapped.
        if (alreadyMapped?.has(`${sourceTable}\u0000${fieldPath}`)) continue;

        const isEntityField = isEntityIdLike(leafKey);
        const sampleValues = new Set<unknown>();
        for (const row of rows.slice(0, Math.min(500, rows.length))) {
            const val = getNestedValue(row, fieldPath);
            const vals = Array.isArray(val) ? val : [val];
            for (const v of vals) {
                if (v !== null && v !== undefined && v !== 0 && v !== "") sampleValues.add(v);
            }
        }

        if (sampleValues.size === 0) continue;
        if (
            sampleValues.size <= 6 &&
            [...sampleValues].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10)
        ) continue;

        let bestTarget = "";
        let bestRate = 0;
        // Score every plausible target by forward match (is the source a subset of the
        // target?) and reverse match (how much of the target the source covers).
        const scored: Array<{ name: string; forward: number; reverse: number; preferred: boolean }> = [];
        for (const [targetName, targetPkSet] of pkSets) {
            if (targetName === sourceTable) continue;
            if (isEntityField && /_desc(?:_v\d+)?$/.test(targetName)) continue;
            if (targetPkSet.size === 0) continue;
            let matches = 0;
            for (const v of sampleValues) if (targetPkSet.has(v)) matches++;
            const forward = matches / sampleValues.size;
            if (forward < 0.5) continue;
            // Reverse is a proxy: the sampled source uniformly under-counts every target's
            // intersection, so the sampling factor cancels and relative ordering is preserved.
            const reverse = matches / targetPkSet.size;
            scored.push({name: targetName, forward, reverse, preferred: PREFERRED_SOURCE_TABLES.has(targetName)});
        }
        if (scored.length === 0) continue;

        // Tie-break within a forward-rate tier: ECS center tables first (a generic
        // owner/entity ref canonically points at the design center, even though magnet
        // tables can show an equal or higher reverse rate), then tightest reverse coverage,
        // then a stable name order. Forward rate stays the dominant signal.
        const fwdTier = (f: number) => Math.round(f * 100);
        scored.sort((a, b) => {
            const ta = fwdTier(a.forward);
            const tb = fwdTier(b.forward);
            if (ta !== tb) return tb - ta;
            if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
            if (b.reverse !== a.reverse) return b.reverse - a.reverse;
            return a.name.localeCompare(b.name);
        });
        const best = scored[0];
        bestTarget = best.name;
        bestRate = best.forward;
        const topTier = fwdTier(best.forward);
        const alternateTargets = scored
            .slice(1)
            .filter((s) => fwdTier(s.forward) === topTier)
            .slice(0, 4)
            .map((s) => s.name);

        out.push({
            sourceTable,
            sourceField: fieldPath,
            targetTable: bestTarget,
            matchRate: bestRate,
            reverseRate: best.reverse,
            alternateTargets: alternateTargets.length ? alternateTargets : undefined,
            sampleSize: sampleValues.size,
            isList: inList,
            sourceKind: "state-dump",
            overrideType: inList ? "listOverrides" : "fkOverrides",
            configKey: `${sourceTable}.${fieldPath}`,
            configValue: bestTarget,
            configSnippet: `"${sourceTable}.${fieldPath}": "${bestTarget}"`,
        });
    }

    return out;
}

export function loadStateDumpCandidates(
    dirs: string[],
    allTables: TableDataMap,
    getNestedValue: FkDetectorDeps["getNestedValue"],
    alreadyMapped?: Set<string>,
): CandidateMatch[] {
    // The static `allTables` only has rows for desc tables; state tables are registered
    // schema-only (empty rows). To match state columns against *other state tables* (e.g.
    // entity_id → player_state/enemy_state) we overlay the dumped rows onto a merged map,
    // then build PK value sets once across the union of static + dumped data.
    const merged: TableDataMap = {};
    for (const [name, entry] of Object.entries(allTables)) {
        merged[name] = {meta: entry.meta, rows: entry.rows};
    }

    const dumpedTables: string[] = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new Error(`State dump directory not found: ${dir}`);
        }
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
        for (const file of files) {
            const tableName = file.replace(/\.json$/, "");
            if (!(tableName in allTables)) continue;
            const fullPath = path.join(dir, file);
            // BSATN-dumped U64 ids exceed 2^53 — parse losslessly so they keep full precision.
            const rows = parseJsonLossless<Record<string, unknown>[]>(fs.readFileSync(fullPath, "utf-8"));
            // Overlay dumped rows (keep the schema-derived meta).
            merged[tableName] = {meta: allTables[tableName].meta, rows};
            dumpedTables.push(tableName);
        }
    }

    // Build PK value sets once across the merged set (static desc rows + dumped state rows).
    const pkSets = new Map<string, Set<unknown>>();
    for (const [name, {meta, rows}] of Object.entries(merged)) {
        if (!meta.primaryKey || rows.length === 0) continue;
        const set = new Set<unknown>();
        for (const row of rows) set.add(row[meta.primaryKey]);
        pkSets.set(name, set);
    }

    const candidates: CandidateMatch[] = [];
    for (const tableName of dumpedTables) {
        candidates.push(
            ...detectValueCandidatesForRows(tableName, merged[tableName].rows, merged, getNestedValue, pkSets, alreadyMapped),
        );
    }
    return candidates;
}

export function detectForeignKeys(deps: FkDetectorDeps): { mappings: ForeignKeyMapping[]; candidates: CandidateMatch[] } {
    const {
        tables,
        schemaTableInfo,
        regionSchema,
        fkConfig,
        globalEnumRegistry,
        collectTaggedUnionFieldsByName,
        collectIdFieldsFromProductForFK,
        collectEnumFieldsFromProductForFK,
        resolveColumnPath,
        getNestedValue,
    } = deps;

    const mappings: ForeignKeyMapping[] = [];
    const candidates: CandidateMatch[] = [];

    // ── claimed-field bookkeeping (enforces pass priority) ──────────────────────
    const claimed = new Set<string>();
    const claimKey = (t: string, f: string) => `${t}\u0000${f}`;
    const claim = (t: string, f: string) => claimed.add(claimKey(t, f));
    const isClaimed = (t: string, f: string) => claimed.has(claimKey(t, f));
    const addMapping = (m: ForeignKeyMapping) => {
        mappings.push(m);
        claim(m.sourceTable, m.sourceField);
    };

    const pk = (t: string) => tables[t]?.meta.primaryKey;

    // Ignored tables (staged_*, inter_module_message*, …) are still registered so their
    // schema is viewable, but they are excluded from FK detection — neither sources nor
    // (auto-)targets.
    const ignorePrefixes = fkConfig.ignoreTables ?? [];
    const isIgnored = (name: string) => ignorePrefixes.some((p) => name.startsWith(p));

    // ── migrated `_vN` tables ────────────────────────────────────────────────────
    // Both desc and state tables may be migrated; in a world-wipe a chain can collapse back to
    // the bare base. The "current" version of a migration base is the highest-N table present in
    // *this* snapshot (bare base = N0). Superseded versions stay registered (viewable schema) but
    // are excluded from FK detection — neither sources nor targets — and every config/name target
    // is resolved to the current version so base-name rules land on (e.g.) `deployable_state_v2`.
    // Shared with the frontend via `schemaDerive.buildMigrationInfo` so the grouping can't drift.
    const {resolveCurrent, isSuperseded} = buildMigrationInfo(Object.keys(tables));
    // Combined source/target exclusion: ignored prefixes + superseded migration versions.
    const isExcluded = (name: string) => isIgnored(name) || isSuperseded(name);

    // ── PK value sets (for list verification) ───────────────────────────────────
    const pkSets = new Map<string, Set<unknown>>();
    for (const [name, {meta, rows}] of Object.entries(tables)) {
        if (!meta.primaryKey || isExcluded(name)) continue;
        const s = new Set<unknown>();
        for (const row of rows) s.add(row[meta.primaryKey]);
        pkSets.set(name, s);
    }

    // ── base-name → table maps (for name-based matching) ────────────────────────
    // Built only from current (non-superseded) tables, so a name match lands directly on the
    // current migration version. The migration suffix is stripped *before* matching `_desc` /
    // `_state` (field names never carry version numbers), and the current versioned table name
    // is stored as the value — so e.g. `deployable_state_v2` registers under base `deployable`
    // and `deployable_entity_id` resolves to it without a manual override.
    const baseToDesc = new Map<string, string>();
    const baseToState = new Map<string, string>();
    const baseToAny = new Map<string, string>();
    for (const tName of Object.keys(tables)) {
        if (isExcluded(tName)) continue;
        const {base: unversioned} = migrationBase(tName);
        const desc = unversioned.match(/^(.*)_desc$/);
        const state = unversioned.match(/^(.*)_state$/);
        if (desc) {
            const base = desc[1];
            baseToDesc.set(base, tName);
            if (!baseToAny.has(base)) baseToAny.set(base, tName);
            continue;
        }
        if (state) {
            const base = state[1];
            if (!baseToState.has(base)) baseToState.set(base, tName);
            if (!baseToAny.has(base)) baseToAny.set(base, tName);
            continue;
        }
        if (!baseToAny.has(unversioned)) baseToAny.set(unversioned, tName);
    }

    function inferEntityBase(fieldLeaf: string): string | undefined {
        if (!isEntityIdLike(fieldLeaf)) return undefined;
        const m = fieldLeaf.match(/^(.*)_entity_ids?$/);
        if (!m) return undefined;
        return m[1] || undefined;
    }

    function findEntityStateTarget(fieldLeaf: string): string | undefined {
        const base = inferEntityBase(fieldLeaf);
        if (!base) return undefined;
        return baseToState.get(base);
    }

    /** Name-based target: maps `<base>_id`/`<base>_type` to a desc table, handling
     *  the `description` → `desc` shorthand (`building_description_id` → building_desc). */
    function findTableByFieldName(fieldLeaf: string): string | undefined {
        if (isEntityIdLike(fieldLeaf)) return findEntityStateTarget(fieldLeaf);

        const isId = fieldLeaf.endsWith("_id");
        const isType = fieldLeaf.endsWith("_type");
        if (!isId && !isType) return undefined;
        let base = isId ? fieldLeaf.slice(0, -3) : fieldLeaf;
        // `..._description` is a common long-form of `..._desc` / the base table name.
        base = base.replace(/_description$/, "").replace(/^description$/, "");
        if (!base) return undefined;
        const parts = base.split("_").filter(Boolean);
        for (let start = 0; start < parts.length; start++) {
            for (let end = parts.length; end > start; end--) {
                const candidate = parts.slice(start, end).join("_");
                const descTarget = baseToDesc.get(candidate);
                if (descTarget) return descTarget;
            }
        }
        return undefined;
    }

    // ── per-table field caches ──────────────────────────────────────────────────
    const idFieldsCache = new Map<string, Map<string, { path: string; inList: boolean }>>();

    function mergedIdFields(sourceName: string): Map<string, { path: string; inList: boolean }> {
        const cached = idFieldsCache.get(sourceName);
        if (cached) return cached;
        const sourceRows = tables[sourceName]?.rows ?? [];
        const fromData = sourceRows.length > 0
            ? collectIdFields(sourceRows[0], getNestedValue, "", false, sourceRows)
            : [];
        const info = schemaTableInfo.get(sourceName);
        const fromSchema = info?.productTypeRef !== undefined
            ? collectIdFieldsFromProductForFK(regionSchema.typespace.types[info.productTypeRef]?.Product?.elements ?? [], "", false)
            : [];
        const map = new Map<string, { path: string; inList: boolean }>();
        for (const f of fromData) map.set(f.path, f);
        for (const f of fromSchema) if (!map.has(f.path)) map.set(f.path, f);
        idFieldsCache.set(sourceName, map);
        return map;
    }

    const enumNameOf = (variants: string[]) => globalEnumRegistry.get(variants.join("|"))?.name;

    const OVERRIDES = fkConfig.fkOverrides ?? {};
    const LIST_OVERRIDES = fkConfig.listOverrides ?? {};
    const TAGGED_UNION_OVERRIDES = fkConfig.taggedUnionOverrides ?? {};
    const ENUM_TARGETS = fkConfig.enumTargets ?? {};
    const TYPE_CONDITIONAL_RULES = fkConfig.typeConditionalRules ?? [];

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 0 — tagged-union overrides (schema-driven, highest priority)
    // ════════════════════════════════════════════════════════════════════════════
    const taggedUnionOverrideKeys = new Set(Object.keys(TAGGED_UNION_OVERRIDES));
    for (const [sourceName] of Object.entries(tables)) {
        if (isExcluded(sourceName)) continue;
        const info = schemaTableInfo.get(sourceName);
        if (!info) continue;
        const typeDef = regionSchema.typespace.types[info.productTypeRef];
        if (!typeDef?.Product) continue;

        const taggedFields = collectTaggedUnionFieldsByName(typeDef.Product.elements, "", false, taggedUnionOverrideKeys);
        for (const {path: fieldPath, typeName, inList} of taggedFields) {
            const variantMappings = TAGGED_UNION_OVERRIDES[typeName]!;
            for (const [variantName, targetTable] of Object.entries(variantMappings)) {
                const variantPath = `${fieldPath}.${variantName}_`;
                if (isClaimed(sourceName, variantPath)) continue;
                if (targetTable === null) {
                    claim(sourceName, variantPath);
                    continue;
                }
                const target = resolveCurrent(targetTable);
                if (!(target in tables)) {
                    console.warn(`  [tagged-union override] ${sourceName}.${variantPath}: target "${targetTable}" not found`);
                    continue;
                }
                addMapping({
                    sourceTable: sourceName,
                    sourceField: variantPath,
                    targetTable: target,
                    targetField: pk(target),
                    isList: inList,
                });
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 1 — type-based (enum convention + conditional-by-type discriminators)
    // ════════════════════════════════════════════════════════════════════════════
    function computeSiblingPath(enumPath: string, rule: TypeConditionalRule): string | undefined {
        const parent = parentOf(enumPath);
        const leaf = leafOf(enumPath);
        let siblingLeaf: string | undefined;
        if (rule.siblingLeaf) {
            siblingLeaf = rule.siblingLeaf;
        } else if (rule.siblingSuffix) {
            if (!leaf.endsWith(rule.siblingSuffix.from)) return undefined;
            siblingLeaf = leaf.slice(0, -rule.siblingSuffix.from.length) + rule.siblingSuffix.to;
        } else {
            return undefined;
        }
        return parent ? `${parent}.${siblingLeaf}` : siblingLeaf;
    }

    for (const [sourceName] of Object.entries(tables)) {
        if (isExcluded(sourceName)) continue;
        const info = schemaTableInfo.get(sourceName);
        if (!info) continue;
        const elements = regionSchema.typespace.types[info.productTypeRef]?.Product?.elements;
        if (!elements) continue;

        const enumFields = collectEnumFieldsFromProductForFK(elements, "", false);
        const idFields = mergedIdFields(sourceName);

        for (const {path: enumPath, variants, inList} of enumFields) {
            const enumName = enumNameOf(variants);
            if (!enumName) continue;
            const leaf = leafOf(enumPath);

            // (a) conditional-by-type: emit an FK on the *sibling id* column.
            let handled = false;
            for (const rule of TYPE_CONDITIONAL_RULES) {
                if (rule.discriminatorType !== enumName) continue;
                if (rule.discriminatorLeaf && leaf !== rule.discriminatorLeaf) continue;
                const siblingPath = computeSiblingPath(enumPath, rule);
                if (!siblingPath || !idFields.has(siblingPath)) continue;
                handled = true;
                if (isClaimed(sourceName, siblingPath)) break;

                const conds = rule.conditions
                    .map((c) => ({...c, targetTable: c.targetTable === null ? null : resolveCurrent(c.targetTable)}))
                    .filter((c) => c.targetTable === null || c.targetTable in tables);
                const firstTarget = conds.find((c) => c.targetTable !== null)?.targetTable;
                if (!firstTarget) break;

                addMapping({
                    sourceTable: sourceName,
                    sourceField: siblingPath,
                    targetTable: firstTarget,
                    targetField: pk(firstTarget),
                    isList: idFields.get(siblingPath)!.inList,
                    conditionalTargets: conds.map((c) => ({
                        whenField: enumPath,
                        whenValue: c.whenValue,
                        targetTable: c.targetTable,
                    })),
                });
                claim(sourceName, enumPath); // the discriminator itself isn't a separate FK
                break;
            }
            if (handled) continue;

            // (b) direct enum → table (the enum value IS the target PK, via enumConversion).
            if (enumName in ENUM_TARGETS) {
                const rawTarget = ENUM_TARGETS[enumName];
                const target = rawTarget ? resolveCurrent(rawTarget) : rawTarget;
                claim(sourceName, enumPath);
                if (target && target in tables && target !== sourceName) {
                    addMapping({
                        sourceTable: sourceName,
                        sourceField: enumPath,
                        targetTable: target,
                        targetField: pk(target),
                        isList: inList,
                        enumConversion: enumName,
                    });
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 2 — explicit overrides (schema-driven path resolution, multi-target)
    // ════════════════════════════════════════════════════════════════════════════
    function normalizeTargets(v: string | string[] | null): string[] | null {
        if (v === null) return null;
        return Array.isArray(v) ? v : [v];
    }

    function applyOverride(sourceName: string, fieldPath: string, raw: string | string[] | null, forceList: boolean): boolean {
        if (isExcluded(sourceName)) return false;
        if (isClaimed(sourceName, fieldPath)) return true;
        const info = schemaTableInfo.get(sourceName);
        if (!info) return false;
        const resolved = resolveColumnPath(info.productTypeRef, fieldPath);
        if (!resolved.found) return false;

        const targets = normalizeTargets(raw);
        if (targets === null) {
            claim(sourceName, fieldPath); // explicit suppression
            return true;
        }
        const valid = [...new Set(targets.map(resolveCurrent))].filter((t) => t in tables);
        if (valid.length === 0) {
            if (targets.length > 0) console.warn(`  [override] ${sourceName}.${fieldPath}: no target tables exist (${targets.join(", ")})`);
            return false;
        }
        const isList = forceList || resolved.inList;
        if (valid.length === 1) {
            addMapping({
                sourceTable: sourceName,
                sourceField: fieldPath,
                targetTable: valid[0],
                targetField: pk(valid[0]),
                isList,
            });
        } else {
            addMapping({
                sourceTable: sourceName,
                sourceField: fieldPath,
                targetTable: valid[0],
                targetTables: valid,
                isList,
            });
        }
        return true;
    }

    function applyOverrideMap(map: Record<string, string | string[] | null>, forceList: boolean): void {
        for (const [key, raw] of Object.entries(map)) {
            if (key.includes(".")) {
                const dot = key.indexOf(".");
                // Override keys use base table names; resolve the *source* to its current
                // migration version too (not just targets) so a rule keyed on `deployable_state.x`
                // still applies once the live table is `deployable_state_v2`.
                applyOverride(resolveCurrent(key.slice(0, dot)), key.slice(dot + 1), raw, forceList);
                continue;
            }
            // Global (leaf-only) key: apply to any table where it resolves as a top-level
            // column OR matches the leaf of a nested id field. (Superseded sources are skipped
            // inside applyOverride, so this naturally lands on current versions only.)
            for (const sourceName of Object.keys(tables)) {
                if (applyOverride(sourceName, key, raw, forceList)) continue;
                for (const f of mergedIdFields(sourceName).values()) {
                    if (leafOf(f.path) === key) applyOverride(sourceName, f.path, raw, forceList);
                }
            }
        }
    }

    applyOverrideMap(OVERRIDES, false);
    applyOverrideMap(LIST_OVERRIDES, true);

    // ── Preferred ECS-center tables: their own `entity_id` is the entity's identity, not an
    // outgoing FK. Claim it (after explicit overrides, so an intentional override still wins) so
    // the name/list/value passes never emit a mapping — or a candidate — pointing it elsewhere.
    for (const sourceName of Object.keys(tables)) {
        if (isExcluded(sourceName) || !isPreferredSource(sourceName)) continue;
        if (mergedIdFields(sourceName).has("entity_id")) claim(sourceName, "entity_id");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 3 — name-based matching over id fields
    // ════════════════════════════════════════════════════════════════════════════
    for (const [sourceName, {meta: sourceMeta}] of Object.entries(tables)) {
        if (isExcluded(sourceName)) continue;
        const enumColSet = new Set(sourceMeta.enumColumns);
        for (const {path: fieldPath, inList} of mergedIdFields(sourceName).values()) {
            if (isClaimed(sourceName, fieldPath)) continue;
            const leafKey = leafOf(fieldPath);
            if (enumColSet.has(fieldPath) || enumColSet.has(leafKey)) continue;

            // flattened sum-variant scalar like `someField_` → match its camel/snake base.
            if (leafKey.endsWith("_")) {
                const camelBase = leafKey.slice(0, -1);
                const snakeBase = camelBase.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`).replace(/^_/, "");
                const nameMatch =
                    baseToAny.get(snakeBase) ??
                    baseToAny.get(camelBase.toLowerCase()) ??
                    baseToDesc.get(snakeBase) ??
                    baseToDesc.get(camelBase.toLowerCase());
                if (nameMatch && nameMatch in tables && nameMatch !== sourceName) {
                    addMapping({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: nameMatch,
                        targetField: pk(nameMatch),
                        isList: inList,
                    });
                }
                continue;
            }

            const nameMatch = findTableByFieldName(leafKey);
            if (nameMatch && nameMatch !== sourceName && nameMatch in tables) {
                addMapping({
                    sourceTable: sourceName,
                    sourceField: fieldPath,
                    targetTable: nameMatch,
                    targetField: pk(nameMatch),
                    isList: inList,
                });
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 4 — list (array-of-primitive) name matching, verified against PK values
    // ════════════════════════════════════════════════════════════════════════════
    for (const [sourceName, {rows: sourceRows}] of Object.entries(tables)) {
        if (isExcluded(sourceName)) continue;
        const sampleRow = sourceRows.find((r) => Object.values(r).some((v) => Array.isArray(v) && v.length > 0)) ?? sourceRows[0];
        if (!sampleRow) continue;

        for (const fieldPath of collectListFields(sampleRow)) {
            if (isClaimed(sourceName, fieldPath)) continue;
            const leafKey = leafOf(fieldPath);
            const parts = leafKey.split("_").map(singularize);

            let nameMatch: string | undefined;
            if (isEntityIdLike(leafKey)) {
                nameMatch = findEntityStateTarget(leafKey);
            } else {
                outer: for (let start = 0; start < parts.length; start++) {
                    for (let end = parts.length; end > start; end--) {
                        const candidate = parts.slice(start, end).join("_");
                        const descTarget = baseToDesc.get(candidate);
                        if (descTarget) {
                            nameMatch = descTarget;
                            break outer;
                        }
                        if (baseToAny.has(candidate)) {
                            nameMatch = baseToAny.get(candidate)!;
                            break outer;
                        }
                    }
                }
            }

            if (nameMatch && nameMatch !== sourceName) {
                const targetPkSet = pkSets.get(nameMatch);
                if (!targetPkSet) continue;
                let verified = false;
                for (const row of sourceRows.slice(0, 20)) {
                    const arr = getNestedValue(row, fieldPath);
                    if (Array.isArray(arr) && arr.some((v) => targetPkSet.has(v))) {
                        verified = true;
                        break;
                    }
                }
                if (verified) {
                    addMapping({
                        sourceTable: sourceName,
                        sourceField: fieldPath,
                        targetTable: nameMatch,
                        targetField: pk(nameMatch),
                        isList: true,
                    });
                }
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PASS 5 — value-based fallback (advisory candidates only; never auto-applied)
    // ════════════════════════════════════════════════════════════════════════════
    for (const [sourceName, {meta: sourceMeta, rows: sourceRows}] of Object.entries(tables)) {
        if (isExcluded(sourceName)) continue;
        if (sourceRows.length === 0) continue;
        const enumColSet = new Set(sourceMeta.enumColumns);
        for (const {path: fieldPath, inList} of mergedIdFields(sourceName).values()) {
            if (isClaimed(sourceName, fieldPath)) continue;
            const leafKey = leafOf(fieldPath);
            if (enumColSet.has(fieldPath) || enumColSet.has(leafKey)) continue;
            if (sourceMeta.primaryKey && fieldPath === sourceMeta.primaryKey) continue;

            const sampleValues = new Set<unknown>();
            for (const row of sourceRows.slice(0, Math.min(50, sourceRows.length))) {
                const val = getNestedValue(row, fieldPath);
                const vals = Array.isArray(val) ? val : [val];
                for (const v of vals) {
                    if (v !== null && v !== undefined && v !== 0 && v !== "") sampleValues.add(v);
                }
            }
            if (sampleValues.size === 0) continue;
            if (
                sampleValues.size <= 6 &&
                [...sampleValues].every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10)
            ) continue;

            const isEntityField = isEntityIdLike(leafKey);
            let bestTarget = "";
            let bestRate = 0;
            for (const [targetName, targetPkSet] of pkSets) {
                if (targetName === sourceName) continue;
                if (isEntityField && /_desc(?:_v\d+)?$/.test(targetName)) continue;
                let matches = 0;
                for (const v of sampleValues) if (targetPkSet.has(v)) matches++;
                const rate = matches / sampleValues.size;
                if (rate > bestRate && rate >= 0.5) {
                    bestRate = rate;
                    bestTarget = targetName;
                }
            }
            if (bestTarget) {
                candidates.push({
                    sourceTable: sourceName,
                    sourceField: fieldPath,
                    targetTable: bestTarget,
                    matchRate: bestRate,
                    sampleSize: sampleValues.size,
                    isList: inList,
                    sourceKind: "static",
                    overrideType: inList ? "listOverrides" : "fkOverrides",
                    configKey: `${sourceName}.${fieldPath}`,
                    configValue: bestTarget,
                    configSnippet: `"${sourceName}.${fieldPath}": "${bestTarget}"`,
                });
            }
        }
    }

    return {mappings, candidates};
}













