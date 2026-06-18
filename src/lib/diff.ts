/**
 * Pure, framework-agnostic diff logic for comparing game data between two versions.
 *
 * Three composable levels — object → table → version — each building on the previous.
 * Nothing here touches Solid, the DOM, or the data store; all inputs are already-resolved
 * plain data so the functions are trivially unit-testable.
 */

import type {AlgebraicType, DefManifest, SchemaTable} from "./schema";
import {buildMigrationInfo} from "./schemaDerive";

export type DiffKind = "added" | "removed" | "changed";

// ── Object level ────────────────────────────────────────────────────────────

/**
 * Map of field path → diff kind.
 *
 * Paths use the SAME convention as `JsonViewer`'s `fieldPath`: dot-separated object keys
 * and bracketed array indices (e.g. `items[3].name`).
 */
export type ObjectDiff = Map<string, DiffKind>;

/** Side-aware object diff paths for compare views where array indices can diverge. */
export interface ObjectDiffSides {
    from: ObjectDiff;
    to: ObjectDiff;
    /** Union-like map kept for compatibility with existing callers. */
    merged: ObjectDiff;
}

/** Structural deep-equality for plain JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;

    const aArr = Array.isArray(a);
    const bArr = Array.isArray(b);
    if (aArr !== bArr) return false;

    if (aArr) {
        const ar = a as unknown[];
        const br = b as unknown[];
        if (ar.length !== br.length) return false;
        for (let i = 0; i < ar.length; i++) if (!deepEqual(ar[i], br[i])) return false;
        return true;
    }

    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pushDiff(path: string, kind: DiffKind, ...outs: ObjectDiff[]): void {
    for (const out of outs) out.set(path, kind);
}

function arrayPath(path: string, idx: number): string {
    return `${path}[${idx}]`;
}

/** Edit operation used for array alignment. */
type ArrayOp = "match" | "sub" | "del" | "ins";

function alignArrayOps(a: unknown[], b: unknown[]): ArrayOp[] {
    const n = a.length;
    const m = b.length;
    const dp: number[][] = Array.from({length: n + 1}, () => Array<number>(m + 1).fill(0));
    const op: ArrayOp[][] = Array.from({length: n + 1}, () => Array<ArrayOp>(m + 1).fill("match"));

    for (let i = n; i >= 0; i--) {
        for (let j = m; j >= 0; j--) {
            if (i === n && j === m) {
                dp[i][j] = 0;
                continue;
            }
            if (i === n) {
                dp[i][j] = 1 + dp[i][j + 1];
                op[i][j] = "ins";
                continue;
            }
            if (j === m) {
                dp[i][j] = 1 + dp[i + 1][j];
                op[i][j] = "del";
                continue;
            }

            if (deepEqual(a[i], b[j])) {
                dp[i][j] = dp[i + 1][j + 1];
                op[i][j] = "match";
                continue;
            }

            const sub = 1 + dp[i + 1][j + 1];
            const del = 1 + dp[i + 1][j];
            const ins = 1 + dp[i][j + 1];
            const best = Math.min(sub, del, ins);
            dp[i][j] = best;

            // Tie-break to reduce churn: substitution first, then insertion, then deletion.
            if (sub === best) op[i][j] = "sub";
            else if (ins === best) op[i][j] = "ins";
            else op[i][j] = "del";
        }
    }

    const out: ArrayOp[] = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
        const cur = i <= n && j <= m ? op[i][j] : "match";
        if (i === n) {
            out.push("ins");
            j++;
            continue;
        }
        if (j === m) {
            out.push("del");
            i++;
            continue;
        }
        out.push(cur);
        if (cur === "match" || cur === "sub") {
            i++;
            j++;
        } else if (cur === "ins") j++;
        else i++;
    }
    return out;
}

/**
 * Recursively diff two JSON values, writing `path → kind` entries into `out`.
 * `a` is the "from" (older) value, `b` is the "to" (newer) value.
 */
