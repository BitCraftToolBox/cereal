import {
    Accessor,
    createContext,
    createMemo,
    createResource,
    createSignal,
    ParentComponent,
    Resource,
    useContext,
} from "solid-js";
import {
    type AlgebraicType,
    buildTypeIndexMap,
    DefManifest,
    ForeignKeyMapping,
    getColumnTypeElement,
    SpacetimeDBSchema,
    TableMeta,
} from "./schema";

// Re-export a patched TableMeta type where enumValues is the resolved string[] form
export type ResolvedTableMeta = Omit<TableMeta, "enumValues"> & { enumValues: Record<string, string[]> };

// --- Types ---

export interface TableIndex {
    name: string;
    meta: ResolvedTableMeta;
}

/** A single entry in public/defs/versions.json */
export interface VersionEntry {
    hash: string;
    label: string;
    date: string;
}

export interface DataStore {
    tableNames: Resource<string[]>;
    tableIndex: Resource<TableIndex[]>;
    fetchTable: (name: string) => Promise<Record<string, unknown>[]>;
    getTable: (name: string) => Record<string, unknown>[] | undefined;
    getTableMeta: (name: string) => ResolvedTableMeta | undefined;
    foreignKeys: Resource<ForeignKeyMapping[]>;
    getOutgoingRefs: (tableName: string) => ForeignKeyMapping[];
    getIncomingRefs: (tableName: string) => ForeignKeyMapping[];
    /** Resolve a named enum from the manifest to its variant list */
    getEnum: (name: string) => string[] | undefined;
    /** Return the raw AlgebraicType for a table column. */
    getColumnType: (tableName: string, columnName: string) => AlgebraicType | undefined;
    /** Return a context object for rendering AlgebraicTypeView, or undefined while schema is loading. */
    getTypeContext: () => { schema: SpacetimeDBSchema; idxMap: Map<number, string> } | undefined;
    /**
     * Return the cached display-name map for a table (pk → label), or undefined if not yet loaded.
     * Reactive: memos that call this will re-run when new tables finish loading.
     */
    getDisplayNames: (tableName: string) => Map<string, string> | undefined;
    /** The raw SpacetimeDB schema */
    schema: Resource<SpacetimeDBSchema | null>;
    versions: Resource<VersionEntry[]>;
    version: Accessor<string>;
    setVersion: (v: string) => void;
}

/** Returns true if a table name represents static (desc) game data that has a data file. */
export function isStaticTable(name: string): boolean {
    return /_desc(_v\d+)?$/.test(name) || name === "claim_tile_cost";
}

const DataContext = createContext<DataStore>();

// --- Provider ---

