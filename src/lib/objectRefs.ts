/**
 * Shared reactive primitives and pure helpers for object-level FK resolution.
 * Used by both the object view and object graph routes.
 */

import {type Accessor, createEffect, createMemo, createResource} from "solid-js";
import {type DataStore, isStaticTable, type ResolvedTableMeta} from "~/lib/data";
import {type ForeignKeyMapping, allTargetTables, getNestedValue, resolveTargetTable, resolveTargetTableWithCondition} from "~/lib/schema";

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Walk `obj` following `path` segments, collecting all plain objects at the leaf.
 * Traverses arrays at every level (flatMap), so it handles lists-of-objects correctly.
 */
export function collectContainers(obj: unknown, path: string[]): Record<string, unknown>[] {
    if (path.length === 0) {
        if (Array.isArray(obj))
            return obj.filter(
                (el) => el !== null && typeof el === "object" && !Array.isArray(el)
            ) as Record<string, unknown>[];
        return obj !== null && typeof obj === "object" && !Array.isArray(obj)
            ? [obj as Record<string, unknown>]
            : [];
    }
    const [head, ...rest] = path;
    if (Array.isArray(obj)) return obj.flatMap((item) => collectContainers(item, path));
    if (obj !== null && typeof obj === "object")
        return collectContainers((obj as Record<string, unknown>)[head], rest);
    return [];
}

export function valueMatchesNeedle(v: unknown, needle: string): boolean {
    if (Array.isArray(v)) return v.some((x) => valueMatchesNeedle(x, needle));
    if (v !== null && typeof v === "object") return false;
    return String(v ?? "").toLowerCase() === needle;
}

export function rowMatchesField(
    row: Record<string, unknown>,
    parts: string[],
    needle: string,
): boolean {
    const [head, ...rest] = parts;
    const val = row[head];
    if (rest.length === 0) return valueMatchesNeedle(val, needle);
    if (Array.isArray(val))
        return val.some((item) =>
            item !== null && typeof item === "object"
                ? rowMatchesField(item as Record<string, unknown>, rest, needle)
                : false
        );
    if (val !== null && typeof val === "object")
        return rowMatchesField(val as Record<string, unknown>, rest, needle);
    return false;
}

// ── Object row ────────────────────────────────────────────────────────────────

/**
 * Returns basic row/meta/displayName accessors for a single object page.
 * `tableName` and `objectId` should be reactive accessors (e.g. `() => params.name`).
 */
export function createObjectRow(
    tableName: Accessor<string>,
    objectId: Accessor<string>,
    data: DataStore,
) {
    const meta = () => data.getTableMeta(tableName());

    const isFetchable = createMemo(() => {
        const m = meta();
        if (!m) return false;
        return isStaticTable(tableName()) && (m.isPublic ?? true);
    });

    const [rows] = createResource(
        () => isFetchable() ? {tag: data.tag(), name: tableName()} : null,
        (s) => data.fetchTableFor(s.tag, s.name),
    );

    const row = createMemo(() => {
        const r = rows();
        const m = meta();
        if (!r || !m?.primaryKey) return undefined;
        const id = decodeURIComponent(objectId());
        return r.find((obj) => String(obj[m.primaryKey!]) === id);
    });

    const displayName = createMemo(() => {
        const r = row();
        const m = meta();
        const id = objectId();
        const name = tableName();
        // early reactive tracking
        const nameMap = data.getDisplayNames(name);
        if (!r || !m) return `${name} #${id}`;
        const pk = String(r[m.primaryKey!] ?? id);
        const cached = nameMap?.get(pk);
        if (cached) return cached;
        return `${name} #${pk}`;
    });

    return {meta, isFetchable, rows, row, displayName};
}

// ── Unified ref result ────────────────────────────────────────────────────────

/**
 * A resolved reference group: a field on `table` that points to (or from, for
 * incoming refs) the current object.  `ids` are the *other* objects' PKs as strings.
 */
export interface RefResult {
    /** FK field path (e.g. "consumed_items.item_stack.item_id") */
    field: string;
    /**
     * For outgoing: the target table.
     * For incoming: the source table (the one that *holds* the FK field).
     */
    table: string;
    /** All resolved / matched row PKs as strings (already de-duplicated per group). */
    ids: string[];
    /** When the target was determined by a conditional sibling field. */
    conditionalFilter?: { field: string; value: string };
}

// ── Outgoing refs ─────────────────────────────────────────────────────────────

/** Internal flat ref before grouping. */
interface OutgoingRef {
    field: string;
    targetTable: string;
    targetId: string;
    conditionalFilter?: { field: string; value: string };
}