function diffIntoSides(
    a: unknown,
    b: unknown,
    fromPath: string,
    toPath: string,
    fromOut: ObjectDiff,
    toOut: ObjectDiff,
    mergedOut: ObjectDiff,
): void {
    if (deepEqual(a, b)) return;

    const aMissing = a === undefined;
    const bMissing = b === undefined;
    if (aMissing && !bMissing) {
        pushDiff(toPath, "added", toOut, mergedOut);
        return;
    }
    if (!aMissing && bMissing) {
        pushDiff(fromPath, "removed", fromOut, mergedOut);
        return;
    }

    // Both present but differ.
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            const fromChild = fromPath ? `${fromPath}.${k}` : k;
            const toChild = toPath ? `${toPath}.${k}` : k;
            diffIntoSides(a[k], b[k], fromChild, toChild, fromOut, toOut, mergedOut);
        }
        return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        pushDiff(fromPath, "changed", fromOut, mergedOut);
        if (toPath !== fromPath) pushDiff(toPath, "changed", toOut, mergedOut);
        else pushDiff(toPath, "changed", toOut);

        const ops = alignArrayOps(a, b);
        let i = 0, j = 0;
        for (const cur of ops) {
            if (cur === "match") {
                i++;
                j++;
                continue;
            }
            if (cur === "sub") {
                diffIntoSides(
                    a[i],
                    b[j],
                    arrayPath(fromPath, i),
                    arrayPath(toPath, j),
                    fromOut,
                    toOut,
                    mergedOut,
                );
                i++;
                j++;
                continue;
            }
            if (cur === "del") {
                pushDiff(arrayPath(fromPath, i), "removed", fromOut, mergedOut);
                i++;
                continue;
            }
            pushDiff(arrayPath(toPath, j), "added", toOut, mergedOut);
            j++;
        }
        return;
    }

    // Primitive vs primitive (or type mismatch).
    pushDiff(fromPath, "changed", fromOut, mergedOut);
    if (toPath !== fromPath) pushDiff(toPath, "changed", toOut, mergedOut);
    else pushDiff(toPath, "changed", toOut);
}

/** Diff two objects (or any JSON values). Returns an empty map when equal. */
export function diffObject(a: unknown, b: unknown): ObjectDiff {
    return diffObjectSides(a, b).merged;
}

/**
 * Diff two objects with side-specific paths, useful when array insertions/removals shift
 * indices differently between the two versions.
 */
export function diffObjectSides(a: unknown, b: unknown): ObjectDiffSides {
    const from: ObjectDiff = new Map();
    const to: ObjectDiff = new Map();
    const merged: ObjectDiff = new Map();
    diffIntoSides(a, b, "", "", from, to, merged);
    return {from, to, merged};
}

// ── Schema level ────────────────────────────────────────────────────────────

export interface ColumnSchemaDiff {
    column: string;
    kind: DiffKind;
}

export interface IndexSchemaDiff {
    /** Human-readable index/constraint key. */
    name: string;
    kind: DiffKind;
}

export interface SchemaDiff {
    columns: ColumnSchemaDiff[];
    indexes: IndexSchemaDiff[];
    /** Total number of schema-level changes (columns + indexes/constraints). */
    changeCount: number;
}

/** Build a stable string key for a schema index. */
function indexKey(idx: NonNullable<SchemaTable["indexes"]>[number]): string {
    const cols = idx.algorithm?.BTree ?? idx.algorithm?.Hash ?? idx.algorithm?.Direct ?? [];
    const colStr = Array.isArray(cols) ? cols.join(",") : String(cols);
    const algo = idx.algorithm?.BTree ? "btree" : idx.algorithm?.Hash ? "hash" : "direct";
    return idx.accessor_name?.some ?? idx.name?.some ?? `${algo}(${colStr})`;
}

/** Build a stable string key for a unique constraint. */
function constraintKey(c: NonNullable<SchemaTable["constraints"]>[number]): string {
    const cols = c.data?.Unique?.columns ?? [];
    return c.name?.some ?? `unique(${cols.join(",")})`;
}