export const DataProvider: ParentComponent = (props) => {
    const [version, setVersion] = createSignal("latest");
    const tableCache = new Map<string, Record<string, unknown>[]>();
    const displayNameCache = new Map<string, Map<string, string>>();
    const [displayNameVersion, setDisplayNameVersion] = createSignal(0);

    // Fetch the pre-computed definition manifest for the current version.
    // Always resolves (returns null on error) so downstream resources don't hang.
    const [manifest] = createResource(version, async (ver): Promise<DefManifest | null> => {
        try {
            const res = await fetch(`/defs/${ver}.json`);
            if (!res.ok) throw new Error(res.statusText);
            return await res.json() as Promise<DefManifest>;
        } catch (e) {
            console.warn(`[cereal] Could not load manifest for version "${ver}":`, e);
            return null;
        }
    });

    // Derived resources.
    // Source wraps manifest in an object so it's always truthy once manifest settles —
    // returning undefined (not null) while still loading keeps the resource pending correctly.
    const settled = () => {
        const m = manifest();
        return m !== undefined ? {m} : undefined;
    };

    const [tableIndex] = createResource(
        settled,
        ({m}): TableIndex[] => {
            if (!m) return [];
            const enumMap = new Map((m.enums ?? []).map((e) => [e.name, e.values]));
            return [...m.tables]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((meta) => {
                    const resolvedEnumValues: Record<string, string[]> = {};
                    for (const [col, enumName] of Object.entries(meta.enumValues)) {
                        const variants = enumMap.get(enumName);
                        if (variants) resolvedEnumValues[col] = variants;
                    }
                    return {name: meta.name, meta: {...meta, enumValues: resolvedEnumValues}};
                });
        },
    );

    const [tableNames] = createResource(
        settled,
        ({m}): string[] => {
            if (!m) return [];
            return [...m.tables].sort((a, b) => a.name.localeCompare(b.name)).map((t) => t.name);
        },
    );

    const [foreignKeys] = createResource(
        settled,
        ({m}): ForeignKeyMapping[] => m?.foreignKeys ?? [],
    );

    // SpacetimeDB schema — fetched once (version-independent for now)
    const [schema] = createResource(async (): Promise<SpacetimeDBSchema | null> => {
        try {
            const res = await fetch(`/${version()}/region_schema.json`);
            if (!res.ok) throw new Error(res.statusText);
            return await res.json() as Promise<SpacetimeDBSchema>;
        } catch (e) {
            console.warn("[cereal] Could not load region_schema.json:", e);
            return null;
        }
    });

    // Memoized type index map — rebuilt when schema loads
    let cachedIdxMap: Map<number, string> | null = null;

    function getIdxMap(): Map<number, string> | null {
        const s = schema();
        if (!s) return null;
        if (!cachedIdxMap) cachedIdxMap = buildTypeIndexMap(s);
        return cachedIdxMap;
    }

    function getColumnType(tableName: string, columnName: string): AlgebraicType | undefined {
        const s = schema();
        if (!s) return undefined;
        return getColumnTypeElement(tableName, columnName, s);
    }

    function getTypeContext(): { schema: SpacetimeDBSchema; idxMap: Map<number, string> } | undefined {
        const s = schema();
        const idxMap = getIdxMap();
        if (!s || !idxMap) return undefined;
        return {schema: s, idxMap};
    }

    // Available versions list (fetched once)
    const [versions] = createResource(async (): Promise<VersionEntry[]> => {
        try {
            const res = await fetch("/defs/versions.json");
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        } catch (e) {
            console.warn("[cereal] Could not load versions.json:", e);
            return [];
        }
    });

    const outgoingRefsMap = createMemo(() => {
        const map = new Map<string, ForeignKeyMapping[]>();
        for (const fk of foreignKeys() ?? []) {
            const list = map.get(fk.sourceTable);
            if (list) list.push(fk);
            else map.set(fk.sourceTable, [fk]);
        }
        return map;
    });

    const incomingRefsMap = createMemo(() => {
        const map = new Map<string, ForeignKeyMapping[]>();
        const addToMap = (target: string, fk: ForeignKeyMapping) => {
            const list = map.get(target);
            if (list) {
                if (!list.includes(fk)) list.push(fk);
            } else map.set(target, [fk]);
        };
        for (const fk of foreignKeys() ?? []) {
            addToMap(fk.targetTable, fk);
            // Also index by each conditional target table so those tables show incoming refs
            for (const cond of fk.conditionalTargets ?? []) {
                if (cond.targetTable && cond.targetTable !== fk.targetTable) {
                    addToMap(cond.targetTable, fk);
                }
            }
        }
        return map;
    });

    function getEnum(name: string): string[] | undefined {
        return manifest()?.enums?.find((e) => e.name === name)?.values;
    }

    function getTableMeta(name: string): ResolvedTableMeta | undefined {
        const m = manifest();
        const meta = m?.tables.find((t) => t.name === name);
        if (!meta) return undefined;
        // Resolve column->enumName to column->variants[]
        const enumMap = new Map((m!.enums ?? []).map((e) => [e.name, e.values]));
        const resolvedEnumValues: Record<string, string[]> = {};
        for (const [col, enumName] of Object.entries(meta.enumValues)) {
            const variants = enumMap.get(enumName);
            if (variants) resolvedEnumValues[col] = variants;
        }
        return {...meta, enumValues: resolvedEnumValues};
    }

    async function fetchTable(name: string): Promise<Record<string, unknown>[]> {
        if (tableCache.has(name)) return tableCache.get(name)!;
        let res: Response;
        try {
            res = await fetch(`/${version()}/static/${name}.json`);
        } catch (e) {
            const msg = `[cereal] Network error fetching table "${name}": ${e}`;
            console.error(msg);
            throw new Error(msg);
        }
        if (!res.ok) {
            const msg = `[cereal] HTTP ${res.status} fetching table "${name}"`;
            console.error(msg);
            throw new Error(msg);
        }
        let rows: Record<string, unknown>[];
        try {
            rows = (await res.json()) as Record<string, unknown>[];
        } catch (e) {
            const msg = `[cereal] Failed to parse JSON for table "${name}": ${e}`;
            console.error(msg);
            throw new Error(msg);
        }
        tableCache.set(name, rows);
        // Build display name map for this table if it has a displayField
        const meta = getTableMeta(name);
        if (meta?.primaryKey && meta.displayField) {
            const map = new Map<string, string>();
            for (const row of rows) {
                const pk = String(row[meta.primaryKey]);
                const label = row[meta.displayField];
                if (label) map.set(pk, String(label));
            }
            displayNameCache.set(name, map);
            setDisplayNameVersion((v) => v + 1);

            // Special case: crafting_recipe_desc names contain {0} (output) and {1} (input)
            // format params that need to be resolved to actual item/cargo names.
            if (name === "crafting_recipe_desc") {
                resolveCraftingRecipeNames(rows, meta.primaryKey, map).then(() => {
                    setDisplayNameVersion((v) => v + 1);
                }).catch(() => {/* non-fatal */});
            }
        }
        return rows;
    }

    /**
     * Resolves {0} (first output) and {1} (first input) placeholders in
     * crafting_recipe_desc display names by looking up item_desc/cargo_desc.
     * Mutates the provided `map` in place and is called async after the initial
     * map is already cached, so the reactive signal is bumped again when done.
     */
    async function resolveCraftingRecipeNames(
        rows: Record<string, unknown>[],
        primaryKey: string,
        map: Map<string, string>,
    ) {
        const [itemRows, cargoRows] = await Promise.all([
            fetchTable("item_desc").catch(() => [] as Record<string, unknown>[]),
            fetchTable("cargo_desc").catch(() => [] as Record<string, unknown>[]),
        ]);

        const itemMeta = getTableMeta("item_desc");
        const cargoMeta = getTableMeta("cargo_desc");

        const itemById = new Map<string, string>();
        for (const r of itemRows) {
            if (itemMeta?.primaryKey && itemMeta.displayField) {
                const pk = String(r[itemMeta.primaryKey]);
                const label = r[itemMeta.displayField];
                if (label) itemById.set(pk, String(label));
            }
        }
        const cargoById = new Map<string, string>();
        for (const r of cargoRows) {
            if (cargoMeta?.primaryKey && cargoMeta.displayField) {
                const pk = String(r[cargoMeta.primaryKey]);
                const label = r[cargoMeta.displayField];
                if (label) cargoById.set(pk, String(label));
            }
        }

        const lookupStack = (stack: unknown): string | undefined => {
            if (!stack || typeof stack !== "object" || Array.isArray(stack)) return undefined;
            const s = stack as Record<string, unknown>;
            const id = String(s["item_id"] ?? "");
            const type = String(s["item_type"] ?? "");
            return type === "Cargo" ? cargoById.get(id) : itemById.get(id);
        };

        for (const row of rows) {
            const template = map.get(String(row[primaryKey]));
            if (!template || (!template.includes("{0}") && !template.includes("{1}"))) continue;

            const crafted = row["crafted_item_stacks"];
            const consumed = row["consumed_item_stacks"];
            const output = Array.isArray(crafted) ? crafted[0] : crafted;
            const input = Array.isArray(consumed) ? consumed[0] : consumed;

            const resolved = template
                .replace("{0}", lookupStack(output) ?? "{0}")
                .replace("{1}", lookupStack(input) ?? "{1}");

            map.set(String(row[primaryKey]), resolved);
        }
    }

    const store: DataStore = {
        tableNames,
        tableIndex,
        fetchTable,
        getTable: (name) => tableCache.get(name),
        getTableMeta,
        foreignKeys,
        getOutgoingRefs: (tableName) => outgoingRefsMap().get(tableName) ?? [],
        getIncomingRefs: (tableName) => incomingRefsMap().get(tableName) ?? [],
        getEnum,
        getColumnType,
        getTypeContext,
        getDisplayNames: (name: string) => {
            displayNameVersion(); // reactive dependency — re-runs callers when any table loads
            return displayNameCache.get(name);
        },
        schema,
        versions,
        version,
        setVersion,
    };

    return <DataContext.Provider value={store}>{props.children}</DataContext.Provider>;
};

export function useData() {
    const ctx = useContext(DataContext);
    if (!ctx) throw new Error("useData must be used within DataProvider");
    return ctx;
}