function resolveOutgoingRefs(
    r: Record<string, unknown>,
    tableName: string,
    data: DataStore,
): OutgoingRef[] {
    const enumVals = data.getTableMeta(tableName)?.enumValues;

    return data.getOutgoingRefs(tableName).flatMap((fk) => {
        const convertId = (v: unknown): string => {
            if (fk.enumConversion && typeof v === "string") {
                const variants = data.getEnum(fk.enumConversion);
                const idx = variants?.indexOf(v) ?? -1;
                if (idx !== -1) return String(idx);
            }
            return String(v);
        };

        if (!fk.conditionalTargets?.length) {
            const value = getNestedValue(r, fk.sourceField);
            if (value === null || value === undefined || value === 0) return [];
            const ids = Array.isArray(value) ? value : [value];
            return ids
                .filter((v) => v !== null && v !== undefined && v !== 0)
                .map((v) => ({field: fk.sourceField, targetTable: fk.targetTable, targetId: convertId(v)} as OutgoingRef));
        }

        const fieldParts = fk.sourceField.split(".");
        const leafField = fieldParts[fieldParts.length - 1];
        const containers = fieldParts.length > 1 ? collectContainers(r, fieldParts.slice(0, -1)) : [r];

        return containers.flatMap((ctx) => {
            const id = ctx[leafField];
            if (id === null || id === undefined || id === 0) return [];
            const {targetTable, conditionalFilter} = resolveTargetTableWithCondition(fk, ctx, enumVals);
            if (!targetTable) return [];
            return [{field: fk.sourceField, targetTable, targetId: convertId(id), conditionalFilter}] as OutgoingRef[];
        });
    });
}

/**
 * Groups outgoing FK refs into `RefResult[]`, one entry per unique
 * (field, targetTable, conditionalFilter) combination.
 */
export function createOutgoingResults(
    row: Accessor<Record<string, unknown> | undefined>,
    tableName: Accessor<string>,
    data: DataStore,
): Accessor<RefResult[]> {
    return createMemo(() => {
        const r = row();
        if (!r) return [];
        const groups = new Map<string, RefResult>();
        for (const ref of resolveOutgoingRefs(r, tableName(), data)) {
            const key = `${ref.field}::${ref.targetTable}::${ref.conditionalFilter?.value ?? ""}`;
            const existing = groups.get(key);
            if (existing) existing.ids.push(ref.targetId);
            else groups.set(key, {
                field: ref.field,
                table: ref.targetTable,
                conditionalFilter: ref.conditionalFilter,
                ids: [ref.targetId],
            });
        }
        return [...groups.values()];
    });
}

// ── Incoming refs ─────────────────────────────────────────────────────────────

/**
 * Fetches every source table that holds an FK pointing at `tableName()` / current
 * row, counts matches, and returns one `RefResult` per (sourceTable, sourceField)
 * pair that has at least one match.
 *
 * Also triggers `data.fetchTable` for each source table so that
 * `data.getDisplayNames(sourceTable)` becomes available reactively.
 */