/** Context needed to resolve `Ref` indices into their underlying type structure. */
export interface TypeResolveCtx {
    typespace: AlgebraicType[];
    idxMap: Map<number, string>;
}

const SCALAR_KEYS = [
    "U8", "U16", "U32", "U64", "U128", "U256",
    "I8", "I16", "I32", "I64", "I128", "I256",
    "F32", "F64", "Bool", "String", "Bytes",
] as const;

/**
 * Produce a structural, Ref-number-independent canonical form of an AlgebraicType.
 *
 * `Ref` indices are *inlined* to the structure they point at, so two versions that assign
 * different typespace indices to identical types compare equal (e.g. `Array<Ref 180>` vs
 * `Array<Ref 178>` where both resolve to the same `MovementSpeed` struct). Recursion is
 * broken using the type's stable *name* (from `idxMap`), so genuinely structural changes are
 * still detected while recursive types don't loop forever.
 */
export function canonicalizeType(
    type: AlgebraicType | undefined,
    ctx?: TypeResolveCtx,
    seen: ReadonlySet<string> = new Set(),
): unknown {
    if (!type) return null;

    if (type.Ref !== undefined) {
        const name = ctx?.idxMap.get(type.Ref) ?? `#${type.Ref}`;
        if (seen.has(name)) return {recur: name};
        const resolved = ctx?.typespace[type.Ref];
        if (!resolved) return {ref: name};
        return canonicalizeType(resolved, ctx, new Set([...seen, name]));
    }

    if (type.Array !== undefined) {
        return {array: canonicalizeType(type.Array, ctx, seen)};
    }

    if (type.Sum) {
        return {
            sum: type.Sum.variants.map((v) => ({
                name: v.name && "some" in v.name ? v.name.some : null,
                type: canonicalizeType(v.algebraic_type, ctx, seen),
            })),
        };
    }

    if (type.Product) {
        return {
            product: type.Product.elements.map((el) => ({
                name: el.name && "some" in el.name ? el.name.some : null,
                type: canonicalizeType(el.algebraic_type, ctx, seen),
            })),
        };
    }

    for (const k of SCALAR_KEYS) if (k in type) return {scalar: k};
    return {unknown: true};
}

/**
 * Diff table schema: columns (add/remove, plus `changed` when the column's AlgebraicType
 * differs) and indexes/constraints (add/remove). Schema changes never count as row changes.
 *
 * When `ctxA`/`ctxB` are supplied, column types are compared by their *resolved structure*
 * rather than by raw shape, so differing `Ref` indices that point at identical types are not
 * reported as changes.
 */
export function diffSchema(
    colTypesA: Map<string, AlgebraicType | undefined>,
    colTypesB: Map<string, AlgebraicType | undefined>,
    schemaTableA?: SchemaTable,
    schemaTableB?: SchemaTable,
    ctxA?: TypeResolveCtx,
    ctxB?: TypeResolveCtx,
): SchemaDiff {
    const columns: ColumnSchemaDiff[] = [];
    const colNames = new Set([...colTypesA.keys(), ...colTypesB.keys()]);
    for (const col of colNames) {
        const inA = colTypesA.has(col);
        const inB = colTypesB.has(col);
        if (inA && !inB) columns.push({column: col, kind: "removed"});
        else if (!inA && inB) columns.push({column: col, kind: "added"});
        else {
            const ca = canonicalizeType(colTypesA.get(col), ctxA);
            const cb = canonicalizeType(colTypesB.get(col), ctxB);
            if (!deepEqual(ca, cb)) columns.push({column: col, kind: "changed"});
        }
    }

    const indexes: IndexSchemaDiff[] = [];
    const keysA = new Set<string>([
        ...(schemaTableA?.indexes ?? []).map(indexKey),
        ...(schemaTableA?.constraints ?? []).map(constraintKey),
    ]);
    const keysB = new Set<string>([
        ...(schemaTableB?.indexes ?? []).map(indexKey),
        ...(schemaTableB?.constraints ?? []).map(constraintKey),
    ]);
    for (const k of new Set([...keysA, ...keysB])) {
        const inA = keysA.has(k);
        const inB = keysB.has(k);
        if (inA && !inB) indexes.push({name: k, kind: "removed"});
        else if (!inA && inB) indexes.push({name: k, kind: "added"});
    }

    return {columns, indexes, changeCount: columns.length + indexes.length};
}

