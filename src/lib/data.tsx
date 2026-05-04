import {
    Accessor,
    createContext,
    createEffect,
    createMemo,
    createResource,
    createSignal,
    ParentComponent,
    Resource,
    untrack,
    useContext,
} from "solid-js";
import {useLocation, useSearchParams} from "@solidjs/router";
import {
    type AlgebraicType,
    buildTypeIndexMap,
    type DefManifest,
    type ForeignKeyMapping,
    getColumnTypeElement,
    type SearchIndex,
    type SpacetimeDBSchema,
    type TableMeta,
    type VersionEntry,
} from "./schema";
import {DATA_CDN_BASE} from "./constants";

export type ResolvedTableMeta = Omit<TableMeta, "enumValues"> & {
    enumValues: Record<string, string[]>;
};

export interface TableIndex {
    name: string;
    meta: ResolvedTableMeta;
}

export interface DataStore {
    tableIndex: Resource<TableIndex[]>;
    fetchTable: (name: string) => Promise<Record<string, unknown>[]>;
    getTable: (name: string) => Record<string, unknown>[] | undefined;
    getTableMeta: (name: string) => ResolvedTableMeta | undefined;
    foreignKeys: Resource<ForeignKeyMapping[]>;
    getOutgoingRefs: (tableName: string) => ForeignKeyMapping[];
    getIncomingRefs: (tableName: string) => ForeignKeyMapping[];
    getEnum: (name: string) => string[] | undefined;
    getColumnType: (tableName: string, columnName: string) => AlgebraicType | undefined;
    getTypeContext: () => { schema: SpacetimeDBSchema; idxMap: Map<number, string> } | undefined;
    getDisplayNames: (tableName: string) => Map<string, string> | undefined;
    schema: Resource<SpacetimeDBSchema | null>;
    searchIndex: Resource<SearchIndex | null>;
    tag: Accessor<string>;
}

export function isStaticTable(name: string): boolean {
    return /_desc(_v\d+)?$/.test(name) || name === "claim_tile_cost";
}

interface VersionCaches {
    manifests: Map<string, DefManifest | null>;
    schemas: Map<string, SpacetimeDBSchema | null>;
    idxMaps: Map<string, Map<number, string> | null>;
    /** tag → tableName → rows */
    tables: Map<string, Map<string, Record<string, unknown>[]>>;
    /** tag → tableName → pk → label */
    displayNames: Map<string, Map<string, Map<string, string>>>;
    displayNameVersion: Accessor<number>;
    bumpDisplayNameVersion: () => void;
    /** Search index cache: tag → SearchIndex */
    searchIndexes: Map<string, SearchIndex | null>;
    /** Deduplication: in-flight fetches for manifests and schemas */
    inFlightManifests: Map<string, Promise<DefManifest | null>>;
    inFlightSchemas: Map<string, Promise<SpacetimeDBSchema | null>>;
    inFlightSearches: Map<string, Promise<SearchIndex | null>>;
}

interface DataRegistry {
    versions: Resource<VersionEntry[]>;
    createVersionedStore: (tagSignal: Accessor<string>) => DataStore;
}

export const DataRegistryContext = createContext<DataRegistry>();

interface DataScope {
    store: DataStore;
    tag: Accessor<string>;
    setTag: (tag: string) => void;
    versions: Resource<VersionEntry[]>;
}

export const DataScopeContext = createContext<DataScope>();

