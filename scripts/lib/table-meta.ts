import type {TableMeta} from "../../src/lib/schema";

export interface SchemaInfo {
    columns: string[];
    isPublic: boolean;
    enumColumns: string[];
    enumVariants: Record<string, string[]>;
    schemaPrimaryKey?: string;
    productTypeRef: number;
}

/**
 * Build-time superset of the (slim) manifest `TableMeta`. Carries a couple of extra fields the
 * generator + FK detector + search-index builder need but which are NOT serialized into the
 * manifest (they're re-derived from the schema at runtime, or are build-only).
 */
export interface BuildTableMeta extends TableMeta {
    /** Build-only: free-text fields fed into the search index. */
    searchFields: string[];
    /** Schema-derived enum column paths (used by FK value-candidate detection). */
    enumColumns: string[];
}

const SPRITE_FIELD_RE = /^(image|icon)(_asset)?_(name|address)s?$/;
const SINGLE_CHAR = /^(.|\\u[0-9a-fA-F]{4})$/;

function detectDisplayField(table: string, columns: string[], nameOverrides: Record<string, string | null>): string | undefined {
    if (table in nameOverrides) return nameOverrides[table] ?? undefined;

    const exactName = columns.find((c) => c === "name");
    if (exactName) return exactName;

    const nameSuffix = columns
        .filter((c) => c.endsWith("name") && !/asset_names?$/.test(c))
        .sort((a, b) => a.length - b.length)[0];
    if (nameSuffix) return nameSuffix;

    const title = columns.find((c) => c === "title");
    if (title) return title;

    return columns.find((c) => c === "description");
}

function detectSearchFields(rows: Record<string, unknown>[]): string[] {
    if (rows.length === 0) return [];
    const keys = Object.keys(rows[0]);
    const hexAsset = /^[0-9a-f]{32}$/i;

    return keys.filter((k) => {
        const lk = k.toLowerCase();
        if (
            !lk.includes("name") &&
            !lk.includes("description") &&
            !lk.includes("desc") &&
            !lk.includes("tag") &&
            !lk.includes("text")
        ) return false;

        if (/asset_names?$/.test(k)) return false;

        const samples: string[] = [];
        for (const row of rows.slice(0, Math.min(20, rows.length))) {
            const v = row[k];
            if (typeof v === "string" && v.length > 0) {
                samples.push(v);
                if (samples.length >= 5) break;
            }
        }

        if (samples.length === 0) return false;
        if (samples.every((v) => SINGLE_CHAR.test(v))) return false;
        if (samples.every((v) => hexAsset.test(v))) return false;
        return true;
    });
}

function detectSpriteFields(rows: Record<string, unknown>[]): string[] {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).filter((k) => {
        if (!SPRITE_FIELD_RE.test(k)) return false;
        for (const row of rows) {
            const v = row[k];
            if (typeof v === "string" && v.length > 1 && !SINGLE_CHAR.test(v)) return true;
        }
        return false;
    });
}

export function buildTableMeta(
    tableName: string,
    rows: Record<string, unknown>[],
    info: SchemaInfo | undefined,
    nameOverrides: Record<string, string | null>,
): BuildTableMeta {
    const columns = info?.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);

    return {
        name: tableName,
        primaryKey: info?.schemaPrimaryKey,
        displayField: detectDisplayField(tableName, columns, nameOverrides),
        rowCount: rows.length,
        isPublic: info?.isPublic ?? true,
        spriteFields: detectSpriteFields(rows),
        searchFields: detectSearchFields(rows),
        enumColumns: info?.enumColumns ?? [],
    };
}