// ── Table level ─────────────────────────────────────────────────────────────

export interface RowDiff {
    kind: DiffKind;
    /** Primary key as a string, or a synthetic key for keyless tables. */
    id: string;
    /** Per-field diff paths — only present for `changed` rows. */
    paths?: ObjectDiff;
}

export interface TableDiff {
    rows: RowDiff[];
    added: number;
    removed: number;
    changed: number;
    schema: SchemaDiff;
}

function keyRows(rows: Record<string, unknown>[], pk?: string): Map<string, Record<string, unknown>> {
    const map = new Map<string, Record<string, unknown>>();
    if (pk) {
        for (const r of rows) map.set(String(r[pk]), r);
    } else {
        // Keyless: identity by full-row JSON (SpacetimeDB-style). Duplicate rows collapse.
        for (const r of rows) map.set(JSON.stringify(r), r);
    }
    return map;
}

function rootPathSegment(path: string): string {
    const dot = path.indexOf(".");
    const first = dot === -1 ? path : path.slice(0, dot);
    const bracket = first.indexOf("[");
    return bracket === -1 ? first : first.slice(0, bracket);
}

/**
 * Diff a single table's rows + schema between two versions.
 *
 * Rows are keyed by `primaryKey` when available, otherwise by full-row JSON equality
 * (added = only in `to`, removed = only in `from`, no `changed` for keyless tables).
 */
export function diffTable(
    rowsA: Record<string, unknown>[],
    rowsB: Record<string, unknown>[],
    metaA: { primaryKey?: string } | undefined,
    metaB: { primaryKey?: string } | undefined,
    schema: SchemaDiff,
): TableDiff {
    const pk = metaB?.primaryKey ?? metaA?.primaryKey;
    const mapA = keyRows(rowsA, pk);
    const mapB = keyRows(rowsB, pk);

    // Columns that were purely added/removed at the schema level produce a spurious
    // per-row field diff on every row (the field simply didn't exist on one side). Those
    // aren't real content changes, so ignore them here — the direct object compare still
    // surfaces them. Type-*changed* columns are kept, since their values can really differ.
    const ignoreFields = new Set(
        schema.columns.filter((c) => c.kind !== "changed").map((c) => c.column),
    );

    const rows: RowDiff[] = [];
    let added = 0, removed = 0, changed = 0;

    const keys = new Set([...mapA.keys(), ...mapB.keys()]);
    for (const key of keys) {
        const a = mapA.get(key);
        const b = mapB.get(key);
        // For keyed tables the key IS the pk string. For keyless tables the key is the
        // full-row JSON; there is no stable id to link to, so fall back to the key.
        const id = key;
        if (a && !b) {
            rows.push({kind: "removed", id});
            removed++;
        } else if (!a && b) {
            rows.push({kind: "added", id});
            added++;
        } else if (a && b && pk) {
            const paths = diffObject(a, b);
            for (const p of [...paths.keys()]) {
                if (ignoreFields.has(rootPathSegment(p))) paths.delete(p);
            }
            if (paths.size > 0) {
                rows.push({kind: "changed", id: key, paths});
                changed++;
            }
        }
        // keyless + present in both → identical (same JSON key), skip.
    }

    return {rows, added, removed, changed, schema};
}

// ── Version level ───────────────────────────────────────────────────────────

export interface EnumDiff {
    name: string;
    kind: DiffKind;
    addedValues?: string[];
    removedValues?: string[];
}

