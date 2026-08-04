/**
 * Shared logic behind the version-compare dropdowns (`CompareButton`, `CompareHeader`):
 * classify each candidate version as "has its own recorded change", "no recorded change", or
 * "known not to exist yet / anymore" (before the table/object was added, or after it was
 * removed), using the history manifests loaded via `data.getTableHistory`/`getObjectHistory`.
 */
import {migrationBase} from "./schemaDerive";
import type {DataStore} from "./data";

export type ExistenceKind = "added" | "removed";

export interface ExistenceEvent {
    idx: number;
    kind: ExistenceKind;
}

export interface VersionHistoryState {
    /** Version tags at which the table/object has a recorded change of its own. */
    changed: Set<string>;
    /** Add/remove events, sorted oldest-first (i.e. descending `idx`). */
    events: ExistenceEvent[];
}

/**
 * Build the change/existence state for `tableName` (resolved to its migration base) — or, when
 * `objectId` is given, for that one object within it. `versionIndex` maps tag → position in the
 * newest-first versions list. Returns `undefined` while the underlying history data is still
 * loading, in which case callers should render every option at full opacity.
 */
export function computeVersionHistoryState(
    tableName: string,
    objectId: string | undefined,
    versionIndex: Map<string, number>,
    data: Pick<DataStore, "getTableHistory" | "getObjectHistory">,
): VersionHistoryState | undefined {
    const base = migrationBase(tableName).base;

    if (objectId != null) {
        const entries = data.getObjectHistory(base, objectId);
        if (!entries) return undefined;
        const events = entries
            .filter((e) => (e.kind === "added" || e.kind === "removed") && versionIndex.has(e.version))
            .map((e): ExistenceEvent => ({idx: versionIndex.get(e.version)!, kind: e.kind as ExistenceKind}))
            .sort((a, b) => b.idx - a.idx);
        return {changed: new Set(entries.map((e) => e.version)), events};
    }

    const entries = data.getTableHistory(base);
    if (!entries) return undefined;
    const events = entries
        .filter((e) => e.lifecycle && versionIndex.has(e.version))
        .map((e): ExistenceEvent => ({idx: versionIndex.get(e.version)!, kind: e.lifecycle!}))
        .sort((a, b) => b.idx - a.idx);
    return {changed: new Set(entries.map((e) => e.version)), events};
}

/**
 * Whether the entity is known NOT to exist at version index `idx` (0 = newest, larger = older),
 * given its add/remove events sorted oldest-first (i.e. descending `idx`).
 *
 * Walks the events from oldest to newest, tracking the state as of the most recent event that
 * is still at-or-before `idx` (i.e. `event.idx >= idx`, since larger index = older). If no event
 * is that old, the query predates all tracked history — nonexistent only if the very first
 * tracked event is an "added" (proving it didn't exist before that point).
 */
export function isNonexistentAt(idx: number, eventsOldestFirst: ExistenceEvent[]): boolean {
    let state: ExistenceKind | undefined;
    for (const e of eventsOldestFirst) {
        if (e.idx < idx) break;
        state = e.kind;
    }
    if (state) return state === "removed";
    return eventsOldestFirst[0]?.kind === "added";
}
