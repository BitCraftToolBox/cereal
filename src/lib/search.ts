import type {TableIndex} from "./data";
import {isStaticTable} from "./data";
import type {CompactSearchEntry, SearchIndex} from "./schema";

export type TableCategory = "static" | "hidden" | "nonStatic";

export interface TableMatch {
    kind: "table";
    tableName: string;
    score: number;
    category: TableCategory;
    isPublic: boolean;
}

export interface ObjectMatch {
    kind: "object";
    tableName: string;
    primaryKey: unknown;
    displayValue: string;
    matchField: string;
    matchValue: string;
    score: number;
}

export type SearchResult = TableMatch | ObjectMatch;

export interface GroupedResults {
    tables: TableMatch[];
    /** Object matches grouped by table name, sorted by score within each group */
    objects: Map<string, ObjectMatch[]>;
    /** Total matches per table (before maxPerTable slice) */
    totalPerTable: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Strip punctuation and spaces for normalized comparison. */
function normalize(s: string): string {
    return s.replace(/[\s_\-.'"]+/g, "");
}

/** Levenshtein edit distance (character-level). */
function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const dp: number[] = Array.from({length: b.length + 1}, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const temp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = temp;
        }
    }
    return dp[b.length];
}

/**
 * Score how well `query` matches `target`. Lower = better match. null = no match.
 * Handles multi-word queries (space/underscore separated) — all words must match.
 */
export function scoreMatch(target: string, query: string): number | null {
    const t = target.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return null;

    if (t === q) return 0;
    if (t.startsWith(q)) return 1;
    const nt = normalize(t);
    const nq = normalize(q);
    if (nq.length >= 3) {
        if (nt === nq) return 0.5;
        if (nt.startsWith(nq)) return 1.5;
    }

    const words = q.split(/[\s_]+/).filter(Boolean);
    if (words.length > 1) {
        let total = 0;
        for (const word of words) {
            const s = scoreWord(t, word);
            if (s === null) return null;
            total += s;
        }
        return total;
    }

    return scoreWord(t, q);
}

/**
 * Score a single query word against a (already-lowercased) target string.
 *
 * Score tiers (lower = better):
 *   0    exact full-string match
 *   1    full-string prefix
 *   2    full-string substring
 *   2.5  normalized (punct-stripped) substring
 *   3    exact match against an individual target word
 *   3.5  prefix of an individual target word
 *   4    substring of an individual target word
 *   5+   edit distance 1-2 against an individual target word (typo tolerance)
 *   null no match
 */
function scoreWord(target: string, word: string): number | null {
    // Exact full-string match always wins regardless of target length
    if (target === word) return 0;

    // Full-string prefix / substring checks only make sense for single-token targets
    // (e.g. table names, short IDs). For multi-word strings like descriptions, these
    // checks find "rod" inside "p[rod]ucts" which is a false positive — use per-word
    // matching instead for those cases.
    const isSingleToken = !/[\s]/.test(target);
    if (isSingleToken) {
        if (target.startsWith(word)) return 1;
        if (target.includes(word)) return 2;
    }

    // Normalized match: strip punctuation/underscores/spaces from both sides.
    // Only do exact or prefix — substring would match across word boundaries (e.g. "perch" in "developerchisel").
    const nt = normalize(target);
    const nw = normalize(word);
    if (nw.length >= 3) {
        if (nt === nw) return 0.5;
        if (nt.startsWith(nw)) return 1.5;
    }

    // Per-word matching: split target into its component words and score against each
    const targetWords = target.split(/[\s_\-.'"]+/).filter(Boolean);
    let best: number | null = null;

    const improve = (s: number) => {
        if (best === null || s < best) best = s;
    };

    for (const tw of targetWords) {
        if (tw === word) {
            improve(3);
            continue;
        }
        if (tw.startsWith(word)) {
            improve(3.5);
            continue;
        }
        if (tw.includes(word)) {
            improve(4);
            continue;
        }

        // Edit distance — only for words long enough to make typo-tolerance meaningful
        const maxLen = Math.max(tw.length, word.length);
        const lenDiff = Math.abs(tw.length - word.length);
        if (maxLen < 4 || lenDiff > 2) continue;

        const threshold = maxLen >= 6 ? 2 : 1;
        const dist = levenshtein(tw, word);
        if (dist <= threshold) improve(5 + dist);
    }

    return best;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search table names leniently (same style as the home page filter).
 * Matches if the query (normalized: spaces/underscores removed) is a substring of the
 * normalized table name. Sorts by category: static public → private → non-static.
 */
export function searchTableNames(
    query: string,
    tables: TableIndex[],
): TableMatch[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    // Normalize: collapse spaces and underscores for lenient word-boundary-agnostic matching
    const qNorm = q.replace(/[\s_]+/g, "");

    const results: TableMatch[] = [];
    for (const t of tables) {
        const name = t.name.toLowerCase();
        const nameNorm = name.replace(/_/g, "");
        const isStatic = isStaticTable(t.name);
        const category: TableCategory = !isStatic ? "nonStatic" : t.meta.isPublic ? "static" : "hidden";

        if (!name.includes(q) && !nameNorm.includes(qNorm)) continue;

        results.push({kind: "table", tableName: t.name, score: 0, category, isPublic: t.meta.isPublic});
    }

    // Sort: static public → private → non-static, then alphabetically within category
    const catOrder: Record<TableCategory, number> = {static: 0, hidden: 1, nonStatic: 2};
    results.sort((a, b) => {
        const co = catOrder[a.category] - catOrder[b.category];
        if (co !== 0) return co;
        return a.tableName.localeCompare(b.tableName);
    });

    return results;
}

/**
 * Search using a pre-built SearchIndex (fast path — no table row loading required).
 */
export function searchWithIndex(
    query: string,
    index: SearchIndex,
    maxPerTable = 5,
    scoreCutoff = 9,
): GroupedResults {
    const q = query.trim();
    const qLower = q.toLowerCase();
    const objects = new Map<string, ObjectMatch[]>();
    const totalPerTable = new Map<string, number>();

    for (const [tableName, entries] of Object.entries(index.entries)) {
        for (const raw of entries as CompactSearchEntry[]) {
            const pkRaw = typeof raw === "string" || typeof raw === "number" ? raw : raw.pk;
            const pk = String(pkRaw);
            const n = typeof raw === "object" && raw.n != null ? raw.n : pk;
            const f: [string, string][] = typeof raw === "object" && raw.f != null ? raw.f : [];

            // Exact PK match
            if (pk.toLowerCase() === qLower) {
                const list = objects.get(tableName) ?? [];
                list.push({kind: "object", tableName, primaryKey: pk, displayValue: n, matchField: "id", matchValue: pk, score: -1});
                objects.set(tableName, list);
                continue;
            }

            // Fuzzy match against display name and search fields
            let bestScore: number | null = null;
            let bestField = "";
            let bestVal = "";

            const nameScore = scoreMatch(n, q);
            if (nameScore !== null && nameScore <= scoreCutoff) {
                bestScore = nameScore;
                bestField = "name";
                bestVal = n;
            }

            for (const [field, val] of f) {
                const score = scoreMatch(val, q);
                if (score !== null && score <= scoreCutoff && (bestScore === null || score < bestScore)) {
                    bestScore = score;
                    bestField = field;
                    bestVal = val;
                }
            }

            if (bestScore !== null) {
                const list = objects.get(tableName) ?? [];
                list.push({kind: "object", tableName, primaryKey: pk, displayValue: n, matchField: bestField, matchValue: bestVal, score: bestScore});
                objects.set(tableName, list);
            }
        }
    }

    // Sort within each table, count totals, slice to maxPerTable
    for (const [name, matches] of objects) {
        matches.sort((a, b) => a.score - b.score);
        totalPerTable.set(name, matches.length);
        objects.set(name, matches.slice(0, maxPerTable));
    }

    const sorted = new Map([...objects.entries()].sort((a, b) => a[1][0].score - b[1][0].score));
    return {tables: [], objects: sorted, totalPerTable};
}