export const DataProvider: ParentComponent = (props) => {
    const [versions] = createResource(async (): Promise<VersionEntry[]> => {
        try {
            const res = await fetch(`${DATA_CDN_BASE}/versions.json`);
            if (!res.ok) throw new Error(res.statusText);
            const raw = await res.json() as VersionEntry[];
            return raw.map((v) => ({
                tag: v.tag,
                label: v.label,
                description: v.description,
            }));
        } catch (e) {
            console.warn("[cereal] Could not load versions.json:", e);
            return [];
        }
    });

    const [displayNameVersion, setDisplayNameVersion] = createSignal(0);
    const caches: VersionCaches = {
        manifests: new Map(),
        schemas: new Map(),
        idxMaps: new Map(),
        tables: new Map(),
        displayNames: new Map(),
        displayNameVersion,
        bumpDisplayNameVersion: () => setDisplayNameVersion((v) => v + 1),
        searchIndexes: new Map(),
        inFlightManifests: new Map(),
        inFlightSchemas: new Map(),
        inFlightSearches: new Map(),
    };

    function createVersionedStore(tagSignal: Accessor<string>): DataStore {
        const [manifest] = createResource(tagSignal, async (ver): Promise<DefManifest | null> => {
            // "__pending__" is the placeholder before real versions load — skip fetching
            if (!ver || ver === "__pending__") return null;
            if (caches.manifests.has(ver)) return caches.manifests.get(ver)!;
            // Deduplicate concurrent fetches for the same version
            if (caches.inFlightManifests.has(ver)) return caches.inFlightManifests.get(ver)!;
            const promise = (async () => {
                try {
                    const res = await fetch(`${DATA_CDN_BASE}/data/${ver}/version_${ver}.json`);
                    if (!res.ok) throw new Error(res.statusText);
                    const m = await res.json() as DefManifest;
                    caches.manifests.set(ver, m);
                    return m;
                } catch (e) {
                    console.warn(`[cereal] Could not load manifest for "${ver}":`, e);
                    caches.manifests.set(ver, null);
                    return null;
                } finally {
                    caches.inFlightManifests.delete(ver);
                }
            })();
            caches.inFlightManifests.set(ver, promise);
            return promise;
        });

        const [schema] = createResource(tagSignal, async (ver): Promise<SpacetimeDBSchema | null> => {
            if (!ver || ver === "__pending__") return null;
            if (caches.schemas.has(ver)) return caches.schemas.get(ver)!;
            if (caches.inFlightSchemas.has(ver)) return caches.inFlightSchemas.get(ver)!;
            const promise = (async () => {
                try {
                    const res = await fetch(`${DATA_CDN_BASE}/data/${ver}/region_schema.json`);
                    if (!res.ok) throw new Error(res.statusText);
                    const s = await res.json() as SpacetimeDBSchema;
                    caches.schemas.set(ver, s);
                    return s;
                } catch (e) {
                    console.warn("[cereal] Could not load region_schema.json:", e);
                    caches.schemas.set(ver, null);
                    return null;
                } finally {
                    caches.inFlightSchemas.delete(ver);
                }
            })();
            caches.inFlightSchemas.set(ver, promise);
            return promise;
        });

        const settled = () => { const m = manifest(); return m !== undefined ? {m} : undefined; };

        const [searchIndex] = createResource(tagSignal, async (ver): Promise<SearchIndex | null> => {
            if (!ver || ver === "__pending__") return null;
            if (caches.searchIndexes.has(ver)) return caches.searchIndexes.get(ver)!;
            if (caches.inFlightSearches.has(ver)) return caches.inFlightSearches.get(ver)!;
            const promise = (async () => {
                try {
                    const res = await fetch(`${DATA_CDN_BASE}/data/${ver}/search_${ver}.json`);
                    if (!res.ok) throw new Error(res.statusText);
                    const idx = await res.json() as SearchIndex;
                    caches.searchIndexes.set(ver, idx);
                    return idx;
                } catch (e) {
                    console.warn(`[cereal] Could not load search index for "${ver}":`, e);
                    caches.searchIndexes.set(ver, null);
                    return null;
                } finally {
                    caches.inFlightSearches.delete(ver);
                }
            })();
            caches.inFlightSearches.set(ver, promise);
            return promise;
        });

        const [tableIndex] = createResource(settled, ({m}): TableIndex[] => {
            if (!m) return [];
            const enumMap = new Map((m.enums ?? []).map((e) => [e.name, e.values]));
            return [...m.tables].sort((a, b) => a.name.localeCompare(b.name)).map((meta) => {
                const ev: Record<string, string[]> = {};
                for (const [col, enumName] of Object.entries(meta.enumValues)) {
                    const v = enumMap.get(enumName);
                    if (v) ev[col] = v;
                }
                return {name: meta.name, meta: {...meta, enumValues: ev}};
            });
        });

        const [foreignKeys] = createResource(settled, ({m}): ForeignKeyMapping[] => m?.foreignKeys ?? []);

        function getIdxMap(): Map<number, string> | null {
            const ver = tagSignal();
            if (caches.idxMaps.has(ver)) return caches.idxMaps.get(ver)!;
            const s = schema();
            if (!s) return null;
            const map = buildTypeIndexMap(s);
            caches.idxMaps.set(ver, map);
            return map;
        }

        function resolveEnumValues(meta: TableMeta): Record<string, string[]> {
            const m = manifest();
            if (!m) return {};
            const enumMap = new Map((m.enums ?? []).map((e) => [e.name, e.values]));
            const ev: Record<string, string[]> = {};
            for (const [col, enumName] of Object.entries(meta.enumValues)) {
                const v = enumMap.get(enumName);
                if (v) ev[col] = v;
            }
            return ev;
        }

        function getTableMeta(name: string): ResolvedTableMeta | undefined {
            const m = manifest();
            const meta = m?.tables.find((t) => t.name === name);
            if (!meta) return undefined;
            return {...meta, enumValues: resolveEnumValues(meta)};
        }

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
            const add = (target: string, fk: ForeignKeyMapping) => {
                const list = map.get(target);
                if (list) { if (!list.includes(fk)) list.push(fk); } else map.set(target, [fk]);
            };
            for (const fk of foreignKeys() ?? []) {
                add(fk.targetTable, fk);
                for (const cond of fk.conditionalTargets ?? []) {
                    if (cond.targetTable && cond.targetTable !== fk.targetTable)
                        add(cond.targetTable, fk);
                }
            }
            return map;
        });

        async function fetchTable(name: string): Promise<Record<string, unknown>[]> {
            const ver = tagSignal();
            let vCache = caches.tables.get(ver);
            if (!vCache) { vCache = new Map(); caches.tables.set(ver, vCache); }
            if (vCache.has(name)) return vCache.get(name)!;

            let res: Response;
            try {
                res = await fetch(`${DATA_CDN_BASE}/data/${ver}/static/${name}.json`);
            } catch (e) {
                throw new Error(`[cereal] Network error fetching "${name}": ${e}`);
            }
            if (!res.ok) throw new Error(`[cereal] HTTP ${res.status} fetching "${name}"`);

            let rows: Record<string, unknown>[];
            try {
                rows = (await res.json()) as Record<string, unknown>[];
            } catch (e) {
                throw new Error(`[cereal] Failed to parse JSON for "${name}": ${e}`);
            }
            vCache.set(name, rows);

            const meta = getTableMeta(name);
            if (meta?.primaryKey && meta.displayField) {
                let dnVersionMap = caches.displayNames.get(ver);
                if (!dnVersionMap) { dnVersionMap = new Map(); caches.displayNames.set(ver, dnVersionMap); }
                const map = new Map<string, string>();
                for (const row of rows) {
                    const pk = String(row[meta.primaryKey]);
                    const label = row[meta.displayField];
                    if (label) map.set(pk, String(label));
                }
                dnVersionMap.set(name, map);
                caches.bumpDisplayNameVersion();

                if (name === "crafting_recipe_desc") {
                    resolveCraftingRecipeNames(ver, rows, meta.primaryKey, map)
                        .then(() => caches.bumpDisplayNameVersion())
                        .catch(() => {/* non-fatal */});
                }
            }
            return rows;
        }

        async function resolveCraftingRecipeNames(
            ver: string,
            rows: Record<string, unknown>[],
            primaryKey: string,
            map: Map<string, string>,
        ) {
            await Promise.all([fetchTable("item_desc").catch(() => []), fetchTable("cargo_desc").catch(() => [])]);
            const dnVer = caches.displayNames.get(ver);
            const itemById = dnVer?.get("item_desc") ?? new Map<string, string>();
            const cargoById = dnVer?.get("cargo_desc") ?? new Map<string, string>();

            const lookupStack = (stack: unknown): string | undefined => {
                if (!stack || typeof stack !== "object" || Array.isArray(stack)) return undefined;
                const s = stack as Record<string, unknown>;
                const id = String(s["item_id"] ?? "");
                return String(s["item_type"] ?? "") === "Cargo" ? cargoById.get(id) : itemById.get(id);
            };

            for (const row of rows) {
                const template = map.get(String(row[primaryKey]));
                if (!template || (!template.includes("{0}") && !template.includes("{1}"))) continue;
                const crafted = row["crafted_item_stacks"];
                const consumed = row["consumed_item_stacks"];
                map.set(String(row[primaryKey]), template
                    .replace("{0}", lookupStack(Array.isArray(crafted) ? crafted[0] : crafted) ?? "{0}")
                    .replace("{1}", lookupStack(Array.isArray(consumed) ? consumed[0] : consumed) ?? "{1}"));
            }
        }

        return {
            tableIndex,
            fetchTable,
            getTable: (name) => caches.tables.get(tagSignal())?.get(name),
            getTableMeta,
            foreignKeys,
            getOutgoingRefs: (t) => outgoingRefsMap().get(t) ?? [],
            getIncomingRefs: (t) => incomingRefsMap().get(t) ?? [],
            getEnum: (name) => manifest()?.enums?.find((e) => e.name === name)?.values,
            getColumnType: (tableName, columnName) => {
                const s = schema();
                return s ? getColumnTypeElement(tableName, columnName, s) : undefined;
            },
            getTypeContext: () => {
                const s = schema();
                const idxMap = getIdxMap();
                return s && idxMap ? {schema: s, idxMap} : undefined;
            },
            getDisplayNames: (name: string) => {
                caches.displayNameVersion(); // reactive dep
                return caches.displayNames.get(tagSignal())?.get(name);
            },
            schema,
            searchIndex,
            tag: tagSignal,
        };
    }

    return (
        <DataRegistryContext.Provider value={{versions, createVersionedStore}}>
            {props.children}
        </DataRegistryContext.Provider>
    );
};

