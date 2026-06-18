import type {SearchIndex} from "../../src/lib/schema";
import type {BuildTableMeta} from "./table-meta";

export type TableDataMap = Record<string, { meta: BuildTableMeta; rows: Record<string, unknown>[] }>;

export function buildSearchIndex(tag: string, tableData: TableDataMap): { index: SearchIndex; totalEntryCount: number } {
    const entries: Record<string, (string | number | { pk: string | number; n?: string; f?: [string, string][] })[]> = {};
    let totalEntryCount = 0;

    for (const [tableName, {meta, rows}] of Object.entries(tableData)) {
        if (!meta.isPublic || rows.length === 0) continue;
        if (!tableName.endsWith("_desc") && !tableName.match(/_desc_v\d+$/) && tableName !== "claim_tile_cost") continue;
        if (!meta.primaryKey) continue;

        const hasDisplay = !!meta.displayField;
        const searchFields = meta.searchFields.filter((f) => f !== meta.displayField);

        const tableEntries: (string | number | { pk: string | number; n?: string; f?: [string, string][] })[] = [];

        for (const row of rows) {
            const rawPk = row[meta.primaryKey];
            if (rawPk == null) continue;
            const pk = typeof rawPk === "number" ? rawPk : String(rawPk);

            if (!hasDisplay && searchFields.length === 0) {
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
            entries[tableName] = tableEntries;
            totalEntryCount += tableEntries.length;
        }
    }

    return {index: {tag, entries}, totalEntryCount};
}

