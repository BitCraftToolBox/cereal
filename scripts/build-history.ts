/**
 * build-history.ts
 *
 * Computes, for every migration-base "logical" table, the versions at which it actually
 * changed (schema and/or row content) and — for tables with per-version row snapshots — which
 * specific objects changed at each version. This answers "at what versions did object X (or
 * table Y) have changes" without a caller having to fetch every historical version to find out.
 *
 * Reuses the exact same schema/row diff logic as the compare routes (`diffSchema`/`diffTable`
 * in `src/lib/diff.ts`), so a migration that only adds a default-valued column shows up as a
 * table-level schema change without marking every existing row as "changed" — `diffTable`
 * already excludes pure column add/remove from its per-row comparison.
 *
 * Full rebuild every run: cheap at the current version-scale, and side-steps having to
 * invalidate cached diffs when `update-versions.ts --compress-patches` renames/deletes patch
 * folders out from under a previous incremental result.
 *
 * Usage:
 *   tsx scripts/build-history.ts [--root-dir <path>]
 *   e.g. tsx scripts/build-history.ts --root-dir ../cereal-data
 *
 * Writes:
 *   <root>/data/history.json          — base table name -> version-level change entries
 *   <root>/data/history/<base>.json   — per table (row-snapshot tables only), id -> change entries
 */

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    diffSchema,
    diffTable,
    type ObjectHistory,
    type ObjectHistoryEntry,
    type SchemaDiff,
    type TableHistory,
    type TableHistoryEntry,
    type TableHistoryKind,
} from "../src/lib/diff";
import {type AlgebraicType, getColumnTypeElement, type SpacetimeDBSchema, type VersionEntry} from "../src/lib/schema";
import {buildTypeIndexMap} from "../src/lib/schema";
import {type DerivedSchema, deriveSchema} from "../src/lib/schemaDerive";
import {parseJsonLossless} from "./lib/json-lossless";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let dataRoot = path.resolve(__dirname, "..", "public");
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root-dir" && args[i + 1]) {
        dataRoot = path.resolve(args[i + 1]);
        i++;
    }
}

const DATA_DIR = path.join(dataRoot, "data");
const VERSIONS_FILE = path.join(dataRoot, "versions.json");
const HISTORY_FILE = path.join(dataRoot, "history.json");
const HISTORY_DIR = path.join(dataRoot, "history");

/** Same rule the frontend (`src/lib/data.tsx`) uses to decide which tables have row snapshots. */
function isStaticTable(name: string): boolean {
    return /_desc(_v\d+)?$/.test(name) || name === "claim_tile_cost";
}

// ---------------------------------------------------------------------------
// 1. Read versions.json (newest-first) and walk oldest -> newest
// ---------------------------------------------------------------------------
if (!fs.existsSync(VERSIONS_FILE)) {
    console.error(`versions.json not found: ${VERSIONS_FILE}`);
    process.exit(1);
}
const versionManifest = JSON.parse(fs.readFileSync(VERSIONS_FILE, "utf-8")) as VersionEntry[];
const tags = versionManifest.map((v) => v.tag).slice().reverse();
console.log(`Found ${tags.length} versions`);

// ---------------------------------------------------------------------------
// 2. Per-version snapshot loading (schema, eagerly; rows, lazily + cached per snapshot)
// ---------------------------------------------------------------------------
interface Snapshot {
    tag: string;
    schema: SpacetimeDBSchema;
    derived: DerivedSchema;
    idxMap: Map<number, string>;
    rowsByTable: Map<string, Record<string, unknown>[] | null>; // null = not fetchable / missing
}

function loadSnapshot(tag: string): Snapshot | null {
    const schemaFile = path.join(DATA_DIR, tag, "region_schema.json");
    if (!fs.existsSync(schemaFile)) {
        console.warn(`  Skipping ${tag}: no region_schema.json`);
        return null;
    }
    const schema = JSON.parse(fs.readFileSync(schemaFile, "utf-8")) as SpacetimeDBSchema;
    return {
        tag,
        schema,
        derived: deriveSchema(schema),
        idxMap: buildTypeIndexMap(schema),
        rowsByTable: new Map(),
    };
}

/** Lazily fetch + cache a table's rows for one snapshot; null when not a fetchable static table. */
function getRows(snap: Snapshot, tableName: string): Record<string, unknown>[] | null {
    if (snap.rowsByTable.has(tableName)) return snap.rowsByTable.get(tableName)!;
    const dt = snap.derived.tables.get(tableName);
    if (!dt || !isStaticTable(tableName) || !dt.isPublic) {
        snap.rowsByTable.set(tableName, null);
        return null;
    }
    const file = path.join(DATA_DIR, snap.tag, "static", `${tableName}.json`);
    if (!fs.existsSync(file)) {
        snap.rowsByTable.set(tableName, null);
        return null;
    }
    const rows = parseJsonLossless<Record<string, unknown>[]>(fs.readFileSync(file, "utf-8"));
    snap.rowsByTable.set(tableName, rows);
    return rows;
}

function colTypeMap(snap: Snapshot, name: string): Map<string, AlgebraicType | undefined> {
    const dt = snap.derived.tables.get(name);
    const out = new Map<string, AlgebraicType | undefined>();
    for (const col of dt?.columns ?? []) out.set(col, getColumnTypeElement(name, col, snap.schema));
    return out;
}

// ---------------------------------------------------------------------------
// 3. Walk adjacent version pairs, diffing per migration-base logical table
// ---------------------------------------------------------------------------
const tableHistory: TableHistory = {};
const objectHistories = new Map<string, ObjectHistory>();