export interface VersionScopeProviderProps {
    syncUrl?: boolean;
    initialTag?: string;
}

export const VersionScopeProvider: ParentComponent<VersionScopeProviderProps> = (props) => {
    const registry = useContext(DataRegistryContext);
    if (!registry) throw new Error("VersionScopeProvider must be inside DataProvider");

    const [searchParams, setSearchParams] = useSearchParams();
    const location = useLocation();
    const syncUrl = () => props.syncUrl !== false;

    const [tag, setTag] = createSignal<string | null>(props.initialTag ?? null);
    let initialized = false;

    // Don't expose "__pending__" to the store — wait for the real version list
    const resolvedTag: Accessor<string> = () => tag() ?? "__pending__";

    // ── URL→tag: initialize from URL/versions, then react to explicit URL version changes ──
    createEffect(() => {
        if (!syncUrl()) return;
        const vList = registry.versions();
        if (!vList?.length) return;
        const urlTag = (searchParams.version as string | undefined) || undefined;
        const latest = vList[0].tag;

        if (!initialized) {
            initialized = true;
            if (urlTag && vList.some((v) => v.tag === urlTag)) {
                setTag(urlTag);
            } else {
                if (urlTag) setSearchParams({ version: undefined }, { replace: true });
                setTag(latest);
            }
            return;
        }

        // Post-init: update tag only when URL explicitly carries a (different) valid version.
        // When urlTag is absent (e.g. a plain link stripped it), leave tag alone —
        // the tag→URL effect below will add it back.
        const currentTag = untrack(tag);
        if (urlTag && urlTag !== currentTag) {
            if (vList.some((v) => v.tag === urlTag)) {
                setTag(urlTag);
            } else {
                setSearchParams({ version: undefined }, { replace: true });
            }
        }
    });

    // ── tag→URL: after every navigation or tag change, ensure URL version param is correct ──
    // Tracks location.pathname + location.search so it re-runs on every router navigation.
    // Uses setSearchParams (router-owned) so the router never overwrites our change afterward.
    createEffect(() => {
        const currentTag = tag();
        const _path = location.pathname;   // track navigation
        const urlSearch = location.search; // track search param changes

        if (!syncUrl() || !initialized || !currentTag || currentTag === "__pending__") return;

        const vList = untrack(() => registry.versions());
        if (!vList?.length) return;
        const latest = vList[0].tag;

        const urlParams = new URLSearchParams(urlSearch);
        const urlTag = urlParams.get("version") || undefined;

        if (currentTag === latest) {
            if (urlTag) setSearchParams({ version: undefined }, { replace: true });
        } else {
            if (urlTag !== currentTag) setSearchParams({ version: currentTag }, { replace: true });
        }
    });

    const store = registry.createVersionedStore(resolvedTag);

    return (
        <DataScopeContext.Provider value={{store, tag: resolvedTag, setTag, versions: registry.versions}}>
            {props.children}
        </DataScopeContext.Provider>
    );
};

export function useData(): DataStore {
    const ctx = useContext(DataScopeContext);
    if (!ctx) throw new Error("useData must be used within VersionScopeProvider");
    return ctx.store;
}

export function useVersions() {
    const ctx = useContext(DataScopeContext);
    if (!ctx) throw new Error("useVersions must be used within VersionScopeProvider");
    return {
        versions: ctx.versions,
        currentTag: ctx.tag,
        setCurrentTag: ctx.setTag,
    };
}