export function createIncomingResults(
    row: Accessor<Record<string, unknown> | undefined>,
    meta: Accessor<ResolvedTableMeta | undefined>,
    tableName: Accessor<string>,
    data: DataStore,
): Accessor<RefResult[]> {
    // Build (fk, pkValue, conditionalFilter) specs once the row is known
    const specs = createMemo(() => {
        const r = row();
        const m = meta();
        if (!r || !m?.primaryKey) return [];

        return data.getIncomingRefs(tableName()).map((fk) => {
            const rawPk = r[m.primaryKey!];
            let pkValue: unknown = rawPk;
            if (fk.enumConversion && typeof rawPk === "number") {
                const variants = data.getEnum(fk.enumConversion);
                if (variants && rawPk < variants.length) pkValue = variants[rawPk];
            }
            let conditionalFilter: { field: string; value: string } | undefined;
            if (fk.conditionalTargets?.length) {
                const cond = fk.conditionalTargets.find((c) => c.targetTable === tableName());
                if (cond) conditionalFilter = {field: cond.whenField, value: cond.whenValue};
            }
            return {fk, pkValue, conditionalFilter};
        });
    });

    const fetchableTables = createMemo(() =>
        [...new Set(specs().map((s) => s.fk.sourceTable))].filter((t) => {
            const m = data.getTableMeta(t);
            return m !== undefined && isStaticTable(t) && (m.isPublic ?? true);
        }),
    );

    const [tableData] = createResource(
        () => {
            const t = fetchableTables().join(",");
            return t ? {tag: data.tag(), tables: fetchableTables()} : null;
        },
        async (s) => {
            const pairs = await Promise.all(
                s.tables.map((t) => data.fetchTableFor(s.tag, t).then((rows) => [t, rows] as const)),
            );
            return new Map(pairs);
        },
    );

    return createMemo((): RefResult[] => {
        const fetched = tableData();
        if (!fetched) return [];
        const tname = tableName();
        const out: RefResult[] = [];

        for (const {fk, pkValue, conditionalFilter} of specs()) {
            const rows = fetched.get(fk.sourceTable);
            if (!rows) continue;

            const needle = String(pkValue).toLowerCase();
            const fieldParts = fk.sourceField.split(".");
            const srcMeta = data.getTableMeta(fk.sourceTable);
            const srcEnumVals = srcMeta?.enumValues;
            const hasConditional = !!fk.conditionalTargets?.length;
            const leafField = fieldParts[fieldParts.length - 1];

            const fkForResolve: ForeignKeyMapping | undefined = hasConditional ? {
                sourceTable: fk.sourceTable,
                sourceField: fk.sourceField,
                targetTable: fk.targetTable,
                conditionalTargets: fk.conditionalTargets,
                enumConversion: fk.enumConversion,
            } : undefined;

            const matched = rows.filter((row) => {
                if (!hasConditional) return rowMatchesField(row, fieldParts, needle);
                const containers = fieldParts.length > 1
                    ? collectContainers(row, fieldParts.slice(0, -1))
                    : [row];
                return containers.some((ctx) => {
                    const id = ctx[leafField];
                    if (id === null || id === undefined) return false;
                    if (String(id).toLowerCase() !== needle) return false;
                    return resolveTargetTable(fkForResolve!, ctx, srcEnumVals) === tname;
                });
            });

            if (matched.length === 0) continue;

            const ids = matched.map((m) =>
                srcMeta?.primaryKey ? String(m[srcMeta.primaryKey]) : "?"
            );
            out.push({field: fk.sourceField, table: fk.sourceTable, ids, conditionalFilter});
        }
        return out;
    });
}

// ── Display names ─────────────────────────────────────────────────────────────

/** Map from tableName → (pk → display label) */
export type DisplayNameMap = Map<string, Map<string, string>>;

/**
 * Triggers fetches for the given table list and builds a DisplayNameMap from the
 * shared per-table display name cache in the DataStore.
 * Tables that appear in multiple call sites share a single cached Map — no duplication.
 */
export function createDisplayNameMap(
    tableList: Accessor<string[]>,
    data: DataStore,
): { displayNames: Accessor<DisplayNameMap> } {
    createEffect(() => {
        const ver = data.tag();
        for (const t of tableList()) data.fetchTableFor(ver, t).catch(() => {});
    });

    const displayNames = createMemo((): DisplayNameMap => {
        const out: DisplayNameMap = new Map();
        for (const t of tableList()) {
            const names = data.getDisplayNames(t);
            if (names) out.set(t, names);
        }
        return out;
    });

    return {displayNames};
}

/**
 * Returns the tables that should be fetched for display names on an object view page:
 * all outgoing FK target tables (including conditional targets) that have a displayField.
 */
export function outgoingDisplayTables(tableName: string, data: DataStore): string[] {
    const tables = new Set<string>();
    for (const fk of data.getOutgoingRefs(tableName)) {
        for (const t of allTargetTables(fk)) {
            const m = data.getTableMeta(t);
            if (m?.displayField && isStaticTable(t) && (m.isPublic ?? true)) tables.add(t);
        }
    }
    return [...tables];
}

/**
 * Returns the tables that should be fetched for display names on an object graph page:
 * the center table itself plus all outgoing and incoming FK tables with a displayField.
 */
export function allDisplayTables(tableName: string, data: DataStore): string[] {
    const tables = new Set<string>([tableName]);
    for (const fk of data.getOutgoingRefs(tableName)) {
        for (const t of allTargetTables(fk)) tables.add(t);
    }
    for (const fk of data.getIncomingRefs(tableName)) {
        tables.add(fk.sourceTable);
    }
    return [...tables].filter((t) => {
        const m = data.getTableMeta(t);
        return m?.displayField && isStaticTable(t) && (m.isPublic ?? true);
    });
}

/** Builds the fkMap for the JsonViewer component. */
export function buildFkMap(
    fks: ForeignKeyMapping[],
): Map<string, {
    targetTable: string;
    conditionalTargets?: ForeignKeyMapping["conditionalTargets"];
    enumConversion?: string;
}> {
    return new Map(fks.map((fk) => [
        fk.sourceField,
        {targetTable: fk.targetTable, conditionalTargets: fk.conditionalTargets, enumConversion: fk.enumConversion},
    ]));
}