function pushTableEntry(base: string, entry: TableHistoryEntry): void {
    (tableHistory[base] ??= []).push(entry);
}

function pushObjectEntry(base: string, id: string, entry: ObjectHistoryEntry): void {
    let hist = objectHistories.get(base);
    if (!hist) {
        hist = {};
        objectHistories.set(base, hist);
    }
    (hist[id] ??= []).push(entry);
}

let prev: Snapshot | null = null;
for (const tag of tags) {
    const cur = loadSnapshot(tag);
    if (!cur) continue;
    if (!prev) {
        prev = cur;
        continue;
    }

    console.log(`Diffing ${prev.tag} -> ${cur.tag}...`);

    const fromMig = prev.derived.migration;
    const toMig = cur.derived.migration;
    const bases = new Set([...fromMig.currentByBase.keys(), ...toMig.currentByBase.keys()]);

    for (const base of bases) {
        const fromName = fromMig.currentByBase.get(base);
        const toName = toMig.currentByBase.get(base);

        if (fromName && !toName) {
            // Whole table removed as of `cur`.
            const rows = getRows(prev, fromName);
            const dt = prev.derived.tables.get(fromName);
            if (rows && dt?.primaryKey) {
                for (const row of rows) pushObjectEntry(base, String(row[dt.primaryKey]), {version: cur.tag, kind: "removed"});
            }
            const kind: TableHistoryKind[] = rows?.length ? ["schema", "rows"] : ["schema"];
            pushTableEntry(base, {version: cur.tag, kind, removed: rows?.length, lifecycle: "removed"});
            continue;
        }

        if (!fromName && toName) {
            // Whole table added as of `cur`.
            const rows = getRows(cur, toName);
            const dt = cur.derived.tables.get(toName);
            if (rows && dt?.primaryKey) {
                for (const row of rows) pushObjectEntry(base, String(row[dt.primaryKey]), {version: cur.tag, kind: "added"});
            }
            const kind: TableHistoryKind[] = rows?.length ? ["schema", "rows"] : ["schema"];
            pushTableEntry(base, {version: cur.tag, kind, added: rows?.length, lifecycle: "added"});
            continue;
        }

        if (!fromName || !toName) continue; // unreachable — satisfies narrowing below

        // Present on both sides, either under the same name or across a migration
        // (fromName -> toName). Column-type comparison is Ref-index-independent (canonicalized
        // inside diffSchema), so a migration that only renumbers the typespace isn't flagged.
        const schemaDiff: SchemaDiff = diffSchema(
            colTypeMap(prev, fromName),
            colTypeMap(cur, toName),
            prev.schema.tables.find((t) => t.name === fromName),
            cur.schema.tables.find((t) => t.name === toName),
            {typespace: prev.schema.typespace.types, idxMap: prev.idxMap},
            {typespace: cur.schema.typespace.types, idxMap: cur.idxMap},
        );

        const fromRows = getRows(prev, fromName);
        const toRows = getRows(cur, toName);
        const fromMeta = prev.derived.tables.get(fromName);
        const toMeta = cur.derived.tables.get(toName);

        let rowDelta: { added: number; removed: number; changed: number } | undefined;
        if (fromRows !== null && toRows !== null) {
            const tableDiff = diffTable(
                fromRows, toRows,
                {primaryKey: fromMeta?.primaryKey}, {primaryKey: toMeta?.primaryKey},
                schemaDiff,
            );
            if (tableDiff.added || tableDiff.removed || tableDiff.changed) {
                rowDelta = {added: tableDiff.added, removed: tableDiff.removed, changed: tableDiff.changed};
            }
            // Keyless tables have no stable per-object identity (diffTable keys them by
            // full-row JSON) — object-level history only makes sense when there's a real pk.
            const pk = toMeta?.primaryKey ?? fromMeta?.primaryKey;
            if (pk) {
                for (const row of tableDiff.rows) pushObjectEntry(base, row.id, {version: cur.tag, kind: row.kind});
            }
        }

        if (schemaDiff.changeCount > 0 || rowDelta) {
            const kind: TableHistoryKind[] = [];
            if (schemaDiff.changeCount > 0) kind.push("schema");
            if (rowDelta) kind.push("rows");
            pushTableEntry(base, {
                version: cur.tag,
                kind,
                added: rowDelta?.added,
                removed: rowDelta?.removed,
                changed: rowDelta?.changed,
            });
        }
    }

    prev = cur;
}

// ---------------------------------------------------------------------------
// 4. Write outputs (full rebuild — clear stale per-table files first)
// ---------------------------------------------------------------------------
fs.rmSync(HISTORY_DIR, {recursive: true, force: true});
fs.mkdirSync(HISTORY_DIR, {recursive: true});

const sortedTableHistory: TableHistory = {};
for (const base of Object.keys(tableHistory).sort()) sortedTableHistory[base] = tableHistory[base];
fs.writeFileSync(HISTORY_FILE, JSON.stringify(sortedTableHistory, null, 2), "utf-8");
console.log(`\nWrote ${HISTORY_FILE} (${Object.keys(sortedTableHistory).length} tables with history)`);

let objectFileCount = 0;
for (const [base, hist] of objectHistories) {
    if (Object.keys(hist).length === 0) continue;
    fs.writeFileSync(path.join(HISTORY_DIR, `${base}.json`), JSON.stringify(hist), "utf-8");
    objectFileCount++;
}
console.log(`Wrote ${objectFileCount} per-table history files to ${HISTORY_DIR}`);
console.log("\nDone.");