export interface TableEntryDiff {
    name: string;
    kind: DiffKind;
    /** Row deltas, present only when the table was diffed against fetched rows. */
    rowAdded?: number;
    rowRemoved?: number;
    rowChanged?: number;
    /** Number of schema-level changes (columns + indexes). */
    schemaChanges: number;
    /** Whether row data is fetchable (static + public) in at least one version. */
    fetchable: boolean;
}

export interface VersionDiff {
    enums: EnumDiff[];
    tables: TableEntryDiff[];
}

/** Per-table row deltas supplied by the route after fetching + diffing each table. */
export type RowDeltaMap = Map<string, { added: number; removed: number; changed: number }>;

/** Per-table schema change counts supplied by the route (needs both schemas). */
export type SchemaChangeMap = Map<string, number>;

function diffEnumMaps(mapA: Map<string, string[]>, mapB: Map<string, string[]>): EnumDiff[] {
    const out: EnumDiff[] = [];
    for (const name of new Set([...mapA.keys(), ...mapB.keys()])) {
        const va = mapA.get(name);
        const vb = mapB.get(name);
        if (va && !vb) out.push({name, kind: "removed"});
        else if (!va && vb) {
            out.push({name, kind: "added", addedValues: vb});
        } else if (va && vb && !deepEqual(va, vb)) {
            const setA = new Set(va);
            const setB = new Set(vb);
            const addedValues = vb.filter((v) => !setA.has(v));
            const removedValues = va.filter((v) => !setB.has(v));
            out.push({name, kind: "changed", addedValues, removedValues});
        }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Diff two version manifests. Table `changed` is derived from `schemaChanges` and/or
 * `rowDeltas` (both supplied by the route once it has the schemas / fetched rows). Enum diffs
 * come from the schema-derived enum maps (`enumsA`/`enumsB`), since the manifest no longer
 * carries enums.
 *
 * Migrated `_vN` tables are paired by **migration base**, taking each side's current (highest-N)
 * version — so a `deployable_desc_v2` → `deployable_desc_v3` migration shows as a schema/row
 * *change* on the current name, not a remove+add of distinct tables. Superseded versions are
 * never counted. `rowDeltas` / `schemaChanges` are therefore keyed by **base name** (the route
 * keys them the same way), while the emitted `name` is the displayed/linkable current table.
 */
export function diffVersion(
    a: DefManifest,
    b: DefManifest,
    opts?: {
        rowDeltas?: RowDeltaMap;
        schemaChanges?: SchemaChangeMap;
        fetchable?: (name: string) => boolean;
        enumsA?: Map<string, string[]>;
        enumsB?: Map<string, string[]>;
    },
): VersionDiff {
    const fromMig = buildMigrationInfo(a.tables.map((t) => t.name));
    const toMig = buildMigrationInfo(b.tables.map((t) => t.name));

    const tables: TableEntryDiff[] = [];
    for (const base of new Set([...fromMig.currentByBase.keys(), ...toMig.currentByBase.keys()])) {
        const fromName = fromMig.currentByBase.get(base);
        const toName = toMig.currentByBase.get(base);
        // Displayed/linkable name = current version on the newer side (fall back to older).
        const name = toName ?? fromName!;
        const schemaChanges = opts?.schemaChanges?.get(base) ?? 0;
        const delta = opts?.rowDeltas?.get(base);
        const fetchable = opts?.fetchable?.(name) ?? true;

        let kind: DiffKind | null = null;
        if (fromName && !toName) kind = "removed";
        else if (!fromName && toName) kind = "added";
        else {
            const rowChanged = !!delta && (delta.added > 0 || delta.removed > 0 || delta.changed > 0);
            if (schemaChanges > 0 || rowChanged) kind = "changed";
        }
        if (!kind) continue;

        tables.push({
            name,
            kind,
            rowAdded: delta?.added,
            rowRemoved: delta?.removed,
            rowChanged: delta?.changed,
            schemaChanges,
            fetchable,
        });
    }
    tables.sort((x, y) => x.name.localeCompare(y.name));

    const enums = opts?.enumsA && opts?.enumsB ? diffEnumMaps(opts.enumsA, opts.enumsB) : [];
    return {enums, tables};
}
